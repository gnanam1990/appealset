import type { Db } from '../lib/db.ts';
import { newId, nowIso } from '../lib/hash.ts';
import { badRequest, notFound, unauthorized, forbidden } from '../lib/errors.ts';
import type { Actor, Role } from './types.ts';

interface ActorRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  org_id: string;
  role: Role;
  alias: string;
  consent_status: 'opted_in' | 'opted_out' | null;
  languages_json: string | null;
  calibration_expires_at: string | null;
  conflicts_json: string | null;
  created_at: string;
}

function rowToActor(r: ActorRow): Actor {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    principal_id: r.principal_id,
    org_id: r.org_id,
    role: r.role,
    alias: r.alias,
    consent_status: r.consent_status,
    languages: r.languages_json ? JSON.parse(r.languages_json) : [],
    calibration_expires_at: r.calibration_expires_at,
    conflicts: r.conflicts_json ? JSON.parse(r.conflicts_json) : [],
    created_at: r.created_at,
  };
}

export function getActor(db: Db, id: string): Actor | null {
  const r = db.prepare('SELECT * FROM actors WHERE id = ?').get(id) as ActorRow | undefined;
  return r ? rowToActor(r) : null;
}

/** Resolve the request actor. Local-build auth: an actor id presented per request. */
export function requireActor(db: Db, actorId: string | undefined): Actor {
  if (!actorId) throw unauthorized();
  const actor = getActor(db, actorId);
  if (!actor) throw unauthorized('unknown actor');
  return actor;
}

export function requireRole(actor: Actor, roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw forbidden(`role ${actor.role} may not perform this action`, {
      required: roles,
      actor_role: actor.role,
    });
  }
}

export interface CreateActorInput {
  tenant_id: string;
  principal_id: string;
  org_id: string;
  role: Role;
  alias?: string;
  consent_status?: 'opted_in' | 'opted_out';
  languages?: string[];
  calibration_expires_at?: string | null;
  conflicts?: string[];
}

const ROLES: Role[] = ['admin', 'steward', 'budget_owner', 'reviewer', 'expert', 'qa'];

export function createActor(db: Db, input: CreateActorInput): Actor {
  if (!input.tenant_id || !input.principal_id || !input.org_id) {
    throw badRequest('tenant_id, principal_id and org_id are required');
  }
  if (!ROLES.includes(input.role)) throw badRequest(`unknown role ${input.role}`);
  if ((input.role === 'reviewer' || input.role === 'expert') && !input.consent_status) {
    throw badRequest('reviewer and expert actors require a consent_status');
  }
  const id = newId('act');
  const alias = input.alias ?? `${input.role.slice(0, 3)}-${id.slice(-6)}`;
  db.prepare(
    `INSERT INTO actors (id, tenant_id, principal_id, org_id, role, alias, consent_status,
       languages_json, calibration_expires_at, conflicts_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.tenant_id,
    input.principal_id,
    input.org_id,
    input.role,
    alias,
    input.consent_status ?? null,
    input.languages ? JSON.stringify(input.languages) : null,
    input.calibration_expires_at ?? null,
    input.conflicts ? JSON.stringify(input.conflicts) : null,
    nowIso()
  );
  return getActor(db, id)!;
}

/** Operator-facing roster: exposes aliases and orgs, never payment identity. */
export function listReviewers(db: Db, tenantId: string): object[] {
  const rows = db
    .prepare(
      `SELECT * FROM actors WHERE tenant_id = ? AND role IN ('reviewer','expert') ORDER BY created_at`
    )
    .all(tenantId) as ActorRow[];
  return rows.map((r) => {
    const a = rowToActor(r);
    return {
      id: a.id,
      alias: a.alias,
      role: a.role,
      org_id: a.org_id,
      consent_status: a.consent_status,
      languages: a.languages,
      calibration_expires_at: a.calibration_expires_at,
      conflicts: a.conflicts,
    };
  });
}

export function audit(
  db: Db,
  tenantId: string,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string,
  detail?: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(tenantId, actorId, action, entity, entityId, detail ? JSON.stringify(detail) : null, nowIso());
}

export function mustGet<T>(row: T | undefined | null, what = 'resource'): T {
  if (row === undefined || row === null) throw notFound(`${what} not found`);
  return row;
}
