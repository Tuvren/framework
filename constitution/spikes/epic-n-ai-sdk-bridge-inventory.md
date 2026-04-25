# Epic N AI SDK Bridge Inventory

This file closes `KRT-N001` through `KRT-N007` against current repo reality and
records the contract, mapping, and handoff seams that Epic O may depend on
without rediscovering AI SDK provider behavior.

## Current Repo Reality
- `@tuvren/provider-bridge-ai-sdk` now exists at
  `boundaries/providers/implementations/typescript/bridge-ai-sdk`.
- The bridge is locked to `LanguageModelV3` and `ProviderV3` from
  `@ai-sdk/provider@3.0.8`, with `ai@6.0.142` pinned alongside it.
- All AI SDK imports, compatibility drift, prompt/result mapping, structured
  output validation, metadata preservation, and error normalization stay inside
  the bridge package.
- Shared public runtime contracts remain unchanged in Epic N:
  `TuvrenProvider`, `ProviderStreamChunk`, and `TuvrenStreamEvent` were not
  widened to accommodate provider-owned tool or file streaming.

## Contract Homes
- Shared provider contract:
  `boundaries/framework/contracts/runtime-api/src/lib/runtime-contracts.ts`
- Public provider seam re-export:
  `boundaries/providers/contracts/provider-api/src/index.ts`
- AI SDK bridge implementation:
  `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge.ts`
- ReAct/runtime integration seam that consumes bridge output:
  `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver.ts`

## Implemented Baseline
- Prompt/config mapping:
  - `TuvrenPrompt.config.settings` supports only `maxOutputTokens`,
    `temperature`, `topP`, `topK`, `stopSequences`, `presencePenalty`,
    `frequencyPenalty`, `seed`, `toolChoice`, `headers`, and namespaced
    `providerOptions`
  - mismatched `config.model` or `config.provider` fail fast as
    `invalid_ai_sdk_bridge_config`
- Prompt/message mapping:
  - system messages map only from text parts
  - user messages map from text and file parts
  - assistant messages map from text, reasoning, file, and client-executed
    tool-call/tool-result parts
  - tool messages map from durable `tool_result` parts
- Structured output:
  - outbound structured requests use AI SDK JSON response format
  - inbound structured output is synthesized from returned JSON text and
    validated in isolated Ajv validator contexts
  - draft-07 is the default dialect, with explicit draft-2019-09 and
    draft-2020-12 support when `$schema` names them
- Non-stream output mapping:
  - supported AI SDK content: text, reasoning, file, and client-executed
    `tool-call`
  - response metadata, warnings, sources, and detailed usage stay under
    `providerMetadata.aiSdkBridge`
- Stream mapping:
  - `text-*` maps to `text_delta`, or to synthesized `structured_delta` /
    `structured_done` when a structured response format is active
  - `reasoning-*` maps to `reasoning_delta` / `reasoning_done`
  - `tool-input-*` plus client-executed complete `tool-call` map to the
    canonical `tool_call_*` stream chunks, and `tool-input-end` may synthesize
    `tool_call_done` from buffered JSON input when the provider does not send a
    separate complete `tool-call` part
  - when a provider emits both incremental `tool-input-*` parts and a complete
    `tool-call`, the bridge expects the same provider call identity for both
    surfaces, and the final complete `tool-call` name/input must match the
    buffered incremental state for that identity; mismatches fail fast instead
    of duplicating or mutating a canonical tool call
  - `stream-start`, `response-metadata`, `source`, `raw`, and detailed usage are
    preserved under finish metadata

## Explicit Unsupported Surfaces
- Provider-executed tools remain out of scope in Epic N:
  - AI SDK `tool-approval-request`
  - AI SDK `tool-result`
  - AI SDK `tool-call` with `providerExecuted: true`
  - AI SDK dynamic/provider-owned tools
- Streamed AI SDK `file` parts are out of scope in Epic N because the shared
  `ProviderStreamChunk` seam does not expose a live file chunk variant.
- Any of the unsupported surfaces above fail with typed bridge/provider errors;
  they are not silently dropped and do not widen shared runtime contracts.

## Downstream Handoff To Epic O
- Epic O may treat `TuvrenStreamEvent` output from bridge-backed ReAct turns as
  canonical and stable for:
  - text lifecycle events
  - reasoning lifecycle events
  - structured-output lifecycle events synthesized from JSON text
  - tool-call request lifecycle events for client-executed tools
  - finish metadata carrying warnings, response metadata, sources, and raw
    bridge diagnostics
- Epic O must not assume live file events or provider-owned tool-result events
  exist in canonical runtime output.
- Any future desire to stream provider-owned tools, provider approvals, or live
  files requires a new upstream contract change before adapter work begins.

## Validation Targets
- `bun run lint`
- `bun run typecheck`
- `bun run nx run providers-bridge-ai-sdk:typecheck`
- `bun run nx run providers-bridge-ai-sdk:test`
- `bun run nx run providers-bridge-ai-sdk:exports-smoke`
- `bun run nx run framework-runtime-core:test`
