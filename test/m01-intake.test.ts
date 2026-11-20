import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, POLICY, ITEM, PAST, FUTURE } from './helpers.ts';

test('T-001: replayed intake under one client key returns one case with a stable snapshot', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const pol = await h.call('POST', '/v1/policies', { actor: r.steward, body: POLICY });
    assert.equal(pol.status, 200);
    const item = await h.call('POST', '/v1/items', { actor: r.steward, body: ITEM });
    assert.equal(item.status, 200);

    const payload = { item_id: item.body.id, policy_id: pol.body.id, disputed_label: 'A' };
    const first = await h.call('POST', '/v1/cases', { actor: r.steward, body: payload, key: 'client-key-1' });
    assert.equal(first.status, 200);
    const caseId = (first.body.case as Record<string, unknown>).id as string;

    // Same client key replayed: identical stored response, no second case.
    const replay = await h.call('POST', '/v1/cases', { actor: r.steward, body: payload, key: 'client-key-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal((replay.body.case as Record<string, unknown>).id, caseId);

    // Same dispute imported again under a different key: natural dedupe.
    const dupe = await h.call('POST', '/v1/cases', { actor: r.steward, body: payload });
    assert.equal(dupe.status, 200);
    assert.equal((dupe.body.case as Record<string, unknown>).id, caseId);
    assert.equal(dupe.body.deduplicated, true);

    const cases = await h.call('GET', '/v1/cases', { actor: r.steward });
    assert.equal((cases.body as unknown as unknown[]).length, 1);

    // Stable snapshot: a new policy version must not alter the open case (INV-01).
    const pol2 = await h.call('POST', '/v1/policies', {
      actor: r.steward,
      body: { ...POLICY, taxonomy: ['X', 'Y'], guideline_text: 'revised' },
    });
    assert.equal(pol2.body.version, 2);
    const got = await h.call('GET', `/v1/cases/${caseId}`, { actor: r.steward });
    assert.equal(got.body.policy_version, 1);
    assert.equal(got.body.item_hash, item.body.content_hash);
  } finally {
    h.close();
  }
});

test('T-002: expired consent scope or a label absent from the taxonomy blocks intake', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const pol = await h.call('POST', '/v1/policies', { actor: r.steward, body: POLICY });
    const expired = await h.call('POST', '/v1/items', {
      actor: r.steward,
      body: { ...ITEM, consent_expires_at: PAST },
    });
    const c1 = await h.call('POST', '/v1/cases', {
      actor: r.steward,
      body: { item_id: expired.body.id, policy_id: pol.body.id, disputed_label: 'A' },
    });
    assert.equal(c1.status, 422);
    assert.equal(c1.body.error, 'unprocessable');
    assert.match(String(c1.body.message), /consent/);

    const ok = await h.call('POST', '/v1/items', { actor: r.steward, body: ITEM });
    const c2 = await h.call('POST', '/v1/cases', {
      actor: r.steward,
      body: { item_id: ok.body.id, policy_id: pol.body.id, disputed_label: 'ZZZ' },
    });
    assert.equal(c2.status, 422);
    assert.equal((c2.body.detail as Record<string, unknown>).disputed_label, 'ZZZ');

    // Nothing persisted.
    const cases = await h.call('GET', '/v1/cases', { actor: r.steward });
    assert.equal((cases.body as unknown as unknown[]).length, 0);
  } finally {
    h.close();
  }
});
