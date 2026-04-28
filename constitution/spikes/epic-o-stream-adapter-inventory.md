# Epic O Stream Adapter Inventory

This file closes `KRT-O001` through `KRT-O006` against current repo reality and
records the adapter contracts, warning policy, coverage, and downstream
assumptions that Epic P inherits.

## Current Repo Reality

- `@tuvren/stream-core` now exists at
  `boundaries/framework/implementations/typescript/stream-core`.
- `@tuvren/stream-sse` now exists at
  `boundaries/framework/implementations/typescript/stream-sse`.
- `@tuvren/stream-agui` now exists at
  `boundaries/framework/implementations/typescript/stream-agui`.
- Shared runtime contracts remained stable through Epic O:
  `TuvrenStreamEvent` and `ProviderStreamChunk` were not widened.
- `ExecutionHandle.events()` remains single-consumer. Epic O closes the host/test
  fanout gap with `teeTuvrenStreamEvents(...)` instead of relaxing the runtime
  contract. Tee branches must subscribe before the first upstream pull; late
  subscriptions fail explicitly instead of silently missing the consumed prefix.

## Selected Protocol Versions

- SSE baseline: EventSource-compatible text/event-stream framing over canonical
  `TuvrenStreamEvent` JSON payloads.
- AG-UI baseline: `@ag-ui/core@0.0.52`.
- AG-UI implementation uses the official exported `AGUIEvent` union,
  `EventType`, and `EventSchemas` runtime validator from `@ag-ui/core`.
- ACP or any additional host protocol remains explicitly deferred.

## Package Exports

- `@tuvren/stream-core`
  - `StreamProtocolAdapter<T>`
  - `StreamAdapterWarning`
  - `StreamAdapterOptions`
  - `cloneTuvrenStreamEvent(...)`
  - `createFixtureStream(...)`
  - `createStreamAdapterWarningReporter(...)`
  - `serializeTuvrenStreamEvent(...)`
  - `streamAdapterFixtures`
  - `teeTuvrenStreamEvents(...)`
- `@tuvren/stream-sse`
  - `TuvrenSseFrame`
  - `toSseFrames(...)`
  - `toSseResponse(...)`
- `@tuvren/stream-agui`
  - `toAgUiEvents(...): AsyncIterable<AGUIEvent>`

## Mapping Matrix

### SSE

- Every canonical event becomes one SSE frame.
- `frame.event` is the original `TuvrenStreamEvent.type`.
- `frame.data` is the serialized canonical event JSON.
- `file.done` binary payloads are encoded into a JSON marker object:
  `{ type: "Uint8Array", data: number[] }`, with a warning.

### AG-UI direct mappings

- `turn.start` -> `RUN_STARTED`
  - `runId = turnId`
  - resumed streams preserve `parentRunId = resumedFrom`
- `turn.end` completed -> `RUN_FINISHED`
- `turn.end` failed -> `RUN_ERROR` using the latest fatal canonical `error`
  as `rawEvent` when present
- `iteration.start` / `iteration.end` -> `STEP_STARTED` / `STEP_FINISHED`
  - `stepName = iteration-${iterationCount}`
- `text.delta` / `text.done` -> `TEXT_MESSAGE_*`
  - `text.done` synthesizes content when no prior delta exists
- `reasoning.delta` / `reasoning.done` -> `REASONING_*` and
  `REASONING_MESSAGE_*`
  - reasoning message ids use `${messageId}:reasoning`
- `tool_call.start` / `tool_call.args_delta` / `tool_call.done` ->
  `TOOL_CALL_*`
  - `tool_call.done` synthesizes `TOOL_CALL_ARGS` from final input when no args
    delta was emitted
- `tool.result` -> `TOOL_CALL_RESULT`
  - `messageId = tool-result:${callId}`
  - non-string outputs are JSON-stringified
- `state.snapshot` -> `STATE_SNAPSHOT`
  - `snapshot = { contextManifest: manifest }`
- canonical `custom` -> AG-UI `CUSTOM` with the original custom name and data

### AG-UI custom-fallback mappings

- `approval.requested` -> `CUSTOM tuvren.runtime.approval.requested`
- `approval.resolved` -> `CUSTOM tuvren.runtime.approval.resolved`
- `turn.end` paused -> `CUSTOM tuvren.runtime.turn.paused` plus `RUN_FINISHED`
  with `{ status: "paused" }`
- `steering.incorporated` -> `CUSTOM tuvren.runtime.steering.incorporated`
- `state.checkpoint` -> `CUSTOM tuvren.runtime.state.checkpoint`
- `tool.start` -> `CUSTOM tuvren.runtime.tool.start`
- `structured.delta` -> `CUSTOM tuvren.runtime.structured.delta`
- `structured.done` -> `CUSTOM tuvren.runtime.structured.done`
- `file.done` -> `CUSTOM tuvren.runtime.file.done`
- nonfatal `error` -> `CUSTOM tuvren.runtime.error`
- `message.done` -> `CUSTOM tuvren.runtime.message.done`

## Warning Codes

- `sse_binary_payload_json_encoded`
- `agui_approval_custom_fallback`
- `agui_file_output_custom_fallback`
- `agui_message_done_custom_fallback`
- `agui_nonfatal_error_custom_fallback`
- `agui_paused_turn_coerced_to_run_finished`
- `agui_state_checkpoint_custom_fallback`
- `agui_steering_custom_fallback`
- `agui_structured_output_custom_fallback`
- `agui_tool_execution_custom_fallback`

Warnings are deduped once per code per adapter stream instance. Host observers
cannot fail adapter execution by throwing inside `onWarning`.

## Known Lossy Cases

- AG-UI has no first-class approval, pause, checkpoint, structured-output,
  file-output, tool-execution-start, steering, or nonfatal-error event model
  matching Tuvren’s richer canonical vocabulary. These cases intentionally flow
  through the `tuvren.runtime.*` custom namespace.
- AG-UI `RunFinished` has no paused outcome, so paused turns are coerced to a
  custom pause event plus `RUN_FINISHED`.
- `message.done` finish metadata and usage are preserved only through
  `tuvren.runtime.message.done`.
- SSE binary `file.done` payloads stay fully observable but not byte-for-byte
  identical after JSON encoding because JSON cannot carry raw `Uint8Array`
  values directly.

## Fixture And Integration Coverage

- Package-local tests:
  - `stream-core`: tee fanout, warning dedupe, JSON-safe binary serialization
  - `stream-sse`: frame mapping, response headers, binary warning path
  - `stream-agui`: direct mappings, resumed lineage projection, paused
    coercion, fatal error mapping, failed-lifecycle validation, synthesized
    tool-call args, synthesized text content, and terminal failure flushes
- Smoke coverage:
  - package export smoke tests exist for all three packages
- Runtime integration coverage:
  - `runtime-core/test/stream-adapters.test.ts` proves tee-based adapter use on
    real `ExecutionHandle.events()` flows for completed, paused/resumed,
    structured-output, steered, and cancelled turns
  - `drivers/react/test/react-driver.test.ts` proves provider-streamed success
    and provider-streamed failure flows through tee fanout into canonical, SSE,
    and AG-UI adapter consumers

## Downstream Assumptions For Epic P

- Hosts must call `handle.events()` once and fan out with
  `teeTuvrenStreamEvents(...)` if they need canonical, SSE, and AG-UI views at
  the same time.
- Hosts must subscribe every required tee branch before the first consumer pull.
  `toSseFrames(...)`, `toSseResponse(...)`, and `toAgUiEvents(...)` now reserve
  their tee branch eagerly at adapter construction time to make that contract
  practical for the standard host fanout path.
- SSE is the lossless host transport for canonical event semantics.
- AG-UI is intentionally lossy and must be treated as a UI-oriented transport
  with `tuvren.runtime.*` custom events for Tuvren-specific control semantics.
- Playground flows in Epic P may rely on:
  - `@tuvren/stream-sse` for direct canonical event streaming
  - `@tuvren/stream-agui` for AG-UI-compatible UI transport
  - `@tuvren/stream-core` fixture helpers and tee fanout for deterministic
    multi-consumer testing
- Epic P must not assume provider-owned tool results, provider-owned approvals,
  or live provider file streaming exist in canonical runtime output.

## Validation Performed

- `bun run nx run framework-runtime-core:build`
- `bun run nx run framework-runtime-core:typecheck`
- `bun run typecheck`
- `bun run nx run framework-stream-agui:test`
- `bun run nx run framework-runtime-core:test`
- `bun run nx run framework-driver-react:test`
