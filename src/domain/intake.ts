import type { Db } from '../lib/db.ts';
import { tx } from '../lib/db.ts';
import { newId, nowIso, sha256Hex, hashObject } from '../lib/hash.ts';
import { badRequest, conflict, unprocessable } from '../lib/errors.ts';
import { audit, mustGet } from './actors.ts';
import type { Actor, PolicySnapshot } from './types.ts';

// ---------- policies ----------

export interface CreatePolicyInput {
  taxonomy: string[];
  guideline_text: string;
  expert_on_disagreement?: boolean;
  allow_concordance?: boolean;
  require_org_separation?: boolean;
  review_price_minor: number;
  expert_price_minor: number;
  currency?: string;
}

export function createPolicy(db: Db, actor: Actor, input: CreatePolicyInput) {
  if (!Array.isArray(input.taxonomy) || input.taxonomy.length === 0) {
    throw badRequest('taxonomy must be a non-empty label list');
  }
  if (new Set(input.taxonomy).size !== input.taxonomy.length) {
    throw badRequest('taxonomy contains duplicate labels');
  }
  if (!input.guideline_text) throw badRequest('guideline_text is required');
  if (!Number.isInteger(input.review_price_minor) || input.review_price_minor < 0) {
    throw badRequest('review_price_minor must be a non-negative integer');
  }
  if (!Number.isInteger(input.expert_price_minor) || input.expert_price_minor < 0) {
    throw badRequest('expert_price_minor must be a non-negative integer');
  }
  const currency = input.currency ?? 'USD';
  const id = newId('pol');
  const version =
    ((db.prepare('SELECT MAX(version) AS v FROM policies WHERE tenant_id = ?').get(actor.tenant_id) as {
      v: number | null;
    }).v ?? 0) + 1;

  db.prepare(
    `INSERT INTO policies (id, tenant_id, version, taxonomy_json, taxonomy_hash, guideline_text,
       guideline_hash, expert_on_disagreement, allow_concordance, require_org_separation,
       review_price_minor, expert_price_minor, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    actor.tenant_id,
    version,
    JSON.stringify(input.taxonomy),
    hashObject(input.taxonomy),
    input.guideline_text,
    sha256Hex(input.guideline_text),
    input.expert_on_disagreement === false ? 0 : 1,
    input.allow_concordance === false ? 0 : 1,
    input.require_org_separation ? 1 : 0,
    input.review_price_minor,
    input.expert_price_minor,
    currency,
    nowIso()
  );
  audit(db, actor.tenant_id, actor.id, 'policy.create', 'policy', id, { version });
  return mustGet(db.prepare('SELECT * FROM policies WHERE id = ?').get(id));
}

export function getPolicy(db: Db, tenantId: string, id: string) {
  return mustGet(
    db.prepare('SELECT * FROM policies WHERE id = ? AND tenant_id = ?').get(id, tenantId),
    'policy'
  );
}

export function listPolicies(db: Db, tenantId: string) {
  return db.prepare('SELECT * FROM policies WHERE tenant_id = ? ORDER BY version').all(tenantId);
}

export function policySnapshot(row: Record<string, unknown>): PolicySnapshot {
  return {
    policy_id: row.id as string,
    version: row.version as number,
    taxonomy: JSON.parse(row.taxonomy_json as string),
    taxonomy_hash: row.taxonomy_hash as string,
    guideline_text: row.guideline_text as string,
    guideline_hash: row.guideline_hash as string,
    expert_on_disagreement: row.expert_on_disagreement === 1,
    allow_concordance: row.allow_concordance === 1,
    require_org_separation: row.require_org_separation === 1,
    review_price_minor: row.review_price_minor as number,
    expert_price_minor: row.expert_price_minor as number,
    currency: row.currency as string,
  };
}

// ---------- items ----------

export interface CreateItemInput {
  org_id: string;
  language: string;
  content: string;
  dataset_version: string;
  original_label?: string;
  gold_label?: string;
  consent_scope: string;
  consent_expires_at: string;
}

export function createItem(db: Db, actor: Actor, input: CreateItemInput) {
  if (!input.org_id || !input.language || !input.content || !input.dataset_version) {
    throw badRequest('org_id, language, content and dataset_version are required');
  }
  if (!input.consent_scope || !input.consent_expires_at) {
    throw badRequest('consent_scope and consent_expires_at are required');
  }
  if (Number.isNaN(Date.parse(input.consent_expires_at))) {
    throw badRequest('consent_expires_at must be an ISO timestamp');
  }
  const id = newId('itm');
  const now = nowIso();
  db.prepare(
    `INSERT INTO items (id, tenant_id, org_id, language, content, content_hash, dataset_version,
       original_label, gold_label, consent_scope, consent_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    actor.tenant_id,
    input.org_id,
    input.language,
    input.content,
    sha256Hex(input.content),
    input.dataset_version,
    input.original_label ?? null,
    input.gold_label ?? null,
    input.consent_scope,
    input.consent_expires_at,
    now,
    now
  );
  audit(db, actor.tenant_id, actor.id, 'item.create', 'item', id);
  return mustGet(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
}

export function getItem(db: Db, tenantId: string, id: string) {
  return mustGet(
    db.prepare('SELECT * FROM items WHERE id = ? AND tenant_id = ?').get(id, tenantId),
    'item'
  );
}

/** Source-side alteration: recomputes the content hash. Existing cases keep their frozen hash. */
export function updateItemContent(db: Db, actor: Actor, itemId: string, content: string) {
  const item = getItem(db, actor.tenant_id, itemId);
  db.prepare('UPDATE items SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?').run(
    content,
    sha256Hex(content),
    nowIso(),
    item.id as string
  );
  audit(db, actor.tenant_id, actor.id, 'item.update_content', 'item', itemId);
  return getItem(db, actor.tenant_id, itemId);
}

export function listItems(db: Db, tenantId: string) {
  return db
    .prepare(
      `SELECT id, tenant_id, org_id, language, content_hash, dataset_version, original_label,
              consent_scope, consent_expires_at, created_at
       FROM items WHERE tenant_id = ? ORDER BY created_at`
    )
    .all(tenantId);
}

// ---------- cases ----------

export interface CreateCaseInput {
  item_id: string;
  policy_id: string;
  disputed_label: string;
  budget_cap_minor?: number;
  budget_currency?: string;
}

/**
 * Open a dispute case. Freezes the item hash and a full policy snapshot.
 * Replayed submissions for the same (item, policy) return the existing case.
 */
export function createCase(db: Db, actor: Actor, input: CreateCaseInput) {
  if (!input.item_id || !input.policy_id || !input.disputed_label) {
    throw badRequest('item_id, policy_id and disputed_label are required');
  }
  return tx(db, () => {
    const item = getItem(db, actor.tenant_id, input.item_id) as Record<string, unknown>;
    const policy = getPolicy(db, actor.tenant_id, input.policy_id) as Record<string, unknown>;
    const snap = policySnapshot(policy);

    if (!snap.taxonomy.includes(input.disputed_label)) {
      throw unprocessable('disputed_label is not in the frozen taxonomy', {
        disputed_label: input.disputed_label,
        taxonomy: snap.taxonomy,
        next_action: 'correct the label or open the case under a policy version that contains it',
      });
    }
    const consentExpiry = Date.parse(item.consent_expires_at as string);
    if (consentExpiry <= Date.now()) {
      throw unprocessable('item consent scope has expired', {
        consent_scope: item.consent_scope,
        consent_expires_at: item.consent_expires_at,
        next_action: 'obtain renewed consent before adjudicating this item',
      });
    }
    if (input.budget_cap_minor !== undefined) {
      if (!Number.isInteger(input.budget_cap_minor) || input.budget_cap_minor < 0) {
        throw badRequest('budget_cap_minor must be a non-negative integer');
      }
    }
    const budgetCurrency = input.budget_currency ?? snap.currency;
    if (input.budget_cap_minor !== undefined && budgetCurrency !== snap.currency) {
      throw badRequest('budget currency must match policy currency', {
        policy_currency: snap.currency,
      });
    }

    const existing = db
      .prepare('SELECT * FROM cases WHERE tenant_id = ? AND item_id = ? AND policy_id = ?')
      .get(actor.tenant_id, input.item_id, input.policy_id) as Record<string, unknown> | undefined;
    if (existing) {
      return { case: presentCase(existing), deduplicated: true };
    }

    const id = newId('case');
    const now = nowIso();
    db.prepare(
      `INSERT INTO cases (id, tenant_id, item_id, item_hash, policy_id, policy_snapshot_json,
         base_version, disputed_label, state, budget_cap_minor, budget_currency, reserved_minor,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'opened', ?, ?, 0, ?, ?)`
    ).run(
      id,
      actor.tenant_id,
      input.item_id,
      item.content_hash as string,
      input.policy_id,
      JSON.stringify(snap),
      item.dataset_version as string,
      input.disputed_label,
      input.budget_cap_minor ?? null,
      input.budget_cap_minor !== undefined ? budgetCurrency : null,
      now,
      now
    );
    audit(db, actor.tenant_id, actor.id, 'case.create', 'case', id, {
      item_hash: item.content_hash,
      policy_version: snap.version,
    });
    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as Record<string, unknown>;
    return { case: presentCase(row), deduplicated: false };
  });
}

export function getCase(db: Db, tenantId: string, id: string) {
  return mustGet(
    db.prepare('SELECT * FROM cases WHERE id = ? AND tenant_id = ?').get(id, tenantId),
    'case'
  ) as Record<string, unknown>;
}

export function getCaseSnapshot(caseRow: Record<string, unknown>): PolicySnapshot {
  return JSON.parse(caseRow.policy_snapshot_json as string) as PolicySnapshot;
}

export function setCaseState(db: Db, caseId: string, state: string, unresolvedReason?: string | null) {
  db.prepare('UPDATE cases SET state = ?, unresolved_reason = ?, updated_at = ? WHERE id = ?').run(
    state,
    unresolvedReason ?? null,
    nowIso(),
    caseId
  );
}

/** Budget owner authorizes or raises the spending cap for a case. */
export function setCaseBudget(
  db: Db,
  actor: Actor,
  caseId: string,
  capMinor: number,
  currency: string
) {
  if (!Number.isInteger(capMinor) || capMinor < 0) {
    throw badRequest('cap_minor must be a non-negative integer');
  }
  if (!currency) throw badRequest('currency is required');
  return tx(db, () => {
    const c = getCase(db, actor.tenant_id, caseId);
    const snap = getCaseSnapshot(c);
    if (currency !== snap.currency) {
      throw conflict('budget currency does not match the frozen policy currency', {
        policy_currency: snap.currency,
      });
    }
    db.prepare(
      'UPDATE cases SET budget_cap_minor = ?, budget_currency = ?, updated_at = ? WHERE id = ?'
    ).run(capMinor, currency, nowIso(), caseId);
    audit(db, actor.tenant_id, actor.id, 'case.set_budget', 'case', caseId, {
      cap_minor: capMinor,
      currency,
    });
    return getCase(db, actor.tenant_id, caseId);
  });
}

/** Steward-facing case view: includes state reason, never payment identity. */
export function presentCase(row: Record<string, unknown>) {
  const snap = JSON.parse(row.policy_snapshot_json as string);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    item_id: row.item_id,
    item_hash: row.item_hash,
    policy_id: row.policy_id,
    policy_version: snap.version,
    taxonomy_hash: snap.taxonomy_hash,
    guideline_hash: snap.guideline_hash,
    base_version: row.base_version,
    disputed_label: row.disputed_label,
    state: row.state,
    unresolved_reason: row.unresolved_reason,
    budget_cap_minor: row.budget_cap_minor,
    budget_currency: row.budget_currency,
    reserved_minor: row.reserved_minor,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listCases(db: Db, tenantId: string) {
  const rows = db
    .prepare('SELECT * FROM cases WHERE tenant_id = ? ORDER BY created_at')
    .all(tenantId) as Record<string, unknown>[];
  return rows.map(presentCase);
}
