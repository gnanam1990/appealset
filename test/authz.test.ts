import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedRoster, makeCase } from './helpers.ts';
import { createActor } from '../src/domain/actors.ts';
import { mintCredential } from '../src/domain/auth.ts';
import { getActor } from '../src/domain/actors.ts';

test('authorization regression: bearer credentials required in normal mode', async () => {
  const h = makeHarness(); // devFixtures off (default)
  try {
    const r = seedRoster(h);

    // No credential → 401.
    const none = await h.call('GET', '/v1/cases');
    assert.equal(none.status, 401);

    // Unknown token → 401.
    const bad = await h.call('GET', '/v1/cases', { token: 'apsk_deadbeef' });
    assert.equal(bad.status, 401);

    // Caller-selected identity is rejected: x-actor-id is not honored.
    const shortcut = await h.call('GET', '/v1/cases', {
      actor: 'nobody',
      headers: { 'x-actor-id': r.steward },
    });
    assert.equal(shortcut.status, 401);

    // Provisioned bearer → 200.
    const ok = await h.call('GET', '/v1/cases', { actor: r.steward });
    assert.equal(ok.status, 200);

    // /v1/session reports the enrolled identity, not a claimed one.
    const sess = await h.call('GET', '/v1/session', { actor: r.rev1 });
    assert.equal(sess.body.id, r.rev1);
    assert.equal(sess.body.role, 'reviewer');

    // Dev roster endpoint is absent in normal mode (does not exist → 401
    // for unauthenticated, i.e. no open path).
    const roster = await h.call('GET', '/v1/session/actors');
    assert.equal(roster.status, 401);
    const rosterAuth = await h.call('GET', '/v1/session/actors', { actor: r.admin });
    assert.equal(rosterAuth.status, 404);
  } finally {
    h.close();
  }
});

test('authorization regression: roles bound from enrollment, not headers', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const { case: c } = await makeCase(h, r, { capMinor: 50 });

    // Reviewer credential cannot perform steward actions → 403.
    const denied = await h.call('POST', `/v1/cases/${c.id}/assign`, {
      actor: r.rev1,
      body: { reviewer_ids: [r.rev1, r.rev2] },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'forbidden');

    // Reviewer credential cannot read finance-scoped costs → 403.
    const costs = await h.call('GET', `/v1/cases/${c.id}/costs`, { actor: r.rev1 });
    assert.equal(costs.status, 403);

    // Credential minted for tenant-2 cannot see tenant-1 cases.
    const outsider = createActor(h.db, {
      tenant_id: 'tenant-2', principal_id: 'p-x', org_id: 'org-x', role: 'steward',
    });
    const otok = mintCredential(h.db, getActor(h.db, outsider.id)!, 'other tenant').token;
    const cross = await h.call('GET', '/v1/cases', { token: otok });
    assert.equal(cross.status, 200);
    assert.equal((cross.body as unknown as unknown[]).length, 0);
  } finally {
    h.close();
  }
});

test('authorization regression: revoked credentials stop working', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const creds = await h.call('GET', '/v1/credentials', { actor: r.admin });
    assert.equal(creds.status, 200);
    const rev1Cred = (creds.body as unknown as Record<string, unknown>[]).find(
      (c) => c.actor_id === r.rev1
    )!;
    const del = await h.call('DELETE', `/v1/credentials/${rev1Cred.id}`, { actor: r.admin });
    assert.equal(del.status, 200);
    const after = await h.call('GET', '/v1/me/assignments', { actor: r.rev1 });
    assert.equal(after.status, 401);
  } finally {
    h.close();
  }
});

test('authorization regression: non-admin cannot provision credentials', async () => {
  const h = makeHarness();
  try {
    const r = seedRoster(h);
    const denied = await h.call('POST', '/v1/credentials', {
      actor: r.steward,
      body: { actor_id: r.steward },
    });
    assert.equal(denied.status, 403);
    // Admin can; token works exactly once displayed.
    const ok = await h.call('POST', '/v1/credentials', {
      actor: r.admin,
      body: { actor_id: r.steward, label: 'spare' },
    });
    assert.equal(ok.status, 200);
    const use = await h.call('GET', '/v1/session', { token: ok.body.token as string });
    assert.equal(use.body.id, r.steward);
  } finally {
    h.close();
  }
});

test('dev fixtures: x-actor-id and roster work only when explicitly enabled', async () => {
  const h = makeHarness({ devFixtures: true });
  try {
    const r = seedRoster(h);
    const roster = await h.call('GET', '/v1/session/actors');
    assert.equal(roster.status, 200);
    assert.ok((roster.body as unknown as unknown[]).length >= 7);

    const viaShortcut = await h.call('GET', '/v1/cases', {
      headers: { 'x-actor-id': r.steward },
    });
    assert.equal(viaShortcut.status, 200);

    // Real credentials still work alongside the fixture.
    const viaToken = await h.call('GET', '/v1/cases', { actor: r.steward });
    assert.equal(viaToken.status, 200);
  } finally {
    h.close();
  }
});
