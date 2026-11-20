# AppealSet · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** Dataset steward freezes tasks and policy. A budget owner authorizes review spending. Consenting reviewers submit blind rationales. A qualified adjudicator resolves conflicts or explicitly abstains. Dataset QA approves versioned exports.

## Domain schema

Item(tenant,id,content_hash,dataset_version,consent_scope); Policy(id,taxonomy_hash,guideline_hash,expert_on_disagreement); Case(id,item_hash,policy_id,base_version,state); Reviewer(id,org_id,consent_status,eligibility); Assignment(id,case_id,slot,reviewer_id,lease_epoch,state,price,currency); Submission(assignment_id,version,label,rationale,attestation,submitted_at); Decision(case_id,source,base_hash,label_or_null,reason); Payout(assignment_id,provider_ref,state); Patch(id,source_version,decision_refs,hash). A partial unique index on (case_id,slot) applies only while the assignment is active, distinct reviewer principals for the two blind slots.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /v1/cases fixes item and policy; POST /v1/cases/{id}/assign reserves independent reviewer slots; GET /v1/assignments/{id}/task returns blinded view; POST /v1/assignments/{id}/submission accepts active lease and version; POST /v1/cases/{id}/decision records an expert resolution or abstention; POST /v1/patches generates a deterministic patch; GET /v1/cases/{id}/costs is finance-scoped.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Filter by consent, language skill, recent calibration and known conflicts. Assign two distinct principals without exposing other reviewer submissions, original labels, vendor identifiers or payment-linked identity. Enforce organization separation if the purchased policy requires it; principal distinction alone gives limited independence evidence. Lock inputs, guidelines and taxonomy before submission. With two complete valid reviews, route disagreement/abstention to an expert; emit concordance only where policy permits. Ambiguous expert decisions remain unresolved. Require source hash to match before patching.

## State model

Case opened → slots_reserved → reviewing → concordant or awaiting_expert → expert_decided or unresolved. Resolved decisions become patch_ready and exported only after QA acceptance. Assignments separately track accepted, expired, delivered and compensated; missing budget leaves a recoverable waiting_funds state.

## Recovery

Atomically allocate slots and reserve spend. Expire unaccepted leases; reassign under policy and within budget. Idempotently finalize each submission and payable entitlement. When a payout status is unknown reconcile by assignment/remote reference. Append superseding decisions for corrected rulings; immutable prior export records remain reproducible.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
