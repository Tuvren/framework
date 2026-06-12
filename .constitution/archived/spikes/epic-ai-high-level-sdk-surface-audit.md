# Epic AI High-Level SDK Surface Audit

Epic AI is closed in current repo reality.

This file records the `KRT-AI001` audit and the `KRT-AI002` normalization that
landed from it. The goal was not to freeze final public publication forever; it
was to give the proving-host path one intentional host-facing SDK surface so
the serious REPL host can be built against a coherent package story instead of
against historical package accidents.

## Scope

The audit evaluated the current proving-host path represented by
`@tuvren/playground-host`, its direct TypeScript workspace dependencies, and the
host-visible runtime helpers that future REPL-host work needs.

## Classification

| Package | Classification | Decision |
| --- | --- | --- |
| `@tuvren/runtime` | keep | New curated host-facing facade for current proving-host work. |
| `@tuvren/backend-memory` | keep | Explicit non-persistent proving/backend selection surface. |
| `@tuvren/backend-sqlite` | keep | Explicit persistent backend selection surface for Node-capable proving hosts. |
| `@tuvren/provider-bridge-ai-sdk` | keep | Standing TypeScript-only provider bridge exception remains explicit rather than hidden. |
| `@tuvren/stream-core` | keep | Canonical stream tee/fanout helper remains a first-class host tool. |
| `@tuvren/stream-sse` | keep | Portable SSE projection remains a first-class host tool. |
| `@tuvren/stream-agui` | keep | AG-UI projection remains explicit as an implementation-specific adapter. |
| `@tuvren/core-types` | merge | Re-exported through `@tuvren/runtime` for proving-host use. |
| `@tuvren/kernel-protocol` | merge | Host-needed kernel types and record decoding are re-exported through `@tuvren/runtime`. |
| `@tuvren/kernel-runtime` | merge | Local kernel construction is now consumed through `@tuvren/runtime`. |
| `@tuvren/runtime-api` | merge | Host-facing runtime contracts are now consumed through `@tuvren/runtime`. |
| `@tuvren/runtime-core` | merge | Shared runtime implementation helpers are now consumed through `@tuvren/runtime`. |
| `@tuvren/driver-react` | merge | The baseline driver constructor is now consumed through `@tuvren/runtime`. |
| `@tuvren/event-stream` | merge | Host-needed canonical stream-event typing is now consumed through `@tuvren/runtime`. |
| `@tuvren/framework-testkit` | internal | Validation helper only; removed from the proving-host package path. |
| `@tuvren/playground-host` | internal | Transitional proving harness, not the lasting public SDK surface. |

No split classification was required for the current proving-host path.
No additional rename beyond the new facade was required to unblock host work.

## Confusing Boundaries Identified

- Host-facing playground code had to know about `runtime-core`, `runtime-api`,
  `driver-react`, `kernel-runtime`, `core-types`, `kernel-protocol`, and
  `event-stream` directly, which exposed internal package topology instead of a
  deliberate SDK shape.
- The proving-host path carried a test-only dependency on
  `@tuvren/framework-testkit`, which made the package story look less product
  intentional than it actually needed to be.
- The playground host proved that the runtime worked, but it did not yet prove
  that a downstream host developer could start from one coherent runtime
  package.

## Normalization Delivered

- Added `@tuvren/runtime` at
  `boundaries/framework/implementations/typescript/runtime/` as the curated
  host-facing facade for the current TypeScript line.
- Re-exported the proving-host runtime surface from `@tuvren/runtime`:
  runtime contracts, runtime/core construction helpers, the baseline ReAct
  driver constructor, kernel-construction helpers, selected kernel record
  helpers, and selected shared error/value types.
- Rewired `@tuvren/playground-host` to depend on `@tuvren/runtime` instead of
  the lower-level runtime package set.
- Removed `@tuvren/framework-testkit` and the other lower-level runtime package
  handles from the proving-host package manifest and local TS path wiring.
- Added `@tuvren/runtime` to repo validation and portability import checks so
  the facade is treated as a real package surface rather than as documentation
  only.

## Validation

- `bun install`
- `bun run nx run-many -t typecheck -p framework-runtime,host-playground`
- `bun run nx run-many -t exports-smoke -p framework-runtime,host-playground`
- `bun run nx run host-playground:test`
- `bun tools/scripts/portability-check.ts`
