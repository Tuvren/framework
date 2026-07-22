# Issue #108 — Make the blob-per-scope persistence path Git-faithful

> **Status:** in-progress evidence/completion report for GitHub issue #108.
> **Origin:** [`SPK-BK007`](../spikes/SPK-BK007.md) · audit finding `[C-01]`
> (`audit-2026-07-04-170703-post-epic-87-baseline.md`) · `.constitution/tech-spec/changelog.md`
> v0.32.0 (persistence-model decision deferred as evidence-gated).
>
> This report accumulates evidence milestone by milestone. It currently
> contains the **M1 — Phase-attributed baseline** section only; later
> milestones (A/B/C/D optimizations and the closing recommendation) append
> further sections without rewriting this one.

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
  land.
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
  `backend-sqlite.record-validation.test.ts` (12 cases: invalid run status,
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
