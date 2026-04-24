# Kraken Framework Specification

**Version**: v0.17
**Status**: Authoritative
**Basis**: Kernel Specification v0.9 (frozen)

Read this after the kernel specification. This document is authoritative for the initial Kraken framework driver behavior built on the frozen kernel.

Kraken is the execution engine inside Tuvren Runtime. This specification defines the engine-layer framework and driver semantics, not the public product namespace.

This is the single authoritative specification for the shared framework semantic model plus the initial ReAct Driver execution semantics. It does not claim that ReAct is the only possible Kraken driver. Future drivers may reuse the shared framework types and kernel primitives defined here while specifying different control-flow behavior. The companion rationale document is explanatory only.

---

## 0. Driver Framing

Kraken is organized in three semantic layers:

- **Kernel:** durable mechanism only
- **Framework:** shared runtime model, host-facing concepts, and integration vocabulary built on the kernel
- **Driver:** one concrete execution model implemented over the shared framework and kernel primitives

This document therefore serves two purposes:

- define the shared semantic types that drivers and framework integrations rely on
- define the first production-depth driver, the **ReAct Driver**

Unless a section says otherwise, terms such as messages, tool calls, structured output, approvals, event shapes, and context manifests are framework-level semantics. Iterative loop behavior, runtime resolution precedence in the active agent loop, and model-tool-feedback execution are specified here as the ReAct Driver baseline rather than as the only possible Kraken execution model.

---

## 1. Shared Types

All shared framework types and all types used by the initial ReAct Driver are defined here.

### 1.1 Content Parts

Atomic units of conversational content. Strict discriminated union on `type`.

```
TextPart
├─ type: "text"
├─ text: string
└─ providerMetadata?: Record<string, unknown>

ReasoningPart
├─ type: "reasoning"
├─ text: string                     // empty string when fully redacted
├─ redacted: boolean
└─ providerMetadata?: Record<string, unknown>

ToolCallPart
├─ type: "tool_call"
├─ callId: string                   // framework-generated linking ID
├─ name: string
├─ input: unknown                   // always parsed, never JSON string
└─ providerMetadata?: Record<string, unknown>

ToolResultPart
├─ type: "tool_result"
├─ callId: string                   // links to ToolCallPart.callId
├─ name: string
├─ output: unknown
├─ isError?: boolean
└─ providerMetadata?: Record<string, unknown>

FilePart
├─ type: "file"
├─ data: string | Uint8Array        // base64 or binary
├─ mediaType: string                // IANA media type
├─ filename?: string
└─ providerMetadata?: Record<string, unknown>

StructuredPart
├─ type: "structured"
├─ data: unknown                    // parsed structured data, never a raw string
├─ name?: string                    // schema/format identifier from the request
└─ providerMetadata?: Record<string, unknown>

ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | FilePart | StructuredPart
```

Design principles: one type per part (no bag-of-optional-fields). Tool call input is always parsed. Structured output data is always parsed. `callId` is framework-owned (provider-native IDs in `providerMetadata`). `providerMetadata` is structural — carries opaque tokens needed for multi-turn continuity (Anthropic’s `signature`, OpenAI’s `encrypted_content`, Google’s `thoughtSignature`). No provider-specific content types in the canonical model. Streaming is not in the content model — these types represent complete, durable content.

Structured output is assistant-authored structured data — a distinct content kind from freeform text and from tool use. It is not a tool call, does not require a tool result, and does not imply executable side effects. Tool calls remain for delegated actions and side effects. Structured output is model-generated data conforming to a requested schema.

### 1.2 Messages

```
NonEmptyArray<T> = [T, ...T[]]

TuvrenMessage =
  | { role: "system",    content: string }
  | { role: "user",      parts: NonEmptyArray<ContentPart> }
  | { role: "assistant", parts: NonEmptyArray<ContentPart>, providerMetadata?: Record<string, unknown> }
  | { role: "tool",      parts: NonEmptyArray<ToolResultPart> }
```

Separate `tool` role even though some providers merge tool results into user messages. Each adapter handles the merge or split.

### 1.3 InputSignal

Canonical inbound signal accepted by the framework and its drivers.

```
InputSignal
└─ parts: NonEmptyArray<ContentPart>  // Canonical inbound user content.
                                      // Extend only if a future extra is irreducible.
```

`InputSignal` is not a persisted message. The framework normalizes it into a `TuvrenMessage` during input incorporation. Empty `parts` arrays are invalid at the shared contract boundary.

### 1.4 Prompt and Response

```
RenderedToolDefinition
├─ name: string
├─ description: string
└─ inputSchema: JSONSchema

TuvrenModelConfig
├─ model?: string
├─ provider?: string
└─ settings?: Record<string, unknown>
```

`RenderedToolDefinition` is the provider-facing projection of a runtime tool definition. Runtime executable tool definitions do not cross the provider prompt boundary.

```
StructuredOutputRequest
├─ schema: JSONSchema               // the schema to request
├─ name?: string                    // optional identifier for the schema
└─ strict?: boolean                 // enforcement hint for providers that support native schema enforcement
```

`StructuredOutputRequest` is the provider-neutral contract for requesting schema-constrained model output. `schema` is the JSON Schema the response must satisfy. Draft-07 is the default dialect when `schema.$schema` is absent; schemas that use draft-2019-09 or draft-2020-12 keywords must declare the matching `$schema` URI so the framework validator can select the correct dialect. `name` is an optional identifier for the schema (mapped to provider-native name fields where applicable). `strict` is an enforcement hint — providers that support native structured output enforcement (OpenAI’s strict mode, Google’s `responseSchema`) apply it at generation time; providers that do not support native enforcement must either reject with a clear error or fall back through a documented compatibility path (e.g., schema-in-prompt instruction).

```
TuvrenPrompt
├─ messages: TuvrenMessage[]
├─ tools?: RenderedToolDefinition[]
├─ config?: TuvrenModelConfig
└─ responseFormat?: StructuredOutputRequest

TuvrenModelResponse
├─ parts: ContentPart[]
├─ finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter"
├─ usage?: { inputTokens: number, outputTokens: number }
└─ providerMetadata?: Record<string, unknown>
```

### 1.5 RuntimeResolution

The exhaustive type for runtime control flow outcomes in the shared framework model. The initial ReAct Driver maps its loop policy, extension verdicts, handoff detection, and error handling into this type.

```
RuntimeResolution =
  | { type: "continue_iteration" }
  | { type: "end_turn", reason: string }
  | { type: "pause", reason: string, approval: ApprovalRequest }
  | { type: "handoff", targetAgent: string, contextPlan: HandoffContextPlan }
  | { type: "fail", error: Error, fatality: "hard" | "soft" }
```

```
ContextEngineeringHelpers
├─ loadMessage(hash: Hash) → TuvrenMessage | null
├─ storeMessage(message: TuvrenMessage) → Hash
└─ storeMessages(messages: TuvrenMessage[]) → Hash[]

ContextEngineeringContext
├─ messageHashes: Hash[]
├─ messages: TuvrenMessage[]
├─ manifest: ContextManifest
└─ helpers: ContextEngineeringHelpers

ContextEngineeringPlan
├─ action: string
└─ execute(ctx: ContextEngineeringContext) → Hash[]

HandoffContextPlan
├─ targetAgent: string
├─ reason: string
├─ mode: "preserve_trace" | "last_output_only" | string
├─ builder: HandoffContextBuilder
└─ sourceContext: HandoffSourceContext

HandoffSourceContext
├─ messages: TuvrenMessage[]
├─ handoffIntent: { targetAgent: string, reason?: string, payload?: unknown }
├─ sourceAgent: AgentConfig
├─ targetAgent: AgentConfig
├─ manifest: ContextManifest
└─ helpers: ContextEngineeringHelpers

type HandoffContextBuilder = (ctx: HandoffSourceContext) → Hash[]
```

`ContextEngineeringPlan` is the framework contract for persistent transformation of the `messages` path. The framework owns the Run lifecycle, `tree.create`, checkpointing, manifest recomputation, and Turn/Branch advancement around the plan.

The handoff builder returns the complete replacement hash array for the active `messages` path. RuntimeResolution carries the plan declaratively. The framework executes the builder during a dedicated handoff context engineering Run (§10.4), not at resolution time.

**Mapping from control mechanisms:**

| Source                                                 | Resolution                         |
| ------------------------------------------------------ | ---------------------------------- |
| Loop policy `continue: true, executeTools: true`       | `continue_iteration`               |
| Loop policy `continue: false`                          | `end_turn`                         |
| Extension verdict `"endTurn"`                          | `end_turn`                         |
| Extension verdict `"hardFail"`                         | `fail(hard)`                       |
| Extension verdict `"softFail"`                         | `fail(soft)`                       |
| Tool approval required (via tool policy or aroundTool) | `pause(approval: ApprovalRequest)` |
| Handoff intent detected                                | `handoff`                          |
| Model call failure (retries exhausted)                 | `fail(hard)`                       |
| Max iterations exceeded                                | `end_turn("max_iterations")`       |

**Resolution precedence**: `fail(hard) > pause > handoff > end_turn > fail(soft) > continue_iteration`. `fail(soft)` is uniformly non-terminal: it records the error condition, may emit events and state effects, and does not by itself terminate the Turn or iteration loop. When extension verdicts, loop policy, and handoff detection all produce resolutions in the same iteration, the highest-precedence resolution wins.

**Kernel verdict algebra**: The kernel provides a five-verdict algebra (`Abort > Pause > Modify > Retry > Proceed`). The initial ReAct Driver currently consumes three of these (`Abort` variants via intercept verdicts, `Pause` via tool approval, `Proceed` as the default). The kernel's `Modify` and `Retry` verdicts are reserved for future framework or driver use.

### 1.6 ContextManifest

Lightweight index for O(1) context engineering decisions. Staged alongside messages on every checkpoint.

```
ContextManifest
├─ messageCount: number
├─ byRole:
│    user: number
│    assistant: number
│    tool: number
│    system: number
├─ toolCalls:
│    total: number
│    byName: Record<string, number>
├─ toolResults:
│    total: number
│    byName: Record<string, number>
├─ lastUserMessageIndex: number
├─ lastAssistantMessageIndex: number
├─ turnBoundaries: number[]          // message indexes where user turns begin
├─ tokenEstimate: number
└─ extensions: Record<string, unknown>  // extension-owned persisted namespaces;
                                        // sharedExports are projected from
                                        // declared export keys over this state
```

Extensions own their namespace within `extensions`. The core manifest never reads extension data. The manifest is updated by the framework as a side effect of staging messages — computing deltas is arithmetic from data the framework already holds. Context engineering and handoff rebuild the manifest's core message-derived indexes, but preserve `extensions` unchanged unless an explicit context engineering action says otherwise.

### 1.7 ApprovalRequest and ApprovalResponse

```
ApprovalRequest
├─ toolCalls: PendingToolCall[]
└─ completedResults: ToolResultPart[]

PendingToolCall
├─ callId: string
├─ name: string
├─ input: unknown
├─ decisions: string[]
└─ message: string

ApprovalResponse
└─ decisions: ApprovalDecision[]

ApprovalDecision
├─ callId: string                    // must match a PendingToolCall.callId
├─ type: "approve" | "edit" | "reject" | string
├─ editedInput?: unknown
└─ message?: string                  // optional operator commentary attached to the resulting ToolResultPart
```

Each approval decision applies to exactly one pending tool call, linked by framework `callId`.

| Decision  | Framework action                                                   |
| --------- | ------------------------------------------------------------------ |
| `approve` | Execute with original input                                        |
| `edit`    | Execute with `editedInput`                                         |
| `reject`  | Produce error ToolResultPart with message                          |
| custom    | Treated as reject with decision type and message surfaced to model |

`ApprovalDecision.message` remains optional for every decision type. When present, it is incorporated into the resulting `ToolResultPart` produced by the approval outcome; it does not create a separate `user` message and is not treated as steering. For `approve` and `edit`, the message is attached to the executed tool result. For `reject` and custom decisions, the message is attached to the synthesized error `ToolResultPart`. When `reject` or a custom decision omits `message`, the framework MUST still synthesize a coherent error `ToolResultPart` using a framework-defined default explanation.

### 1.8 TuvrenStreamEvent

The internal event vocabulary. Discriminated union on `type`. Every event carries `type`, `timestamp`, and optional `source` (for multi-agent attribution).

```
EventSource
├─ agent: string
├─ driver?: string
├─ workerId?: string
└─ threadId?: string
```

**Lifecycle events**: `turn.start`, `turn.end`, `iteration.start`, `iteration.end`

**Model output events** (streaming): `message.start`, `text.delta`, `text.done`, `reasoning.delta`, `reasoning.done`, `file.done`, `structured.delta`, `structured.done`, `tool_call.start`, `tool_call.args_delta`, `tool_call.done`, `message.done`

**Tool execution events**: `tool.start`, `tool.result`

**Control events**: `approval.requested`, `approval.resolved`, `steering.incorporated`, `error`

**State events**: `state.snapshot`, `state.checkpoint`

**Custom events**: `custom` (extension-defined `name` and `data`)

Twenty-five event types in six groups. Complete type definitions:

```
TurnStartEvent         { type: "turn.start", turnId, threadId, resumedFrom?: string, timestamp }
TurnEndEvent           { type: "turn.end", turnId, status: "completed"|"paused"|"failed", timestamp }
IterationStartEvent    { type: "iteration.start", iterationCount, timestamp }
IterationEndEvent      { type: "iteration.end", iterationCount, timestamp }

MessageStartEvent      { type: "message.start", messageId, role: "assistant", timestamp }
TextDeltaEvent         { type: "text.delta", messageId, delta: string, timestamp }
TextDoneEvent          { type: "text.done", messageId, text: string, timestamp }
ReasoningDeltaEvent    { type: "reasoning.delta", messageId, delta: string, timestamp }
ReasoningDoneEvent     { type: "reasoning.done", messageId, timestamp }
FileDoneEvent          { type: "file.done", messageId, data: string|Uint8Array,
                         mediaType: string, filename?: string, timestamp }
StructuredDeltaEvent   { type: "structured.delta", messageId, delta: string, timestamp }
StructuredDoneEvent    { type: "structured.done", messageId, data: unknown, name?: string, timestamp }
ToolCallStartEvent     { type: "tool_call.start", messageId, callId, name, timestamp }
ToolCallArgsDeltaEvent { type: "tool_call.args_delta", callId, delta: string, timestamp }
ToolCallDoneEvent      { type: "tool_call.done", callId, name, input: unknown, timestamp }
MessageDoneEvent       { type: "message.done", messageId, finishReason, usage?, timestamp }

ToolExecutionStartEvent  { type: "tool.start", callId, name, input: unknown, timestamp }
ToolExecutionResultEvent { type: "tool.result", callId, name, output: unknown, isError, timestamp }

ApprovalRequestedEvent   { type: "approval.requested", request: ApprovalRequest, timestamp }
ApprovalResolvedEvent    { type: "approval.resolved", response: ApprovalResponse, timestamp }
SteeringIncorporatedEvent { type: "steering.incorporated", messageId, timestamp }
ErrorEvent               { type: "error", error: { message, code?, details? }, fatal: boolean, timestamp }

StateSnapshotEvent     { type: "state.snapshot", manifest: ContextManifest, timestamp }
StateCheckpointEvent   { type: "state.checkpoint", turnNodeHash, iterationCount, timestamp }

CustomEvent            { type: "custom", name: string, data: unknown, timestamp }
```

`TurnStartEvent.resumedFrom`: When present, contains the TurnNode hash of the pause point. Protocol adapters use this to distinguish fresh Turns from resumed Turns. Absent means fresh Turn.

**Ordering guarantees**: `message.start` precedes all content events for that message. `text.delta` events arrive in order. `structured.delta` events arrive in order; `structured.done` follows all `structured.delta` events for that message. `file.done` is emitted as one complete visible content event for that file and must occur between `message.start` and `message.done`. `tool_call.start` precedes `tool_call.args_delta`. `message.done` follows all content events. Note: `tool_call.*` describes what the model requests (args streaming). `tool.*` describes what the framework executes. These are two different moments.

**Contract tiers**: Kraken's internal event vocabulary is intentionally richer than any single external protocol. Protocol adapters consume this canonical stream and bridge it into AG-UI, ACP, OpenResponses-style transports, or any other host protocol.

**Required core events**: `turn.start`, `turn.end`, `iteration.start`, `iteration.end`, `message.start`, `text.delta`, `text.done`, `reasoning.delta`, `reasoning.done`, `file.done`, `structured.delta`, `structured.done`, `tool_call.start`, `tool_call.args_delta`, `tool_call.done`, `message.done`, `tool.start`, `tool.result`, `approval.requested`, `approval.resolved`, `steering.incorporated`, and `error`. When their corresponding runtime moments occur, the framework MUST emit them.

**Optional standardized events**: `state.snapshot`, `state.checkpoint`, and `custom`. Their shapes and meanings are standardized, but hosts and protocol adapters MUST tolerate their absence. They are observability and integration affordances, not correctness dependencies.

---

## 2. State Schema

### 2.1 Default Schema

```
DefaultAgentSchema
├─ schemaId: "tuvren.agent.v1"
├─ paths:
│    messages              ordered     // conversation in natural order
│    context.manifest      single      // structural index
│    turn.lineage          single      // semantic-turn lineage metadata
│    runtime.status        single      // execution state metadata
│
└─ incorporationRules:
     message               → messages
     context_manifest      → context.manifest
     turn_lineage          → turn.lineage
     runtime_status        → runtime.status
```

Four paths. Four objectTypes. Four incorporation rules.

### 2.2 Messages Path (ordered)

Each Object is a serialized `TuvrenMessage`. Array order IS the conversation order.

One message = one Object. A message with three tool calls is still one Object. Staged as `objectType: "message"`.

### 2.3 Context Manifest Path (single)

Staged as `objectType: "context_manifest"`. Each new manifest replaces the previous one. Cost: one extra Object per checkpoint. Maintained by the framework as a side effect of staging messages.

When context engineering restructures the messages path via `tree.create`, the manifest is rebuilt from the new hash array and included in the new TurnTree.

### 2.4 Turn Lineage Path (single)

```
TurnLineage
└─ activeTurnId: string
```

`turn.lineage` is framework-owned semantic lineage metadata. It is initialized during input incorporation for a new Turn and then preserved across later checkpoints on the same Turn. When the caller omits `parentTurnId`, the framework infers the active semantic parent from the Branch Head's `turn.lineage.activeTurnId`. It is not used for context assembly or host status display.

### 2.5 Runtime Status Path (single)

```
RuntimeStatus
├─ state: "running" | "paused" | "completed" | "failed"
├─ activeAgent?: string
├─ pauseReason?: string
├─ partial?: boolean                 // true when assistant output was interrupted
```

**Lifecycle**: The framework stages an updated RuntimeStatus at Turn start (`running`, `activeAgent` set from the active `AgentConfig`), on approval decision execution (`running` restaged before any resumed work proceeds), on pause (`paused`, `pauseReason` set), on handoff (`running`, `activeAgent` updated), and at Turn end (`completed` or `failed`). It is not staged on every iteration — only on state transitions. Used by the framework for execution decisions, by hosts for status display, and by orchestration for current execution ownership. Not consumed by context assembly for prompt construction.

`runtime.status` is framework-owned Turn execution lifecycle metadata. It is persisted through the schema, not stored as a Kernel Turn field. Turn-final `completed` / `failed` status is durably committed through a dedicated framework finalization checkpoint (§4.11). It is not a general telemetry bag; richer observability belongs to higher layers.

`partial`: Set to `true` when a cancellation or other recoverable interruption stages a partial assistant message before the Run fails. Hard process crashes during model streaming may still lose in-memory accumulator state and re-execute from scratch. Extensions and host code can use this flag to detect incomplete responses that were durably staged.

### 2.6 Context Engineering Operations

All produce new TurnTrees via `tree.create`. Original messages are never mutated.

**Pruning**: Remove messages by index — filter the hash array, build new tree.

**Summarization**: Replace message range with summary — insert summary hash, remove old hashes, build new tree.

**Compaction**: Replace verbose tool results with compact versions.

All operations use `tree.create` with a base tree. Only changed path hashes recompute. The kernel handles structural sharing.

---

## 3. Provider Contract

### 3.1 Interface

```
TuvrenProvider
├─ id: string
├─ generate(prompt: TuvrenPrompt) → Promise<TuvrenModelResponse>
└─ stream(prompt: TuvrenPrompt) → AsyncIterable<ProviderStreamChunk>
```

`generate` returns a complete response. `stream` yields normalized intermediate chunks. Authentication, retry, rate limiting, timeout, HTTP config are internal to each adapter.

The provider never generates framework execution identity (`messageId`, `timestamp`). Those are driver concerns. The provider translates between its native wire format and the normalized `ProviderStreamChunk` / `TuvrenModelResponse` types.

### 3.2 ProviderStreamChunk

The normalized intermediate type yielded by `provider.stream()`. Carries content deltas and tool call fragments without framework identity.

```
ProviderStreamChunk =
  | { type: "text_delta", text: string }
  | { type: "reasoning_delta", text: string, signature?: string }
  | { type: "reasoning_done" }
  | { type: "tool_call_start", providerCallId: string, name: string }
  | { type: "tool_call_args_delta", providerCallId: string, delta: string }
  | { type: "tool_call_done", providerCallId: string, name: string, input: unknown }
  | { type: "structured_delta", delta: string }
  | { type: "structured_done", data: unknown, name?: string }
  | { type: "finish", finishReason: string, usage?: { inputTokens: number, outputTokens: number },
      providerMetadata?: Record<string, unknown> }
  | { type: "error", error: unknown }
```

`providerCallId` is the provider’s native tool call ID (Anthropic’s `toolu_...`, OpenAI’s `call_...`, Google’s optional `id`). The driver maps this to a framework-generated `callId` and preserves the provider ID in `providerMetadata` on the resulting `ToolCallPart`.

`signature` on `reasoning_delta` carries Anthropic’s thinking continuity token. The driver preserves it in `providerMetadata` on the resulting `ReasoningPart`.

### 3.3 StreamAccumulator

The accumulator builds a complete `TuvrenModelResponse` from provider stream chunks. The driver uses it to bridge the live path (immediate events) and the durable path (complete response for staging).

```
StreamAccumulator
├─ absorb(chunk: ProviderStreamChunk): void
├─ finalize(): TuvrenModelResponse
├─ hasContent(): boolean
```

`absorb` processes one chunk: appends text deltas, accumulates tool call arguments, accumulates structured output deltas, captures usage and metadata. `finalize` produces the complete `TuvrenModelResponse` with all parts assembled, arguments parsed, structured output parsed into `StructuredPart.data`, and metadata merged. On normal stream completion, unfinished structured-output and tool-call parts are provider stream errors; only cancellation partial finalization may preserve incomplete accumulated content. If structured output cannot be parsed (malformed JSON or equivalent), `finalize` produces an error response. `hasContent` returns whether any chunks have been absorbed — used by the driver to detect aroundModel short-circuits that need synthetic event generation (§6.5).

### 3.4 Adapter Strategy

**Direct adapters** implement `TuvrenProvider` by calling a provider’s API directly.

**Bridge adapters** implement `TuvrenProvider` by wrapping another framework’s provider integration (e.g., Vercel AI SDK).

Both produce identical behavior from the framework’s perspective. Package topology:

```
@tuvren/core-types                         zero dependencies, types only
@tuvren/provider-anthropic            direct, depends on @anthropic-ai/sdk
@tuvren/provider-openai               direct, depends on openai
@tuvren/provider-google               direct, depends on @google/genai
@tuvren/provider-vercel               bridge, depends on @ai-sdk/*
@tuvren/provider-langchain            bridge, depends on @langchain/*
```

Each adapter implements two conversion directions: outbound (`TuvrenPrompt → provider payload`) and inbound (`provider response/stream → TuvrenModelResponse/ProviderStreamChunk`). Typically 50–150 lines per direction.

### 3.5 Structured Output

Structured output is model-authored structured data requested via `StructuredOutputRequest` on the prompt and returned as a `StructuredPart` on the assistant message. This section defines the full contract: adapter normalization, streaming behavior, validation, and failure.

#### Adapter Normalization

Provider adapters normalize provider-native structured responses into `StructuredPart` before durable staging. The canonical model never exposes provider-specific structured output types.

Outbound: when `TuvrenPrompt.responseFormat` is set, the adapter maps `StructuredOutputRequest` to the provider's native structured output mechanism (OpenAI's `response_format`, Google's `generationConfig.responseSchema`, or equivalent). When the provider does not support native structured output, the adapter must either reject with a clear error identifying the unsupported capability, or fall back through a documented compatibility path (e.g., injecting the schema into the system prompt as an instruction). The choice between rejection and fallback is adapter-specific and must be documented per adapter.

Inbound: the adapter maps the provider's structured response into a `StructuredPart` with `data` containing the parsed result and `name` carrying the schema identifier from the request. Provider-specific structured output metadata (e.g., refusal reasons, schema enforcement details) is preserved in `providerMetadata`.

#### Streaming Behavior

Structured output follows the same two-path model as text content:

**Live path**: Provider stream chunks of type `structured_delta` are translated into `structured.delta` framework events and yielded to the output iterable immediately. The consumer sees the raw structured content building incrementally. When the provider emits `structured_done`, the driver yields `structured.done` with the final parsed data. If a provider emits `structured_done` without any prior `structured_delta`, the driver first synthesizes a `structured.delta` from the serialized final data so the live stream still satisfies the canonical delta/done contract.

**Durable path**: The same chunks are accumulated by the `StreamAccumulator`. On `finalize`, the accumulator parses the accumulated content into a `StructuredPart` with the complete parsed `data`. This complete part is what gets staged as part of the durable assistant message.

Both paths converge on the same durable `StructuredPart` representation. The streaming and non-streaming execution paths produce identical durable content.

When `provider.generate()` is used instead of `provider.stream()`, the driver synthesizes `structured.delta` (with the full serialized content) and `structured.done` events from the complete response, consistent with the non-streaming fallback pattern (§6.3).

#### Validation

**Parse responsibility**: The `StreamAccumulator` parses raw structured output into `StructuredPart.data`. If parsing fails (malformed JSON or equivalent), the accumulator produces an error response and the driver treats it as a model call failure.

**Schema validation**: After the `aroundModel` chain returns (whether it called `next` or not), the driver validates the `StructuredPart.data` against the `schema` from the prompt's `StructuredOutputRequest`. The validator uses draft-07 when `$schema` is absent or declares draft-07, draft-2019-09 when `$schema` declares that dialect, and draft-2020-12 when `$schema` declares that dialect. Dynamic request schemas are compiled in an isolated validator context so repeated `$id` values from different host requests do not collide across turns. Unsupported `$schema` dialects and schema compilation failures produce `structured_output_validation`. Provider-side enforcement via the `strict` flag is the first line of defense — providers that support native schema enforcement apply it at generation time. The framework validates after receipt regardless. This is consistent with the "framework always normalizes, never trusts the wire" principle applied to tool call argument parsing.

**Failure behavior**: Schema mismatch produces `fail(hard)` with error code `structured_output_validation`. This is a defined runtime outcome, not a silent acceptance or best-effort parse. The error is staged and the Run fails through the standard `failIteration` path. The model does not see the invalid output on the next iteration — the Turn terminates.

#### Lifecycle

Structured output is ordinary assistant content. A `StructuredPart` lives on an assistant message's `parts` array alongside `TextPart`, `ReasoningPart`, or other content the model produced in the same response.

Structured output survives checkpointing, recovery, rollback, handoff, and context engineering through the same mechanisms as any other content part. No special handling is required. Context assembly includes structured outputs in history unless explicitly removed by context engineering policy. Handoff context builders can read structured outputs from message history through the standard `ContextEngineeringHelpers`.

No kernel primitive or syscall changes are required. Structured output is stored as part of serialized `TuvrenMessage` Objects in the content-addressed store.

---

## 4. Execution Model

### 4.1 Turn Lifecycle

```
Signal arrives
  │
  ├─ Phase 1: Incorporate Input (always)
  │    One Run, one checkpoint
  │    User message + manifest enter the messages and manifest paths
  │
  ├─ beforeTurn hooks (once)
  │
  └─ Phase 2: Iteration Loop
       │
       for each iteration:
       │
       ├─ a. Steering check (inject user message if steering available)
       ├─ b. beforeIteration hooks (may trigger context engineering)
       ├─ c. Context engineering check (manifest → policy, or extension CE plan)
       │    If action needed: separate Run with tree.create → completeStep(treeHash)
       └─ d. Agent iteration
            One Run, one checkpoint
            Context assembly → systemPrompt collection →
            aroundModel(model call) → [aroundTool(tool execution)] →
            stage results → checkpoint → afterIteration hooks
            │
            └─ Resolution determines: continue, end, pause, handoff, or fail
       │
       Phase 3: Finalize Turn
       afterTurn hooks (once, non-durable on terminal paths)
       framework finalization checkpoint for runtime.status
       turn.updateHead → return result via event stream
```

**Structural rules:**

- One Run per iteration. The loop is the driver, not the step sequence.
- One Run per context engineering action. Always separate from the iteration Run.
- Input incorporation is always the first Run.
- Context engineering is a per-iteration check, not a per-turn phase. The manifest drives the decision. O(1).
- Extension hooks fire within existing framework phases — they do not create their own Runs or checkpoint boundaries.
- `beforeTurn` fires exactly once per semantic Turn, after input incorporation and before the first iteration of the first handle.
- `afterTurn` fires exactly once per semantic Turn, only after the iteration loop reaches a terminal non-paused stop. A `beforeTurn` short-circuit does not trigger `afterTurn`.
- Approval resume continues the same Turn and MUST NOT re-run Turn-level hooks.
- `pause` is approval-only. A paused Turn represents approval-gated continuation of already-requested tool work.
- After any Run completion that produces a checkpointed TurnNode, the framework MUST advance the Turn head via `turn.updateHead(turnId, turnNodeHash)` before starting the next Run on that Turn.

### 4.2 Phase 1: Incorporate Input

```
function incorporateInput(signal, turnId, branchId, schemaId, agentName?):

  inputRunId = generateId()
  branch = kernel.branch.get(branchId)

  kernel.run.create(inputRunId, turnId, branchId, schemaId,
                    branch.headTurnNodeHash,
                    [{ id: "incorporate_input", deterministic: false, sideEffects: false }])

  kernel.run.beginStep(inputRunId, "incorporate_input")

  userMsg = buildUserMessage(signal)
  kernel.staging.stage(inputRunId, serialize(userMsg), "msg_user", "message", completed)

  manifest = readManifest(branch.headTurnNodeHash)
  manifest = updateManifest(manifest, [userMsg])
  kernel.staging.stage(inputRunId, serialize(manifest), "manifest", "context_manifest", completed)

  lineage = { activeTurnId: turnId }
  kernel.staging.stage(inputRunId, serialize(lineage), "turn_lineage", "turn_lineage", completed)

  status = { state: "running", activeAgent: agentName }
  kernel.staging.stage(inputRunId, serialize(status), "runtime_status", "runtime_status", completed)

  kernel.run.completeStep(inputRunId, "incorporate_input", storeEvent({ type: "input_received" }))
  kernel.run.complete(inputRunId, completed)
  kernel.turn.updateHead(turnId, latestHead())
```

### 4.3 Phase 2: Iteration Loop

```
function iterationLoop(turnId, branchId, schemaId, toolRegistry, config, steering?):

  iterationCount = 0
  activeConfig = config
  activeToolRegistry = toolRegistry
  carriedStateUpdates = {}

  while true:
    iterationCount++
    yield { type: "iteration.start", iterationCount, timestamp: now() }

    // ── Steering check ──
    if steering && steering.hasNext():
      incorporateSteering(steering.take(), turnId, branchId, schemaId)

    manifest = readManifest(latestHead())

    // ── beforeIteration hooks ──
    iterResult = runBeforeIterationHooks(activeConfig.extensions, manifest, iterationCount)
    pendingStateUpdates = mergeStateUpdates(carriedStateUpdates, iterResult.state ?? {})
    carriedStateUpdates = {}
    iterResolution = verdictToResolution(iterResult.verdict)
    if iterResolution == end_turn or iterResolution == fail(hard):
      return iterResolution
    if iterResolution == fail(soft):
      log soft failure and continue
    if iterResult.cePlan:
      executeCEAction(iterResult.cePlan, turnId, branchId, schemaId, pendingStateUpdates)
      pendingStateUpdates = {}
      manifest = readManifest(latestHead())

    // ── Context engineering check (contract-level, after extension CE) ──
    cePlan = activeConfig.contextPolicy.evaluate(manifest, iterationCount)
    if cePlan.action != "none":
      executeCEAction(cePlan, turnId, branchId, schemaId, pendingStateUpdates)
      pendingStateUpdates = {}
      manifest = readManifest(latestHead())

    // ── Agent iteration ──
    resolution = executeIteration(
      turnId,
      branchId,
      schemaId,
      activeToolRegistry,
      activeConfig,
      iterationCount,
      pendingStateUpdates
    )

    manifest = readManifest(latestHead())

    // ── afterIteration hooks ──
    afterResult = runAfterIterationHooks(activeConfig.extensions, manifest, resolution, iterationCount)
    if afterResult.verdict:
      resolution = composeResolution(resolution, afterResult.verdict)
    carriedStateUpdates = afterResult.state ?? {}

    if iterationCount >= activeConfig.maxIterations && resolution.type == "continue_iteration":
      resolution = { type: "end_turn", reason: "max_iterations" }

    yield { type: "iteration.end", iterationCount, timestamp: now() }

    match resolution:
      continue_iteration → continue loop
      end_turn           → break
      pause              → break (Branch blocked)
      handoff            → ({ activeConfig, activeToolRegistry } =
                             applyHandoff(resolution.contextPlan, turnId, branchId, schemaId, carriedStateUpdates)),
                             carriedStateUpdates = {},
                             continue loop
      fail(hard)         → break
      fail(soft)         → log error, continue loop

  return resolution
```

### 4.4 Steering Injection

Steering allows user message injection between iterations without cancelling in-progress work.

```
function incorporateSteering(steerSignal, turnId, branchId, schemaId):
  // Same pattern as incorporateInput: separate Run, stage user message + manifest, checkpoint
```

**Timing**: After previous iteration’s checkpoint, before beforeIteration hooks. **What the model sees**: Steering appears as a user message after the most recent tool results. **No cancellation**: Waits for current iteration to complete.

**Validity**: Steering is only accepted while a Turn is running (between iterations). The host’s `steer()` call is rejected if the Turn is paused or completed.

On successful incorporation, the framework MUST emit `steering.incorporated` after the steering checkpoint commits and before the next iteration proceeds.

### 4.5 Context Engineering Action

Same Run lifecycle pattern as §4.2. One Run with step `"context_engineering"` (deterministic: false, sideEffects: false).

```
function executeCEAction(plan, turnId, branchId, schemaId, pendingExtensionStateUpdates = {}):
  // create Run, beginStep

  branch = kernel.branch.get(branchId)
  currentTreeHash = kernel.node.get(branch.headTurnNodeHash).turnTreeHash
  msgHashes = kernel.tree.resolve(currentTreeHash, "messages")
  messages = readMessages(branch.headTurnNodeHash)
  manifest = readManifest(branch.headTurnNodeHash)

  ceContext = {
    messageHashes: msgHashes,
    messages,
    manifest,
    helpers: {
      loadMessage: (hash) => readMessageByHash(hash),
      storeMessage: (message) => kernel.store.put(serialize(message)),
      storeMessages: (messages) => messages.map(msg => kernel.store.put(serialize(msg)))
    }
  }

  newMsgHashes = plan.execute(ceContext)

  newManifest = rebuildManifest(newMsgHashes, kernel, {
    preserveExtensionsFrom: manifest.extensions,
    applyExtensionStateUpdates: pendingExtensionStateUpdates
  })
  manifestHash = kernel.store.put(serialize(newManifest))

  newTreeHash = kernel.tree.create(schemaId, {
    "messages": newMsgHashes,
    "context.manifest": manifestHash
  }, currentTreeHash)

  eventHash = storeEvent({ type: "context_engineering_applied", action: plan.action })
  kernel.run.completeStep(ceRunId, "context_engineering", eventHash, undefined, newTreeHash)
  kernel.run.complete(ceRunId, completed)
  kernel.turn.updateHead(turnId, latestHead())
```

### 4.6 Agent Iteration

```
function executeIteration(turnId, branchId, schemaId, toolRegistry, config, iterationCount, pendingExtensionStateUpdates = {}):

  // create Run with step "iterate" (deterministic: false, sideEffects: true), beginStep

  function failIteration(error, fatality = "hard"):
    stageIterationErrorIfNeeded(iterRunId, error, fatality)
    completion = kernel.run.complete(iterRunId, failed,
      storeEvent({ type: "iteration_failed", message: error.message, fatality }))
    if completion.turnNodeHash:
      kernel.turn.updateHead(turnId, completion.turnNodeHash)
    return { type: "fail", error, fatality }

  // ── Context assembly ──
  currentHead = kernel.branch.get(branchId).headTurnNodeHash
  messages = readMessages(currentHead)
  manifest = readManifest(currentHead)
  stagedMessages = []
  iterationStateUpdates = pendingExtensionStateUpdates

  // ── System prompt collection (base + extension contributions) ──
  systemPrompts = collectSystemPrompts(config.extensions, manifest, iterationCount)
  renderedTools = toolRegistry.toDefinitions()
  prompt = renderer.render(messages, renderedTools, config, systemPrompts)

  // ── Model call through aroundModel chain (§6.2, §9.5) ──
  modelResult = await executeModelCall(iterRunId, prompt, config, iterationCount)
  response = modelResult.response
  iterationStateUpdates = mergeStateUpdates(iterationStateUpdates, modelResult.state ?? {})

  // ── Capture handoff intent before durable staging ──
  handoffIntents = extractHandoffIntents(response.parts)
  if handoffIntents.length > 1:
    return failIteration(new Error("invalid_handoff_composition: multiple handoff intents in one response"))

  if handoffIntents.length == 1 && extractNonHandoffToolCalls(response.parts).length > 0:
    return failIteration(new Error("invalid_handoff_composition: handoff may not be combined with executable tool calls"))

  handoffIntent = handoffIntents[0] ?? null
  assistantParts = stripHandoffIntent(response.parts)

  // ── Stage assistant message ──
  if assistantParts.length > 0:
    assistantMsg = { role: "assistant", parts: assistantParts,
                     providerMetadata: response.providerMetadata }
    kernel.staging.stage(iterRunId, serialize(assistantMsg),
                        "msg_asst_" + iterationCount, "message", completed)
    stagedMessages.push(assistantMsg)

  // ── Loop policy → resolution composition ──
  decision = config.loopPolicy.evaluate({ ...response, parts: assistantParts }, manifest, iterationCount)
  toolCalls = extractToolCalls(response).filter(call => !isHandoffCall(call))
  if toolCalls.length > 0 && decision.continue && !decision.executeTools:
    return failIteration(new Error("invalid_loop_policy"))

  resolution = handoffIntent
    ? { type: "handoff", targetAgent: handoffIntent.targetAgent,
        contextPlan: buildHandoffPlan(handoffIntent, messages, manifest, config) }
    : decisionToResolution(decision)

  if resolution.type == "fail" && resolution.fatality == "hard":
    return failIteration(resolution.error, "hard")

  // ── Tool execution (if resolution is continue_iteration and tools requested) ──
  if resolution.type == "continue_iteration" && decision.executeTools:
    dispatchContext = {
      turnId,
      branchId,
      iterationCount,
      runId: iterRunId,
      stageResult: async (result) => {
        const toolMsg = { role: "tool", parts: [result] }
        await kernel.staging.stage(
          iterRunId,
          serialize(toolMsg),
          "msg_tool_" + result.callId,
          "message",
          completed
        )
      }
    }
    executionResult = await toolExecutor.execute(toolCalls, dispatchContext)
    iterationStateUpdates = mergeStateUpdates(iterationStateUpdates, executionResult.state ?? {})

    if executionResult.approval:
      emit { type: "approval.requested", request: executionResult.approval, timestamp: now() }
      resolution = { type: "pause", reason: "approval_required",
                     approval: executionResult.approval }

    if executionResult.results.length > 0:
      stagedMessages.push(...executionResult.results.map(result => ({
        role: "tool",
        parts: [result]
      })))

  if resolution.type == "pause":
    status = { state: "paused", pauseReason: resolution.reason, activeAgent: config.name }
    kernel.staging.stage(iterRunId, serialize(status), "runtime_status", "runtime_status", completed)

  // ── Update manifest ──
  manifest = updateManifest(manifest, stagedMessages, iterationStateUpdates)
  kernel.staging.stage(iterRunId, serialize(manifest), "manifest", "context_manifest", completed)

  // ── Checkpoint ──
  kernel.run.completeStep(iterRunId, "iterate",
    storeEvent({ type: "iteration_completed", iteration: iterationCount }))

  if resolution.type == "pause":
    kernel.run.complete(iterRunId, paused, storeEvent({ type: "paused", reason: resolution.reason }))
  else:
    kernel.run.complete(iterRunId, completed)

  kernel.turn.updateHead(turnId, latestHead())

  return resolution
```

### 4.7 Complete Turn Protocol

```
function executeTurn(input):
  → ExecutionHandle

  signal = input.signal
  threadId = input.threadId
  branchId = input.branchId
  schemaId = input.schemaId
  driverId = input.driverId
  tools = input.tools
  config = input.config
  steering = input.steering
  parentTurnId = input.parentTurnId

  turnId = generateId()
  activeDriverId = driverId ?? resolveDefaultDriverId()
  activeDriver = getDriver(activeDriverId)

  function* driver():
    branch = kernel.branch.get(branchId)
    resolvedParentTurnId = parentTurnId ?? resolveParentTurnId(threadId, branchId)
    kernel.turn.create(turnId, threadId, branchId, resolvedParentTurnId, branch.headTurnNodeHash)
    activeConfig = config
    activeTools = tools ?? activeConfig.tools ?? []
    toolRegistry = buildToolRegistry(activeTools, activeConfig.extensions)
    enteredIterationLoop = false

    yield { type: "turn.start", turnId, threadId, timestamp: now() }

    incorporateInput(signal, turnId, branchId, schemaId, activeConfig.name)

    turnHookResult = runBeforeTurnHooks(activeConfig.extensions)
    turnHookResolution = verdictToResolution(turnHookResult?.verdict)
    if turnHookResolution == end_turn or turnHookResolution == fail(hard):
      resolution = turnHookResolution
    else if turnHookResolution == fail(soft):
      log soft failure
      enteredIterationLoop = true
      resolution = activeDriver.iterationLoop(turnId, branchId, schemaId, toolRegistry, activeConfig, steering)
    else:
      enteredIterationLoop = true
      resolution = activeDriver.iterationLoop(turnId, branchId, schemaId, toolRegistry, activeConfig, steering)

    if enteredIterationLoop && resolution.type != "pause":
      runAfterTurnHooks(activeConfig.extensions)

    if resolution.type != "pause":
      finalizeTurnStatus(turnId, branchId, schemaId, resolution)

    kernel.turn.updateHead(turnId, latestHead())
    yield { type: "turn.end", turnId, status: resolutionToStatus(resolution), timestamp: now() }

  return wrapAsHandle(driver(), turnId, branchId, steering, activeDriverId)
```

`executeTurn` returns an `ExecutionHandle` (§7.1), not a bare `AsyncIterable`. The handle wraps the internal driver generator. The `events()` method on the handle provides the iterable that drives execution.

`driverId` is optional. When omitted, the framework resolves its configured default driver before execution begins. In the current baseline, the default driver is ReAct. Hosts may pass an explicit `driverId` when they need a concrete driver instead of the configured default.

For a Thread's first semantic Turn, `parentTurnId` is `null`. For every subsequent semantic Turn, `parentTurnId` MUST identify the immediately previous semantic Turn on the active Branch and still belong to the same Thread. When the framework resolves this parent implicitly, the resolver must be branch-aware (`resolveParentTurnId(threadId, branchId)`), so branching and rollback do not make semantic lineage ambiguous. Approval resumes stay within the existing Turn and do not create a new Turn.

### 4.8 Pause and Resume

**Pause trigger**: Tool approval. A Turn pauses only when one or more requested tool calls are pending approval, whether that approval requirement came from the tool definition’s `approval` policy or from `aroundTool`.

Cancellation is not a pause trigger. While a Turn is running, user-initiated cancellation follows §6.10 and terminates the current Turn as `failed`. While a Turn is paused for approval, cancellation follows the approval-rejection semantics from §6.10 instead of forcing an automatic failed terminal state.

**Pause protocol**: Stage pending work (including completed tool results from a partial batch), `run.complete(runId, paused, eventHash)`. Reactive checkpoint captures all staged work. Branch is blocked until an approval decision is executed.

When a pause is triggered by tool approval, the framework MUST emit `approval.requested` before yielding `turn.end` with paused status.

#### Approval Resume

When a Turn is paused for tool approval, `resolveApproval` on the `ExecutionHandle` triggers the approval decision path. The `ApprovalResponse` is a control signal, not conversational content. Any optional `ApprovalDecision.message` is folded into the resulting `ToolResultPart` for that decision; it is not incorporated as a standalone `user` message.

Approval resume continues the existing Turn. `beforeTurn` and `afterTurn` are not re-fired.

```
function resumeFromApproval(approvalResponse, turnId, branchId, ...):
  → ExecutionHandle

  1. Close the paused Run and unblock the Branch
  2. Yield turn.start (with resumedFrom: pause TurnNode hash)
  3. Yield approval.resolved
  4. Create new Run with step "iterate"
  5. Stage runtime.status = { state: "running", activeAgent } before any resumed work proceeds
  6. Apply approval decisions → resume only unfinished tool calls through the full aroundTool chain;
     approval wrappers observe the prior decision for the exact call and pass through without re-requesting approval
  7. Stage tool results + manifest, checkpoint
  8. Re-enter iterationLoop from current Branch Head
  9. Yield turn.end

  return wrapAsHandle(driver(), turnId, branchId, steering)
```

Before resumed tool execution begins, the framework MUST durably restage `runtime.status` to `running` for the active Turn. This ensures the durable state surface reflects actual execution state throughout the decision path.

`resolveApproval(...)` returns a **new** handle. The old paused handle remains exhausted/inert as the completed paused execution token and must not remain a second active owner of further control flow. Once approval has been resolved, subsequent control calls on the old handle are invalid.

For `approve` and `edit` decisions, unfinished tool calls resume through the normal tool execution path. For `reject`, shared-core semantics require the canonical rejection `ToolResultPart` outcomes for the pending calls and then continue the same Turn through the normal iteration loop. The host chooses that explicit same-Turn rejection path by calling `resolveApproval(...)` with `reject` decisions; the paused-handle `cancel()` path remains the separate rejection-and-stop control surface described in §6.10.

At the kernel layer, closing a paused Run still uses the kernel's `paused -> failed` transition before the continuation Run begins. That is a Run-lifecycle bookkeeping step required by the kernel contract; it MUST NOT be interpreted as a Turn-level approval failure or as a contradiction of the framework's approval semantics.

### 4.9 Recovery Protocol

**Crash during input incorporation**: If TurnNode exists, input is durable — proceed. If not, re-incorporate from original signal.

**Crash during context engineering**: If TurnNode exists (completeStep succeeded), restructured state is durable. If not, re-run from unchanged messages path.

**Crash during iteration (before model call)**: Re-create iteration Run. Context assembly is deterministic.

**Crash during iteration (during model stream)**: Partial accumulator state is lost. Stream events already emitted are lost. Re-execute the model call from scratch. Provider streams are not resumable.

**Crash during iteration (after model call, before tools)**: Assistant output may survive as durable uncommitted staged work. If a TurnNode exists, the assistant message is committed history. If not, recovery reads staged results via `run.recover()` and either checkpoints them or re-executes from the last committed TurnNode. Unfulfilled tool calls are derived only from committed or recovered staged state, not assumed.

**Crash during iteration (mid tool execution)**: Completed tool results that were incrementally staged before the crash may survive as durable uncommitted staged work for individual `tool` messages. If a TurnNode exists, those results are committed history. If not, recovery reads them from `run.recover()`, skips completed tool calls by `callId`, and resumes only unfinished calls. The framework MUST NOT assume they were already incorporated into the `messages` path unless the checkpoint succeeded.

**Crash between iterations**: Clean state. Resume from current Branch Head.

### 4.10 Error Handling

**Model call failure**: Transport failures handled by provider adapter’s internal retry. If exhausted, produce `fail(hard)` resolution with error message staged.

**Tool execution failure**: Individual tool failures produce error ToolResultParts. Model sees the error and reasons about it. Tool failures never fail the Run.

**Max iterations exceeded**: Produces `end_turn("max_iterations")`. Run completes as `completed`, not `failed`.

### 4.11 Final Turn Status Checkpoint

Final Turn `completed` / `failed` status is durably committed by the framework through a dedicated finalization checkpoint. This is framework lifecycle behavior, not hook behavior. Paused Turns do not run this finalization step — `paused` status is already staged at the pause transition checkpoint inside the iteration Run.

```
function finalizeTurnStatus(turnId, branchId, schemaId, resolution):

  if resolution.type == "pause":
    return

  statusRunId = generateId()
  branch = kernel.branch.get(branchId)

  kernel.run.create(statusRunId, turnId, branchId, schemaId,
                    branch.headTurnNodeHash,
                    [{ id: "finalize_turn_status", deterministic: false, sideEffects: false }])

  kernel.run.beginStep(statusRunId, "finalize_turn_status")

  status = {
    state: resolutionToStatus(resolution)
  }

  kernel.staging.stage(statusRunId, serialize(status),
                      "runtime_status_final", "runtime_status", completed)

  kernel.run.completeStep(statusRunId, "finalize_turn_status",
    storeEvent({ type: "turn_status_finalized", status: status.state }))
  kernel.run.complete(statusRunId, completed)
  kernel.turn.updateHead(turnId, latestHead())
```

This finalization step is independent of terminal hook outputs. `afterTurn` remains non-durable on terminal paths. The finalization checkpoint MUST commit and the Turn head MUST advance before `turn.end` is emitted. Any non-paused terminal Turn resolution — including `beforeTurn` short-circuits — MUST durably finalize `runtime.status` through this step before `turn.end` is emitted.

---

## 5. Contracts

Five pluggable contracts called at defined points.

### 5.1 Context Policy

```
contextPolicy.evaluate(manifest: ContextManifest, iterationCount: number)
  → { action: "none" } | ContextEngineeringPlan
```

Called at top of every iteration, after beforeIteration hooks. O(1) via manifest. Default: no-op.

If a `beforeIteration` hook returns a CE plan, the hook’s plan executes first. The contract-level context policy evaluates after, against the post-CE manifest. Both can trigger separate CE Runs in the same iteration.

### 5.2 Renderer

```
renderer.render(messages: TuvrenMessage[], tools: RenderedToolDefinition[],
                config: TuvrenModelConfig, systemPrompts: string[],
                responseFormat?: StructuredOutputRequest)
  → TuvrenPrompt
```

Pure function. Same inputs, same output. `systemPrompts` contains the final ordered system prompt sequence supplied to the model: extension contributions in registration order followed by the active agent’s base system prompt. Default: identity pass-through with system prompts prepended and response format forwarded.

### 5.3 Loop Policy

```
loopPolicy.evaluate(response: TuvrenModelResponse, manifest: ContextManifest, iterationCount: number)
  → IterationDecision

IterationDecision
├─ continue: boolean
├─ executeTools: boolean
└─ reason?: string
```

Default: `continue = true, executeTools = true` when `finishReason == "tool_call"`. `continue = false` otherwise. Responses containing structured output (`StructuredPart`) are evaluated by the same rules as freeform text responses — structured output does not alter loop policy semantics unless the policy is explicitly specialized.

`IterationDecision` maps to `RuntimeResolution` during resolution composition.

Invalid combinations are rejected. If the model response contains executable tool calls and the loop policy returns `continue: true` with `executeTools: false`, the framework MUST convert the decision to `fail(hard)` with error code `invalid_loop_policy`.

### 5.4 Tool Executor

```
toolExecutor.execute(toolCalls: ToolCallPart[], context: ToolDispatchContext)
  → Promise<ToolExecutionResult>

ToolExecutionResult =
  | { approval: undefined, results: ToolResultPart[], state?: Record<string, unknown> }           // all executed
  | { approval: ApprovalRequest, results: ToolResultPart[], state?: Record<string, unknown> }     // partial: some executed, some pending
```

See §8 for tool dispatch details.

### 5.5 Context Engineering Executor

```
plan.execute(ctx: ContextEngineeringContext)
  → Hash[]
```

Default plans: `summarizeRange`, `dropIndices`, `compactToolResults`. Custom plans supported.

### 5.6 Driver Contract

Shared drivers execute against immutable snapshots of framework-owned state plus explicit capability ports. The primitive-layer shape is:

- snapshots in
- capabilities through ports
- explicit results out

```
DriverRuntimePort
├─ emit(event: TuvrenStreamEvent): void | Promise<void>
└─ now(): EpochMs

DriverHandoffPort
└─ createContextPlan(input: {
     targetAgent: string,
     reason: string,
     mode?: "preserve_trace" | "last_output_only" | string,
     builder?: HandoffContextBuilder,
     payload?: unknown
   }): HandoffContextPlan

DriverExecutionContext
├─ turnId: string
├─ threadId: string
├─ branchId: string
├─ schemaId: string
├─ iterationCount: number
├─ config: AgentConfig                 // read-only snapshot
├─ messages: TuvrenMessage[]           // read-only snapshot
├─ manifest: ContextManifest           // read-only snapshot
├─ toolRegistry: ToolRegistry          // read-only driver-facing view
├─ runtime: DriverRuntimePort
├─ handoff: DriverHandoffPort
└─ signal?: AbortSignal

DriverResumeContext extends DriverExecutionContext
├─ approval: ApprovalResponse
└─ resumedFrom?: HashString

DriverExecutionResult
├─ resolution: RuntimeResolution
├─ messages?: TuvrenMessage[]
├─ partial?: boolean
├─ assistantEventReconciliation?: "allow_final_sequence_divergence"
├─ stateUpdates?: DriverExtensionStateUpdate[]
└─ toolExecutionMode?: "parallel" | "sequential"
```

The driver does not mutate framework-owned state by aliasing context objects in place. If a driver needs to influence framework state, it does so through explicit returned outputs such as `messages`, `resolution`, `partial`, and `stateUpdates`, not through mutation of the execution context.

The shared core does not require a driver-owned approval-resume path. Approval resume is handled by the framework around the paused tool batch, so any driver `resume(...)` method is optional and outside the current shared-core execution path.

`runtime.emit(...)` is a driver-owned streaming surface, not a framework-lifecycle backdoor. Drivers may use it for custom events and assistant/provider stream-content events only. Shared-core lifecycle events such as `turn.*`, `iteration.*`, `tool.*`, `approval.*`, `state.*`, `error`, and similar framework-owned control events are emitted only by shared core itself. If a driver emits assistant content events, that emitted assistant sequence must normally reconcile to the same durable assistant message returned in `DriverExecutionResult.messages`, including incremental delta payloads such as `text.delta`, `reasoning.delta`, `structured.delta`, and `tool_call.args_delta`, stable event identity (`messageId`, `callId`), canonical message-start/message-done ordering, and the final `finishReason`; otherwise shared core rejects the result as an invalid stream event. The one intentional exception is `aroundModel` post-stream replacement after `next()`: once a live assistant sequence has already been emitted, the wrapper may still replace the durable assistant checkpoint, and the driver must opt into that narrower validation path by returning `assistantEventReconciliation: "allow_final_sequence_divergence"`. Shared core honors that exception only when the active agent config includes at least one `aroundModel` handler, assistant content events were actually emitted, the final emitted assistant sequence actually diverges from the durable assistant message, and neither the final live sequence nor the durable assistant message requests tools; in that case it validates the emitted assistant sequence as a standalone assistant message rather than requiring equality with the final durable assistant message. AfterIteration hooks still receive a coherent `TuvrenModelResponse` synthesized from the durable assistant checkpoint, with provider usage preserved when available. Because publication is live, later contract failures such as streamed structured-output validation errors do not retract already-forwarded assistant events; the Turn fails with the corresponding validation error instead. If a driver returns a durable assistant message without emitting matching assistant content events, shared core synthesizes the missing assistant stream events from that durable message so the public event stream still reflects the committed assistant output.

`DriverExecutionResult` is intentionally minimal:

- `resolution` is always required
- `messages` are required whenever the iteration produces durable assistant history
- `messages` may contain at most one assistant message per iteration
- `messages` may be absent only for pure control outcomes with no durable assistant-history contribution, or for failures before any durable assistant output was staged
- `partial` is valid only for failed execution results that stage an assistant message
- `assistantEventReconciliation` is optional and only valid for explicit driver-signaled cases such as `aroundModel` post-stream durable replacement
- `stateUpdates` carries per-extension manifest updates that must be merged at the same checkpoint that commits the assistant message and updated manifest
- `toolExecutionMode` is required when the driver requests tool calls through assistant messages, and invalid otherwise
- failed `partial` results may include interrupted tool-call content; those calls are durable context only, still require `toolExecutionMode` for contract completeness, and are not executed because the resolution is failed

The shared driver seam does **not** carry a generic raw `response` object. Richer transient iteration artifacts belong in driver-local or runtime-internal layers unless a future shared-core need proves otherwise.

---

## 6. Streaming

### 6.1 Layered Surfaces

Three distinct surfaces exist for streaming. Each has one role.

**Internal driver** (not public): A generator function that yields `TuvrenStreamEvent`. Receives control signals (cancel, steer) through injected channels. The host never interacts with the generator directly.

**Host-facing control surface** (public): The `ExecutionHandle` (§7.1). Wraps the internal driver. Exposes `events()` for iteration, plus `cancel()`, `steer()`, and `resolveApproval()` for control.

**Protocol adapter consumption** (public): Adapters receive `AsyncIterable<TuvrenStreamEvent>` from `handle.events()` and transform it into external formats. Adapters never touch the handle.

`events()` is a single-consumer stream for a given `ExecutionHandle`. Hosts that need multiple downstream consumers own teeing, multicast, filtering, buffering, replay, and backpressure policy outside shared core.

```
Internal driver (generator)
  └─→ ExecutionHandle.events()  ←─ host iterates this
        └─→ ProtocolAdapter(events)  ←─ transforms to AG-UI / ACP / SSE
```

Kraken's event stream plays the same architectural role on the outbound side that provider adapters play on the inbound side: one canonical internal interface, many bridges.

### 6.2 Two Parallel Outputs

During a model call, two consumers need different things simultaneously:

**Live path**: Provider stream chunks are translated into `TuvrenStreamEvent` and yielded to the output iterable. These reach protocol adapters immediately. The user sees tokens appearing in real time.

**Durable path**: The same chunks are simultaneously accumulated into a complete `TuvrenModelResponse` via the `StreamAccumulator` (§3.3). This complete response is what the aroundModel chain receives, what the loop policy evaluates, and what gets staged as a durable assistant message.

```
function executeModelCall(runId, prompt, config, iterationCount):
  → { response: TuvrenModelResponse, state?: Record<string, unknown> }

  messageId = generateId()
  callIdMap = {}                    // providerCallId → framework callId
  accumulator = createAccumulator()

  yield { type: "message.start", messageId, role: "assistant", timestamp: now() }

  rawModelResult = await aroundModelChain(ctx, async (innerCtx) => {
    for await (const chunk of provider.stream(innerCtx.prompt)) {
      accumulator.absorb(chunk)
      yield* toStreamEvents(chunk, messageId, callIdMap)
    }
    return accumulator.finalize()
  })
  modelResult = normalizeAroundModelResult(rawModelResult)

  // If aroundModel short-circuited (no chunks absorbed), synthesize events
  if !accumulator.hasContent():
    yield* synthesizeEvents(modelResult.response, messageId)

  yield { type: "message.done", messageId,
          finishReason: modelResult.response.finishReason,
          usage: modelResult.response.usage, timestamp: now() }

  return modelResult
```

`toStreamEvents` maps `ProviderStreamChunk` → `TuvrenStreamEvent`, adding `messageId`, `timestamp`, and translating `providerCallId` → framework `callId` via `callIdMap`.

### 6.3 Non-Streaming Fallback

When `provider.generate()` is used instead of `provider.stream()`, the driver synthesizes events from the complete response: `message.start`, one delta+done pair per content part, then `message.done`. Protocol adapters see identical event shapes regardless of streaming mode — events arrive faster (all at once) but the structure is identical.

This same synthesis mechanism is used when aroundModel short-circuits (§6.5).

### 6.4 Tool Execution Events

`tool.start` and `tool.result` events describe framework-side execution. A `tool.start` event is emitted only after approval has resolved and immediately before the framework enters the first executable aroundTool/execute step for that call. It is never emitted merely because the model requested the tool (that’s `tool_call.done`).

The driver chooses the execution mode for a batch (`sequential` or `parallel`). The shared framework core owns the ordering semantics once a mode is chosen.

**Sequential execution:**

```
for each toolCall in executingTools:
  yield { type: "tool.start", callId, name, input, timestamp: now() }
  result = await executeSingleTool(toolCall)
  yield { type: "tool.result", callId, name, output, isError, timestamp: now() }
```

**Parallel execution:**

All `tool.start` events for executing tools are yielded before any `tool.result`. Each completed tool then emits `tool.result` at the moment that specific tool finishes; the runtime does not wait for the slowest sibling before surfacing already-completed results.

```
for each toolCall in executingTools:
  yield { type: "tool.start", callId, name, input, timestamp: now() }

for each toolCall in executingTools run concurrently:
  result = await executeSingleTool(toolCall)
  stage completed tool_result durably for recovery
  yield { type: "tool.result", callId, name, output, isError, timestamp: now() }

// At checkpoint time the framework materializes the final messages path in the
// original tool-call order so durable conversation order remains deterministic.
```

The shared runtime applies a host-configurable cap to concurrently executing parallel tool calls. Default: `10`. `AgentConfig.maxParallelToolCalls` may override that default for the active agent. When a parallel batch has more executable calls than the cap, execution proceeds in waves: all `tool.start` events for a wave are emitted before any `tool.result` in that wave, then the next wave begins. Durable result ordering still follows the original tool-call order.

For any batch mode, non-executed outcomes that are already known (for example invalid input, unknown tool, or explicit rejection) may emit and stage `tool.result` as soon as they are known; they are not artificially delayed behind slower executable siblings.

**Mixed-approval batch ordering**: When a parallel batch contains both auto-approved and approval-gated tools, only auto-approved tools emit `tool.start`/`tool.result` events before the pause. Approval-gated tools do not emit `tool.start` until after approval, during the resume. The model’s request for the tool is already visible in `tool_call.done` events from the streaming phase.

### 6.5 aroundModel Interaction with Streaming

The `aroundModel` wrapper receives the complete `TuvrenModelResponse` from `next()`. It does not see or control the event stream. Stream events are emitted by the driver as the provider stream progresses, before the around chain receives the complete response.

**Short-circuit**: If aroundModel returns without calling `next()` (cache hit, static response), no streaming events were emitted during the call. The driver detects this via `accumulator.hasContent()` and synthesizes events from the returned response using the same mechanism as the non-streaming fallback (§6.3). The consumer sees one complete message sequence.

**Replacement**: If aroundModel modifies the response after calling `next()`, stream events from `next()` are already emitted and cannot be recalled. The durable path uses the modified response, even when that differs materially from the already-emitted live assistant content. This live-versus-durable divergence is intentional for post-stream replacement and is validated through the explicit `assistantEventReconciliation` contract rather than by forcing the durable checkpoint to match the earlier live stream. This exception is limited to non-tool-call assistant content; if either the final live sequence or the durable replacement requests tools, shared core rejects the result as an invalid stream event.

**Retry**: If aroundModel calls `next()` multiple times (fallback to different provider), each call produces its own stream event sequence with a new `messageId`. The consumer sees multiple message sequences. Only the final response (from the last `next()` call) is staged on the durable path.

When aroundModel returns `{ response, state }`, the driver merges `state` into the iteration's pending extension updates and applies it at the same checkpoint that commits the assistant message and manifest.

### 6.6 aroundTool Interaction with Streaming

The driver emits `tool.start` immediately before the first executable aroundTool/execute entry for an approved or resumed tool call, and emits `tool.result` after the aroundTool chain returns. The around is invisible to the event stream.

**Short-circuit** (cache hit): Both `tool.start` and `tool.result` are emitted. The result arrives instantly.

**Retry**: If aroundTool calls `next()` multiple times, the consumer still sees one `tool.start` and one `tool.result`. Internal retries are invisible to the event stream. This differs from aroundModel retry because tool results are not user-facing streamed content.

When aroundTool returns `{ result, state }` or `{ verdict: "pause", approval, state }`, the executor merges `state` into the iteration's pending extension updates. Those updates are applied at the next iteration checkpoint, including the pause checkpoint when approval interrupts the batch.

### 6.7 Custom Event Emission

Extensions inject events into the output stream via two mechanisms:

**`ctx.emit({ name, data })`** — creates a `CustomEvent` and injects it into the output stream at the point of emission, preserving temporal ordering. Available on all extension handler contexts (intercepts and arounds).

**`ctx.forward(event, source)`** — injects any `TuvrenStreamEvent` into the output stream with the `source` field set (§1.8). Available only on `AroundToolContext` and `ToolExecutionContext`. This is the mechanism for worker sub-agent streaming — a tool call that internally runs a sub-agent forwards its events with source attribution.

```
// Worker streaming from inside a tool's aroundTool or execute function:
for await (const event of workerHandle.events()) {
  ctx.forward(event, { agent: "research", workerId: "w_1", threadId: "thr_w1" })
}
```

### 6.8 Stream-Level Observation

Extensions that need to observe the raw event stream (for telemetry, logging, or diagnostics) do so at the host layer by wrapping `handle.events()`, not through the extension system. The extension system operates on complete responses and execution boundaries.

### 6.9 Protocol Adapter Boundary

```
type ProtocolAdapter<T> = (events: AsyncIterable<TuvrenStreamEvent>) → AsyncIterable<T>
type ProtocolSink = (events: AsyncIterable<TuvrenStreamEvent>) → Promise<void>
```

Package topology: `@tuvren/stream-agui`, `@tuvren/stream-acp`, `@tuvren/stream-sse`. Multiple adapters can consume the same stream via tee or multicast at the host layer.

### 6.10 Cancellation

**User-initiated cancellation while running**: Host signals via `AbortSignal` through `handle.cancel()`. The driver aborts the provider stream, emits an `error` event with `fatal: true`, stages accumulated content as a partial assistant message (with `partial: true` on RuntimeStatus), completes the Run as `failed`, and yields `turn.end` with `"failed"`. The partial content is durable — on the next Turn, the model sees its own interrupted output.

**User-initiated cancellation while paused for approval**: The shared-core semantic is equivalent to rejecting the pending tool calls and durably staging those rejection outcomes without re-entering the model on the same Turn. The framework MUST NOT reinterpret the paused Turn as failed solely because approval was declined. This is the host-facing rejection-and-stop path; higher layers remain responsible for any later host-initiated continuation after that staged rejection state.

As with approval resolution, the kernel may still record the superseded paused Run through its `paused -> failed` transition because that is how paused Runs are closed at the kernel boundary. That Run-level status change does not alter the framework-level meaning of paused cancellation, which remains rejection-and-stop rather than Turn failure.

**Provider stream interruption**: The driver emits an `error` event, stages an error message, and yields `turn.end` with `"failed"`.

### 6.11 Durability Boundary

```
                    EPHEMERAL                                   DURABLE

ProviderStreamChunk → accumulator → TuvrenModelResponse → staging.stage → checkpoint
                         │
                         ├─→ TuvrenStreamEvent → adapter → UI
                         │       (ephemeral)
```

Stream events are ephemeral — not stored, not replayed, not recovered after crashes. The durability boundary is `staging.stage`. If the process crashes mid-stream, the model call re-executes from scratch. Provider streams are not resumable.

When optional state observability is enabled, the framework emits:

- `state.checkpoint` after any Run completion that advances the Turn head via a new TurnNode.
- `state.snapshot` after any checkpoint that writes a new manifest, using the manifest visible at the new head.

---

## 7. Host Contract

The host is the process or service that embeds Tuvren Runtime and, through it, exposes the Kraken framework to external consumers (APIs, UIs, protocol endpoints).

### 7.1 ExecutionHandle

The control surface a host uses to drive and observe a Turn.

```
ExecutionHandle
├─ events(): AsyncIterable<TuvrenStreamEvent>
├─ cancel(): void
├─ steer(signal: InputSignal): void
├─ resolveApproval(response: ApprovalResponse): ExecutionHandle
└─ status(): ExecutionStatus
```

**`events()`** — the primary output. The host iterates this to receive all execution events. Iteration drives execution — the driver advances as the consumer pulls events. The stream is single-consumer per handle; calling `events()` again after consumption starts is invalid. If the only consumer abandons a still-running `events()` stream without calling `cancel()` separately, shared core treats that stream abandonment as cancellation of the running execution. Paused Handles remain explicit control surfaces: abandoning an already-paused stream does not synthesize rejection.

**`cancel()`** — while the Turn is running, triggers the AbortSignal. The driver handles staging partial content and failing the Run. If the Turn is already paused for approval, `cancel()` is treated as rejection of the pending tool calls rather than as an automatic failed terminal state. The shared-core `cancel()` path stages those rejection outcomes durably and stops the paused execution without re-entering the model on the same Turn. This is distinct from `resolveApproval(...)` with explicit `reject` decisions, which continues the same Turn through the normal iteration loop.

**`steer(signal)`** — pushes a signal into the steering channel. The driver consumes it at the next iteration boundary. Only valid when `status().phase === "running"`. Rejected if the Turn is paused or completed.

**`resolveApproval(response)`** — provides the human’s decision for a paused approval. Triggers the approval decision path (§4.8): closes the paused Run, applies decisions, resumes only unfinished approved or edited tool calls through the normal execution path, and returns a **new** `ExecutionHandle` for the continued Turn. Reject decisions produce canonical rejection `ToolResultPart` outcomes for the pending calls and then continue the same Turn through the normal iteration loop. Only valid when `status().phase === "paused"` and `status().approval` is present.

The old handle’s `events()` iterable is already exhausted (it yielded `turn.end` with `paused` and returned). The new handle produces a fresh event sequence starting with `turn.start` (with `resumedFrom` set).

**`status()`** — returns the current execution state:

```
ExecutionStatus
├─ phase: "running" | "paused" | "completed" | "failed"
├─ iterationCount: number
├─ activeAgent?: string
├─ manifest?: ContextManifest
├─ pauseReason?: string
└─ approval?: ApprovalRequest
```

### 7.2 Host Responsibilities

The host is responsible for:

- **Transport**: Connecting `events()` to client protocols (HTTP SSE, WebSocket, stdio).
- **Fan-out**: Routing the same event stream to multiple consumers if needed (tee/multicast).
- **State sync**: Optionally exposing `state.snapshot` events to clients for UI state.
- **Steering channel**: Providing the concrete channel implementation that feeds `steer()`.
- **Approval routing**: Surfacing `approval.requested` events to the human and collecting responses.
- **Lifecycle management**: Starting Turns, managing Threads and Branches, handling long-lived execution.
- **Stream observation**: Wrapping `events()` for telemetry, logging, or diagnostics if needed.

### 7.3 Lifecycle

```
// Start a Turn
handle = framework.executeTurn({
  signal,
  threadId,
  branchId,
  schemaId,
  driverId: "react",
  tools,
  config
})

// Consume events (drives execution)
while (handle) {
  let resumed = false

  for await (const event of handle.events()) {
    adapter.send(event)

    if (event.type === "approval.requested") {
      // Surface to human, await decision
      const response = await getHumanDecision(event.request)
      handle = handle.resolveApproval(response)  // new handle for resumed Turn
      resumed = true
      break
    }
  }

  if (!resumed) break
}

// Or cancel mid-stream
handle.cancel()

// Or inject steering (only while running)
handle.steer({ parts: [{ type: "text", text: "Focus on the budget section" }] })
```

---

## 8. Tool Dispatch

### 8.1 TuvrenToolDefinition

```
TuvrenToolDefinition
├─ name: string                           // unique within tool set
├─ description: string
├─ inputSchema: KrakenSchema
├─ execute: ExecuteFunction
├─ approval?: ApprovalPolicy
├─ timeout?: number                       // ms, overrides default
└─ metadata?: Record<string, unknown>
```

### 8.2 Schema Flexibility

```
KrakenSchema = JSONSchema | CustomSchema

ValidationResult =
  | { valid: true, value: unknown }
  | { valid: false, error: { message: string, details?: unknown } }

CustomSchema
├─ toJSONSchema(): JSONSchema             // for provider rendering
└─ validate(input: unknown): ValidationResult
```

JSON Schema is the interchange format at the shared framework contract boundary. Zod and TypeBox remain acceptable implementation conveniences upstream, but they must be converted into JSON Schema or wrapped behind `CustomSchema` before they cross this shared contract seam.

### 8.3 Execute Function

```
type ExecuteFunction = (input: unknown, context: ToolExecutionContext) → Promise<unknown> | unknown

ToolDispatchContext
├─ turnId: string
├─ branchId: string
├─ iterationCount: number
├─ runId: string
└─ stageResult: (result: ToolResultPart) → Promise<void>

ToolExecutionContext
├─ callId: string
├─ name: string
├─ signal?: AbortSignal
├─ emit?: (event: { name: string, data: unknown }) → void
├─ forward?: (event: TuvrenStreamEvent, source: EventSource) → void
└─ metadata?: Record<string, unknown>
```

`emit` and `forward` are available when the tool executes within a streaming context. `emit` injects custom events. `forward` injects source-attributed events for worker streaming (see §6.7).

### 8.4 Approval Policy

```
type ApprovalPolicy =
  | boolean
  | (input: unknown, context: ToolExecutionContext) → boolean | Promise<boolean>
```

The `approval` field on `TuvrenToolDefinition` is a declarative shorthand. When `true` (or when the function returns `true`), the tool is marked as pending approval. The aroundTool chain in the extension system (§9.5) is the imperative mechanism for the same gating — an aroundTool handler can return a pause verdict with an `ApprovalRequest` for any tool, regardless of the tool’s own `approval` field.

### 8.5 Tool Registry

```
ToolRegistry
├─ register(tool: TuvrenToolDefinition): void
├─ get(name: string): TuvrenToolDefinition | undefined
├─ has(name: string): boolean
├─ list(): TuvrenToolDefinition[]
└─ toDefinitions(): RenderedToolDefinition[]
```

Tools can be modified between Turns but not during normal execution of an active agent segment. Extension-contributed tools (§9.2) merge into the registry at Turn start. The active registry is rebuilt on handoff (§10.4); it is otherwise immutable for the duration of an active agent segment.

### 8.6 Executor Flow

For each tool call in the batch:

```
1. RESOLVE         tool = registry.get(name). Not found → error ToolResultPart.
2. VALIDATE        tool.inputSchema.validate(input). Invalid → error ToolResultPart.
3. APPROVAL CHECK  tool.approval field. If true → mark as pending.
4. AROUND + EXEC   aroundTool chain wraps: tool.execute(validatedInput, context).
                   aroundTool may also trigger approval (pause verdict).
                   Any `state` returned by aroundTool is merged into
                   `ToolExecutionResult.state` for the iteration checkpoint.
5. PRODUCE         ToolResultPart. Immediately after each ToolResultPart is produced,
                   the executor MUST invoke `context.stageResult(result)`.
                   The staged durable unit is `{ role: "tool", parts: [result] }`
                   stored as `objectType: "message"`.
```

**Execution mode selection**: The driver chooses whether a batch executes sequentially or in parallel. The shared framework core owns the canonical ordering and durability semantics for the chosen mode (§6.4).

**Parallel execution**: Steps 1–3 synchronously for all calls. Split into approved and pending sets. Steps 4–5 concurrently for approved tools via aroundTool chain, subject to the active max-parallel-tool-call cap. If pending set is non-empty, return partial result with `ApprovalRequest` containing `completedResults` (from approved tools) and `toolCalls` (pending).

**Sequential execution**: All steps one call at a time. First approval-gated tool encountered triggers pause with results from previously completed tools.

Individual tool failures produce error ToolResultParts. Tool failures never fail the Run.

Whether one failed call aborts, rejects, or coexists with sibling results in a mixed or parallel batch is a driver- or host-level policy decision above the shared core. The shared core only defines trace integrity, call-ID ownership, and ordering/durability semantics for whichever results are ultimately produced.

Incremental staging is required for crash-safe partial progress. In a parallel or sequential batch, each completed tool result becomes durably recoverable before the batch as a whole returns. Recovery can therefore skip completed tool calls by `callId` and resume only unfinished calls.

### 8.7 Approval Precedence

```
1. Tool definition's approval field (if true or function returns true)
   → mark as pending
2. aroundTool handler returning { verdict: "pause", approval: ApprovalRequest }
   → mark as pending
3. If nothing pauses → auto-approve, execute tool
```

---

## 9. Extension System

### 9.1 Extension Unit

```
createExtension({
  name: string

  // ── Contributions ──
  tools?: TuvrenToolDefinition[]
  systemPrompt?: string | SystemPromptFn
  exports?: string[]                           // state keys visible to other extensions via sharedExports

  // ── Persistent State ──
  state?: Record<string, unknown>

  // ── Intercepts ──
  beforeTurn?: InterceptHandler
  afterTurn?: InterceptHandler
  beforeIteration?: BeforeIterationHandler
  afterIteration?: AfterIterationHandler

  // ── Arounds ──
  aroundModel?: AroundModelHandler
  aroundTool?: AroundToolSpec

  // ── Config ──
  timeout?: number                               // ms, overrides agent default
})
```

Six hooks, two shapes. A single Extension can use any combination. A budget tracker uses `state` + `afterIteration`. A model fallback uses `aroundModel`. A PII sanitizer uses `aroundTool`. A summarization extension uses `state` + `beforeIteration`.

Extensions are registered on the agent configuration before execution begins. Registration order determines composition order (§9.6). Extensions cannot be added or removed during normal execution of an active agent segment. A handoff (§10.4) is the sole sanctioned mid-Turn reconfiguration boundary; on handoff the framework swaps AgentConfig and rebuilds the active tool registry, extension composition, renderer inputs, and contract bindings for subsequent iterations. Tools contributed by extensions merge into the tool registry at Turn start.

If a tool name conflicts with an explicitly registered tool or another extension’s tool, registration fails with a duplicate name error.

### 9.2 Contributions

#### Tools

Extension-contributed tools satisfy `TuvrenToolDefinition` and merge into the tool registry at Turn start. The tool executor does not distinguish between explicit and extension-contributed tools.

#### System Prompt

```
type SystemPromptFn = (ctx: SystemPromptContext) → string | undefined

SystemPromptContext
├─ extensionState: Record<string, unknown>
├─ sharedExports: Record<string, Record<string, unknown>>
├─ manifest: ContextManifest
└─ iterationCount: number
```

String: injected as-is. Function: evaluated before each model call; `undefined` = no injection. Contributions from all extensions are collected in registration order and passed to the renderer (§5.2). System prompt contributions are transient — not persisted in the messages path.

Dynamic system prompts may invalidate provider KV cache. The framework documents this tradeoff but does not prevent it.

### 9.3 Extension State

#### Declaration and Initialization

The `state` field declares initial values. Stored in `manifest.extensions[name]`. On first Turn, initial values are written. On subsequent Turns, persisted values are read.

The optional `exports` field declares which keys from that persisted namespace are visible to other extensions through `sharedExports`. Exported values are not stored separately — they are projected from the persisted namespace whenever the framework builds handler contexts.

#### Reading and Updating

All handlers receive `ctx.extensionState` (their own persisted extension namespace, deserialized from the manifest). Handler contexts also expose `sharedExports`, a read-only projection of other extensions' declared export keys over the latest persisted extension state. Intercepts and arounds return state updates via the generic `state` field in their return value. Updates are collected per phase and applied at the next checkpoint.

The framework may warn hosts when an extension namespace grows past an implementation-defined manifest budget, but this is advisory only. There is no hard manifest-state cap in the core contract; hosts keep agency over their persistence and performance tradeoffs.

When multiple state update maps are pending before the next checkpoint, the framework merges them deterministically by key, with the later update winning.

#### Durability

State is durable through the manifest checkpoint lifecycle. State updates from an around that crashes mid-execution are lost — consistent with “arounds are ephemeral” (§9.5).

#### Namespace Isolation

Each extension owns `manifest.extensions[name]`. The framework rejects duplicate names. Other extensions may read only the keys explicitly listed in that extension's `exports` declaration; they may not mutate another extension’s namespace. Core manifest fields are never affected by extension state updates.

#### Three Storage Postures

**Execution-affecting state** (budget counters, compression markers) — lives in `manifest.extensions[name]`. Durable through manifest checkpoint lifecycle.

**Transient modifications** (system prompt rewrites, tool filtering) — lives nowhere durably. Applies to one iteration.

**External operational data** (audit logs, traces, metrics) — extension owns its own storage. The framework provides observation points, not persistence.

### 9.4 Intercept Hooks

Intercepts observe execution at phase boundaries and return verdicts and state updates. They do not wrap execution and cannot call `next()`.

#### Handler Signature

```
type InterceptHandler = (ctx: InterceptContext) → InterceptResult | void | Promise<...>

InterceptContext
├─ extensionState: Record<string, unknown>
├─ sharedExports: Record<string, Record<string, unknown>>
├─ manifest: ContextManifest
├─ iterationCount: number
├─ messages: TuvrenMessage[]                   // read-only snapshot
├─ turnId: string
├─ runId: string
└─ emit: (event: { name: string, data: unknown }) → void
```

#### InterceptResult

```
InterceptResult
├─ state?: Record<string, unknown>
├─ verdict?: "endTurn" | "softFail" | "hardFail"
├─ reason?: string          // required for endTurn
└─ error?: Error            // required for softFail and hardFail
```

Three verdicts mapping into RuntimeResolution:

| Intercept verdict | RuntimeResolution |
| ----------------- | ----------------- |
| `undefined`       | (no effect)       |
| `"endTurn"`       | `end_turn`        |
| `"softFail"`      | `fail(soft)`      |
| `"hardFail"`      | `fail(hard)`      |

`InterceptResult` stays small and local. It is not a miniature `RuntimeResolution` object. The only extra payload carried is the irreducible payload required for clean lifting into runtime control.

Validation rules: `reason` is required when `verdict` is `"endTurn"`. `error` is required when `verdict` is `"softFail"` or `"hardFail"`.

Verdict composition follows RuntimeResolution precedence. When multiple extensions return verdicts, the highest-precedence resolution wins.

#### beforeTurn

Fires once before the first iteration. Used for precondition validation, one-time initialization, loading external configuration into extension state. Uses `InterceptHandler` / `InterceptResult`.

#### afterTurn

Fires once after the iteration loop reaches a terminal non-paused stop. It is not fired for `beforeTurn` short-circuits because no iteration ran, and it is not fired for approval pauses because the Turn may resume. Used for cleanup, turn-level accounting, final metrics emission. Uses `InterceptHandler` / `InterceptResult`. Verdicts from afterTurn do not affect the completed Turn — the Turn has already resolved. State updates from afterTurn are non-durable on terminal paths. Implementations MUST NOT assume a later persistence opportunity for those updates within the same Turn.

#### beforeIteration

```
type BeforeIterationHandler = (ctx: InterceptContext) → BeforeIterationResult | void | Promise<...>

BeforeIterationResult
├─ state?: Record<string, unknown>
├─ cePlan?: ContextEngineeringPlan
├─ verdict?: "endTurn" | "softFail" | "hardFail"
├─ reason?: string          // required for endTurn
└─ error?: Error            // required for softFail and hardFail
```

When `cePlan` is returned, the framework executes the context engineering action as a separate Run before the iteration proceeds (§4.5). This is the only hook that can trigger context engineering.

#### afterIteration

```
type AfterIterationHandler = (ctx: AfterIterationContext) → InterceptResult | void | Promise<...>

AfterIterationContext extends InterceptContext
├─ response: TuvrenModelResponse               // the model's response this iteration
├─ toolResults?: ToolResultPart[]               // if tools were executed
└─ resolution: RuntimeResolution                // the iteration's current resolution
```

Fires after checkpoint. Sees the complete iteration: model response, tool results, and committed state. Used for budget tracking (token counting after seeing usage), metrics, and verdicts that should consider the full iteration outcome. `softFail` remains non-terminal here; `endTurn` and `hardFail` may still override continuation through RuntimeResolution precedence.

State updates returned from afterIteration are durable only if a later checkpoint occurs. On terminal paths they are non-durable.

### 9.5 Around Hooks

Arounds wrap execution. They receive `next` and can call it zero times (short-circuit), once (normal), or multiple times (retry). Arounds are ephemeral — they do not survive crashes. On recovery, the framework re-enters the iteration loop from the last checkpoint. Arounds run again from scratch.

#### aroundModel

```
type AroundModelHandler = (ctx: AroundModelContext, next: NextModelFn) → AroundModelResult | Promise<...>

AroundModelContext
├─ extensionState: Record<string, unknown>
├─ sharedExports: Record<string, Record<string, unknown>>
├─ manifest: ContextManifest
├─ messages: TuvrenMessage[]
├─ prompt: TuvrenPrompt                        // mutable
├─ tools: RenderedToolDefinition[]             // mutable
├─ config: TuvrenModelConfig                   // mutable
├─ iterationCount: number
└─ emit: (event: { name: string, data: unknown }) → void

type NextModelFn = (ctx?: AroundModelContext) → Promise<TuvrenModelResponse>
type AroundModelResult = TuvrenModelResponse | { response: TuvrenModelResponse, state?: Record<string, unknown> }
```

`next` accepts an optional modified context — this is how tool filtering, prompt modification, model swapping, and retry work. These are call-scoped execution mechanics, not persistent policy decisions. aroundModel is an execution wrapper, not a generic verdict surface.

State updates returned from aroundModel are collected by the driver and applied at the next iteration checkpoint. If the around crashes before returning, state updates are lost (ephemeral).

#### aroundTool

```
type AroundToolSpec =
  | AroundToolHandler
  | { tools: string[], handler: AroundToolHandler }

type AroundToolHandler = (ctx: AroundToolContext, next: NextToolFn) → AroundToolResult | Promise<...>

AroundToolContext
├─ extensionState: Record<string, unknown>
├─ sharedExports: Record<string, Record<string, unknown>>
├─ toolCall: ToolCallPart
├─ tool: TuvrenToolDefinition
├─ input: unknown
├─ callId: string
├─ approvalDecision?: ApprovalDecision        // present when resuming this exact call after approval
├─ emit: (event: { name: string, data: unknown }) → void
└─ forward: (event: TuvrenStreamEvent, source: EventSource) → void

type NextToolFn = (ctx?: AroundToolContext) → Promise<ToolResultPart>
type AroundToolResult =
  | ToolResultPart
  | { result: ToolResultPart, state?: Record<string, unknown> }
  | { verdict: "pause", approval: ApprovalRequest, state?: Record<string, unknown> }
```

When filtered by tool name, the handler only runs for matching tools. When the handler returns `{ verdict: "pause", approval }`, it uses the same approval machinery as tool-level `approval` fields (§8.7). State updates returned with `{ result, state }` or with a pause verdict are collected by the executor and applied at the next iteration checkpoint, including the pause checkpoint when approval interrupts the batch. On approval resume, only unfinished tool calls are resumed, and each resumed call re-enters the full aroundTool chain. Approval-aware wrappers use the prior decision for the exact call and pass through without re-requesting approval.

`forward` is available on aroundTool — this is the mechanism for worker sub-agent streaming (§6.7, §10.2).

### 9.6 Composition and Ordering

#### Intercept Ordering

**Before intercepts** (beforeTurn, beforeIteration): registration order (ext1 → ext2 → ext3).

**After intercepts** (afterIteration, afterTurn): reverse registration order (ext3 → ext2 → ext1).

#### Around Nesting

First-registered is outermost:

```
ext1.aroundModel(ctx,
  ext2.aroundModel(ctx,
    ext3.aroundModel(ctx,
      → actual model call)))
```

#### System Prompt Collection

Registration order: `[ext1.systemPrompt, ext2.systemPrompt, ext3.systemPrompt, basePrompt]`.

### 9.7 Interaction with Streaming

aroundModel and aroundTool interact with the streaming system as defined in §6.5 and §6.6. The key rules:

- aroundModel receives the complete `TuvrenModelResponse`, not streaming events. Stream events are emitted by the driver during the provider stream, before aroundModel sees the response.
- Short-circuit (no `next()` call): driver synthesizes events from the returned response.
- Single-call replacement after `next()`: if the wrapper returns a different durable response after one streamed `next()` call, the already-emitted live assistant sequence stays visible and only the durable checkpoint changes.
- Retry (multiple `next()` calls): each produces a stream sequence with a new `messageId`. Only the final response is durable.
- If a provider call fails after streaming has started and no durable assistant message is checkpointed, the already-emitted assistant content remains visible as an interrupted partial sequence and is followed by failure handling.
- Live publication is not retractable: if later shared-core validation fails, including post-stream structured-output validation, the prior ephemeral stream remains visible and the Turn fails with the corresponding contract error.
- aroundTool is invisible to the event stream. One `tool.start` and one `tool.result` regardless of internal retries.

`emit` is available on all handler contexts. `forward` is available only on `AroundToolContext` and `ToolExecutionContext`.

### 9.8 Interaction with Framework Contracts

The extension system does not replace the five contracts. It provides an ergonomic layer that compiles into them.

**Context policy**: `beforeIteration` returning `cePlan` triggers context engineering. If a developer also replaces the context policy contract directly, both can trigger CE in the same iteration — the extension’s plan runs first.

**Renderer**: System prompt contributions modify the prompt input to the renderer, not the renderer itself.

**Loop policy**: afterIteration verdicts compose with loop policy via RuntimeResolution precedence. An extension’s `"endTurn"` overrides the loop policy’s continuation decision.

**Tool executor**: aroundTool integrates into the executor flow. Arounds wrap the tool execution step.

**Two tiers**: Extensions cover the common case. Contract replacement covers deep structural intervention.

### 9.9 Error Handling

**Intercept errors**: Caught, treated as `fail(soft)`. Prevents a broken extension from crashing the agent.

**Around errors**: Before `next()` — caught, produces error result (tools) or fails model call (model). After `next()` — framework uses `next()`’s result, logs the error.

**System prompt errors**: Logged, that extension’s contribution omitted. Others unaffected.

**Timeout**: Timeout ownership belongs to the framework or host layer, not to the shared core as a forced-termination guarantee. When timeout is triggered, the shared core provides the reliable semantics that follow: abort runtime-owned signals where available, fence runtime-owned callbacks and event injection surfaces, ignore late results, and prevent late timeout-losing work from re-entering durable framework state. Stronger timeout enforcement may exist in specific hosts, sandboxes, or concrete driver deployments above the core.

---

## 10. Multi-Agent Orchestration

Multi-agent orchestration is a framework pattern built on existing primitives: tools, steering, context engineering, and agent configuration. No new kernel concepts.

### 10.1 Agent Configuration

```
AgentConfig
├─ name: string
├─ model?: string | TuvrenProvider
├─ systemPrompt?: string
├─ tools?: TuvrenToolDefinition[]
├─ extensions?: Extension[]
├─ loopPolicy?: LoopPolicy
├─ contextPolicy?: ContextPolicy
├─ responseFormat?: StructuredOutputRequest
├─ maxIterations?: number
└─ maxParallelToolCalls?: number
```

Agent configs are static for the lifetime of the orchestration. On handoff, the framework swaps the active config and continues on the same Branch.

### 10.2 Synchronous Workers

A tool call that internally runs a sub-agent. The parent blocks until the result.

```
tools: [{
  name: "research",
  description: "Delegate a research task to a specialized agent",
  inputSchema: { query: "string", depth: "string" },
  execute: async (input, ctx) => {
    const { threadId, branchId } = kernel.thread.create(...)
    const workerHandle = executeTurn({
      signal: input,
      threadId,
      branchId,
      schemaId,
      driverId: "react",
      tools: researchConfig.tools,
      config: researchConfig
    })

    let result = ""
    for await (const event of workerHandle.events()) {
      if (event.type === "text.done") result = event.text
      ctx.forward(event, { agent: "research", workerId: threadId })  // opt-in
    }
    return { summary: result, workerId: threadId }
  }
}]
```

From the parent’s perspective: one tool call, one tool result. The sub-agent’s internal execution is opaque. The sub-agent runs on its own Thread with its own history. Forwarding worker events via `ctx.forward` is opt-in — omit it for silent workers.

### 10.3 Asynchronous Workers

An asynchronous worker runs on its own Thread and may complete while the parent Turn continues.

The shared core does **not** define a canonical conversational `worker_result` payload. Instead it provides primitives:

- child execution handles
- child/subtree event streams
- child completion access
- steering as a separate primitive already available to higher layers

What happens with a worker's final result is a driver or host concern. Higher layers may, for example:

- inject a child result through steering while the parent is running
- expose a sync tool that waits for a child and returns its result
- choose not to inject the child result into parent conversational context at all

Any higher-layer projection of child completion into parent context should be based only on the child's visible final result surface. Internal reasoning or hidden trace details are not shared-core projection semantics.

**Run locality**: Worker execution is local to the specific execution handle that spawned it. If the parent pauses for approval, workers may continue. If a worker pauses for approval, the parent and sibling workers may continue. Pause semantics are always run-local.

**Launch precondition**: A parent handle must have actually started execution before it can spawn children. In the default lazy execution model that means at least one parent-facing event stream (`events()` or `allEvents()`) has started consumption.

**Subtree streams**: `allEvents()` is also single-consumer for each orchestration handle. When a parent `allEvents()` stream is active, the runtime forwards child subtree events through an internal subscription path. This does not consume the child's host-visible `allEvents()` stream; a host may still consume the child's own `allEvents()` once, independently of the ancestor subtree forwarder.

### 10.4 Handoffs

#### Agent-Signaled Handoff

Provider APIs may express handoff intent through a tool-like response, but the framework captures the intent and canonicalizes it into `RuntimeResolution.handoff`. Agent-signaled handoff is therefore a control transition, not ordinary tool execution.

1. Detects handoff intent in the model response.
1. Does **not** persist the literal handoff `tool_call` as conversation history.
1. Stages any remaining assistant content that is still semantically conversational.
1. Executes handoff context engineering as a separate Run.
1. Rewrites the active `messages` path for the receiving agent.
1. Updates `runtime.status` with the new `activeAgent`.
1. Swaps the active `AgentConfig`.
1. Continues the iteration loop with the new config on the same Branch.

The Turn does not end. The Branch does not change. History is preserved.

Before the next iteration begins, the framework MUST rebuild the active execution scope from the new `AgentConfig`: tool registry, extension composition, system prompt contributions, renderer inputs, loop policy, context policy, and any other per-agent framework contracts. The receiving agent MUST NOT continue with the previous agent’s tool or extension surface.

The framework rejects multiple handoff intents in one response. A response that combines handoff intent with ordinary executable tool calls is rejected as invalid handoff composition.

#### Handoff Context Engineering

Every handoff replaces the entire active `messages` collection. Handoffs stay on the same Turn and same Branch; the framework rewrites the full active context window, swaps the active agent configuration, and continues execution. No raw prior context is preserved in-place for the receiving agent unless the selected handoff builder chooses to summarize or restate it.

The framework provides two standard handoff modes:

- **`preserve_trace`** — expected for agent-signaled handoffs. The receiving agent gets a rewritten request that preserves the prior agent trace as a chronological summarized trace without exposing raw history, raw tool-call inputs, or incompatible tool surfaces.
- **`last_output_only`** — expected for thin higher-layer pipeline patterns built on handoff. The receiving agent gets a clean-slate request containing only the previous agent’s final visible output parts (text / structured / file) plus any developer-configured scaffolding. Provider continuity metadata is not carried across the role transition into the new user-authored handoff message.

The handoff context builder (§1.5 `HandoffContextBuilder`) produces new message hashes. The framework executes it as a context engineering Run:

```
function applyHandoff(plan: HandoffContextPlan, turnId, branchId, schemaId, pendingExtensionStateUpdates = {}):
  → { activeConfig, activeToolRegistry }
  ceRunId = generateId()
  // create Run with step "handoff_context"
  branch = kernel.branch.get(branchId)
  currentTreeHash = kernel.node.get(branch.headTurnNodeHash).turnTreeHash

  newMsgHashes = plan.builder(plan.sourceContext)

  newManifest = rebuildManifest(newMsgHashes, kernel, {
    preserveExtensionsFrom: plan.sourceContext.manifest.extensions,
    applyExtensionStateUpdates: pendingExtensionStateUpdates
  })
  manifestHash = kernel.store.put(serialize(newManifest))

  runtimeStatus = {
    state: "running",
    activeAgent: plan.targetAgent
  }
  runtimeStatusHash = kernel.store.put(serialize(runtimeStatus))

  newTreeHash = kernel.tree.create(schemaId, {
    "messages": newMsgHashes,
    "context.manifest": manifestHash,
    "runtime.status": runtimeStatusHash
  }, currentTreeHash)

  eventHash = storeEvent({ type: "handoff_applied", targetAgent: plan.targetAgent })
  kernel.run.completeStep(ceRunId, "handoff_context", eventHash, undefined, newTreeHash)
  kernel.run.complete(ceRunId, completed)
  kernel.turn.updateHead(turnId, latestHead())

  // Swap active config
  activeConfig = agents[plan.targetAgent]
  activeTools = activeConfig.tools ?? []
  activeToolRegistry = buildToolRegistry(activeTools, activeConfig.extensions)

  return { activeConfig, activeToolRegistry }
```

#### Default Handoff Context Builder (`preserve_trace`)

Deterministic, no model call. The semantic content below is normative; the exact wrapper text is implementation-defined.

```
function defaultHandoffContextBuilder(ctx: HandoffSourceContext) → Hash[]:
  trace = []
  for message in ctx.messages:
    switch message.role:
      case "user":
        trace.push(`[User] ${renderVisibleUserContent(message)}`)
      case "assistant":
        trace.push(`[Assistant] ${summarizeVisibleAssistantOutput(message)}`)
      case "tool":
        for result in message.parts:
          trace.push(`[Tool:${result.name}] ${renderToolResult(result)}`)
      case "system":
        continue

  handoffMsg = {
    role: "user",
    parts: [{
      type: "text",
      text: [
        `[Handoff from ${ctx.sourceAgent.name}]`,
        `Reason: ${ctx.handoffIntent.reason ?? "unspecified"}`,
        `--- Chronological Trace ---`,
        ...trace,
        `Continue from where the previous agent left off.`
      ].join('\n')
    }]
  }
  return [ctx.helpers.storeMessage(handoffMsg)]
```

System instructions are never persisted by handoff context builders. The receiving agent’s base system prompt remains transient renderer input from the active `AgentConfig`.

Developers may replace this builder with custom builders for domain-specific handoff formats. The default remains available.

#### Last Output Only Builder (`last_output_only`)

Deterministic, no model call:

```
function sequenceHandoffContextBuilder(ctx: HandoffSourceContext) → Hash[]:
  lastParts = extractLastVisibleAssistantOutputParts(ctx.messages)
  handoffMsg = {
    role: "user",
    parts: lastParts.length > 0
      ? lastParts
      : [{ type: "text", text: "" }]
  }
  return [ctx.helpers.storeMessage(handoffMsg)]
```

#### History Preservation

Both handoff types use `tree.create` to build new TurnTrees. Previous TurnNodes with full history remain in the chain.

- **Audit**: Complete raw conversation recoverable by walking TurnNode chain.
- **Rollback**: `branch.setHead` to pre-handoff TurnNode restores original agent state.
- **Debugging**: `tree.diff` between pre-handoff and post-handoff shows exactly what context engineering changed.

### 10.5 Ordered Pipelines

Ordered multi-agent pipelines are not part of the shared framework core. A thin driver may build them on top of handoff semantics, typically using `last_output_only` as the handoff mode between steps.

The shared core therefore does **not** standardize sequence configuration, validation, or progression policy as part of its normative semantics.

### 10.6 OrchestrationRuntime

The framework-provided orchestration primitive is minimal and handle/tree-based rather than runtime-global worker-registry-based.

```
OrchestrationRuntime
└─ executeTurn(input: { agent: string, signal, threadId, branchId, schemaId?, driverId?, tools?, parentTurnId? }) → OrchestrationHandle
```

```
OrchestrationHandle extends ExecutionHandle
├─ resolveApproval(response: ApprovalResponse) → OrchestrationHandle
├─ spawn(input: { agent: string, signal: InputSignal }) → OrchestrationHandle
├─ allEvents(): AsyncIterable<TuvrenStreamEvent>
└─ awaitResult(): Promise<unknown>
```

**Construction**:

```
const orchestration = createOrchestrationRuntime({
  framework,
  agents: { primary, research, billing }
})
```

The authoritative shared-core semantics define orchestration by composition over an existing framework runtime. More elaborate construction modes are outside current core scope until a concrete use case justifies them.

**Internal mechanics**: The runtime composes existing primitives:

- `executeTurn` for both root and child Turns
- `ExecutionHandle.events()` for stream consumption
- `thread.create` for child Thread creation
- existing event `source` attribution for descendant events in subtree streams

No new kernel concepts. The runtime is a composition layer.

Child handles are ordinary execution handles:

- each child owns its own pause/resume/cancel lifecycle
- any child may itself spawn children, allowing recursive parent/worker trees
- `spawn()` is valid only while the current orchestration handle is running
- `spawn()` starts the child execution immediately; `awaitResult()` does not satisfy the parent launch precondition by itself
- `allEvents()` means self + descendants
- descendant events in `allEvents()` MUST carry `source` attribution sufficient to identify the originating execution node
- child launches inherit the caller's explicit execution surface (for example `driverId` and per-request `tools`) because `spawn()` intentionally does not define its own override bag

`awaitResult()` waits for the child execution to reach a terminal state. It resolves with the child execution's final visible result surface on successful completion and rejects on failed completion. The shared core does not prescribe how higher layers feed that result into parent conversational context.

### 10.7 Extension Scoping

Extensions belong to their `AgentConfig`. On handoff, previous agent’s extensions deactivate, new agent’s extensions activate.

Extension state in `manifest.extensions` persists across handoffs — it lives on the Branch. A budget tracker active on both agents sees cumulative usage. An extension active only on the first agent has state preserved but is not invoked after handoff.

Workers run on separate Threads with their own `AgentConfig` and extensions. Parent extensions do not apply to workers.

Cross-agent budget tracking: use a shared budget extension that both configs include, reading from a shared external store (extension-owned storage, not manifest state).

### 10.8 Streaming Events for Orchestration

Orchestration-specific tracing stays minimal and pluggable in the shared core.

- `events()` and `allEvents()` are the canonical runtime surfaces.
- Descendant execution is represented through standard event types plus `source` attribution.
- Additional orchestration-specific tracing may be emitted through `custom` events, but names and payloads are implementation-defined rather than fixed framework semantics.

This keeps the shared core compatible with pluggable observability stacks such as OpenTelemetry, Langfuse, or custom host-defined tracing.

### 10.9 Boundaries

This specification does not define:

- **Worker process management**: Scheduling, monitoring, cleanup of worker OS processes. Host concern.
- **Cross-thread state sharing**: Beyond tool results and steering. Deferred.
- **Agent discovery**: Agents are statically configured.
- **A2A protocol integration**: Adapter concern, not core orchestration.
- **Delegated/external orchestration construction modes**: Deferred until a concrete use case justifies a normative boundary.
- **Worker Thread lifecycle / GC**: Deferred per kernel spec.
- **Concurrent handoffs**: Multiple handoff intents in one response are rejected — one handoff per iteration.

---

_v0.17. This is the single authoritative framework specification. All framework behavior — execution model, extension system, multi-agent orchestration, streaming, host contract, and tool dispatch — is defined here. Companion rationale is explanatory only and non-contract._
