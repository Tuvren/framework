# Spike report: KRT-DO001 durable mutant and shared-writer race

## Effort budget

- **Budget:** 5 story points.
- **Spent:** To be filled during execution.

## Question

- **Owner:** KRT-DO001 (`.constitution/tasks/epics/EPIC-DO-durable-control-mutants.yaml`).
- **Decision this spike must produce:** Can a generic non-atomic backend wrapper expose each checkpoint fault on SQLite and PostgreSQL, and what control exposes the shared-writer race?

## Context and objective

- **Trigger:** ADR-0084 and the three durable undetected registers in `spec/conformance/kernel/`.
- **Target:** Run a disposable mutant beneath the fault seam on SQLite and PostgreSQL. Capture activation, fault receipts, per-write commits, recovery, and designated assertion outcomes. Investigate both writer outcomes, the barrier, and database locking on PostgreSQL.
- **Surface:** The backend certification testkit and the durable conformance profiles.

## Codebase baseline

- **State today:** `spec/conformance/kernel/kernel-process-crash-undetected.json` records three gaps; `spec/conformance/kernel/kernel-shared-backend-undetected.json` records the stale-head activation and one-result, one-error outcome.
- **Discovered constraints:** `typescript/kernel/backends/sqlite/src/lib/sqlite-transaction-validation.ts` validates the written tree at commit. `RuntimeBackendTx.now` is optional (`typescript/kernel/protocol/src/lib/kernel-types.ts`), so preserve its absence when the backend omits it. Whether grouping tree and paths suffices, and whether other invariants prevent the mutant, remain unmeasured.

## Options and trade-offs

- To be filled from the actual SQLite and PostgreSQL runs. Compare per-call commits, any required write grouping, and a race control supported by the observed interleaving.

## Recommendation

- **Chosen option:** To be filled during execution; the proposed non-atomic mutant is assumed, not proven.
- **Why it fits:** To be filled from the measured activation and assertion results.
- **Rejected options:** To be filled during execution.

## Downstream impact

- **ADRs to write or update:** To be determined if measurement contradicts ADR-0084.
- **Tickets unblocked:** KRT-DO002 and KRT-DO005.
- **Register entry closed:** None.
- **Tickets to add or split:** To be determined from the measured results.
- **Spec edits required:** Route any contract change to Stage 3; the spike does not edit the active spec.
