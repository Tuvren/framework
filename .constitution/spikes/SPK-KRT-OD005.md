# Spike report: OD-05 TypeScript workspace resolution inside Bazel actions

## Effort budget

- **Budget:** 3 story points (decision-owned spike, agreed in the 2026-09-29 tech-spec interview).
- **Spent:** 3 story points. Nothing in the method was cut. Two items were not measured, and are marked "unverified" below: option A under Bazel's `linux-sandbox` strategy, because it is not registered on the NixOS dev host, and a `bun install` inside the repository rule with the network disabled.

## Question

- **Owner:** OD-05 (`.constitution/reports/open-decisions.yaml`)
- **Decision this spike must produce:** How should TypeScript build (tsup + dts), typecheck, and `bun test` actions resolve workspace `@tuvren/*` packages and third-party `node_modules` inside Bazel, while keeping the local action cache sound? The owner's rulings still apply: Bazel is the only graph, cache, and affected layer. Native tools do the work. No rules_js. Local cache only. No Nx at the end.

## Context and objective

- **Triggering upstream file or section:** OD-05 in `.constitution/reports/open-decisions.yaml`, which blocks the Bazel epic (Nx removal) and the ADR that supersedes `.constitution/tech-spec/adrs/ADR-0013-workspace-orchestration-uses-devenv-and-nx.md` and the Nx clause of `ADR-0017-native-toolchains-remain-authoritative-inside-each-impl.md`.
- **Target:** Whether the Bazel action cache stays sound for TypeScript actions. Sound means a cache hit is never served when the real result would differ, and the right set of actions reruns when something changes. Measured on the real edge `typescript/core -> typescript/kernel/protocol -> typescript/kernel/runtime`. `@tuvren/kernel-runtime` depends on `@tuvren/kernel-protocol`, and both have `@tuvren/core` as a peer dependency, whose `dist` the dts step of both packages needs. So the minimal honest slice is 3 packages and 7 actions: core build, then build, typecheck, and test for protocol and for runtime.
- **Archetype / surface:** Developer tooling and build graph for the TypeScript implementation line. No product API surface changes.

## Codebase baseline

- **State today:**
  - Every `typescript/**/BUILD.bazel` is a `native_binary` shim that calls `tools/bazel/nx-run.sh` (`bun run nx run <target>`, which only works under `bazel run`). Nx `build` runs `bunx --bun tsup` and then `bunx --bun tsc -p tsconfig.dts.json`. `typecheck` runs `tools/scripts/typecheck-project.ts` (`tsc --noEmit` on `tsconfig.typecheck.json`, or on `tsconfig.lib.json` when there is none). `test` runs `bun test`.
  - Bun uses the isolated linker. The root `node_modules/.bun` store held 622 package entries (1241 packages installed), and there are 27 per-package `node_modules` directories. Workspace entries are relative symlinks into the source tree. Example: `typescript/kernel/runtime/node_modules/@tuvren/kernel-protocol -> ../../../protocol`. Their `package.json` `exports` point at `./dist/*`.
  - **Measured: typecheck and `bun test` never read `dist` today.** In a fresh worktree with no `dist` anywhere, runtime `bun test` ran 56 tests with 0 failures, protocol `bun test` ran 86 with 0 failures, and runtime typecheck exited 0. Both resolve `@tuvren/*` to source through the `paths` in `tsconfig.base.json`, which every package `tsconfig.json` or `tsconfig.typecheck.json` extends.
  - **Measured: tsup never reads upstream `dist`.** The runtime bundle keeps `from "@tuvren/core"` and `from "@tuvren/kernel-protocol"` as external imports.
  - **Only the dts step reads upstream `dist`.** Runtime's `tsconfig.dts.json` maps `@tuvren/kernel-protocol` to `../protocol/dist/index.d.ts` and resolves `@tuvren/core` through the `node_modules` symlink to `core/dist`. Without upstream `dist`, dts fails with TS2307 and TS7006.
- **Discovered constraints:**
  - Some test inputs appear in no manifest. `runtime-kernel-storage.chunk-constant-agreement.test.ts` reads `backends/postgres/src/lib/postgres-backend.ts` and `backends/sqlite/src/lib/sqlite-backend.ts` at runtime. `tsconfig.typecheck.json` pulls in `../backends/memory/src/**`. Protocol tests read `spec/kernel/cddl/kernel-records.cddl`. None of these are `package.json` dependencies, so any Bazel graph derived only from `package.json` misses them.
  - On this NixOS host Bazel 9.1.1 does not register `linux-sandbox`. Its support probe execs `/bin/true`, which does not exist on Nix. The `linux-sandbox` binary itself works: `-- /bin/sh -c 'echo inside'` exits 0. So on the dev host every "sandboxed" action runs under `processwrapper-sandbox`, a symlink forest with no filesystem isolation. CI on ubuntu would get `linux-sandbox`.
  - `.bazelrc` sets `--action_env=PATH` and `--test_env=PATH`. The devenv PATH has 12 entries outside `/nix/store` (for example `~/.cargo/bin`, `~/.local/bin`, `/run/current-system/sw/bin`, and a worktree-specific `.devenv/state/go/bin`).
  - The devenv Bun is 1.3.10 (`packageManager` pins `bun@1.3.11`). Its `bun install --help` has `--frozen-lockfile`, `--cache-dir`, `--no-cache`, `--linker`, and `--backend`, but no `--offline` and no `--prefer-offline`. Those two flags shipped in [Bun v1.4.1](https://bun.com/blog/bun-v1.4.1) ([bun install docs](https://bun.com/docs/pm/cli/install)). `--offline` never touches the network and fails on an uncached package. `--prefer-offline` uses cached metadata regardless of age.

## Options and trade-offs

### Method

Scratch rules lived in a throwaway worktree and were discarded afterwards. They consisted of one Starlark rule set with a `mode` attribute and three rules (`spk_ts_build` produces a tree artifact containing `package.json` and `dist/`; `spk_ts_typecheck` produces a stamp file; `spk_ts_test` is a test rule), a `spk_ts_package` macro, one shared runner script, and, for option A, a repository rule. Counts come from `--execution_log_json_file`: every logged spawn is an executed spawn, and local action-cache hits log none. Each test contributes 2 spawns (the test and its XML post-processing), so "7 of 7" means 5 build or typecheck actions plus 2 tests.

- **Option A (as built):**
  - A repository rule reads the workspaces from the root `package.json`, copies `bun.lock` and every workspace `package.json` (all watched), and runs `bun install --frozen-lockfile`. Its only exported file is a `stamp` containing the Bun version, the package list, and the full `bun.lock`.
  - Each action declares `bun.lock` and the stamp, then builds a private staged workspace inside its sandbox directory:
    - `cp -L` of its declared sources.
    - `cp -rL` of each upstream bazel-bin package tree into that package's source-relative path, so upstream directories contain only `package.json` and `dist`.
    - A root `node_modules` symlink to the external repo.
    - `cp -a` of the per-package `node_modules` symlink directories from the external repo. They are relative, so `@tuvren/*` links land on the staged copies.
  - Copying, rather than using Bazel's input symlinks, is required. Bun and tsc realpath files, so symlinked inputs would resolve upward into the real workspace's `node_modules` and `dist`.
- **Option B (as built):** Actions are tagged `no-sandbox` and declare `bun.lock` and the upstream bazel-bin tree (the "dist stamp"). They `cd` into the real package directory, run the tools in-tree against the developer's `node_modules` and in-tree `dist`, and copy `package.json` and `dist` into the declared tree.
- **Option C (probed directly, not as a full lane):** Typecheck and test already work this way today. For the build, runtime dts was pointed at `../protocol/src` and `../../core/src`.

### Measurements

| # | Check | A: staged, sandboxed | B: in-tree, `no-sandbox` |
|---|---|---|---|
| 1 | Cold build, typecheck, and test | Yes. 9 spawns, all `processwrapper-sandbox`. The first attempt failed 3 runtime tests with ENOENT on the undeclared postgres and sqlite sources; they passed once those 2 files were declared. | Yes. 8 spawns, all `local`. |
| 2 | Identical rerun | 7 of 7 actions cached, 0 spawns. | 7 of 7 actions cached, 0 spawns. |
| 3a | New export added to `protocol/src/index.ts` | 6 of 7 reran: protocol build, typecheck, and test, and runtime build, typecheck, and test. Core build stayed cached. | Same 6 of 7. |
| 3b | Comment-only change in the same file | 5 of 7 reran. Runtime build stayed cached because protocol's output tree was byte-identical (early cutoff). | Same mechanism: B's declared tree is also content-hashed. |
| 4a | Delete in-tree `protocol/dist/index.d.ts` | Unaffected: A never reads in-tree `dist`. With every action key busted, the in-tree `dist` tampered, and the worktree's root `node_modules` moved away: 7 of 7 re-executed and all passed. | **Unsound.** 0 of 7 reran and the cache reported green over a broken tree. After a runtime source change, runtime build failed (TS7016 against the in-tree `dist`) while protocol build stayed cached, so Bazel never regenerates the missing file. The state is stuck until someone busts the cache or rebuilds by hand. |
| 4b | Forgotten test input: postgres chunk threshold changed from 32 to 64 in an undeclared file | Fails loudly: 3 tests fail with ENOENT because the file is not staged, instead of a wrong pass. | **Unsound.** 0 of 7 reran and the cache served PASS. With `--nocache_test_results` the real result is FAIL (1 runtime test target, 1 cross-module agreement case). |
| 4c | Worktree root `node_modules` removed, all keys busted | Unaffected (see 4a). | Build actions still succeeded: `bunx` found `tsup` and `tsc` by walking up past the workspace root into the parent checkout's `node_modules/.bin`. Both test targets failed. |
| 4d | A package (`cbor-x`) hidden inside the external repo's `node_modules` | **Residual hole.** 0 of 7 reran and the cache served PASS. The real result is 2 of 2 test targets failing. A trusts the repository-rule contents; only the stamp is declared. | Not applicable (B has no external repo). The same class of hole covers the in-tree `node_modules`. |
| 4e | Whitespace-only edit to `bun.lock` | 7 of 7 reran (the repository rule re-ran and the stamp changed). | 7 of 7 reran. |
| 5 | Sandbox | Runs sandboxed. On this host that is `processwrapper-sandbox`, where isolation comes from staging, not the sandbox. Under `linux-sandbox` (CI): unverified. Absolute-path reads of the output base stay allowed by default. | Needs `no-sandbox`. A direct `linux-sandbox` probe blocked the in-tree `dist` write and still allowed in-tree `node_modules` reads, so on CI a sandboxed B build breaks. On this host `processwrapper-sandbox` would not stop it. |
| 6a | `--incompatible_strict_action_env` with the repo's `--action_env=PATH` still set | 0 of 7 reran: no effect, because the explicit PATH wins. | Same. |
| 6b | Strict env with the default PATH (`/bin:/usr/bin:/usr/local/bin`) | 7 of 7 failed. Build actions failed with `execvp(bash)` not found, tests with exit 127 in `generate-xml.sh`. | Same. |
| 6c | PATH passthrough with one extra harmless PATH entry, then back | 7 of 7 reran, then 7 of 7 reran again. The cache thrashes whenever a different shell invokes Bazel. | Same. |
| 7 | How `@tuvren/*` resolves | tsc `--listFiles` for runtime dts showed `_od05_stage/typescript/core/dist/index.d.ts` and `_od05_stage/typescript/kernel/protocol/dist/index.d.ts`, the staged copies of the bazel-bin trees. Test and typecheck actions staged 0 upstream trees and resolved `@tuvren/*` to declared upstream sources through tsconfig paths. Staging cost per action: 43 to 126 files plus 1 to 4 per-package `node_modules` symlink directories. | Resolves through in-tree symlinks to the real source directories and their in-tree `dist`, which is undeclared. |
| 8 | Complexity (non-comment lines) | 82 lines of Starlark rules and macro, shared with B, plus 33 lines of repository rule, plus 66 lines of runner (about 55 of them for A staging and the shared tool calls). Each package needs one macro call (11 to 13 lines here). | The same rule file without the repository rule; about 10 lines of the runner. |

- **Option C, pure path-to-source with no `dist` between packages:** Not viable for the build. Runtime dts with `@tuvren/*` mapped to upstream `src` produced 14 TS6059 errors (upstream files outside `rootDir`), and it wrote 14 stray `.d.ts` files into `core/src` and `protocol/src`, polluting the upstream source trees. C is already what typecheck and tests do, and tsup does not need `dist`, so C's valid part is the typecheck and test half of the recommendation below.
- **Variant D, noted for later:** per-package dts through `isolatedDeclarations`, which could remove the dts edge on upstream `dist` entirely. `tsc --isolatedDeclarations` reported 8 TS9xxx errors in `core`, 0 in `protocol`, and 0 in `runtime`. The approach is close but not ready, and the other packages were not surveyed.

### Scaling to the 30 workspace packages

The root `package.json` workspace globs match 30 package manifests in the tree, excluding the root package. `git ls-files 'typescript/**/package.json'` also lists 30 manifests.

- **A:** The macro scales, but hand-written `deps` would duplicate `package.json`. The repository rule already reads every workspace `package.json`, so it can also emit a generated `.bzl` that lists `@tuvren/*` dependencies per package. That leaves each BUILD file at about 3 lines, with only the non-manifest test and typecheck inputs (like the backend sources and the `spec/` fixtures above) declared by hand. A's loud ENOENT failures surface every such omission.
- **Staging cost** grows with transitive source size for typecheck and test actions (the largest here was 126 files), not with the 23,993-file install. The install is linked, never copied.
- **B:** Scales with fewer lines, but each extra package adds more undeclared in-tree state of the kind shown in 4a, 4b, and 4c.

### Modelling `node_modules` production

The repository-rule approach works:

- `rctx.watch` or `read(watch="yes")` on `bun.lock` and each workspace `package.json` re-runs the rule on change.
- `environ = ["PATH", "HOME"]` gives Bun its global cache.
- With a warm `~/.bun/install/cache`, the install finished inside the repository fetch. It is unverified whether it touched the network.

A tree-artifact action that ran `bun install` instead would close hole 4d, but Bazel would hash about 23,993 files and 2,044 symlinks on every install change and track them as action outputs. That is not worth it for a local-only cache.

For offline and reproducible fetches, upgrade to Bun 1.4.1 or later and pass `--offline` when the cache has been pre-warmed (CI cache restore), or `--prefer-offline` otherwise. On the current Bun 1.3.10 neither flag exists.

## Recommendation

- **Chosen option:** Option A, in a hybrid form ("A + C-for-checks").
  1. A repository rule runs `bun install --frozen-lockfile` over `bun.lock` and the workspace manifests, and exports a content stamp (Bun version, package list, `bun.lock`) as the only declared input from the install.
  2. Every TypeScript action runs sandboxed in a staged private workspace. Declared files are copied, not symlinked. The external `node_modules` store is linked. The per-package `node_modules` symlink directories are copied.
  3. Build actions (tsup, then dts) consume upstream packages only as bazel-bin trees containing `package.json` and `dist`. This is the only `dist` edge between packages.
  4. Typecheck and test actions consume upstream sources through the existing tsconfig `paths`, as they already do today, with no `dist` edge.
  5. Tools run from explicit `node_modules/.bin/<tool>` paths inside the staged workspace, never through `bunx` fallback resolution.
  6. `PATH` is pinned to one generated value from the devenv environment (for example a devenv-written `user.bazelrc` with `--action_env=PATH=<devenv profile bin>` and the matching `--test_env`) instead of raw passthrough.
  7. The repository rule emits the `@tuvren/*` dependency graph as a generated `.bzl`, so BUILD files stay small.
- **Why it fits:**
  - A is the only option whose cache stayed sound under every adversarial in-workspace probe: stale `dist` (4a), a forgotten input (4b), and a missing or ancestor `node_modules` (4c).
  - Its failures are loud, never wrong-green, and its invalidation and early cutoff were exact (3a, 3b, 4e).
  - It keeps native tools and `bun test` doing the work inside actions, meets the no-rules_js ruling, and does not depend on `linux-sandbox` being present, which it is not on the dev host.
  - Splitting the `dist` edge (build only) from the source edge (checks) matches how the repo already resolves packages, so no package or tsconfig semantics change.
- **Rejected options:**
  - **B:** Measured wrong cache results in both directions (4a, 4b), a stuck state that Bazel cannot self-heal, tool resolution escaping into ancestor directories (4c), and it breaks under CI's `linux-sandbox`.
  - **Pure C:** dts cannot be emitted from upstream source (14 TS6059 errors, and it pollutes upstream `src`), so `dist` edges remain unavoidable for build.
- **Evidence that would change this recommendation:**
  - If A fails under `linux-sandbox` on CI (reads of the external repo blocked), either declare the store as a filegroup or add `--sandbox_add_mount_pair` for the output base before adopting it.
  - If staged-file counts at full scale exceed about 10x the 126 measured here for common actions, revisit symlink-with-`--preserve-symlinks` staging.
  - If core's 8 `isolatedDeclarations` errors are fixed and a repo-wide survey shows 0, adopt variant D to drop the `dist` edge for dts as well.
  - If trusting the repository-rule contents (4d) becomes unacceptable, move the install into a tree-artifact action and accept hashing about 24,000 files.

## Downstream impact

- **ADRs to write or update:** A new ADR superseding `.constitution/tech-spec/adrs/ADR-0013-workspace-orchestration-uses-devenv-and-nx.md` and the Nx clause of `.constitution/tech-spec/adrs/ADR-0017-native-toolchains-remain-authoritative-inside-each-impl.md`. It should record the staged-workspace model, the bun-install repository rule with its stamp, the split between the `dist` edge (build) and the source edge (checks), the pinned `PATH`, the ban on `bunx` fallback, and the 4d trust boundary. The Bazel-module docstring in `MODULE.bazel` ("TypeScript-hermeticity reversal") needs a matching update when that ADR lands.
- **Tickets unblocked:** none (decision-owned spike). This unblocks planning of the Bazel epic (Nx removal).
- **Register entry closed:** OD-05, with Option A (staged `node_modules` from a `bun install` repository rule), refined to sandboxed staged-workspace actions, a `dist` edge for build only, and source resolution for typecheck and test.
- **Tickets to add or split:**
  1. Repository rule plus generated package graph.
  2. `ts_package` macro and runner, with explicit tool paths.
  3. Declare the non-manifest test and typecheck inputs (backend sources for runtime tests, `spec/kernel/**` for protocol tests), which A will surface package by package.
  4. A devenv-generated `user.bazelrc` pinning `PATH`.
  5. Upgrade Bun to 1.4.1 or later so the repository rule can use `--offline` or `--prefer-offline`.
  6. A dev-host fix or an ADR note on `linux-sandbox` being unavailable on NixOS (the `/bin/true` probe).
  7. A CI check that A passes under `linux-sandbox`.
  8. Optional: an `isolatedDeclarations` survey toward variant D.
- **Spec edits required:** Stage 3 (tech-spec). The new ADR above, plus the verification commands in the tech-spec guidelines that still name Nx lanes. The spike does not edit them; the epic lead raises the blocker for Stage 3.
