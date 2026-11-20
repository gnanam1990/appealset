import type { Db } from '../lib/db.ts';
import { tx } from '../lib/db.ts';
import { newId, nowIso } from '../lib/hash.ts';
import { badRequest, conflict, notFound, gone, unprocessable } from '../lib/errors.ts';
import { audit } from './actors.ts';
import { getCase, getCaseSnapshot, setCaseState } from './intake.ts';
import { getAssignment, recordEntitlement } from './assignments.ts';
import type { Actor } from './types.ts';

interface SubmissionRow {
  id: string;
  tenant_id: string;
  assignment_id: string;
  version: number;
  kind: 'draft' | 'final';
  label: string | null;
  abstain: number;
  rationale: string;
  submitted_at: string;
}

function emitOutbox(db: Db, tenantId: string, kind: string, payload: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO outbox (tenant_id, kind, payload_json, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(tenantId, kind, JSON.stringify(payload), nowIso());
}

/**
 * Blind workbench view. The reviewer sees only their own assignment: the item
 * content, frozen taxonomy and guidelines, pay terms and due time.
 * Peer labels, the original disputed label and all peer identity are withheld.
 */
export function taskView(db: Db, actor: Actor, assignmentId: string) {
  // One lookup; any non-owner (or cross-tenant) access returns the same 404,
  // so probing cannot reveal whether an assignment exists.
  const a = getAssignment(db, actor.tenant_id, assignmentId);
  if (a.reviewer_id !== actor.id) throw notFound('assignment not found');

  const caseRow = getCase(db, actor.tenant_id, a.case_id);
  const snap = getCaseSnapshot(caseRow);
  const item = db
    .prepare('SELECT language, content, content_hash, dataset_version FROM items WHERE id = ?')
    .get(caseRow.item_id as string) as Record<string, unknown>;

  const stale = a.state === 'expired' || a.state === 'cancelled';
  const drafts = db
    .prepare(
      `SELECT version, kind, label, abstain, rationale, submitted_at FROM submissions
       WHERE assignment_id = ? ORDER BY version`
    )
    .all(a.id) as Partial<SubmissionRow>[];
  const final = drafts.find((d) => (d as SubmissionRow).kind === 'final');

  let expertContext: object | null = null;
  if (a.kind === 'expert') {
    // Experts see both blind rationales, anonymized to slot numbers, only
    // after both blind submissions are closed (final or case routed onward).
    const peers = db
      .prepare(
        `SELECT s.label, s.abstain, s.rationale, s.submitted_at, asn.slot
         FROM submissions s JOIN assignments asn ON asn.id = s.assignment_id
         WHERE asn.case_id = ? AND asn.kind = 'review' AND s.kind = 'final'
         ORDER BY asn.slot`
      )
      .all(a.case_id) as Record<string, unknown>[];
    if (peers.length === 2) {
      expertContext = {
        blind_rationales: peers.map((p) => ({
          slot: p.slot,
          label: p.abstain === 1 ? null : p.label,
          abstain: p.abstain === 1,
          rationale: p.rationale,
          submitted_at: p.submitted_at,
        })),
      };
    }
  }

  return {
    assignment_id: a.id,
    case_id: a.case_id,
    kind: a.kind,
    state: a.state,
    stale,
    item: {
      language: item.language,
      content: item.content,
      content_hash: item.content_hash,
      dataset_version: item.dataset_version,
    },
    policy: {
      version: snap.version,
      taxonomy: snap.taxonomy,
      guideline_text: snap.guideline_text,
    },
    pay: { amount_minor: a.price_minor, currency: a.currency },
    lease_expires_at: a.lease_expires_at,
    drafts: drafts
      .filter((d) => (d as SubmissionRow).kind === 'draft')
      .map((d) => ({
        version: d.version,
        label: d.label,
        abstain: d.abstain === 1,
        rationale: d.rationale,
        submitted_at: d.submitted_at,
      })),
    final: final
      ? {
          version: (final as SubmissionRow).version,
          label: (final as SubmissionRow).label,
          abstain: (final as SubmissionRow).abstain === 1,
          rationale: (final as SubmissionRow).rationale,
          submitted_at: (final as SubmissionRow).submitted_at,
        }
      : null,
    expert_context: expertContext,
  };
}

export interface SubmitInput {
  kind: 'draft' | 'final';
  label?: string | null;
  abstain?: boolean;
  rationale: string;
}

/**
 * Save a draft or finalize one versioned opinion. Finalization marks the
 * assignment delivered, records the payable entitlement and emits a routing
 * event — all in one transaction, so a crash leaves no partial state.
 */
export function submit(db: Db, actor: Actor, assignmentId: string, input: SubmitInput) {
  if (input.kind !== 'draft' && input.kind !== 'final') {
    throw badRequest("kind must be 'draft' or 'final'");
  }
  if (!input.rationale || !input.rationale.trim()) {
    throw badRequest('a rationale is required');
  }
  const abstain = input.abstain === true;
  return tx(db, () => {
    const a = getAssignment(db, actor.tenant_id, assignmentId);
    if (a.reviewer_id !== actor.id) throw notFound('assignment not found');
    if (a.state === 'expired' || a.state === 'cancelled') {
      throw gone('assignment is no longer active', { state: a.state });
    }
    if (a.state === 'delivered') {
      throw conflict('a final opinion is already recorded for this assignment');
    }
    if (Date.parse(a.lease_expires_at) <= Date.now()) {
      throw gone('lease has expired', { lease_expires_at: a.lease_expires_at });
    }
    if (a.state === 'offered') {
      throw conflict('accept the offer before submitting', { state: a.state });
    }

    const caseRow = getCase(db, actor.tenant_id, a.case_id);
    const snap = getCaseSnapshot(caseRow);
    if (input.kind === 'final' && !abstain) {
      if (!input.label || !snap.taxonomy.includes(input.label)) {
        throw unprocessable('final label must be a non-abstain label from the frozen taxonomy', {
          taxonomy: snap.taxonomy,
        });
      }
    }
    if (abstain && input.label) {
      throw badRequest('an abstention cannot carry a label');
    }

    const nextVersion =
      ((db
        .prepare('SELECT MAX(version) AS v FROM submissions WHERE assignment_id = ?')
        .get(a.id) as { v: number | null }).v ?? 0) + 1;

    const subId = newId('sub');
    db.prepare(
      `INSERT INTO submissions (id, tenant_id, assignment_id, version, kind, label, abstain,
         rationale, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      subId,
      actor.tenant_id,
      a.id,
      nextVersion,
      input.kind,
      abstain ? null : input.label ?? null,
      abstain ? 1 : 0,
      input.rationale,
      nowIso()
    );

    if (input.kind === 'final') {
      const now = nowIso();
      db.prepare(
        `UPDATE assignments SET state = 'delivered', delivered_at = ? WHERE id = ?`
      ).run(now, a.id);
      recordEntitlement(db, a);
      audit(db, actor.tenant_id, actor.id, 'submission.final', 'submission', subId, {
        assignment_id: a.id,
        case_id: a.case_id,
      });
      if (a.kind === 'review') {
        // Signal the router once; the worker decides concordance/escalation.
        emitOutbox(db, actor.tenant_id, 'route_case', { case_id: a.case_id });
      }
    } else {
      audit(db, actor.tenant_id, actor.id, 'submission.draft', 'submission', subId, {
        assignment_id: a.id,
      });
    }
    return { submission_id: subId, version: nextVersion, kind: input.kind };
  });
}
