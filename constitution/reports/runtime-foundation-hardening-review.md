# Runtime Foundation Hardening Review

## Purpose

Record the architecture review conclusions about persistence, run lifecycle, and retention before the next post-Epic-I work begins. This report keeps the discussion grounded in code smells that are visible in the repository, not in generalized opinions about SQLite, LLM orchestration, or distributed systems.

## Summary Judgment

The review surfaced real foundation risks, but the useful action is narrower than halting all future runtime work indefinitely.

The strongest confirmed smell is backend-local: the SQLite backend currently performs whole-database validation inside the normal transaction path. That turns ordinary writes into work proportional to total persisted history and makes SQLite behave like a full-state serialization format instead of a disk-backed indexed store.

The next strongest concern is contract-level: durable `running` and `paused` Runs block Branches, but the current Run shape has no owner, lease, heartbeat, or stale-run recovery semantics. That is not only a SQLite issue; future backends need the same kernel-visible lifecycle answer.

Retention and garbage collection remain intentionally policy-bound, but the runtime still needs explicit retention roots and reachability topology so future backend implementations can prove cleanup is possible without weakening audit history.

## Confirmed Code Smells

### 1. SQLite Full-State Validation In Transaction Hot Path

`SqliteBackend.transact(...)` calls `loadValidatedState(this.db)` before user work and again before `COMMIT`. `loadValidatedState(...)` rebuilds complete in-memory maps from broad table scans and validates persisted invariants across the loaded state.

This is useful as a diagnostic and corruption-detection tool, but it is not acceptable as the default write path for a persistent backend whose history grows monotonically.

Accepted position:

- remove full-state validation from normal SQLite transactions
- retain it for tests, explicit diagnostics, startup health, or an opt-in paranoid mode
- replace hot-path global validation with targeted checks over the write set, referenced records, active Branch, active Run, and relevant lineage
- benchmark that transaction cost no longer scales with total database history

### 2. Lineage Checks Need A Backend Strategy

The backend already performs targeted lineage walks in places such as `isTurnNodeDescendantOfInDatabase(...)`. That avoids whole-state loading, but repeated application-level `SELECT` loops may still be expensive for deep histories.

Accepted position:

- use indexed lineage lookups as the correctness baseline
- evaluate SQLite recursive CTEs for single-statement ancestry and membership proofs
- measure depth-sensitive behavior instead of assuming constant or logarithmic complexity
- consider backend-local materialized ancestry only if measurement shows recursive traversal is inadequate

The target is not magic `O(log N)` for graph reachability. The practical target is that routine writes do not scale with total persisted history and that any depth-bound traversal is explicit, indexed, and measured.

### 3. Run Liveness Is Underspecified

The kernel enforces one active Run per Branch and treats `running` and `paused` as Branch-blocking states. Current `StoredRun` records include `createdAtMs` and `updatedAtMs`, but not execution owner, lease expiry, heartbeat, or stale active-run recovery policy.

Accepted position:

- define lifecycle semantics before adding schema fields
- distinguish `running` execution leases from `paused` approval ownership
- define who may preempt stale Runs, how preemption is recorded, and what happens to pending staged work
- ensure drivers/runtime ports can observe invalidation or persistence rejection without pretending cancellation is always cooperative

This is a kernel/framework contract question, not a SQLite-only implementation detail.

### 4. Retention Needs Roots, Not Ad Hoc Deletion

The kernel intentionally preserves committed history and archives abandoned segments. That is compatible with later retention, but only if retention roots and reachability rules are explicit.

Accepted position:

- define host-authorized retention roots before implementing deletion
- prove backend reachability queries for TurnNodes, TurnTrees, TurnTree paths, ordered chunks, Objects, Runs, and StagedResults
- keep audit-preserving compaction distinct from destructive correction
- avoid making SQLite-specific retention mechanics visible in the kernel contract

## Non-Smells Or Rejected Claims

### SQLite Is Not The Runtime Ontology

SQLite single-writer behavior is a backend tradeoff, not a global condemnation of Tuvren Runtime. The TechSpec already treats SQLite as the first persistent backend, not the canonical physical model for future PostgreSQL, MongoDB, or other backend adapters.

The smell is not "SQLite exists." The smell is allowing a backend-local diagnostic strategy to sit in the backend-local hot path.

### Epic I Is Not Invalidated

Epic I has already completed as a ReAct Driver foundation slice. Its value was driver and provider-contract proof, not production persistence benchmarking. The foundation hardening work should happen before deeper post-I runtime expansion, but it does not erase completed driver contract work.

### Boundary Cloning Remains A Separate Concern

The prior runtime-boundary performance report remains valid: clone and snapshot overhead should be optimized by measurement without weakening shared-core validation. Persistence hot-path hardening is a different workstream.

## Recommended Backlog Position

Insert a Runtime Foundation Hardening epic before deeper ReAct loop/tool work and before any production durability, concurrency, or SQLite performance claims.

The hardening epic should include:

1. SQLite transaction hot-path characterization and guardrails.
2. SQLite localized validation design using indexed checks and recursive CTE evaluation.
3. SQLite transaction-path cleanup once the localized strategy is accepted.
4. Run liveness and stale active-run recovery specification.
5. Retention roots and GC reachability topology design.

## Epic J Closure Status

Epic J has implemented or specified the accepted actions from this review:

- SQLite transaction hot-path characterization, benchmark output, and localized
  validation landed in `constitution/reports/runtime-foundation-hardening-sqlite-hot-path.md`
  and the SQLite backend implementation.
- Lineage checks now use backend-local lineage root/depth metadata for common
  membership and root-to-head proofs, with bounded recursive CTE fallback for
  non-root ancestry. Query-plan regression coverage protects the targeted access
  paths.
- Run liveness is now specified in the Kernel Spec, Framework Spec, and
  TechSpec as a lease/preemption extension gate. No partial lease schema or
  stale-run implementation is introduced in this pass.
- Retention roots and reachability topology are documented in
  `constitution/reports/runtime-foundation-hardening-retention-topology.md`, and
  `bun run nx run backend-sqlite:retention-dry-run` proves the mark-only SQLite
  traversal without destructive cleanup.

After Epic J, the project may claim that the SQLite normal transaction path no
longer performs whole-database validation and that explicit health diagnostics
retain full-state corruption checks. It still must not claim durable recovery
from process death for active Runs or bounded storage growth until future
implementation epics add the lease/preemption and retention mechanics specified
by this hardening pass.

## Production Claim Gate

Before Epic J closure, the project should not claim:

- SQLite-backed production performance
- durable recovery from process death for active Runs
- bounded storage growth
- concurrency behavior representative of future persistent backends

It may still continue contract-focused driver, provider, and framework work when that work does not depend on unresolved persistence timing or stale-run recovery semantics.
