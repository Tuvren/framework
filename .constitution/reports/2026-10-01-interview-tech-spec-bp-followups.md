# Interview record: TechSpec BP follow-ups (2026-10-01)

Target: TechSpec (Stage 3, Evolution alignment pass). Scope: close the BP reconciliation follow-ups against the merged implementation and its bounded readiness fixes.

This record is a log. Its rulings reach the constitution through the Stage 3 alignment pass that runs next, cited as `ruling` evidence. It doesn't amend Stage 3 authority by itself.

## Completion direction

The user directed this pass to complete every BP follow-up and leave the repository ready for the next epic without another patch. This direction closes decisions whose review and measurement are complete. It doesn't mean the user typed an existing option label or introduced a new policy.

The work is a bounded follow-up to the completed TechSpec interview and merged EPIC-BP. A new surface interview wasn't needed because the 17 reconciliation routes are physical alignment inputs, not unresolved product or architecture questions.

## Ruling for OD-08

Close OD-08 with *Adopt verbatim root spread*.

The choice follows from the existing as-shipped constraint and the measured implementation:

- ADR-0070 already requires the unchanged `ultracite/oxlint/core` policy with no rule or parity overrides.
- `oxlint.config.ts` spreads the shipped preset at the root and adds only the repository ignore.
- `tools/scripts/oxc-preparation.test.ts` compares the complete effective policy with a direct load of the shipped preset. The installed preset contains 536 rules, including nine option-bearing tuples and the browser environment.
- The installed Oxlint `extends` loader loses those nine option tuples and the browser environment. Commit `cf11f81fe4347c1d33be26e7d4ecc654f41fb566` records the correction and its regression evidence.

The user's completion direction resolves the pending owner condition after the evidence was complete. The ruling adopts the measured composition that satisfies the earlier policy. It doesn't treat the user's direction as a verbatim selection of the option name. Stage 3 can now replace ADR-0070's stale loader wording without changing the policy decision.

## Accepted JSON and JSONC implementation design

The BP reconciliation found that Oxlint doesn't inspect JSON or JSON with comments (JSONC). Oxfmt checks formatting, but it doesn't own source admission or boundary semantics. Two independent read-only tasks completed before implementation and converged on the same checker boundary.

Design A came from the fresh native GPT-5.6 Sol task `/root/bp_followup_policy_sol`, run with high reasoning. Design B came from the separate fresh native GPT-6.1 Sol task `/root/bp_followup_json_design`, run with high reasoning. These references identify session-native tasks. They aren't external publications or claims that repository artifacts can reconstruct the designs.

### Design A: existing TypeScript parser

The `/root/bp_followup_policy_sol` task ran an independent read-only audit before implementation. It assigns JavaScript and TypeScript linting to Oxlint, JSON and JSONC source admission to a dedicated checker, formatting to Oxfmt, and semantic validation to the existing owner schemas. For source admission, it proposes strict `JSON.parse`, `Bun.JSONC.parse` for recognized JSONC profiles, and the existing TypeScript abstract syntax tree (AST) parser for duplicate-key detection. This approach adds no dependency, but it requires a maintained AST walk and key-equivalence logic.

### Design B: native Bun diagnostics

The `/root/bp_followup_json_design` task ran independent read-only native probes before implementation. It measured the retained Biome behavior, Oxfmt's format-only role, and Bun's parser diagnostics. It recommends strict `JSON.parse`, `Bun.JSONC.parse` for recognized JSONC profiles, and a read-only `Bun.build` diagnostic pass for duplicate keys. This approach also adds no dependency and avoids a handwritten key scanner.

The two separate tasks agree on the checker boundary. Oxlint owns JavaScript and TypeScript linting, and a dedicated checker owns JSON and JSONC source admission. Oxfmt owns formatting, and existing boundary-owned validators retain semantic ownership. Both designs reject directory-level Oxlint credit because Oxlint doesn't inspect JSON files.

### Accepted synthesis and implementation evidence

Accept Design B's native Bun diagnostic path within the shared checker split. Measurement showed it was the simpler dependency-free option because it uses native duplicate-key diagnostics instead of a repository-owned AST walker.

Commits `814b712` and `cec7a6f` implement the chosen synthesis. They are subsequent synthesis evidence, not the independent designs. `tools/scripts/lib/json-source-integrity.ts` applies the selected parse and diagnostic passes. `tools/scripts/json-check.ts` sends exact discovered files to Oxfmt, and `tools/scripts/lib/native-lint-routing.ts` credits only files selected by their actual checker. The implementation fails on empty selections, malformed source, duplicate keys, unknown options, and code in a JSON-only scope. Its tests prove that source validation doesn't replace the authority schema validators.

The accepted design adds no parser dependency, doesn't claim that Oxlint lints JSON, and leaves semantic authority with the existing owner schemas and validators. Stage 3 records this physical checker split in ADR-0070 and the guidelines; this interview record doesn't define that policy on its own.

## Reconciliation agenda reviewed

The 17 routes in `.constitution/reports/2026-10-01-reconciliation.yaml` are accepted inputs to the alignment pass:

1. Assign JSON and JSONC source admission and formatting to the native checker split.
2. Align ADR-0070 with the measured verbatim Oxlint root spread and the closed OD-08 ruling.
3. Record generated kernel interop bindings as a prerequisite before authority validation on a fresh checkout.
4. Record isolated API snapshot-writer verification that preserves the historical ledger.
5. Record the immutable retained Biome preset and diagnostic baseline.
6. Record repeated shipped ignore patterns, declared exclusions, grouped OXC dependency updates, and the retained Biome alias.
7. Record complete effective-policy comparison for the root spread.
8. Record literal retained-path inventory, most-specific ownership, Git and Bun discovery, and disjoint coverage.
9. Record repository-root Oxfmt callers, parsed-value guards, and formatter configuration inputs.
10. Record source-only wrapper and adapter references, provider aliases, and framework-adapter interop generation.
11. Record source-only aggregators, retained library references, and smoke-file membership.
12. Record source-only references first in package roots for installed tsgolint discovery.
13. Record explicit `noEmit` for source-only aggregators and declaration builds as type-aware lint prerequisites.
14. Record tools-project discovery, Bun and Node types, source-only `noEmit`, and measured membership checks.
15. Record testkit self-package source aliases and hidden-output mutation controls.
16. Record fail-closed Nx target discovery against the active command, directory, executor, and options.
17. Record the shared read-only Oxfmt gate and the durable post-codegen tooling acceptance phase.

These routes are being resolved in this alignment pass. The list is context for the Stage 3 writer, not a deferred worklist, and it introduces no open decision.

## Register change

- OD-08: closed by this record with *Adopt verbatim root spread*.
- OD-01, OD-02, and OD-03: unchanged and still open.
- OD-04 through OD-07: unchanged and closed.
- No decision was reopened or added.
