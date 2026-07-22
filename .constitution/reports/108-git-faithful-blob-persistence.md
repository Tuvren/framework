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
