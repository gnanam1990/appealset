# AppealSet · Session handoff

Initial state: specification only. Current state: all seven modules
implemented locally; 23/23 tests pass; acceptance scene proven via tests and
a live process-level journey.

- Target repository / branch / tested SHA: this repo, `devin/appealset`,
  see STATUS.json `testedSha` (recorded after the clean-checkout run).
- Current module and owner: complete — no active module.
- Completed behavior and redacted evidence path:
  - M01 intake: idempotent case creation with frozen item hash + policy
    snapshot (T-001, T-002) — test/m01-intake.test.ts
  - M02 enrollment: eligibility, conflicts, distinct principals, org
    separation (T-003, T-004) — test/m02-reviewers.test.ts
  - M03 budgets: reservations, scoped offers, pay disclosure, waiting_funds
    recovery (T-005, T-006) — test/m03-budget.test.ts
  - M04 workbench: blind task view, drafts, single final, lease expiry,
    404-on-non-owner (T-007, T-008) — test/m04-workbench.test.ts
  - M05 routing: outbox-driven concordance/escalation, expert decision and
    abstain, idempotent under worker redelivery (T-009, T-010) —
    test/m05-routing.test.ts
  - M06 patches: deterministic diffs pinned to source version + decisions,
    QA approve/export, supersede, exclusions (T-011, T-012) —
    test/m06-patches.test.ts
  - M07 reporting/recovery: overview + calibration reports, payout
    dispatch/reconcile, replay verify over a restored db file
    (T-013, T-014) — test/m07-reports.test.ts
  - Acceptance: $0.50 cap → 3 entitlements totaling $0.50 + exported patch;
    $0.40 cap → waiting_funds, no export — test/acceptance.test.ts; also
    driven live through `npm start` + `npm run worker` processes with curl.
- Working tree or branch requiring transfer: none.
- Commands, exit codes and tested environment:
  - `npm test` → exit 0, 23 pass (Node v22.23.1, macOS arm64)
  - `npm run seed && npm start && npm run worker` → acceptance journey via
    curl completed: case exported, entitlements total 50 minor units.
- External dependencies and decisions: decisions/0001-stack-and-integrations.md
  - live payment rail (e.g. Kite Passport task session): UNAVAILABLE —
    paid service calls are out of scope for this run; missing proof is a
    session-bound paid dispatch + settlement receipt. LOCAL-LEDGER adapter
    stands in and is labeled non-settling.
  - SSO / real identity: UNAVAILABLE — `x-actor-id` header auth is a local
    demo mechanism.
  - partner consent registry + expert gold set feed: UNAVAILABLE — schema
    supports gold_label/calibration; reports show `unavailable` without data.
  - PostgreSQL: not running locally; embedded SQLite used instead.
- First next action: none required to continue the local build. To extend:
  run `npm run seed && npm start && npm run worker` and exercise the console.
- Next agent must reproduce: `npm test` (exit 0, 23 tests) at STATUS.json
  testedSha.
