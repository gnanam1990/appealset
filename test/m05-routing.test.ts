import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase, reviewBoth } from './helpers.ts';

test('T-009: A/B disagreement opens exactly one expert case; expert B is recorded with adjudicator and rationale', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    h.tick();

    const c1 = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(c1.body.state, 'awaiting_expert');

    const ex = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
    assert.equal(ex.status, 200);
    const expertAsg = ex.body.id as string;

    // Expert sees anonymized rationales, not reviewer identity.
    const view = await h.call('GET', `/v1/assignments/${expertAsg}/task`, { actor: r.expert });
    const ctx = view.body.expert_context as { blind_rationales: Record<string, unknown>[] };
    assert.equal(ctx.blind_rationales.length, 2);
    const serialized = JSON.stringify(ctx);
    assert.ok(!serialized.includes(r.rev1) && !serialized.includes(r.rev2));
    assert.ok(!serialized.includes('principal'));

    const dec = await h.call('POST', `/v1/cases/${c.id}/decision`, {
      actor: r.expert,
      body: { label: 'B', rationale: 'expert reads intent as B' },
    });
    assert.equal(dec.status, 200);
    assert.equal(dec.body.state, 'expert_decided');

    const bundle = await h.call('GET', `/v1/cases/${c.id}/bundle`, { actor: r.qa });
    const decisions = bundle.body.decisions as Record<string, unknown>[];
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].source, 'expert');
    assert.equal(decisions[0].label, 'B');
    assert.equal(decisions[0].reason, 'expert reads intent as B');
  } finally {
    h.close();
  }
});

test('T-010: worker redelivery and a second submit cannot create a second escalation or payout', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 100 });
    const ids = await reviewBoth(h, r, c.id as string, ['A', 'B']);

    // Worker redelivery: run the outbox repeatedly.
    h.tick();
    h.tick();
    h.tick();
    const c1 = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(c1.body.state, 'awaiting_expert');

    const asgRows = h.db
      .prepare(`SELECT COUNT(*) AS n FROM assignments WHERE case_id = ? AND kind = 'expert'`)
      .get(c.id) as { n: number };
    assert.equal(asgRows.n, 0); // not yet assigned; only state moved

    const ex = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
    assert.equal(ex.status, 200);
    // A second expert offer is refused by the live-expert unique index.
    const ex2 = await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
    assert.equal(ex2.status, 409);

    // Re-submit on a delivered assignment: refused; entitlements stay at 2.
    const again = await h.call('POST', `/v1/assignments/${ids[0]}/submission`, {
      actor: r.rev1,
      body: { kind: 'final', label: 'B', rationale: 'duplicate' },
    });
    assert.equal(again.status, 409);
    const ents = h.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS t
         FROM entitlements e JOIN assignments a ON a.id = e.assignment_id WHERE a.case_id = ?`
      )
      .get(c.id) as { n: number; t: number };
    assert.equal(ents.n, 2);
    assert.equal(ents.t, 20);
  } finally {
    h.close();
  }
});

test('concordant reviews emit a concordant decision without an expert', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    await reviewBoth(h, r, c.id as string, ['A', 'A']);
    h.tick();
    const c1 = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(c1.body.state, 'concordant');
    const bundle = await h.call('GET', `/v1/cases/${c.id}/bundle`, { actor: r.qa });
    const decisions = bundle.body.decisions as Record<string, unknown>[];
    assert.equal(decisions[0].source, 'concordant');
    assert.equal(decisions[0].label, 'A');
  } finally {
    h.close();
  }
});

test('INV-05: expert abstention leaves the case unresolved with an explicit reason', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    await reviewBoth(h, r, c.id as string, ['A', 'B']);
    h.tick();
    await h.call('POST', `/v1/cases/${c.id}/assign-expert`, { actor: r.steward, body: {} });
    const dec = await h.call('POST', `/v1/cases/${c.id}/decision`, {
      actor: r.expert,
      body: { abstain: true, rationale: 'evidence insufficient' },
    });
    assert.equal(dec.body.state, 'unresolved');
    const c1 = await h.call('GET', `/v1/cases/${c.id}`, { actor: r.steward });
    assert.equal(c1.body.state, 'unresolved');
    assert.equal(c1.body.unresolved_reason, 'expert_abstain');
  } finally {
    h.close();
  }
});
