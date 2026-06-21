# Iteration-speed benchmarks

Grounding numbers for the inner-loop / `verify` performance work on branch
`perf/faster-inner-loop-and-verify`. Measurements are single-run on a local
dev machine with a warm Cargo target dir and warm `bun`/Nx caches; they are
directional and reproducible with the commands shown. A cold CI builder
**amplifies** the Rust and typecheck deltas (it has to compile from scratch),
so treat these as conservative lower bounds for CI.

## W1 — Per-boundary cache input scoping (kills cross-boundary poisoning)

The old `codegen`/`conformance` `targetDefaults` pulled in workspace-wide globs
(`boundaries/*/conformance/**`, …). Because a project-level `inputs` array
*replaces* the targetDefault (Nx does not merge), every conformance runner fell
through to that broad default — so editing one boundary's fixture invalidated
every other boundary's conformance cache.

**Method.** Warm the `providers-typescript-conformance-runner:conformance`
cache (no DB, no build deps), then edit an *unrelated* kernel fixture
(`boundaries/kernel/conformance/plans/kernel-protocol-core.json`) and re-run the
providers target. Old config = `nx.json` + providers `project.json` from
`master`; new config = this branch.

| Scenario | old (master) | new (branch) |
|---|---|---|
| warm re-run, no edit | CACHE HIT ~478 ms | CACHE HIT ~471 ms |
| **edit unrelated kernel fixture → providers** | **RAN (miss) 4659 ms** | **CACHE HIT 865 ms** |
| edit providers' *own* fixture → providers (control) | RAN 4678 ms | RAN 4678 ms |

So a foreign-boundary fixture edit went from a **~4.7 s wasted re-run to a
~0.9 s cache hit per non-owning runner**, and the new scoping still correctly
invalidates on an own-boundary edit (no false cache hits). `bun run conformance`
drives 8 runners across kernel/framework/providers; a single-boundary fixture
edit previously invalidated **all 8**, now only the owning boundary's runners.

## W2 — Affected inner-loop lane (`bun run check`)

**Method.** Append a line to `boundaries/providers/implementations/typescript/
mcp-client/src/index.ts`, then compare `nx affected` selection and cold
wall-clock against the full typecheck lane.

- Projects selected by the 1-file edit: **6 of 28** typecheck-capable projects
  (`providers-mcp-client` + its dependents `providers-bridge-ai-sdk`,
  `providers-typescript-conformance-runner`, `framework-runtime-core`,
  `framework-runtime`, `host-repl`).
- Cold wall-clock:

| Lane | wall-clock |
|---|---|
| `nx affected -t typecheck --base=HEAD` (1-file edit) | **21.3 s** |
| `nx run-many -t typecheck --parallel=4` (full) | **49.5 s** |

→ **~2.3× faster (57% less)** for a single-boundary change, before counting the
Nx cache on warm re-runs.

## W3 — Phased `verify` with intra-phase parallelism

**Method.** Run the real phase 1 (`DEFAULT_VERIFICATION_PHASES[0]`, 11 static
analysis + authority/conformance validators) through `runVerificationPhases`,
parallel vs `VERIFY_SERIAL=1`.

| Mode | wall-clock |
|---|---|
| serial (`VERIFY_SERIAL=1`) | **6063 ms** |
| parallel (default) | **4035 ms** |

→ **~33% less (1.5×)** for phase 1, bounded by the longest single step
(whole-repo `biome` lint). The other serial phases are unchanged.

## W3 — Rust dedup in `verify`

Old `verify` ran `cargo clippy --workspace --all-targets` + `cargo test
--workspace` and **then** `nx run-many build/test` over a subset of the same
crates. The latter are redundant.

**Method.** After `cargo test --workspace` (4239 ms, the kept step) warmed the
workspace, time the removed steps:

| Removed step | wall-clock (warm) |
|---|---|
| `nx run-many -t build -p <4 rust crates> --parallel=1` | 1195 ms |
| `nx run-many -t test -p <3 rust crates> --parallel=1` | 3394 ms |
| **total redundant work removed** | **~4.6 s (warm)** |

These crates were already compiled and tested by `cargo test --workspace`; on a
cold CI builder the redundancy is far larger (a second compile across dev + test
profiles from scratch).

## What is *not* benchmarked here

A full end-to-end `bun run verify` A/B (which needs `devenv up` + PostgreSQL and
runs ~10 min/side) was not run; the verify-specific wins are the sum of the
phase-1 parallelism and the Rust dedup above, plus W1 cache hits on the
conformance phase across repeated runs.
