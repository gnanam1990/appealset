import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase, FUTURE } from './helpers.ts';
import { createActor } from '../src/domain/actors.ts';

test('T-003: two eligible reviewers from independent organizations fill the two slots', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    const res = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, r.rev2] },
    });
    assert.equal(res.status, 200);
    const list = res.body as unknown as Record<string, unknown>[];
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((a) => a.slot).sort(), [1, 2]);
    assert.ok(list.every((a) => a.price_minor === 10 && a.state === 'offered'));

    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    assert.equal(costs.body.reserved_minor, 20);
  } finally {
    h.close();
  }
});

test('T-004: two accounts mapped to the same principal cannot occupy both slots', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    // A second account sharing p-rev-1's principal.
    const twin = createActor(h.db, {
      tenant_id: 'tenant-1',
      principal_id: 'p-rev-1',
      org_id: 'org-elsewhere',
      role: 'reviewer',
      consent_status: 'opted_in',
      languages: ['en'],
      calibration_expires_at: FUTURE,
    });
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    const res = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, twin.id] },
    });
    assert.equal(res.status, 422);
    assert.ok(
      (res.body.detail as Record<string, unknown>).pair_reasons &&
        ((res.body.detail as Record<string, unknown>).pair_reasons as string[]).includes('same_principal')
    );

    // Ineligible reviewer (expired calibration) also rejected.
    const stale = createActor(h.db, {
      tenant_id: 'tenant-1',
      principal_id: 'p-stale',
      org_id: 'org-south',
      role: 'reviewer',
      consent_status: 'opted_in',
      languages: ['en'],
      calibration_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res2 = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, stale.id] },
    });
    assert.equal(res2.status, 422);
    const d2 = res2.body.detail as Record<string, unknown>;
    assert.ok(((d2.reviewer_2 as Record<string, unknown>).reasons as string[]).includes('calibration_expired'));
  } finally {
    h.close();
  }
});

test('INV-02: org separation enforced when the policy requires it', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    // Policy requiring org separation; rev2 shares org-north via a new actor.
    const sameOrg = createActor(h.db, {
      tenant_id: 'tenant-1',
      principal_id: 'p-rev-9',
      org_id: 'org-north',
      role: 'reviewer',
      consent_status: 'opted_in',
      languages: ['en'],
      calibration_expires_at: FUTURE,
    });
    const pol = await h.call('POST', '/v1/policies', {
      actor: r.steward,
      body: {
        taxonomy: ['A', 'B'],
        guideline_text: 'g',
        review_price_minor: 10,
        expert_price_minor: 30,
        require_org_separation: true,
      },
    });
    const item = await h.call('POST', '/v1/items', {
      actor: r.steward,
      body: {
        org_id: 'org-vendor', language: 'en', content: 'x', dataset_version: 'v1',
        consent_scope: 's', consent_expires_at: FUTURE,
      },
    });
    const c = await h.call('POST', '/v1/cases', {
      actor: r.steward,
      body: { item_id: item.body.id, policy_id: pol.body.id, disputed_label: 'A', budget_cap_minor: 50 },
    });
    const res = await h.call('POST', `/v1/cases/${(c.body.case as Record<string, unknown>).id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, sameOrg.id] },
    });
    assert.equal(res.status, 422);
    assert.ok(
      ((res.body.detail as Record<string, unknown>).pair_reasons as string[]).includes(
        'org_separation_required'
      )
    );
  } finally {
    h.close();
  }
});
