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
  mergeProviderMetadataRecords,
  parseJsonInput,
  readReasoningStreamSignature,
  rejectUnsupportedProviderOwnedToolPart,
  requireToolState,
  type StreamToolState,
  sanitizeMetadataValue,
  sanitizeRecord,
  sanitizeResponseMetadata,
  unsupportedStreamPartError,
} from "./ai-sdk-provider-bridge-utils.js";

type AiSdkStreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

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

function handleToolInputStartPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-input-start" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  rejectUnsupportedProviderOwnedToolPart(part, state.model);
  state.toolStates.set(part.id, {
    doneEmitted: false,
    ended: false,
    inputBuffer: "",
    name: part.toolName,
    providerMetadata: readStreamToolPartProviderMetadata(part),
    started: true,
  });

  return [
    {
      name: part.toolName,
      providerCallId: part.id,
      type: "tool_call_start",
    },
  ];
}

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
  toolState.ended = true;
  toolState.providerMetadata = mergeProviderMetadataRecords(
    toolState.providerMetadata,
    readStreamToolPartProviderMetadata(part)
  );
  return [];
}

function handleToolCallStreamPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  rejectUnsupportedProviderOwnedToolPart(part, state.model);
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
        toolState.inputBuffer === part.input && toolState.name === part.toolName
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

function readStreamToolPartProviderMetadata(part: {
  providerMetadata?: unknown;
}): Record<string, unknown> | undefined {
  return isPlainObject(part.providerMetadata)
    ? sanitizeRecord(part.providerMetadata)
    : undefined;
}

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
      hasToolCalls: state.toolStates.size > 0,
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
    if (!toolState.doneEmitted) {
      return false;
    }
  }

  return true;
}

function ensureToolCallsCompleted(state: StreamMappingState): void {
  for (const [providerCallId, toolState] of state.toolStates.entries()) {
    if (toolState.doneEmitted) {
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
