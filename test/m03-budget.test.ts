import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase, reviewBoth } from './helpers.ts';

test('T-005: with a $0.50 cap two $0.10 reviews reserve 20 and the $0.30 expert is reserved only when needed', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });

    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    let costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    assert.equal(costs.body.reserved_minor, 20);
    h.tick();
    const c1 = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(c1.body.state, 'awaiting_expert');

    const ex = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, {
      actor: r.steward,
      body: {},
    });
    assert.equal(ex.status, 200);
    assert.equal(ex.body.price_minor, 30);
    costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    assert.equal(costs.body.reserved_minor, 50);
  } finally {
    h.close();
  }
});

test('T-006: with a $0.40 cap the expert reservation fails and reviewer compensation stays owed', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 40 });
    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    h.tick();

    const ex = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, {
      actor: r.steward,
      body: {},
    });
    assert.equal(ex.status, 422);
    assert.equal(ex.body.error, 'unprocessable');

    const c1 = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(c1.body.state, 'waiting_funds');
    assert.equal(c1.body.unresolved_reason, 'insufficient_budget_for_expert');

    // Both delivered reviews still hold payable entitlements.
    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    const ents = costs.body.entitlements as Record<string, unknown>[];
    assert.equal(ents.length, 2);
    assert.ok(ents.every((e) => e.state === 'payable' && e.amount_minor === 10));
    assert.equal(costs.body.total_entitled_minor, 20);

    // Budget owner raises the cap: case becomes fundable again.
    const bump = await h.call('POST', `/v1/cases/${c.id}/budget`, {
      actor: r.budget,
      body: { cap_minor: 50, currency: 'USD' },
    });
    assert.equal(bump.status, 200);
    const ex2 = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, {
      actor: r.steward,
      body: {},
    });
    assert.equal(ex2.status, 200);
  } finally {
    h.close();
  }
});

test('pay terms are disclosed before reviewer acceptance', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    const asg = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, r.rev2] },
    });
    const list = asg.body as unknown as { id: string }[];
    const task = await h.call('GET', `/v1/assignments/${list[0].id}/task`, { actor: r.rev1 });
    assert.equal(task.status, 200);
    const pay = task.body.pay as Record<string, unknown>;
    assert.equal(pay.amount_minor, 10);
    assert.equal(pay.currency, 'USD');
    assert.equal(task.body.state, 'offered');

    // Submitting before acceptance is refused.
    const early = await h.call('POST', `/v1/assignments/${list[0].id}/submission`, {
      actor: r.rev1,
      body: { kind: 'final', label: 'A', rationale: 'too early' },
    });
    assert.equal(early.status, 409);
  } finally {
    h.close();
  }
});
