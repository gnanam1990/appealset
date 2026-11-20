import type { Db } from '../lib/db.ts';
import { tx } from '../lib/db.ts';
import { newId, nowIso, sha256Hex, canonicalJson } from '../lib/hash.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { audit, mustGet } from './actors.ts';
import { getCase } from './intake.ts';
import type { Actor } from './types.ts';
import type { PaymentAdapter } from '../payments/local-ledger.ts';

// ---------- per-case costs (finance-scoped) ----------

export function caseCosts(db: Db, actor: Actor, caseId: string) {
  const c = getCase(db, actor.tenant_id, caseId);
  const ents = db
    .prepare(
      `SELECT e.id, e.amount_minor, e.currency, e.state, e.provider, e.provider_ref,
              a.slot, a.kind, a.reviewer_id
       FROM entitlements e JOIN assignments a ON a.id = e.assignment_id
       WHERE a.case_id = ? ORDER BY a.slot`
    )
    .all(caseId) as Record<string, unknown>[];
  const alias = (id: string) =>
    (db.prepare('SELECT alias FROM actors WHERE id = ?').get(id) as { alias: string } | undefined)
      ?.alias ?? id;
  return {
    case_id: caseId,
    budget_cap_minor: c.budget_cap_minor,
    budget_currency: c.budget_currency,
    reserved_minor: c.reserved_minor,
    entitlements: ents.map((e) => ({
      id: e.id,
      slot: e.slot,
      kind: e.kind,
      payee_alias: alias(e.reviewer_id as string),
      amount_minor: e.amount_minor,
      currency: e.currency,
      state: e.state,
      provider: e.provider,
      provider_ref: e.provider_ref,
    })),
    total_entitled_minor: ents.reduce((s, e) => s + (e.amount_minor as number), 0),
  };
}

// ---------- tenant overview (INV-07: independent counts) ----------

export function overviewReport(db: Db, actor: Actor) {
  const t = actor.tenant_id;
  const caseCounts = db
    .prepare('SELECT state, COUNT(*) AS n FROM cases WHERE tenant_id = ? GROUP BY state')
    .all(t) as { state: string; n: number }[];
  const entCounts = db
    .prepare(
      `SELECT state, COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS total_minor
       FROM entitlements WHERE tenant_id = ? GROUP BY state`
    )
    .all(t) as { state: string; n: number; total_minor: number }[];
  const decisions = db
    .prepare(
      `SELECT source, COUNT(*) AS n,
              SUM(CASE WHEN label IS NULL THEN 1 ELSE 0 END) AS unresolved
       FROM decisions WHERE tenant_id = ? GROUP BY source`
    )
    .all(t) as { source: string; n: number; unresolved: number }[];
  return {
    tenant_id: t,
    cases_by_state: Object.fromEntries(caseCounts.map((r) => [r.state, r.n])),
    entitlements_by_state: Object.fromEntries(
      entCounts.map((r) => [r.state, { count: r.n, total_minor: r.total_minor }])
    ),
    decisions_by_source: decisions,
    note: 'counts are independent: resolved, unresolved, paid and pending are reported separately; majority agreement is not labeled ground truth',
  };
}

// ---------- calibration (gold subset) ----------

/**
 * Per-cohort calibration: agreement of reviewer finals with steward-held gold
 * labels. When no gold subset exists the report is explicitly unavailable.
 */
export function calibrationReport(db: Db, actor: Actor) {
  const rows = db
    .prepare(
      `SELECT a.reviewer_id, i.language, s.label AS reviewer_label, i.gold_label
       FROM submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN cases c ON c.id = a.case_id
       JOIN items i ON i.id = c.item_id
       WHERE s.tenant_id = ? AND s.kind = 'final' AND i.gold_label IS NOT NULL`
    )
    .all(actor.tenant_id) as Record<string, unknown>[];
  if (rows.length === 0) {
    return {
      status: 'unavailable',
      reason: 'no_gold_subset',
      detail: 'no items carry a steward-provided gold label; agreement with held-back expert judgments cannot be computed',
    };
  }
  const cohorts: Record<string, { reviewed: number; agreed: number }> = {};
  for (const r of rows) {
    const key = `${r.reviewer_id}|${r.language}`;
    cohorts[key] ??= { reviewed: 0, agreed: 0 };
    cohorts[key].reviewed++;
    if (r.reviewer_label === r.gold_label) cohorts[key].agreed++;
  }
  const alias = (id: string) =>
    (db.prepare('SELECT alias FROM actors WHERE id = ?').get(id) as { alias: string } | undefined)
      ?.alias ?? id;
  return {
    status: 'available',
    cohorts: Object.entries(cohorts).map(([k, v]) => {
      const [reviewer, language] = k.split('|');
      return {
        reviewer_alias: alias(reviewer),
        language,
        reviewed: v.reviewed,
        agreed: v.agreed,
        agreement_rate: v.reviewed ? v.agreed / v.reviewed : null,
      };
    }),
  };
}

// ---------- payout reconciliation ----------

/**
 * Dispatch a payable entitlement through the configured adapter. Persists the
 * provider reference before returning; an unknown outcome leaves the
 * entitlement 'pending' and blocks automatic redispatch.
 */
export function dispatchPayout(db: Db, actor: Actor, entitlementId: string, adapter: PaymentAdapter) {
  return tx(db, () => {
    const e = mustGet(
      db
        .prepare('SELECT * FROM entitlements WHERE id = ? AND tenant_id = ?')
        .get(entitlementId, actor.tenant_id),
      'entitlement'
    ) as Record<string, unknown>;
    if (e.state !== 'payable') {
      throw conflict(`entitlement state ${e.state} cannot be dispatched`);
    }
    const quote = adapter.quote(e.amount_minor as number, e.currency as string);
    const res = adapter.execute(quote, e.assignment_id as string);
    const newState = res.status === 'settled' ? 'paid' : 'pending';
    db.prepare(
      `UPDATE entitlements SET state = ?, provider = ?, provider_ref = ?, updated_at = ? WHERE id = ?`
    ).run(newState, adapter.name, res.ref, nowIso(), e.id as string);
    audit(db, actor.tenant_id, actor.id, 'payout.dispatch', 'entitlement', entitlementId, {
      provider: adapter.name,
      provider_ref: res.ref,
      outcome: newState,
    });
    return { id: e.id, state: newState, provider: adapter.name, provider_ref: res.ref };
  });
}

/**
 * Reconcile a pending payout with its original provider reference and exact
 * amount. 'unknown' keeps it pending — never silently marks paid.
 */
export function reconcilePayout(db: Db, actor: Actor, entitlementId: string, adapter: PaymentAdapter) {
  return tx(db, () => {
    const e = mustGet(
      db
        .prepare('SELECT * FROM entitlements WHERE id = ? AND tenant_id = ?')
        .get(entitlementId, actor.tenant_id),
      'entitlement'
    ) as Record<string, unknown>;
    if (e.state !== 'pending') {
      throw conflict(`entitlement state ${e.state} is not pending reconciliation`);
    }
    const res = adapter.status(e.provider_ref as string);
    const newState = res.status === 'settled' ? 'paid' : 'pending';
    db.prepare('UPDATE entitlements SET state = ?, updated_at = ? WHERE id = ?').run(
      newState,
      nowIso(),
      e.id as string
    );
    audit(db, actor.tenant_id, actor.id, 'payout.reconcile', 'entitlement', entitlementId, {
      provider_ref: e.provider_ref,
      outcome: newState,
    });
    return {
      id: e.id,
      state: newState,
      provider_ref: e.provider_ref,
      reconciliation: res.status === 'unknown' ? 'required' : 'complete',
    };
  });
}

export function listEntitlements(db: Db, actor: Actor) {
  return db
    .prepare('SELECT * FROM entitlements WHERE tenant_id = ? ORDER BY created_at')
    .all(actor.tenant_id);
}

// ---------- replayable evidence / recovery ----------

/**
 * Redacted case evidence bundle: the exact input revision, actor scope
 * (aliases), persisted decisions and evidence references. Peer payment
 * identity is excluded.
 */
export function caseBundle(db: Db, actor: Actor, caseId: string) {
  const c = getCase(db, actor.tenant_id, caseId);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(c.item_id as string) as Record<
    string,
    unknown
  >;
  const decisions = db
    .prepare('SELECT seq, source, base_hash, label, reason, actor_id, created_at FROM decisions WHERE case_id = ? ORDER BY seq')
    .all(caseId) as Record<string, unknown>[];
  const ents = db
    .prepare(
      `SELECT e.amount_minor, e.currency, e.state, e.provider
       FROM entitlements e JOIN assignments a ON a.id = e.assignment_id WHERE a.case_id = ?`
    )
    .all(caseId) as Record<string, unknown>[];
  const patches = db
    .prepare(
      `SELECT id, seq, hash, source_version, state, diff_json FROM patches
       WHERE tenant_id = ? AND diff_json LIKE ?`
    )
    .all(actor.tenant_id, `%"${caseId}"%`) as Record<string, unknown>[];
  return {
    case_id: caseId,
    state: c.state,
    input_revision: {
      item_id: c.item_id,
      content_hash: c.item_hash,
      current_source_hash: item.content_hash,
      dataset_version: c.base_version,
    },
    decisions: decisions.map((d) => ({
      seq: d.seq,
      source: d.source,
      base_hash: d.base_hash,
      label: d.label,
      reason: d.reason,
      created_at: d.created_at,
    })),
    entitlements_total_minor: ents.reduce((s, e) => s + (e.amount_minor as number), 0),
    entitlement_states: ents.map((e) => ({ state: e.state, provider: e.provider })),
    patches: patches.map((p) => ({
      id: p.id,
      seq: p.seq,
      hash: p.hash,
      source_version: p.source_version,
      state: p.state,
    })),
  };
}

/**
 * Recompute evidence from stored inputs and compare to recorded hashes —
 * the replay check after a restore. Returns each check independently.
 */
export function verifyReplay(db: Db, actor: Actor, caseId: string) {
  const c = getCase(db, actor.tenant_id, caseId);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(c.item_id as string) as Record<
    string,
    unknown
  >;
  const recomputedContentHash = sha256Hex(item.content as string);
  const patches = db
    .prepare(
      `SELECT * FROM patches WHERE tenant_id = ? AND diff_json LIKE ? ORDER BY seq`
    )
    .all(actor.tenant_id, `%"${caseId}"%`) as Record<string, unknown>[];
  const patchChecks = patches.map((p) => {
    const diff = JSON.parse(p.diff_json as string);
    const recomputed = sha256Hex(
      canonicalJson({ source_version: p.source_version, diff })
    );
    return { patch_id: p.id, recorded_hash: p.hash, recomputed_hash: recomputed, match: recomputed === p.hash };
  });
  const ents = db
    .prepare(
      `SELECT e.amount_minor FROM entitlements e JOIN assignments a ON a.id = e.assignment_id
       WHERE a.case_id = ?`
    )
    .all(caseId) as { amount_minor: number }[];
  const totalMinor = ents.reduce((s, e) => s + e.amount_minor, 0);
  return {
    case_id: caseId,
    content_hash: {
      recorded: c.item_hash,
      recomputed: recomputedContentHash,
      match: recomputedContentHash === c.item_hash,
    },
    patches: patchChecks,
    entitlement_total_minor: totalMinor,
  };
}
