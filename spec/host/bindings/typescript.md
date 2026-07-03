# TypeScript Binding Appendix

The engine package `@tuvren/runtime` (which absorbed the retired
`@tuvren/runtime-core` shim) and the `@tuvren/core` type subpaths are the
TypeScript binding projections for the neutral host contract (the
`messages`, `events`, `execution`, `tools`, `provider`, and `extensions`
binding sections of `tuvren.shared.core` per ADR-037). The former
`@tuvren/runtime-api` shim was retired at 87-M9.2 — it never had a
standalone authority packet, and its type surface lives on as
`@tuvren/core` subpath exports. TypeScript function signatures,
`Promise`, `AsyncIterable`, `AbortSignal`, `Uint8Array`, and language-native
errors are binding conveniences only.

Portable packet artifacts project TypeScript `Uint8Array` values as `uint8[]`
JSON arrays. Host-facing callable surfaces such as `ExecutionHandle` remain
binding-only and are not emitted as JSON Schema artifacts.

## ExecutionHandle binding

The base `ExecutionHandle` is the return type of `TuvrenRuntime.executeTurn()`.
TypeScript bindings not in the TypeSpec:

- `ExecutionHandle.awaitResult() -> Promise<ExecutionResult>`

`ExecutionResult` is a discriminated union keyed on `status`:

```typescript
type ExecutionResult =
  | { status: "completed"; finalAssistantMessage?: TuvrenMessage; executionStatus: ExecutionStatus }
  | { status: "failed"; error: TuvrenError; executionStatus: ExecutionStatus };
```

ADR-035 semantics for `awaitResult()`:

- `status: "completed"` — the turn ended normally; `finalAssistantMessage` is
  the last assistant message emitted by the runner, or `undefined` when the
  final runner iteration produced only tool results.
- `status: "failed"` — the runner returned an invalid result or the execution
  encountered an unrecoverable error; the result resolves (does not reject).
- Cancellation via `cancel()` is the only path that causes `awaitResult()` to
  reject; the rejection carries a `TuvrenRuntimeError` with
  `code: "execution_cancelled"`.
- Calling `awaitResult()` multiple times on the same handle is idempotent: all
  subsequent calls resolve immediately with the same `ExecutionResult`.

## OrchestrationHandle binding

TypeScript orchestration bindings stay in this appendix rather than JSON Schema
artifacts:

- `OrchestrationRuntime.executeTurn(...) -> OrchestrationHandle`
- `OrchestrationHandle.spawn(...) -> OrchestrationHandle`
- `OrchestrationHandle.allEvents() -> AsyncIterable<TuvrenStreamEvent>`
- `OrchestrationHandle.awaitResult() -> Promise<OrchestrationResult>`

`OrchestrationResult` extends `ExecutionResult` with an aggregated child map:

```typescript
type OrchestrationResult = ExecutionResult & {
  childResults: Record<string, ExecutionResult>;
};
```

`childResults` maps worker IDs (the `workerId` assigned by the orchestration
runtime to each spawned child) to that child's `ExecutionResult`. A cancelled
child whose `awaitResult()` rejection is caught during aggregation is recorded
as `{ status: "failed", error: TuvrenRuntimeError(execution_cancelled), ... }`.

The portable semantics for orchestration bindings are not defined by TypeScript
source. They are defined by the `tuvren.shared.core` authority packet plus the
shared orchestration conformance plan:

- launch preconditions for `spawn()` and `awaitResult()`
- run-local pause, resume, and cancel behavior across parent and child handles
- `events()` as self-only and `allEvents()` as self-plus-descendants
- descendant `source` attribution on subtree streams
- child final visible result text from `awaitResult()`
- absence of a canonical injected parent `worker_result`
- explicit execution-surface inheritance for `runnerId`, per-request `tools`,
  and explicit parent `schemaId`
- nested descendant attribution through child and ancestor subtree streams

`AsyncIterable` remains a TypeScript ergonomics detail only. Cross-language
implementations should satisfy the packet-owned orchestration semantics through
their own binding projection rather than copying TypeScript method mechanics.
