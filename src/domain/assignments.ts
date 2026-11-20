import type { Db } from '../lib/db.ts';
import { tx } from '../lib/db.ts';
import { newId, nowIso } from '../lib/hash.ts';
import { badRequest, conflict, unprocessable, notFound, forbidden, gone } from '../lib/errors.ts';
import { audit, mustGet, getActor } from './actors.ts';
import { getCase, getCaseSnapshot, setCaseState } from './intake.ts';
import { checkEligibility, checkSlotPair } from './eligibility.ts';
import type { Actor, AssignmentState } from './types.ts';
import { DEFAULT_LEASE_MS } from './types.ts';

interface AssignmentRow {
  id: string;
  tenant_id: string;
  case_id: string;
  slot: number;
  kind: 'review' | 'expert';
  reviewer_id: string;
  principal_id: string;
  state: AssignmentState;
  price_minor: number;
  currency: string;
  lease_expires_at: string;
  lease_epoch: number;
  offered_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export function presentAssignment(r: AssignmentRow, opts: { alias?: string } = {}) {
  return {
    id: r.id,
    case_id: r.case_id,
    slot: r.slot,
    kind: r.kind,
    reviewer_alias: opts.alias ?? r.reviewer_id,
    state: r.state,
    price_minor: r.price_minor,
    currency: r.currency,
    lease_expires_at: r.lease_expires_at,
    lease_epoch: r.lease_epoch,
    offered_at: r.offered_at,
    accepted_at: r.accepted_at,
    delivered_at: r.delivered_at,
  };
}

function aliasFor(db: Db, actorId: string): string {
  return getActor(db, actorId)?.alias ?? actorId;
}

export function getAssignment(db: Db, tenantId: string, id: string): AssignmentRow {
  return mustGet(
    db.prepare('SELECT * FROM assignments WHERE id = ? AND tenant_id = ?').get(id, tenantId),
    'assignment'
  ) as AssignmentRow;
}

/**
 * Reserve spend for one slot and create an offer in a single transaction.
 * Returns the created assignment row. Throws on insufficient budget.
 */
function reserveAndOffer(
  db: Db,
  actor: Actor,
  caseRow: Record<string, unknown>,
  reviewer: Actor,
  slot: number,
  kind: 'review' | 'expert',
  priceMinor: number,
  leaseMs: number
): AssignmentRow {
  const snap = getCaseSnapshot(caseRow);
  const cap = caseRow.budget_cap_minor as number | null;
  const reserved = caseRow.reserved_minor as number;
  if (cap === null) {
    throw unprocessable('case has no authorized budget', {
      next_action: 'budget owner must authorize a cap before offers are issued',
    });
  }
  if (reserved + priceMinor > cap) {
    throw unprocessable('insufficient budget for this reservation', {
      cap_minor: cap,
      reserved_minor: reserved,
      required_minor: priceMinor,
      next_action: 'raise the case budget cap or release spend',
    });
  }
  const id = newId('asg');
  const now = nowIso();
  const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
  db.prepare(
    `INSERT INTO assignments (id, tenant_id, case_id, slot, kind, reviewer_id, principal_id, state,
       price_minor, currency, lease_expires_at, lease_epoch, offered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, 1, ?, ?)`
  ).run(
    id,
    actor.tenant_id,
    caseRow.id as string,
    slot,
    kind,
    reviewer.id,
    reviewer.principal_id,
    priceMinor,
    snap.currency,
    leaseExpires,
    now,
    now
  );
  db.prepare('UPDATE cases SET reserved_minor = reserved_minor + ?, updated_at = ? WHERE id = ?').run(
    priceMinor,
    now,
    caseRow.id as string
  );
  audit(db, actor.tenant_id, actor.id, 'assignment.offer', 'assignment', id, {
    case_id: caseRow.id,
    slot,
    kind,
    price_minor: priceMinor,
  });
  return getAssignment(db, actor.tenant_id, id);
}

/**
 * Steward assigns the two blind reviewer slots. Both offers are created in one
 * transaction: eligibility, distinct principals and org separation are enforced.
 */
export function assignReviewers(
  db: Db,
  actor: Actor,
  caseId: string,
  reviewerIds: string[],
  leaseMs: number = DEFAULT_LEASE_MS
) {
  if (!Array.isArray(reviewerIds) || reviewerIds.length !== 2) {
    throw badRequest('exactly two reviewer_ids are required');
  }
  return tx(db, () => {
    const caseRow = getCase(db, actor.tenant_id, caseId);
    const state = caseRow.state as string;
    if (!['opened', 'slots_reserved', 'reviewing'].includes(state)) {
      throw conflict(`case state ${state} does not accept reviewer assignment`);
    }
    const item = db
      .prepare('SELECT * FROM items WHERE id = ?')
      .get(caseRow.item_id as string) as Record<string, unknown>;
    const snap = getCaseSnapshot(caseRow);

    // A slot that already delivered work cannot be re-filled (no double pay).
    const delivered = db
      .prepare(
        `SELECT COUNT(*) AS n FROM assignments
         WHERE case_id = ? AND kind = 'review' AND state = 'delivered'`
      )
      .get(caseId) as { n: number };
    if (delivered.n > 0) {
      throw conflict('case already has delivered review work', { delivered: delivered.n });
    }

    const r1 = mustGet(
      db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(reviewerIds[0], actor.tenant_id),
      'reviewer'
    );
    const r2 = mustGet(
      db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(reviewerIds[1], actor.tenant_id),
      'reviewer'
    );
    const a1 = getActor(db, r1.id as string)!;
    const a2 = getActor(db, r2.id as string)!;

    const itemRef = {
      language: item.language as string,
      org_id: item.org_id as string,
      id: item.id as string,
    };
    const e1 = checkEligibility(a1, itemRef, { role: 'reviewer' });
    const e2 = checkEligibility(a2, itemRef, { role: 'reviewer' });
    const pair = checkSlotPair(a1, a2, snap);
    if (!e1.eligible || !e2.eligible || !pair.eligible) {
      throw unprocessable('reviewers are not eligible for the two blind slots', {
        reviewer_1: { id: a1.id, reasons: e1.reasons },
        reviewer_2: { id: a2.id, reasons: e2.reasons },
        pair_reasons: pair.reasons,
        next_action: 'select eligible reviewers honoring consent, calibration and conflicts',
      });
    }

    const active = db
      .prepare(
        `SELECT slot FROM assignments WHERE case_id = ? AND kind = 'review'
         AND state IN ('offered','accepted') ORDER BY slot`
      )
      .all(caseId) as { slot: number }[];
    const freeSlots = [1, 2].filter((s) => !active.some((a) => a.slot === s));
    if (freeSlots.length < 2) {
      throw conflict('both reviewer slots are already filled', { active_slots: active });
    }

    const created = [
      reserveAndOffer(db, actor, caseRow, a1, freeSlots[0], 'review', snap.review_price_minor, leaseMs),
      reserveAndOffer(
        db,
        actor,
        { ...caseRow, reserved_minor: (caseRow.reserved_minor as number) + snap.review_price_minor },
        a2,
        freeSlots[1],
        'review',
        snap.review_price_minor,
        leaseMs
      ),
    ];
    setCaseState(db, caseId, 'slots_reserved');
    return created.map((a) => presentAssignment(a, { alias: aliasFor(db, a.reviewer_id) }));
  });
}

/**
 * Create the single expert offer for a case in awaiting_expert state.
 * Reserves the expert price against the same budget cap.
 */
export function assignExpert(
  db: Db,
  actor: Actor,
  caseId: string,
  expertId: string | null,
  leaseMs: number = DEFAULT_LEASE_MS
) {
  // Pre-check the budget so the recoverable waiting_funds state commits
  // before the caller-facing error is raised.
  const pre = getCase(db, actor.tenant_id, caseId);
  const preState = pre.state as string;
  if (preState !== 'awaiting_expert' && preState !== 'waiting_funds') {
    throw conflict(`case state ${preState} does not accept an expert assignment`);
  }
  const preSnap = getCaseSnapshot(pre);
  const cap = pre.budget_cap_minor as number | null;
  if (cap === null || (pre.reserved_minor as number) + preSnap.expert_price_minor > cap) {
    tx(db, () =>
      setCaseState(db, caseId, 'waiting_funds', 'insufficient_budget_for_expert')
    );
    throw unprocessable('insufficient budget for the expert reservation', {
      cap_minor: cap,
      reserved_minor: pre.reserved_minor,
      required_minor: preSnap.expert_price_minor,
      next_action: 'budget owner raises the cap, then retry the expert assignment',
    });
  }

  return tx(db, () => {
    const caseRow = getCase(db, actor.tenant_id, caseId);
    const snap = getCaseSnapshot(caseRow);
    const item = db
      .prepare('SELECT * FROM items WHERE id = ?')
      .get(caseRow.item_id as string) as Record<string, unknown>;
    const itemRef = {
      language: item.language as string,
      org_id: item.org_id as string,
      id: item.id as string,
    };

    let expert: Actor | null = null;
    if (expertId) {
      expert = getActor(db, expertId);
      if (!expert || expert.tenant_id !== actor.tenant_id) throw notFound('expert not found');
      const e = checkEligibility(expert, itemRef, { role: 'expert' });
      if (!e.eligible) {
        throw unprocessable('expert is not eligible for this case', { reasons: e.reasons });
      }
    } else {
      const rows = db
        .prepare(
          `SELECT id FROM actors WHERE tenant_id = ? AND role = 'expert' ORDER BY created_at`
        )
        .all(actor.tenant_id) as { id: string }[];
      const reviewerPrincipals = new Set(
        (
          db
            .prepare(
              `SELECT principal_id FROM assignments WHERE case_id = ? AND kind = 'review'`
            )
            .all(caseId) as { principal_id: string }[]
        ).map((r) => r.principal_id)
      );
      for (const row of rows) {
        const cand = getActor(db, row.id)!;
        if (reviewerPrincipals.has(cand.principal_id)) continue;
        if (checkEligibility(cand, itemRef, { role: 'expert' }).eligible) {
          expert = cand;
          break;
        }
      }
      if (!expert) {
        throw unprocessable('no eligible expert is enrolled for this case', {
          next_action: 'enroll a calibrated expert or assign one explicitly',
        });
      }
    }

    const asg = reserveAndOffer(db, actor, caseRow, expert, 3, 'expert', snap.expert_price_minor, leaseMs);
    setCaseState(db, caseId, 'awaiting_expert');
    return presentAssignment(asg, { alias: aliasFor(db, asg.reviewer_id) });
  });
}

/** Reviewer accepts a scoped offer after seeing disclosed pay. */
export function acceptAssignment(db: Db, actor: Actor, assignmentId: string) {
  return tx(db, () => {
    const a = getAssignment(db, actor.tenant_id, assignmentId);
    if (a.reviewer_id !== actor.id) throw notFound('assignment not found');
    if (a.state === 'expired') throw gone('offer has expired');
    if (a.state !== 'offered') throw conflict(`assignment state ${a.state} cannot be accepted`);
    if (Date.parse(a.lease_expires_at) <= Date.now()) {
      expireAssignment(db, a);
      throw gone('offer has expired');
    }
    db.prepare(
      `UPDATE assignments SET state = 'accepted', accepted_at = ? WHERE id = ?`
    ).run(nowIso(), a.id);
    const caseRow = getCase(db, actor.tenant_id, a.case_id);
    if (a.kind === 'review' && (caseRow.state as string) === 'slots_reserved') {
      setCaseState(db, a.case_id, 'reviewing');
    }
    audit(db, actor.tenant_id, actor.id, 'assignment.accept', 'assignment', a.id);
    return presentAssignment(getAssignment(db, actor.tenant_id, a.id), { alias: actor.alias });
  });
}

/** Reviewer declines/expiry helper — frees the slot and releases the reservation. */
export function expireAssignment(db: Db, a: AssignmentRow): void {
  db.prepare(`UPDATE assignments SET state = 'expired' WHERE id = ?`).run(a.id);
  db.prepare('UPDATE cases SET reserved_minor = MAX(0, reserved_minor - ?), updated_at = ? WHERE id = ?').run(
    a.price_minor,
    nowIso(),
    a.case_id
  );
  audit(db, a.tenant_id, null, 'assignment.expire', 'assignment', a.id, {
    case_id: a.case_id,
    slot: a.slot,
    kind: a.kind,
  });
}

/** Worker sweep: expire all un-accepted work whose lease has lapsed. */
export function expireStaleLeases(db: Db, now: Date = new Date()): number {
  const rows = db
    .prepare(
      `SELECT * FROM assignments WHERE state IN ('offered','accepted') AND lease_expires_at <= ?`
    )
    .all(now.toISOString()) as AssignmentRow[];
  let n = 0;
  for (const a of rows) {
    expireAssignment(db, a);
    n++;
  }
  return n;
}

/** Create the payable entitlement for delivered work. Idempotent per assignment. */
export function recordEntitlement(db: Db, a: AssignmentRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO entitlements
       (id, tenant_id, assignment_id, amount_minor, currency, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'payable', ?, ?)`
  ).run(newId('ent'), a.tenant_id, a.id, a.price_minor, a.currency, nowIso(), nowIso());
}

export function caseAssignments(db: Db, tenantId: string, caseId: string) {
  const rows = db
    .prepare('SELECT * FROM assignments WHERE case_id = ? AND tenant_id = ? ORDER BY slot')
    .all(caseId, tenantId) as AssignmentRow[];
  return rows.map((r) => presentAssignment(r, { alias: aliasFor(db, r.reviewer_id) }));
}

/** Reviewer queue: only this actor's own assignments. */
export function actorAssignments(db: Db, actor: Actor) {
  const rows = db
    .prepare(
      `SELECT * FROM assignments WHERE reviewer_id = ? AND tenant_id = ?
       ORDER BY created_at DESC`
    )
    .all(actor.id, actor.tenant_id) as AssignmentRow[];
  return rows.map((r) => presentAssignment(r, { alias: actor.alias }));
}
