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

/**
 * Allow-list of `TuvrenPrompt.config.settings` keys the bridge forwards to the
 * AI SDK call options. Any other key is rejected with
 * `invalid_ai_sdk_bridge_config` so unsupported knobs fail loudly instead of
 * being silently dropped.
 */
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
/**
 * Shared Ajv options for structured-output validation. `addUsedSchema: false`
 * keeps per-request schemas out of the instance cache; `strict: false` accepts
 * provider-authored schemas that use vocabulary Ajv's strict mode would flag.
 */
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

/** Resolved result of `LanguageModelV3.doStream` (stream plus request/response metadata). */
type AiSdkStreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

/**
 * Options for {@link createAiSdkProviderBridge}, binding one AI SDK
 * `LanguageModelV3` instance as a `TuvrenProvider`.
 */
export interface AiSdkProviderBridgeOptions {
  /**
   * Headers applied to every model call. Per-prompt
   * `config.settings.headers` entries override same-named keys.
   */
  defaultHeaders?: Record<string, string | undefined>;
  /**
   * Provider-namespaced options applied to every model call. Merged (per
   * provider namespace, shallow) under per-prompt `providerContinuity`
   * artifacts and `config.settings.providerOptions`, with the per-prompt
   * values winning on key collisions.
   */
  defaultProviderOptions?: SharedV3ProviderOptions;
  /**
   * Stable identifier reported as `TuvrenProvider.id`.
   *
   * @defaultValue `"ai-sdk:{model.provider}:{model.modelId}"`
   */
  id?: string;
  /** The already-constructed AI SDK language model to bridge. */
  model: LanguageModelV3;
}

/**
 * Options for {@link createAiSdkProviderBridgeFromProvider}, which resolves
 * the model from an AI SDK `ProviderV3` registry instead of receiving it
 * pre-constructed.
 */
export interface AiSdkProviderBridgeFromProviderOptions
  extends Omit<AiSdkProviderBridgeOptions, "model"> {
  /** Model identifier passed to `provider.languageModel(modelId)`. */
  modelId: string;
  /** AI SDK provider used to look up the language model. */
  provider: ProviderV3;
}

/**
 * `TuvrenProvider` adapter over a single AI SDK `LanguageModelV3`.
 *
 * The bridge is the baseline provider adapter of the framework's adapter
 * strategy (KrakenFrameworkSpecification §3.4; ADR-055 defers native provider
 * clients behind this seam). It translates the Tuvren prompt/response
 * vocabulary to `doGenerate`/`doStream` calls and normalizes every failure
 * into a `TuvrenProviderError` with a stable machine-readable `code`.
 */
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

  /**
   * Executes one non-streaming model call via `doGenerate` and maps the
   * result into a `TuvrenModelResponse`.
   *
   * When `prompt.responseFormat` is set, the model's text output is parsed as
   * JSON and validated against the requested schema before it is surfaced as
   * a `structured` part (KrakenFrameworkSpecification §3.5).
   *
   * @throws TuvrenProviderError with code `ai_sdk_generate_failed` when the
   *   underlying call fails, or a more specific bridge code
   *   (`invalid_ai_sdk_bridge_config`, `structured_output_validation`,
   *   `unsupported_ai_sdk_content`, ...) when mapping fails.
   */
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

  /**
   * Executes one streaming model call via `doStream` and yields canonical
   * `ProviderStreamChunk` values (KrakenFrameworkSpecification §3.2).
   *
   * Stream parts are mapped incrementally through a per-call
   * `StreamMappingState`; the reader is cancelled and its lock released when
   * the consumer stops early or a mapping error is thrown, so the underlying
   * HTTP stream is never leaked.
   *
   * @throws TuvrenProviderError with code `ai_sdk_stream_failed` when the
   *   underlying stream fails, or a mapping-specific bridge code (for example
   *   `unsupported_ai_sdk_stream_part`).
   */
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

/**
 * Creates a `TuvrenProvider` backed by a Vercel AI SDK `LanguageModelV3`.
 *
 * This is the primary entrypoint of `@tuvren/provider-bridge-ai-sdk`: pass
 * the resulting provider to `createTuvren` (or any host composition) to run
 * Tuvren Turns against any model the AI SDK can reach. Semantics of the
 * mapped surface are governed by the providers authority packet
 * (spec/providers/authority-packet.json) and its conformance plans.
 *
 * @param options - The model binding plus optional default headers,
 *   provider options, and provider id.
 * @returns A `TuvrenProvider` whose `generate` and `stream` calls are
 *   delegated to the bound model.
 *
 * @example
 * ```ts
 * import { openai } from "@ai-sdk/openai";
 * import { createAiSdkProviderBridge } from "@tuvren/provider-bridge-ai-sdk";
 *
 * const provider = createAiSdkProviderBridge({
 *   model: openai("gpt-4o-mini"),
 * });
 * ```
 */
export function createAiSdkProviderBridge(
  options: AiSdkProviderBridgeOptions
): TuvrenProvider {
  return new AiSdkProviderBridge(options);
}

/**
 * Creates a `TuvrenProvider` by resolving `modelId` from an AI SDK
 * `ProviderV3` registry, then delegating to {@link createAiSdkProviderBridge}.
 *
 * @param options - The provider registry, model id, and the same defaults
 *   accepted by {@link createAiSdkProviderBridge}.
 * @throws TuvrenProviderError with code `ai_sdk_provider_lookup_failed` when
 *   the registry cannot resolve the requested model.
 */
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

/**
 * Awaits `doStream` and normalizes any pre-stream failure into a
 * `TuvrenProviderError` with code `ai_sdk_stream_failed`.
 */
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

/**
 * Rejects provider-mediated tool configs on non-OpenAI models. The mediated
 * (MCP) execution class currently maps only to the OpenAI `openai.mcp`
 * provider tool (AY004), so binding any other provider is a configuration
 * error rather than a silent no-op.
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_bridge_config`.
 */
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

/**
 * Builds the `LanguageModelV3CallOptions` for one `doGenerate`/`doStream`
 * call from a `TuvrenPrompt` and the bridge defaults.
 *
 * Cross-checks the prompt's requested `config.model` / `config.provider`
 * against the bound model, rejects `responseFormat.strict` (native strict
 * structured output is unsupported by the bridge baseline), forwards the
 * cooperative cancellation signal (ADR-043), and merges headers and
 * provider options (defaults < providerContinuity < per-prompt settings).
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_bridge_config` when
 *   the prompt conflicts with the bound model or uses unsupported settings.
 */
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
    // Forward the framework's cooperative cancellation signal so the underlying
    // provider request is actually aborted (full resource containment) when the
    // execution-bounds guard stops awaiting at a bound. (ADR-043, KRT-BD006)
    ...(input.prompt.signal === undefined
      ? {}
      : {
          abortSignal: input.prompt.signal,
        }),
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

/**
 * Validates `TuvrenPrompt.config.settings` against
 * {@link SUPPORTED_BRIDGE_SETTINGS} and coerces each supported key to its
 * expected shape. Unknown keys and malformed values are rejected with
 * `invalid_ai_sdk_bridge_config`.
 */
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

/**
 * Normalizes the host-facing `toolChoice` setting into the AI SDK tool-choice
 * object. Accepts `"auto" | "none" | "required"`, a bare tool name string,
 * or an already-shaped `{ type }` / `{ type: "tool", toolName }` object.
 *
 * @throws TuvrenProviderError with code `invalid_ai_sdk_bridge_config` for
 *   any other shape.
 */
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

/** Reads an optional finite-number setting; rejects any other defined value. */
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

/** Reads an optional array of non-empty strings; rejects any other defined value. */
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

/**
 * Reads the optional `headers` setting: a plain object whose values are
 * strings or `undefined` (an `undefined` value unsets a default header).
 */
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

/** Reads the optional `providerOptions` setting and defensively clones it. */
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

/** Merges default and per-prompt headers; per-prompt keys win. */
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

/**
 * Merges two provider-option records. Provider namespaces present in both are
 * shallow-merged key-by-key with `overrides` winning; namespaces unique to
 * either side are cloned through unchanged.
 */
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

/**
 * Maps AI SDK usage into the canonical `ProviderUsage` pair plus a sanitized
 * raw-usage record. `canonical` is only populated when both input and output
 * totals are numeric; the full breakdown (cache reads/writes, reasoning vs
 * text tokens, provider raw usage) always survives in `rawUsage` for
 * provider-metadata attribution.
 */
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

/**
 * Maps the AI SDK unified finish reason onto the Tuvren finish-reason
 * vocabulary (`stop`, `length`, `content_filter`, `tool_call`, `error`).
 * When the turn actually produced tool calls, `stop` and certain raw
 * provider fallbacks are normalized to `tool_call` (see
 * {@link shouldNormalizeToolCallFinishReason}).
 */
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

/**
 * Decides whether a finish reason should be reported as `tool_call`. Without
 * emitted tool calls only a unified `tool-calls` qualifies; with tool calls,
 * `stop` also qualifies (some providers report `stop` for tool turns), as
 * does the historical Gemini raw `FUNCTION_CALL` + `other`/`error` fallback.
 */
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

/**
 * Parses structured-output text as JSON and validates it against the
 * requested schema (KrakenFrameworkSpecification §3.5).
 *
 * @throws TuvrenProviderError with code `structured_output_validation` when
 *   the text is not valid JSON or does not satisfy the schema.
 */
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

/**
 * Validates a parsed structured-output value against the request schema,
 * surfacing each Ajv error (instance path, keyword, message) in the thrown
 * error's details.
 */
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

/**
 * Compiles a structured-output validator with the Ajv build matching the
 * schema's declared `$schema` dialect (draft-07 by default, 2019-09 and
 * 2020-12 when declared).
 */
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

/**
 * Reads the JSON Schema dialect from `$schema`. Schemas without a `$schema`
 * default to draft-07; an unrecognized dialect URI is rejected with
 * `structured_output_validation`.
 */
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

/**
 * Assembles the AI SDK `tools` array from the prompt's three tool families:
 * client function tools (`prompt.tools`), provider-native declarations
 * (AY002), and provider-mediated MCP configs (AY004), in that order.
 */
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

/**
 * Converts `prompt.providerContinuity` artifacts into provider options so a
 * provider receives its own namespace continuity data on the next turn
 * (AY005). Returns `undefined` when there is nothing to thread through.
 */
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

/**
 * Builds the tool-name → execution-class lookup used by the generate and
 * stream mappers to accept provider-owned results only for tools the host
 * actually declared. Returns `undefined` when the prompt declares no
 * provider-native or provider-mediated tools, which keeps the baseline
 * rejection of provider-owned execution in force.
 */
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
