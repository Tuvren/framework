# Epic L Parity Inventory

This file closes `KRT-L001` against current brownfield reality and defines the
streaming and provider-semantics invariants that Epic M may assume.

## Current Repo Reality

- `framework-driver-react` and `framework-runtime-core` already implement and
  test most of Epic L behavior.
- Verification baseline at the time of this inventory:
  - `bun run nx run framework-driver-react:test`
  - `bun run nx run framework-runtime-core:test`
  - `bun run nx run framework-driver-react:typecheck`
  - `bun run nx run framework-runtime-core:typecheck`

## Contract Homes

- Provider contract:
  `boundaries/framework/contracts/runtime-api/src/lib/runtime-contracts.ts`
  and `boundaries/providers/contracts/provider-api/src/index.ts`
- ReAct stream accumulation and generated-response synthesis:
  `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-stream.ts`
- AroundModel reconciliation and structured-output validation:
  `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver.ts`
- Assistant stream validation and synthesized hook-visible responses:
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts`

## Parity Inventory

### Text

- `provider.generate()` returns a complete `TextPart`; the driver synthesizes
  `message.start`, `text.delta`, `text.done`, and `message.done`.
- `provider.stream()` emits `text_delta`; the accumulator publishes live
  `text.delta` and finalizes the same durable `TextPart`.
- Durable rule: generated and streamed text converge to the same assistant
  message content and finish-reason semantics.

### Reasoning

- Streamed reasoning uses `reasoning_delta` and `reasoning_done`.
- The accumulator preserves Anthropic-style thinking continuity tokens in
  `ReasoningPart.providerMetadata.signature`.
- Generated reasoning is already canonical durable content; the driver
  synthesizes `reasoning.delta` and `reasoning.done` from that durable part.
- Durable rule: reasoning text and redaction state live in the durable message;
  provider continuity tokens stay opaque in part-level `providerMetadata`.

### Structured Output

- Generated structured output synthesizes `structured.delta` from serialized
  final data followed by `structured.done`.
- Streamed structured output supports both incremental `structured_delta` plus
  `structured_done` and final-only `structured_done`, where the driver
  synthesizes the missing delta before publishing done.
- The driver validates the parsed `StructuredPart.data` against the requested
  schema after `aroundModel` returns.
- Durable rule: generated and streamed structured output must converge to the
  same `StructuredPart`, and invalid or incomplete streams fail before
  checkpointing.

### File Content

- Canonical assistant events include `file.done`.
- Generated or synthesized durable assistant messages can emit `file.done`.
- The current `ProviderStreamChunk` contract has no file-specific chunk
  variant, so provider-native live file streaming is not part of the current
  contract.
- Durable rule: file parity currently enters through durable response
  synthesis, not through a provider-native stream chunk.

### Tool-Call Previews

- Generated tool calls synthesize `tool_call.start`, `tool_call.args_delta`,
  `tool_call.done`, and `message.done`.
- Streamed tool calls accept incremental `tool_call_args_delta` or final-only
  `tool_call_done`; the driver synthesizes missing args deltas when needed.
- Durable rule: generated and streamed tool calls must converge to the same
  durable `ToolCallPart` shape before runtime-core begins tool execution.

### Finish Reason and Usage

- Generate mode takes `finishReason` and optional `usage` from the durable
  `TuvrenModelResponse` and publishes them via synthesized `message.done`.
- Stream mode takes `finishReason`, `usage`, and response-level
  `providerMetadata` from the `finish` chunk.
- Runtime-core synthesizes `AfterIterationContext.response` from the durable
  assistant message plus the last `message.done` usage.
- Durable rule: `finishReason` must stay coherent with assistant content, and
  `usage` must survive into hook-visible synthesized responses.

### Response-Level and Part-Level Provider Metadata

- Assistant-message-level `providerMetadata` remains provider-shaped and opaque.
- Part-level `providerMetadata` remains provider-shaped and opaque on text,
  reasoning, structured, file, tool-call, and tool-result parts.
- Metadata-only `aroundModel` changes do not require
  `assistantEventReconciliation`.
- Durable rule: do not normalize provider metadata into a Tuvren-owned schema in
  Epic L.

### Failure and Cancellation

- Provider stream failures become typed provider failures and do not get masked
  as `invalid_stream_event` failures.
- Cancellation may checkpoint partial assistant content only when the accumulated
  content is already safe and parseable as a durable assistant message.
- A bare `tool_call.start` without usable arguments does not become durable
  assistant content and therefore cannot become executable tool work.
- Durable rule: Epic M must inherit only durable assistant tool calls, never
  ephemeral provider chunk fragments.

### aroundModel Divergence

- `assistantEventReconciliation: "allow_final_sequence_divergence"` is valid
  only when there is an active `aroundModel`, assistant content was emitted, the
  final emitted sequence truly differs from the durable assistant message, and
  neither side requests tools.
- Durable rule: Epic M may treat assistant tool-call requests as exact durable
  inputs and does not need to handle live-versus-durable tool-call divergence.

## Provider-Shaped Continuity Fields To Preserve Opaquely

### OpenAI

- Response and message identity such as response IDs and item IDs
- Function `call_id`
- Reasoning `encrypted_content`
- Usage detail counters beyond the canonical `inputTokens` and `outputTokens`

### Anthropic

- Message IDs
- `stop_reason`
- Tool-use IDs
- Cumulative usage values
- Partial JSON tool-input deltas
- Thinking `signature`

### Google / Gemini

- Function-call `id`
- `thoughtSignature`
- `groundingMetadata`
- `usageMetadata`
- Session or grounding continuity fields returned by the provider

## Epic M Handoff Gates

- Runtime-owned durable tool identity is `ToolCallPart.callId`; provider-native
  IDs remain opaque in `providerMetadata`.
- Generated and streamed assistant tool calls must produce the same durable
  `ToolCallPart` shape before tool execution or approval logic runs.
- Partial cancellation and provider failures must not create orphan executable
  tool calls.
- Synthesized `AfterIterationContext.response` must remain coherent even when
  finish reason and usage come from emitted `message.done` while parts and
  `providerMetadata` come from the durable assistant message.
- Provider metadata stays outside approval request, pending tool call, and tool
  executor contracts unless a future TechSpec revision explicitly promotes a
  field.

## Verification Evidence

- Driver coverage lives primarily in
  `boundaries/framework/implementations/typescript/drivers/react/test/react-driver.test.ts`
- Runtime validation coverage lives primarily in
  `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.test.ts`
- The current repo already verifies:
  - generated-response event synthesis
  - streamed structured-output final-only synthesis
  - streamed tool-call final-only args synthesis
  - aroundModel divergence restrictions
  - typed provider failure propagation
  - cancellation boundaries for partial assistant output
