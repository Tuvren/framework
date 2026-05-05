# TypeScript Binding Appendix

`@tuvren/runtime-api` and `@tuvren/runtime-core` are TypeScript binding
projections for `tuvren.framework.runtime-api`. TypeScript function signatures,
`Promise`, `AsyncIterable`, `AbortSignal`, `Uint8Array`, and language-native
errors are binding conveniences only.

Portable packet artifacts project TypeScript `Uint8Array` values as `uint8[]`
JSON arrays. Host-facing callable surfaces such as `ExecutionHandle` remain
binding-only and are not emitted as JSON Schema artifacts.

TypeScript orchestration bindings stay in this appendix rather than JSON Schema
artifacts:

- `OrchestrationRuntime.executeTurn(...) -> OrchestrationHandle`
- `OrchestrationHandle.spawn(...) -> OrchestrationHandle`
- `OrchestrationHandle.allEvents() -> AsyncIterable<TuvrenStreamEvent>`
- `OrchestrationHandle.awaitResult() -> Promise<unknown>`

The portable semantics for those bindings are not defined by TypeScript source.
They are defined by the runtime-api authority packet plus the shared
orchestration conformance plan:

- launch preconditions for `spawn()` and `awaitResult()`
- run-local pause, resume, and cancel behavior across parent and child handles
- `events()` as self-only and `allEvents()` as self-plus-descendants
- descendant `source` attribution on subtree streams
- child final visible result behavior from `awaitResult()`
- absence of a canonical injected parent `worker_result`
- explicit execution-surface inheritance for `driverId`, per-request `tools`,
  and explicit parent `schemaId`
- nested descendant attribution through child and ancestor subtree streams

`AsyncIterable` remains a TypeScript ergonomics detail only. Cross-language
implementations should satisfy the packet-owned orchestration semantics through
their own binding projection rather than copying TypeScript method mechanics.
