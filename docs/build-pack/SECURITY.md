# AppealSet · Threat model

Scope dataset access by assignment, lease and consent. Blind API responses, logs, notifications and presigned evidence links must omit peer data. Keep payment identity apart from content-facing aliases. Apply retention/redaction controls and show independence evidence limits when people may collude.

The web client, uploaded records and provider payloads are untrusted. Enforce organization, ownership and action-specific authorization at read and write boundaries. Test guessed IDs, stale approvals and access to evidence after membership revocation. Bound extraction payload sizes, validate data formats, redact secret-bearing query strings and keep private data out of public endpoints. Network clients restrict target schemes and destinations to configured providers. Keep customer data, tokens and payment details out of prompts and handoff logs.

Bind an operation to the actor, payload digest, amount limit, provider and expiry where applicable. Audit original and corrected decisions with actor and reason. Include redacted reproduction steps for a failed or unknown result. Align the retention policy with data rights agreed in the pilot.
