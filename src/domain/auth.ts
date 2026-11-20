import { randomBytes } from 'node:crypto';
import type { Db } from '../lib/db.ts';
import { newId, nowIso, sha256Hex } from '../lib/hash.ts';
import { unauthorized, notFound } from '../lib/errors.ts';
import { getActor, audit } from './actors.ts';
import type { Actor } from './types.ts';

/**
 * Provisioned opaque credentials. The raw token is returned exactly once at
 * provisioning; only its sha256 is stored. Format `apsk_<48 hex>` (192 bits).
 */

const TOKEN_PREFIX = 'apsk_';

export function mintCredential(db: Db, actor: Actor, label?: string): { id: string; token: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const id = newId('cred');
  db.prepare(
    `INSERT INTO credentials (id, tenant_id, actor_id, token_hash, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, actor.tenant_id, actor.id, sha256Hex(token), label ?? null, nowIso());
  audit(db, actor.tenant_id, actor.id, 'credential.mint', 'credential', id, { label: label ?? null });
  return { id, token };
}

/** Resolve a bearer token to its actor, or null when unknown/revoked. */
export function resolveToken(db: Db, token: string): Actor | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = db
    .prepare('SELECT actor_id FROM credentials WHERE token_hash = ? AND revoked_at IS NULL')
    .get(sha256Hex(token)) as { actor_id: string } | undefined;
  if (!row) return null;
  return getActor(db, row.actor_id);
}

/**
 * Extract the request credential. Bearer token always; `x-actor-id` is honored
 * only when dev fixtures are explicitly enabled by the server operator.
 */
export function authenticate(
  db: Db,
  headers: { authorization?: string; 'x-actor-id'?: string },
  devFixtures: boolean
): Actor {
  const auth = headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const actor = resolveToken(db, auth.slice('Bearer '.length).trim());
    if (!actor) throw unauthorized('credential is unknown or revoked');
    return actor;
  }
  if (devFixtures && headers['x-actor-id']) {
    const actor = getActor(db, headers['x-actor-id']);
    if (!actor) throw unauthorized('unknown actor');
    return actor;
  }
  throw unauthorized();
}

export function revokeCredential(db: Db, actor: Actor, credentialId: string): void {
  const row = db
    .prepare('SELECT * FROM credentials WHERE id = ? AND tenant_id = ?')
    .get(credentialId, actor.tenant_id) as { revoked_at: string | null } | undefined;
  if (!row) throw notFound('credential not found');
  if (row.revoked_at) return;
  db.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ?').run(nowIso(), credentialId);
  audit(db, actor.tenant_id, actor.id, 'credential.revoke', 'credential', credentialId);
}

/** Operator-facing credential list: never exposes token material. */
export function listCredentials(db: Db, tenantId: string): object[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.actor_id, c.label, c.created_at, c.revoked_at, a.alias, a.role
       FROM credentials c JOIN actors a ON a.id = c.actor_id
       WHERE c.tenant_id = ? ORDER BY c.created_at`
    )
    .all(tenantId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id,
    actor_id: r.actor_id,
    actor_alias: r.alias,
    actor_role: r.role,
    label: r.label,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  }));
}
