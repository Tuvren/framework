/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type {
  ProviderStreamChunk,
  StructuredOutputRequest,
  TuvrenModelResponse,
} from "@tuvren/provider-api";
import type { ProviderToolClassLookup } from "./ai-sdk-provider-bridge-generate.js";
import {
  bridgeError,
  buildProviderMetadata,
  hasAnthropicRedactedReasoningMetadata,
  isPlainObject,
  isProviderOwnedToolPart,
  mergeProviderMetadataRecords,
  parseJsonInput,
  providerOwnedToolExecutionUnsupportedError,
  readReasoningStreamSignature,
  requireToolState,
  type StreamToolState,
  sanitizeMetadataValue,
  sanitizeRecord,
  sanitizeResponseMetadata,
  unsupportedStreamPartError,
} from "./ai-sdk-provider-bridge-utils.js";

/** Resolved result of `LanguageModelV3.doStream` (stream plus request/response metadata). */
type AiSdkStreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

/**
 * Mutable per-call state threaded through {@link mapStreamPart} while one AI
 * SDK stream is mapped to canonical `ProviderStreamChunk` values
 * (KrakenFrameworkSpecification §3.2).
 *
 * It accumulates everything that only becomes emittable at the terminal
 * `finish` part (warnings, sources, raw parts, response metadata) plus the
 * incremental tool-input and structured-output buffers whose completeness is
 * asserted before the stream may finish. Create it with
 * {@link createStreamMappingState}; never share it across calls.
 */
export interface StreamMappingState {
  model: LanguageModelV3;
  /** Lookup for provider-native/mediated declared tool names; undefined = none declared. */
  providerToolClassLookup?: ProviderToolClassLookup;
  requestBody?: unknown;
  responseFormat?: StructuredOutputRequest;
  responseHeaders?: unknown;
  responseMetadata?: {
    id?: string;
    modelId?: string;
    timestamp?: string;
  };
  streamPartMetadata: unknown[];
  streamRawParts: unknown[];
  streamSources: unknown[];
  streamWarnings: unknown[];
  structuredChunks: string[];
  structuredDoneEmitted: boolean;
  toolStates: Map<string, StreamToolState>;
}

/**
 * Mapping callbacks injected by the bridge so the stream mapper shares the
 * exact finish-reason, usage, and structured-output semantics of the
 * generate path (defined once in `ai-sdk-provider-bridge.ts`).
 */
export interface StreamMappingHelpers {
  mapFinishReason(
    reason: Pick<
      LanguageModelV3GenerateResult["finishReason"],
      "raw" | "unified"
    >,
    options: {
      hasToolCalls?: boolean;
    }
  ): TuvrenModelResponse["finishReason"];
  mapUsage(usage: LanguageModelV3GenerateResult["usage"]): {
    canonical?:
      | {
          inputTokens: number;
          outputTokens: number;
        }
      | undefined;
    rawUsage: unknown;
  };
  parseStructuredOutput(
    serialized: string,
    responseFormat: StructuredOutputRequest
  ): unknown;
}

/**
 * Creates the initial {@link StreamMappingState} for one `doStream` call,
 * capturing the sanitized request body and response headers up front so they
 * can be attributed on the terminal `finish` chunk's provider metadata.
 */
export function createStreamMappingState(input: {
  model: LanguageModelV3;
  providerToolClassLookup?: ProviderToolClassLookup;
  responseFormat?: StructuredOutputRequest;
  streamResult: AiSdkStreamResult;
}): StreamMappingState {
  return {
    model: input.model,
    ...(input.providerToolClassLookup === undefined
      ? {}
      : { providerToolClassLookup: input.providerToolClassLookup }),
    requestBody:
      input.streamResult.request?.body === undefined
        ? undefined
        : sanitizeMetadataValue(input.streamResult.request.body),
    responseFormat: input.responseFormat,
    responseHeaders:
      input.streamResult.response?.headers === undefined
        ? undefined
        : sanitizeMetadataValue(input.streamResult.response.headers),
    responseMetadata: undefined,
    streamPartMetadata: [],
    streamRawParts: [],
    streamSources: [],
    streamWarnings: [],
    structuredChunks: [],
    structuredDoneEmitted: false,
    toolStates: new Map<string, StreamToolState>(),
  };
}

/**
 * Maps one AI SDK stream part into zero or more canonical
 * `ProviderStreamChunk` values, mutating `state` as bookkeeping requires.
 *
 * Part families are tried in order — metadata, text/structured output,
 * reasoning, tool activity, terminal (`finish`/`error`) — and the first
 * handler that recognizes the part wins.
 *
 * @returns The chunks to yield for this part (often empty for bookkeeping
 *   parts such as `stream-start` or `tool-input-end`).
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_stream_part` for
 *   parts outside the baseline contract (for example undeclared
 *   provider-executed tool results), or `structured_output_validation` when
 *   structured output finishes incomplete or invalid.
 */
export function mapStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState,
  helpers: StreamMappingHelpers
): ProviderStreamChunk[] {
  const metadataChunks = handleMetadataStreamPart(part, state);

  if (metadataChunks !== undefined) {
    return metadataChunks;
  }

  const textChunks = handleTextStreamPart(part, state, helpers);

  if (textChunks !== undefined) {
    return textChunks;
  }

  const reasoningChunks = handleReasoningStreamPart(part);

  if (reasoningChunks !== undefined) {
    return reasoningChunks;
  }

  const toolChunks = handleToolStreamPart(part, state);

  if (toolChunks !== undefined) {
    return toolChunks;
  }

  const terminalChunks = handleTerminalStreamPart(part, state, helpers);

  if (terminalChunks !== undefined) {
    return terminalChunks;
  }

  throw unsupportedStreamPartError(part.type, state.model);
}

/**
 * Absorbs metadata-only parts (`stream-start`, `response-metadata`, `source`,
 * `raw`) into state; they surface later on the finish chunk's provider
 * metadata. Returns `undefined` when the part is not a metadata part.
 */
function handleMetadataStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "stream-start":
      state.streamWarnings.push(...part.warnings.map(sanitizeMetadataValue));
      return [];
    case "response-metadata":
      state.responseMetadata = sanitizeResponseMetadata(part);
      return [];
    case "source":
      state.streamSources.push(sanitizeMetadataValue(part));
      return [];
    case "raw":
      state.streamRawParts.push(sanitizeMetadataValue(part.rawValue));
      return [];
    default:
      return undefined;
  }
}

/**
 * Maps text parts. Plain text becomes `text_delta` chunks; when the prompt
 * requested structured output, deltas are buffered as `structured_delta`
 * chunks and `text-end` emits the validated `structured_done`. Returns
 * `undefined` when the part is not a text part.
 */
function handleTextStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState,
  helpers: StreamMappingHelpers
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "text-start":
      assertStructuredStreamStillOpen(state, part.type);
      return [];
    case "text-delta":
      return createTextDeltaChunks(part, state);
    case "text-end": {
      const structuredChunk = createStructuredStreamDoneChunk(state, helpers);

      return structuredChunk === undefined ? [] : [structuredChunk];
    }
    default:
      return undefined;
  }
}

/**
 * Emits a `text_delta` chunk, or in structured-output mode buffers the delta
 * and emits a `structured_delta` chunk instead.
 */
function createTextDeltaChunks(
  part: Extract<LanguageModelV3StreamPart, { type: "text-delta" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  if (state.responseFormat === undefined) {
    return [
      {
        text: part.delta,
        type: "text_delta",
      },
    ];
  }

  assertStructuredStreamStillOpen(state, part.type);
  state.structuredChunks.push(part.delta);

  return [
    {
      delta: part.delta,
      type: "structured_delta",
    },
  ];
}

/**
 * Maps reasoning parts to `reasoning_delta` / `reasoning_done` chunks.
 * Anthropic redacted-reasoning starts emit an empty delta so the redacted
 * block is still observable downstream. Returns `undefined` when the part is
 * not a reasoning part.
 */
function handleReasoningStreamPart(
  part: LanguageModelV3StreamPart
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "reasoning-start":
      return createReasoningStartChunks(part);
    case "reasoning-delta":
      return [createReasoningDeltaChunk(part)];
    case "reasoning-end":
      return [
        {
          type: "reasoning_done",
        },
      ];
    default:
      return undefined;
  }
}

/**
 * Emits an empty `reasoning_delta` only for Anthropic redacted reasoning, so
 * the redacted block's existence survives even though no text will stream.
 */
function createReasoningStartChunks(
  part: Extract<LanguageModelV3StreamPart, { type: "reasoning-start" }>
): ProviderStreamChunk[] {
  return hasAnthropicRedactedReasoningMetadata(part.providerMetadata)
    ? [
        {
          text: "",
          type: "reasoning_delta",
        },
      ]
    : [];
}

/**
 * Maps a reasoning delta, attaching the provider's opaque reasoning
 * signature (anthropic `signature`, google/vertex `thoughtSignature`) when
 * present so hosts can replay it on later turns.
 */
function createReasoningDeltaChunk(
  part: Extract<LanguageModelV3StreamPart, { type: "reasoning-delta" }>
): Extract<ProviderStreamChunk, { type: "reasoning_delta" }> {
  const signature = readReasoningStreamSignature(part.providerMetadata);

  return {
    ...(signature === undefined
      ? {}
      : {
          signature,
        }),
    text: part.delta,
    type: "reasoning_delta",
  };
}

/**
 * Maps tool-activity parts. Client function tools flow through the
 * `tool_call_start` → `tool_call_args_delta` → `tool_call_done` chunk
 * sequence; declared provider-native/mediated tool results become
 * `provider_tool_result` chunks; undeclared provider-owned activity and
 * `file` / `tool-approval-request` parts are rejected (baseline protection,
 * KRT-BH005 / ADR-055). Returns `undefined` when the part is not a tool part.
 */
function handleToolStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "tool-input-start":
      return handleToolInputStartPart(part, state);
    case "tool-input-delta":
      return handleToolInputDeltaPart(part, state);
    case "tool-input-end":
      return handleToolInputEndPart(part, state);
    case "tool-call":
      return handleToolCallStreamPart(part, state);
    case "tool-result": {
      // Accept for declared provider-native/mediated tools; reject undeclared (baseline protection).
      if (state.providerToolClassLookup !== undefined) {
        const executionClass = state.providerToolClassLookup(part.toolName);
        if (executionClass !== undefined) {
          return mapProviderToolResultStreamPart(part, executionClass);
        }
      }
      throw unsupportedStreamPartError(part.type, state.model);
    }
    case "file":
    case "tool-approval-request":
      throw unsupportedStreamPartError(part.type, state.model);
    default:
      return undefined;
  }
}

/**
 * Maps a declared provider-executed tool result to a `provider_tool_result`
 * chunk tagged with its execution class and `owner: "provider"` attribution
 * (AY002/AY004).
 */
function mapProviderToolResultStreamPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-result" }>,
  executionClass: "provider-native" | "provider-mediated"
): ProviderStreamChunk[] {
  const providerMetadata = sanitizeRecord(part.providerMetadata);
  const chunk: Extract<ProviderStreamChunk, { type: "provider_tool_result" }> =
    {
      isError: part.isError,
      name: part.toolName,
      providerCallId: part.toolCallId,
      providerMetadata: {
        ...(providerMetadata ?? {}),
        executionClass,
        owner: "provider",
      },
      result: sanitizeMetadataValue(part.result) ?? null,
      type: "provider_tool_result",
    };
  return [chunk];
}

/**
 * Seeds the per-call tool state and, for client tools, emits
 * `tool_call_start`. Declared provider-owned tools are marked in state and
 * emit nothing here (see the inline KRT-BH005 note); undeclared
 * provider-owned tools are rejected.
 */
function handleToolInputStartPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-input-start" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  // KRT-BH005 / ADR-055: real providers stream a provider-executed
  // (providerExecuted/dynamic) tool as tool-input-start → tool-input-delta →
  // tool-input-end → tool-call → tool-result (e.g. @ai-sdk/openai Responses
  // web_search / code_interpreter). Only tool-input-start carries the
  // providerExecuted/dynamic flags, so a declared provider-native/mediated tool is
  // recognised here, marked provider-owned, and emits no client-facing
  // tool_call_start — the matching tool-result yields the provider_tool_result
  // attribution (AY002/AY004) and the subsequent input/tool-call parts are skipped
  // via the marker. Undeclared provider-owned execution stays rejected (baseline
  // protection).
  const providerOwned = isProviderOwnedToolPart(part);
  if (
    providerOwned &&
    state.providerToolClassLookup?.(part.toolName) === undefined
  ) {
    throw providerOwnedToolExecutionUnsupportedError(
      part.toolName,
      state.model
    );
  }

  state.toolStates.set(part.id, {
    doneEmitted: false,
    ended: false,
    inputBuffer: "",
    name: part.toolName,
    providerMetadata: readStreamToolPartProviderMetadata(part),
    ...(providerOwned ? { providerOwned: true } : {}),
    started: true,
  });

  if (providerOwned) {
    return [];
  }

  return [
    {
      name: part.toolName,
      providerCallId: part.id,
      type: "tool_call_start",
    },
  ];
}

/**
 * Buffers a tool-input delta into the correlated tool state and emits a
 * `tool_call_args_delta` chunk; provider-owned tool input never surfaces
 * (KRT-BH005).
 *
 * @throws TuvrenProviderError when the delta arrives before its
 *   `tool-input-start` (no correlated state).
 */
function handleToolInputDeltaPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-input-delta" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  const toolState = requireToolState(
    state.toolStates,
    part.id,
    state.model,
    part
  );
  if (toolState.providerOwned === true) {
    // Provider-executed tool input is the provider's own bookkeeping; never surface
    // an args delta the runtime would attribute to a client tool call (KRT-BH005).
    return [];
  }
  toolState.inputBuffer += part.delta;
  toolState.providerMetadata = mergeProviderMetadataRecords(
    toolState.providerMetadata,
    readStreamToolPartProviderMetadata(part)
  );

  return [
    {
      delta: part.delta,
      providerCallId: part.id,
      type: "tool_call_args_delta",
    },
  ];
}

/**
 * Marks the tool input as ended (bookkeeping only — the `tool_call_done`
 * chunk is emitted by the matching `tool-call` part or flushed at finish).
 */
function handleToolInputEndPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-input-end" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  const toolState = requireToolState(
    state.toolStates,
    part.id,
    state.model,
    part
  );
  if (toolState.providerOwned === true) {
    // Provider-executed tool input end carries no client-facing signal (KRT-BH005).
    return [];
  }
  toolState.ended = true;
  toolState.providerMetadata = mergeProviderMetadataRecords(
    toolState.providerMetadata,
    readStreamToolPartProviderMetadata(part)
  );
  return [];
}

/**
 * Maps a complete `tool-call` part. Declared provider-owned calls are
 * skipped (their attribution comes from the matching `tool-result`; see the
 * inline KRT-BH005 / ADR-055 note); client calls are correlated against any
 * incremental tool-input state, then emit the missing prelude chunks and a
 * `tool_call_done` exactly once per provider call id.
 */
function handleToolCallStreamPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  // KRT-BH005 / ADR-055: a provider-executed (providerExecuted/dynamic) tool-call
  // declared as provider-native/mediated is the provider's own executed call;
  // skip it (the matching tool-result yields the provider_tool_result attribution
  // — AY002/AY004) and emit no client-facing tool_call chunk. A tool-state already
  // marked provider-owned by its tool-input-start prelude is decisive even if the
  // tool-call part omits the flags. Undeclared provider-owned execution stays out
  // of scope (baseline protection).
  //
  // The seeded-state lookup relies on the AI SDK convention that a tool's
  // tool-input-start `id` equals its terminal tool-call `toolCallId` (the same
  // identity the rest of the bridge correlates on, and what real providers —
  // OpenAI Responses, Anthropic, Google, MCP — emit). If a provider both renamed
  // the id mid-stream AND dropped the providerExecuted/dynamic flags on the
  // terminal tool-call, neither this marker nor the flag check below would catch
  // it; no shipped provider does either, so that doubly-hypothetical shape is out
  // of the audited contract.
  const seededToolState = state.toolStates.get(part.toolCallId);
  if (seededToolState?.providerOwned === true) {
    return [];
  }
  if (isProviderOwnedToolPart(part)) {
    if (state.providerToolClassLookup?.(part.toolName) !== undefined) {
      return [];
    }
    throw providerOwnedToolExecutionUnsupportedError(
      part.toolName,
      state.model
    );
  }
  assertToolCallCorrelation(part, state);

  const chunks = createToolCallPreludeChunks(part, state);
  const existingState = state.toolStates.get(part.toolCallId);
  const providerMetadata = mergeProviderMetadataRecords(
    existingState?.providerMetadata,
    readStreamToolPartProviderMetadata(part)
  );

  if (existingState?.doneEmitted === true) {
    existingState.providerMetadata = providerMetadata;
    return chunks;
  }

  chunks.push(
    createToolCallDoneChunk(
      part.toolCallId,
      part.toolName,
      part.input,
      state.model,
      providerMetadata
    )
  );
  state.toolStates.set(part.toolCallId, {
    doneEmitted: true,
    ended: true,
    inputBuffer: part.input,
    name: part.toolName,
    providerMetadata,
    started: true,
  });

  return chunks;
}

/**
 * Asserts that a complete `tool-call` part is consistent with the
 * incremental tool-input state: a same-id state must match on name and
 * buffered input, and a matching-content state under a different id (single
 * or ambiguous) is rejected as a correlation error.
 *
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_stream_part` on
 *   any mismatch.
 */
function assertToolCallCorrelation(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
  state: StreamMappingState
): void {
  const existingState = state.toolStates.get(part.toolCallId);

  if (existingState != null) {
    if (
      existingState.name === part.toolName &&
      existingState.inputBuffer === part.input
    ) {
      return;
    }

    throw bridgeError(
      "AI SDK stream emitted a complete tool-call that conflicts with the incremental tool-input state",
      "unsupported_ai_sdk_stream_part",
      {
        expectedInput: existingState.inputBuffer,
        expectedToolName: existingState.name,
        modelId: state.model.modelId,
        provider: state.model.provider,
        receivedInput: part.input,
        receivedToolCallId: part.toolCallId,
        receivedToolName: part.toolName,
      }
    );
  }

  const correlatedIds = [...state.toolStates.entries()]
    .filter(
      ([, toolState]) =>
        // Provider-owned (provider-executed/dynamic) states are skipped
        // bookkeeping — they linger with inputBuffer === "" and must never
        // correlate to a client tool-call. Without this guard a same-named client
        // tool-call with empty input would spuriously match a provider tool's
        // lingering state and surface a misleading correlation-mismatch error
        // instead of the accurate input-validation error (KRT-BH005).
        toolState.providerOwned !== true &&
        toolState.inputBuffer === part.input &&
        toolState.name === part.toolName
    )
    .map(([providerCallId]) => providerCallId);

  if (correlatedIds.length === 0) {
    return;
  }

  if (correlatedIds.length === 1) {
    throw bridgeError(
      "AI SDK stream emitted a complete tool-call with a mismatched incremental tool-input id",
      "unsupported_ai_sdk_stream_part",
      {
        expectedProviderCallId: correlatedIds[0],
        modelId: state.model.modelId,
        provider: state.model.provider,
        receivedToolCallId: part.toolCallId,
        toolName: part.toolName,
      }
    );
  }

  throw bridgeError(
    "AI SDK stream emitted an ambiguous complete tool-call correlation",
    "unsupported_ai_sdk_stream_part",
    {
      candidateProviderCallIds: correlatedIds,
      modelId: state.model.modelId,
      provider: state.model.provider,
      receivedToolCallId: part.toolCallId,
      toolName: part.toolName,
    }
  );
}

/**
 * Emits the `tool_call_start` (and args delta) prelude for a complete
 * `tool-call` whose input never streamed incrementally; returns nothing when
 * the prelude was already emitted by `tool-input-start`.
 */
function createToolCallPreludeChunks(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  const existingState = state.toolStates.get(part.toolCallId);

  if (existingState?.started === true) {
    return [];
  }

  const chunks: ProviderStreamChunk[] = [
    {
      name: part.toolName,
      providerCallId: part.toolCallId,
      type: "tool_call_start",
    },
  ];

  if (part.input.length > 0) {
    chunks.push({
      delta: part.input,
      providerCallId: part.toolCallId,
      type: "tool_call_args_delta",
    });
  }

  return chunks;
}

/**
 * Builds the terminal `tool_call_done` chunk, parsing the buffered input as
 * JSON.
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_tool_call_input`
 *   when the accumulated input is not valid JSON.
 */
function createToolCallDoneChunk(
  providerCallId: string,
  toolName: string,
  input: string,
  model: Pick<LanguageModelV3, "modelId" | "provider">,
  providerMetadata?: Record<string, unknown>
): ProviderStreamChunk {
  return {
    input: parseJsonInput(
      input,
      "tool call input",
      "invalid_ai_sdk_tool_call_input",
      {
        modelId: model.modelId,
        provider: model.provider,
        toolName,
      }
    ),
    name: toolName,
    providerCallId,
    ...(providerMetadata === undefined
      ? {}
      : {
          providerMetadata,
        }),
    type: "tool_call_done",
  };
}

/** Reads and sanitizes a tool part's provider metadata, if it is a plain object. */
function readStreamToolPartProviderMetadata(part: {
  providerMetadata?: unknown;
}): Record<string, unknown> | undefined {
  return isPlainObject(part.providerMetadata)
    ? sanitizeRecord(part.providerMetadata)
    : undefined;
}

/**
 * Maps terminal parts: `finish` closes out tool calls, structured output,
 * and usage into the final chunks; `error` surfaces as an `error` chunk.
 * Returns `undefined` when the part is not terminal.
 */
function handleTerminalStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState,
  helpers: StreamMappingHelpers
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "finish":
      return createFinishStreamChunks(part, state, helpers);
    case "error":
      return [
        {
          error: part.error,
          type: "error",
        },
      ];
    default:
      return undefined;
  }
}

/**
 * Produces the end-of-stream chunk sequence for a `finish` part: flushes any
 * ended-but-unemitted tool calls, emits pending `structured_done`, asserts
 * every client tool call and requested structured output completed, and
 * closes with a `finish` chunk carrying the normalized finish reason,
 * canonical usage, and aggregated provider metadata.
 */
function createFinishStreamChunks(
  part: Extract<LanguageModelV3StreamPart, { type: "finish" }>,
  state: StreamMappingState,
  helpers: StreamMappingHelpers
): ProviderStreamChunk[] {
  const chunks = flushCompletedToolCalls(state);
  const structuredChunk = createStructuredStreamDoneChunk(state, helpers);

  if (structuredChunk !== undefined) {
    chunks.push(structuredChunk);
  }

  ensureToolCallsCompleted(state);
  ensureStructuredStreamCompleted(state, part.finishReason.unified);
  const usage = helpers.mapUsage(part.usage);
  const providerMetadata = buildStreamFinishProviderMetadata(
    part.providerMetadata,
    state,
    usage.rawUsage
  );

  chunks.push({
    finishReason: helpers.mapFinishReason(part.finishReason, {
      // Provider-owned (provider-executed/dynamic) tool states are skipped
      // bookkeeping, not client tool calls — they must not push a `stop` turn
      // into the tool-call finish-reason normalization, which would diverge from
      // the generate path (it counts emitted tool_call parts) and spuriously
      // drive a continue/execute-tools iteration with no client call (KRT-BH005).
      hasToolCalls: [...state.toolStates.values()].some(
        (toolState) => toolState.providerOwned !== true
      ),
    }),
    ...(providerMetadata === undefined
      ? {}
      : {
          providerMetadata,
        }),
    ...(usage.canonical === undefined
      ? {}
      : {
          usage: usage.canonical,
        }),
    type: "finish",
  });

  return chunks;
}

/**
 * Emits `tool_call_done` for every tool whose input ended without a
 * corresponding complete `tool-call` part (providers that stream input
 * deltas only), marking each as emitted so finish-time assertions pass.
 */
function flushCompletedToolCalls(
  state: StreamMappingState
): ProviderStreamChunk[] {
  const chunks: ProviderStreamChunk[] = [];

  for (const [providerCallId, toolState] of state.toolStates.entries()) {
    if (toolState.doneEmitted || !toolState.ended) {
      continue;
    }

    toolState.doneEmitted = true;
    chunks.push(
      createToolCallDoneChunk(
        providerCallId,
        toolState.name,
        toolState.inputBuffer,
        state.model,
        toolState.providerMetadata
      )
    );
  }

  return chunks;
}

/**
 * Aggregates everything captured during the stream (raw parts, usage,
 * request body, response headers/metadata, sources, per-part metadata,
 * warnings) into the finish chunk's provider metadata. Bridge-captured
 * extras are secret-screened inside {@link buildProviderMetadata} (ADR-044).
 */
function buildStreamFinishProviderMetadata(
  providerMetadata: Record<string, unknown> | undefined,
  state: StreamMappingState,
  rawUsage: unknown
): Record<string, unknown> | undefined {
  return buildProviderMetadata({
    bridgeExtras: {
      rawParts: state.streamRawParts,
      rawUsage,
      requestBody: state.requestBody,
      response: {
        headers: state.responseHeaders,
        metadata: state.responseMetadata,
      },
      sources: state.streamSources,
      streamPartMetadata: state.streamPartMetadata,
      warnings: state.streamWarnings,
    },
    providerMetadata,
  });
}

/**
 * Rejects text parts arriving after structured output already completed —
 * structured output must be a single contiguous JSON document.
 */
function assertStructuredStreamStillOpen(
  state: StreamMappingState,
  partType: string
): void {
  if (state.responseFormat === undefined || !state.structuredDoneEmitted) {
    return;
  }

  throw bridgeError(
    "AI SDK stream emitted text after structured output completed",
    "unsupported_ai_sdk_stream_part",
    {
      modelId: state.model.modelId,
      partType,
      provider: state.model.provider,
    }
  );
}

/**
 * Emits the `structured_done` chunk once buffered structured text exists:
 * joins the deltas, parses and validates them against the requested schema,
 * and marks structured output complete. Returns `undefined` when structured
 * output was not requested, already emitted, or nothing buffered yet.
 */
function createStructuredStreamDoneChunk(
  state: StreamMappingState,
  helpers: StreamMappingHelpers
): ProviderStreamChunk | undefined {
  if (
    state.responseFormat === undefined ||
    state.structuredDoneEmitted ||
    state.structuredChunks.length === 0
  ) {
    return undefined;
  }

  state.structuredDoneEmitted = true;

  return {
    data: helpers.parseStructuredOutput(
      state.structuredChunks.join(""),
      state.responseFormat
    ),
    ...(state.responseFormat.name === undefined
      ? {}
      : {
          name: state.responseFormat.name,
        }),
    type: "structured_done",
  };
}

/**
 * Asserts at finish time that requested structured output was emitted,
 * unless the turn legitimately ended in client tool calls instead (see
 * {@link canOmitStructuredStreamOutput}).
 *
 * @throws TuvrenProviderError with code `structured_output_validation`.
 */
function ensureStructuredStreamCompleted(
  state: StreamMappingState,
  finishReason: Extract<
    LanguageModelV3StreamPart,
    { type: "finish" }
  >["finishReason"]["unified"]
): void {
  if (
    state.responseFormat === undefined ||
    state.structuredDoneEmitted ||
    canOmitStructuredStreamOutput(state, finishReason)
  ) {
    return;
  }

  throw bridgeError(
    "AI SDK stream finished without structured output text",
    "structured_output_validation",
    {
      modelId: state.model.modelId,
      provider: state.model.provider,
    }
  );
}

/**
 * Structured output may be omitted only for a `tool-calls` finish where
 * every client tool call completed (provider-owned states do not count —
 * KRT-BH005); the model will produce the structured document on a later
 * iteration after tool results return.
 */
function canOmitStructuredStreamOutput(
  state: StreamMappingState,
  finishReason: Extract<
    LanguageModelV3StreamPart,
    { type: "finish" }
  >["finishReason"]["unified"]
): boolean {
  if (finishReason !== "tool-calls" || state.toolStates.size === 0) {
    return false;
  }

  for (const toolState of state.toolStates.values()) {
    // Provider-owned tool inputs never emit a client tool_call_done; they do not
    // gate client tool-call completion (KRT-BH005).
    if (toolState.providerOwned === true) {
      continue;
    }
    if (!toolState.doneEmitted) {
      return false;
    }
  }

  return true;
}

/**
 * Asserts at finish time that every client tool call emitted its
 * `tool_call_done`; provider-owned states are exempt (KRT-BH005).
 *
 * @throws TuvrenProviderError with code `unsupported_ai_sdk_stream_part`.
 */
function ensureToolCallsCompleted(state: StreamMappingState): void {
  for (const [providerCallId, toolState] of state.toolStates.entries()) {
    // Provider-owned tool inputs never emit a client-facing tool_call_done — they
    // are skipped bookkeeping for the provider's own executed call (KRT-BH005), so
    // they are not subject to the client tool-call completeness invariant.
    if (toolState.doneEmitted || toolState.providerOwned === true) {
      continue;
    }

    throw bridgeError(
      "AI SDK stream finished before tool call completed",
      "unsupported_ai_sdk_stream_part",
      {
        modelId: state.model.modelId,
        provider: state.model.provider,
        providerCallId,
        toolName: toolState.name,
      }
    );
  }
}
