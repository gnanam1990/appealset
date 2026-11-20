# Decision record

- Date: 2026-11-20
- Owner: implementation agent (Devin)
- Affected modules: all (M01–M07)

## Decision

Greenfield stack: TypeScript executed natively by Node 22.18+ (no build step,
no npm dependencies), `node:http` for the API, `node:sqlite` (embedded SQLite,
WAL mode) as the durable store, `node:test` for tests, a supervised loop worker
(`src/worker.ts`), and a vanilla HTML/CSS/JS console under `src/console/`.

## Alternatives

- PostgreSQL (the pack's proposed baseline): `psql` 17 is installed but no
  server is running in this environment and starting a system service would
  leave the build dependent on machine state outside this checkout. SQLite
  keeps install, migrations and the clean-checkout replay proof fully
  self-contained.
- Express/Fastify + an ORM: would need npm installs and lockfile churn for no
  functional gain at this scope.

## Chosen behavior and dependency proof

- Local auth: requests carry `x-actor-id` resolved against the `actors` table;
  `GET /v1/session/actors` exists only to drive the demo console login. Real
  SSO/identity is an external dependency (unavailable in this run — no
  external service calls permitted).
- Payments: `LOCAL-LEDGER` adapter records intents/refs inside the checkout;
  it is explicitly not a settlement rail. A live rail (e.g. Kite Passport
  task-scoped session) is an external dependency, unavailable in this run
  because paid service calls are out of scope. Exact missing proof: a
  session-bound paid execution route that fails closed, with sandbox evidence
  of dispatch + settlement.
- External reviewer independence, consent registry and an expert gold set are
  partner dependencies per KITE-AND-PROVIDERS.md; the schema carries
  consent/eligibility/conflict fields and gold labels, populated by steward
  intake only.

## Affected tests

All T-001..T-014 run locally with the embedded store and local adapter.

## Reopen conditions

A live payment rail, SSO, a running PostgreSQL service or a partner data feed
becomes available with owner authority for the specific external action.
