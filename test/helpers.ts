import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrations.ts';
import { createApp } from '../src/server.ts';
import { createActor, type CreateActorInput } from '../src/domain/actors.ts';
import { runWorkerTick } from '../src/worker.ts';
import { createServer, type Server } from 'node:http';
import { LocalLedgerAdapter } from '../src/payments/local-ledger.ts';

export const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
export const PAST = new Date(Date.now() - 1000).toISOString();

export interface Harness {
  db: Db;
  dir: string;
  adapter: LocalLedgerAdapter;
  call: (
    method: string,
    path: string,
    opts?: { actor?: string; body?: unknown; key?: string }
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  tick: () => void;
  close: () => void;
}

/** In-process HTTP app on an ephemeral port with a temp SQLite file. */
export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'appealset-test-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const adapter = new LocalLedgerAdapter();
  const app = createApp({ db, adapter });
  let server: Server | null = null;
  let base = '';

  const start = new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      app(req, res).catch(() => res.writeHead(500).end('err'));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const call: Harness['call'] = async (method, path, opts = {}) => {
    await start;
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.actor ? { 'x-actor-id': opts.actor } : {}),
        ...(opts.key ? { 'idempotency-key': opts.key } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };

  return {
    db,
    dir,
    adapter,
    call,
    tick: () => void runWorkerTick(db),
    close: () => {
      server?.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Roster {
  admin: string;
  steward: string;
  budget: string;
  rev1: string;
  rev2: string;
  expert: string;
  qa: string;
}

export function seedRoster(db: Db, tenant = 'tenant-1'): Roster {
  const mk = (spec: CreateActorInput) => createActor(db, spec).id;
  return {
    admin: mk({ tenant_id: tenant, principal_id: 'p-admin', org_id: 'org-appealset', role: 'admin' }),
    steward: mk({ tenant_id: tenant, principal_id: 'p-steward', org_id: 'org-appealset', role: 'steward' }),
    budget: mk({ tenant_id: tenant, principal_id: 'p-budget', org_id: 'org-appealset', role: 'budget_owner' }),
    rev1: mk({
      tenant_id: tenant, principal_id: 'p-rev-1', org_id: 'org-north', role: 'reviewer',
      consent_status: 'opted_in', languages: ['en'], calibration_expires_at: FUTURE,
    }),
    rev2: mk({
      tenant_id: tenant, principal_id: 'p-rev-2', org_id: 'org-south', role: 'reviewer',
      consent_status: 'opted_in', languages: ['en'], calibration_expires_at: FUTURE,
    }),
    expert: mk({
      tenant_id: tenant, principal_id: 'p-exp-1', org_id: 'org-panel', role: 'expert',
      consent_status: 'opted_in', languages: ['en'], calibration_expires_at: FUTURE,
    }),
    qa: mk({ tenant_id: tenant, principal_id: 'p-qa', org_id: 'org-appealset', role: 'qa' }),
  };
}

export const POLICY = {
  taxonomy: ['A', 'B', 'C'],
  guideline_text: 'Choose the label matching the dominant intent.',
  expert_on_disagreement: true,
  review_price_minor: 10,
  expert_price_minor: 30,
  currency: 'USD',
};

export const ITEM = {
  org_id: 'org-vendor',
  language: 'en',
  content: 'The committee declined to table the motion.',
  dataset_version: 'v1',
  original_label: 'A',
  consent_scope: 'adjudication-pilot',
  consent_expires_at: FUTURE,
};

export async function makeCase(
  h: Harness,
  r: Roster,
  opts: { capMinor?: number; body?: Record<string, unknown> } = {}
) {
  const pol = await h.call('POST', '/v1/policies', { actor: r.steward, body: POLICY });
  const item = await h.call('POST', '/v1/items', { actor: r.steward, body: { ...ITEM, ...(opts.body ?? {}) } });
  const created = await h.call('POST', '/v1/cases', {
    actor: r.steward,
    body: {
      item_id: item.body.id,
      policy_id: pol.body.id,
      disputed_label: 'A',
      ...(opts.capMinor !== undefined ? { budget_cap_minor: opts.capMinor } : {}),
    },
  });
  return { policy: pol.body, item: item.body, case: created.body.case as Record<string, unknown> };
}

/** Drive a case through to two finals. Returns assignment ids. */
export async function reviewBoth(
  h: Harness,
  r: Roster,
  caseId: string,
  labels: [string, string]
) {
  const asg = await h.call('POST', `/v1/cases/${caseId}/assign`, {
    actor: r.steward,
    body: { reviewer_ids: [r.rev1, r.rev2] },
  });
  const list = asg.body as unknown as { id: string }[];
  await h.call('POST', `/v1/assignments/${list[0].id}/accept`, { actor: r.rev1 });
  await h.call('POST', `/v1/assignments/${list[1].id}/accept`, { actor: r.rev2 });
  await h.call('POST', `/v1/assignments/${list[0].id}/submission`, {
    actor: r.rev1,
    body: { kind: 'final', label: labels[0], rationale: 'first reviewer rationale' },
  });
  await h.call('POST', `/v1/assignments/${list[1].id}/submission`, {
    actor: r.rev2,
    body: { kind: 'final', label: labels[1], rationale: 'second reviewer rationale' },
  });
  return [list[0].id, list[1].id];
}
