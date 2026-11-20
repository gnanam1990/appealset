import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase } from './helpers.ts';
import { createActor } from '../src/domain/actors.ts';

async function offeredTwo(h: ReturnType<typeof makeHarness>, r: ReturnType<typeof seedRoster>) {
  const { case: c } = await makeCase(h, r, { capMinor: 50 });
  const asg = await h.call('POST', `/v1/cases/${c.id}/assign`, {
    actor: r.steward,
    body: { reviewer_ids: [r.rev1, r.rev2] },
  });
  return { caseId: c.id as string, list: asg.body as unknown as { id: string }[] };
}

test('T-007: both reviewers independently complete and reload their own assignments', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { caseId, list } = await offeredTwo(h, r);

    for (const [actor, asgId, label] of [
      [r.rev1, list[0].id, 'A'],
      [r.rev2, list[1].id, 'B'],
    ] as const) {
      await h.call('POST', `/v1/assignments/${asgId}/accept`, { actor });
      const draft = await h.call('POST', `/v1/assignments/${asgId}/submission`, {
        actor,
        body: { kind: 'draft', label, rationale: 'work in progress' },
      });
      assert.equal(draft.status, 200);
      const fin = await h.call('POST', `/v1/assignments/${asgId}/submission`, {
        actor,
        body: { kind: 'final', label, rationale: `${label} because reasons` },
      });
      assert.equal(fin.status, 200);

      // Reload: own workbench shows draft history and the final opinion.
      const view = await h.call('GET', `/v1/assignments/${asgId}/task`, { actor });
      assert.equal(view.status, 200);
      assert.equal((view.body.final as Record<string, unknown>).label, label);
      assert.equal((view.body.drafts as unknown[]).length, 1);
      assert.equal(view.body.state, 'delivered');

      // One final only: a second final is refused.
      const second = await h.call('POST', `/v1/assignments/${asgId}/submission`, {
        actor,
        body: { kind: 'final', label: 'C', rationale: 'changed my mind' },
      });
      assert.equal(second.status, 409);
    }
    void caseId;
  } finally {
    h.close();
  }
});

test('T-008: another reviewer or guessed id is denied without leaking existence', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { list } = await offeredTwo(h, r);

    // rev2 asks for rev1's task: 404, identical to a guessed id.
    const peer = await h.call('GET', `/v1/assignments/${list[0].id}/task`, { actor: r.rev2 });
    const guess = await h.call('GET', `/v1/assignments/asg_doesnotexist/task`, { actor: r.rev2 });
    assert.equal(peer.status, 404);
    assert.equal(guess.status, 404);
    assert.deepEqual(peer.body, guess.body);

    // Cross-tenant: a reviewer in another tenant cannot reach it either.
    const outsider = createActor(h.db, {
      tenant_id: 'tenant-2',
      principal_id: 'p-x',
      org_id: 'org-x',
      role: 'reviewer',
      consent_status: 'opted_in',
      languages: ['en'],
      calibration_expires_at: new Date(Date.now() + 1e8).toISOString(),
    });
    const cross = await h.call('GET', `/v1/assignments/${list[0].id}/task`, { actor: outsider.id });
    assert.equal(cross.status, 404);

    // Blind view contains no peer or original-label data (INV-04).
    const view = await h.call('GET', `/v1/assignments/${list[0].id}/task`, { actor: r.rev1 });
    const serialized = JSON.stringify(view.body);
    assert.ok(!serialized.includes('original_label'));
    assert.ok(!serialized.includes(r.rev2));
    assert.ok(!serialized.includes('rev2'));
  } finally {
    h.close();
  }
});

test('lease expiry invalidates stale work and frees the slot for reassignment', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h.db);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });
    const asg = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, r.rev2], lease_ms: 1 },
    });
    const list = asg.body as unknown as { id: string }[];
    await new Promise((res) => setTimeout(res, 5));
    h.tick();

    // Stale view: expired assignments report stale and refuse submissions.
    const view = await h.call('GET', `/v1/assignments/${list[0].id}/task`, { actor: r.rev1 });
    assert.equal(view.body.state, 'expired');
    assert.equal(view.body.stale, true);
    const sub = await h.call('POST', `/v1/assignments/${list[0].id}/submission`, {
      actor: r.rev1,
      body: { kind: 'final', label: 'A', rationale: 'late' },
    });
    assert.equal(sub.status, 410);

    // Reservation released; slots can be re-offered.
    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.budget });
    assert.equal(costs.body.reserved_minor, 0);
    const again = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.steward,
      body: { reviewer_ids: [r.rev1, r.rev2] },
    });
    assert.equal(again.status, 200);
  } finally {
    h.close();
  }
});
