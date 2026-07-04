# Spike Report: KRT-BK007 Kernel Persistence-Model Benchmark (Blob-Per-Scope vs Path-Granular)

## 1. Context & Objective
- **Triggering upstream file/section:** `.constitution/reports/audit-2026-07-04-170703-post-epic-87-baseline.md` finding [C-01]; `.constitution/tech-spec/changelog.md` v0.32.0 (persistence-model decision explicitly deferred as evidence-gated)
- **Target:** Write latency and lock-hold time versus accumulated scope-state size for (a) the postgres whole-blob-per-scope transaction model (`typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts:266-333` — `SELECT ... FOR UPDATE` on one scope row, full CBOR decode/clone/re-encode/rewrite per write, `max: 1` connection) and (b) the sqlite full-database loads in `health()` and `reclaim()` (`typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts:283-291, 405-431` — reclaim loads twice per invocation inside a writer-blocking transaction).

## 2. Codebase Baseline
- **Current State:** [To be completed during execution — measure per-write latency at scope sizes across at least three orders of magnitude of accumulated turn history; measure health()/reclaim() wall time and writer-block duration at the same sizes.]
- **Discovered Constraints:** [To be completed — note the canonical-CBOR snapshot model dependencies (ADR-008/010/011) and which ADRs a persistence-model change would touch.]

## 3. Options & Trade-offs
- **Option A — Accept blob-per-scope with documented bounds:** keep the model, write an ADR recording the accepted scope-size ceiling and the topology guidance (scopes stay small; many scopes over few).
- **Option B — Path-granular / row-per-record persistence:** O(delta) writes and intra-scope concurrency at the cost of a large, high-risk backend rework touching the snapshot model.
- [Raw benchmark metrics to be recorded here; the numbers decide.]

## 4. Execution Directives
- **Chosen Option:** [To be completed at spike close — the recommendation feeds a new ADR; no production code changes inside this spike.]
- **Why it fits:** [To be completed.]
- **Downstream Backlog Impact:** Unblocks a future persistence-model epic (or closes the question with an accept-with-bounds ADR). Related but independent: KRT-BK008 (caller-side TurnTree chunking) proceeds regardless of this spike's outcome.
