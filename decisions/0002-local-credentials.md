# 0002 — Provisioned local credentials replace caller-selected identity

Status: accepted (supersedes the `x-actor-id`-as-credential note in 0001)

## Context

The first cut treated a caller-supplied `x-actor-id` header as the credential.
Reviewer independence and blind adjudication are core invariants; a
self-asserted identity makes them untestable in any meaningful way. The pack
requires server-side actor/tenant authority; external SSO is unavailable in
this run, so the authenticator must be real but local.

## Decision

- New `credentials` table (migration v2): `apsk_` opaque tokens, persisted
  only as SHA-256 hashes, revocable, tenant + actor bound.
- `Authorization: Bearer <token>` is the normal path on every authenticated
  route; roles come from the `actors` row the credential resolves to —
  never from a header.
- `x-actor-id` survives only as an explicitly opted-in development fixture:
  `createApp({ devFixtures: true })` or `APPEALSET_DEV_FIXTURES=1`. That flag
  also exposes `GET /v1/session/actors` (the demo roster picker); both are
  absent in normal mode.
- Admin-only provisioning endpoints: `GET/POST /v1/credentials`,
  `DELETE /v1/credentials/:id`; `POST /v1/actors` returns the first token.
- `npm run seed` mints one credential per demo actor and writes them to the
  gitignored `data/dev-roster.json` (local fixture only).
- Console: paste-credential sign-in persisted in `localStorage`
  (`appealset-cred`); the roster picker appears only when the dev-fixture
  endpoint exists.

## Consequences

- Default and normal acceptance are authenticated. `test/authz.test.ts`
  covers: 401 without credentials, `x-actor-id` rejected in normal mode,
  role binding from enrollment, cross-tenant invisibility, revocation, and
  the dev-fixture opt-in.
- Real SSO/IdP remains an external gate; this provides the local
  authenticator the pack asked for without any cloud dependency.
