import type { Db } from '../lib/db.ts';
import { tx } from '../lib/db.ts';
import { newId, nowIso } from '../lib/hash.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { audit } from './actors.ts';
import { getCase, getCaseSnapshot, setCaseState } from './intake.ts';
import { recordEntitlement, getAssignment } from './assignments.ts';
import type { Actor } from './types.ts';

export interface RouteResult {
  action: 'concordant' | 'expert_needed' | 'unresolved' | 'waiting' | 'noop';
  detail?: string;
}

const ROUTED_STATES = new Set([
  'concordant',
  'awaiting_expert',
  'waiting_funds',
  'expert_decided',
  'unresolved',
  'exported',
]);

/**
 * Deterministic routing after both blind finals. Idempotent: re-processing a
 * delivered outbox row (or a duplicate submit signal) is a no-op, so worker
 * redelivery can never create a second escalation.
 */
export function routeCase(db: Db, caseId: string): RouteResult {
  return tx(db, () => {
    const caseRow = getCaseForRouting(db, caseId);
    const state = caseRow.state as string;
    if (ROUTED_STATES.has(state)) return { action: 'noop', detail: `state ${state}` };

    const snap = getCaseSnapshot(caseRow);
    const finals = db
      .prepare(
        `SELECT s.label, s.abstain, asn.slot FROM submissions s
         JOIN assignments asn ON asn.id = s.assignment_id
         WHERE asn.case_id = ? AND asn.kind = 'review' AND s.kind = 'final'
         ORDER BY asn.slot`
      )
      .all(caseId) as { label: string | null; abstain: number; slot: number }[];
    if (finals.length < 2) return { action: 'waiting', detail: 'awaiting both final opinions' };

    const bothAgree =
      finals[0].abstain === 0 && finals[1].abstain === 0 && finals[0].label === finals[1].label;

    if (bothAgree && snap.allow_concordance) {
      recordDecision(db, caseRow, 'concordant', finals[0].label, 'reviewers_concordant', null);
      setCaseState(db, caseId, 'concordant');
      return { action: 'concordant' };
    }

    if (snap.expert_on_disagreement) {
      const existing = db
        .prepare(
          `SELECT COUNT(*) AS n FROM assignments
           WHERE case_id = ? AND kind = 'expert' AND state IN ('offered','accepted','delivered')`
        )
        .get(caseId) as { n: number };
      if (existing.n === 0) {
        setCaseState(db, caseId, 'awaiting_expert');
        return { action: 'expert_needed', detail: 'awaiting expert offer' };
      }
      return { action: 'noop', detail: 'expert already assigned' };
    }

    recordDecision(db, caseRow, 'concordant', null, 'disagreement_no_expert_path', null);
    setCaseState(db, caseId, 'unresolved', 'disagreement_no_expert_path');
    return { action: 'unresolved', detail: 'disagreement_no_expert_path' };
  });
}

function getCaseForRouting(db: Db, caseId: string) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('case not found');
  return row;
}

function recordDecision(
  db: Db,
  caseRow: Record<string, unknown>,
  source: 'concordant' | 'expert' | 'supersede',
  label: string | null,
  reason: string,
  actorId: string | null
): string {
  const next =
    ((db.prepare('SELECT MAX(seq) AS s FROM decisions WHERE case_id = ?').get(caseRow.id as string) as {
      s: number | null;
    }).s ?? 0) + 1;
  const id = newId('dec');
  db.prepare(
    `INSERT INTO decisions (id, tenant_id, case_id, seq, source, base_hash, label, reason, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    caseRow.tenant_id as string,
    caseRow.id as string,
    next,
    source,
    caseRow.item_hash as string,
    label,
    reason,
    actorId,
    nowIso()
  );
  return id;
}

/**
 * Expert resolution or abstention. Requires the actor to hold the live expert
 * assignment for this case. Resolves the case or leaves it unresolved; a
 * QA supersede may append a corrected ruling afterwards.
 */
export function recordExpertDecision(
  db: Db,
  actor: Actor,
  caseId: string,
  input: { label?: string | null; abstain?: boolean; rationale: string; supersede?: boolean }
) {
  if (!input.rationale || !input.rationale.trim()) throw unprocessable('a rationale is required');
  const abstain = input.abstain === true;
  const supersede = input.supersede === true;
  if (abstain && input.label) throw unprocessable('an abstention cannot carry a label');

  return tx(db, () => {
    const caseRow = getCase(db, actor.tenant_id, caseId);
    const snap = getCaseSnapshot(caseRow);
    const state = caseRow.state as string;

    if (supersede) {
      if (actor.role !== 'qa' && actor.role !== 'steward') {
        throw conflict('only qa or steward may supersede a ruling');
      }
      if (!input.label || !snap.taxonomy.includes(input.label)) {
        throw unprocessable('superseding label must come from the frozen taxonomy');
      }
      recordDecision(db, caseRow, 'supersede', input.label, input.rationale, actor.id);
      setCaseState(db, caseId, 'expert_decided');
      audit(db, actor.tenant_id, actor.id, 'decision.supersede', 'case', caseId, {
        label: input.label,
      });
      return { state: 'expert_decided', superseded: true };
    }

    if (state !== 'awaiting_expert') {
      throw conflict(`case state ${state} does not accept an expert decision`);
    }
    const asg = db
      .prepare(
        `SELECT * FROM assignments WHERE case_id = ? AND kind = 'expert'
         AND reviewer_id = ? AND state IN ('offered','accepted')`
      )
      .get(caseId, actor.id) as Record<string, unknown> | undefined;
    if (!asg) throw notFound('expert assignment not found');
    if (Date.parse(asg.lease_expires_at as string) <= Date.now()) {
      throw conflict('expert lease has expired');
    }

    if (abstain) {
      recordDecision(db, caseRow, 'expert', null, 'expert_abstain', actor.id);
      setCaseState(db, caseId, 'unresolved', 'expert_abstain');
    } else {
      if (!input.label || !snap.taxonomy.includes(input.label)) {
        throw unprocessable('expert label must come from the frozen taxonomy', {
          taxonomy: snap.taxonomy,
        });
      }
      recordDecision(db, caseRow, 'expert', input.label, input.rationale, actor.id);
      setCaseState(db, caseId, 'expert_decided');
    }

    // Deliver the expert assignment and record its payable entitlement.
    db.prepare(`UPDATE assignments SET state = 'delivered', delivered_at = ? WHERE id = ?`).run(
      nowIso(),
      asg.id as string
    );
    recordEntitlement(db, {
      id: asg.id,
      tenant_id: asg.tenant_id,
      price_minor: asg.price_minor,
      currency: asg.currency,
    } as Parameters<typeof recordEntitlement>[0]);
    audit(db, actor.tenant_id, actor.id, 'decision.expert', 'case', caseId, {
      label: input.label ?? null,
      abstain,
    });
    return { state: abstain ? 'unresolved' : 'expert_decided', abstain };
  });
}
