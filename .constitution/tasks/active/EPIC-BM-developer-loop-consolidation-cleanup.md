# Epic BM — Developer-Loop and Consolidation Cleanup (KRT)

**Status:** Active — fully parallel to Epics BJ/BK; no cross-epic dependencies in either direction. Every ticket in this epic is independently schedulable (each declares `Dependencies: None`) and none touches kernel-authority or interop-protocol surfaces owned by BJ/BK. Governing authority: the 2026-07-04 audit `.constitution/reports/audit-2026-07-04-170703-post-epic-87-baseline.md` findings [G-01] (CI and verification-lane throughput), [C-02] (conformance harness CPU/latency waste), [E-02] (consolidation cluster — small, high-certainty cleanups), and [E-03] (structural watch items) clusters.

This epic converts those findings into atomic DX/perf/tech-debt tickets; none of them change semantic gate behavior — every ticket's STOP condition guards against a caching, consolidation, or cleanup change silently weakening what a gate actually validates.

"Independently schedulable" and "fully parallel" here mean **dependency-free scheduling** (no BM ticket must wait on another), **not conflict-free concurrent merges**: several BM tickets partition the same tooling files by scope/line-range — e.g. BM002 and BM006 both edit `tools/scripts/verify.ts`, BM002 and BM003 both edit `tools/scripts/verify-kernel.ts`, BM005 and BM006 both edit `tools/scripts/portability-check.ts`, and BM001 and BM002 both touch the root `package.json`. The scopes are deliberately partitioned (e.g. BM002 carves the `KERNEL_*_PROJECTS` literals out to BM003 in its Out-of-Scope), so there is no ordering dependency — only a merge-sequence one: whichever of two file-sharing tickets lands second rebases on the first.

**Total: 18 points.**

#### KRT-BM001 CI Caching + Shared Setup
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** DX
- **Capability / Contract Mapping:** Audit finding [G-01] — `.github/workflows/ci.yml` has zero `actions/cache` usage anywhere, and the Nix/devenv install steps are byte-identical across the `verify` job (lines 119-134) and the `bazel` job (lines 173-185).
- **Scope (In-Scope Files):** `.github/workflows/ci.yml`; a new composite action (e.g. `.github/actions/setup-toolchain/action.yml`) extracting the shared Nix-install/devenv-install steps.
- **Scope (Out-of-Scope Files):** `devenv.nix`, `devenv.lock`, `tools/scripts/verify.ts`, `tools/scripts/verify-kernel.ts`, `tools/scripts/check.ts` — no gate logic or step ordering changes.
- **Verification Command:** A green GitHub Actions run of `.github/workflows/ci.yml` on the PR branch (both the `verify` and `bazel` jobs).
- **Expected Success Output:** Both jobs report `exit 0`/success in the Actions run, with cache-hit steps visible in the job logs on the second run of the same branch.
- **STOP Conditions:** STOP if a caching key needs to key on anything softer than exact lockfile/Nix-input hashes (e.g. a moving branch name or date) — that would let a cache mask staleness the gates exist to catch; record the finding instead of shipping a lossy cache key. STOP if the composite action changes step order relative to today's `verify`/`bazel` jobs in a way that alters what runs before the gate.
- **Description:** Add `actions/cache` (or equivalent) for the Nix store/profile, `bun install`'s cache, and Cargo's registry/target dirs, scoped by lockfile hashes (`bun.lock`, `Cargo.lock`, `devenv.lock`). Extract the duplicated Nix-installer + devenv-install steps (ci.yml:119-134 and 173-185) into one composite action both jobs call, so the pin (`devenv 2.1.2`, `nix-installer-action@v22`) lives in exactly one place.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: CI caching and shared setup

  Scenario: Repeated pushes reuse cached dependencies
    Given a second CI run on the same branch with unchanged lockfiles
    When the "verify" and "bazel" jobs execute
    Then the Nix/bun/cargo cache steps report a cache hit
    And overall job wall-clock is measurably shorter than the cold-cache run

  Scenario: A lockfile change still forces a fresh resolution
    Given Cargo.lock or bun.lock changes on a branch
    When CI runs
    Then the corresponding cache key misses and dependencies are re-resolved
    And the gate does not silently pass with stale dependency state

  Scenario: Shared setup step stays single-sourced
    Given the composite setup action changes the devenv version pin
    When both the "verify" and "bazel" jobs run
    Then both jobs pick up the new pin from the one composite action
    And no duplicated inline copy of the pin remains in ci.yml
```

#### KRT-BM002 Verification Phase-Engine Consolidation
- **Type:** Chore
- **Effort:** 3
- **Dependencies:** None
- **Category:** DX
- **Capability / Contract Mapping:** Audit finding [G-01] — `tools/scripts/verify.ts:437-450`'s `runVerification` maps an explicit step list (used by `verify-kernel.ts` and `check.ts`) to `concurrency: 1` phases even when the underlying validators are independent, while `DEFAULT_VERIFICATION_PHASES` (`verify.ts:248`) already parallelizes the same validator family via `AUTHORITY_GATE_STEPS` (`verify.ts:189`) at `DEFAULT_MAX_CONCURRENCY = 8` (`verify.ts:98`). Root `package.json:28`'s `codegen` script chains ~9 independent validators serially with `&&`.
- **Scope (In-Scope Files):** `tools/scripts/verify.ts` (the `runVerification`/`runVerificationPhases` split, `AUTHORITY_GATE_STEPS`, `DEFAULT_VERIFICATION_PHASES`); `tools/scripts/verify-kernel.ts`; `tools/scripts/check.ts`; new `tools/scripts/codegen.ts`; `package.json`'s `codegen` script entry (line 28).
- **Scope (Out-of-Scope Files):** `tools/scripts/verify-kernel.ts`'s `KERNEL_TYPECHECK_PROJECTS`/`KERNEL_CONFORMANCE_PROJECTS` literals (owned by KRT-BM003); `tools/conformance/**` (owned by KRT-BM004).
- **Verification Command:** `bun run verify:kernel` and `bun run check` and `bun run codegen`
- **Expected Success Output:** `exit 0` for each of the three commands, with `verify-kernel`/`check` logs showing independent validator steps executing inside a shared, non-`concurrency: 1` phase where their underlying commands have no ordering dependency on each other.
- **STOP Conditions:** STOP if any two of the currently-serial steps turn out to share mutable state (e.g. both writing the same generated file) — record the specific pair and keep it serial rather than parallelizing a race. STOP if `codegen.ts` diverges from the exact validator set/order `package.json:28` runs today; the migration must be a refactor, not a behavior change.
- **Description:** Make `runVerificationPhases` (already used by `DEFAULT_VERIFICATION_PHASES`) the single phase-engine entry point for all four lanes. Group `verify-kernel`'s and `check`'s currently-serial, independent steps into shared phases with real concurrency instead of one-step `concurrency: 1` phases. Create `tools/scripts/codegen.ts` that imports `AUTHORITY_GATE_STEPS` (or an equivalent exported subset) from `verify.ts` and runs it through `runVerificationPhases`, then point `package.json`'s `codegen` script at the new script instead of its inline `&&` chain.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Single phase engine for all verification lanes

  Scenario: check and verify-kernel run independent steps concurrently
    Given "bun run check" or "bun run verify:kernel" executes
    When two of its steps have no shared output or ordering dependency
    Then both steps run within the same non-serial phase
    And the command still exits 0 on a clean worktree

  Scenario: codegen reuses the shared gate-step list
    Given "bun run codegen" executes
    When it runs the authority validators
    Then it runs the exact same validator set and order package.json's previous inline chain ran
    And it exits 0 on a clean worktree, non-zero if any validator fails

  Scenario: A genuinely ordered pair stays serial
    Given two steps where one step's output is read by the other
    When the phase engine is configured
    Then those two steps remain in a serial (concurrency: 1) phase
    And no race condition is introduced
```

#### KRT-BM003 Drift-Guarded Kernel Project Lists
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** DX
- **Capability / Contract Mapping:** Audit finding [G-01] — `tools/scripts/verify-kernel.ts:25-40` hardcodes `KERNEL_TYPECHECK_PROJECTS` and `KERNEL_CONFORMANCE_PROJECTS` as string-literal arrays with no live-Nx-graph validation, the same stale-list bug class that hit the codegen project list at incident 87-M4.2c; that incident's fix (`verify.ts:33-70`, which parses the codegen project list from `package.json` and validates each name against `loadNxProjectFiles` plus target existence) was never applied to this sibling list.
- **Scope (In-Scope Files):** `tools/scripts/verify-kernel.ts` (lines 16-40).
- **Scope (Out-of-Scope Files):** `tools/scripts/verify.ts`'s existing `CODEGEN_PROJECTS` derivation (reuse its pattern/helpers, do not restructure it); `tools/scripts/lib/nx-projects.ts` only touched if a shared helper needs extracting, not to change its existing contract.
- **Verification Command:** `bun run verify:kernel`
- **Expected Success Output:** `exit 0` on a clean worktree; renaming or removing one of the listed kernel projects in `project.json` (locally, not committed) causes `verify-kernel` to fail loudly with an "unknown Nx project" or "project no longer declares target" error instead of silently skipping it.
- **STOP Conditions:** STOP if a kernel project only conditionally declares its `typecheck`/`conformance` target (e.g. behind an Nx target-default inheritance the literal-list approach could not see either) — record the case rather than papering over it with a permissive check that could hide the exact 87-M4.2c failure mode.
- **Description:** Using `verify.ts:33-70`'s pattern (`loadNxProjectFiles`, validate each name exists, validate it still declares the target it's listed for) as the precedent, derive or validate `KERNEL_TYPECHECK_PROJECTS` against the live Nx project graph checking each declares a `typecheck` target, and `KERNEL_CONFORMANCE_PROJECTS` checking each declares a `conformance` target. Fail loud at script start if any listed project is missing or targetless, exactly as `verify.ts` already does for the codegen list.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Kernel project lists stay drift-guarded

  Scenario: A valid kernel project list passes
    Given KERNEL_TYPECHECK_PROJECTS and KERNEL_CONFORMANCE_PROJECTS name only real Nx projects that declare the matching target
    When "bun run verify:kernel" executes
    Then it exits 0

  Scenario: A renamed or removed kernel project fails loud
    Given a project name in either list no longer exists in the Nx graph
    When "bun run verify:kernel" executes
    Then it exits non-zero with an error naming the unknown project
    And it does not silently skip that project's checks

  Scenario: A kernel project that dropped its target fails loud
    Given a listed project exists but no longer declares the target it is listed under (typecheck or conformance)
    When "bun run verify:kernel" executes
    Then it exits non-zero with an error naming the targetless project
```

#### KRT-BM004 Conformance-Tooling Validator Caches
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Perf
- **Capability / Contract Mapping:** Audit finding [C-02] — `tools/conformance/harness/assertion-engine/index.ts` (`assertSchemaValid`, around line 187) constructs `new Ajv2020(...)` and calls `.compile()` fresh per `schemaValid` assertion; `tools/conformance/plan-compiler/index.ts`'s `createPlanValidator` (invoked from `loadConformancePlan`, lines 122 and 183-190) re-reads `PLAN_SCHEMA_PATH` from disk and recompiles the plan schema per plan file. In-repo precedent for the fix pattern: `typescript/runtime/src/lib/tool-execution-helpers.ts:925-941`.
- **Scope (In-Scope Files):** `tools/conformance/harness/assertion-engine/index.ts`; `tools/conformance/plan-compiler/index.ts`.
- **Scope (Out-of-Scope Files):** `tools/conformance/harness/run.ts`'s `dispatch`/`events`/`inspectState` sequencing (a separate [C-02] sub-finding, not part of this fixed ticket set); any conformance plan JSON under `spec/conformance/`.
- **Verification Command:** `bun run conformance`
- **Expected Success Output:** `exit 0`, with no regression in check/assertion pass/fail outcomes versus the pre-change baseline (identical evidence status per check).
- **STOP Conditions:** STOP if a schema identity key (for the memoization map) can collide across two distinct schemas — e.g. inline anonymous schemas without a stable `$id` — record the collision case and key by content hash instead of assuming reference identity is safe.
- **Description:** Add a module-level cache mapping schema identity (a stable key: `$id` if present, else a content hash of the schema JSON) to a compiled Ajv `ValidateFunction`, so `assertSchemaValid` and `createPlanValidator` compile each distinct schema once per process instead of once per assertion/plan-file invocation. Mirror the memoization approach already used in `tool-execution-helpers.ts:925-941`.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Schema validators are memoized

  Scenario: Repeated schemaValid assertions reuse a compiled validator
    Given two conformance checks both assert schemaValid against the same schema
    When the assertion engine evaluates both
    Then Ajv compiles that schema only once for the process
    And both assertions still produce correct pass/fail results

  Scenario: The plan schema is read and compiled once per process
    Given multiple conformance plan files are loaded in one process
    When loadConformancePlan runs for each plan file
    Then the plan schema file is read from disk and compiled only once
    And every plan is still validated against the same schema correctly

  Scenario: Distinct schemas never collide in the cache
    Given two different schemas that could share a naive cache key
    When both are compiled through the memoized path
    Then each gets its own distinct compiled validator
    And no cross-schema false pass/fail occurs
```

#### KRT-BM005 Portability-Check Bounded Concurrency
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Perf
- **Capability / Contract Mapping:** Audit finding [G-01] — `tools/scripts/portability-check.ts` (the `runImportCheck` loop around lines 146-156) spawns one `bun` and one `node` child process sequentially per entry in `PORTABLE_PACKAGE_SURFACES`, i.e. 18 sequential process spawns for 9 surfaces × 2 runtimes, on the `codegen`/`verify` critical path.
- **Scope (In-Scope Files):** `tools/scripts/portability-check.ts`.
- **Scope (Out-of-Scope Files):** `PORTABLE_PACKAGE_SURFACES`/`DOCUMENTED_PACKAGE_SURFACES` content (the surface classifications themselves are not being changed, only the execution strategy).
- **Verification Command:** `bun run codegen` (portability:check is one of its chained steps) or directly `bun tools/scripts/portability-check.ts`
- **Expected Success Output:** `exit 0`, with the "Epic Q portability matrix" console output and per-surface pass/fail lines still fully readable and attributable to the correct surface (no interleaved/garbled output from concurrent child processes).
- **STOP Conditions:** STOP if unbounded or high concurrency causes flaky failures from resource contention (e.g. Bun/Node startup under memory pressure) on the CI runner class this targets — record the observed flake and lower the pool size rather than shipping a concurrency level that trades determinism for speed.
- **Description:** Replace the sequential per-surface `await runImportCheck(...)` loop with a bounded-concurrency pool (e.g. a small worker-pool helper capping in-flight spawns at a fixed number such as 4-6), buffering each check's stdout/stderr and printing it atomically per completed check so concurrent output never interleaves mid-line.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Portability checks run with bounded concurrency

  Scenario: All surfaces are still checked
    Given the configured PORTABLE_PACKAGE_SURFACES list
    When portability-check.ts runs
    Then every surface is checked under both Bun and Node
    And the process exits 0 only if every check passed

  Scenario: Concurrent output stays attributable
    Given multiple import checks run concurrently
    When their output is printed to the console
    Then each check's output block is printed as one atomic, unscrambled unit
    And no line from one check's output is interleaved with another's

  Scenario: A single surface failure still fails the whole gate
    Given one surface fails its Bun or Node import check
    When portability-check.ts finishes running all checks
    Then the process exits non-zero
    And the failing surface is clearly identified in the output
```

#### KRT-BM006 Remove the @tuvren/core-types Shim
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Tech-Debt
- **Capability / Contract Mapping:** Audit finding [E-02] — `typescript/core-types/src/lib/{tuvren-error,kernel-records}.ts` are byte-identical stale forks of `@tuvren/core`, and `typescript/core-types/src/index.ts:18-22` already carries its own deprecation notice ("will be removed in the next minor release").
- **Scope (In-Scope Files):** `typescript/core-types/` (delete the package entirely); `tsconfig.json` and `tsconfig.base.json` (remove the `@tuvren/core-types` path mapping and any project reference); `tools/scripts/verify.ts` lines 106 and 142 (remove `"shared-core-types"` from `WORKSPACE_TEST_PROJECTS` and `WORKSPACE_BUILD_PROJECTS`); `tools/scripts/portability-check.ts` (remove the `@tuvren/core-types` entry, lines ~39-40); `typescript/kernel/testkit/package.json:16`, `typescript/kernel/certification/package.json:9`, `typescript/providers/certification/package.json:9` (remove the `"@tuvren/core-types": "workspace:*"` dependency entries); every `tsconfig.*.json` project-reference entry pointing at `../../core-types/*` (found across `typescript/streaming/{agui,core}`, `typescript/providers/{bridge-ai-sdk,provider-api,certification,testkit}`, `typescript/kernel/{protocol,testkit,certification,backends/{postgres,sqlite,memory},runtime}`, `typescript/runners/react`, `typescript/runtime`, `typescript/testkit`).
- **Scope (Out-of-Scope Files):** `typescript/kernel/protocol/test/kernel-contract-deterministic.test.ts:19` — this file imports `../../../core-types/test/kernel-record-fixtures.js` by relative path (a test-fixture import, not the `@tuvren/core-types` package import); this is a live cross-directory importer this ticket's STOP condition must evaluate before any deletion, not a file to edit blindly.
- **Verification Command:** `bun run verify`
- **Expected Success Output:** `exit 0`; a workspace-wide `grep -rn "core-types"` (excluding `spec/core/artifacts/json-schema/*` unrelated JSON Schema hits and this ticket's own historical git log) returns no remaining references.
- **STOP Conditions:** STOP and do not force-delete if `typescript/kernel/protocol/test/kernel-contract-deterministic.test.ts`'s import of `../../../core-types/test/kernel-record-fixtures.js` has no equivalent fixture elsewhere — either relocate `kernel-record-fixtures.ts` to a surviving testkit location first and repoint the import, or record the live dependency and keep the minimal fixture file instead of deleting the whole package. STOP if any other live (non-deprecated-shim) importer surfaces during the sweep.
- **Description:** `typescript/core-types` is a deprecated shim (self-declared at `src/index.ts:18-22`) duplicating two files already owned by `@tuvren/core`. Delete the package and sweep every workspace/Nx/tsconfig/certification registration that names it — the Nx project name is `shared-core-types` (`typescript/core-types/project.json:2`), which appears in `verify.ts`'s `WORKSPACE_TEST_PROJECTS` (line 106) and `WORKSPACE_BUILD_PROJECTS` (line 141-142) lists and must be removed from both so the workspace-coverage gate does not expect a target from a project that no longer exists. Before deleting, resolve the one real relative-path importer of `core-types/test/kernel-record-fixtures.ts` from `kernel/protocol`'s test suite.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: The core-types shim package is removed cleanly

  Scenario: The package and its registrations are gone
    Given typescript/core-types has been deleted
    When searching the workspace for "@tuvren/core-types" or "shared-core-types"
    Then no package.json, tsconfig, or project.json references remain
    And "bun run verify" still exits 0

  Scenario: The one real fixture importer is preserved
    Given kernel-contract-deterministic.test.ts previously imported kernel-record-fixtures.ts from core-types/test
    When the core-types package is removed
    Then the fixture the test depends on still exists at a resolvable location
    And that test still passes

  Scenario: Workspace coverage gates do not reference the deleted project
    Given "shared-core-types" is removed from WORKSPACE_TEST_PROJECTS and WORKSPACE_BUILD_PROJECTS
    When "bun run verify" runs its workspace-coverage validation
    Then it does not fail looking for a target on a nonexistent project
```

#### KRT-BM007 Workspace Manifest Hygiene
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Tech-Debt
- **Capability / Contract Mapping:** Audit finding [E-02] — three manifest-hygiene sub-findings: (a) `typescript/kernel/backends/sqlite/project.json`'s `build`/`bench`/`retention-dry-run`/`test` targets (lines 14, 21, 28, 50) each duplicate the same compile+`mkdir`+`cp migrations/*.sql` pipeline inline; (b) `typescript/providers/bridge-ai-sdk/package.json:22` — audit flagged `@tuvren/runner-react` as test-only and to be verified against its declared placement; (c) `typescript/sdk/package.json:28` peer-declares `"zod": "^4.4.3"` (caret range) versus the exact-pin convention used elsewhere (e.g. `typescript/providers/testkit/package.json:21` and `typescript/tools/mcp-client/package.json:26` both pin `"zod": "4.4.3"` exactly).
- **Scope (In-Scope Files):** `typescript/kernel/backends/sqlite/project.json`; a new `tools/scripts/` helper for the shared compile+copy-migrations pipeline; `typescript/providers/bridge-ai-sdk/package.json`; `typescript/sdk/package.json`.
- **Scope (Out-of-Scope Files):** `typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts` (the separate double-`normalizeBackendError` finding is KRT-BK009's scope, not this ticket's); other packages' `zod` pins beyond confirming the convention.
- **Verification Command:** `bun run nx run backend-sqlite:build`, `bun run nx run backend-sqlite:test`, `bun run nx run backend-sqlite:bench`, `bun run nx run backend-sqlite:retention-dry-run`, and `bun run nx run providers-bridge-ai-sdk:build`
- **Expected Success Output:** `exit 0` for each command listed.
- **STOP Conditions:** For (b): verify `@tuvren/runner-react`'s actual declared placement in `typescript/providers/bridge-ai-sdk/package.json` against the live file before making any change; if it is already under `devDependencies`, treat this sub-item as closed/confirmed rather than moving an entry that has already moved, and note the discrepancy against the audit finding. STOP on (c) if any consumer of `typescript/sdk` actually needs a caret range (e.g. a documented peer-compat reason) — record it instead of silently tightening to an exact pin that breaks that consumer.
- **Description:** (a) Extract the shared `tsc --project <tsconfig> && mkdir -p <dir>/migrations && cp migrations/*.sql <dir>/migrations/` pipeline out of `backend-sqlite`'s `build`, `bench`, `retention-dry-run`, and `test` target `command` strings into one `tools/scripts/` helper script parameterized by target output dir and tsconfig, per the repo rule to keep shared command logic in scripts rather than duplicating shell snippets across `project.json` files. (b) Confirm and, if needed, correct `@tuvren/runner-react`'s placement in `typescript/providers/bridge-ai-sdk/package.json` (test-only usage belongs in `devDependencies`). (c) Align `typescript/sdk/package.json`'s zod peer range with the exact-pin convention (`4.4.3`) used by sibling packages, or explicitly document why the SDK surface needs a caret range if that turns out to be intentional.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Workspace manifests avoid duplicated pipelines and inconsistent pins

  Scenario: sqlite backend targets share one migrations-copy helper
    Given backend-sqlite's build, bench, retention-dry-run, and test targets
    When their project.json command strings are inspected
    Then the compile+copy-migrations logic is invoked via one shared script
    And each target still produces its migrations directory correctly

  Scenario: runner-react dependency placement matches its usage
    Given @tuvren/runner-react is used only by bridge-ai-sdk's tests
    When typescript/providers/bridge-ai-sdk/package.json is inspected
    Then @tuvren/runner-react appears under devDependencies, not dependencies
    And "bun run nx run providers-bridge-ai-sdk:build" still exits 0

  Scenario: zod peer range matches the workspace pin convention
    Given sibling packages pin "zod" to an exact version
    When typescript/sdk/package.json's zod peerDependency is inspected
    Then it either matches the exact-pin convention or documents why not
```

#### KRT-BM008 Kraken-Alias Cleanup + Public-Surface Lint Guard
- **Type:** Chore
- **Effort:** 2
- **Dependencies:** None
- **Category:** Tech-Debt
- **Capability / Contract Mapping:** Audit finding [E-02] — roughly 18 `typescript/runtime/src/**` files plus test helpers locally alias public runtime types to `Kraken*` names via `import { X as KrakenX }`, e.g. `typescript/runtime/src/lib/runner-registry.ts:19-25` (`assertRuntimeRunner as assertKrakenRunner`, `RuntimeRunner as KrakenRunner`, `RuntimeRunnerFactory as KrakenRunnerFactory`) and `typescript/runtime/test/fake-kernel.ts:33,86,99,116,796` (`RuntimeKernel as KrakenKernel`), even though the repo's naming rule reserves `Kraken*` for engine internals only and the public surface is verified clean today.
- **Scope (In-Scope Files):** `typescript/runtime/src/lib/runner-registry.ts` and the other ~18 `typescript/runtime/src/**` files performing the same `as Kraken*` local aliasing; `typescript/runtime/test/fake-kernel.ts` and sibling test helpers; a new or extended lint rule/script enforcing the guard (e.g. under `tools/scripts/` or a Biome/custom lint config) that fails if any package's public `index.ts` exports a `Kraken*`-named symbol.
- **Scope (Out-of-Scope Files):** Any genuine engine-internal type that is legitimately named `Kraken*` at its definition site (not a local alias) — this ticket removes the alias-only pattern, not intentional internal `Kraken*` naming.
- **Verification Command:** `bun run nx run framework-runtime:typecheck`, `bun run nx run framework-runtime:test`, and `bun run lint`
- **Expected Success Output:** `exit 0` for all three; the new lint guard, when temporarily pointed at a deliberately reintroduced `Kraken*` public export in a scratch/local test, fails loudly (confirmed during implementation, not shipped).
- **STOP Conditions:** STOP if removing an alias surfaces a genuine external consumer relying on the `Kraken*`-named local binding (unlikely for a local import alias, but verify no re-export leaks it) — record the case rather than silently dropping a name something outside the file actually depends on.
- **Description:** Drop the local `as Kraken*` import aliases across `typescript/runtime/src/**` and its test helpers, using the underlying public names (`RuntimeRunner`, `RuntimeRunnerFactory`, `RuntimeKernel`, etc.) directly. Add an automated guard (lint rule or a small validation script wired into `bun run lint` or `bun run codegen`) that scans each package's public `index.ts`/entrypoint exports and fails if any exported symbol name contains `Kraken`, keeping the public-surface cleanliness the audit found today permanent rather than incidental.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Kraken-only naming stays internal and enforced

  Scenario: Runtime source no longer locally aliases public types to Kraken names
    Given typescript/runtime/src/lib/runner-registry.ts and its sibling files
    When their import statements are inspected
    Then no "as Kraken*" local alias remains for a publicly-named type
    And "bun run nx run framework-runtime:typecheck" still exits 0

  Scenario: The public-surface guard catches a reintroduced Kraken export
    Given a package's public index.ts is modified to export a Kraken*-named symbol
    When the lint guard runs
    Then it fails loudly, naming the offending package and export

  Scenario: The public-surface guard passes on the current, clean surface
    Given the current state of every package's public index.ts
    When the lint guard runs
    Then it exits 0, confirming no Kraken*-named symbol is publicly exported
```

#### KRT-BM009 Small-Findings Sweep
- **Type:** Chore
- **Effort:** 1
- **Dependencies:** None
- **Category:** Docs
- **Capability / Contract Mapping:** Audit finding [E-02]/[E-03] cluster — four small, independent findings: (a) `typescript/runtime/src/lib/runtime-core-shared.ts:149`'s `detachPromise` has an undocumented "callee must route its own errors" contract (the function body is `task.catch(() => undefined);`); (b) `README.md`'s Quickstart (lines 36-53) assumes Nix and direnv are already installed and omits the prerequisite install steps `.github/workflows/ci.yml:119-134` performs explicitly (`nix-installer-action@v22`, then `nix profile install ... devenv`); (c) `docs/perf-benchmarks.md:51-55` names the retired Nx project `framework-runtime-core` inside a self-annotating historical footnote explaining the M3.2c/Epic-87 rename to `framework-runtime` — confirm this is the "one retired package name" the audit's [E-03] line flags and that the existing footnote already resolves it, or correct it if a different unannotated stale name is found elsewhere in the file; (d) `tools/scripts/services-up.sh` starts devenv-managed services idempotently but has no readiness wait, so a kernel verify lane invoked immediately after can race Postgres startup.
- **Scope (In-Scope Files):** `typescript/runtime/src/lib/runtime-core-shared.ts` (doc comment only, at/around line 149); `README.md` (Quickstart section, lines 36-53); `docs/perf-benchmarks.md`; `tools/scripts/services-up.sh`.
- **Scope (Out-of-Scope Files):** `typescript/runtime/src/lib/runtime-core-shared.ts`'s `detachPromise` implementation itself (documentation only, no behavior change); `.github/workflows/ci.yml` (README should describe the same prerequisites CI performs, not modify CI).
- **Verification Command:** `bun run lint` and a manual readiness check: `bun run services:up` followed immediately by a Postgres-backed command (e.g. `bun run verify:kernel`) exits 0 without a race-condition connection failure.
- **Expected Success Output:** `exit 0` for `bun run lint`; the services-up-then-verify-kernel sequence completes without a "connection refused"/"database not ready" failure.
- **STOP Conditions:** STOP on (c) if the actual current text of `docs/perf-benchmarks.md` no longer contains an unaddressed stale reference (the existing footnote at lines 51-55 already explains the historical name) — record that this sub-item is already resolved rather than editing a passage that is deliberately preserved as originally measured. STOP on (d) if adding a readiness wait would require embedding logic in Nx targets or runner commands, which the repo rules forbid (`services-up.sh` must remain a manual, top-level convenience only, never embedded in Nx targets or runners).
- **Description:** (a) Add a doc comment on `detachPromise` (`runtime-core-shared.ts:149`) stating explicitly that callers/callees must route their own errors — this function intentionally swallows the promise's rejection to prevent an unhandled-rejection crash, and is not itself an error-handling mechanism. (b) Add the two-line Nix/direnv prerequisite step to `README.md`'s Quickstart, ahead of today's step 1 (`direnv allow`), mirroring what `ci.yml:119-134` does explicitly (install Nix, then install devenv) for a reader who has neither installed yet. (c) Verify whether `docs/perf-benchmarks.md`'s only retired-name reference (`framework-runtime-core`, lines 51-55) is already adequately annotated as historical; if so, close this sub-item as already-resolved, otherwise fix whatever unannotated stale name is actually found. (d) Add a Postgres readiness wait (e.g. a bounded `pg_isready`-style poll) to `tools/scripts/services-up.sh` after `devenv up -d` succeeds, so the script itself does not return until the database is ready to accept connections, without violating the "never embed in Nx targets/runners" constraint already documented in the script's own header comment.
- **Acceptance Criteria (Gherkin):**
```gherkin
Feature: Small documentation and readiness findings are resolved

  Scenario: detachPromise's contract is documented
    Given runtime-core-shared.ts's detachPromise function
    When its doc comment is read
    Then it states the callee must route its own errors
    And this documents existing behavior with no functional change

  Scenario: README quickstart includes the Nix/direnv prerequisite
    Given a reader with neither Nix nor direnv installed
    When they follow README.md's Quickstart from the top
    Then they are told how to install Nix and direnv before "direnv allow"
    And the steps mirror what ci.yml's setup steps perform

  Scenario: perf-benchmarks.md's retired-name reference is resolved or confirmed
    Given docs/perf-benchmarks.md's historical footnote on framework-runtime-core
    When the file is reviewed against the audit's "one retired package name" finding
    Then either the footnote is confirmed as already sufficient and closed as-is
    Or the actually-stale unannotated reference is corrected

  Scenario: services:up waits for Postgres readiness
    Given "bun run services:up" has just reported success
    When a Postgres-backed command runs immediately afterward
    Then the database accepts connections without a startup race
    And services-up.sh remains a manual, top-level-only convenience script
```

##### KRT-BM004 Deviations & Justifications
- **Touched Files:** `tools/conformance/harness/test/assertion-engine.test.ts` (in addition to the two declared in-scope files)
- **Justification:** The independent spec review found the sorted-key canonicalizer silently dropped literal `"__proto__"` schema properties (assignment through the inherited setter), which is exactly the collision class the ticket's STOP condition names. The fix (null-prototype accumulator) plus the repo rule "give every claimed scenario matrix an automated check path" required regression tests for the memoization identity, distinct-schema separation, and the `__proto__` collision case; they were colocated with the existing assertion-engine suite.

##### KRT-BM006 Deviations & Justifications
- **Touched Files:** `spec/core/authority-packet.json` (dropped the deleted `typescript/core-types` path from `forbiddenAuthoritySources`), `spec/core/bindings/typescript.md` (binding projection now names `@tuvren/core`), `.constitution/tech-spec/{stack.md,guidelines.md,contracts/README.md,data-models/README.md}` (shim described as removed instead of pending removal), `typescript/kernel/protocol/test/kernel-records.test.ts` (relocated with the fixture), `bun.lock` (workspace member removed).
- **Justification:** The repo rule "keep contracts, conformance, and constitution aligned when semantics change" and the skill's keep-the-spec-folders-honest step require the machine authority and live constitution to stop describing a package that no longer exists. `kernel-records.test.ts` covers real `@tuvren/core` assertion/predicate behavior with the same fixture the protocol suite uses, so it moved with the fixture into `typescript/kernel/protocol/test/` rather than silently dropping coverage.
