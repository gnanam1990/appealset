# AppealSet · acceptance contract

### FR-01 — Dispute intake and policy versions

Freeze tenant-scoped input hash, consent scope, label vocabulary, guideline revision and original dataset version. Deduplicate replayed submissions.

### INV-01 — Dispute intake and policy versions

A policy change cannot alter an already-open case.

### FR-02 — Reviewer enrollment and conflicts

Store opt-in, language eligibility, calibration expiry, organization link and conflict exclusions. Expose aliases to dataset operators.

### INV-02 — Reviewer enrollment and conflicts

Assignments honor the policy's required identity and conflict evidence.

### FR-03 — Paid assignments and leases

Reserve slot budgets, issue scoped task offers, record delivery entitlements and reconcile payment references. Disclose pay before reviewer acceptance.

### INV-03 — Paid assignments and leases

The two initial assignments and any expert purchase together stay within the authorized cap.

### FR-04 — Blind reviewer workbench

Implement a per-assignment view, draft save and one final versioned opinion with rationale; expire leases and invalidate stale views.

### INV-04 — Blind reviewer workbench

Peer labels, original labels and identifying peer metadata remain hidden during blind review.

### FR-05 — Agreement and adjudication

Apply a deterministic routing policy after both valid opinions; present conflicting rationales to a qualified expert with an abstain action.

### INV-05 — Agreement and adjudication

Different or abstaining labels cannot silently produce a training label.

### FR-06 — QA patch and provenance

Produce a deterministic diff pinned to the input version and case decisions, require dataset QA approval and support superseding rulings.

### INV-06 — QA patch and provenance

Only accepted resolved decisions target matching source item hashes.

### FR-07 — Calibration, reporting and recovery

Build per-cohort calibration and cost reports, work expiry handling, reviewer payout reconciliation and replay over a clean database snapshot.

### INV-07 — Calibration, reporting and recovery

Counts distinguish resolved, unresolved, paid and pending independently; majority agreement is not labeled ground truth.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
