import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  ProviderV3,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
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
import {
  mapGenerateResult,
  type ProviderToolClassLookup,
} from "./ai-sdk-provider-bridge-generate.js";
import {
  mapPromptMessages,
  mapProviderMediatedToolConfigs,
  mapProviderNativeToolDeclarations,
  mapToolDefinition,
  resolveProviderToolExecutionClass,
} from "./ai-sdk-provider-bridge-prompt.js";
import {
  createStreamMappingState,
  mapStreamPart,
} from "./ai-sdk-provider-bridge-stream.js";
import {
  bridgeError,
  captureStreamPartMetadata,
  cloneHeaders,
  cloneJsonObject,
  cloneJsonSchema,
  cloneProviderOptions,
  isPlainObject,
  normalizeBridgeError,
  parseJsonInput,
  sanitizeMetadataValue,
} from "./ai-sdk-provider-bridge-utils.js";

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

type AiSdkStreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

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

      const providerToolClassLookup = buildProviderToolClassLookup(prompt);
      return mapGenerateResult(
        result,
        prompt.responseFormat,
        {
          mapFinishReason,
          mapUsage,
          parseStructuredOutput,
        },
        providerToolClassLookup
      );
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
    const providerToolClassLookup = buildProviderToolClassLookup(prompt);
    const state = createStreamMappingState({
      model: this.model,
      ...(providerToolClassLookup === undefined
        ? {}
        : { providerToolClassLookup }),
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

        for (const chunk of mapStreamPart(part, state, {
          mapFinishReason,
          mapUsage,
          parseStructuredOutput,
        })) {
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

function assertProviderMediatedToolsSupported(
  prompt: TuvrenPrompt,
  activeProvider: string
): void {
  if (
    prompt.providerMediatedTools !== undefined &&
    prompt.providerMediatedTools.length > 0 &&
    activeProvider !== "openai"
  ) {
    throw bridgeError(
      "provider-mediated tools require an OpenAI-bound model; bind an openai provider or remove providerMediatedTools",
      "invalid_ai_sdk_bridge_config",
      {
        activeProvider,
        reason: "provider_mediated_tools_require_openai",
      }
    );
  }
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
  const responseFormat = input.prompt.responseFormat;

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

  if (responseFormat?.strict === true) {
    throw bridgeError(
      "StructuredOutputRequest.strict is not supported by the AI SDK bridge baseline; use provider-specific options or disable strict",
      "invalid_ai_sdk_bridge_config",
      {
        modelId: input.model.modelId,
        provider: input.model.provider,
        reason: "native_strict_structured_output_unsupported",
        responseFormatName: responseFormat.name,
      }
    );
  }

  assertProviderMediatedToolsSupported(input.prompt, input.model.provider);

  const headers = mergeHeaders(input.defaultHeaders, settings.headers);
  const providerOptions = mergeProviderOptions(
    mergeProviderOptions(
      input.defaultProviderOptions,
      // Thread providerContinuity artifacts into providerOptions so the provider
      // receives its own namespace continuity data on the next turn. (AY005)
      continuityToProviderOptions(input.prompt.providerContinuity)
    ),
    settings.providerOptions
  );
  const toolChoice = normalizeToolChoice(settings.toolChoice);
  const allTools = buildAllTools(input.prompt);

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
    prompt: mapPromptMessages(input.model.provider, input.prompt.messages),
    ...(providerOptions === undefined
      ? {}
      : {
          providerOptions,
        }),
    ...(responseFormat === undefined
      ? {}
      : {
          responseFormat: {
            name: responseFormat.name,
            schema: cloneJsonSchema(responseFormat.schema),
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
    ...(allTools.length === 0
      ? {}
      : {
          tools: allTools,
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
  reason: Pick<
    LanguageModelV3GenerateResult["finishReason"],
    "raw" | "unified"
  >,
  options: {
    hasToolCalls?: boolean;
  } = {}
): TuvrenModelResponse["finishReason"] {
  if (shouldNormalizeToolCallFinishReason(reason, options.hasToolCalls)) {
    return "tool_call";
  }

  switch (reason.unified) {
    case "stop":
      return "stop";
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

function shouldNormalizeToolCallFinishReason(
  reason: Pick<
    LanguageModelV3GenerateResult["finishReason"],
    "raw" | "unified"
  >,
  hasToolCalls: boolean | undefined
): boolean {
  if (!hasToolCalls) {
    return reason.unified === "tool-calls";
  }

  if (reason.unified === "tool-calls") {
    return true;
  }

  if (reason.unified === "stop") {
    return true;
  }

  // Some provider adapters have historically surfaced Gemini function-call
  // turns as raw FUNCTION_CALL with a unified fallback of "other" or "error".
  return (
    typeof reason.raw === "string" &&
    reason.raw === "FUNCTION_CALL" &&
    (reason.unified === "error" || reason.unified === "other")
  );
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

// ---------------------------------------------------------------------------
// Provider-native / provider-mediated tool helpers (AY002, AY004, AY005)
// ---------------------------------------------------------------------------

import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3ProviderTool,
} from "@ai-sdk/provider";

function buildAllTools(
  prompt: TuvrenPrompt
): Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool> {
  const functionTools =
    prompt.tools !== undefined && prompt.tools.length > 0
      ? prompt.tools.map(mapToolDefinition)
      : [];
  const nativeTools =
    prompt.providerNativeTools !== undefined &&
    prompt.providerNativeTools.length > 0
      ? mapProviderNativeToolDeclarations(prompt.providerNativeTools)
      : [];
  const mediatedTools =
    prompt.providerMediatedTools !== undefined &&
    prompt.providerMediatedTools.length > 0
      ? mapProviderMediatedToolConfigs(prompt.providerMediatedTools)
      : [];
  return [...functionTools, ...nativeTools, ...mediatedTools];
}

function continuityToProviderOptions(
  providerContinuity: Record<string, unknown> | undefined
): SharedV3ProviderOptions | undefined {
  if (
    providerContinuity === undefined ||
    Object.keys(providerContinuity).length === 0
  ) {
    return undefined;
  }
  return cloneProviderOptions(providerContinuity);
}

function buildProviderToolClassLookup(
  prompt: TuvrenPrompt
): ProviderToolClassLookup | undefined {
  const hasNative = (prompt.providerNativeTools?.length ?? 0) > 0;
  const hasMediated = (prompt.providerMediatedTools?.length ?? 0) > 0;
  if (!(hasNative || hasMediated)) {
    return undefined;
  }
  return (toolName: string) =>
    resolveProviderToolExecutionClass(
      toolName,
      prompt.providerNativeTools,
      prompt.providerMediatedTools
    );
}
