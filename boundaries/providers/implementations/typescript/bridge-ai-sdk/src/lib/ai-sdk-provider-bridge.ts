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
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3File,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  ProviderV3,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { AISDKError } from "@ai-sdk/provider";
import { TuvrenProviderError } from "@tuvren/core-types";
import type {
  ProviderStreamChunk,
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/provider-api";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

const SUPPORTED_BRIDGE_SETTINGS = new Set([
  "frequencyPenalty",
  "headers",
  "maxOutputTokens",
  "presencePenalty",
  "providerOptions",
  "seed",
  "stopSequences",
  "temperature",
  "toolChoice",
  "topK",
  "topP",
]);
const STRUCTURED_OUTPUT_AJV_OPTIONS = {
  addUsedSchema: false,
  allErrors: true,
  strict: false,
};
const JSON_SCHEMA_DRAFT_7_URIS = new Set([
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#",
]);
const JSON_SCHEMA_DRAFT_2019_09_URIS = new Set([
  "http://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft/2019-09/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2019-09/schema#",
]);
const JSON_SCHEMA_DRAFT_2020_12_URIS = new Set([
  "http://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
]);

type TuvrenMessage = TuvrenPrompt["messages"][number];
type TuvrenPromptPart = Extract<
  TuvrenMessage,
  {
    parts: unknown[];
  }
>["parts"][number];
type TuvrenToolDefinition = NonNullable<TuvrenPrompt["tools"]>[number];
type AiSdkStreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;
interface JsonObject {
  [key: string]: JsonValue | undefined;
}
type JsonValue = null | string | number | boolean | JsonValue[] | JsonObject;

interface StreamToolState {
  doneEmitted: boolean;
  ended: boolean;
  inputBuffer: string;
  name: string;
  started: boolean;
}

interface GenerateResultState {
  parts: TuvrenModelResponse["parts"];
  responseFormat?: StructuredOutputRequest;
  sources: unknown[];
  structuredChunks: string[];
}

interface StreamMappingState {
  model: LanguageModelV3;
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

export interface AiSdkProviderBridgeOptions {
  defaultHeaders?: Record<string, string | undefined>;
  defaultProviderOptions?: SharedV3ProviderOptions;
  id?: string;
  model: LanguageModelV3;
}

export interface AiSdkProviderBridgeFromProviderOptions
  extends Omit<AiSdkProviderBridgeOptions, "model"> {
  modelId: string;
  provider: ProviderV3;
}

class AiSdkProviderBridge implements TuvrenProvider {
  readonly id: string;
  private readonly defaultHeaders?: Record<string, string | undefined>;
  private readonly defaultProviderOptions?: SharedV3ProviderOptions;
  private readonly model: LanguageModelV3;

  constructor(options: AiSdkProviderBridgeOptions) {
    this.model = options.model;
    this.defaultHeaders = cloneHeaders(options.defaultHeaders);
    this.defaultProviderOptions = cloneProviderOptions(
      options.defaultProviderOptions
    );
    this.id =
      options.id ?? `ai-sdk:${this.model.provider}:${this.model.modelId}`;
  }

  async generate(prompt: TuvrenPrompt): Promise<TuvrenModelResponse> {
    try {
      const result = await this.model.doGenerate(
        createCallOptions({
          bridgeId: this.id,
          defaultHeaders: this.defaultHeaders,
          defaultProviderOptions: this.defaultProviderOptions,
          model: this.model,
          prompt,
        })
      );

      return mapGenerateResult(result, prompt.responseFormat);
    } catch (error: unknown) {
      throw normalizeBridgeError(error, "ai_sdk_generate_failed", {
        modelId: this.model.modelId,
        provider: this.model.provider,
      });
    }
  }

  async *stream(prompt: TuvrenPrompt): AsyncIterable<ProviderStreamChunk> {
    const callOptions = createCallOptions({
      bridgeId: this.id,
      defaultHeaders: this.defaultHeaders,
      defaultProviderOptions: this.defaultProviderOptions,
      includeRawChunks: true,
      model: this.model,
      prompt,
    });
    const streamResult = await loadStreamResult(this.model, callOptions);
    const reader = streamResult.stream.getReader();
    const state = createStreamMappingState({
      model: this.model,
      responseFormat: prompt.responseFormat,
      streamResult,
    });
    let readerDone = false;

    try {
      while (!readerDone) {
        const nextPart = await reader.read();
        if (nextPart.done || nextPart.value === undefined) {
          readerDone = true;
          break;
        }

        const part = nextPart.value;
        captureStreamPartMetadata(state.streamPartMetadata, part);

        for (const chunk of mapStreamPart(part, state)) {
          yield chunk;
        }
      }
    } catch (error: unknown) {
      throw normalizeBridgeError(error, "ai_sdk_stream_failed", {
        modelId: this.model.modelId,
        provider: this.model.provider,
      });
    } finally {
      if (!readerDone) {
        await reader.cancel().catch(() => undefined);
      }

      reader.releaseLock();
    }
  }
}

export function createAiSdkProviderBridge(
  options: AiSdkProviderBridgeOptions
): TuvrenProvider {
  return new AiSdkProviderBridge(options);
}

export function createAiSdkProviderBridgeFromProvider(
  options: AiSdkProviderBridgeFromProviderOptions
): TuvrenProvider {
  try {
    return createAiSdkProviderBridge({
      defaultHeaders: options.defaultHeaders,
      defaultProviderOptions: options.defaultProviderOptions,
      id: options.id,
      model: options.provider.languageModel(options.modelId),
    });
  } catch (error: unknown) {
    throw normalizeBridgeError(error, "ai_sdk_provider_lookup_failed", {
      modelId: options.modelId,
    });
  }
}

async function loadStreamResult(
  model: LanguageModelV3,
  callOptions: LanguageModelV3CallOptions
): Promise<AiSdkStreamResult> {
  try {
    return await model.doStream(callOptions);
  } catch (error: unknown) {
    throw normalizeBridgeError(error, "ai_sdk_stream_failed", {
      modelId: model.modelId,
      provider: model.provider,
    });
  }
}

function createStreamMappingState(input: {
  model: LanguageModelV3;
  responseFormat?: StructuredOutputRequest;
  streamResult: AiSdkStreamResult;
}): StreamMappingState {
  return {
    model: input.model,
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

function mapStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState
): ProviderStreamChunk[] {
  const metadataChunks = handleMetadataStreamPart(part, state);

  if (metadataChunks !== undefined) {
    return metadataChunks;
  }

  const textChunks = handleTextStreamPart(part, state);

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

  const terminalChunks = handleTerminalStreamPart(part, state);

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
  state: StreamMappingState
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "text-start":
      assertStructuredStreamStillOpen(state, part.type);
      return [];
    case "text-delta":
      return createTextDeltaChunks(part, state);
    case "text-end": {
      const structuredChunk = createStructuredStreamDoneChunk(state);

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
      return [];
    case "reasoning-delta":
      return [
        {
          text: part.delta,
          type: "reasoning_delta",
        },
      ];
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
    case "tool-result":
    case "file":
    case "tool-approval-request":
      throw unsupportedStreamPartError(part.type, state.model);
    default:
      return undefined;
  }
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

  if (toolState.doneEmitted) {
    return [];
  }

  toolState.doneEmitted = true;

  return [
    createToolCallDoneChunk(
      part.id,
      toolState.name,
      toolState.inputBuffer,
      state.model
    ),
  ];
}

function handleToolCallStreamPart(
  part: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
  state: StreamMappingState
): ProviderStreamChunk[] {
  rejectUnsupportedProviderOwnedToolPart(part, state.model);
  assertToolCallCorrelation(part, state);

  const chunks = createToolCallPreludeChunks(part, state);
  const existingState = state.toolStates.get(part.toolCallId);

  if (existingState?.doneEmitted === true) {
    return chunks;
  }

  chunks.push(
    createToolCallDoneChunk(
      part.toolCallId,
      part.toolName,
      part.input,
      state.model
    )
  );
  state.toolStates.set(part.toolCallId, {
    doneEmitted: true,
    ended: true,
    inputBuffer: part.input,
    name: part.toolName,
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
  model: Pick<LanguageModelV3, "modelId" | "provider">
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
    type: "tool_call_done",
  };
}

function handleTerminalStreamPart(
  part: LanguageModelV3StreamPart,
  state: StreamMappingState
): ProviderStreamChunk[] | undefined {
  switch (part.type) {
    case "finish":
      return createFinishStreamChunks(part, state);
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
  state: StreamMappingState
): ProviderStreamChunk[] {
  const chunks: ProviderStreamChunk[] = [];
  const structuredChunk = createStructuredStreamDoneChunk(state);

  if (structuredChunk !== undefined) {
    chunks.push(structuredChunk);
  }

  ensureStructuredStreamCompleted(state);
  const usage = mapUsage(part.usage);
  const providerMetadata = buildStreamFinishProviderMetadata(
    part.providerMetadata,
    state,
    usage.rawUsage
  );

  chunks.push({
    finishReason: mapFinishReason(part.finishReason.unified),
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
  state: StreamMappingState
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
    data: parseStructuredOutput(
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

function ensureStructuredStreamCompleted(state: StreamMappingState): void {
  if (state.responseFormat === undefined || state.structuredDoneEmitted) {
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

function createCallOptions(input: {
  bridgeId: string;
  defaultHeaders?: Record<string, string | undefined>;
  defaultProviderOptions?: SharedV3ProviderOptions;
  includeRawChunks?: boolean;
  model: LanguageModelV3;
  prompt: TuvrenPrompt;
}): LanguageModelV3CallOptions {
  const settings = normalizeBridgeSettings(input.prompt);
  const requestedModel = input.prompt.config?.model;
  const requestedProvider = input.prompt.config?.provider;

  if (
    typeof requestedModel === "string" &&
    requestedModel.trim().length > 0 &&
    requestedModel !== input.model.modelId
  ) {
    throw bridgeError(
      "TuvrenPrompt.config.model does not match the bound AI SDK model",
      "invalid_ai_sdk_bridge_config",
      {
        expectedModel: input.model.modelId,
        requestedModel,
      }
    );
  }

  if (
    typeof requestedProvider === "string" &&
    requestedProvider.trim().length > 0 &&
    requestedProvider !== input.model.provider &&
    requestedProvider !== input.bridgeId
  ) {
    throw bridgeError(
      "TuvrenPrompt.config.provider does not match the bound AI SDK provider",
      "invalid_ai_sdk_bridge_config",
      {
        expectedProvider: input.model.provider,
        requestedProvider,
        tuvrenProviderId: input.bridgeId,
      }
    );
  }

  const headers = mergeHeaders(input.defaultHeaders, settings.headers);
  const providerOptions = mergeProviderOptions(
    input.defaultProviderOptions,
    settings.providerOptions
  );
  const toolChoice = normalizeToolChoice(settings.toolChoice);

  return {
    ...(typeof settings.frequencyPenalty === "number"
      ? {
          frequencyPenalty: settings.frequencyPenalty,
        }
      : {}),
    ...(headers === undefined
      ? {}
      : {
          headers,
        }),
    ...(input.includeRawChunks === true
      ? {
          includeRawChunks: true,
        }
      : {}),
    ...(typeof settings.maxOutputTokens === "number"
      ? {
          maxOutputTokens: settings.maxOutputTokens,
        }
      : {}),
    ...(typeof settings.presencePenalty === "number"
      ? {
          presencePenalty: settings.presencePenalty,
        }
      : {}),
    prompt: mapPromptMessages(input.prompt.messages),
    ...(providerOptions === undefined
      ? {}
      : {
          providerOptions,
        }),
    ...(input.prompt.responseFormat === undefined
      ? {}
      : {
          responseFormat: {
            name: input.prompt.responseFormat.name,
            schema: cloneJsonSchema(input.prompt.responseFormat.schema),
            type: "json",
          },
        }),
    ...(typeof settings.seed === "number"
      ? {
          seed: settings.seed,
        }
      : {}),
    ...(settings.stopSequences === undefined
      ? {}
      : {
          stopSequences: settings.stopSequences,
        }),
    ...(typeof settings.temperature === "number"
      ? {
          temperature: settings.temperature,
        }
      : {}),
    ...(toolChoice === undefined
      ? {}
      : {
          toolChoice,
        }),
    ...(input.prompt.tools === undefined || input.prompt.tools.length === 0
      ? {}
      : {
          tools: input.prompt.tools.map(mapToolDefinition),
        }),
    ...(typeof settings.topK === "number"
      ? {
          topK: settings.topK,
        }
      : {}),
    ...(typeof settings.topP === "number"
      ? {
          topP: settings.topP,
        }
      : {}),
  };
}

function mapPromptMessages(
  messages: TuvrenPrompt["messages"]
): LanguageModelV3Prompt {
  return messages.map((message) => mapPromptMessage(message));
}

function mapPromptMessage(message: TuvrenMessage): LanguageModelV3Message {
  switch (message.role) {
    case "system": {
      return {
        content: message.content,
        role: "system",
      };
    }

    case "user": {
      return {
        content: message.parts.map((part) => mapUserPart(part)),
        role: "user",
      };
    }

    case "assistant": {
      return {
        content: message.parts.map((part) => mapAssistantPart(part)),
        role: "assistant",
      };
    }

    case "tool": {
      return {
        content: message.parts.map((part) => mapToolResultPart(part)),
        role: "tool",
      };
    }

    default: {
      throw bridgeError(
        "unsupported Tuvren message role in AI SDK prompt mapping",
        "unsupported_ai_sdk_prompt_part",
        {
          role: (message as { role?: unknown }).role,
        }
      );
    }
  }
}

function mapUserPart(part: TuvrenPromptPart) {
  switch (part.type) {
    case "text": {
      return {
        text: part.text,
        type: "text",
      } satisfies LanguageModelV3Message["content"][number];
    }

    case "file": {
      return {
        data: cloneFileData(part.data),
        ...(typeof part.filename === "string"
          ? {
              filename: part.filename,
            }
          : {}),
        mediaType: part.mediaType,
        type: "file",
      } satisfies LanguageModelV3Message["content"][number];
    }

    case "structured": {
      return {
        text: JSON.stringify(part.data),
        type: "text",
      } satisfies LanguageModelV3Message["content"][number];
    }

    default: {
      throw bridgeError(
        "user messages only support text, file, and structured parts in the AI SDK bridge baseline",
        "unsupported_ai_sdk_prompt_part",
        {
          partType: part.type,
          role: "user",
        }
      );
    }
  }
}

function mapAssistantPart(part: TuvrenPromptPart) {
  switch (part.type) {
    case "text": {
      return {
        text: part.text,
        type: "text",
      } satisfies LanguageModelV3Message["content"][number];
    }

    case "reasoning": {
      return {
        text: part.text,
        type: "reasoning",
      } satisfies LanguageModelV3Message["content"][number];
    }

    case "file": {
      return {
        data: cloneFileData(part.data),
        ...(typeof part.filename === "string"
          ? {
              filename: part.filename,
            }
          : {}),
        mediaType: part.mediaType,
        type: "file",
      } satisfies LanguageModelV3Message["content"][number];
    }

    case "tool_call": {
      return {
        input: cloneMetadataValue(part.input),
        toolCallId: part.callId,
        toolName: part.name,
        type: "tool-call",
      } satisfies LanguageModelV3Message["content"][number];
    }

    case "tool_result": {
      return mapToolResultPart(part);
    }

    case "structured": {
      return {
        text: JSON.stringify(part.data),
        type: "text",
      } satisfies LanguageModelV3Message["content"][number];
    }

    default: {
      throw bridgeError(
        "assistant messages contain a part that the AI SDK bridge baseline does not support",
        "unsupported_ai_sdk_prompt_part",
        {
          role: "assistant",
        }
      );
    }
  }
}

function mapToolResultPart(
  part: Extract<TuvrenPromptPart, { type: "tool_result" }>
) {
  return {
    output: mapToolResultOutput(part),
    toolCallId: part.callId,
    toolName: part.name,
    type: "tool-result",
  } satisfies LanguageModelV3Message["content"][number];
}

function mapToolResultOutput(
  part: Extract<TuvrenPromptPart, { type: "tool_result" }>
) {
  if (typeof part.output === "string") {
    return {
      type: part.isError === true ? "error-text" : "text",
      value: part.output,
    } as const;
  }

  if (isJsonValue(part.output)) {
    return {
      type: part.isError === true ? "error-json" : "json",
      value: cloneMetadataValue(part.output),
    } as const;
  }

  throw bridgeError(
    "tool result output must be string or JSON-serializable to cross the AI SDK bridge baseline",
    "invalid_ai_sdk_tool_result_output",
    {
      toolName: part.name,
    }
  );
}

function mapToolDefinition(
  tool: TuvrenToolDefinition
): LanguageModelV3FunctionTool {
  return {
    description: tool.description,
    inputSchema: cloneJsonSchema(tool.inputSchema),
    name: tool.name,
    type: "function",
  };
}

function mapGenerateResult(
  result: LanguageModelV3GenerateResult,
  responseFormat?: StructuredOutputRequest
): TuvrenModelResponse {
  const state: GenerateResultState = {
    parts: [],
    responseFormat,
    sources: [],
    structuredChunks: [],
  };

  for (const contentPart of result.content) {
    appendGenerateContentPart(contentPart, state, result);
  }

  finalizeGenerateStructuredOutput(state);

  const usage = mapUsage(result.usage);
  const providerMetadata = buildGenerateProviderMetadata(
    result,
    state.sources,
    usage.rawUsage
  );

  return {
    finishReason: mapFinishReason(result.finishReason.unified),
    parts: state.parts,
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
  };
}

function appendGenerateContentPart(
  contentPart: LanguageModelV3GenerateResult["content"][number],
  state: GenerateResultState,
  result: LanguageModelV3GenerateResult
): void {
  switch (contentPart.type) {
    case "text":
      appendGenerateTextPart(contentPart, state);
      return;
    case "reasoning":
      state.parts.push({
        redacted: false,
        text: contentPart.text,
        type: "reasoning",
      });
      return;
    case "file":
      state.parts.push(mapGeneratedFilePart(contentPart));
      return;
    case "tool-call":
      state.parts.push(mapGeneratedToolCallPart(contentPart, result));
      return;
    case "tool-result":
      throw bridgeError(
        "provider-executed tool results are out of scope for the baseline AI SDK bridge",
        "unsupported_ai_sdk_content",
        {
          partType: contentPart.type,
          toolName: contentPart.toolName,
        }
      );
    case "tool-approval-request":
      throw bridgeError(
        "provider-executed tool approvals are out of scope for the baseline AI SDK bridge",
        "unsupported_ai_sdk_content",
        {
          partType: contentPart.type,
        }
      );
    case "source":
      state.sources.push(sanitizeMetadataValue(contentPart));
      return;
    default:
      throw bridgeError(
        "unsupported AI SDK content surfaced in generate result mapping",
        "unsupported_ai_sdk_content"
      );
  }
}

function appendGenerateTextPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "text" }
  >,
  state: GenerateResultState
): void {
  if (state.responseFormat === undefined) {
    state.parts.push({
      text: contentPart.text,
      type: "text",
    });
    return;
  }

  state.structuredChunks.push(contentPart.text);
}

function mapGeneratedToolCallPart(
  contentPart: Extract<
    LanguageModelV3GenerateResult["content"][number],
    { type: "tool-call" }
  >,
  result: LanguageModelV3GenerateResult
): Extract<TuvrenModelResponse["parts"][number], { type: "tool_call" }> {
  rejectUnsupportedProviderOwnedToolPart(contentPart, {
    modelId: result.response?.modelId ?? "unknown",
    provider: "unknown",
  });

  return {
    callId: contentPart.toolCallId,
    input: parseJsonInput(
      contentPart.input,
      "tool call input",
      "invalid_ai_sdk_tool_call_input"
    ),
    name: contentPart.toolName,
    ...(contentPart.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: sanitizeRecord(contentPart.providerMetadata),
        }),
    type: "tool_call",
  };
}

function finalizeGenerateStructuredOutput(state: GenerateResultState): void {
  if (state.responseFormat === undefined) {
    return;
  }

  if (state.structuredChunks.length === 0) {
    throw bridgeError(
      "AI SDK generate result did not include structured output text",
      "structured_output_validation"
    );
  }

  state.parts.push({
    data: parseStructuredOutput(
      state.structuredChunks.join(""),
      state.responseFormat
    ),
    ...(state.responseFormat.name === undefined
      ? {}
      : {
          name: state.responseFormat.name,
        }),
    type: "structured",
  });
}

function buildGenerateProviderMetadata(
  result: LanguageModelV3GenerateResult,
  sources: unknown[],
  rawUsage: unknown
): Record<string, unknown> | undefined {
  return buildProviderMetadata({
    bridgeExtras: {
      rawUsage,
      requestBody:
        result.request?.body === undefined
          ? undefined
          : sanitizeMetadataValue(result.request.body),
      response: sanitizeGenerateResponseMetadata(result.response),
      sources,
      warnings: result.warnings.map(sanitizeMetadataValue),
    },
    providerMetadata: result.providerMetadata,
  });
}

function mapGeneratedFilePart(file: LanguageModelV3File) {
  return {
    data: cloneFileData(file.data),
    mediaType: file.mediaType,
    ...(file.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: sanitizeRecord(file.providerMetadata),
        }),
    type: "file",
  } satisfies Extract<TuvrenModelResponse["parts"][number], { type: "file" }>;
}

function normalizeBridgeSettings(prompt: TuvrenPrompt) {
  const settings = prompt.config?.settings;

  if (settings === undefined) {
    return {} as {
      frequencyPenalty?: number;
      headers?: Record<string, string | undefined>;
      maxOutputTokens?: number;
      presencePenalty?: number;
      providerOptions?: SharedV3ProviderOptions;
      seed?: number;
      stopSequences?: string[];
      temperature?: number;
      toolChoice?: unknown;
      topK?: number;
      topP?: number;
    };
  }

  if (!isPlainObject(settings)) {
    throw bridgeError(
      "TuvrenPrompt.config.settings must be a plain object",
      "invalid_ai_sdk_bridge_config",
      {
        settings,
      }
    );
  }

  for (const key of Object.keys(settings)) {
    if (!SUPPORTED_BRIDGE_SETTINGS.has(key)) {
      throw bridgeError(
        `unsupported AI SDK bridge setting "${key}"`,
        "invalid_ai_sdk_bridge_config",
        {
          key,
        }
      );
    }
  }

  return {
    frequencyPenalty: readOptionalNumberSetting(
      settings.frequencyPenalty,
      "frequencyPenalty"
    ),
    headers: readOptionalHeaders(settings.headers),
    maxOutputTokens: readOptionalNumberSetting(
      settings.maxOutputTokens,
      "maxOutputTokens"
    ),
    presencePenalty: readOptionalNumberSetting(
      settings.presencePenalty,
      "presencePenalty"
    ),
    providerOptions: readOptionalProviderOptions(settings.providerOptions),
    seed: readOptionalNumberSetting(settings.seed, "seed"),
    stopSequences: readOptionalStringArray(
      settings.stopSequences,
      "stopSequences"
    ),
    temperature: readOptionalNumberSetting(settings.temperature, "temperature"),
    toolChoice: settings.toolChoice,
    topK: readOptionalNumberSetting(settings.topK, "topK"),
    topP: readOptionalNumberSetting(settings.topP, "topP"),
  };
}

function normalizeToolChoice(
  value: unknown
): LanguageModelV3CallOptions["toolChoice"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto" || value === "none" || value === "required") {
    return {
      type: value,
    };
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return {
      toolName: value,
      type: "tool",
    };
  }

  if (
    isPlainObject(value) &&
    typeof value.type === "string" &&
    (value.type === "auto" ||
      value.type === "none" ||
      value.type === "required")
  ) {
    return {
      type: value.type,
    };
  }

  if (
    isPlainObject(value) &&
    value.type === "tool" &&
    typeof value.toolName === "string" &&
    value.toolName.trim().length > 0
  ) {
    return {
      toolName: value.toolName,
      type: "tool",
    };
  }

  throw bridgeError(
    "toolChoice must be auto, none, required, a tool name string, or a valid tool choice object",
    "invalid_ai_sdk_bridge_config",
    {
      value,
    }
  );
}

function readOptionalNumberSetting(
  value: unknown,
  key: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw bridgeError(
    `AI SDK bridge setting "${key}" must be a finite number`,
    "invalid_ai_sdk_bridge_config",
    {
      key,
      value,
    }
  );
}

function readOptionalStringArray(
  value: unknown,
  key: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    return [...value];
  }

  throw bridgeError(
    `AI SDK bridge setting "${key}" must be a string array`,
    "invalid_ai_sdk_bridge_config",
    {
      key,
      value,
    }
  );
}

function readOptionalHeaders(
  value: unknown
): Record<string, string | undefined> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw bridgeError(
      'AI SDK bridge setting "headers" must be a plain object',
      "invalid_ai_sdk_bridge_config",
      {
        value,
      }
    );
  }

  const headers: Record<string, string | undefined> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || typeof entry === "string") {
      headers[key] = entry;
      continue;
    }

    throw bridgeError(
      'AI SDK bridge setting "headers" must contain only string or undefined values',
      "invalid_ai_sdk_bridge_config",
      {
        key,
        value: entry,
      }
    );
  }

  return headers;
}

function readOptionalProviderOptions(
  value: unknown
): SharedV3ProviderOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw bridgeError(
      'AI SDK bridge setting "providerOptions" must be a plain object',
      "invalid_ai_sdk_bridge_config",
      {
        value,
      }
    );
  }

  return cloneProviderOptions(value);
}

function mergeHeaders(
  defaults?: Record<string, string | undefined>,
  overrides?: Record<string, string | undefined>
): Record<string, string | undefined> | undefined {
  if (defaults === undefined && overrides === undefined) {
    return undefined;
  }

  return {
    ...(defaults ?? {}),
    ...(overrides ?? {}),
  };
}

function mergeProviderOptions(
  defaults?: SharedV3ProviderOptions,
  overrides?: SharedV3ProviderOptions
): SharedV3ProviderOptions | undefined {
  const normalizedDefaults = cloneProviderOptions(defaults);
  const normalizedOverrides = cloneProviderOptions(overrides);

  if (normalizedDefaults === undefined && normalizedOverrides === undefined) {
    return undefined;
  }

  if (normalizedDefaults === undefined) {
    return normalizedOverrides;
  }

  if (normalizedOverrides === undefined) {
    return normalizedDefaults;
  }

  const merged: SharedV3ProviderOptions = {
    ...normalizedDefaults,
  };

  for (const [key, value] of Object.entries(normalizedOverrides)) {
    const existing = merged[key];

    if (existing !== undefined) {
      merged[key] = {
        ...existing,
        ...value,
      };
      continue;
    }

    merged[key] = cloneJsonObject(value);
  }

  return merged;
}

function mapUsage(usage: LanguageModelV3GenerateResult["usage"]) {
  const inputTotal = usage.inputTokens.total;
  const outputTotal = usage.outputTokens.total;

  return {
    canonical:
      typeof inputTotal === "number" && typeof outputTotal === "number"
        ? {
            inputTokens: inputTotal,
            outputTokens: outputTotal,
          }
        : undefined,
    rawUsage: sanitizeMetadataValue({
      inputTokens: {
        cacheRead: usage.inputTokens.cacheRead,
        cacheWrite: usage.inputTokens.cacheWrite,
        noCache: usage.inputTokens.noCache,
        total: usage.inputTokens.total,
      },
      outputTokens: {
        reasoning: usage.outputTokens.reasoning,
        text: usage.outputTokens.text,
        total: usage.outputTokens.total,
      },
      raw: usage.raw,
    }),
  };
}

function mapFinishReason(
  reason: LanguageModelV3GenerateResult["finishReason"]["unified"]
): TuvrenModelResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool-calls":
      return "tool_call";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "error":
    case "other":
      return "error";
    default:
      return "error";
  }
}

function parseStructuredOutput(
  text: string,
  request: StructuredOutputRequest
): unknown {
  const parsed = parseJsonInput(
    text,
    "structured output",
    "structured_output_validation",
    {
      name: request.name,
    }
  );
  validateStructuredOutput(request, parsed);
  return parsed;
}

function validateStructuredOutput(
  request: StructuredOutputRequest,
  value: unknown
): void {
  const validator = createStructuredOutputValidator(request.schema);
  const valid = validator(value);

  if (valid) {
    return;
  }

  throw bridgeError(
    "structured output did not satisfy the requested schema",
    "structured_output_validation",
    {
      errors:
        validator.errors?.map((error) => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          message: error.message,
          params: sanitizeMetadataValue(error.params),
          schemaPath: error.schemaPath,
        })) ?? [],
      name: request.name,
    }
  );
}

function createStructuredOutputValidator(
  schema: StructuredOutputRequest["schema"]
) {
  const dialect = readSchemaDialect(schema);

  if (dialect === "draft2019-09") {
    return new Ajv2019(STRUCTURED_OUTPUT_AJV_OPTIONS).compile(
      cloneJsonSchema(schema)
    );
  }

  if (dialect === "draft2020-12") {
    return new Ajv2020(STRUCTURED_OUTPUT_AJV_OPTIONS).compile(
      cloneJsonSchema(schema)
    );
  }

  return new Ajv(STRUCTURED_OUTPUT_AJV_OPTIONS).compile(
    cloneJsonSchema(schema)
  );
}

function readSchemaDialect(
  schema: StructuredOutputRequest["schema"]
): "draft7" | "draft2019-09" | "draft2020-12" {
  if (!isPlainObject(schema) || typeof schema.$schema !== "string") {
    return "draft7";
  }

  if (JSON_SCHEMA_DRAFT_2019_09_URIS.has(schema.$schema)) {
    return "draft2019-09";
  }

  if (JSON_SCHEMA_DRAFT_2020_12_URIS.has(schema.$schema)) {
    return "draft2020-12";
  }

  if (JSON_SCHEMA_DRAFT_7_URIS.has(schema.$schema)) {
    return "draft7";
  }

  throw bridgeError(
    "structured output schema uses an unsupported JSON Schema dialect",
    "structured_output_validation",
    {
      dialect: schema.$schema,
    }
  );
}

function captureStreamPartMetadata(
  collection: unknown[],
  part: LanguageModelV3StreamPart
): void {
  if (!("providerMetadata" in part) || part.providerMetadata === undefined) {
    return;
  }

  collection.push(
    sanitizeMetadataValue({
      id: "id" in part ? part.id : undefined,
      providerMetadata: part.providerMetadata,
      type: part.type,
    })
  );
}

function sanitizeGenerateResponseMetadata(
  response: LanguageModelV3GenerateResult["response"]
) {
  if (response === undefined) {
    return undefined;
  }

  return sanitizeMetadataValue({
    body: response.body,
    headers: response.headers,
    id: response.id,
    modelId: response.modelId,
    timestamp:
      response.timestamp instanceof Date
        ? response.timestamp.toISOString()
        : undefined,
  });
}

function sanitizeResponseMetadata(
  response: Extract<LanguageModelV3StreamPart, { type: "response-metadata" }>
) {
  return {
    ...(typeof response.id === "string"
      ? {
          id: response.id,
        }
      : {}),
    ...(typeof response.modelId === "string"
      ? {
          modelId: response.modelId,
        }
      : {}),
    ...(response.timestamp instanceof Date
      ? {
          timestamp: response.timestamp.toISOString(),
        }
      : {}),
  };
}

function buildProviderMetadata(input: {
  bridgeExtras: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  const providerMetadata = sanitizeRecord(input.providerMetadata);
  const extras = sanitizeRecord(input.bridgeExtras);

  if (providerMetadata !== undefined) {
    Object.assign(metadata, providerMetadata);
  }

  if (extras !== undefined) {
    metadata.aiSdkBridge = extras;
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function sanitizeRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sanitized = sanitizeMetadataValue(value);
  return isPlainObject(sanitized) ? sanitized : undefined;
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return {
      base64: Buffer.from(value).toString("base64"),
      type: "uint8array",
    };
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadataValue(entry));
  }

  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      const normalized = sanitizeMetadataValue(entry);

      if (normalized !== undefined) {
        sanitized[key] = normalized;
      }
    }

    return sanitized;
  }

  return String(value);
}

function cloneProviderOptions(
  value: SharedV3ProviderOptions | Record<string, unknown> | undefined
): SharedV3ProviderOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const cloned: SharedV3ProviderOptions = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      throw bridgeError(
        "AI SDK bridge providerOptions entries must be plain objects",
        "invalid_ai_sdk_bridge_config",
        {
          providerNamespace: key,
          value: entry,
        }
      );
    }

    cloned[key] = cloneJsonObject(entry);
  }

  return cloned;
}

function cloneHeaders(
  value: Record<string, string | undefined> | undefined
): Record<string, string | undefined> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return {
    ...value,
  };
}

function cloneMetadataValue<T>(value: T): T {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneMetadataValue(entry)) as T;
  }

  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneMetadataValue(entry);
    }

    return clone as T;
  }

  return value;
}

function cloneFileData(value: string | Uint8Array): string | Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : value;
}

function cloneJsonSchema(
  schema: StructuredOutputRequest["schema"]
): JSONSchema7 {
  return cloneMetadataValue(schema) as JSONSchema7;
}

function parseJsonInput(
  text: string,
  label: string,
  code: string,
  details?: Record<string, unknown>
): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    throw normalizeBridgeError(error, code, {
      ...details,
      label,
      text,
    });
  }
}

function rejectUnsupportedProviderOwnedToolPart(
  part:
    | Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-start" | "tool-call" }
      >
    | Extract<
        LanguageModelV3GenerateResult["content"][number],
        { type: "tool-call" }
      >,
  model: {
    modelId: string;
    provider: string;
  }
): void {
  if (
    part.providerExecuted === true ||
    ("dynamic" in part && part.dynamic === true)
  ) {
    throw bridgeError(
      "provider-owned tool execution is out of scope for the baseline AI SDK bridge",
      "unsupported_ai_sdk_content",
      {
        modelId: model.modelId,
        provider: model.provider,
        toolName: part.toolName,
      }
    );
  }
}

function requireToolState(
  toolStates: Map<string, StreamToolState>,
  id: string,
  model: {
    modelId: string;
    provider: string;
  },
  part: {
    type: string;
  }
): StreamToolState {
  const state = toolStates.get(id);

  if (state !== undefined) {
    return state;
  }

  throw bridgeError(
    "AI SDK stream emitted tool input deltas before tool input started",
    "unsupported_ai_sdk_stream_part",
    {
      modelId: model.modelId,
      partType: part.type,
      provider: model.provider,
      providerCallId: id,
    }
  );
}

function unsupportedStreamPartError(
  partType: string,
  model: {
    modelId: string;
    provider: string;
  }
) {
  return bridgeError(
    `AI SDK stream part "${partType}" is out of scope for the baseline bridge`,
    "unsupported_ai_sdk_stream_part",
    {
      modelId: model.modelId,
      partType,
      provider: model.provider,
    }
  );
}

function normalizeBridgeError(
  error: unknown,
  code: string,
  details?: Record<string, unknown>
): TuvrenProviderError {
  if (error instanceof TuvrenProviderError) {
    return error;
  }

  if (AISDKError.isInstance(error)) {
    return bridgeError(error.message, code, {
      ...details,
      aiSdkErrorName: error.name,
    });
  }

  if (error instanceof Error) {
    return bridgeError(error.message, code, {
      ...details,
      errorName: error.name,
    });
  }

  return bridgeError("unknown AI SDK bridge failure", code, {
    ...details,
    error: sanitizeMetadataValue(error),
  });
}

function bridgeError(
  message: string,
  code: string,
  details?: Record<string, unknown>
): TuvrenProviderError {
  return new TuvrenProviderError(message, {
    code,
    ...(details === undefined
      ? {}
      : {
          details: sanitizeMetadataValue(details),
        }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable === true && "value" in descriptor
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isJsonValue(entry));
}

function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  const cloned: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }

    if (!isJsonValue(entry)) {
      throw bridgeError(
        "AI SDK bridge JSON object values must be JSON-serializable",
        "invalid_ai_sdk_bridge_config",
        {
          key,
          value: entry,
        }
      );
    }

    cloned[key] = cloneJsonValue(entry);
  }

  return cloned;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }

  return cloneJsonObject(value);
}
