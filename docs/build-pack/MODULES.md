# AppealSet · module index

These are dependency-ordered work units. Once a contract is agreed, UI, adapter and test contributors may proceed on fixtures matching that contract and integrate against its real implementation before acceptance.

1. [M01 · Dispute intake and policy versions](prompts/M01.md) — Freeze tenant-scoped input hash, consent scope, label vocabulary, guideline revision and original dataset version. Deduplicate replayed submissions.
2. [M02 · Reviewer enrollment and conflicts](prompts/M02.md) — Store opt-in, language eligibility, calibration expiry, organization link and conflict exclusions. Expose aliases to dataset operators.
3. [M03 · Paid assignments and leases](prompts/M03.md) — Reserve slot budgets, issue scoped task offers, record delivery entitlements and reconcile payment references. Disclose pay before reviewer acceptance.
4. [M04 · Blind reviewer workbench](prompts/M04.md) — Implement a per-assignment view, draft save and one final versioned opinion with rationale; expire leases and invalidate stale views.
5. [M05 · Agreement and adjudication](prompts/M05.md) — Apply a deterministic routing policy after both valid opinions; present conflicting rationales to a qualified expert with an abstain action.
6. [M06 · QA patch and provenance](prompts/M06.md) — Produce a deterministic diff pinned to the input version and case decisions, require dataset QA approval and support superseding rulings.
7. [M07 · Calibration, reporting and recovery](prompts/M07.md) — Build per-cohort calibration and cost reports, work expiry handling, reviewer payout reconciliation and replay over a clean database snapshot.
