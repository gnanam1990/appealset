import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './lib/db.ts';
import { migrate } from './lib/migrations.ts';
import { createActor, getActor } from './domain/actors.ts';
import type { CreateActorInput } from './domain/actors.ts';
import { mintCredential } from './domain/auth.ts';

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Demo roster for the local console. Each actor gets a provisioned `apsk_`
 * credential; hashes are stored in `credentials`, the plaintext is printed
 * once here and mirrored into the gitignored `data/dev-roster.json`.
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

  const out: Record<string, { id: string; token: string }> = {};
  for (const spec of roster) {
    const existing = db
      .prepare('SELECT id FROM actors WHERE tenant_id = ? AND principal_id = ? AND role = ?')
      .get(spec.tenant_id, spec.principal_id, spec.role) as { id: string } | undefined;
    const id = existing?.id ?? createActor(db, spec).id;
    const cred = mintCredential(db, getActor(db, id)!, 'seed roster');
    out[spec.alias!] = { id, token: cred.token };
  }

  // Dev fixture: convenience roster the console can display when the server
  // runs with APPEALSET_DEV_FIXTURES=1. Treat as a secret only insofar as the
  // local demo db matters; it is gitignored and lives under data/.
  const rosterPath = join(dirname(dbPath), 'dev-roster.json');
  writeFileSync(
    rosterPath,
    JSON.stringify(
      {
        dev_fixture: true,
        note: 'demo credentials for the local console only; gitignored',
        actors: Object.entries(out).map(([alias, v]) => ({ alias, id: v.id, token: v.token })),
      },
      null,
      2
    )
  );
  db.close();
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.APPEALSET_DB ?? 'data/appealset.db';
  const ids = seed(dbPath);
  console.log(`Seeded demo roster into ${dbPath}`);
  for (const [alias, v] of Object.entries(ids)) {
    console.log(`  ${alias}: ${v.id}  credential: ${v.token}`);
  }
  console.log('Dev roster written to data/dev-roster.json (gitignored demo fixture).');
}
