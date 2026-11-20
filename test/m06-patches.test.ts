import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase, reviewBoth } from './helpers.ts';

async function decidedCase(h: ReturnType<typeof makeHarness>, r: ReturnType<typeof seedRoster>, cap = 50) {
  const { case: c, item } = await makeCase(h, r, { capMinor: cap });
  await reviewBoth(h, r, c.id as string, ['A', 'B']);
  h.tick();
  await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
  await h.call('POST', `/v1/cases/${c.id}/decision`, {
    actor: r.expert,
    body: { label: 'B', rationale: 'expert adjudication' },
  });
  return { caseId: c.id as string, itemId: item.id as string };
}

test('T-011: one expert-approved B yields exactly one patch row identifying expert adjudication', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { caseId } = await decidedCase(h, r);
    const patch = await h.call('POST', '/v1/patches', {
      actor: r.qa,
      body: { case_ids: [caseId] },
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.state, 'draft');
    const diff = patch.body.diff as Record<string, unknown>[];
    assert.equal(diff.length, 1);
    assert.equal(diff[0].to_label, 'B');
    assert.equal(diff[0].decision_source, 'expert');
    assert.equal(patch.body.source_version, 'v1');
    assert.match(patch.body.hash as string, /^[0-9a-f]{64}$/);

    // Export requires QA approval first.
    const early = await h.call('POST', `/v1/patches/${patch.body.id}/export`, { actor: r.qa });
    assert.equal(early.status, 409);
    const approve = await h.call('POST', `/v1/patches/${patch.body.id}/approve`, { actor: r.qa });
    assert.equal(approve.body.state, 'approved');
    const exp = await h.call('POST', `/v1/patches/${patch.body.id}/export`, { actor: r.qa });
    assert.equal(exp.body.state, 'exported');

    const patches = await h.call('GET', '/v1/patches', { actor: r.qa });
    assert.equal((patches.body as unknown as unknown[]).length, 1);
  } finally {
    h.close();
  }
});

test('T-012: altered source item and abstentions are excluded with surfaced reasons', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    // Case 1: resolved normally.
    const { caseId: c1 } = await decidedCase(h, r);

    // Case 2: expert abstains → unresolved.
    const { case: c2 } = await makeCase(h, r, {
      capMinor: 50,
      body: { content: 'Second disputed item.', original_label: 'B' },
    });
    await reviewBoth(h, r, c2.id as string, ['A', 'C']);
    h.tick();
    await h.call('POST', `/v1/cases/${c2.id}/assign-expert`, { actor: r.steward, body: {} });
    await h.call('POST', `/v1/cases/${c2.id}/decision`, {
      actor: r.expert,
      body: { abstain: true, rationale: 'not enough context' },
    });

    // Case 3: resolved, then the source item is altered → hash mismatch.
    const { case: c3, item: i3 } = await makeCase(h, r, {
      capMinor: 50,
      body: { content: 'Third disputed item.', original_label: 'C' },
    });
    await reviewBoth(h, r, c3.id as string, ['B', 'C']);
    h.tick();
    await h.call('POST', `/v1/cases/${c3.id}/assign-expert`, { actor: r.steward, body: {} });
    await h.call('POST', `/v1/cases/${c3.id}/decision`, {
      actor: r.expert,
      body: { label: 'C', rationale: 'C is correct' },
    });
    await h.call('PATCH', `/v1/items/${i3.id}/content`, {
      actor: r.steward,
      body: { content: 'Third disputed item, EDITED upstream.' },
    });

    const patch = await h.call('POST', '/v1/patches', {
      actor: r.qa,
      body: { case_ids: [c1, c2.id, c3.id] },
    });
    assert.equal(patch.status, 200);
    const diff = patch.body.diff as Record<string, unknown>[];
    assert.equal(diff.length, 1);
    assert.equal(diff[0].case_id, c1);
    const excluded = patch.body.excluded as { case_id: string; reason: string }[];
    assert.equal(excluded.length, 2);
    const reasons = Object.fromEntries(excluded.map((e) => [e.case_id, e.reason]));
    assert.equal(reasons[c2.id as string], 'unresolved:expert_abstain');
    assert.equal(reasons[c3.id as string], 'source_hash_mismatch');
  } finally {
    h.close();
  }
});

test('superseding ruling appends a new decision and the patch follows it', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { caseId } = await decidedCase(h, r);
    // QA supersedes B with C.
    const sup = await h.call('POST', `/v1/cases/${caseId}/decision`, {
      actor: r.qa,
      body: { label: 'C', rationale: 'vendor corrected the item', supersede: true },
    });
    assert.equal(sup.status, 200);
    const bundle = await h.call('GET', `/v1/cases/${caseId}/bundle`, { actor: r.qa });
    const decisions = bundle.body.decisions as Record<string, unknown>[];
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].source, 'supersede');

    const patch = await h.call('POST', '/v1/patches', {
      actor: r.qa,
      body: { case_ids: [caseId] },
    });
    const diff = patch.body.diff as Record<string, unknown>[];
    assert.equal(diff[0].to_label, 'C');
    assert.equal(diff[0].decision_source, 'supersede');
  } finally {
    h.close();
  }
});
