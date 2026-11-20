import type { Db } from './db.ts';

/**
 * Versioned forward migrations. Each entry runs once, in order.
 * Monetary amounts are integer minor units paired with an ISO currency code.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE actors (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','steward','budget_owner','reviewer','expert','qa')),
  alias         TEXT NOT NULL,
  consent_status    TEXT CHECK (consent_status IN ('opted_in','opted_out',NULL)),
  languages_json    TEXT,
  calibration_expires_at TEXT,
  conflicts_json    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_actors_tenant ON actors(tenant_id, role);
CREATE INDEX ix_actors_principal ON actors(tenant_id, principal_id);

CREATE TABLE policies (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  taxonomy_json       TEXT NOT NULL,
  taxonomy_hash       TEXT NOT NULL,
  guideline_text      TEXT NOT NULL,
  guideline_hash      TEXT NOT NULL,
  expert_on_disagreement INTEGER NOT NULL DEFAULT 1,
  allow_concordance      INTEGER NOT NULL DEFAULT 1,
  require_org_separation INTEGER NOT NULL DEFAULT 0,
  review_price_minor  INTEGER NOT NULL,
  expert_price_minor  INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (tenant_id, version)
);

CREATE TABLE items (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  language       TEXT NOT NULL,
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  original_label TEXT,
  gold_label     TEXT,
  consent_scope  TEXT NOT NULL,
  consent_expires_at TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX ix_items_tenant ON items(tenant_id, dataset_version);

CREATE TABLE cases (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  item_id         TEXT NOT NULL REFERENCES items(id),
  item_hash       TEXT NOT NULL,
  policy_id       TEXT NOT NULL REFERENCES policies(id),
  policy_snapshot_json TEXT NOT NULL,
  base_version    TEXT NOT NULL,
  disputed_label  TEXT NOT NULL,
  state           TEXT NOT NULL,
  budget_cap_minor    INTEGER,
  budget_currency     TEXT,
  reserved_minor      INTEGER NOT NULL DEFAULT 0,
  unresolved_reason   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, item_id, policy_id)
);
CREATE INDEX ix_cases_tenant_state ON cases(tenant_id, state);

CREATE TABLE assignments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  slot          INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('review','expert')),
  reviewer_id   TEXT NOT NULL REFERENCES actors(id),
  principal_id  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('offered','accepted','delivered','expired','cancelled')),
  price_minor   INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  lease_epoch   INTEGER NOT NULL DEFAULT 1,
  offered_at    TEXT NOT NULL,
  accepted_at   TEXT,
  delivered_at  TEXT,
  created_at    TEXT NOT NULL
);
-- One active holder per (case, slot) at a time; expired/cancelled free the slot.
CREATE UNIQUE INDEX ux_assignments_active_slot
  ON assignments(case_id, slot) WHERE state IN ('offered','accepted');
-- At most one live expert escalation per case.
CREATE UNIQUE INDEX ux_assignments_live_expert
  ON assignments(case_id) WHERE kind = 'expert' AND state IN ('offered','accepted','delivered');
CREATE INDEX ix_assignments_case ON assignments(case_id, kind, state);
CREATE INDEX ix_assignments_reviewer ON assignments(reviewer_id, state);
CREATE INDEX ix_assignments_lease ON assignments(state, lease_expires_at);

CREATE TABLE submissions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  version       INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('draft','final')),
  label         TEXT,
  abstain       INTEGER NOT NULL DEFAULT 0,
  rationale     TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  UNIQUE (assignment_id, version)
);
-- Exactly one final opinion per assignment.
CREATE UNIQUE INDEX ux_submissions_final
  ON submissions(assignment_id) WHERE kind = 'final';

CREATE TABLE decisions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  case_id     TEXT NOT NULL REFERENCES cases(id),
  seq         INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('concordant','expert','supersede')),
  base_hash   TEXT NOT NULL,
  label       TEXT,
  reason      TEXT NOT NULL,
  actor_id    TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (case_id, seq)
);
CREATE INDEX ix_decisions_case ON decisions(case_id, seq);

CREATE TABLE entitlements (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('payable','pending','paid','failed')),
  provider      TEXT,
  provider_ref  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (assignment_id)
);

CREATE TABLE patches (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  diff_json     TEXT NOT NULL,
  excluded_json TEXT NOT NULL,
  hash          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('draft','approved','exported')),
  created_by    TEXT NOT NULL,
  approved_by   TEXT,
  supersedes_id TEXT,
  created_at    TEXT NOT NULL,
  approved_at   TEXT,
  UNIQUE (tenant_id, seq)
);

CREATE TABLE outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX ix_outbox_status ON outbox(status, id);

CREATE TABLE idempotency (
  tenant_id    TEXT NOT NULL,
  key          TEXT NOT NULL,
  op           TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_tenant ON audit_log(tenant_id, entity, entity_id);
`,
  },
];

export function migrate(db: Db): number[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
  );
  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    ran.push(m.version);
  }
  return ran;
}
