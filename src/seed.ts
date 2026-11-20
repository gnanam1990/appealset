import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './lib/db.ts';
import { migrate } from './lib/migrations.ts';
import { createActor, getActor } from './domain/actors.ts';
import type { CreateActorInput } from './domain/actors.ts';

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Demo roster for the local console. Local-only auth: an actor id presented as
 * `x-actor-id` is the credential — document this when seeding real users.
 */
export function seed(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  migrate(db);

  const roster: CreateActorInput[] = [
    { tenant_id: 'tenant-1', principal_id: 'p-admin', org_id: 'org-appealset', role: 'admin', alias: 'admin' },
    { tenant_id: 'tenant-1', principal_id: 'p-steward', org_id: 'org-appealset', role: 'steward', alias: 'steward' },
    { tenant_id: 'tenant-1', principal_id: 'p-budget', org_id: 'org-appealset', role: 'budget_owner', alias: 'budget' },
    {
      tenant_id: 'tenant-1', principal_id: 'p-rev-1', org_id: 'org-north', role: 'reviewer',
      alias: 'reviewer-north', consent_status: 'opted_in', languages: ['en'],
      calibration_expires_at: FUTURE,
    },
    {
      tenant_id: 'tenant-1', principal_id: 'p-rev-2', org_id: 'org-south', role: 'reviewer',
      alias: 'reviewer-south', consent_status: 'opted_in', languages: ['en'],
      calibration_expires_at: FUTURE,
    },
    {
      tenant_id: 'tenant-1', principal_id: 'p-exp-1', org_id: 'org-panel', role: 'expert',
      alias: 'expert-panel', consent_status: 'opted_in', languages: ['en'],
      calibration_expires_at: FUTURE,
    },
    { tenant_id: 'tenant-1', principal_id: 'p-qa', org_id: 'org-appealset', role: 'qa', alias: 'qa' },
  ];

  const out: Record<string, string> = {};
  for (const spec of roster) {
    const existing = db
      .prepare('SELECT id FROM actors WHERE tenant_id = ? AND principal_id = ? AND role = ?')
      .get(spec.tenant_id, spec.principal_id, spec.role) as { id: string } | undefined;
    const id = existing?.id ?? createActor(db, spec).id;
    out[spec.alias!] = id;
  }
  db.close();
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.APPEALSET_DB ?? 'data/appealset.db';
  const ids = seed(dbPath);
  console.log(`Seeded demo roster into ${dbPath}`);
  for (const [alias, id] of Object.entries(ids)) {
    console.log(`  ${alias}: ${id}`);
  }
}
