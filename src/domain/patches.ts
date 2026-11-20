import type { Db } from '../lib/db.ts';
import { tx } from '../lib/db.ts';
import { newId, nowIso, canonicalJson, sha256Hex } from '../lib/hash.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { audit, mustGet } from './actors.ts';
import { getCase } from './intake.ts';
import type { Actor } from './types.ts';

interface PatchRow {
  id: string;
  tenant_id: string;
  seq: number;
  source_version: string;
  diff_json: string;
  excluded_json: string;
  hash: string;
  state: string;
  created_by: string;
  approved_by: string | null;
  supersedes_id: string | null;
  created_at: string;
  approved_at: string | null;
}

export function presentPatch(r: PatchRow) {
  return {
    id: r.id,
    seq: r.seq,
    source_version: r.source_version,
    diff: JSON.parse(r.diff_json),
    excluded: JSON.parse(r.excluded_json),
    hash: r.hash,
    state: r.state,
    created_by: r.created_by,
    approved_by: r.approved_by,
    supersedes_id: r.supersedes_id,
    created_at: r.created_at,
    approved_at: r.approved_at,
  };
}

/**
 * Latest effective ruling per case: highest decision seq wins, so a supersede
 * replaces the earlier ruling without mutating it.
 */
function effectiveDecision(db: Db, caseId: string) {
  return db
    .prepare('SELECT * FROM decisions WHERE case_id = ? ORDER BY seq DESC LIMIT 1')
    .get(caseId) as Record<string, unknown> | undefined;
}

/**
 * Build a deterministic patch over decided cases. Only resolved decisions
 * whose frozen item hash still matches the current source item are included;
 * everything else is listed under `excluded` with an operator-facing reason.
 */
export function buildPatch(db: Db, actor: Actor, caseIds: string[], supersedesId?: string) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw badRequest('case_ids must be a non-empty list');
  }
  return tx(db, () => {
    const diff: Record<string, unknown>[] = [];
    const excluded: { case_id: string; reason: string }[] = [];
    let sourceVersion: string | null = null;

    for (const caseId of [...caseIds].sort()) {
      const c = getCase(db, actor.tenant_id, caseId);
      const dec = effectiveDecision(db, caseId);
      if (!dec || dec.label === null) {
        excluded.push({
          case_id: caseId,
          reason: dec ? `unresolved:${dec.reason}` : 'unresolved:no_decision',
        });
        continue;
      }
      const item = db
        .prepare('SELECT id, content_hash, dataset_version, original_label FROM items WHERE id = ?')
        .get(c.item_id as string) as Record<string, unknown>;
      if (item.content_hash !== c.item_hash) {
        excluded.push({ case_id: caseId, reason: 'source_hash_mismatch' });
        continue;
      }
      const version = item.dataset_version as string;
      if (sourceVersion === null) sourceVersion = version;
      if (version !== sourceVersion || version !== c.base_version) {
        excluded.push({ case_id: caseId, reason: 'dataset_version_mismatch' });
        continue;
      }
      diff.push({
        item_id: c.item_id,
        base_version: version,
        from_label: item.original_label,
        to_label: dec.label,
        decision_id: dec.id,
        decision_source: dec.source,
        case_id: caseId,
      });
    }

    diff.sort((a, b) => (a.item_id as string).localeCompare(b.item_id as string));
    if (diff.length === 0) {
      throw conflict('no resolved decisions target a matching source item hash', {
        excluded,
        next_action: 'resolve cases or restore the pinned source items before patching',
      });
    }

    const content = { source_version: sourceVersion, diff };
    const hash = sha256Hex(canonicalJson(content));
    const id = newId('pat');
    const seq =
      ((db
        .prepare('SELECT MAX(seq) AS s FROM patches WHERE tenant_id = ?')
        .get(actor.tenant_id) as { s: number | null }).s ?? 0) + 1;
    db.prepare(
      `INSERT INTO patches (id, tenant_id, seq, source_version, diff_json, excluded_json, hash,
         state, created_by, supersedes_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    ).run(
      id,
      actor.tenant_id,
      seq,
      sourceVersion,
      JSON.stringify(diff),
      JSON.stringify(excluded),
      hash,
      actor.id,
      supersedesId ?? null,
      nowIso()
    );
    audit(db, actor.tenant_id, actor.id, 'patch.create', 'patch', id, { hash, seq });
    return presentPatch(
      db.prepare('SELECT * FROM patches WHERE id = ?').get(id) as PatchRow
    );
  });
}

export function approvePatch(db: Db, actor: Actor, patchId: string) {
  return tx(db, () => {
    const p = mustGet(
      db.prepare('SELECT * FROM patches WHERE id = ? AND tenant_id = ?').get(patchId, actor.tenant_id),
      'patch'
    ) as PatchRow;
    if (p.state !== 'draft') throw conflict(`patch state ${p.state} cannot be approved`);
    db.prepare(
      `UPDATE patches SET state = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`
    ).run(actor.id, nowIso(), p.id);
    // Mark the contained cases exported-eligible once QA accepts.
    const diff = JSON.parse(p.diff_json) as { case_id: string }[];
    for (const d of diff) {
      db.prepare(
        `UPDATE cases SET state = 'exported', updated_at = ? WHERE id = ?
         AND state IN ('concordant','expert_decided')`
      ).run(nowIso(), d.case_id);
    }
    audit(db, actor.tenant_id, actor.id, 'patch.approve', 'patch', patchId);
    return presentPatch(
      db.prepare('SELECT * FROM patches WHERE id = ?').get(p.id) as PatchRow
    );
  });
}

export function exportPatch(db: Db, actor: Actor, patchId: string) {
  return tx(db, () => {
    const p = mustGet(
      db.prepare('SELECT * FROM patches WHERE id = ? AND tenant_id = ?').get(patchId, actor.tenant_id),
      'patch'
    ) as PatchRow;
    if (p.state !== 'approved') {
      throw conflict('patch requires QA approval before export', { state: p.state });
    }
    db.prepare(`UPDATE patches SET state = 'exported' WHERE id = ?`).run(p.id);
    audit(db, actor.tenant_id, actor.id, 'patch.export', 'patch', patchId, { hash: p.hash });
    return presentPatch(
      db.prepare('SELECT * FROM patches WHERE id = ?').get(p.id) as PatchRow
    );
  });
}

export function listPatches(db: Db, tenantId: string) {
  const rows = db
    .prepare('SELECT * FROM patches WHERE tenant_id = ? ORDER BY seq')
    .all(tenantId) as PatchRow[];
  return rows.map(presentPatch);
}

export function getPatch(db: Db, tenantId: string, id: string) {
  return presentPatch(
    mustGet(
      db.prepare('SELECT * FROM patches WHERE id = ? AND tenant_id = ?').get(id, tenantId),
      'patch'
    ) as PatchRow
  );
}
