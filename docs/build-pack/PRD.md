# AppealSet · Product requirements

## Product decision

Adjudicate disputed items in one licensed language dataset and label taxonomy. Support disjoint assignments, a fixed review budget, expert escalation, policy-versioned decisions and auditable exports. Keep reviewer compensation independent of verdict agreement. Clarify whether a decision is concordant, expert adjudicated or unresolved.

**Buyer and commercial hypothesis.** AI teams with expensive disputed training labels. Charge per adjudicated item. Pilot one label taxonomy with a language-data vendor.

**People and responsibilities.** Dataset steward freezes tasks and policy. A budget owner authorizes review spending. Consenting reviewers submit blind rationales. A qualified adjudicator resolves conflicts or explicitly abstains. Dataset QA approves versioned exports.

## Customer journey

A steward opens a disagreement with frozen content and guidelines. Two eligible reviewers receive separate blind assignments. When both valid responses arrive the policy accepts concordance or opens expert adjudication. QA publishes a versioned patch and inspects costs; the prior dataset version remains reproducible.

## Acceptance scene

Two initial reviews cost $0.10 each and an expert costs $0.30. With a $0.50 cap, labels A and B route to one expert. The expert accepts B and QA exports one patch with three payable entitlements totaling $0.50. With a $0.40 cap the first two reviews remain payable; the case waits for expert funds and exports nothing.

## Behaviors for the team

- **FR-01 · Dispute intake and policy versions.** Freeze tenant-scoped input hash, consent scope, label vocabulary, guideline revision and original dataset version. Deduplicate replayed submissions.
- **FR-02 · Reviewer enrollment and conflicts.** Store opt-in, language eligibility, calibration expiry, organization link and conflict exclusions. Expose aliases to dataset operators.
- **FR-03 · Paid assignments and leases.** Reserve slot budgets, issue scoped task offers, record delivery entitlements and reconcile payment references. Disclose pay before reviewer acceptance.
- **FR-04 · Blind reviewer workbench.** Implement a per-assignment view, draft save and one final versioned opinion with rationale; expire leases and invalidate stale views.
- **FR-05 · Agreement and adjudication.** Apply a deterministic routing policy after both valid opinions; present conflicting rationales to a qualified expert with an abstain action.
- **FR-06 · QA patch and provenance.** Produce a deterministic diff pinned to the input version and case decisions, require dataset QA approval and support superseding rulings.
- **FR-07 · Calibration, reporting and recovery.** Build per-cohort calibration and cost reports, work expiry handling, reviewer payout reconciliation and replay over a clean database snapshot.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Partner with a language-data vendor using consented, de-identified items. Hide a steward-provided expert calibration subset from reviewers. Measure per-item review cost, adjudicator escalation rates, time to resolution and the rate of agreement with held-back expert judgments. Quote per adjudicated item plus pass-through compensation.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [Deano](https://ethglobal.com/showcase/deano-t0hn9); customer willingness to pay requires pilot evidence.

## Larger team scope

- Taxonomy revisions, assignment eligibility and reviewer conflicts
- Sealed independent responses, abstentions, escalation and expert decisions
- Reviewer compensation with audit and independent eligibility checks
- Dataset import and privacy-safe exports, agreement analysis by label version

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
