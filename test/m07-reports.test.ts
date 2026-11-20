import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, seedRoster, makeCase, reviewBoth } from './helpers.ts';
import { openDb } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrations.ts';
import { verifyReplay } from '../src/domain/reports.ts';
import { getActor } from '../src/domain/actors.ts';
import { LocalLedgerAdapter } from '../src/payments/local-ledger.ts';

async function exportedCase(h: ReturnType<typeof makeHarness>, r: ReturnType<typeof seedRoster>) {
  const { case: c } = await makeCase(h, r, { capMinor: 50 });
  await reviewBoth(h, r, c.id as string, ['A', 'B']);
  h.tick();
  await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
  await h.call('POST', `/v1/cases/${c.id}/decision`, {
    actor: r.expert,
    body: { label: 'B', rationale: 'adjudicated' },
  });
  const patch = await h.call('POST', '/v1/patches', { actor: r.qa, body: { case_ids: [c.id] } });
  await h.call('POST', `/v1/patches/${patch.body.id}/approve`, { actor: r.qa });
  await h.call('POST', `/v1/patches/${patch.body.id}/export`, { actor: r.qa });
  return c.id as string;
}

test('T-013: a restored database reproduces content hash, patch hash and the $0.50 entitlement total', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const caseId = await exportedCase(h, r);

    const before = await h.call('POST', `/v1/cases/${caseId}/verify`, { actor: r.qa });
    assert.equal((before.body.content_hash as Record<string, unknown>).match, true);
    const patches = before.body.patches as Record<string, unknown>[];
    assert.equal(patches.length, 1);
    assert.equal(patches[0].match, true);
    assert.equal(before.body.entitlement_total_minor, 50);

    // Snapshot the database file, restore into a clean file and re-verify.
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(join(h.dir, 'test.db'), join(h.dir, 'restored.db'));
    const rdb = openDb(join(h.dir, 'restored.db'));
    migrate(rdb);
    const qa = getActor(rdb, r.qa)!;
    const after = verifyReplay(rdb, qa, caseId);
    assert.equal(after.content_hash.match, true);
    assert.equal(after.patches[0].match, true);
    assert.equal(after.entitlement_total_minor, 50);
    rdb.close();
  } finally {
    h.close();
  }
});

test('T-014: no gold subset shows calibration unavailable; timed-out payout stays pending', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const cal = await h.call('GET', '/v1/reports/calibration', { actor: r.steward });
    assert.equal(cal.body.status, 'unavailable');
    assert.equal(cal.body.reason, 'no_gold_subset');

    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    h.tick();
    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    const ents = costs.body.entitlements as { id: string }[];

    // Adapter reports an unknown outcome: dispatch leaves it pending.
    h.adapter.forcedStatus = 'unknown';
    const disp = await h.call('POST', `/v1/entitlements/${ents[0].id}/dispatch`, {
      actor: r.budget,
    });
    assert.equal(disp.body.state, 'pending');
    const rec = await h.call('POST', `/v1/entitlements/${ents[0].id}/reconcile`, {
      actor: r.budget,
    });
    assert.equal(rec.body.state, 'pending');
    assert.equal(rec.body.reconciliation, 'required');

    // Once the provider verifies settlement it becomes paid.
    h.adapter.forcedStatus = null;
    h.adapter.settle(disp.body.provider_ref as string);
    const rec2 = await h.call('POST', `/v1/entitlements/${ents[0].id}/reconcile`, {
      actor: r.budget,
    });
    assert.equal(rec2.body.state, 'paid');
  } finally {
    h.close();
  }
});

test('overview report counts resolved, unresolved, paid and pending independently', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { case: c1 } = await makeCase(h, r, { capMinor: 50 });
    await reviewBoth(h, r, c1.id as string, ['A', 'B']);
    h.tick();
    const { case: c2 } = await makeCase(h, r, {
      capMinor: 40,
      body: { content: 'A second item', original_label: 'B' },
    });
    await reviewBoth(h, r, c2.id as string, ['A', 'C']);
    h.tick();
    await h.call('POST', `/v1/cases/${c2.id}/assign-expert`, { actor: r.steward, body: {} });

    const rep = await h.call('GET', '/v1/reports/overview', { actor: r.budget });
    const byState = rep.body.cases_by_state as Record<string, number>;
    assert.equal(byState.awaiting_expert, 1);
    assert.equal(byState.waiting_funds, 1);
    const ents = rep.body.entitlements_by_state as Record<string, { count: number; total_minor: number }>;
    assert.equal(ents.payable.count, 4);
    assert.equal(ents.payable.total_minor, 40);
  } finally {
    h.close();
  }
});
