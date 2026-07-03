# Engine-seam certification assets (87-M3)

This directory holds the conformance plans and scenarios that certify
the engine's own behavior (turn/run lifecycle, callables, orchestration,
batteries-included assembly) — the `runtime-api-*` plan family moved
here from `boundaries/framework/conformance/` at 87-M3.4 per the
migration inventory's plan-prefix table ("engine seam", M3).

Layout follows the kernel precedent (`spec/conformance/kernel/`):

- `plans/` — `runtime-api-{lifecycle,callables,callables-extended,lifecycle-extended,orchestration,batteries-included}.json`
- `scenarios/` — `runtime-api-scenarios.json`

Three of the plans (`callables-extended`, `lifecycle-extended`,
`orchestration`) were originally scaffolded by a generator script
(`tools/scripts/conformance/generate-framework-plans.ts`) that drifted
behind the committed content (measured at 87-M3.4) and was retired at
87-M6.1a. The committed JSON is authority; there is no regeneration
path — amendments are made directly to these files.

Naming note: "engine" matches the migration ledger's destination label.
M9 finalizes the `runtime-api` authority disposition (host port) and may
reconcile this directory's name then; until that milestone this home is
deliberately engine-scoped, not host-scoped.
