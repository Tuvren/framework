This is a PR151 round-one review overlay on exact base `89fbfdb8d9e4944f332ee22fb597c6b822d32aeb`. Original M10 measures historical `d04b04d172007604c930aa38ccde7acee1145fa6`; its archive, index, and 52 source fingerprints remain unchanged. Two explicitly approved paths have different current hashes. The other 50 fingerprints match. All 16 production TypeScript files and 277 callable signatures/bodies match after comment removal.

Run from the candidate repository root with its dependencies and pinned Git history available. Set `REPORT_ROOT` to this extracted overlay, `REPLAY_OUT` to a fresh external directory, `TUVREN_ENV_ROOT` to the checkout supplying direnv, and `TUVREN_VERIFY_LOCK` to the shared runtime lock. Repository services must already be running.

```zsh
mkdir -p "$REPLAY_OUT"
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" zsh -c '
  bun "$1/source-proof.mjs" "$2/source-proof.json" &&
  bun "$1/admission-proof.mjs" "$2/admission" &&
  bun "$1/program.mjs" "$2/program.json" &&
  NX_DAEMON=false bun "$1/hash.mjs" "$2/hash.json" &&
  bun "$1/replay.mjs" "$1" "$2" &&
  bun "$1/test-proof.mjs" "$2/test-proof"
' -- "$REPORT_ROOT" "$REPLAY_OUT"
```

The replay scripts locate captured baselines relative to their own extracted directory. They don't require the original worker `/tmp` directory or a current-HEAD source baseline. Baselines contain exact historical source text, the original M10 fingerprints/index/manifest, and the original program inventory. Source replay checks both actual pinned Git commits against those captured bytes before comparing the current approved deltas. Raw historical generated test paths in logs are provenance, not replay inputs; the test probe regenerates its isolated mutants using the replay checkout.

The strengthened test observes a real `queueMicrotask` checkpoint while `delay(0)` remains pending, then awaits actual completion. Both a direct resolved Promise and an async resolved-Promise mutant fail at the pending assertion. Ten positive runs pass. This adds no wall-clock threshold, fake clock, padding await, Promise-identity guarantee, or microtask-count guarantee. The resolver uses the existing repository `Promise.withResolvers<null>()` signal pattern, verified against the installed Bun1.4.2/TypeScript6.0.2 and unchanged shipped type-aware Oxlint1.86.0 preset. Primary API references: [Bun queueMicrotask](https://bun.sh/reference/globals/queueMicrotask), [ECMAScript Promise.withResolvers](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.withresolvers), and [Node promise timers](https://nodejs.org/api/timers.html#timerspromisessettimeoutdelay-value-options).

Read `summary.json` for the 19 current successful gates. `final/results.json` honestly preserves an initial external wrapper failure after 14 actual commands exited zero: its parser expected nonexistent Oxlint JSON counters. `remaining/results.json` passes after checking the measured complete `diagnostics` array instead. Broad gates were not repeated because their source stayed frozen. `failure-provenance.json` also preserves the setup and two initial candidate lint failures. `final/tree-before.json`, `final/tree-after.json`, and both `remaining` snapshots match across all 2318 tracked/index/new files.

The admission and replay patches document the exact external adaptation of the original M10 probes. Global raw owners, effective policy, inventories, canonical commands, JSON integrity, inherited inputs, and atomic suppression checks retain their original assertions. The old whole-region byte-identity claim is explicitly false for the sanctioned review delta. Complete source inventory, exact hash deltas, unchanged production AST, and current negative/positive test proofs replace that stale claim. No source or policy exclusion was added.

For independent complete gate replay, freeze the entire working tree and run this wrapper. It acquires one shared lock and retains it through every conformance/broad fetch cleanup. Never nest the lock or start/stop services from these probes.

```zsh
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" bun "$REPORT_ROOT/gates.mjs" "$REPLAY_OUT/gates"
```

`gates.mjs` repeats the 19 current checks and preserves both check and fetch exit codes. A full serial repository `verify` was not repeated for this comment/test-only overlay; the prior complete serial M10 verification remains historical evidence. Exact-head CI and review remain the epic lead's responsibility. This archive records the worker's uncommitted candidate; the epic lead subsequently commits the verified comment/test changes and assembled evidence. The worker made no `.constitution/` edits.
