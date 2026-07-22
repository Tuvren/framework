# Issue #108 — Make the blob-per-scope persistence path Git-faithful

> **Status:** complete. Evidence/completion report for GitHub issue #108,
> closed out with [`ADR-066`](../tech-spec/adrs/ADR-066-blob-per-scope-persistence-retained-git-faithful-operations.md)
> (accepted).
> **Origin:** [`SPK-BK007`](../spikes/SPK-BK007.md) · audit finding `[C-01]`
> (`audit-2026-07-04-170703-post-epic-87-baseline.md`) · `.constitution/tech-spec/changelog.md`
> v0.32.0 (persistence-model decision deferred as evidence-gated).
>
> This report accumulates evidence milestone by milestone: M1 (phase-attributed
> baseline), M2 (the sqlite O(n²) lineage-validation bisect and fix), M3 (A3
> decode memoization), M4 (A1/A2 closed with measured reason), M5 (B1
> `health()`/`fsck()` split), M6 (C1 reclaim single-load), M7 (B2/D1 closed
> with measured reason). The **Closing summary and recommendation** section at
> the end of this report is the final milestone: an executive summary of every
> area's disposition and the written recommendation issue #108 asked for,
> feeding — not making — the separate Option-B storage-shape decision per
> ADR-066.

## M1 — Phase-attributed baseline

**Goal:** add phase-level instrumentation (decode / validate / encode /
write / lock-wait) to the postgres and sqlite kernel backends' blob
persistence paths, so cost attribution is explicit instead of inferred, then
re-run the three committed benches at a higher sample count to produce a
phase-attributed baseline before any optimization lands.

### Environment

| | |
|---|---|
| CPU | AMD Ryzen 7 PRO 4750U with Radeon Graphics (16 logical cores) |
| OS | NixOS 26.05, Linux 6.18.37 x86_64 |
| bun | 1.3.10 |
| Date | 2026-07-22 |
| postgres | devenv-managed local PostgreSQL, `tuvren_runtime` database |
| sqlite | `better-sqlite3` 12.8.0, WAL mode, file-per-scope |

**Sample counts.** All three benches ran at `BENCH_SAMPLE_COUNT=15` (the new
default, raised from the spike's `n=5`) at every tier — including the
decisive 1k/10k tiers — for the full committed size ladder
`[10, 100, 1000, 10000]` (postgres write-latency, sqlite load-cost) and
`[0, 100, 500, 1000]` (sqlite hot-path, its own pre-existing tiering, unchanged
by this milestone). No tier was reduced or skipped; the 10k sqlite tier
(`health()` ~7s/sample, `reclaim()` ~14–18s/sample at this history length)
was run to completion in the background rather than truncated. Every reported
number below is n=15 unless noted; postgres `lock-wait`/`write` phase rows and
sqlite `reclaim` phase rows show `n=30` because two samples of that phase are
recorded per single write/reclaim call (see "Why n=30" note below each table).

Raw benchmark stdout (including full JSON) is preserved for this run under
`/tmp/108-baseline/{postgres-write-latency,sqlite-load-cost,sqlite-hot-path}.out`
on the machine that produced it (not checked in; regenerate with the commands
in "How to reproduce" below).

### Observer design implemented

- `@tuvren/backend-shared` exports `PersistencePhase` (`"decode" | "encode" |
  "load" | "lock-wait" | "validate" | "write"`), a `PhaseObserver` interface
  (`startPhase(phase): () => void`), a frozen `NOOP_PHASE_OBSERVER` default,
  and `createRecordingPhaseObserver()` for benches/tests, which accumulates
  `{ phase, durationNs }` samples timed with `process.hrtime.bigint()`.
- Both backends thread an optional `phaseObserver` through their
  **construction options only** (never passed per-call), defaulting to
  `NOOP_PHASE_OBSERVER`, satisfying the hard constraint that the seam cannot
  alter measured production paths when disabled (one shared frozen no-op
  closure per phase call, no allocation).
- **Postgres** (`postgres-backend.ts` / `postgres-backend-persistence.ts`):
  `lock-wait` wraps both the in-process `transactionQueue` wait and the
  `SELECT … FOR UPDATE` row-lock wait; `decode` wraps `decodeSnapshot`;
  `validate` wraps every `validateCommittedState` call site (`health`,
  `transact`, `reclaim`); `encode` wraps `encodeSnapshot`; `write` wraps the
  `UPDATE` and the `COMMIT` statement.
- **SQLite** (`sqlite-backend.ts`): `load` wraps `loadState` and `validate`
  wraps `validateCommittedState`, both inside the shared `loadValidatedState`
  helper used by `health()` and `reclaim()`; `write` wraps `reclaim()`'s row
  deletions and its `COMMIT`. `transact()`'s write path is **not**
  instrumented in M1 — see the sqlite-hot-path finding below for why that is
  correct, not an oversight.

### 1. postgres-write-latency — marginal single-object write, `transact()`

| Scope size | best | median | p95 | avg | n |
|---|---|---|---|---|---|
| 10 | 4.125 ms | 5.284 ms | 8.078 ms | 5.794 ms | 15 |
| 100 | 7.470 ms | 10.174 ms | 15.047 ms | 10.592 ms | 15 |
| 1,000 | 48.951 ms | 51.319 ms | 61.382 ms | 53.134 ms | 15 |
| 10,000 | 466.464 ms | 487.192 ms | 570.242 ms | 499.074 ms | 15 |

Per-phase attribution (best / median / p95 / avg; `n` per phase):

| Size | Phase | n | best | median | p95 | avg |
|---|---|---|---|---|---|---|
| 10 | decode | 15 | 1.150 ms | 1.320 ms | 1.898 ms | 1.395 ms |
| 10 | encode | 15 | 577.5 us | 860.4 us | 1.241 ms | 834.9 us |
| 10 | lock-wait | 30 | 330 ns | 2.3 us | 758.3 us | 283.4 us |
| 10 | validate | 15 | 7.5 us | 8.9 us | 11.5 us | 9.1 us |
| 10 | write | 30 | 544.2 us | 888.9 us | 3.019 ms | 1.175 ms |
| 100 | decode | 15 | 2.756 ms | 3.150 ms | 7.408 ms | 3.410 ms |
| 100 | encode | 15 | 1.739 ms | 1.999 ms | 2.777 ms | 2.080 ms |
| 100 | lock-wait | 30 | 310 ns | 3.3 us | 1.616 ms | 392.8 us |
| 100 | validate | 15 | 10.7 us | 15.3 us | 71.3 us | 23.5 us |
| 100 | write | 30 | 797.3 us | 1.065 ms | 4.874 ms | 1.771 ms |
| 1,000 | decode | 15 | 20.558 ms | 22.864 ms | 28.175 ms | 23.108 ms |
| 1,000 | encode | 15 | 13.615 ms | 14.848 ms | 21.209 ms | 16.348 ms |
| 1,000 | lock-wait | 30 | 240 ns | 872 ns | 2.299 ms | 899.5 us |
| 1,000 | validate | 15 | 11.9 us | 13.8 us | 25.4 us | 14.3 us |
| 1,000 | write | 30 | 800.0 us | 1.386 ms | 11.149 ms | 5.566 ms |
| 10,000 | decode | 15 | 220.927 ms | 234.366 ms | 285.548 ms | 241.763 ms |
| 10,000 | encode | 15 | 146.963 ms | 154.070 ms | 188.379 ms | 159.412 ms |
| 10,000 | lock-wait | 30 | 461 ns | 1.3 us | 20.604 ms | 8.254 ms |
| 10,000 | validate | 15 | 13.5 us | 16.7 us | 19.5 us | 16.4 us |
| 10,000 | write | 30 | 2.057 ms | 7.469 ms | 76.106 ms | 39.432 ms |

*Why n=30 for `lock-wait`/`write`:* `transact()` records two `lock-wait`
samples per call (in-process queue wait, then the `FOR UPDATE` row-lock wait)
and two `write` samples per call (the `UPDATE` of `snapshot_cbor`, then the
`COMMIT`), so 15 writes produce 30 samples of each.

**Reading:** `decode` and `encode` are the two dominant, size-proportional
costs and together account for ~79% of best-case wall time at 10k
(220.9 ms + 147.0 ms of 466.5 ms). `validate` is flat and negligible at every
size (13–24 μs) — confirming `validateCommittedState`'s cost is not the
postgres bottleneck. `write` grows with size (the `UPDATE` payload is the
whole re-encoded blob) but its p95 is noisy (network/WAL flush variance).
`lock-wait` best-case is near-zero (single writer, no contention in this
bench) but its p95/avg carries real variance at 10k, consistent with a
`FOR UPDATE` wait occasionally landing behind PostgreSQL's own I/O for a
multi-hundred-KB row. Comparing phase-sum medians (decode+encode+validate+
write+lock-wait ≈ 403 ms) against the reported total median (487 ms) leaves
an uninstrumented residual of roughly 17% at 10k — most plausibly
`cloneState(baseState)` (the in-memory structural clone of the twelve
collections before repositories run), which M1 does not instrument because
the brief scoped postgres instrumentation to
decode/validate/encode/write/lock-wait only.

### 2. sqlite-load-cost — `health()` and `reclaim()`

| DB size | health best | health median | health p95 | reclaim best | reclaim median | reclaim p95 | reclaim/health (best) | n |
|---|---|---|---|---|---|---|---|---|
| 10 | 3.352 ms | 4.062 ms | 4.755 ms | 6.477 ms | 7.059 ms | 7.691 ms | 1.93x | 15 |
| 100 | 13.766 ms | 15.251 ms | 17.570 ms | 22.385 ms | 24.048 ms | 27.353 ms | 1.63x | 15 |
| 1,000 | 165.571 ms | 176.302 ms | 198.778 ms | 237.013 ms | 254.729 ms | 300.082 ms | 1.43x | 15 |
| 10,000 | 7.030 s | 7.832 s | 8.598 s | 13.658 s | 14.376 s | 17.595 s | 1.94x | 15 |

Per-phase attribution (best / median / p95 / avg; `n` per phase):

| Size | Op | Phase | n | best | median | p95 | avg |
|---|---|---|---|---|---|---|---|
| 10 | health | load | 15 | 505.5 us | 580.2 us | 717.1 us | 602.6 us |
| 10 | health | validate | 15 | 184.6 us | 231.9 us | 284.6 us | 229.7 us |
| 10 | reclaim | load | 30 | 400.3 us | 552.0 us | 690.8 us | 527.9 us |
| 10 | reclaim | validate | 30 | 150.4 us | 173.9 us | 245.2 us | 178.4 us |
| 10 | reclaim | write | 30 | 38.7 us | 52.9 us | 131.9 us | 83.1 us |
| 100 | health | load | 15 | 1.818 ms | 1.969 ms | 2.555 ms | 2.072 ms |
| 100 | health | validate | 15 | 377.7 us | 385.3 us | 520.0 us | 409.9 us |
| 100 | reclaim | load | 30 | 1.292 ms | 1.425 ms | 1.700 ms | 1.453 ms |
| 100 | reclaim | validate | 30 | 353.0 us | 361.0 us | 459.2 us | 382.3 us |
| 100 | reclaim | write | 30 | 40.7 us | 73.8 us | 276.4 us | 145.7 us |
| 1,000 | health | load | 15 | 14.846 ms | 15.529 ms | 17.305 ms | 15.736 ms |
| 1,000 | health | validate | 15 | 2.226 ms | 2.509 ms | 2.888 ms | 2.514 ms |
| 1,000 | reclaim | load | 30 | 10.031 ms | 10.290 ms | 12.332 ms | 10.720 ms |
| 1,000 | reclaim | validate | 30 | 2.207 ms | 2.262 ms | 2.442 ms | 2.330 ms |
| 1,000 | reclaim | write | 30 | 54.6 us | 83.0 us | 1.701 ms | 731.0 us |
| 10,000 | health | load | 15 | 166.924 ms | 171.761 ms | 177.951 ms | 171.921 ms |
| 10,000 | health | validate | 15 | 22.926 ms | 23.443 ms | 25.374 ms | 23.571 ms |
| 10,000 | reclaim | load | 30 | 103.542 ms | 106.110 ms | 114.193 ms | 108.157 ms |
| 10,000 | reclaim | validate | 30 | 22.202 ms | 22.969 ms | 24.183 ms | 23.068 ms |
| 10,000 | reclaim | write | 30 | 43.9 us | 66.4 us | 11.183 ms | 5.444 ms |

*Why n=30 for `reclaim` phases:* `reclaim()` calls `loadValidatedState` twice
per call (once to capture survivor keys before the sweep, once to
re-validate referential integrity after deleting), and separately records a
`write` sample for the row deletions and another for the `COMMIT`, so 15
`reclaim()` calls produce 30 samples of each phase.

#### The residual: where the superlinear cost actually is

Summing the two instrumented phases against the reported operation total
exposes a large and *increasingly dominant* gap that neither `load` nor
`validate` (i.e. `validateCommittedState`) accounts for:

| DB size | health total (best) | load+validate (best) | **residual** | residual % of total |
|---|---|---|---|---|
| 10 | 3.352 ms | 0.690 ms | 2.662 ms | 79.4% |
| 100 | 13.766 ms | 2.195 ms | 11.571 ms | 84.1% |
| 1,000 | 165.571 ms | 17.072 ms | 148.499 ms | 89.7% |
| 10,000 | 7,030.105 ms | 189.850 ms | 6,840.255 ms | 97.3% |

Residual growth per decade of size: **4.35×** (10→100), **12.83×**
(100→1,000), **46.06×** (1,000→10,000) — a sharply *accelerating* curve, far
in excess of the ~10× a linear cost would show, and far in excess of the
`load` phase's own growth (roughly 3.6×, 8.2×, 11.2× per decade — itself
close to linear-ish, not the source of the acceleration).

`reclaim()` corroborates this precisely: it runs the same uninstrumented
residual **twice** per call (via its two `loadValidatedState` invocations)
plus its own small `write` overhead. At 10,000: `2 × 6,840.26 ms (health's
residual) ≈ 13,680.5 ms`, versus `reclaim()`'s actual best-case total of
`13,657.69 ms` — a match within 0.2%, strongly confirming the residual's
location is inside the code both operations share (`loadValidatedState`),
not in anything specific to `health()` or `reclaim()` individually.

**What is in the residual.** `loadValidatedState` (`sqlite-backend.ts`) runs,
between the instrumented `load` and `validate` phases, two calls M1 does
*not* instrument: `validateLoadedState` (`sqlite-state-validation.ts`) —
which re-asserts every record's shape and, for every content-addressed
family, recomputes and compares its canonical identity hash, including
`assertStoredTurnNodeIdentity` for **every** TurnNode (an O(1)-per-node
canonical-hash recomputation, confirmed by reading
`hashTurnNodeIdentity`'s call site in
`typescript/kernel/protocol/src/lib/kernel-validation-stored.ts:138-163` — it
hashes only the node's own fields, not an ancestor walk) — and
`validateTurnNodeLineageRootIndex` (`sqlite-transaction-validation.ts:140`),
which runs a **second full `SELECT * FROM turn_node_lineage_roots`** and
cross-checks it against the loaded state. Both are real, currently
uninstrumented O(N) work; at the 10k tier they are collectively responsible
for essentially all of the measured superlinear growth.

**Factual answer to the B3 question ("does sqlite's superlinear term sit in
`loadState` or `validateCommittedState`?"):** **Neither, within what M1
instruments.** The `load` phase (`loadState`) and the `validate` phase
(`validateCommittedState`) are both present and both grow with size, but
neither shows anywhere near the observed 46× per-decade acceleration, and
together they are only 2.7% of total wall time at 10k. The measured
super-linearity lives in the two calls M1 did not scope for instrumentation —
`validateLoadedState`'s per-record identity re-hashing and
`validateTurnNodeLineageRootIndex`'s second full-table read plus cross-check
— both inside `loadValidatedState`, both currently un-attributed by name.
This is a real, reproducible finding (n=15, confirmed twice via the
`health()`/`reclaim()` 2× cross-check above), not a measurement confound of
the kind the spike flagged (`n=5` → `p95≈max`); at `n=15` every tier's
p95 is clearly separated from its max-adjacent best/median, and the 10k tier
in particular shows tight best/median/p95 clustering (7.03 s / 7.83 s /
8.60 s), i.e. a stable, reproducible cost, not noise.

**Recommendation for the next milestone:** extend the `PhaseObserver` seam to
explicitly instrument `validateLoadedState` and
`validateTurnNodeLineageRootIndex` (either as two new named phases, e.g.
`"identity-check"` and `"lineage-index"`, or folded under `"validate"` with a
sub-label) before attempting B1/B2/B3 optimizations, so the eventual
before/after numbers for those optimizations are attributed against the
phase that actually carries the cost, rather than against `load`/`validate`
as currently scoped.

### 3. sqlite-hot-path — `transact()` across representative write shapes

| History size | Case | best/iter | median/iter | p95/iter | avg (total) | iterations | n |
|---|---|---|---|---|---|---|---|
| 0 | no-op transaction | 10.2 us | 11.1 us | 32.1 us | 341.6 us | 25 | 15 |
| 0 | single object write | 163.2 us | 208.8 us | 271.2 us | 3.195 ms | 15 | 15 |
| 0 | deep branch membership | 286.5 us | 324.9 us | 500.4 us | 5.334 ms | 15 | 15 |
| 0 | deep branch forward | 367.7 us | 422.9 us | 611.6 us | 4.572 ms | 10 | 15 |
| 0 | deep branch non-root forward | 357.6 us | 403.0 us | 675.8 us | 4.509 ms | 10 | 15 |
| 0 | deep branch non-root rollback | 253.8 us | 273.4 us | 569.1 us | 3.115 ms | 10 | 15 |
| 100 | no-op transaction | 7.8 us | 8.0 us | 68.5 us | 306.1 us | 25 | 15 |
| 100 | single object write | 132.8 us | 149.9 us | 237.4 us | 2.414 ms | 15 | 15 |
| 100 | deep branch membership | 344.9 us | 362.5 us | 566.4 us | 5.785 ms | 15 | 15 |
| 100 | deep branch forward | 893.7 us | 925.6 us | 1.430 ms | 10.176 ms | 10 | 15 |
| 100 | deep branch non-root forward | 1.666 ms | 1.720 ms | 2.122 ms | 18.242 ms | 10 | 15 |
| 100 | deep branch non-root rollback | 120.9 ms | 147.0 ms | 175.1 ms | 1.484 s | 10 | 15 |
| 500 | no-op transaction | 7.7 us | 7.8 us | 8.1 us | 196.8 us | 25 | 15 |
| 500 | single object write | 132.4 us | 153.1 us | 241.1 us | 2.575 ms | 15 | 15 |
| 500 | deep branch membership | 711.6 us | 720.6 us | 789.5 us | 10.935 ms | 15 | 15 |
| 500 | deep branch forward | 1.970 ms | 1.992 ms | 2.038 ms | 20.018 ms | 10 | 15 |
| 500 | deep branch non-root forward | 4.461 ms | 4.489 ms | 4.639 ms | 45.091 ms | 10 | 15 |
| 500 | deep branch non-root rollback | 323.3 ms | 389.6 ms | 451.8 ms | 3.899 s | 10 | 15 |
| 1,000 | no-op transaction | 7.6 us | 7.8 us | 8.7 us | 197.2 us | 25 | 15 |
| 1,000 | single object write | 141.0 us | 150.7 us | 261.7 us | 2.491 ms | 15 | 15 |
| 1,000 | deep branch membership | 1.188 ms | 1.202 ms | 1.320 ms | 18.260 ms | 15 | 15 |
| 1,000 | deep branch forward | 3.382 ms | 3.413 ms | 3.648 ms | 34.378 ms | 10 | 15 |
| 1,000 | deep branch non-root forward | 8.112 ms | 8.258 ms | 8.378 ms | 82.483 ms | 10 | 15 |
| 1,000 | deep branch non-root rollback | 587.1 ms | 697.8 ms | 826.9 ms | 7.070 s | 10 | 15 |

**Phase table: empty for every case at every size (`(no phase samples
recorded)`), by design.** `transact()` is not phase-instrumented in M1
because it has no full-blob decode/validate/encode seam to attribute:
SQLite's write path is already row-per-record (per-repository-method SQL
statements plus a single `validateTransactionWriteSet` delta check before
`COMMIT`), which is exactly what issue #108 wants postgres's write path to
become. `deep branch non-root rollback transaction`'s cost visibly grows
with history size (254 μs → 121 ms → 323 ms → 587 ms best/iter across 0 →
1,000 history) — this is `assertBranchHeadMoveIsLinearInDatabase`-style
lineage-walk cost inherent to that specific case, not blob persistence, and
is out of scope for this issue's optimization areas (A/B/C/D).

### How to reproduce

```
bun run typescript/kernel/backends/postgres/bench/postgres-write-latency.bench.ts
bun run nx run backend-sqlite:bench-load-cost
bun run nx run backend-sqlite:bench
```

`BENCH_SAMPLE_COUNT` overrides the sample count on all three (default 15);
`BENCH_DATABASE_SIZES` (comma-separated) overrides the sqlite-load-cost size
ladder for running one decisive tier at a time (the 10k tier alone takes
several minutes at n=15).

### Validation performed for M1

- `bun run nx run backend-postgres:test` — pass (49/49, including the 2 new
  phase-observer tests).
- `bun run nx run backend-postgres:typecheck` — pass.
- `bun run nx run backend-postgres:lint` — pass.
- `bun run nx run backend-sqlite:test` — pass (101/101, including the 2 new
  phase-observer tests).
- `bun run nx run backend-sqlite:typecheck` — pass.
- `bun run nx run backend-sqlite:lint` — pass.
- `bun run nx run backend-shared:test` / `:typecheck` / `:lint` — pass.
- `bun run check` — pass (fast inner-loop lane: authority gates + affected
  typecheck/test/lint).
- `git diff | grep '\[DEBUG-'` — no matches.

### Deviations from the M1 brief

- `docs/perf-benchmarks.md` was **not** updated in M1; the M1 instructions
  this report responds to scoped the deliverable to this
  `.constitution/reports/` file only. The broader issue body separately asks
  for `docs/perf-benchmarks.md` to carry the numbers table — that is deferred
  to whichever milestone the lead designates for documentation, to avoid
  duplicating/drifting two number sources before the A/B/C/D optimizations
  land. *(Resolved at closeout: by the lead's standing decision this report
  is the single home for the persistence numbers; `docs/perf-benchmarks.md`
  carries only a cross-reference to it, never a duplicate table.)*
- sqlite-hot-path's own history-size ladder (`[0, 100, 500, 1000]`) was left
  unchanged rather than forced to `[10, 100, 1000, 10000]`; that ladder
  predates this milestone and is a different axis (TurnNode chain length,
  not database row count) than the two blob-cost benches' `[10, 100, 1000,
  10000]` scope-size ladder the brief was referring to.

## M2 — Bisecting and fixing the sqlite superlinear residual

M1 left the `loadValidatedState` residual (79–97% of `health()`/`reclaim()`
wall time, growing 4.35×/12.83×/46.06× per decade) attributed only to "two
calls M1 did not instrument" — `validateLoadedState`'s per-record identity
re-hashing and `validateTurnNodeLineageRootIndex`'s ancestry cross-check —
without measurement separating the two. An independent review correctly
flagged that conclusion as unproven: both suspects are O(N) *on paper*, and a
GC/allocation confound (large `n`, large object graphs, more time under GC
pressure) had not been ruled out either. M2 instruments each suspect as its
own `PhaseObserver` phase and re-measures before changing any code, so the
attribution below is measured, not inferred.

### Sub-phase instrumentation

`loadValidatedState` (`sqlite-backend.ts`) now reports four phases instead of
M1's two, in call order:

1. `load` — unchanged from M1 (`loadState`).
2. `validate-loaded` — `validateLoadedState`'s per-record shape/identity
   re-hash pass (M1's first suspect).
3. `validate-lineage-index` — `validateTurnNodeLineageRootIndex`'s
   second-table-read-plus-cross-check pass (M1's second suspect).
4. `validate-committed` — `validateCommittedState`, renamed from M1's
   `validate` phase now that `validate` no longer uniquely identifies one
   call.

`PersistencePhase` (`backend-invariant-phase-observer.ts`) gained
`"validate-committed" | "validate-lineage-index" | "validate-loaded"` for
this; postgres is unaffected and keeps its single `"validate"` phase, since
postgres's residual was already fully attributed in M1 (B1/B2, not part of
this milestone's open question).

### Bisect result: before the fix (unmemoized), n=5, sizes 10/100/1000/5000

Measured by running the real, already-sub-phase-instrumented code path with
one deliberate temporary change reverted afterward: `validateTurnNodeLineageRootIndex`'s per-node lineage lookup used a *fresh*
lookup structure on every loop iteration (the exact pre-fix behavior —
`computeExpectedTurnNodeLineageMetadata` walked `previousTurnNodeHash`
ancestry back to the thread root from scratch for every turn node), instead
of the one lookup structure shared across the whole loop that the landed fix
uses. This isolates the *algorithm* under test (fresh-walk-per-node vs.
memoized-once) while holding everything else — instrumentation, call sites,
error codes — identical, so the "before" and "after" numbers are directly
comparable at the sub-phase level.

| Size | health best | load | validate-loaded | validate-lineage-index | validate-committed |
|---|---|---|---|---|---|
| 10 | 5.254 ms | 574.8 us | 3.839 ms | 107.4 us | 240.0 us |
| 100 | 16.935 ms | 2.223 ms | 12.545 ms | 886.3 us | 417.5 us |
| 1,000 | 198.210 ms | 15.700 ms | 113.371 ms | 65.367 ms | 2.281 ms |
| 5,000 | 2.523 s | 80.547 ms | 438.996 ms | 1.992 s | 10.270 ms |

Decade multipliers (n=5, before fix):

| Phase | 10→100 | 100→1,000 | 1,000→5,000 (per-decade) |
|---|---|---|---|
| `validate-lineage-index` | 8.25× | **73.75×** | **132.77×** |
| `validate-loaded` | 3.27× | 9.04× | 6.94× |
| `load` | 3.87× | 7.06× | 10.37× |
| `validate-committed` | 1.74× | 5.46× | 8.61× |
| health total | 3.22× | 11.70× | 38.07× |

This settles the bisect unambiguously: `validate-lineage-index` is the only
sub-phase with superlinear growth (73.75× and an extrapolated 132.77× per
decade — an *accelerating* curve, the signature of O(n²) work, not GC
pressure, which would show as a roughly constant multiplicative penalty
across all four phases rather than isolated to one). `validate-loaded`
(M1's *other* suspect) grows at 6.94×–9.04× per decade throughout — close to
the ~10× a linear cost produces, and *not* accelerating. `load` and
`validate-committed` are similarly near-linear. **The GC/allocation confound
the review flagged is ruled out by this same evidence**: if the superlinear
growth were GC-driven, it would show up across all four phases roughly
proportionally to allocation volume, not concentrated in exactly one of
them while the other three stay near-linear at the same sizes with the same
object graph.

### The driver, with file:line evidence

The superlinear term was `computeExpectedTurnNodeLineageMetadata`, a
function that used to live at `sqlite-transaction-validation.ts:803-845` in
commit `5714d16` (M1's baseline; the function no longer exists in the tree —
see "The fix" below). It was called once per turn node from
`validateTurnNodeLineageRootIndex`'s main loop
(`sqlite-transaction-validation.ts:144`, then around what is now line 199),
and its body walked `previousTurnNodeHash` backward, one hop at a time,
**all the way to the thread's root turn node**, for every single call.

Why that is O(n²): a thread's turn node lineage is, in the shapes this bench
exercises, a single linear chain (`sqlite-load-cost.bench.ts` builds each
scope as one straight-line history of `databaseSize` turn nodes). Walking
"all the way to the root" from turn node `k` costs `O(k)` hops. Summed over
all `n` turn nodes in the outer loop, total work is
`Σ(k=1..n) O(k) = O(n²)`. Every other phase in `loadValidatedState` — the
row load, the per-record identity re-hash, the committed-state structural
checks — does a constant amount of work per record, so none of them show
this shape.

### The fix

Replace the per-call ancestor walk with one shared, cycle-detecting,
memoizing pass: `resolveTurnNodeLineagePosition`
(`typescript/kernel/backends/shared/src/lib/backend-invariant-turn-node-lineage.ts:81`)
walks from a start node only as far as the nearest node whose
root-hash/depth is *already cached* in a shared `TurnNodeLineageIndex`
(`createTurnNodeLineageIndex`, same file), then unwinds the walked prefix
assigning depth/root to every node it just visited, caching all of them.
`validateTurnNodeLineageRootIndex` now creates one `TurnNodeLineageIndex`
before its loop (`sqlite-transaction-validation.ts:197`) and passes it to
every call (`sqlite-transaction-validation.ts:210`), so a shared ancestor
prefix — the common case on a chain — is walked at most once for the whole
loop regardless of how many descendants reference it: total work collapses
to `O(n)`.

The same shared module backs a second, independent superlinear risk that the
bench shape does not trigger but that the brief called out explicitly:
`assertTurnNodeBelongsToThread` and `assertTurnNodeDescendsFrom`
(formerly `sqlite-state-validation.ts:859-902` / `915-956`) did their own
per-call ancestor walks inside `validateCommittedState`, which is worst-case
O(n²) at state shapes with many turns/runs referencing deep lineages even
though `sqlite-load-cost`'s shape (few branches, one long chain) does not
land in that worst case. `createBackendInvariantTurnNodeLineage` (same
shared module,
`typescript/kernel/backends/shared/src/lib/backend-invariant-turn-node-lineage.ts:239`)
wraps the same memoized-index primitive behind the exact per-backend error
codes (`sqlite_backend_*`, `memory_backend_*`, `postgres_backend_*`) the two
assertions used to throw, and `validateCommittedState` now builds one
`TurnNodeLineageIndex` per pass and threads it through
`validateBranchInvariants`/`validateTurnInvariants`/`validateRunInvariants`
so every lineage check in one `validateCommittedState` call shares the same
memoization. The identical change landed in the memory backend
(`typescript/kernel/backends/memory/src/lib/memory-backend-lineage.ts`,
`memory-backend-state.ts`) and the postgres backend's memory-backend fork
(`typescript/kernel/backends/postgres/src/lib/memory-backend-lineage.ts`,
`memory-backend-state.ts`), keeping the three copies in lockstep per
KRT-BK001. No error code, message, or throw site changed in any of the
three backends — only how the position each one throws about is computed.

`validateLoadedState`'s per-record canonical-identity re-hash was **not**
touched: the bisect confirms it is linear (6.94×–9.04× per decade, both
before and after the fix, since this milestone's change never touches it),
matching M1's own textual claim about `hashTurnNodeIdentity`
(`typescript/kernel/protocol/src/lib/kernel-validation-stored.ts:138-163`)
hashing only a node's own fields. After the fix it becomes the *new*
dominant cost (81.8% of `health()` at 10,000 — see below), which is real and
substantial but is O(1)-per-record work multiplied by `n` records, not an
algorithmic defect; changing hashing/re-validation semantics is out of this
milestone's scope. It is a legitimate candidate for a future fsck-style
milestone (e.g. M5) that considers incremental/cached identity verification
instead of a full re-hash on every `health()`/`reclaim()` call.

### After the fix: full n=15, official `[10, 100, 1,000, 10,000]` ladder

`health()`/`reclaim()` totals:

| DB size | health best | health median | health p95 | reclaim best | reclaim median | reclaim p95 | reclaim/health (best) |
|---|---|---|---|---|---|---|---|
| 10 | 3.805 ms | 5.212 ms | 6.107 ms | 7.065 ms | 7.927 ms | 9.302 ms | 1.86× |
| 100 | 14.762 ms | 16.963 ms | 19.156 ms | 22.217 ms | 23.854 ms | 25.206 ms | 1.51× |
| 1,000 | 124.905 ms | 133.858 ms | 152.636 ms | 160.901 ms | 186.808 ms | 213.985 ms | 1.29× |
| 10,000 | 1.126 s | 1.192 s | 1.237 s | 1.580 s | 1.650 s | 1.754 s | 1.40× |

Per-phase attribution (best; `n=15` for `health`, `n=30` for `reclaim` — same
reason as M1: `reclaim()` calls `loadValidatedState` twice per call):

| Size | Op | Phase | best |
|---|---|---|---|
| 10 | health | load | 498.5 us |
| 10 | health | validate-committed | 191.3 us |
| 10 | health | validate-lineage-index | 89.5 us |
| 10 | health | validate-loaded | 2.558 ms |
| 100 | health | load | 1.807 ms |
| 100 | health | validate-committed | 355.8 us |
| 100 | health | validate-lineage-index | 227.8 us |
| 100 | health | validate-loaded | 11.865 ms |
| 1,000 | health | load | 15.030 ms |
| 1,000 | health | validate-committed | 2.142 ms |
| 1,000 | health | validate-lineage-index | 1.726 ms |
| 1,000 | health | validate-loaded | 102.297 ms |
| 10,000 | health | load | 162.503 ms |
| 10,000 | health | validate-committed | 21.137 ms |
| 10,000 | health | validate-lineage-index | 18.107 ms |
| 10,000 | health | validate-loaded | 921.106 ms |

Residual (health total minus the sum of all four instrumented phases) is now
fully attributed at every size, closing M1's open unattributed gap:

| Size | health total (best) | sum of 4 phases (best) | residual | residual % |
|---|---|---|---|---|
| 10 | 3.805 ms | 3.337 ms | 468.1 us | 12.3% |
| 100 | 14.762 ms | 14.256 ms | 506.2 us | 3.4% |
| 1,000 | 124.905 ms | 121.194 ms | 3.710 ms | 3.0% |
| 10,000 | 1.126 s | 1.123 s | 2.859 ms | **0.25%** |

(The small residual is scheduler/observer overhead between phase
boundaries, not an unaccounted-for algorithmic cost; it shrinks in relative
terms as `n` grows, the opposite of what M1's 97.3%-and-growing residual
showed.)

(M3 review note: the "sum of 4 phases (best)" column above adds each
phase's own best-case sample, and those bests are not guaranteed to come
from the same one of the 15 `health()` iterations as each other or as the
"health total (best)" column — best-of-15 per phase can land on different
iterations than best-of-15 for the total. The derived residual is therefore
an approximation, not an exact per-iteration decomposition; the qualitative
conclusion above (residual shrinks to ~0.25% as `n` grows) is unaffected,
since the same approximation applies uniformly across all four rows and the
trend is far larger than the iteration-selection noise it introduces. The
underlying per-iteration samples were not re-derived for this note — see
the M2 section's own scope note above.)

### Before/after growth-curve comparison (the collapse to ~linear)

| Phase | Before (per-decade) | After (per-decade) |
|---|---|---|
| `validate-lineage-index` | 8.25× / **73.75×** / **132.77×** | 2.55× / 7.57× / 10.49× |
| health total | 3.22× / 11.70× / 38.07× (n=5, 5k top tier) | 3.88× / 8.46× / 9.01× (n=15, official 10k top tier) |

The isolated driver collapses from an accelerating curve (peaking near
133× per decade) to a curve indistinguishable from linear (10.49× per
decade — an O(n) cost with a constant per-node factor produces exactly
10× per decade). `health()`'s own end-to-end growth after the fix
(3.88×/8.46×/9.01×) is now close to the ~10× ideal at every step, compared
to M1's 4.35×/12.83×/46.06× residual-driven curve that accelerated sharply
at the top tier.

Absolute effect at the size that matters most (10,000 rows): `health()`
best-case dropped from M1's **7.030 s to 1.126 s — a 6.2× speedup** — with
`reclaim()` following proportionally (13.658 s → 1.580 s, an 8.6× speedup).

### Hot-path regression check

`bun run nx run backend-sqlite:bench` (n=15, unchanged `[0, 100, 500, 1,000]`
history-size ladder) confirms `transact()` itself is unaffected, as
expected — `transact()`'s pre-commit path is `validateTransactionWriteSet`
(targeted per-write SQL lookups), which never calls `validateCommittedState`
or `loadValidatedState`. Representative rows, M1 baseline vs. this
milestone (best/iter):

| History size | Case | M1 (5714d16) | M2 (this run) |
|---|---|---|---|
| 0 | deep branch non-root rollback | 253.8 us | 263.4 us |
| 100 | deep branch non-root forward | 1.666 ms | 1.676 ms |
| 100 | deep branch non-root rollback | 120.9 ms | 121.4 ms |
| 1,000 | deep branch forward | 3.382 ms | 3.359 ms |
| 1,000 | deep branch non-root rollback | 587.1 ms | 580.0 ms |

All within normal run-to-run noise (a few percent either direction); no
case regressed or improved beyond that noise band, confirming the fix is
scoped to `health()`/`reclaim()` as intended.

### B3 resolution (supersedes the M1 paragraph)

M1's B3 paragraph concluded "**Neither, within what M1 instruments**" — the
superlinear term lived somewhere inside `loadValidatedState`'s two
uninstrumented calls, without saying which one. That was accurate as far as
M1's own instrumentation could show, but left the question open, which is
exactly the gap SPK-BK007 flagged as unresolved.

**M2 resolves it with direct sub-phase measurement**: the superlinear term
was entirely inside `validateTurnNodeLineageRootIndex`
(`sqlite-transaction-validation.ts`, formerly calling the now-deleted
`computeExpectedTurnNodeLineageMetadata` at lines 803-845 of commit
`5714d16`) — specifically its per-turn-node walk back to the thread root,
O(n²) on a linear chain. `validateLoadedState`'s per-record identity
re-hash, M1's *other* named suspect, was linear both before and after this
milestone's change and was never part of the superlinear residual. The fix
(one shared, memoized `TurnNodeLineageIndex` per validation pass instead of
a fresh ancestor walk per node or per assertion call) collapsed
`validate-lineage-index`'s growth from an accelerating ~133×-per-decade
curve to a linear ~10×-per-decade curve, and the same memoized-index
primitive now also backs `validateCommittedState`'s
`assertTurnNodeBelongsToThread`/`assertTurnNodeDescendsFrom` checks in all
three backends (sqlite, memory, postgres) to close the parallel O(n²) risk
those two assertions carried at lineage-heavy state shapes, even though the
`sqlite-load-cost` bench shape does not exercise that particular path.
SPK-BK007's open secondary question — sqlite `loadState` vs.
`validateCommittedState` — is answered: it was neither of those two named
phases; it was the *third*, previously-unnamed call
(`validateTurnNodeLineageRootIndex`) that M1 had not scoped for
instrumentation, now isolated, fixed, and measured back down to linear.

### Validation performed for M2

- `bun run nx run backend-sqlite:test` — pass (103/103: 101 pre-existing
  tests unmodified, plus 2 new turn-node-lineage cases and the
  strengthened phase-observer test).
- `bun run nx run backend-sqlite:typecheck` — pass.
- `bun run nx run backend-sqlite:lint` — pass.
- `bun run nx run backend-postgres:test` — pass (51/51: 49 pre-existing
  tests unmodified, plus 2 new turn-node-lineage cases; the
  phase-observer test was strengthened, not behaviorally changed).
- `bun run nx run backend-postgres:typecheck` — pass.
- `bun run nx run backend-postgres:lint` — pass.
- `bun run nx run backend-memory:test` — pass (77/77: 75 pre-existing tests
  unmodified, plus 2 new turn-node-lineage cases).
- `bun run nx run backend-memory:typecheck` — pass.
- `bun run nx run backend-memory:lint` — pass.
- `bun run nx run backend-shared:test` / `:typecheck` / `:lint` — pass
  (covers the new `backend-invariant-turn-node-lineage.ts` module and the
  `PersistencePhase` union additions).
- `bun run check` — pass (fast inner-loop lane: authority gates + affected
  typecheck/test/lint).
- `git diff | grep '\[DEBUG-'` — no matches.
- All pre-existing corruption-injection suites
  (`backend-sqlite.invariants.test.ts`, `backend-sqlite.record-validation.test.ts`,
  and their memory/postgres equivalents, including the shared
  `expectCorruptedStateRejection` helper paths) pass **unmodified** — no
  error code, message, or rejection behavior changed. The only test files
  touched are the three `*.phase-observer.test.ts` files (deliberately
  strengthened per this milestone's review-debt item, from a
  near-tautological noop-vs-absent comparison to a genuine
  NOOP-vs-RECORDING byte-identity comparison) and the three
  `backend-*.test.ts`/`backend-sqlite.invariants.test.ts` files that gained
  the two new lineage-index cycle/cross-thread-root tests.

### Deviations from the M2 brief

- `sqlite-state-validation.ts` still exceeds the 500-LoC recommended size
  (and, at roughly 1,036 lines, still exceeds the 1,000-LoC hard ceiling) —
  it dropped from 1,116 lines pre-M2 by removing the two local ancestor-walk
  functions, but the net reduction was not enough to bring it under the
  ceiling on its own. Splitting this file is not part of this milestone's
  scope (the milestone's mandate was the algorithmic fix and its shared-code
  consequences, not a broader file-layout pass); flagged here for the lead
  to decide whether a follow-up split belongs in M3 or a dedicated
  housekeeping change.

## M3 — A3 content-hash memoization

**Goal:** area A3 of issue #108 — memoize the postgres backend's
decode+validate cost across repeat loads of byte-identical `snapshot_cbor`
rows, since M1's baseline showed `decode`+`encode` at ~79% of best-case
write time at 10,000 objects (220.9 ms decode + 147.0 ms encode of
466.5 ms) and every `transact()`/`health()`/`reclaim()` paid a full
`decodeSnapshot` even when the row bytes were exactly what this same
instance itself just wrote. Git-native principle: trust a hash you have
already seen.

### Design implemented

A single-entry, per-instance cache
(`typescript/kernel/backends/postgres/src/lib/postgres-backend-snapshot-cache.ts`,
`createSnapshotStateCache`), owned by `PostgresBackend` as
`this.snapshotCache`, memoizing `{ hashHex, state }` — the SHA-256 hex
digest (`node:crypto` `createHash("sha256")`, synchronous — chosen over the
kernel-protocol `hashOpaqueObjectBytes` helper specifically because that
helper is `async` (WebCrypto) and this runs on the hot load/write path; the
digest is an internal cache-validity key only, never persisted, never
compared cross-process, and unrelated to any ADR-008 canonical
content-address) of the last `snapshot_cbor` bytes this instance itself
saw, and that snapshot's already-decoded `BackendState`. One entry per
instance is correct because one `PostgresBackend` instance is bound to
exactly one Scope's row (ADR-048/ADR-049).

- **Read side** (`loadPersistedStateForUpdate`,
  `postgres-backend-persistence.ts`): the `SELECT ... FOR UPDATE` row lock
  and the `schema_version` check run exactly as before this milestone,
  unconditionally, on every call. Only what happens with the loaded bytes
  afterward changed: they are hashed (a new `"hash"` `PersistencePhase`,
  added to the shared `PersistencePhase` union in
  `typescript/kernel/backends/shared/src/lib/backend-invariant-phase-observer.ts`
  since the seam is cross-backend even though only postgres populates this
  phase today) and looked up in the cache. A hash match returns the
  memoized `BackendState` directly — `decodeSnapshot` never runs. A miss
  (first load on this instance, or another writer changed the row since
  this instance last saw it) runs the full `decodeSnapshot` exactly as
  before and then refreshes the memo with the newly decoded state. This
  also means `health()` (a read-only path that already called
  `loadPersistedStateForUpdate`) shares the same memo for free — a
  read-heavy sequence of `health()` calls or read-only `transact()`s
  benefits identically to a write-heavy sequence.
- **Write side** (`persistStateSnapshot`): after encoding the committed
  draft to `snapshotBytes` (unchanged), the function now also hashes those
  exact bytes (same `"hash"` phase) and returns `{ hashHex }` to its
  caller. It does **not** write to the cache itself, and does not know
  whether its caller's transaction will actually commit — `persistStateSnapshot`
  runs the `UPDATE` inside the caller's still-open transaction, before the
  caller's own `COMMIT`.
- **Drafts are only ever cached after `COMMIT`.** `transact()`'s `commit()`
  closure and `reclaim()`'s commit sequence both call
  `this.snapshotCache.set(hashHex, draftState)` on the line immediately
  after `await reserved.unsafe("COMMIT")` returns successfully, never
  before. This placement is deliberate and is the entire correctness
  argument for rollback safety (below) — no additional rollback-specific
  code exists anywhere in the change; the safety falls out of *where* one
  line sits relative to the `COMMIT` statement. (M4 review-debt
  correction: an earlier draft of this bullet said cache population was
  "owned entirely by `PostgresBackend`" and only ever happened after
  `COMMIT` — that overstated it. `loadPersistedStateForUpdate`
  (`postgres-backend-persistence.ts`) has its own, separate,
  already-safe cache write on the decode-miss path: it memoizes the
  decode of bytes already read under the row's `FOR UPDATE` lock, i.e.
  bytes that were already durably committed by whichever transaction
  wrote them (this instance's own prior commit, or a different writer
  entirely) before this load ever ran. That write is not gated on this
  transaction's own `COMMIT` because it has nothing to do with this
  transaction's draft — it is memoizing a decode of already-durable data,
  not caching a not-yet-committed one. The rollback-safety property this
  bullet is about applies specifically to *draft* caching, which remains
  exactly as described: `PostgresBackend` alone decides when a `draftState`
  is safe to promote, and only after that draft's own `COMMIT` succeeds.)
- `purgeScope()` additionally calls `this.snapshotCache.clear()` after
  deleting the Scope's row — defensive tidiness for the (contractually
  unsupported) case where the instance is used again after being purged,
  not required for correctness since the `RuntimeBackend.purgeScope`
  contract already says the instance is discarded.
- A non-public, construction-injected testkit seam
  (`PostgresBackendOptions.snapshotCacheObserver`, type `SnapshotCacheObserver`
  with `recordHit()`/`recordMiss()`, re-exported as a type only from the
  package's `index.ts` — never constructed by the package itself) lets a
  bench or test count hits/misses without adding anything to the public
  `RuntimeBackend` surface. Omitting it costs one `undefined` check per
  load, matching the existing `phaseObserver` seam's zero-cost-when-absent
  discipline.

### Aliasing safety (why serving the cached state as `base` is exactly as
safe as serving a fresh decode)

The transaction flow is `load → cloneState(base) → mutate draft via
repositories`. `cloneState` (`memory-backend-turn-tree.ts`) constructs new
top-level `Map`s but does not deep-clone the *records* inside them — base
and draft share record object references by design (documented at
`cloneState`'s call sites). Every repository `set`/`put` in
`postgres-backend.ts`'s `createRepositories` replaces a draft-Map entry
with a freshly cloned record (`cloneStoredBranch`, `cloneStoredObject`,
etc.) rather than mutating an existing record in place — clone-on-write.
Confirmed by direct inspection of every `set`/`put` call site: none of them
mutate a record's fields; they always construct a new record via a
`cloneStored*` helper before `state.<family>.set(...)`. `validateCommittedState`
(`memory-backend-state.ts`) takes `baseState` as a second argument (used by
`validateBranchInvariants` to look up a branch's pre-transaction head for
linearity checking) and only ever *reads* from it — grepped every
`baseState` reference in that file to confirm none of them mutate it.
Since `base` (whether freshly decoded or served from the cache) is never
mutated in place by anything downstream of `loadPersistedStateForUpdate`,
returning the exact same cached object reference across multiple calls
(e.g. a `health()` call and a later `transact()` call both hitting the
memo) is safe: every caller either only reads it or clones it before
writing.

Concurrency: this per-instance cache needs no locking of its own beyond
what already exists. Every mutating operation (`transact`, `reclaim`,
`purgeScope`) serializes through `this.transactionQueue` at the JS level,
and every `loadPersistedStateForUpdate` call (including `health()`'s, which
does *not* go through `transactionQueue`) takes the row's `FOR UPDATE`
lock before touching the cache — a second concurrent
`SELECT ... FOR UPDATE` on the same row physically cannot resolve until the
first transaction commits or rolls back. So no two cache reads/writes for
one Scope's row can interleave in a way that matters, independent of
whether the concurrent callers are `health()`, `transact()`, or `reclaim()`.

### Failure semantics — rollback and cross-process invalidation

- **Rollback safety.** If `work(repositories)` throws, or
  `validateCommittedState` throws, or a fault hook throws before `commit()`
  runs, or `persistStateSnapshot` itself throws, or the `COMMIT` statement
  itself throws (network drop, constraint violation, etc.) — in every one
  of these cases execution never reaches the
  `this.snapshotCache.set(hashHex, draftState)` line, because that line is
  physically after `committed = true` in `transact()`'s `commit()` closure
  (and after the equivalent point in `reclaim()`). The outer `catch` block
  issues `ROLLBACK` and rethrows; the cache is untouched. A rolled-back
  draft can therefore never become the cached "committed" state. This was
  traced through every throw site in `transact()` (`work`, `validateCommittedState`,
  `beforeCommit`, `persistStateSnapshot`, `COMMIT`, `midCommit` calling
  `commit` and then itself throwing, `midCommit` never calling `commit`)
  and confirmed correct in each case without adding any
  rollback-detection code — the ordering already guaranteed it.
- **Cross-process invalidation.** A different writer (a second
  `PostgresBackend` instance bound to the same schema/scope — modeling a
  second process or worker, or literally a raw `UPDATE` of the row) changes
  `snapshot_cbor` between two loads on this instance. This instance's next
  `loadPersistedStateForUpdate` still runs `SELECT ... FOR UPDATE` (so it
  observes the new bytes, not stale ones), hashes them, finds no match
  against its stale memoized hash, and falls through to a full
  `decodeSnapshot` — which also refreshes the memo. No stale state is ever
  served; the only cost of an external write is one extra decode on the
  next load, exactly the cost every load paid before this milestone.
- **Corruption on a miss.** Tampering `snapshot_cbor` bytes directly (byte
  content, not merely a hash the cache would already reject) still fails
  the same way it did before this milestone: `decodeSnapshot` is what
  raises `postgres_backend_snapshot_payload_invalid` (or the CBOR-decoder-level
  `TuvrenValidationError` for bytes that are not even valid canonical CBOR),
  and a memoized hash from before the tamper cannot mask this — the tamper
  changes the bytes, which changes the hash, which is exactly what forces
  the cache miss that runs `decodeSnapshot` in the first place.

### Tests added

All five in
`typescript/kernel/backends/postgres/test/backend-postgres.snapshot-cache.test.ts`
(new file), plus a shared-helper extraction in `postgres-test-helpers.ts`
(`readSnapshotCbor`/`writeSnapshotCbor`, generalized from a duplicate
`readSnapshotCbor` previously local to `backend-postgres.phase-observer.test.ts`,
which now imports the shared version instead):

1. **Cache hit correctness** — "a warmed cache produces byte-identical
   persisted snapshots to a decode-every-time baseline": two sequential
   `transact()` calls on one instrumented instance (asserting `{ hits: 1,
   misses: 1 }` from the `snapshotCacheObserver` seam), compared against
   the same two writes replayed on fresh, cache-less instances (a new
   instance per write, forcing `decodeSnapshot` every time). Asserts the
   final `snapshot_cbor` bytes are identical between the cache-warmed run
   and the always-decode baseline.
2. **Cross-process invalidation** — "detects a cross-process write and
   falls back to a full decode instead of serving a stale hit": a second
   `PostgresBackend` instance bound to the same schema/scope writes between
   two of the first instance's transacts. Asserts the hit/miss counts land
   exactly where expected (miss, hit, then a forced miss after the
   external write) and that the first instance's subsequent read observes
   all four objects — its own two writes and the other writer's two writes
   — proving no stale data was served.
3. **Corruption still caught on miss** — "rejects a corrupted snapshot
   payload on the next load": overwrites `snapshot_cbor` directly via SQL
   with valid canonical deterministic CBOR of the wrong top-level shape (a
   string, not the snapshot object), so the corruption is caught by
   `decodeSnapshot`'s own shape guard. Asserts the thrown error is a
   `TuvrenPersistenceError` with code `postgres_backend_snapshot_payload_invalid`.
   This is the first byte-level corruption-injection coverage for the
   postgres backend (a pre-existing gap the sqlite/memory backends did not
   share, since their corruption suites operate at the row/field level,
   not on an opaque CBOR blob).
4. **Rollback safety** — "a rolled-back transaction does not poison the
   cache": a `transact()` whose work callback mutates the draft and then
   throws. Asserts the next `transact()` on the same instance sees the
   pre-failure committed state (the rolled-back object absent), and
   cross-checks against an independent, cache-less backend instance
   reading the same row to rule out the first instance's cache silently
   diverging from ground truth.
5. **Round-trip** — "decodeSnapshot(encodeSnapshot(cachedState)) round-trips
   a nontrivial committed state byte-for-byte": commits a state spanning
   six record families (schema, object, two turn trees, two turn tree path
   sets, two turn nodes, thread, branch) through the real `transact()`
   path, reads the persisted bytes back, decodes them with the (now
   test-exported, not package-public) `decodeSnapshot`, re-encodes with
   `encodeSnapshot`, and asserts the re-encoded bytes exactly match the
   originally persisted bytes — proving the round trip is faithful using
   canonical-CBOR byte equality (chosen over `Map`-shaped deep-equality
   assertions, which are both harder to get right against nested `Map`s
   and less directly tied to what "faithful" means for a canonical
   encoding).

`encodeSnapshot`/`decodeSnapshot` were changed from module-private to
`export`ed-but-not-`index.ts`-surfaced, mirroring the existing
`createEmptyState`/`validateCommittedState` precedent
(`memory-backend-state.ts`) that other postgres test files already rely on
for the same reason — direct round-trip testing without inflating the
package's public contract.

### Bench: before/after write-latency

"Before" reuses the M1 baseline table above (`5714d16`, same bench, same
`[10, 100, 1,000, 10,000]` ladder, `n=15`) rather than re-running it,
per this milestone's brief — M2 did not touch the postgres write path in
any way that would change these numbers (M2's shared memoized-lineage-index
fix landed in postgres's `validateCommittedState` too, but `validate` was
already flat/negligible at 13–24 μs at every size in M1 and stays so
here). "After" is a fresh run of the same bench, same machine, same
`BENCH_SAMPLE_COUNT=15`, dated 2026-07-22.

| Scope size | Before best | After best | Before median | After median | Before p95 | After p95 | Before avg | After avg | n |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 4.125 ms | 2.773 ms | 5.284 ms | 3.720 ms | 8.078 ms | 8.804 ms | 5.794 ms | 4.633 ms | 15 |
| 100 | 7.470 ms | 5.616 ms | 10.174 ms | 7.016 ms | 15.047 ms | 8.287 ms | 10.592 ms | 6.867 ms | 15 |
| 1,000 | 48.951 ms | 26.941 ms | 51.319 ms | 28.986 ms | 61.382 ms | 38.828 ms | 53.134 ms | 30.046 ms | 15 |
| 10,000 | 466.464 ms | 248.374 ms | 487.192 ms | 283.823 ms | 570.242 ms | 323.078 ms | 499.074 ms | 284.643 ms | 15 |

Best-case speedup: **1.49×** (10), **1.33×** (100), **1.82×** (1,000),
**1.88×** (10,000). Median speedup: 1.42×/1.45×/1.77×/1.72× at the same
sizes. p95 is noisier (dominated by `write`'s network/WAL-flush variance,
unrelated to this milestone) and even regresses slightly at 10 and 100
objects — expected at these sizes, where `write`'s own p95 (driven by
transient connection/WAL scheduling, not by anything this milestone
touched) is a larger fraction of the now-smaller total.

### Per-phase attribution: the decode → hash collapse

Per-phase best-case, M1 `decode` vs M3 `hash` (the phase that replaces it
on every cache hit):

| Size | M1 `decode` best | M3 `hash` best | Reduction | M3 `decode` occurrences (measured window) |
|---|---|---|---|---|
| 10 | 1.150 ms | 9.9 μs | ~116× | 0 / 15 |
| 100 | 2.756 ms | 18.3 μs | ~151× | 0 / 15 |
| 1,000 | 20.558 ms | 81.7 μs | ~251× | 0 / 15 |
| 10,000 | 220.927 ms | 722.8 μs | ~306× | 0 / 15 |

**Every one of the 15 measured loads at every size was a cache hit** — the
bench's `decode` phase is entirely absent from the "after" phase table at
every tier (the shared `summarizePhases` helper only emits a row for a
phase that actually recorded at least one sample), which is the strongest
possible evidence of a 100% hit rate for this access pattern: one
long-lived `PostgresBackend` instance issuing a strictly sequential series
of single-object writes, exactly the marginal-write-latency pattern this
bench is designed to measure. `hash` shows `n=30` (not 15) because, as
designed, it is charged twice per `transact()` — once on the load side
(`loadPersistedStateForUpdate`) and once on the write side
(`persistStateSnapshot`, to compute the hash the backend will memoize
after `COMMIT` succeeds) — the same reason `write` and `lock-wait` were
already `n=30` in M1.

At 10,000 objects the best-case total dropped by 218.1 ms (466.5 ms →
248.4 ms), which is within 1% of the 220.2 ms `decode` removal alone
(220.927 ms − 0.723 ms) — confirming the win is coming from exactly where
the design intended and that `encode`/`write`/`validate`/`lock-wait` are
unaffected (their best-case values in the "after" run: `encode` 168.240 ms
vs M1's 146.963 ms, `write` 1.865 ms vs M1's 2.057 ms, `validate` 14.6 μs
vs M1's 13.5 μs, `lock-wait` 370 ns vs M1's 461 ns — all within normal
run-to-run machine noise for phases this milestone's change does not touch;
`encode` remains the single dominant cost post-fix, exactly as flagged as
the next candidate in the M1/M2 narrative).

### Honest notes and scope boundaries

- **This bench measures the best case for this optimization.** A single,
  long-lived `PostgresBackend` instance issuing a strictly sequential
  series of writes to one Scope, with no other writer ever touching that
  Scope's row, is exactly the shape that produces a 100% hit rate. Two
  realistic deployment shapes get little or none of this speedup:
  - **A host that constructs a fresh `PostgresBackend` per request** (a
    reasonable reading of the ADR-048 per-request-scoped-backend pattern)
    never reuses an instance's cache across requests — every request's
    first (and often only) `transact()` is a cache miss, so write latency
    stays at the pre-M3 baseline. The cache only helps a host that keeps a
    `PostgresBackend` instance alive across multiple operations against the
    same Scope.
  - **Multiple writers sharing one Scope** (multiple processes/workers, or
    multiple long-lived instances in one process) degrade toward the
    pre-M3 baseline in proportion to write interleaving: every write from
    a different writer invalidates every other writer's memo, so a Scope
    under contended multi-writer traffic sees close to 100% misses even
    though every individual instance is warm from its own perspective. The
    cross-process-invalidation test above exercises exactly this case and
    confirms correctness, not speed, under it.
- **`encode` is now the dominant cost** (168 ms of the 248 ms best-case
  total at 10,000 objects — 68%), unchanged by this milestone by design.
  Collapsing it the way this milestone collapsed `decode` is not possible
  with the same technique (there is no "bytes already seen" shortcut for a
  write whose content is, by definition, new), and is out of this
  milestone's scope; a future milestone would need a different approach
  (e.g. incremental re-encoding of only the changed records) to address it.
- **p95/avg improvements are smaller and noisier than best/median**,
  consistent with `write`'s already-documented (M1) network/WAL-flush
  variance dominating the tail at every size — this milestone does not
  touch `write` and does not claim to improve its variance.
- Sqlite is out of scope for this milestone, as directed: its loads are
  row-based (no single "whole snapshot blob" to hash), so there is no
  equivalent identical-bytes fast path to add there.

### Validation performed for M3

- `bun run nx run backend-postgres:test` — pass (56/56: 51 pre-existing
  tests unmodified, plus 5 new snapshot-cache tests).
- `bun run nx run backend-postgres:typecheck` — pass.
- `bun run nx run backend-postgres:lint` — pass.
- `bun run nx run backend-shared:typecheck` / `:lint` — pass (covers the
  `PersistencePhase` union's new `"hash"` member).
- `bun run check` — pass.
- `bun run verify:kernel` — pass.
- `git diff | grep '\[DEBUG-'` — no matches.

### Deviations from the M3 brief

- None. The row lock and `schema_version` check in
  `loadPersistedStateForUpdate` were left completely untouched, as
  required; no aliasing bug was found (see "Aliasing safety" above); sqlite
  was left out of scope; the cache-hit accounting seam was added as a
  non-public, construction-injected observer rather than any addition to
  the public `RuntimeBackend` surface.

## M4 — A1/A2 closed with measured reason (canonical projection cache prototype)

**Goal:** areas A1+A2 of issue #108 — eliminate the per-write full re-sort
and full deep-clone `encodeSnapshot` pays on every `transact()`, since M3
left `encode` as the dominant write cost (best ~168ms of ~248ms total at
10,000 objects, ~68%). The issue's working hypothesis for A1 was that the
per-write re-sort of every record family is the superlinear term worth
attacking; the git-native intuition behind A2 was that a write touching one
record family should not have to re-derive the other eleven.

**Disposition: CLOSED, not landed.** A full prototype was designed, built,
and proven correct — including a byte-identity fuzz harness that caught a
real cross-family-coupling bug during development — but measurement showed
it delivers no real, reproducible wall-clock gain on the committed
write-latency bench (248.374ms → 243.510ms at 10,000 objects, within normal
run-to-run noise). Per issue #108's landing bar — "land only if measured
before/after shows a real, reproducible gain" — the prototype is not landed.
Both A1 and A2 are closed with this measured reason. The remainder of this
section documents the investigation as the evidence and prototype-proof
deliverable the milestone brief asked for, not as a description of shipped
behavior.

### Why A1 is refuted: the re-sort is not the superlinear term

A1's hypothesis was tested directly with a micro-benchmark isolating
*only* the clone+sort step
(`Array.from(map.values(), cloneStoredObject).sort(compareStoredObject)`)
for a 10,000-entry `objects` family, bypassing CBOR encoding entirely:
**best 7.237 ms, median 14.250 ms**, against a total `encode` phase of
~172–182ms (best/median) at the same size — i.e. clone+sort is at most
**~4–8% of `encode`'s cost**, not the dominant term A1 assumed. The
remaining **~90–96% of `encode`'s total cost at 10,000 objects is
`encodeDeterministicKernelRecord`'s canonical-CBOR serialization of the
*entire* composed snapshot** — canonicalizing every value's key order and
re-encoding every byte of every family. A per-family projection cache
(A1/A2's mechanism) changes what feeds the top-level
`encodeProjectedSnapshot` call, not what that call itself does once handed
a complete twelve-family object: `encodeDeterministicKernelRecord` is
called exactly once per encode over the whole composed snapshot, not once
per family, so it still serializes every family's array on every single
write, reused or not. This cost is a property of the current storage
shape — one canonical CBOR blob per Scope — not of how the twelve family
arrays feeding that blob are derived, and reducing it would require
changing blob granularity (splitting the canonical encoding unit below
"the whole Scope"), which issue #108 marks a hard non-goal for this area
and reserves for the separate Option-B storage-shape decision (feeding
ADR-066).

**Review debt (M5 follow-up):** the ad-hoc script that produced the
7.237 ms/14.250 ms numbers above was not committed at M4 time (see "What
was salvaged versus reverted" below). It is now committed as a permanent
diagnostic, `typescript/kernel/backends/postgres/bench/postgres-encode-family.bench.ts`
(`bun run nx run backend-postgres:bench-encode-family`), so the ~4–8%
attribution above is reproducible on demand instead of resting on a
one-time, uncommitted measurement. It needs no PostgreSQL connection: it
isolates the identical clone+sort shape over an in-memory
`Map<string, StoredObject>` family, bypassing CBOR encoding and the
database entirely, and accepts `BENCH_FAMILY_SIZE`/`BENCH_SAMPLE_COUNT`
overrides the same way the other benches in this report do. A fresh run
at the default 10,000-object family size and `n=15` measured **best
6.339 ms, median 6.989 ms, p95 9.743 ms** — consistent with (in fact
slightly below) the original ~4–8% attribution against the ~172–182 ms
encode phase above, so the headline figures are unchanged.

### The prototype: design, and proof it was byte-identical

A per-family, dirty-tracked, instance-level projection cache
(`postgres-backend-projection-cache.ts`, `createProjectionCache`) was built
and wired into `PostgresBackend` as `this.projectionCache`, memoizing
`{ the exact BackendState object the projection was built against, that
state's complete twelve-family projection }`. Design summary (for the
record; none of this is part of the committed change):

- `postgres-backend-persistence.ts`'s `encodeSnapshot` had its twelve
  inlined `Array.from(...).sort(...)` calls factored into a
  `buildFamilyProjection(state, family)` switch, used by both a full
  rebuild path and a new incremental `buildSnapshotProjection` that reuses
  a prior projection's entry for every family absent from a
  `dirtyFamilies` set threaded through `createRepositories`.
- Validity was coupled to the M3 snapshot cache's state identity:
  `ProjectionCache.getFor(state)` returned a memoized projection only when
  `state` was the exact object reference last `set` — so a decode-miss
  (cold start, cross-process write) naturally forced a full rebuild with no
  separate invalidation bookkeeping, and `reclaim()` (which mutates draft
  `Map`s directly, outside the dirty-tracked repositories) was made to
  bypass reuse by construction by passing an explicit empty dirty set.
- Both caches were promoted together, from the same `draftState`, only
  after the same successful `COMMIT`, mirroring M3's rollback-safety
  argument exactly.
- **The mandatory byte-identity gate (ADR-008 proof):** a seeded-RNG
  (mulberry32, seed `0x5eed1234`, logged at test start) sequence of 30
  randomized single- and multi-family mutation steps was run through the
  public `transact()` surface on a warm-cached instance. After **every**
  commit (setup + 39 deterministic ADR-011 chunk-growth steps + 30
  randomized steps = **70 total comparison points**, exceeding the ≥25
  minimum), the persisted `snapshot_cbor` was compared byte-for-byte
  against a fresh, cache-less `PostgresBackend` instance replaying the
  identical step. Every one of the 70 comparison points was byte-identical
  once the design was correct.
- **The fuzz test earned its keep during development — it caught a real
  bug, not a hypothetical one.** Before a fix, at the step where an ordered
  turn-tree path first crossed the ADR-011 chunking threshold, the
  warm-cached instance's persisted bytes were missing the
  newly-materialized `StoredOrderedPathChunk` entirely: `turnTreePaths.putMany`
  can transitively mutate `state.orderedPathChunks` as a side effect
  (`normalizeStoredTurnTreePath`'s flat→chunked promotion), and the
  family's cached projection — from before the promotion — was incorrectly
  reused instead of rebuilt. The per-family diff pinpointed the exact
  family and step; the fix (marking `orderedPathChunks` dirty on every
  `"ordered"` `putMany` call) made every subsequent run byte-identical.
  This is direct evidence that correct per-family dirty tracking is subtle
  — a hand-written targeted test would not have hit this specific
  cross-family coupling unless it happened to grow an ordered path past the
  threshold.
- Targeted unit tests (five, plus the fault-injected-rollback test salvaged
  into the M3 snapshot-cache suite — see below) confirmed, with an
  observer seam counting per-family rebuild/reuse calls: a warm write
  touching only `objects` rebuilds `["objects"]` and reuses the other
  **11 of 12** families; `reclaim()` always forces 12/12 rebuilds and 0
  reuses, then the very next `transact()` goes straight back to 1/12; a
  cross-process write or a `purgeScope()` + fresh instance both force
  12/12 rebuilds; a rolled-back transaction never promotes a staged
  projection.

### Bench: before/after write-latency (the landing-bar measurement)

"Before" reuses M3's committed "after" table (same bench, same ladder,
`n=15`, `2026-07-22`). "After" is a fresh run of the identical bench, same
machine, same `BENCH_SAMPLE_COUNT=15`, same date, against the prototype
before it was reverted.

| Scope size | Before best | After best | Before median | After median | Before p95 | After p95 | Before avg | After avg |
|---|---|---|---|---|---|---|---|---|
| 10 | 2.773 ms | 2.723 ms | 3.720 ms | 3.412 ms | 8.804 ms | 5.592 ms | 4.633 ms | 3.730 ms |
| 100 | 5.616 ms | 4.383 ms | 7.016 ms | 6.013 ms | 8.287 ms | 9.289 ms | 6.867 ms | 6.231 ms |
| 1,000 | 26.941 ms | 24.690 ms | 28.986 ms | 29.601 ms | 38.828 ms | 39.655 ms | 30.046 ms | 30.854 ms |
| 10,000 | 248.374 ms | 243.510 ms | 283.823 ms | 280.628 ms | 323.078 ms | 312.190 ms | 284.643 ms | 278.675 ms |

Per-phase `encode` best/median at each size (this run):

| Size | encode best | encode median |
|---|---|---|
| 10 | 724.992 μs | 835.048 μs |
| 100 | 2.006 ms | 2.206 ms |
| 1,000 | 14.372 ms | 15.198 ms |
| 10,000 | 172.257 ms | 182.553 ms |

**None of the numbers above show a reproducible gain, at any size**, but
the size of the noise band is not uniform across the ladder, and an
earlier draft of this section overstated it as a flat "±1–5%" — corrected
here (review debt). The decisive 10,000-object tier is genuinely within
±1–5% (best −2.0%, median −1.1%, p95 −3.4%, avg −2.1%): at that size the
scope is large enough that run-to-run scheduling/GC jitter averages out,
and this is the tier that actually carries the landing-bar decision, since
it is where the canonical-CBOR serialization floor dominates most clearly.
The smaller tiers (10, 100, 1,000 objects) swing far outside that band in
both directions — 10-object p95 −36.5%, 10-object avg −19.5%, 100-object
best −22.0%, 100-object p95 *+12.1%* (a regression, not an improvement),
1,000-object median/p95/avg all +2–3% — because at tens-to-hundreds of
microseconds/milliseconds total, absolute noise from process scheduling,
GC pauses, and OS jitter is a much larger fraction of the measured
quantity: these tiers are high-relative-variance on tiny absolute values,
not evidence of a real effect in either direction. Reading the small-tier
swings as signal (rather than noise amplified by a small denominator)
would be the wrong conclusion in both directions — neither "small tiers
regressed" nor "small tiers improved" is a claim this data supports. The
disposition below rests on the 10,000-object tier and the phase/mechanism
argument, not on the small-tier deltas. This is the expected consequence
of A1 being refuted
(above): `postgres-write-latency.bench.ts` writes a single
`tx.objects.put(record)` per `transact()` against a scope where `objects`
is the only large family, so `objects` is always the dirty family on every
write this bench measures, and the ~4–8% clone+sort saving A1/A2 could
offer for that one family is swamped by the ~90–96% canonical-CBOR
serialization floor that exists regardless of what changed. Even in the
most favorable case this design targets (a write touching a small family
while large sibling families go untouched), the observer-verified 11/12
family reuse is real and unconditional at the family level, but it saves,
at most, the ~7–14ms this micro-benchmark measured against a ~172ms encode
phase — not a change large enough to move the committed bench outside its
own noise band, and not the "real, reproducible gain" issue #108's landing
bar requires before something is allowed to land.

### Disposition and what this feeds forward

**A1 (per-write re-sort) and A2 (per-family projection cache) are CLOSED
with this measured reason.** The re-sort A1 targeted is a minor fraction
of `encode`'s cost, not the dominant term; the projection-cache mechanism
A2 built to avoid it is correct (proven byte-identical across 70 fuzz
comparison points, including catching a real cross-family bug) but its
wall-clock benefit is too small to clear the landing bar, and cannot be
made larger without changing what it targets. The residual ~90–96% cost —
canonical CBOR serialization of the entire composed snapshot on every
write — is a property of the current one-blob-per-Scope storage shape, not
of family-level derivation, so no per-family caching strategy can reduce it
by design. This is the concrete evidence that feeds the ADR-066
residual-curve question: the curve is not flat because A1/A2 "didn't
work" — it is flat because the next bottleneck downstream (canonical
serialization of the full composed value) sits entirely outside what A1/A2
could ever touch, and only a storage-shape change (Option B, out of this
milestone's scope and this issue's stated non-goal) can move it.

### What was salvaged versus reverted

- The prototype implementation
  (`postgres-backend-projection-cache.ts`, the `postgres-backend.ts` /
  `postgres-backend-persistence.ts` / `index.ts` wiring, and the dedicated
  `backend-postgres.projection-cache.test.ts` suite) was reverted in full —
  it is not part of the committed change, consistent with the "do not land"
  disposition above.
- The M3 review-debt item this milestone's investigation surfaced along the
  way — "a fault-hook-driven test asserting cache non-poisoning when
  COMMIT/midCommit throws" — was salvaged and ported into
  `backend-postgres.snapshot-cache.test.ts` as three tests scoped to the
  M3 snapshot cache alone (no projection-cache assertions or imports):
  one exercising `point: "before-commit"` (a genuine rollback — the fault
  fires before `persistStateSnapshot`/`COMMIT` ever run, so the cache is
  never populated), and one each for `point: "mid-commit"` and
  `point: "after-commit-before-ack"` (both fire strictly *after* a real
  `COMMIT` has already succeeded, so these are successful-write/
  failed-acknowledgment scenarios rather than rollbacks; the tests assert
  the snapshot cache stays byte-for-byte in sync with what was actually
  durably committed in every case, cross-checked against an independent,
  cache-less backend instance reading the same row).

### Validation performed for M4

- `bun run nx run backend-postgres:test` — pass, on the reverted tree (the
  three salvaged fault-hook tests pass alongside the pre-existing M3
  snapshot-cache suite; nothing from the reverted prototype remains).
- `bun run nx run backend-postgres:typecheck` — pass.
- `bun run nx run backend-postgres:lint` — pass.
- `bun run check` — pass.
- `git diff | grep '\[DEBUG-'` — no matches outside this report's own
  prose.
- Before reverting, the prototype itself passed its full local suite
  (`bun run nx run backend-postgres:test` — 63/63: 56 pre-existing tests
  unmodified, plus 7 projection-cache tests, including the 70-point
  byte-identity fuzz test) and `bun run verify:kernel` — this is part of
  the evidence that the "not landed" decision was a measured-benefit
  judgment call, not a correctness retreat.

### Deviations from the M4 brief

- The milestone brief anticipated landing A1/A2 if the design proved
  correct. It proved correct but did not clear issue #108's own landing
  bar (a real, reproducible before/after gain), so the deviation is the
  disposition itself: close with measured reason instead of land, per the
  issue's own stated criterion, not a departure from it.
- Two ad-hoc, uncommitted measurement scripts were written and run locally
  to produce the "why A1 is refuted" numbers above (a schemas-only
  marginal-write variant of the committed bench, and the isolated
  clone+sort micro-benchmark); at M4 time neither was part of the
  committed change — closing with measured reason calls for honest
  measurement of the residual, not necessarily a second permanent bench
  target, and adding one seemed like scope creep against "Keep package
  entrypoints small and explicit" / avoiding unnecessary committed surface
  for a one-time diagnostic.
- **M5 review debt revisits this:** a reviewer flagged that "one-time
  diagnostic" was in tension with citing the numbers as reproducible
  evidence in a permanent report. The isolated clone+sort micro-benchmark
  (not the schemas-only marginal-write variant, which stays an uncommitted
  local script since it exercises the full committed bench path rather
  than isolating a single mechanism) is now committed as
  `typescript/kernel/backends/postgres/bench/postgres-encode-family.bench.ts`
  with a `bench-encode-family` Nx target — see the M4 review-debt note
  under "Why A1 is refuted" above for the re-run numbers.

## M5 — B1 health()/fsck() split (validation off the hot read path)

**Goal:** issue #108 area B1 — move whole-state validation off the hot read
path. Both backends implemented `health()` as a full fsck: BEGIN/load/
validate/ROLLBACK, every call. Post-M2, `health()` at 10,000 rows cost
~1.13s on the sqlite backend, ~81.8% of it inside `validateLoadedState`'s
per-record identity re-hash (see the M2 section above). Git runs `fsck` as
occasional maintenance, never on every read — the goal is to make `health()`
behave the same way, without weakening what the backend actually guarantees.

### Design

1. **`health()` becomes a lightweight liveness/coherence probe** on both
   backends, with no whole-state load or validation:
   - **sqlite:** the connection genuinely starts and completes a transaction
     (`BEGIN IMMEDIATE` / `ROLLBACK` around a trivial `SELECT 1` — the same
     transaction hygiene the old deep probe used, so a connection wedged
     mid-transaction still fails health() exactly as before) and
     `validateMigrationState` (cheap; the only check that ever distinguished
     "corrupt/missing schema" from "healthy" at this probe) still runs. No
     `loadState`, no `validateLoadedState`, no lineage-index validation, no
     `validateCommittedState`.
   - **postgres:** the connection can execute a query, the Scope's snapshot
     row exists, and its `schema_version` is one this package version
     supports (`checkPersistedStateLiveness`, a new function in
     `postgres-backend-persistence.ts`) — without fetching or decoding the
     row's `snapshot_cbor` bytes at all. No decode, no `validateCommittedState`.
   - Both keep the exact poll-safe `{ ok: true } | { ok: false; reason }`
     shape; nothing about error handling or transaction hygiene changed.
2. **A new `fsck()` method on both backend classes** (`SqliteBackend`,
   `PostgresBackend` — deliberately NOT added to the `RuntimeBackend`
   interface in `kernel-protocol`, since it is a maintenance capability
   above the contract, not a syscall the kernel drives) performs exactly
   what `health()` did before this milestone: sqlite's `BEGIN IMMEDIATE` +
   full `loadValidatedState` + `ROLLBACK`; postgres's full
   `loadPersistedStateForUpdate` (decode) + `validateCommittedState(state,
   state)`. Same `{ ok: true } | { ok: false; reason }` return shape.
   `createSqliteBackend`'s exported return type now includes `fsck` (mirroring
   how it already widened for `close`); `createPostgresBackend` keeps its
   plain `RuntimeBackend` return type (widening it to include `fsck` broke
   several pre-existing `as ClosablePostgresBackend`-style test casts —
   TypeScript's "sufficiently overlaps" cast heuristic treats an explicit
   intersection type more strictly than a plain interface reference — so
   postgres tests that need `fsck()` cast through a local interface instead,
   the same pattern already used for `destroy()`/`sql`).

### Contract argument: `health()` never promised whole-state validation

`RuntimeBackend.health()`'s doc comment
(`typescript/kernel/protocol/src/lib/kernel-types.ts:987–991`) reads, in
full:

> Probes the durable substrate. Returns `{ ok: true }` when the backend can
> serve traffic, otherwise `{ ok: false }` with a human-readable reason.

"Can serve traffic" is a liveness/coherence claim, not a promise to
re-validate every persisted record and cross-record invariant on every
call. No conformance plan governs `health()` either — `spec/conformance`
has zero references to `health` as a checked surface — so there was no
authority packet or promoted check this milestone had to satisfy, extend,
or contradict. The full load+validate pass both backends ran on every call
was therefore an implementation choice inherited from getting persistence
working, not a contractual obligation; this milestone brings the
implementation back in line with what the contract actually promises.

### The guarantee is preserved, not weakened

Nothing about *when* validation happens at write time changed: every
`transact()` call already re-validates its own write before `COMMIT`
(sqlite's `validateTransactionWriteSet` plus repository invariants;
postgres's `validateCommittedState(draftState, baseState)`), and `reclaim()`
still runs the full load+validate pass twice (before and after the sweep)
on both backends, exactly as before. What moved is *only* the redundant
re-validation that used to run again on every `health()` poll, on top of
what commit-time validation had already checked. The full pass is still one
call away via `fsck()`, callable as often as an operator wants — Git's own
`fsck` is "occasional maintenance, never on every read," and the
repository's integrity guarantee never depended on running it on every
read either.

### The proof test (both backends)

Both backends' proof tests inject committed-state corruption that no
migration/schema/connectivity check can see, then assert `health()` still
reports `{ ok: true }` while `fsck()` reports `{ ok: false, reason }` —
demonstrating the split with behavior, not argument.

- **sqlite** (`backend-sqlite.invariants.test.ts`, "keeps committed-state
  corruption invisible to health() but reports it through fsck() (issue
  #108 M5)"): seeds a valid database, then directly tampers with a stored
  object row's `hash` column via raw SQL so it no longer matches the row's
  `bytes` (the same corruption `backend-sqlite.record-validation.test.ts`'s
  "rejects stored object rows whose hash no longer matches bytes" case
  uses, now routed through both methods instead of only the old `health()`).
  `transact()` still runs normally (the corruption does not block the hot
  path); `health()` returns `{ ok: true }`; `fsck()` returns `{ ok: false }`
  with a reason matching the object-row identity error pattern.
- **postgres** (new file `backend-postgres.health-fsck.test.ts`, "keeps an
  active-run/branch-head misalignment invisible to health() but reports it
  through fsck()"): builds a thread/branch/turn/running-run through
  `@tuvren/kernel-runtime`'s `createRuntimeKernel`, decodes the persisted
  snapshot, directly rewrites the branch's `headTurnNodeHash` back to the
  thread root (bypassing `transact()`'s own `validateCommittedState`
  entirely, mirroring how a raw SQL edit or a different writer's bug could
  produce the same corruption), and re-persists the tampered bytes via
  `writeSnapshotCbor`. Every individual record is still schema-valid
  (`decodeSnapshot`'s per-record asserts pass); only the cross-record
  active-run/branch-head alignment invariant (`assertActiveRunHeadAlignment`)
  is broken — exactly the class of corruption a connectivity/schema-version
  check can never see. `health()` returns `{ ok: true }`; `fsck()` returns
  `{ ok: false }` with a reason matching `/stay aligned with the current
  branch head/`.

### Before/after: health() drops to constant cost; fsck() continues the old curve

sqlite, `bun run nx run backend-sqlite:bench-load-cost` (`n=15`,
`2026-07-22`, same machine/ladder as M1/M2):

| Turn nodes | health best | health median | health p95 | fsck best | fsck median | fsck p95 | fsck/health best ratio |
|---|---|---|---|---|---|---|---|
| 10 | 265.8 μs | 286.6 μs | 368.5 μs | 4.457 ms | 4.861 ms | 6.159 ms | 16.8x |
| 100 | 238.3 μs | 247.6 μs | 271.1 μs | 13.398 ms | 14.665 ms | 19.294 ms | 56.2x |
| 1,000 | 235.4 μs | 241.4 μs | 252.7 μs | 115.731 ms | 125.667 ms | 137.637 ms | 491.7x |
| 10,000 | 239.7 μs | 256.9 μs | 853.1 μs | 1.119 s | 1.167 s | 1.231 s | 4666.7x |

`health()` is now flat — roughly 235–370 μs (best/median/p95, ignoring the
10,000-tier p95 outlier at 853 μs) across three orders of magnitude of
database size, consistent with "a trivial read plus schema-shape checks
that don't scale with row count." `health()` no longer reports any
`PhaseObserver` samples at all (there is nothing left inside it to
attribute — no `load`/`validate-*` phase runs). `fsck()` reproduces the old
health() curve exactly, because it is byte-for-byte the same code path: at
10,000 rows, `fsck()`'s own `validate-loaded` phase (915 ms of a 1.119 s
total, ~81.8%) matches the M2 section's "~81.8% of health() in
`validateLoadedState`" finding precisely, confirming `fsck()` is a faithful
rename-and-relocate of the pre-M5 `health()`, not a reimplementation.
`reclaim()`'s cost (which still runs the same full load+validate pass
twice, unconditionally) is unaffected — it was never routed through
`health()` and continues to scale the same way it did in M1/M2.

### Migration inventory: which tests moved to `fsck()`, which stayed on `health()`, and why

**Moved to `fsck()`** (committed-state/per-record corruption — invisible to
the new lightweight `health()` by design):

- `backend-sqlite-test-helpers.ts`'s `expectCorruptedStateRejection` helper
  now calls `fsck()` instead of `health()`. Every test in
  `backend-sqlite.record-validation.test.ts` (13 cases: invalid run status,
  invalid object `byteLength`, object hash/bytes mismatch, invalid
  `currentStepIndex`, interrupted staged result with null payload,
  malformed consumed-staged-results payload, corrupted lineage depth,
  invalid thread/branch/turn timestamp metadata, invalid turn-tree-path
  collection kind, corrupted `orderedCount`/`item_count` cardinality) moved
  transitively through this one helper change.
- `backend-sqlite.invariants.test.ts`: "reports unhealthy status through
  fsck() when committed-state invariants are broken" (a raw-SQL-inserted
  second active run on the same branch — the duplicate-active-run
  invariant) and the proof test described above both call `fsck()`
  directly.
- `backend-sqlite.phase-observer.test.ts`: both tests now exercise `fsck()`
  instead of `health()`, since the load/validate-loaded/
  validate-lineage-index/validate-committed phase-attribution this suite
  proves only exists inside the full pass, which lives in `fsck()` now.
- postgres: the new `backend-postgres.health-fsck.test.ts` proof test
  (described above) is the only postgres test exercising this class of
  corruption end-to-end; no pre-existing postgres test needed migrating,
  since postgres had no equivalent pre-M5 committed-state-corruption test
  routed through `health()`.

**Stayed on `health()`** (migration/schema/connectivity corruption — still
visible to the lightweight probe by design):

- `backend-sqlite.invariants.test.ts`: "reports unhealthy status when
  required schema tables are missing" and "reports missing tables through
  health instead of transaction preflight" (both `DROP TABLE objects`, then
  assert `health()` fails) and "rejects databases that are missing baseline
  indexes" (`DROP INDEX`, then assert `health()` fails) — all three are
  caught by `validateMigrationState`, which the lightweight `health()` still
  runs.
- `backend-sqlite.rollback-normalization.test.ts`: still asserts
  `health()` returns `{ ok: true }` after a rolled-back transaction, to
  prove the connection was not left mid-transaction — `health()` still runs
  `BEGIN IMMEDIATE`/`ROLLBACK` around its trivial read, so this transaction-
  hygiene assertion is unaffected by the lightweight-probe change.
- `backend-sqlite.wal-locking.test.ts`, `backend-sqlite.startup.test.ts`:
  unchanged `{ ok: true }` sanity checks after normal startup/reopen/WAL
  scenarios — none of these assert on committed-state corruption, so they
  needed no migration.
- postgres: `backend-postgres.test.ts`'s "retries initialization after a
  transient bootstrap failure" (patches `sql.begin` to fail once, asserting
  `health()` surfaces the transient error and then recovers) exercises
  `ensureInitialized()`, which `health()` still calls first — unaffected.
  `backend-postgres.pool-contention.test.ts` and
  `backend-postgres.reclamation.test.ts`'s `{ ok: true }` sanity checks
  after normal operation/reclaim also needed no migration.

### Review debts folded in from M4 (see the M4 section above for the first two)

1. Reworded the M4 "±1–5% run-to-run noise" claim, which its own table
   contradicted at small tiers (10-object p95 −36.5%, 100-object best
   −22.0%, mixed signs including a +12.1% regression at 100-object p95):
   the ±1–5% band holds only at the decisive 10,000-object tier; smaller
   tiers are high-relative-variance on tiny absolute values, not evidence of
   a real effect. No re-measurement — this was a wording fix over existing
   numbers.
2. Committed the clone+sort micro-benchmark as
   `postgres-encode-family.bench.ts` with a `bench-encode-family` Nx target
   (see the M4 section's "Why A1 is refuted" for the re-run numbers: best
   6.339 ms / median 6.989 ms / p95 9.743 ms at the default 10,000-object
   family size, `n=15` — consistent with, in fact slightly below, the
   original ~4–8% attribution, so the headline M4 figures are unchanged).
3. Tightened `backend-postgres.snapshot-cache.test.ts`'s "a fault injected
   before COMMIT rolls back cleanly..." test to assert the specific
   injected-fault error code (`rejects.toMatchObject({ code:
   "kernel_persistence_fault_injected" })`) instead of a bare
   `rejects.toThrow()`, matching its two `mid-commit`/`after-commit-before-ack`
   siblings.

### Validation performed for M5

- `bun run nx run backend-sqlite:test` — 103/103 pass.
- `bun run nx run backend-sqlite:typecheck` — pass.
- `bun run nx run backend-sqlite:lint` — pass (one
  `lint/suspicious/useAwait` finding on the now-synchronous `health()` body,
  resolved with a `biome-ignore` — `queueConnectionWork` requires a
  Promise-returning callback even though every read inside is synchronous
  better-sqlite3 work).
- `bun run nx run backend-postgres:test` — 60/60 pass (devenv PostgreSQL
  already running per session setup; `devenv up` itself was never invoked).
- `bun run nx run backend-postgres:typecheck` — pass.
- `bun run nx run backend-postgres:lint` — pass.
- `bun run check` — pass.
- `bun run verify:kernel` — pass; health is not conformance-governed (see
  the contract argument above), and this run is the evidence that nothing
  conformance-relevant regressed anyway.
- `git diff | grep '\[DEBUG-'` — no matches outside this report's own prose.

### Deviations from the M5 brief

- `createPostgresBackend`'s exported return type was not widened to include
  `fsck()` the way `createSqliteBackend`'s was widened for `close()`
  (design point 2 anticipated mirroring that pattern). Widening it broke
  several pre-existing `as ClosablePostgresBackend`/`as
  TestablePostgresBackend`-style test casts elsewhere in the suite
  (TypeScript's cast-overlap heuristic treats an explicit intersection type
  more strictly than a plain interface reference, so those casts stopped
  type-checking). Postgres tests that need `fsck()` cast through a local
  interface instead (`as unknown as FsckCapableBackend`), the same
  double-cast pattern already in use for `destroy()`/`sql` elsewhere in the
  postgres test suite. Behavior is identical either way; only the exported
  static type signature differs from what the design anticipated.

## M6 — C1 reclaim single-load

**Goal:** issue #108 area C1 — eliminate sqlite `reclaim()`'s second full
`loadValidatedState` pass. Post-M2/M5, `reclaim()` called `loadValidatedState`
twice per call (once to capture survivor keys before the sweep, once to
re-validate referential integrity after deleting), making its cost roughly
1.4×–1.9× `fsck()`'s own single-pass cost even though the second pass mostly
re-verified work the sweep could not have invalidated.

### Design

`reclaim()` keeps its shape — `BEGIN IMMEDIATE` → `defer_foreign_keys = ON`
→ `loadValidatedState` (unchanged: load, `validate-loaded`,
`validate-lineage-index`, `validate-committed`) → capture survivor keys →
`reclaimBackendState` (shared sweep, mutates the loaded projection via
`Map.delete`) → `applyReclamationDeletions` (batched `DELETE`s diffed from
pre/post key sets) → `COMMIT` — but the second `loadValidatedState` call
between the deletes and `COMMIT` is gone. In its place,
`assertReclamationSurvivorInvariants`
(`typescript/kernel/backends/sqlite/src/lib/sqlite-reclamation-validation.ts`,
a new module, exported for direct unit testing the same way
`encodeSnapshot`/`decodeSnapshot` are in the postgres backend) runs a
targeted, O(survivors) check directly over the same in-memory `state` object
the deletes were diffed from — the post-deletion truth, not a fresh read.
It gets its own `PersistencePhase`, `"validate-reclaim-survivors"`, added to
the shared union in `backend-invariant-phase-observer.ts`, so the bench's
phase table stays honest about where reclaim's remaining cost sits after the
second load disappears.

The reasoning the check relies on: `loadValidatedState`'s first call already
fully validated the pre-sweep state (shape/identity, the derived
lineage-root index, every committed-state invariant). `reclaimBackendState`
only ever calls `Map.delete` on the loaded projection — it never edits a
surviving record's fields (confirmed by reading every `sweep*` function in
`typescript/kernel/backends/shared/src/lib/backend-invariant-reclamation.ts`:
`sweepRuns`/`sweepTurns`/`sweepArchivedBranches`/`sweepTurnNodes`/
`sweepTurnTrees`/`sweepChunks`/`sweepObjects` are all `Map.delete` loops with
no field mutation). So nothing about record shape or identity can have
changed; the only thing deletion can break is a surviving record's
*reference* to something the sweep removed. `applyReclamationDeletions`
already computes the swept keys — `reclaimedKeys` diffs the pre-sweep key set
against the post-sweep `Map` — so those same swept-vs-kept sets are exactly
what the targeted check needs to verify against, with no additional
bookkeeping.

### Enumerated invariant coverage

Reasoned from `reclaimBackendState`'s closure-computation semantics
(`computeKeepClosure`, `sweep*`) and the actual schema
(`migrations/0001_initial_schema.sql`, `0002_targeted_validation_indexes.sql`):

| Deletion-breakable invariant | Covered by |
|---|---|
| Surviving turn node's `previousTurnNodeHash` ancestor chain resolves entirely within survivors | **FK** (`turn_nodes.previous_turn_node_hash → turn_nodes.hash`, self-referencing, enforced at `COMMIT` under `defer_foreign_keys = ON`) **+ targeted check** (`assertSurvivingTurnNodeLineage`'s shared `TurnNodeLineageIndex` walk, for a friendly `sqlite_backend_missing_turn_node_reference`/`sqlite_backend_turn_node_lineage_cycle` error instead of a raw SQLite constraint failure) |
| Surviving branch's `headTurnNodeHash` resolves to a surviving turn node | **FK** (`branches.head_turn_node_hash → turn_nodes.hash`) **+ targeted check** (`assertSurvivingRootReferences`) |
| Surviving thread's `rootTurnNodeHash` resolves to a surviving turn node | **FK** (`threads.root_turn_node_hash → turn_nodes.hash`) **+ targeted check** (`assertSurvivingRootReferences`); threads are never swept by `reclaimBackendState` at all (no `sweepThreads` exists), so this is doubly guaranteed |
| Surviving turn's branch/thread/start-turn-node/head-turn-node references | **FK** (`turns.branch_id`/`thread_id`/`start_turn_node_hash`/`head_turn_node_hash`) **+ targeted check** (`assertSurvivingTurnReferences`) |
| Surviving run's branch/turn/start-turn-node references | **FK** (`runs.branch_id`/`turn_id`/`start_turn_node_hash`) **+ targeted check** (`assertSurvivingRunReferences`) |
| Surviving run's `createdTurnNodesCbor` lineage | **Not FK-covered** — it is an opaque CBOR-encoded hash array, not a real column. **Targeted check only** (`assertSurvivingRunReferences` decodes it via `decodeRunCreatedTurnNodeHashes` and checks every hash against the survivors) — this is the genuine gap a deferred FK cannot close |
| Surviving turn node's `consumedStagedResultsCbor` object references | **Not FK-covered** (same opaque-CBOR reason). **Targeted check only** (`assertSurvivingTurnNodeLineage`, via `decodeTurnNodeConsumedStagedResultObjectHashes`) |
| Surviving staged result's `runId`/`objectHash` | **FK** (`staged_results.run_id`/`object_hash`) **+ structurally impossible to diverge** (`sweepRuns` in `backend-invariant-reclamation.ts` deletes `state.stagedResults.get(runId)` in the same iteration it deletes `state.runs.get(runId)`) **+ targeted check** (`assertSurvivingStagedResultReferences`) as direct, negligible-cost defense against a defect in that same sweep logic |
| Surviving turn-tree path's `turnTreeHash` | **FK** (`turn_tree_paths.turn_tree_hash → turn_trees.hash`) **+ structurally impossible to diverge** (`sweepTurnTrees` deletes `state.turnTreePaths` in the same iteration it deletes `state.turnTrees`) **+ targeted check** (`assertSurvivingTurnTreePathReferences`) |
| Surviving turn-tree path's resolved object/chunk references (`single_hash`, `ordered_inline_cbor`, `ordered_chunk_list_cbor`) | **Not FK-covered** — no foreign key is declared on these columns at all. **Targeted check only** (`assertTurnTreePathSurvivorReferences`, using the same `resolveStoredTurnTreePathValue` the sweep's own `keepPathObjects` closure step uses to decide what to retain) — the other genuine gap |
| `turn_node_lineage_roots` row set matches `turn_nodes`' surviving row set | **Structurally impossible to diverge** — `applyReclamationDeletions` deletes both tables using the exact same key list (`deletedTurnNodeHashes`), computed once from the same before/after `turnNodes` diff; nothing to re-read from the database |
| `turn_node_lineage_roots`'s cached `(rootTurnNodeHash, depth)` value for a surviving row | **Structurally impossible to go stale** — deletion never edits a surviving row's columns, and the sweep's `closeTurnNodeReachability` walk retains a kept turn node's *entire* ancestor chain back to genesis, never a partial prefix, so a surviving node's ancestor set is unchanged by the sweep; transitively re-proven by the targeted lineage-chain walk (first row of this table), which would surface a broken link if that structural guarantee were ever violated |

### Corruption-still-caught proof

`assertReclamationSurvivorInvariants` is exported (module-private, not
re-exported from `index.ts` — the same precedent as postgres's
`encodeSnapshot`/`decodeSnapshot`) and unit-tested directly in the new
`typescript/kernel/backends/sqlite/test/sqlite-reclamation-validation.test.ts`,
seven cases against a shared, fully cross-referenced fixture builder
(`buildBaseFixture`: a three-node turn-node chain, thread, branch, turn, run,
staged result, and turn-tree path, all genuinely resolving to each other):

1. **Baseline** — the unmodified fixture passes (`doesNotThrow`), proving the
   check does not false-positive on a genuinely consistent post-sweep state.
2. **Branch head pointing at a deleted node** — deletes the turn node a
   surviving branch's `headTurnNodeHash` points to; rejects with
   `sqlite_backend_missing_turn_node_reference`.
3. **Surviving child of a deleted parent** — deletes the *middle* node of a
   three-node chain, leaving the branch head (the grandchild, still present)
   with a broken ancestor link; rejects with
   `sqlite_backend_missing_turn_node_reference` from the lineage-chain walk,
   isolated from case 2 by construction (the branch head's own row is never
   touched in this case).
4. **`consumedStagedResultsCbor` referencing a deleted object** — deletes the
   object a surviving turn node's consumed-staged-result entry references;
   rejects with `sqlite_backend_missing_object_reference`.
5. **`createdTurnNodesCbor` referencing a deleted turn node** — rebases the
   branch/turn heads off the node under test first (isolating this case from
   cases 2–3), then deletes a turn node a surviving run's
   `createdTurnNodesCbor` lineage references; rejects with
   `sqlite_backend_missing_turn_node_reference` — the CBOR-blob gap no
   foreign key can see.
6. **Staged result of a deleted run** — deletes the run a surviving staged
   result still references (simulating `sweepRuns` dropping the run map
   entry without also dropping the staged-results entry); rejects with
   `sqlite_backend_missing_run_reference`.
7. **Turn-tree path resolving to a deleted object** — clears every other
   object reference in the fixture, then deletes the object a surviving
   turn-tree path's `single_hash` resolves to; rejects with
   `sqlite_backend_missing_object_reference` — the other CBOR/no-FK gap.

Each case asserts the specific `TuvrenPersistenceError.code`, not just that
*something* threw, so the proof is that the *right* check catches the
*right* defect. The pre-existing end-to-end reclamation test
(`backend-sqlite.reclamation.test.ts`, "reclaims unreferenced objects and
archived branches after a rollback" / "is a safe no-op when nothing is
unreachable") was **not modified** and still passes unmodified against the
real `reclaim()` path, proving normal reclamation still releases unreachable
data and retains reachable data with the second load gone.

### Before/after: `bun run nx run backend-sqlite:bench-load-cost` (n=15)

**Before** (M2's committed reclaim series — M5 did not re-report `reclaim()`
numbers since its scope was `health()`/`fsck()` only, and `reclaim()`'s own
implementation was untouched between M2 and this milestone — against M5's
committed `fsck()` series, since `fsck()` is byte-for-byte the pre-M5
`health()` code path `reclaim()`'s own `loadValidatedState` calls always
ran):

| DB size | fsck best (M5) | reclaim best (M2) | reclaim/fsck ratio |
|---|---|---|---|
| 10 | 4.457 ms | 7.065 ms | 1.58× |
| 100 | 13.398 ms | 22.217 ms | 1.66× |
| 1,000 | 115.731 ms | 160.901 ms | 1.39× |
| 10,000 | 1.119 s | 1.580 s | 1.41× |

**After** (this milestone, same machine/ladder, `2026-07-22`, n=15):

| DB size | health best | fsck best | reclaim best | reclaim median | reclaim p95 | reclaim/fsck ratio |
|---|---|---|---|---|---|---|
| 10 | 266.4 μs | 4.086 ms | 4.026 ms | 4.914 ms | 6.136 ms | 0.99× |
| 100 | 235.6 μs | 13.893 ms | 11.223 ms | 11.708 ms | 13.381 ms | 0.81× |
| 1,000 | 231.7 μs | 115.194 ms | 90.517 ms | 93.686 ms | 106.372 ms | 0.79× |
| 10,000 | 238.5 μs | 1.098 s | 834.098 ms | 855.039 ms | 905.153 ms | 0.76× |

The reclaim/fsck ratio collapses from **1.4×–1.7×** (the spike-era range the
brief cited, and consistent with M2/M5's own ~1.3×–1.9× series) down to
**0.76×–0.99×** — reclaim is now at or *below* `fsck()`'s own single-pass
cost at every tier, not the ~2× multiple of it the second load used to cost.
At the decisive 10,000-row tier: reclaim best-case dropped from **1.580 s to
834 ms, a 1.9× speedup**, while releasing the same `25` orphaned objects each
sample seeds (`releasedObjectCount=25`, unchanged from prior milestones'
bench shape).

### Phase attribution: the second load's phases disappear, one new phase replaces them

Per-phase attribution at 10,000 rows (best; `n=15` for every phase now —
`reclaim()` no longer calls `loadValidatedState` twice, so M1/M2's "n=30
because two samples of that phase are recorded per single reclaim() call"
note no longer applies to `reclaim()`):

| Phase | fsck (single load+validate pass) | reclaim (before M6: same pass × 2) | reclaim (after M6) |
|---|---|---|---|
| `load` | 164.3 ms | ran twice (~2× 103 ms) | 104.3 ms (once) |
| `validate-loaded` | 891.0 ms | ran twice (~2× 640–900 ms) | 624.8 ms (once) |
| `validate-lineage-index` | 19.2 ms | ran twice | 19.2 ms (once) |
| `validate-committed` | 21.3 ms | ran twice | 21.4 ms (once) |
| `validate-reclaim-survivors` | n/a (new phase) | did not exist | 21.0 ms (new, replaces the second pass) |
| `write` | n/a | delete + commit | delete + commit (unchanged) |

`validate-reclaim-survivors` (21.0 ms at 10,000 rows) is roughly **1/40th**
the cost of the `validate-loaded` pass it stands in for avoiding a second run
of (891.0 ms) — the O(survivors) targeted check is dramatically cheaper than
a full per-record identity re-hash plus a fresh database read, exactly the
saving the design predicted. The updated
`backend-sqlite.phase-observer.test.ts` case ("a RecordingPhaseObserver
captures every persistence phase in the order fsck()/reclaim() run them")
asserts this shape directly: every `load`/`validate-*` phase from
`loadValidatedState` now appears **exactly once** per `reclaim()` call (was
twice before this milestone), `validate-reclaim-survivors` appears exactly
once and is attributed after `validate-committed`, and `write` still appears
at least twice (the batched deletes, then `COMMIT`).

### Files touched

- `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` — `reclaim()`
  drops the second `loadValidatedState` call, adds the
  `validate-reclaim-survivors` phase around the new targeted check, and its
  doc comment (plus `loadValidatedState`'s) is updated to describe the new
  shape and the FK/targeted-check reliance.
- `typescript/kernel/backends/sqlite/src/lib/sqlite-reclamation-validation.ts`
  (new) — `assertReclamationSurvivorInvariants` and its six per-family helper
  functions, with the full enumerated-coverage reasoning in its doc comment.
- `typescript/kernel/backends/shared/src/lib/backend-invariant-phase-observer.ts`
  — adds `"validate-reclaim-survivors"` to the `PersistencePhase` union.
- `typescript/kernel/backends/sqlite/test/sqlite-reclamation-validation.test.ts`
  (new) — the seven corruption-proof unit tests described above.
- `typescript/kernel/backends/sqlite/test/backend-sqlite.phase-observer.test.ts`
  — updated reclaim-phase assertions for the single-load shape plus the new
  phase.
- `typescript/kernel/backends/sqlite/test/backend-sqlite-test-helpers.ts` —
  adds `sqlite-reclamation-validation.js` to the fake-dist-layout file list
  `copyCompiledSqliteRuntimeBundle` copies, so the dist-layout startup tests
  keep resolving the new module.
- `typescript/kernel/protocol/src/lib/kernel-types.ts` — M5 review debt:
  tightens `RuntimeBackend.health()`'s doc comment to state what it actually
  proves (connectivity plus schema/migration liveness) and explicitly not
  prove (a decodable/semantically valid committed blob), pointing to
  backend-level `fsck()`/commit-time validation for the deeper guarantee.
  `docs/KrakenKernelSpecification.md` §8.1 (Storage Contract) does not
  mention `health()` at all, so it was already "probe-shaped" by omission
  and needed no alignment edit.
- `typescript/kernel/testkit/src/lib/fault-injecting-backend.ts` — M5 review
  debt: forwards an optional `fsck()` method through
  `createFaultInjectingBackend`'s decorator (discovered structurally via
  `readOptionalFsckMethod`, the same `Reflect.get`-based pattern
  `close`/`destroy` already use, since `fsck` is not a `RuntimeBackend`
  member), so a wrapped backend that has `fsck()` does not silently lose it
  behind the fault-injection decorator.

### Validation performed for M6

- `bun run nx run backend-sqlite:test` — 110/110 pass (103 pre-existing plus
  7 new `assertReclamationSurvivorInvariants` corruption-proof cases; the
  pre-existing reclamation end-to-end tests and the phase-observer suite
  pass with the phase-observer test's reclaim-phase assertions updated for
  the new single-load shape).
- `bun run nx run backend-sqlite:typecheck` — pass.
- `bun run nx run backend-sqlite:lint` — pass (after one `biome check --write`
  formatting pass over the new/edited files; no logic changes from
  formatting).
- `bun run nx run backend-shared:typecheck` — pass (the `PersistencePhase`
  union addition).
- `bun run nx run backend-postgres:typecheck` — pass (unaffected; postgres's
  `reclaim()` was never in scope for this milestone since it already runs a
  single load/validate pass, per its own snapshot-blob write model).
- `bun run nx run kernel-contract-protocol:typecheck` /`:lint` /`:test` —
  pass (86/86 tests; the `health()` doc-comment change).
- `bun run nx run kernel-testkit:typecheck` /`:lint` /`:test` — pass (13/13
  tests; the `fsck()` forwarding change).
- `bun run check` — pass (fast inner-loop lane: authority gates + affected
  typecheck/test/lint across the full affected set).
- `bun run verify:kernel` — pass, including sqlite conformance at
  `71/71` applicable checks (`kernel-typescript-sqlite-certification`) —
  reclamation's observable semantics (what is released/retained under grace
  windows, leases, live roots) are unchanged; `spec/conformance/kernel/plans/kernel-reclamation.json`
  stayed green throughout.
- `git diff | grep '\[DEBUG-'` — no matches outside this report's own prose.

### Deviations from the M6 brief

None. The design landed as specified: the second `loadValidatedState` pass
is gone, replaced by a targeted O(survivors) check with its own phase
attribution, the enumerated coverage table above accounts for every
deletion-breakable reference the sweep's own semantics expose, and the
corruption-proof tests demonstrate the targeted check rejects each specific
class of defective-sweep corruption the brief asked for.

## M7 — B2 closed with measured reason, D1 closed as not applicable (measured), and M6 review debts

**Goal:** close the two remaining open issue areas from the original #108
disposition matrix — B2 (delta-validation instead of whole-state
`validateCommittedState` per commit) and D1 (whether the postgres `max: 1`
pool plus in-process `transactionQueue` wrongly serializes writers on
*different* scopes) — with committed measurement rather than assertion, and
fold in the two M6 review debts identified after that milestone landed
(chunked/inline-array turn-tree-path corruption coverage, and a wiring guard
proving `reclaim()` actually calls its post-sweep invariant check).

### B2 — closed with measured reason

**The question.** B2 proposed validating only a commit's write-set against
prior committed state (delta-validation), prototyped shadow-first, instead
of running whole-state `validateCommittedState` on every commit — on the
theory that whole-state validation might be a write-path cost worth cutting
as scope/database size grows.

**The measured answer: whole-state validation is already flat and already a
negligible share of write cost on both backends, post-M2.** M2 (the shared
memoized `TurnNodeLineageIndex`) fixed the one place `validateCommittedState`
could have gone superlinear (`assertTurnNodeBelongsToThread`/
`assertTurnNodeDescendsFrom`'s per-call ancestor walks); since that landed,
`validateCommittedState` is O(state size) with a small constant, and every
bench this report has run confirms it stays a tiny, roughly flat number of
microseconds regardless of scope/database size, while the surrounding
write-path work (postgres's whole-blob CBOR decode/encode, sqlite's
per-record row I/O) grows with size and dominates the total.

**Postgres.** `transact()`'s single `validate` phase (whole-state
`validateCommittedState`, unchanged in cost by M2/M3/M4 — M3's own text
above confirms it: "`validate` was already flat/negligible at 13–24 μs at
every size in M1 and stays so here", and the M3 per-phase comparison at
10,000 objects measured `validate` at 14.6 μs vs M1's 13.5 μs, i.e. the same
number within machine noise) against the *current* committed write-latency
baseline (M3's "after" table — M4's canonical-projection-cache prototype was
reverted per that milestone's own "closed with measured reason" disposition,
so M3's numbers, not M4's, are what ships):

| Scope size | total best (M3, committed) | validate best (flat, M1–M3) | share (best) | total median (M3) | validate median (M1) | share (median) |
|---|---|---|---|---|---|---|
| 10 | 2.773 ms | 7.5 μs | **0.270%** | 3.720 ms | 8.9 μs | 0.239% |
| 100 | 5.616 ms | 10.7 μs | **0.191%** | 7.016 ms | 15.3 μs | 0.218% |
| 1,000 | 26.941 ms | 11.9 μs | **0.044%** | 28.986 ms | 13.8 μs | 0.048% |
| 10,000 | 248.374 ms | 14.6 μs | **0.006%** | 283.823 ms | 16.7 μs | 0.006% |

**SQLite.** `transact()` has no whole-state validate call on its write path
at all — `sqlite-backend.ts`'s `transact()` calls
`validateTransactionWriteSet(this.db, writeTracker)` (line 528), never
`validateCommittedState`; that whole-state check only runs on the read/
maintenance paths (`fsck()`/`reclaim()`'s `loadValidatedState`), which this
issue's write-path question does not concern. This means sqlite's write path
was **already delta-shaped before this milestone** — `validateTransactionWriteSet`
re-validates only the rows a transaction actually touched (tracked by
`TransactionWriteTracker`), the exact shape B2 proposed adding to postgres.
That call had no phase attribution before this milestone (M1 explicitly
scoped it out: "`transact()`'s write path is not instrumented in M1... it
has no full-blob decode/validate/encode seam to attribute"), so this
milestone adds the minimal instrumentation the B2 closure needs to make its
share visible by name: a new `"validate-write-set"` `PersistencePhase`
(`backend-invariant-phase-observer.ts`), wrapping the existing
`validateTransactionWriteSet` call in `transact()`
(`sqlite-backend.ts:528-534`) with `this.phaseObserver.startPhase(...)` /
end, deliberately *not* reusing postgres's `"validate"` name (the two check
different things — a commit's delta vs. the entire committed state — and
sharing a name would make a future reader misread sqlite's already-delta-shaped
write path as doing postgres's whole-state work). `bun run nx run
backend-sqlite:bench` (`sqlite-hot-path.bench.ts`, n=15, `BENCH_SAMPLE_COUNT`
default) now reports this phase on every case; the "single object write
transaction" case is the direct sqlite analogue of postgres's one-object
`transact()` bench:

| History size | total best/iter | validate-write-set best | share (best) | total median/iter | validate-write-set median | share (median) |
|---|---|---|---|---|---|---|
| 0 | 162.662 μs | 752 ns | **0.462%** | 227.064 μs | 1.714 μs | 0.755% |
| 100 | 152.352 μs | 982 ns | **0.645%** | 217.725 μs | 1.593 μs | 0.732% |
| 500 | 143.148 μs | 922 ns | **0.644%** | 163.450 μs | 1.042 μs | 0.638% |
| 1,000 | 142.675 μs | 701 ns | **0.491%** | 162.981 μs | 881 ns | 0.540% |

sqlite's `validate-write-set` share (~0.46–0.76%) is flat across history
size, as expected: it costs O(write-set size), not O(database size), so
growing the turn-node chain the write is unrelated to does not move it.

**The disposition.**

1. **Theoretical max gain (Amdahl).** Even a hypothetically *zero-cost*
   delta validator can only ever save the share measured above: ≤0.27% of
   write time on postgres (already shrinking as scope grows — 0.27%→0.006%
   across the ladder, because `validate`'s absolute cost is flat while the
   denominator grows), and ≤0.76% on sqlite (also flat, but sqlite's write
   path is already the delta-shaped check B2 asked for, so this is not
   headroom B2 could add — it is the cost of the delta validator that
   already runs). Neither number is a write-path bottleneck by any
   reasonable threshold.
2. **The O(N)-encode/persist floor dominates regardless.** Postgres's write
   cost is a whole-blob CBOR `decode` + `encode` + `write` on every
   `transact()` (M1/M3: `encode` alone is ~168 ms of the ~248 ms best-case
   total at 10,000 objects — 68% — unchanged by any validation strategy);
   deleting `validate`'s 14.6 μs entirely would not move that floor.
   SQLite's write path is **already O(delta)**, not O(database size) — its
   per-write row operations only ever touch the rows a transaction's
   repository calls wrote, which is exactly why `validateTransactionWriteSet`
   (the thing already running) is delta-shaped rather than whole-state. This
   makes delta-*validation* the only candidate B2 could have targeted on
   sqlite in the first place (the surrounding write path was never
   whole-state to begin with), and that candidate's own measured ceiling is
   the ≤0.76% table above.
3. **Correctness-risk asymmetry.** Delta-validation requires proving, per
   invariant, that the invariant is *local* — that no invariant in
   `validateCommittedState`'s suite (turn-node lineage, branch/turn/run
   cross-references, turn-tree-path resolution, staged-result references,
   schema conformance) can be violated by a write whose direct write-set
   satisfies it in isolation but whose *combination* with unrelated existing
   state does not. M2's own fix (the shared `TurnNodeLineageIndex`) is
   direct evidence this is not a safe assumption to make casually: lineage
   invariants are defined over ancestor chains that a single write's
   immediate write-set does not fully contain. Proving invariant locality
   for all twelve state families, correctly, for a ≤0.27%/≤0.76% ceiling, is
   a poor risk/reward trade against whole-state validation's existing,
   simple, already-fast-enough correctness argument ("re-check everything,
   cheaply, every time").
4. **Base-state threading stays.** `validateCommittedState(state,
   baseState)`'s two-argument shape (added for the cross-transaction
   invariants M2's lineage-index fix and the shared-module extraction rely
   on) remains in place. It costs nothing extra to keep and gives a future
   milestone a ready seam if a workload profile ever emerges where
   `validate`'s share is no longer negligible (e.g. a state shape or write
   pattern this report's benches do not exercise).

**Disposition: B2 — closed with measured reason.** Whole-state validation is
flat-cost and a ≤0.27% (postgres) / ≤0.76% (sqlite, already-delta) share of
write time at every measured size; the O(N) encode/persist floor dominates
regardless of validation strategy; and the invariant-locality proof burden
delta-validation would require is disproportionate to a ceiling this small.
No further action beyond the instrumentation and this measurement.

### D1 — closed as not applicable (measured)

**The question.** D1 asked whether the postgres backend's `max: 1`
connection pool (`postgres-backend-persistence.ts:146`, `createPostgresClient`)
combined with `PostgresBackend`'s in-process `transactionQueue`
(`postgres-backend.ts:219`, a `private` per-instance field) wrongly
serializes writers bound to *different* scopes, the way it deliberately
does for writers on the *same* scope.

**Architecture fact, confirmed by reading the source.** `PostgresBackend`
resolves and binds exactly one Scope at construction
(`this.scope = resolvedOptions.scope ?? DEFAULT_SCOPE`, `postgres-backend.ts:228`,
validated by `assertScope`), and every persisted row is keyed by
`(snapshot_id, scope)` — a genuine composite primary key
(`postgres-backend-persistence.ts:233`), always `snapshot_id = 1` for a
given scope's single row. `transactionQueue` and the `postgres.js` client's
connection pool are both **instance fields**, not shared across instances or
keyed by anything wider than the one scope a given `PostgresBackend` was
constructed for. Two backend instances bound to two different scopes
therefore own entirely separate queues and entirely separate `max: 1` pools
— there is no shared state between them for either layer to serialize on.
Cross-scope writers already use separate instances in every deployment shape
this backend supports (`backend-postgres.scope-isolation.test.ts` already
proves this is correct in isolation; `backend-postgres.pool-contention.test.ts`
proves the converse — that *same*-scope writers genuinely do serialize on
the row lock, which is explicitly out of scope for this issue to change).
D1's premise does not hold architecturally; this milestone proves it does
not hold operationally either, with a throughput measurement.

**The measurement.** New bench,
`typescript/kernel/backends/postgres/bench/postgres-cross-scope-throughput.bench.ts`
(`bun run nx run backend-postgres:bench-cross-scope-throughput`, n=5 —
smaller default than the per-write latency benches' n=15 because each
sample here is `SCOPE_COUNT × WRITES_PER_SCOPE` real `transact()` round
trips, not one; override via `BENCH_SAMPLE_COUNT`). Each repetition
allocates fresh scope names (never reusing a scope across repetitions), so
per-scope object count stays constant across every repetition instead of
growing the way the write-latency bench's ladder deliberately does — this
keeps the comparison isolated to the concurrency question, not conflated
with the already-measured whole-blob write-latency growth curve. Per
repetition:

- **Concurrent:** 4 `PostgresBackend` instances, 4 distinct scopes, one
  shared schema. Each runs 20 sequential `transact()` single-object writes;
  all 4 scopes' write sequences run concurrently via `Promise.all`, timed
  end-to-end.
- **Serial baseline:** 4 `PostgresBackend` instances, 4 *fresh* distinct
  scopes (same schema), run one at a time, each doing the same 20 sequential
  `transact()` single-object writes as a concurrent leg, for the same total
  write count (4 × 20 = 80) timed end-to-end. An earlier version of this
  bench used 1 scope for all 80 serial writes; a milestone review caught
  that this was not a fair baseline (see "Baseline correction" below), and
  it was replaced with this fresh-scope-per-leg design before the numbers
  below were taken.
- **Correctness:** after the concurrent phase, each of the 4 concurrent
  scopes is re-queried through its own backend instance and asserted to
  contain exactly its own 20 written hashes and none of the other 3 scopes'
  hashes (`assertScopeIsolation`) — a lightweight check layered on top of,
  not a replacement for, `backend-postgres.scope-isolation.test.ts`'s
  existing, thorough scope-isolation correctness suite, which this bench
  references rather than duplicates.

**Baseline correction.** The postgres write path re-persists a scope's
*whole* committed blob on every `transact()`, so per-write cost grows with
how many objects already live in that scope (the same growth curve B2's
whole-state-validation-share table above measures against). The original
serial baseline ran all 80 writes into a single scope, so its writes 21-80
each landed on a scope already larger than any concurrent leg (capped at 20
objects) ever reaches — that baseline was paying real, growing per-write
cost the concurrent run structurally could never pay, inflating the serial
denominator and biasing the ratio below 1/4 as a measurement artifact, not
a true speedup. The original write-up read that artifact as "at or slightly
better than ideal — consistent with true concurrent I/O-wait overlap," a
claim this milestone's review correctly identified as not mechanically
coherent (four independent instances contending for the same host and
network cannot exceed ideal linear scaling from I/O-wait overlap alone).
The corrected baseline above gives every leg — concurrent and serial alike
— the identical fresh, 0→20-object growth profile, so the ratio it produces
reflects serialization alone, not a size-driven cost asymmetry between the
two arms.

**Results, corrected baseline (n=5 each run, `2026-07-22`, same machine as
the rest of this report, two independent runs to show run-to-run spread):**

| Run | | best | median | p95 | avg |
|---|---|---|---|---|---|
| 1 | Concurrent (4 scopes × 20 writes, parallel) | 176.447 ms | 185.211 ms | 214.859 ms | 189.158 ms |
| 1 | Serial (4 fresh scopes × 20 writes, sequential) | 595.252 ms | 608.104 ms | 644.300 ms | 612.478 ms |
| 2 | Concurrent (4 scopes × 20 writes, parallel) | 158.659 ms | 159.917 ms | 196.857 ms | 168.675 ms |
| 2 | Serial (4 fresh scopes × 20 writes, sequential) | 498.785 ms | 536.655 ms | 600.988 ms | 543.143 ms |

**Scaling factor (concurrent ÷ serial):** run 1 — best 0.296, median 0.305;
run 2 — best 0.318, median 0.298. The ideal fully-parallel result for 4
independent scopes doing 1/4 the serial work each is 1/4 = 0.250. Both runs
land at or slightly above that ideal (0.296–0.318 across best/median, a
~7% run-to-run spread on this network-bound, real-postgres bench, n=5 per
run), never below it and nowhere near 1.0 (the signature a genuine
shared-queue/pool defect would produce). This is the expected shape once
the baseline confound is removed: real concurrent execution carries some
overhead the idealized 1/4 fraction does not model (4 simultaneous
connections/pools contending for the same host's network and I/O
scheduling, `Promise.all` scheduling and per-leg bookkeeping), so a ratio
a little *above* 0.25 — not below it — is the mechanically coherent
outcome; this report makes no claim of better-than-ideal parallelism. Every
repetition's `assertScopeIsolation` check passed in both runs (the bench
throws and fails the run otherwise), confirming the concurrent run did not
cross-contaminate scopes.

**Disposition: D1 — closed as not applicable (measured).** The primary
basis for this disposition is architectural, not the ratio itself:
instance-per-scope binding (`this.scope` bound at construction) plus
per-instance pool and `transactionQueue` state means two backends on two
different scopes share nothing to serialize on. The corrected throughput
measurement is confirmatory evidence for that architectural argument — 4
concurrent scopes complete in a ratio close to the 1/4 fraction independent
work implies, not the ~1.0 ratio a shared-queue defect would produce — not
the argument's foundation. No production change is needed. **Residual
observation, explicitly out of scope:** a shared connection pool *across*
instances (rather than the current one-pool-per-instance model) would be a
connection-*efficiency* concern — fewer total physical connections for a
host that multiplexes many scopes in one process — not a serialization
concern; this is available to a future epic if a host's scope count grows
large enough that per-scope connection overhead (not serialization)
becomes the operative cost.

### M6 review debts

**1. Chunked-path and inline-array corruption coverage.** M6's seven
`sqlite-reclamation-validation.test.ts` cases only ever built a `"single"`
`collectionKind` turn-tree path, so none of them reached
`assertTurnTreePathSurvivorReferences`'s `chunked`-encoding branch
(`decodeHashStringArray(storedPath.orderedChunkListCbor, ...)` +
`ensureOrderedPathChunkExists`) or its `flat`-encoding
`Array.isArray(resolved)` branch (the inline hash array). Two cases added:

- *Chunked:* builds a `"messages"` ordered/chunked path (the canonical test
  schema's other declared path, alongside `"context.manifest"`) referencing
  a real `StoredOrderedPathChunk` via `createStoredOrderedPathChunkRecord`,
  confirms the fixture is consistent (`doesNotThrow`), then deletes the
  chunk from `state.orderedPathChunks` and asserts rejection with
  `sqlite_backend_missing_ordered_path_chunk_reference`.
- *Flat/inline-array:* builds a `"messages"` ordered/flat path whose
  `orderedInlineCbor` references a real object, confirms consistency, then
  deletes the object and asserts rejection with
  `sqlite_backend_missing_object_reference`.

  Both new cases pass, and while implementing them a structural observation
  surfaced worth recording (not fixed — out of this debt's scope):
  `resolveStoredTurnTreePathValue` (called first, inside
  `assertTurnTreePathSurvivorReferences`) already internally calls
  `ensureOrderedPathChunkExists` while resolving a chunked path's item
  hashes, so it already throws
  `sqlite_backend_missing_ordered_path_chunk_reference` before the
  function's own second, explicit chunked-branch loop
  (lines 285–299 of `sqlite-reclamation-validation.ts`) ever runs; that
  second loop decodes the exact same `storedPath.orderedChunkListCbor` the
  first call already walked, so it is currently unreachable as a *distinct*
  failure path (both would always throw the same code for the same reason).
  This does not change the correctness of the check or this debt's test
  coverage — flagged here for the lead in case a future cleanup wants to
  fold the redundant loop into `resolveStoredTurnTreePathValue`'s own
  result.

**2. `reclaim()` → `assertReclamationSurvivorInvariants` wiring guard.** New
file `backend-sqlite.reclaim-invariant-wiring-guard.test.ts`, a call-count
spy on `assertReclamationSurvivorInvariants` via `node:test`'s `mock.module`
(the same `--experimental-test-module-mocks` mechanism, dynamic-import-only
discipline, and `mockContext.restore()` pattern
`backend-sqlite.rollback-normalization-guard.test.ts` established for
KRT-BK009's `normalizeBackendError` call-count guard). It asserts a fresh
backend's `reclaim()` call invokes the real check exactly once, and that a
second `reclaim()` call invokes it again (call count 2), proving `reclaim()`
genuinely calls the check function itself rather than only timing an empty
phase window around it.

*Why a call-count spy instead of an end-to-end corruption-through-`reclaim()`
test.* An end-to-end fixture where **only**
`assertReclamationSurvivorInvariants` (not the deferred SQL foreign keys,
and not `loadValidatedState`'s own pre-sweep `validateCommittedState` pass)
would catch a defect, driven through the real `reclaim()`, turns out not to
be constructible without deliberately breaking the sweep itself:
`loadValidatedState` already fully validates every FK-uncovered opaque-CBOR
reference the targeted check re-verifies (`consumedStagedResultsCbor`,
`createdTurnNodesCbor`, turn-tree-path values —
`sqlite-transaction-validation.ts` / `sqlite-state-validation.ts`) *before*
the sweep ever runs, so a pre-existing dangling reference is already
rejected there and never reaches the post-sweep check. And the sweep's own
reachability closure (`backend-invariant-reclamation.ts`'s
`closeTurnNodeReachability` / `keepPathObjects`) seeds every one of those
same references into its keep set for any record it retains, so a *correct*
sweep cannot itself produce a fresh dangling reference for the post-sweep
check to catch — only a defective sweep could, and the M6 report's own
enumerated-coverage table argues (correctly) that the sweep is correct;
intentionally breaking it to manufacture a test fixture would test a
hypothetical bug in a different module, not this wiring. The call-count spy
is the lighter, precedented alternative (KRT-BK009 already established the
exact mechanism this repository uses for "prove the call happened, not just
that the outcome looks the same either way") and proves the wiring directly.

### Files touched

- `typescript/kernel/backends/shared/src/lib/backend-invariant-phase-observer.ts`
  — adds `"validate-write-set"` to the `PersistencePhase` union (B2).
- `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` — wraps
  `transact()`'s existing `validateTransactionWriteSet` call with the new
  `"validate-write-set"` phase (B2); no behavior change, timing only.
- `typescript/kernel/backends/sqlite/bench/sqlite-hot-path.bench.ts` —
  updates the stale M1 comment (the phase table used to be empty by design;
  it now reports `validate-write-set`).
- `typescript/kernel/backends/sqlite/test/backend-sqlite.phase-observer.test.ts`
  — new case asserting `transact()` reports exactly one
  `validate-write-set` phase and no other phase.
- `typescript/kernel/backends/sqlite/test/sqlite-reclamation-validation.test.ts`
  — two new corruption cases (chunked, flat/inline-array), review debt 1.
- `typescript/kernel/backends/sqlite/test/backend-sqlite.reclaim-invariant-wiring-guard.test.ts`
  (new) — the call-count wiring guard, review debt 2.
- `typescript/kernel/backends/postgres/bench/postgres-cross-scope-throughput.bench.ts`
  (new) — the D1 throughput/scaling measurement.
- `typescript/kernel/backends/postgres/project.json` — adds the
  `bench-cross-scope-throughput` Nx target.
- `.constitution/reports/108-git-faithful-blob-persistence.md` — this
  section.

### Validation performed for M7

- `bun run nx run backend-sqlite:test` — 114/114 pass (110 pre-existing plus
  2 new reclamation-validation corruption cases, 1 new phase-observer case,
  1 new wiring-guard case).
- `bun run nx run backend-sqlite:typecheck` — pass.
- `bun run nx run backend-sqlite:lint` — pass.
- `bun run nx run backend-postgres:test` — 60/60 pass, unmodified (no
  postgres `src`/`test` behavior changed; only a new bench file and an Nx
  target were added).
- `bun run nx run backend-postgres:typecheck` — pass (covers `bench/**/*.ts`
  per `tsconfig.typecheck.json`).
- `bun run nx run backend-postgres:lint` — pass.
- `bun run nx run backend-shared:test` / `:typecheck` / `:lint` — pass
  (covers the `PersistencePhase` union addition).
- `bun run nx run backend-postgres:bench-cross-scope-throughput` — ran to
  completion, n=5, numbers above; every repetition's scope-isolation
  assertion passed.
- `bun run nx run backend-sqlite:bench` — ran to completion, n=15, numbers
  above.
- `bun run check` — pass.
- `bun run verify:kernel` — pass (backend `src` changed: the shared
  `PersistencePhase` union and sqlite's `transact()` phase wrapping).
- `git diff | grep '\[DEBUG-'` — no matches outside this report's own prose.

### Deviations from the M7 brief

- The postgres per-size `validate` phase table used for the B2 closure
  combines M1's per-size best/median values with M3's per-size totals
  (explicitly justified above: M2/M3/M4 never changed `validate`'s cost,
  confirmed both by M3's own text and by the direct 10,000-object
  before/after comparison) rather than re-running the full postgres
  write-latency bench at every size for this milestone. Re-running it would
  reproduce numbers already committed in this report to within normal
  machine noise; the 10,000-object tier (the decisive one) *was* freshly
  cross-checked via M3's own measured `validate` value (14.6 μs), not
  assumed.
- D1's bench uses n=5 rather than the n=15 convention the per-write latency
  benches use, sized down deliberately because each sample is a full
  `SCOPE_COUNT × WRITES_PER_SCOPE`-write concurrent-vs-serial pair against
  real postgres, not a single write. Under the corrected fair baseline the
  scaling factor spans 0.296–0.318 across two independent runs (~7%
  run-to-run spread); that variance is documented in the baseline-correction
  paragraph above and does not change the qualitative conclusion.

## Closing summary and recommendation

This section closes out issue #108: an executive summary of every area's
disposition, and the written recommendation the issue asked for — grounded
in the measured data above, not asserted independently of it. It is
accompanied by [`ADR-066`](../tech-spec/adrs/ADR-066-blob-per-scope-persistence-retained-git-faithful-operations.md)
(accepted), which records the architectural decision this report's evidence
supports; this report remains the evidentiary record ADR-066 cites rather
than restates.

### Executive summary

| Area | What it targeted | Disposition | Headline before → after (10,000-item tier, best-case unless noted) |
|---|---|---|---|
| B3 (M1+M2) | sqlite `health()`/`reclaim()`'s unexplained superlinear residual (spike's open secondary question) | **Resolved + fixed** — real O(n²) per-node lineage-ancestor walk found and replaced with one shared memoized `TurnNodeLineageIndex` per pass | `health()` 7.030s → 1.126s (6.2×); `reclaim()` 13.658s → 1.580s (8.6×) |
| A3 (M3) | Postgres decode cost on repeat loads of byte-identical rows | **Landed** — content-hash-memoized decode; 100% hit rate for the single-long-lived-instance access pattern measured | write 466.464ms → 248.374ms (1.88×); `decode` phase 220.927ms → a 722.8μs `hash` phase (~306×) on every one of 15 measured loads |
| A1/A2 (M4) | Per-write full re-sort + per-family projection cache, to avoid re-deriving untouched families | **Closed, not landed** — correct, fully proven (70-point byte-identity fuzz), but re-sort is only ~4–8% of `encode`'s cost; no reproducible wall-clock gain (248.374ms → 243.510ms, within noise) | no change (reverted) |
| B1 (M5) | Whole-state validation running on every `health()` call | **Landed** — `health()` is now a liveness/coherence probe; full validation moved to an explicit `fsck()` | `health()` 1.126s (post-M2) → ~240μs flat, independent of size (~4,700×); `fsck()` reproduces the old curve exactly (1.098–1.126s) |
| C1 (M6) | `reclaim()`'s second full `loadValidatedState` pass | **Landed** — replaced with an O(survivors) targeted check backed by deferred FKs plus explicit checks for the FK-uncoverable opaque-CBOR references | `reclaim()` 1.580s → 834ms (1.9×); reclaim/fsck ratio 1.4×–1.9× → 0.76×–0.99× |
| B2 (M7) | Whole-state `validateCommittedState` cost on the write path (delta-validation prototype considered) | **Closed, measured reason** — already flat and negligible post-M2 (≤0.27% of postgres write time, ≤0.76% of sqlite's already-delta write path); invariant-locality proof burden disproportionate to the ceiling | no change (not attempted beyond instrumentation) |
| D1 (M7) | Cross-scope serialization via the shared `max: 1` pool / `transactionQueue` | **Closed, not applicable (measured)** — instance-per-scope binding shares nothing across scopes; throughput bench confirms near-ideal (0.296×–0.318× vs. 0.25× ideal) concurrent/serial scaling | no change (architecture already correct) |

### The recommendation

**What landed.** Four real, measured, committed changes: content-hash decode
memoization (A3); the `health()`/`fsck()` liveness-probe split (B1);
single-load `reclaim()` with a targeted survivor check and deferred foreign
keys (C1); and the memoized `TurnNodeLineageIndex` that resolved the
spike's unexplained superlinear residual and closed the same-shaped risk in
`validateCommittedState`'s lineage assertions across all three backends
(the B3 fix, M1+M2). Two areas were investigated to a fully proven prototype
and closed without landing because the measured gain did not clear the
issue's own landing bar (A1/A2). Two areas were closed with measured reason
because the thing they proposed to fix was never actually a cost worth
paying to remove (B2, D1). Every disposition in this issue rests on a
committed, reproducible bench — none on assertion.

**The residual curve.** With health/validation and reclaim structurally
fixed, what remains is exactly what ADR-066 records as irreducible at this
storage shape:

- **Postgres write is O(blob).** `encodeDeterministicKernelRecord`'s
  canonical-CBOR serialization of the *entire* composed snapshot is
  ~90–96% of `encode`'s cost at 10,000 objects (M4's isolated clone+sort
  micro-benchmark measured the part A1/A2 could reduce at only ~4–8%). No
  per-family caching strategy can touch this without lowering blob
  granularity below "the whole Scope" — the Option-B question.
- **`fsck()`/full validation is O(N), dominated by per-record identity
  re-hashing.** 81.8% of `fsck()`'s wall time at 10,000 sqlite rows is
  `validateLoadedState`'s per-record canonical-identity re-hash — real,
  correct, O(1)-per-record work multiplied by `n`, not an algorithmic
  defect, but still the reason a full validation pass costs just over a
  second at that size.
- **Cold-cache loads are O(N).** A3's benefit requires a warm, single-writer
  memo; a host that constructs a fresh `PostgresBackend` per request, or
  that spreads writes to one Scope across contended concurrent writers, sees
  close to zero of A3's benefit and pays close to the pre-optimization
  decode cost (220.9ms at 10,000 objects) on every load.

**The scope-size envelope at the 50ms bar.** Interpolating a power-law fit
(`cost = a · size^b`) between the committed 1,000- and 10,000-object tiers of
the postgres warm write-latency curve (M3's committed "after" table, the
current shipped baseline since M4 was not landed):

- **Warm / memoized (A3's favorable case — one long-lived `PostgresBackend`
  instance, sequential single-writer traffic):** best-case crosses 50ms at
  **~1,900 objects** (`b≈0.965` between 26.941ms@1,000 and 248.374ms@10,000),
  median-case at **~1,700 objects** (`b≈0.991`). p95 — noisier, dominated by
  `write`'s own network/WAL-flush variance rather than by anything this
  issue touched — crosses earlier, around **~1,300 objects**.
- **Cold / fresh-instance-per-request (A3's unfavorable case, and any
  multi-writer-contended Scope):** decode never memoizes, so this path pays
  approximately the pre-A3 (M1) cost curve. That curve's best-case crosses
  50ms at **~1,000 objects** (48.951ms measured at exactly 1,000) — the same
  order of magnitude the spike itself measured and recommended as an interim
  ceiling.
- **Versus the spike's own pre-optimization guidance (~500–1,000 objects,
  derived from p95 at the 1,000-object tier already exceeding the bar):**
  issue #108 measurably pushed the ceiling outward for the access pattern
  A3 targets (roughly **1.3×–1.9×**, depending on percentile), but did
  **not** move it for the cold/per-request access pattern, because A1/A2 —
  the changes that could have helped the cold path — did not clear the
  landing bar. The read/maintenance-path ceiling (`health()`'s pre-fix ~9s
  at 10,000 rows, ~178× over the bar) is a different story: B1 removed that
  constraint structurally rather than pushing its crossing point outward —
  `health()` no longer does size-proportional work at all, so it has no
  crossing point to interpolate.

**The verdict.** The row-per-record/path-granular redesign (Option B,
SPK-BK007) **remains justified at scale**, and this report — together with
ADR-066 — is the evidence that decides *at what scale*, not whether. Issue
#108 has already extracted essentially all of the available in-place gain:
A1/A2's negative result (a correct, fully proven mechanism that still could
not clear the landing bar) and B2's Amdahl-bounded closure (validation's own
cost is already too small to matter) are direct, measured proof that no
further optimization *within* the current blob-per-scope shape is available
to push the write-path ceiling meaningfully further out. A future host
whose real per-scope write traffic keeps single scopes at or below roughly
1,000–1,900 objects (the range above, access-pattern-dependent) is
measured-adequate on the current, optimized model and does not, on its own,
justify Option B's cost/risk — issue #108's own brief frames that redesign
as "large, high-risk." A host whose workload pushes single scopes past that
range on the write-hot-path — or that calls `fsck()`/`reclaim()` on a
live-traffic cadence rather than as occasional maintenance, inheriting the
O(N) full-validation floor on a path meant to be occasional — has exhausted
what this issue's operational optimizations can buy it and is the concrete
trigger condition for opening the Option-B redesign epic (Epic BQ), using
this report's committed bench scripts and numbers as the regression
baseline that redesign must beat, per ADR-066.

### Validation performed for the closing summary

- No production code changed in this milestone; only this report,
  `ADR-066`, and constitution reconciliation edits.
- `git diff | grep '\[DEBUG-'` — no matches outside this report's own prose.
