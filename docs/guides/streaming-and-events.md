# Streaming and events

This guide explains the event pipeline end to end: the canonical event type, how events are produced inside the runtime, how a host consumes them through an `ExecutionHandle`, and how the SSE and AG-UI protocol adapters project them onto the wire. It is a pointer, not an oracle: where it disagrees with `spec/core/authority-packet.json`, `spec/streaming/sse/authority-packet.json`, a conformance plan under `spec/conformance/streaming/`, or `docs/KrakenFrameworkSpecification.md` §6, those sources win.

## The canonical event: `TuvrenStreamEvent`

Every observable moment of a Turn is one `TuvrenStreamEvent` — a discriminated union defined in `typescript/core/src/lib/runtime-contract-shapes.ts` and exported from `@tuvren/core/events`, in six groups:

- **Lifecycle**: `turn.start`, `turn.end`, `iteration.start`, `iteration.end`
- **Model output**: `message.start`, `text.delta`/`text.done`, `reasoning.delta`/`reasoning.done`, `file.done`, `structured.delta`/`structured.done`, `tool_call.start`/`tool_call.args_delta`/`tool_call.done`, `message.done`
- **Tool execution**: `tool.start`, `tool.result`, `tool.audit`
- **Control**: `approval.requested`, `approval.resolved`, `steering.incorporated`, `error`
- **State**: `state.snapshot`, `state.checkpoint`
- **Custom**: `custom`

Every event carries `type`, a `timestamp: EpochMs`, and an optional `source?: EventSource` (`{ agent, runner?, workerId?, threadId? }`) for multi-agent attribution. Guards (`isTuvrenStreamEvent`, `assertTuvrenStreamEvent`) live next to the shapes and are re-exported from the same subpath.

Authority note: the neutral event contract has no packet of its own — it is `tuvren.shared.core` authority (`spec/core/authority-packet.json`, `events` binding section, sourced from `spec/streaming/typespec/main.tsp`). Only the SSE wire framing has a standalone packet (`spec/streaming/sse/authority-packet.json`, `packetId: "tuvren.framework.event-stream-sse"`); `spec/streaming/README.md` explicitly warns against reintroducing the stale claim of a port-wide streaming packet.

## The three-layer architecture

Per `docs/KrakenFrameworkSpecification.md` §6.1, the pipeline has three layers, and only the outer two are public:

```
internal runner (generator yielding TuvrenStreamEvent)
  └─→ ExecutionHandle.events()          ← the host-facing control surface
        └─→ protocol adapter (events)   ← SSE / AG-UI projections
```

The **internal runner** yields events; the host never touches it. The **`ExecutionHandle`** (`@tuvren/core`) is the host's control surface — `events()`, `awaitResult()`, `cancel()`, `steer(signal)`, `resolveApproval(response)`, `status()`; `OrchestrationHandle` extends it with `allEvents()` and `spawn(...)` for multi-agent trees. **Protocol adapters** consume only an `AsyncIterable<TuvrenStreamEvent>` — never the handle — so any adapter composes with any event source, including fixture streams.

Two production details worth knowing:

- **Consumption starts execution.** The concrete handle (`typescript/runtime/src/lib/runtime-execution-handle.ts`) lazily kicks off orchestration on the first `.next()` of `events()`. Drain the stream concurrently with `awaitResult()` — the first-turn example in `docs/guides/publishing-and-adopter-onboarding.md` §2 shows the pattern.
- **Streaming and non-streaming providers produce identical event shapes.** During a streaming model call, provider chunks are simultaneously translated into live events and accumulated into the complete durable response (§6.2); for a non-streaming `generate()` call the runtime synthesizes the equivalent `message.start` → deltas → `message.done` sequence (§6.3), so downstream adapters can't tell the difference.

Inside the runtime, every emission funnels through one seam: `publishEvent` (`typescript/runtime/src/lib/runtime-core-events.ts`) stamps a default `source` from the active agent/runner/thread, re-validates the event with `assertTuvrenStreamEvent`, and pushes it onto the handle's internal queue. Runners participate through their own restricted seam — `RunnerRuntimePort.emit`, which may carry assistant stream-content events and `custom` events only; all lifecycle/tool/approval/state/error events are emitted by shared core itself (see `docs/guides/add-a-runner.md` §3).

## One stream, many consumers: `teeTuvrenStreamEvents`

`ExecutionHandle.events()` is single-consumer by contract — teeing, multicast, filtering, buffering, replay, and backpressure policy are host concerns, outside shared core. The baseline tee ships in `@tuvren/stream-core` (`typescript/streaming/core`):

```ts
const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(handle.events(), 3);
```

Its rules are strict and conformance-checked:

- Every branch must be claimed **before** the first upstream pull; a late `[Symbol.asyncIterator]()` throws `event_stream_subscription_too_late`. (The SSE and AG-UI adapters claim their branches eagerly at construction for exactly this reason.)
- Re-consuming a claimed branch throws `event_stream_already_consumed`.
- Each branch buffers at most one unread event — bounded backpressure, not unbounded fan-out.
- When every branch closes, the tee closes the source iterator, which cancels the upstream execution's event pump.

`@tuvren/stream-core` also carries the adapter toolkit: the `StreamProtocolAdapter<T>` shape (`(events: AsyncIterable<TuvrenStreamEvent>) => AsyncIterable<T>`) every projection implements, `serializeTuvrenStreamEvent` (JSON with a `Uint8Array` marker encoding), `cloneTuvrenStreamEvent`, `createFixtureStream` plus the canonical `streamAdapterFixtures` (`completedTurn`/`failedTurn`/`pausedTurn`), and `createStreamAdapterWarningReporter` (deduped, observer-safe warning delivery).

## The SSE projection: `@tuvren/stream-sse`

`toSseFrames(events)` maps each canonical event to one SSE frame — `event:` is the canonical `type`, `data:` is the serialized event — and `toSseResponse(events)` wraps that in a ready-to-serve Fetch `Response` (`text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`, the content type force-set even against a competing caller header). Binary `file.done` payloads are JSON-marker-encoded, with a deduplicated `sse_binary_payload_json_encoded` warning.

The package also ships the other direction: `decodeSseStream` is a from-scratch implementation of the WHATWG SSE interpretation algorithm (BOM stripping, LF/CRLF/CR line terminators, comment lines, single-leading-space stripping, `id:` with an embedded NUL ignored, digits-only `retry:`, no dispatch of an unterminated final frame), and `reportSseWireCompliance` self-reports seven wire-compliance booleans. Both are conformance surfaces, not conveniences: `spec/conformance/streaming/plans/event-stream-sse.json` drives 18 decode-trace checks against committed fixture traces plus a wire-compliance check asserting all seven booleans are true.

A minimal HTTP host serving a Turn as SSE is therefore one line past `executeTurn`:

```ts
const handle = instance.orchestration.executeTurn({ agent, branchId, signal, threadId });
return toSseResponse(handle.events());
```

## The AG-UI projection: `@tuvren/stream-agui`

`toAgUiEvents(events)` bridges the canonical stream into the third-party AG-UI protocol (`@ag-ui/core`). The mapping is stateful — it tracks text/reasoning/tool-call substreams per message and call id so it can bracket them correctly (`TEXT_MESSAGE_START` lazily on the first delta, `TEXT_MESSAGE_END` on `text.done`, and likewise for reasoning and tool calls). The headline mappings: `turn.start` → `RUN_STARTED`, `turn.end` → `RUN_FINISHED`/`RUN_ERROR` by status, `iteration.*` → `STEP_STARTED`/`STEP_FINISHED`, `tool.result` → `TOOL_CALL_RESULT`, `state.snapshot` → `STATE_SNAPSHOT`.

Where AG-UI has no first-class shape, events project to `CUSTOM("tuvren.runtime.<event>")` with a fixed, deduplicated warning code (e.g. `agui_tool_execution_custom_fallback`, `agui_structured_output_custom_fallback`, `agui_state_checkpoint_custom_fallback`). A paused turn is coerced to `CUSTOM` + `RUN_FINISHED` with `agui_paused_turn_coerced_to_run_finished` — AG-UI has no paused-run event. These fallback codes are asserted by name in the conformance plan, so changing them is a conformance change, not a refactor.

## What conformance pins down

`spec/conformance/streaming/plans/event-stream-core.json` asserts the exact canonical event order for a completed tool turn — from `turn.start` through the tool-call iteration, the tool execution, the final text iteration, to `turn.end`, 25 events in a fixed sequence — plus the corresponding exact AG-UI projection sequence and its expected warning set, failure and pause scenarios, and an eager-subscription check proving a tee'd branch sees the same first event as a direct consumer. `event-stream-sse.json` pins the SSE decode and wire-compliance behavior described above; `event-stream-extended.json` covers additional scenarios. Implementation-side, these operations are answered by the framework conformance adapter (`typescript/conformance-adapter/src/framework-adapter-event-stream-sse.ts` and siblings), which calls the real `toSseFrames`/`toAgUiEvents`/`decodeSseStream` — per the repo rule, event-stream conformance uses implementation-emitted events, never fixture replay dressed up as proof.

## A complete host consumption example

`typescript/host/repl/src/lib/repl-host.ts` projects one execution three ways, claiming all branches up front:

```ts
const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(handle.events(), 3);
const [canonical, sse, agui] = await Promise.all([
  collect(canonicalBranch),
  collect(toSseFrames(sseBranch)),
  collect(toAgUiEvents(aguiBranch)),
]);
```

The SDK itself contains no streaming code — `createTuvren` (`typescript/sdk/src/lib/create-tuvren.ts`) assembles the runtime whose `executeTurn(...)` yields the handle; everything downstream of `handle.events()` is composed from the three streaming packages above.

## See also

- `docs/guides/add-a-runner.md` §3 — the runner-side emission rules (what a runner may and may not emit).
- `docs/guides/publishing-and-adopter-onboarding.md` — the host-facing install/first-Turn walkthrough this guide's consumption patterns build on.
- `docs/KrakenFrameworkSpecification.md` §6 — the normative streaming architecture text.
- `spec/streaming/README.md` — the streaming port's authority map.
