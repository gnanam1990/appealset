import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase, reviewBoth } from './helpers.ts';

/**
 * Reference acceptance scene:
 * reviews $0.10 each, expert $0.30.
 * Cap $0.50 → A/B disagreement routes to one expert; expert accepts B; QA
 * exports one patch with three payable entitlements totaling $0.50.
 * Cap $0.40 → reviews stay payable; the case waits for expert funds and
 * exports nothing.
 */
test('acceptance: $0.50 cap produces one expert patch and $0.50 of entitlements', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    h.tick();

    const ex = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
    assert.equal(ex.status, 200);
    await h.call('POST', `/v1/cases/${c.id}/decision`, {
      actor: r.expert,
      body: { label: 'B', rationale: 'B matches the dominant intent' },
    });

    const patch = await h.call('POST', '/v1/patches', { actor: r.qa, body: { case_ids: [c.id] } });
    assert.equal((patch.body.diff as unknown[]).length, 1);
    await h.call('POST', `/v1/patches/${patch.body.id}/approve`, { actor: r.qa });
    const exp = await h.call('POST', `/v1/patches/${patch.body.id}/export`, { actor: r.qa });
    assert.equal(exp.body.state, 'exported');

    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    const ents = costs.body.entitlements as Record<string, unknown>[];
    assert.equal(ents.length, 3);
    assert.ok(ents.every((e) => e.state === 'payable'));
    assert.equal(costs.body.total_entitled_minor, 50);
    const prior = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(prior.body.state, 'exported');
  } finally {
    h.close();
  }
});

test('acceptance: $0.40 cap leaves reviews payable, waits for expert funds, exports nothing', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { case: c } = await makeCase(h, r, { capMinor: 40 });
    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    h.tick();

    const ex = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
    assert.equal(ex.status, 422);

    const cur = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(cur.body.state, 'waiting_funds');

    // No decision exists → patch cannot include the case.
    const patch = await h.call('POST', '/v1/patches', { actor: r.qa, body: { case_ids: [c.id] } });
    assert.equal(patch.status, 409);

    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    const ents = costs.body.entitlements as Record<string, unknown>[];
    assert.equal(ents.length, 2);
    assert.equal(costs.body.total_entitled_minor, 20);
    const patches = await h.call('GET', '/v1/patches', { actor: r.qa });
    assert.equal((patches.body as unknown as unknown[]).length, 0);
  } finally {
    h.close();
  }
});
