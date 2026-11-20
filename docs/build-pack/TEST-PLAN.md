# AppealSet · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Two initial reviews cost $0.10 each and an expert costs $0.30. With a $0.50 cap, labels A and B route to one expert. The expert accepts B and QA exports one patch with three payable entitlements totaling $0.50. With a $0.40 cap the first two reviews remain payable; the case waits for expert funds and exports nothing.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Dispute intake and policy versions • expected behavior

Status: NOT_RUN

Import a disputed item twice under one client key and receive one case with a stable snapshot.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Dispute intake and policy versions • failure boundary

Status: NOT_RUN

An expired consent scope or a label absent from the taxonomy blocks intake.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Reviewer enrollment and conflicts • expected behavior

Status: NOT_RUN

Two eligible reviewers from permitted independent organizations can fill the two slots.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Reviewer enrollment and conflicts • failure boundary

Status: NOT_RUN

Two accounts mapped to the same principal cannot occupy both slots.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Paid assignments and leases • expected behavior

Status: NOT_RUN

With $0.50 available reserve two $0.10 reviews and a $0.30 expert only when needed.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Paid assignments and leases • failure boundary

Status: NOT_RUN

With $0.40 cap after two reviews, expert reservation fails and existing reviewer compensation remains owed.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Blind reviewer workbench • expected behavior

Status: NOT_RUN

Both reviewers can independently complete and reload their own assignments.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Blind reviewer workbench • failure boundary

Status: NOT_RUN

Requesting another reviewer's task or guessing its evidence URL is denied without leaking its existence.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Agreement and adjudication • expected behavior

Status: NOT_RUN

A/B disagreement opens exactly one expert case; expert B records the adjudicator and rationale.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Agreement and adjudication • failure boundary

Status: NOT_RUN

A worker redelivery and simultaneous second submit cannot create a second escalation or payout.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — QA patch and provenance • expected behavior

Status: NOT_RUN

One expert-approved B yields exactly one patch row identifying expert adjudication.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — QA patch and provenance • failure boundary

Status: NOT_RUN

An altered source item or an expert abstention is excluded and surfaces an unresolved reason.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Calibration, reporting and recovery • expected behavior

Status: NOT_RUN

Restore an exported case and recompute its content hash, patch hash and $0.50 entitlement total.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Calibration, reporting and recovery • failure boundary

Status: NOT_RUN

With no gold subset display unavailable calibration; timed-out payment remains pending until verified.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
