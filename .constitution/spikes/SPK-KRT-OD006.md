# Spike report: OD-06 Cost of adopting the ultracite oxlint/core and oxfmt presets as shipped

## Effort budget

- **Budget:** 3 story points (decision-owned spike agreed in the 2026-09-29 tech-spec interview).
- **Spent:** 3 story points. Not measured: the `compatibility-report.ts` generator was not re-run end to end with oxfmt swapped in (it drives the full conformance lanes); its outputs were covered only by the JSON round-trip test in the table on generator stability below. `generate-kernel-plans.ts` refuses to run on master for an unrelated reason (it would drop 10 promoted checks), so its formatter swap was also covered only by the round-trip test.

## Question

- **Owner:** OD-06 (register entry in `.constitution/reports/open-decisions.yaml`).
- **Decision this spike must produce:** what adopting `ultracite/oxlint/core` and `ultracite/oxfmt` as shipped, with no parity overrides, costs on this repository in violations, reformat size, generator stability and configuration work, so that the OXC epic (Biome removal) can be sized and split.

## Context and objective

- **Triggering upstream file or section:** `.constitution/reports/open-decisions.yaml` OD-06, which blocks the OXC epic and the ADR superseding the lint and format clause of ADR-0012.
- **Target:** the lint and format toolchain boundary: `biome.jsonc`, the root `lint` and `format` scripts, the per-project Nx `lint` targets, the `artifacts` targets under `spec/*/project.json`, and the four generator scripts that call Biome (`tools/scripts/telemetry-codegen.ts`, `tools/scripts/compatibility-report.ts`, `tools/scripts/conformance/format-generated-json.ts`, `tools/scripts/api-freeze-gate.ts`).
- **Archetype / surface:** repository tooling for the TypeScript line and checked-in JSON authority artifacts. No runtime, protocol or published API behavior changes, except the code edits the lint rules force.

## Codebase baseline

- **State today:** Biome 2.5.14 with `extends: ["ultracite/biome/core"]` (`biome.jsonc`, 7 lines), ultracite 7.4.2, TypeScript 6.0.2 (`bun.lock`). Tracked files: 611 `.ts`, 7 `.mjs`, 643 `.json`, 1 `.jsonc`. There are 144 real `biome-ignore` directives in `.ts` and `.mjs` files. The other 4 of the 148 grep matches are prose in Markdown, a changeset and a completed epic YAML file. `bun run typecheck` is green on master (0 TS errors, measured in the scratch worktree).
- **Measured toolchain:** ultracite 7.12.2, oxlint 1.86.0, oxfmt 0.71.0 and oxlint-tsgolint 7.x (for type-aware runs), all installed with `bun add -d` in a throwaway worktree. Bun 1.3.10 and Node 24.13.0 came from `devenv shell`. None of this is committed.
- **Biome touchpoints to migrate:**
  - 41 `project.json` files reference Biome, including 7 `spec/*` artifacts targets that run `tsp compile ... && biome check --write ./artifacts`.
  - `nx.json` lists `biome.jsonc` as a named input.
  - The root `package.json` `lint` and `format` scripts call Biome.
  - 4 generator scripts call Biome.
  - One SHA-pinned evidence probe also calls Biome: `.constitution/evidence/KRT-BN005/release-contract.mjs`. It is historical and must not be edited.
- **Discovered constraints:**
  - **SHA-pinned files.** `.constitution/evidence/**` contains 7 TS/JS files, all pinned by `sha256` in their `manifest.yaml`:
    - `KRT-BN004/package-coverage.mjs`
    - `KRT-BN004/release-classification-audit.mjs`
    - `KRT-BN004/run-negative-controls.mjs`
    - `KRT-BN005/release-contract.mjs`
    - `KRT-BN005/tooling-contract.mjs`
    - `KRT-BN006/dependabot-contract-probe.mjs`
    - `KRT-BN007/contract-probe.ts`

    It also contains 2 JSON files: `KRT-BN004/native-blocker-summary.json` and `KRT-BN004/published-stable-snapshot-comparison.json`. The `.json.txt` evidence files are not JSON by extension, so they are never touched. `.constitution/reports/` has 4 JSON files and `.constitution/archived/spikes/` has 3.

    With the preset as shipped, oxlint reports 205 diagnostics in the 7 evidence scripts, and `--fix` rewrites them. **Both oxlint and oxfmt must ignore `.constitution/**`.**
  - **Parse error.** `tools/scripts/epic-af-conformance-gap-plan.ts:497` contains `readonly Array<...>`, which is TS grammar error TS1354. tsc never sees it because no typecheck config covers the file. oxfmt refuses to format the file and exits 2 on every whole-repository run until it is fixed. This is a one-line fix and a prerequisite.
  - **Type-aware project discovery.** tsgolint discovers each project through `tsconfig.json` and its references. In this repository, tests, benches and smoke files are covered only by `tsconfig.typecheck.json`, and three conformance-adapter packages have only `tsconfig.tsup.json`. Without changes, a `--type-aware --type-check` run reports 2,423 TS resolution errors in 235 files. After adding a `./tsconfig.typecheck.json` reference to 25 `tsconfig.json` files and creating 3 new ones (certification wrappers), that drops to 354. All 354 remaining errors are in the three conformance-adapter packages, which have no typecheck config.

## Options and trade-offs

The owner has already ruled out softening the preset. Option A is the preset as shipped. Option B, parity overrides, is measured only where it clarifies cost, and it is rejected.

### Configuration and loading (item 1)

| Check | Result |
| --- | --- |
| `oxlint.config.ts` snippet from the docs (`defineConfig` + `extends: [core]` + `ignorePatterns: core.ignorePatterns`) | Works as written. The `ultracite/oxlint/*` and `ultracite/oxfmt` exports exist in 7.12.2. |
| Loads under Bun (`bunx --bun oxlint --print-config`) | Yes: 536 rules resolved (473 `error`, 63 `off`), identical output under Node. |
| Loads under Node 24.13 (`node node_modules/oxlint/bin/oxlint`) | Yes |
| `oxfmt.config.ts` snippet (`defineConfig({ ...ultracite })`) | Works under Bun and Node. |
| `ignorePatterns` inherited through `extends` | **No.** A config with only `extends: [core]` linted a file under `**/generated/`. The explicit `ignorePatterns: core.ignorePatterns` line in the docs is required. |
| Docs discrepancies | See the list after this table. |

Where the docs or help text were wrong or incomplete:

1. `oxlint --help` says JS/TS config files "require running via Node.js". In practice they load under `bunx --bun` (Bun 1.3.10).
2. The preset enables 54 type-aware `typescript/*` rules but does not set `options.typeAware`. Those rules are silently skipped (419 of the 473 enabled rules run) unless you pass `--type-aware` and install `oxlint-tsgolint`, which is an optional peer of oxlint and is not pulled in by ultracite.
3. The oxfmt preset already turns on `sortImports` (`ignoreCase`, `newlinesBetween: true`), `sortPackageJson` and `sortTailwindcss`. None of these appear in the snippet.
4. oxfmt formats every language it supports (including Markdown, YAML and TOML) unless you exclude them. The repository config therefore has to extend `ignorePatterns`.
5. ultracite 7.12.2 brings 17 runtime dependencies (`@clack/prompts`, `commander`, `execa` and others) even when used config-only.
6. Upgrading ultracite also changes `ultracite/biome/core`. With 7.12.2, Biome newly reports `assist/source/useSortedKeys` on `tools/scripts/epic-af-conformance-gap-plan.ts`. Bump ultracite in the same change that removes Biome, not before.

### Lint cost with oxlint/core as shipped (item 2)

Whole repository, `bunx --bun oxlint -f json .`: 619 files linted, 419 active rules. All counts below exclude the 205 diagnostics in `.constitution/evidence`.

| Measure | Count |
| --- | --- |
| Total diagnostics (syntactic rules only) | 15,933 in 555 files |
| By severity | 15,933 `error`, 0 `warning` (the preset sets everything to `error`; `categories` is empty) |
| Test files compared with non-test files | about 4,090 in test files, about 11,840 elsewhere |
| Fixed by `--fix` (safe fixes) | 2,847 diagnostics fixed, 13,086 remain; 428 files changed, +4,926 / −5,600 lines |
| `--fix --fix-suggestions` | 12,937 remain (149 more fixed than safe `--fix`) |
| Typecheck after safe `--fix` | **Fails**: 19 distinct TS errors (TS2554 from `unicorn/no-useless-undefined` removing required `undefined` arguments, and TS2740/TS2339 from a rewrite of `readonly WsResumeStatus[]` to a `Set` in `typescript/streaming/ws/src/lib/ws-messages.ts`). Autofix has to run per project with typecheck, not blind. |
| Type-aware rules (`--type-aware`), tsconfigs unchanged | 49,100 total, of which 32,962 come from 39 type-aware rules. **Inflated**: 8,835 are "error typed value" diagnostics caused by the 2,423 TS resolution errors. |
| Type-aware rules, with the tsconfig reference fix | 7,283 type-aware diagnostics: **1,486 outside the three conformance-adapter packages** (reliable, 43 residual error-typed), plus 5,797 inside the adapters (upper bound, still resolution noise). |
| Type-aware mode with TypeScript 6.0.2 | Works. tsgolint uses its own bundled typescript-go and ignores the repository's TS version. No TS5xxx option errors were reported. |

Top 25 rules, syntactic run:

| Rule | Total | Left after `--fix` |
| --- | --- | --- |
| eslint(no-use-before-define) | 4,750 | 4,750 |
| eslint(func-style) `expression` | 4,010 | 4,010 |
| eslint(sort-keys) | 1,035 | 99 |
| typescript(method-signature-style) | 985 | 985 |
| import(consistent-type-specifier-style) | 709 | 442 |
| unicorn(switch-case-braces) | 703 | 5 |
| eslint(require-await) | 647 | 647 |
| eslint(no-await-in-loop) | 397 | 397 |
| jsdoc(require-throws-type) | 353 | 353 |
| eslint(prefer-destructuring) | 261 | 74 |
| jsdoc(check-tag-names) | 226 | 226 |
| typescript(array-type) | 198 | 2 |
| unicorn(no-useless-undefined) | 189 | 8 |
| unicorn(text-encoding-identifier-case) | 177 | 1 |
| promise(avoid-new) | 108 | 108 |
| unicorn(no-array-sort) | 105 | 105 |
| eslint(require-unicode-regexp) | 80 | 80 |
| unicorn(no-await-expression-member) | 78 | 78 |
| unicorn(consistent-function-scoping) | 67 | 67 |
| unicorn(prefer-type-error) | 63 | 0 |
| eslint(no-inline-comments) | 62 | 62 |
| unicorn(import-style) | 59 | 59 |
| typescript(consistent-type-imports) | 47 | 47 |
| jsdoc(require-yields) | 43 | 43 |
| promise(prefer-await-to-then) | 33 | 33 |

Of the 97 distinct rules that fire, the top 3 are 61% of the volume. Together, `func-style` and `no-use-before-define` are 55%. They also interact: `func-style: expression` turns hoisted function declarations into `const` arrow functions, which makes `no-use-before-define` a real ordering constraint. The 4,750 diagnostics point at 2,180 distinct top-level definitions in 252 files, and **those definitions span 54,023 lines**. Reordering them is the single largest cost in this migration: up to about 108k diff lines if every definition moves, and fewer if callers move instead. Converting the 4,010 declarations in 420 files to expressions adds about 8k changed lines of its own.

Most type-aware diagnostics outside the adapters come from `no-unsafe-*`, `promise-function-async` (436), `unbound-method` (236), `no-confusing-void-expression` (177) and `strict-boolean-expressions` (94).

Where the diagnostics concentrate:

| Area | Syntactic | After `--fix` | `--fix` diff lines | Type-aware (tsconfig fixed) | func-style | no-use-before-define | Lines of definitions to reorder |
| --- | --- | --- | --- | --- | --- | --- | --- |
| typescript/kernel | 3,813 | 3,373 | 2,885 | 431 | 1,130 | 1,081 | 16,131 |
| typescript/runtime | 3,782 | 2,916 | 2,825 | 412 | 835 | 758 | 6,585 |
| tools/scripts | 1,844 | 1,620 | 568 | 216 | 460 | 856 | 11,101 |
| typescript/host | 1,561 | 1,283 | 830 | 93 | 380 | 496 | 4,795 |
| typescript/conformance-adapter | 1,401 | 1,039 | 1,397 | (adapters: 5,797 upper bound) | 366 | 378 | 2,042 |
| typescript/providers | 929 | 781 | 441 | 61 | 229 | 412 | 4,481 |
| typescript/runners | 612 | 512 | 264 | 20 | 127 | 217 | 1,863 |
| typescript/core | 577 | 441 | 402 | 117 | 148 | 126 | 2,001 |
| tools/conformance | 554 | 426 | 337 | 51 | 131 | 221 | 2,832 |
| typescript/streaming | 449 | 367 | 289 | 17 | 97 | 116 | 1,138 |
| typescript/sdk | 213 | 148 | 231 | 46 | 51 | 11 | 126 |
| typescript/tools, testkit, telemetry, certification, tools/run-nx.mjs | 198 | 180 | 57 | 22 | 56 | 78 | 931 |

Mapping the 144 existing `biome-ignore` directives:

| Biome rule | Directives | oxlint equivalent (preset state) | Still suppressing a live diagnostic | Migration |
| --- | --- | --- | --- | --- |
| suspicious/useAwait | 83 (71 file, 12 line) | `require-await` (error; `typescript/require-await` off) | 77 (70 file-level covering 595 diagnostics, 7 line-level) | `/* oxlint-disable require-await -- reason */` and `// oxlint-disable-next-line require-await -- reason`; 6 become dead; 45 `require-await` diagnostics are new |
| performance/noBarrelFile | 45 (39 file, 6 line) | `oxc/no-barrel-file` (error, default threshold) | 0: the rule reports nothing at its default threshold in this repository | delete all 45 |
| assist/source/organizeImports | 5 (file) | oxfmt `sortImports` | 0: oxfmt sorts import statements only and never merges the one-export-per-statement layout ADR-0056 relies on (checked on `typescript/host/session/src/lib/session-frame-shapes.ts`) | delete all 5 |
| complexity/noExcessiveCognitiveComplexity | 6 (1 file, 5 line) | no cognitive-complexity rule; `complexity` (cyclomatic) is on | 2 | `// oxlint-disable-next-line complexity -- reason`; delete 4 |
| suspicious/noBitwiseOperators | 2 | `no-bitwise` (error) | 2 | `oxlint-disable-next-line no-bitwise` |
| correctness/noUndeclaredVariables | 2 | `no-undef` (not in preset) | 0 | delete |
| style/useThrowOnlyError | 1 | `no-throw-literal` / `typescript/only-throw-error` (error) | 1 (2 diagnostics) | `oxlint-disable-next-line no-throw-literal typescript/only-throw-error` |
| **Total** | **144** | | **82 migrate, 62 delete** | |

Verified: oxlint honors `oxlint-disable` and `eslint-disable` prefixes, the `-- reason` suffix, and `--report-unused-disable-directives`, which flags dead directives. oxlint exits 1 when it reports errors.

### Format cost with oxfmt as shipped (item 3)

Config: the preset plus `ignorePatterns` for `.constitution/**`, `**/*.md`, `**/*.{yaml,yml}` and `**/*.toml`. With that config, 1,245 TS and JSON files are in scope.

| Measure | Result |
| --- | --- |
| Files that would change | 463 (432 `.ts`, 31 JSON/JSONC) |
| `.ts` | 432 files, +776 / −152 |
| JSON under `spec/` | **0 files** (374 files already match) |
| Other JSON | 31 files, +165 / −165 (30 of them are `package.json` files reordered by `sortPackageJson`, 1 is `biome.jsonc`) |
| Root `package.json` | also reordered by `sortPackageJson` |
| Cause breakdown | With `sortImports` and `sortPackageJson` disabled, only 18 files differ (+114 / −116). The other 415 TS files change only because of import ordering. oxfmt orders case-insensitively with blank lines between groups, which accounts for 628 of the 776 inserted lines; Biome's organizeImports orders differently. |
| `oxfmt --check` exit code | 0 when clean, 1 when files differ, 2 on a parse error or when every path given is ignored |
| Idempotent (second `--write` gives zero diff, `--check` gives 0) | Yes, under Bun and under Node |
| Should `sortImports` be enabled? | It is already on in the preset. Keep it as shipped: it replaces Biome's `organizeImports`, and the 5 file-level organizeImports ignores become unnecessary. |

### Generator stability (item 4)

| Generator and output | Method | Drift from committed after oxfmt |
| --- | --- | --- |
| TypeSpec artifacts, 7 `spec/*` projects (`core`, `providers`, `runners`, `tools`, `host`, `host/session`, `streaming` and its sub-packets) | ran `tsp compile` (265 files differ raw), then `oxfmt --write` on the artifacts directories | **0 files** |
| `generate-kernel-fixtures.ts` via `format-generated-json.ts` (swapped to oxfmt) | ran the generator | **0 files** |
| `telemetry-codegen.ts` (Biome call swapped to `oxfmt --write <json> <ts>`, Markdown dropped) | ran the generator | **0 files** (exit 0) |
| `api-freeze-gate.ts --update` (swapped to oxfmt) | ran it; the surface is unchanged, so it wrote nothing | not exercised by the run; the round-trip test below found 0 drift for the snapshot |
| Round trip of all 390 JSON files under `spec/**`, `reports/**` and `tools/scripts/__snapshots__/**` re-serialized as `JSON.stringify(v, null, 2)` and then formatted with oxfmt | layout test | 28 files drift (+1,356 / −374), all under `spec/conformance/**` plus `reports/compatibility/compatibility-matrix.schema.json` |
| The same with compact `JSON.stringify(v)` | layout test | 287 files drift |

Conclusion: oxfmt's JSON output depends on the input layout. Like Prettier, it keeps an object expanded if the input had it expanded, while Biome collapses short objects. Every generator measured in practice is stable. For a generator that writes `JSON.stringify(v, null, 2)` into a file Biome later collapsed, the epic has to regenerate that output once through the new pipeline in the reformat commit. Hand-formatting the committed file will not reproduce it. After that, output is deterministic.

Gotcha: the preset ignores `**/generated`, so `typescript/telemetry/semconv/src/lib/generated/tuvren-runtime-telemetry.ts` is neither linted nor formatted. Calling `oxfmt` with only that path exits 2 ("Expected at least one target file"). `telemetry-codegen.ts` works today only because it also passes the JSON path. Keep a matched path in that call, or add `--no-error-on-unmatched-pattern`.

### Paths to exclude (item 5)

- **Pinned by `sha256` manifests:** the 7 evidence scripts and 2 evidence JSON files listed under discovered constraints.
- **Excluded by the owner ruling:** the other constitution JSON (`.constitution/reports/*.json` ×4, `.constitution/archived/spikes/*.json` ×3).
- **Configuration:** use a single `.constitution/**` pattern in both `oxlint.config.ts` and `oxfmt.config.ts`. It is an ignore, not a rule override.

### Option comparison

| | A: presets as shipped (chosen) | B: presets plus parity overrides (rejected) |
| --- | --- | --- |
| Lint diagnostics to clear (syntactic) | 15,933 (13,086 after safe `--fix`) | smaller, but only by disabling `func-style`, `no-use-before-define`, `method-signature-style` and `sort-keys` (10,780 diagnostics) |
| Type-aware diagnostics | 1,486 measured plus the conformance adapters, after tsconfig work | same, unless the type-aware rules are dropped |
| Format diff | 463 files, +941 / −317 | the same format diff |
| Repository-local rule policy | none (`extends` plus the `.constitution/**` ignore) | 4 or more rule overrides to maintain, which is the kind of workaround the owner wants to avoid |

## Recommendation

- **Chosen option:** A. Adopt `ultracite/oxlint/core` and `ultracite/oxfmt` as shipped, with `--type-aware` and `oxlint-tsgolint` enabled. The only repository config beyond the preset is ignores: `core.ignorePatterns`, `.constitution/**`, and the Markdown/YAML/TOML exclusions for oxfmt.
- **Why it fits:**
  - The formatter half is cheap and safe: 463 files and about 1.3k lines, idempotent, and zero drift in every checked-in generator artifact measured.
  - The lint half is large but mechanical and rule-concentrated. The cost is known, the strictness is what the owner asked for, and no local rule policy has to be kept aligned with a moving preset.
- **Epic sizing conclusion:** the reformat plus lint fixes far exceed about 10k changed lines. The safe `--fix` alone is 10.5k, the `func-style` and `no-use-before-define` reordering is tens of thousands, and the type-aware rules add about 1.5k to 7k diagnostics. Split the epic. Suggested milestones:
  1. **Toolchain and format (one mechanical commit, about 1.3k lines):**
     - Add ultracite, oxlint, oxfmt and oxlint-tsgolint as devDependencies.
     - Add both config files and the `.constitution/**` ignore.
     - Fix the TS1354 parse error.
     - Swap the formatter call in the 4 generator scripts and the 7 `spec/*` artifacts targets.
     - Regenerate generator outputs through oxfmt.
     - Apply `oxfmt --write`.
     - Keep Biome **lint** as the gate for now.
  2. **Type-aware prerequisite:**
     - Add a `./tsconfig.typecheck.json` reference to 25 `tsconfig.json` files and create 3 new ones.
     - Give the three conformance-adapter packages a typecheck tsconfig.
     - Re-measure their real type-aware count.
  3. **Lint by directory.** Each project's Nx `lint` target switches from Biome to `oxlint` once its directory is clean. This ratchet needs no rule overrides. Directories in order of size:
     - `typescript/kernel`: about 3.8k diagnostics, 16k lines of definitions to reorder.
     - `typescript/runtime`: about 3.8k, 6.6k lines to reorder.
     - `tools/scripts` plus `tools/conformance`: about 2.4k, 13.9k lines to reorder.
     - `typescript/host`: about 1.6k.
     - `typescript/conformance-adapter` plus the kernel and providers adapters: about 1.4k, plus adapter type-aware diagnostics.
     - `typescript/providers` plus `runners`: about 1.5k.
     - `typescript/core`, `sdk`, `streaming`, `tools`, `testkit`, `telemetry` and `certification`: about 1.4k.

     Inside each directory, run safe `--fix` and then typecheck, because the fix breaks typecheck in 19 places. Next, migrate the 82 surviving ignores to `oxlint-disable` and delete the 62 dead ones. Then do the `func-style` / `no-use-before-define` reorder, and finish with the type-aware rules.
  4. **Biome removal:** delete `biome.jsonc` and `@biomejs/biome`, update the `nx.json` input and the root `lint`/`format` scripts, and turn on `--report-unused-disable-directives` in the gate.
- **Evidence that would change this recommendation:**
  - Evidence that `func-style: expression` combined with `no-use-before-define` forces reordering that changes module initialization behavior, for example a runtime or conformance regression after a pilot directory. That would justify raising the pair with ultracite upstream rather than overriding it locally.
  - After the tsconfig prerequisite, the conformance adapters still carrying several thousand real type-aware diagnostics.
  - An oxfmt release that changes JSON layout for `spec/**` artifacts (it is still beta), which would reopen generator stability.
- **Rejected options:**
  - B (parity overrides): cuts the count by switching off the 4 rules that cause 68% of the diagnostics. That is exactly the workaround the owner ruled out.
  - Adopting the formatter without the linter: leaves Biome in place for lint, so there would be two toolchains indefinitely.
  - Running without `--type-aware`: silently drops 54 of the preset's enabled rules, which is not "as shipped" in effect.

## Downstream impact

- **ADRs to write or update:** the ADR superseding the lint and format clause of ADR-0012. It should record: oxlint and oxfmt run natively, ultracite is used config-only, the presets are adopted unchanged, type-aware linting is on, the `.constitution/**` and Markdown/YAML/TOML ignores apply, and generators must format through oxfmt.
- **Tickets unblocked:** none (decision-owned spike). This unblocks planning of the OXC epic.
- **Register entry closed:** OD-06. Chosen option: "Adopt the ultracite oxlint/core and oxfmt presets as shipped".
- **Tickets to add or split:** split the OXC epic into the four milestone groups above, with lint milestone 3 further split by the listed directories. Add tickets for the type-aware tsconfig prerequisite and the TS1354 parse error. Add a ticket to extend `generate-kernel-plans.ts`, which refuses to regenerate on master, so its output can be re-emitted through oxfmt.
- **Spec edits required:** Stage 3. Update `.constitution/tech-spec/` for the tooling pins (oxlint, oxfmt, oxlint-tsgolint and ultracite ^7.12.2, replacing Biome) and for any `guidelines.md` verification commands that name Biome. The spike itself makes no spec edits.
