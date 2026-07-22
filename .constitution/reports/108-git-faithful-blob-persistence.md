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
