# AppealSet

Blind review and adjudication for disputed dataset labels. Greenfield build
driven by `docs/build-pack/` (START-HERE.md → MASTER-PROMPT.md → MODULES.md).

## Stack

Node >= 22.18 only. TypeScript runs natively (erasable syntax — no enums,
namespaces, or parameter properties). Embedded SQLite via `node:sqlite`.
Zero npm dependencies; there is intentionally no lockfile.

## Commands

- `npm test` — all module + acceptance tests (node:test, temp SQLite files,
  in-process HTTP). ~1s.
- `npm run seed` — create the demo roster in `data/appealset.db`; prints provisioned credentials.
- `npm start` — API + console on :8080 (override with `PORT`, db with `APPEALSET_DB`).
- `npm run worker` — outbox processor + lease expiry sweep (required for
  routing decisions; `POST /v1/worker/tick` also works as admin/steward).

## Conventions

- Money is integer minor units + explicit `currency`.
- Mutating routes support `Idempotency-Key`; replays return the stored
  response, divergent payloads get 409.
- Auth is `Authorization: Bearer apsk_…` provisioned credentials (see
  decisions/0002). `x-actor-id` works only under `APPEALSET_DEV_FIXTURES=1`.
  Blind task routes
  return 404 for non-owners to avoid existence leaks.
- Outbox rows carry side effects; handlers must stay idempotent.
- Progress tracking: `build-progress/appealset/{HANDOFF.md,STATUS.json}`.
