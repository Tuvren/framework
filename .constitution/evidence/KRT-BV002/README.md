# KRT-BV002 suppression evidence

This evidence records the two live Biome `noBitwiseOperators` directives in
`tools/scripts/api-freeze-gate.ts` at measurement commit
`99457fbb4fd517f1f867ae9267920bed59d887d5`.

The original source and a byte-identical fixture pass Biome 2.5.14. Replacing
only the directive syntax with the measured Oxlint counterpart makes retained
Biome fail with exactly two `lint/suspicious/noBitwiseOperators` diagnostics.
Oxlint 1.86.0 independently emits exactly two `eslint(no-bitwise)` diagnostics
on the same flag-membership operations in both syntactic and type-aware modes.
The installed `node_modules/oxlint/configuration_schema.json` identifies the
default options as `allow: []` and `int32Hint: false`; its measured SHA-256 is
`e15361eff2cefcc8afac585351981315bd0275a04b19e930f35b575a1faea1e0`.

`suppressions.json` is the CB handoff ledger. `reports.tar.gz` preserves every
raw report and fixture. `raw-reports-index.json` records the digest and byte
count of every archived output other than the index itself. The archived
`commands.json` is a historical transcript and therefore retains the original
checkout and `/tmp` paths.

Run the host-neutral probe from the repository root with the locked repository
toolchain:

```sh
devenv -q shell -- bun .constitution/evidence/KRT-BV002/probe.ts "$PWD" "${TMPDIR:-/tmp}/krt-bv002-rerun"
```

The probe passes only when the directive inventory, reasons, retained-checker
behavior, native diagnostics, source/config digests, required verification
commands, and clean-worktree assertions all match. It reads the historical
baseline from commit `99457fbb4fd517f1f867ae9267920bed59d887d5` and requires
the checked-out commit to descend from that baseline.
