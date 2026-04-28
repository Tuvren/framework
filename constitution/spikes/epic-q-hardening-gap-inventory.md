# Epic Q Hardening Gap Inventory

This file closes `KRT-Q001` against current repo reality and records the
testkit extraction targets, release-check targets, portability posture, and
remaining gaps that Epic Q must close before the post-ReAct implementation
line can be treated as internally implementation-ready. It is not a public
release certification claim.

## Status

- `KRT-Q001` is closed in current repo reality.
- Epic Q remains active through `KRT-Q002` to `KRT-Q006`.
- This inventory is the planning handoff for the remaining Epic Q work.

## Current Repo Reality

- The post-ReAct implementation line already includes:
  - `@tuvren/provider-bridge-ai-sdk`
  - `@tuvren/stream-core`
  - `@tuvren/stream-sse`
  - `@tuvren/stream-agui`
  - `@tuvren/playground-host`
- Package-local test and smoke coverage already exists in the bridge, stream,
  runtime-core, and playground packages.
- `boundaries/providers/testkit` and `boundaries/framework/testkit` do not yet
  exist.
- `tools/scripts` still contains only the placeholder `.gitkeep`; the target
  `verify.ts` and `release-check.ts` entrypoints named in the TechSpec are not
  implemented yet.
- Package export smoke coverage already exists for the current public and
  host-facing packages in scope for Epic Q.
- The Node-backed SQLite reload path already exists as
  `bun run nx run host-playground:scenario-sqlite` and is the authoritative
  persistent-host validation path for the playground because
  `@tuvren/backend-sqlite` depends on `better-sqlite3`.

## Testkit Extraction Targets

### Provider testkit target

- Current source coverage to harvest:
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.test.ts`
  - provider-backed runtime evidence already exercised downstream through
    `framework-driver-react:test` and playground metadata scenarios
- `boundaries/providers/testkit` should become the shared home for:
  - provider-contract conformance fixtures and assertions that can survive the
    upcoming contract-stabilization and language-agnostic foundation work
  - scripted `LanguageModelV3` doubles and stream fixtures only as the first
    proving implementation, not as the ontology of the testkit itself
  - reusable assertions for generate/stream behavior, structured output,
    metadata preservation, tool-call mapping, cancellation, and normalized
    provider/bridge errors through the Tuvren-owned provider contract
  - helpers that keep AI SDK-specific types out of `runtime-core`, the shared
    provider testkit contract, and future non-AI-SDK provider implementations

### Framework testkit target

- Current source coverage to harvest:
  - `boundaries/framework/implementations/typescript/stream-core/test/stream-core.test.ts`
  - `boundaries/framework/implementations/typescript/stream-sse/test/stream-sse.test.ts`
  - `boundaries/framework/implementations/typescript/stream-agui/test/stream-agui.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/stream-adapters.test.ts`
  - `boundaries/hosts/implementations/typescript/playground/test/playground.test.ts`
- `boundaries/framework/testkit` should become the shared home for:
  - canonical event-stream fixtures and ordering assertions
  - tee/fanout helpers for multi-consumer host or test flows above
    `ExecutionHandle.events()`
  - adapter-facing assertions for SSE and AG-UI projections
  - reusable control-flow fixtures for cancellation, steering, approvals,
    errors, and terminal status checks
  - scenario helpers promoted from playground coverage only where they can be
    shared without depending on playground-only internals

## Existing Export Smoke Coverage

- Current `exports-smoke` targets already exist for:
  - `framework-driver-api`
  - `framework-event-stream`
  - `framework-runtime-api`
  - `framework-tool-contracts`
  - `provider-api`
  - `providers-bridge-ai-sdk`
  - `framework-stream-core`
  - `framework-stream-sse`
  - `framework-stream-agui`
  - `host-playground`
- Epic Q should preserve that matrix and add a single release-oriented entry
  point that runs it deliberately instead of relying on manual Nx target
  selection.

## Release-Check Targets

- Epic Q release tooling should own a single reported verification surface for:
  - workspace lint and typecheck
  - targeted package tests for the bridge, stream, runtime-core, ReAct driver,
    playground, and upstream contract packages they depend on
  - package export smoke tests across the current release surface
  - the Node-backed SQLite playground reload scenario
  - portability checks split clearly between Bun and Node where support differs
- That verification surface should certify internal implementation-line
  readiness, not broaden into package-publication or ecosystem-support claims
  that Epic Q is not trying to make.
- The private playground host proof remains a load-bearing Epic Q gate even
  though the package stays private, because it is the current end-to-end host
  evidence for the implementation line.
- The release report should avoid provider credentials, untracked local state,
  and long-lived SQLite files. Current repo reality already supports disposable
  SQLite smoke paths through the playground host target.

## Runtime Portability Matrix

| Surface | Current validation path | Current posture for Epic Q |
| --- | --- | --- |
| Shared/core contract packages | `typecheck`, `test`, existing build targets | Treat as Bun-validated today and add explicit Node validation in `KRT-Q005` |
| Framework runtime and stream packages | package-local tests plus `exports-smoke` | Treat as Bun-validated today and add explicit Node validation in `KRT-Q005` |
| `@tuvren/provider-bridge-ai-sdk` | package-local Bun tests plus export smoke | Do not assume Bun-only validation is enough; measure Node behavior explicitly in `KRT-Q005` |
| `@tuvren/backend-memory` | package-local Bun tests | Likely portable, but current Epic Q scope should document actual validated runtime coverage rather than infer it |
| `@tuvren/backend-sqlite` | package-local tests plus `host-playground:scenario-sqlite` | Node-first only because `better-sqlite3@12.8.0` is a native addon dependency |
| `@tuvren/playground-host` | Bun unit tests plus Node CLI SQLite reload scenario | Host package has mixed validation by scenario; SQLite reload remains explicitly Node-backed |

- Epic Q should preserve this as an explicit checked-in matrix or closure
  artifact section. Portability claims should not remain implicit in prose.
- Use these classifications consistently in Epic Q outputs:
  - `Bun-and-Node validated`
  - `mixed-runtime validated`
  - `Node-only`
  - `deferred`

## Deferred Deno Work

- Deno portability remains deferred for Epic Q.
- The current package/test/release scripts are Bun and Node oriented, and the
  package surfaces are still settling enough that Deno-specific scaffolding
  would create churn disproportionate to current value.
- Epic Q should keep Deno deferred explicitly rather than implying accidental
  support.

## Validation Note

- `package.json` declares `bun@1.3.11` as the package manager.
- Readiness validation in the current workspace observed `bun 1.3.10`.
- Epic Q release tooling should report declared versus actual runtime versions
  so toolchain drift is visible instead of implicit, but drift reporting does
  not need to become a load-bearing release gate for this epic.

## Remaining Gaps To Close Inside Epic Q

- Create `boundaries/providers/testkit` and move the stable AI SDK bridge
  coverage into a provider-contract-first shared testkit surface, keeping the
  AI SDK bridge as the first proving implementation rather than the definition
  of the contract.
- Create `boundaries/framework/testkit` and move the stable canonical stream,
  adapter, and control-flow fixtures there while preserving the documented
  canonical/SSE-only projection for resumed continuation flows that AG-UI does
  not model as a complete lifecycle.
- Implement `tools/scripts/verify.ts` and `tools/scripts/release-check.ts`,
  then wire them into workspace validation, including the private playground
  proof and explicit drift reporting.
- Add explicit Bun and Node portability targets for the packages that claim
  portable ESM support, while documenting narrower support for SQLite-backed or
  otherwise dependency-constrained packages through the explicit matrix above.
- Record final closure evidence in
  `constitution/spikes/epic-q-release-hardening-inventory.md`.

## Validation Evidence

- `bun run typecheck`
- `bun run lint`
- `bun run nx run-many -t test`
- `bun run nx run-many -t exports-smoke`
- `bun run nx run host-playground:scenario-sqlite`
