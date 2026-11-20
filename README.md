# AppealSet

Adjudicate disputed items in a licensed language dataset: two blind reviewers,
a deterministic routing policy, expert escalation, budget-capped compensation,
and QA-approved versioned patches with auditable provenance.

Built from `docs/build-pack/` — see `START-HERE.md` and `MASTER-PROMPT.md`
there for the product contract and `MODULES.md` for the module map.

## Quick start

```sh
npm run seed     # create the demo roster (prints actor ids)
npm start        # API + console on http://localhost:8080
npm run worker   # routing + lease expiry, in a second shell
npm test         # module + acceptance tests
```

Open http://localhost:8080 and pick an actor to enter that role's work
surface. See `AGENTS.md` for conventions and `decisions/` for recorded
build decisions.
