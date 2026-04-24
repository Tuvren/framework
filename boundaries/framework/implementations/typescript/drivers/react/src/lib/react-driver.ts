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

import { isDeepStrictEqual } from "node:util";
import {
  TuvrenProviderError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core-types";
import type {
  DriverAssistantEventReconciliation,
  DriverExecutionContext,
  DriverExecutionResult,
  DriverExtensionStateUpdate,
  DriverToolExecutionMode,
  RuntimeDriver,
  RuntimeDriverFactory,
} from "@tuvren/driver-api";
import { assertTuvrenModelResponse } from "@tuvren/provider-api";
import type {
  AgentConfig,
  AroundModelContext,
  AroundModelResult,
  CustomEvent,
  StructuredPart,
  TuvrenExtension,
  TuvrenJsonSchema,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/runtime-api";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createAroundModelContextSnapshot,
  createExtensionStateSnapshot,
  type NormalizedAroundModelResult,
  normalizeAroundModelResult,
  normalizeNextAroundModelContext,
  preparePromptState,
} from "./react-driver-prompt.js";
import {
  type BufferedAssistantSequence,
  createBufferedAssistantSequence,
  executeGenerateCall,
  executeStreamCall,
  flushBufferedAssistantSequences,
} from "./react-driver-stream.js";

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

export const REACT_DRIVER_ID = "react";

export type ReActDriverProviderCallMode = "generate" | "stream";

export type ReActDriverProviderCallModeResolver =
  | ReActDriverProviderCallMode
  | ((input: {
      config: Readonly<AgentConfig>;
      iterationCount: number;
      provider: TuvrenProvider;
    }) => ReActDriverProviderCallMode);

export type ReActDriverToolExecutionModeResolver =
  | DriverToolExecutionMode
  | ((input: {
      config: Readonly<AgentConfig>;
      iterationCount: number;
      response: TuvrenModelResponse;
    }) => DriverToolExecutionMode);

export interface ReActDriverOptions {
  providerCallMode?: ReActDriverProviderCallModeResolver;
  toolExecutionMode?: ReActDriverToolExecutionModeResolver;
}

interface ResolvedReActDriverOptions {
  providerCallMode: ReActDriverProviderCallModeResolver;
  toolExecutionMode: ReActDriverToolExecutionModeResolver;
}

interface ModelExecutionOutcome {
  assistantEventReconciliation?: DriverAssistantEventReconciliation;
  assistantSequences: BufferedAssistantSequence[];
  cancelled?: boolean;
  response: TuvrenModelResponse;
  responseFormat?: TuvrenPrompt["responseFormat"];
  stateUpdates: DriverExtensionStateUpdate[];
}

class ReActDriver implements RuntimeDriver {
  readonly id = REACT_DRIVER_ID;
  private readonly options: ResolvedReActDriverOptions;

  constructor(options: ResolvedReActDriverOptions) {
    this.options = options;
  }

  async execute(
    context: DriverExecutionContext
  ): Promise<DriverExecutionResult> {
    try {
      return await executeIteration(context, this.options);
    } catch (error: unknown) {
      return {
        resolution: {
          error: normalizeExecutionError(error),
          fatality: "hard",
          type: "fail",
        },
      };
    }
  }
}

export function createReActDriver(
  options?: ReActDriverOptions
): RuntimeDriverFactory {
  const resolvedOptions: ResolvedReActDriverOptions = {
    providerCallMode: options?.providerCallMode ?? "stream",
    toolExecutionMode: options?.toolExecutionMode ?? "parallel",
  };

  return {
    create() {
      return new ReActDriver(resolvedOptions);
    },
    id: REACT_DRIVER_ID,
  };
}

async function executeIteration(
  context: DriverExecutionContext,
  options: ResolvedReActDriverOptions
): Promise<DriverExecutionResult> {
  const promptState = preparePromptState({
    config: context.config,
    iterationCount: context.iterationCount,
    manifest: context.manifest,
    messages: context.messages,
    tools: context.toolRegistry.toDefinitions(),
  });
  const aroundModelContext = createAroundModelContext(context, promptState);
  const execution = await runAroundModelChain(
    context,
    options,
    aroundModelContext
  );
  const response = execution.response;
  const cancelled = execution.cancelled === true;

  assertTuvrenModelResponse(response, "response");
  if (!cancelled) {
    validateStructuredOutput(execution.responseFormat, response);
  }

  if (response.finishReason === "error" && !cancelled) {
    throw new TuvrenProviderError("provider returned an error finish reason", {
      code: "react_driver_provider_failure",
      details: {
        response,
      },
    });
  }

  if (response.parts.some((part) => part.type === "tool_result")) {
    throw new TuvrenRuntimeError(
      "provider responses must not contain tool_result parts",
      {
        code: "react_driver_invalid_model_response",
        details: {
          response,
        },
      }
    );
  }

  if (response.parts.length === 0) {
    if (cancelled) {
      return {
        partial: false,
        resolution: createExecutionCancelledResolution(),
      };
    }

    throw new TuvrenRuntimeError(
      "provider responses must contain assistant output",
      {
        code: "react_driver_empty_response",
        details: {
          response,
        },
      }
    );
  }

  const assistantMessage: Extract<TuvrenMessage, { role: "assistant" }> = {
    parts: toNonEmptyParts(stripUndefinedDeep(response.parts)),
    ...(response.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: stripUndefinedDeep(response.providerMetadata),
        }),
    role: "assistant",
  };
  const requestsTools = assistantMessage.parts.some(
    (part) => part.type === "tool_call"
  );
  const stateUpdates =
    execution.stateUpdates.length === 0
      ? undefined
      : execution.stateUpdates.map((update) => ({
          extensionName: update.extensionName,
          state: cloneValue(update.state),
        }));
  if (cancelled) {
    return {
      ...(execution.assistantEventReconciliation === undefined
        ? {}
        : {
            assistantEventReconciliation:
              execution.assistantEventReconciliation,
          }),
      messages: [assistantMessage],
      partial: true,
      resolution: createExecutionCancelledResolution(),
      stateUpdates,
      ...(requestsTools
        ? {
            toolExecutionMode: resolveToolExecutionMode(
              options.toolExecutionMode,
              context,
              response
            ),
          }
        : {}),
    };
  }

  const driverResult: DriverExecutionResult = requestsTools
    ? {
        ...(execution.assistantEventReconciliation === undefined
          ? {}
          : {
              assistantEventReconciliation:
                execution.assistantEventReconciliation,
            }),
        messages: [assistantMessage],
        resolution: {
          type: "continue_iteration",
        },
        stateUpdates,
        toolExecutionMode: resolveToolExecutionMode(
          options.toolExecutionMode,
          context,
          response
        ),
      }
    : {
        ...(execution.assistantEventReconciliation === undefined
          ? {}
          : {
              assistantEventReconciliation:
                execution.assistantEventReconciliation,
            }),
        messages: [assistantMessage],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
        stateUpdates,
      };

  await flushBufferedAssistantSequences(
    execution.assistantSequences,
    context.runtime
  );

  return driverResult;
}

async function runAroundModelChain(
  context: DriverExecutionContext,
  options: ResolvedReActDriverOptions,
  initialContext: AroundModelContext
): Promise<ModelExecutionOutcome> {
  const handlers = (context.config.extensions ?? []).filter(
    (
      extension
    ): extension is TuvrenExtension & {
      aroundModel: NonNullable<TuvrenExtension["aroundModel"]>;
    } => extension.aroundModel !== undefined
  );

  const invokeAt = async (
    index: number,
    currentContext: AroundModelContext
  ): Promise<ModelExecutionOutcome> => {
    if (index >= handlers.length) {
      return await callProvider(currentContext, context, options);
    }

    const extension = handlers[index];
    const nextOutcomes: ModelExecutionOutcome[] = [];
    const extensionContext = createAroundModelContextSnapshot({
      config: currentContext.config,
      emit: currentContext.emit,
      extensionState: createExtensionStateSnapshot(
        currentContext.manifest,
        extension.name
      ),
      iterationCount: currentContext.iterationCount,
      manifest: currentContext.manifest,
      messages: currentContext.messages,
      prompt: currentContext.prompt,
      sharedExports: currentContext.sharedExports,
      tools: currentContext.tools,
    });
    let rawResult: AroundModelResult;

    try {
      rawResult = await extension.aroundModel(
        extensionContext,
        async (nextContext) => {
          const normalizedNextContext = normalizeNextAroundModelContext(
            currentContext,
            nextContext ?? extensionContext
          );
          const nextOutcome = await invokeAt(index + 1, normalizedNextContext);
          nextOutcomes.push(nextOutcome);
          return cloneValue(nextOutcome.response);
        }
      );
    } catch (error: unknown) {
      if (nextOutcomes.length === 0) {
        throw error;
      }

      await emitPostNextAroundModelError(context, extension.name, error);
      return createPostNextAroundModelFallbackOutcome(
        extension.name,
        nextOutcomes,
        context.runtime.now
      );
    }

    const result = normalizeAroundModelResult(rawResult);
    validateAroundModelRetryDurability(result, nextOutcomes);

    return {
      assistantEventReconciliation: resolveAssistantEventReconciliation(
        result,
        nextOutcomes
      ),
      assistantSequences: finalizeAroundModelSequences(
        result,
        nextOutcomes,
        context.runtime.now
      ),
      cancelled: resolveAroundModelCancellation(result, nextOutcomes),
      response: result.response,
      responseFormat: resolveAroundModelResponseFormat(
        result,
        nextOutcomes,
        currentContext,
        extensionContext
      ),
      stateUpdates: collectAroundModelStateUpdates(
        extension.name,
        result,
        nextOutcomes
      ),
    };
  };

  return await invokeAt(0, initialContext);
}

async function callProvider(
  aroundContext: AroundModelContext,
  context: DriverExecutionContext,
  options: ResolvedReActDriverOptions
): Promise<ModelExecutionOutcome> {
  const provider = resolveProvider(context.config.model);
  const providerCallMode = resolveProviderCallMode(
    options.providerCallMode,
    context,
    provider
  );
  const prompt = createProviderPrompt(aroundContext);
  const sequence =
    providerCallMode === "generate"
      ? await executeGenerateCall({
          now: context.runtime.now,
          prompt,
          provider,
          signal: context.signal,
        })
      : await executeStreamCall({
          now: context.runtime.now,
          prompt,
          provider,
          runtime: context.runtime,
          signal: context.signal,
        });

  return {
    assistantEventReconciliation: undefined,
    assistantSequences: [sequence],
    cancelled: sequence.cancelled,
    response: sequence.response,
    responseFormat: cloneValue(prompt.responseFormat),
    stateUpdates: [],
  };
}

function createAroundModelContext(
  context: DriverExecutionContext,
  promptState: ReturnType<typeof preparePromptState>
): AroundModelContext {
  return createAroundModelContextSnapshot({
    config: cloneValue(promptState.config),
    emit: (event) => {
      context.runtime.emit({
        data: event.data,
        name: event.name,
        timestamp: context.runtime.now(),
        type: "custom",
      });
    },
    extensionState: {},
    iterationCount: context.iterationCount,
    manifest: cloneValue(context.manifest),
    messages: cloneValue(promptState.messages),
    prompt: cloneValue(promptState.prompt),
    sharedExports: cloneValue(promptState.sharedExports),
    tools: cloneValue(promptState.tools),
  });
}

function createExecutionCancelledResolution(): Extract<
  DriverExecutionResult["resolution"],
  { type: "fail" }
> {
  return {
    error: new TuvrenRuntimeError("execution cancelled", {
      code: "react_driver_execution_cancelled",
    }),
    fatality: "hard",
    type: "fail",
  };
}

async function emitPostNextAroundModelError(
  context: DriverExecutionContext,
  extensionName: string,
  error: unknown
): Promise<void> {
  const normalizedError = normalizeExecutionError(error);
  const event: CustomEvent = {
    data: {
      extensionName,
      message: normalizedError.message,
      name: normalizedError.name,
      phase: "post_next",
    },
    name: "react_driver.around_model_error",
    timestamp: context.runtime.now(),
    type: "custom",
  };

  try {
    await context.runtime.emit(event);
  } catch {
    // Logging must not turn a recovered post-next wrapper failure into a model failure.
  }
}

function resolveProvider(model: AgentConfig["model"]): TuvrenProvider {
  if (isConcreteProvider(model)) {
    return model;
  }

  throw new TuvrenValidationError(
    "ReAct driver execution requires config.model to be a concrete TuvrenProvider",
    {
      code: "react_driver_missing_provider",
      details: {
        model,
      },
    }
  );
}

function isConcreteProvider(value: unknown): value is TuvrenProvider {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.generate === "function" &&
    typeof value.stream === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveProviderCallMode(
  resolver: ReActDriverProviderCallModeResolver,
  context: DriverExecutionContext,
  provider: TuvrenProvider
): ReActDriverProviderCallMode {
  const resolvedMode: unknown =
    typeof resolver === "function"
      ? resolver({
          config: context.config,
          iterationCount: context.iterationCount,
          provider,
        })
      : resolver;

  if (resolvedMode === "generate" || resolvedMode === "stream") {
    return resolvedMode;
  }

  throw new TuvrenRuntimeError(
    'providerCallMode must resolve to "generate" or "stream"',
    {
      code: "react_driver_invalid_provider_call_mode",
      details: {
        providerCallMode: resolvedMode,
      },
    }
  );
}

function resolveToolExecutionMode(
  resolver: ReActDriverToolExecutionModeResolver,
  context: DriverExecutionContext,
  response: TuvrenModelResponse
): DriverToolExecutionMode {
  const resolvedMode: unknown =
    typeof resolver === "function"
      ? resolver({
          config: context.config,
          iterationCount: context.iterationCount,
          response,
        })
      : resolver;

  if (resolvedMode === "parallel" || resolvedMode === "sequential") {
    return resolvedMode;
  }

  throw new TuvrenRuntimeError(
    'toolExecutionMode must resolve to "parallel" or "sequential"',
    {
      code: "react_driver_invalid_tool_execution_mode",
      details: {
        toolExecutionMode: resolvedMode,
      },
    }
  );
}

function validateStructuredOutput(
  request: TuvrenPrompt["responseFormat"],
  response: TuvrenModelResponse
): void {
  if (request === undefined) {
    return;
  }

  const structuredParts = response.parts.filter(
    (part): part is StructuredPart => part.type === "structured"
  );

  if (structuredParts.length === 0 && !hasRequestedToolCalls(response)) {
    throw new TuvrenProviderError("structured output validation failed", {
      code: "structured_output_validation",
      details: {
        reason: "missing_structured_part",
        response,
      },
    });
  }

  const validator = compileStructuredOutputSchema(request.schema);

  for (const part of structuredParts) {
    if (!validator(part.data)) {
      throw new TuvrenProviderError("structured output validation failed", {
        code: "structured_output_validation",
        details: {
          errors: validator.errors ?? [],
          response,
        },
      });
    }
  }
}

function compileStructuredOutputSchema(schema: TuvrenJsonSchema) {
  const ajv = createStructuredOutputAjv(schema);

  try {
    return ajv.compile(schema);
  } catch (error: unknown) {
    throw new TuvrenProviderError("structured output validation failed", {
      code: "structured_output_validation",
      details: {
        message: error instanceof Error ? error.message : String(error),
        reason: "schema_compilation_failed",
        schemaDialect: getStructuredOutputSchemaDialect(schema),
      },
    });
  }
}

function createStructuredOutputAjv(
  schema: TuvrenJsonSchema
): Ajv | Ajv2019 | Ajv2020 {
  const schemaDialect = getStructuredOutputSchemaDialect(schema);

  if (
    schemaDialect === undefined ||
    JSON_SCHEMA_DRAFT_7_URIS.has(schemaDialect)
  ) {
    return new Ajv(STRUCTURED_OUTPUT_AJV_OPTIONS);
  }

  if (JSON_SCHEMA_DRAFT_2019_09_URIS.has(schemaDialect)) {
    return new Ajv2019(STRUCTURED_OUTPUT_AJV_OPTIONS);
  }

  if (JSON_SCHEMA_DRAFT_2020_12_URIS.has(schemaDialect)) {
    return new Ajv2020(STRUCTURED_OUTPUT_AJV_OPTIONS);
  }

  throw new TuvrenProviderError("structured output validation failed", {
    code: "structured_output_validation",
    details: {
      reason: "unsupported_schema_dialect",
      schemaDialect,
    },
  });
}

function getStructuredOutputSchemaDialect(
  schema: TuvrenJsonSchema
): string | undefined {
  if (typeof schema === "boolean") {
    return undefined;
  }

  const schemaDialect = schema.$schema;

  if (schemaDialect === undefined) {
    return undefined;
  }

  return typeof schemaDialect === "string" ? schemaDialect : undefined;
}

function collectAroundModelStateUpdates(
  extensionName: string,
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): DriverExtensionStateUpdate[] {
  const lastOutcome = nextOutcomes.at(-1);
  const updates =
    lastOutcome === undefined
      ? []
      : lastOutcome.stateUpdates.map((update) => ({
          extensionName: update.extensionName,
          state: cloneValue(update.state),
        }));

  if (result.state !== undefined) {
    updates.push({
      extensionName,
      state: cloneValue(result.state),
    });
  }

  return updates;
}

function createPostNextAroundModelFallbackOutcome(
  extensionName: string,
  nextOutcomes: ModelExecutionOutcome[],
  now: () => number
): ModelExecutionOutcome {
  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    throw new TuvrenRuntimeError(
      "post-next aroundModel recovery requires a next() outcome",
      {
        code: "react_driver_invalid_around_model_recovery",
      }
    );
  }

  const result: NormalizedAroundModelResult = {
    response: cloneValue(lastOutcome.response),
  };

  return {
    assistantEventReconciliation: resolveAssistantEventReconciliation(
      result,
      nextOutcomes
    ),
    assistantSequences: finalizeAroundModelSequences(result, nextOutcomes, now),
    cancelled: resolveAroundModelCancellation(result, nextOutcomes),
    response: result.response,
    responseFormat: cloneValue(lastOutcome.responseFormat),
    stateUpdates: collectAroundModelStateUpdates(
      extensionName,
      result,
      nextOutcomes
    ),
  };
}

function finalizeAroundModelSequences(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[],
  now: () => number
): BufferedAssistantSequence[] {
  if (nextOutcomes.length === 0) {
    return [createBufferedAssistantSequence(result.response, now)];
  }

  const priorSequences = nextOutcomes
    .slice(0, -1)
    .flatMap((outcome) => cloneAssistantSequences(outcome.assistantSequences));
  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    return priorSequences;
  }

  if (responsesMatch(lastOutcome.response, result.response)) {
    return [
      ...priorSequences,
      ...cloneAssistantSequences(lastOutcome.assistantSequences),
    ];
  }

  const lastSequences = cloneAssistantSequences(lastOutcome.assistantSequences);

  if (lastSequences.some((sequence) => sequence.published)) {
    return [...priorSequences, ...lastSequences];
  }

  return [
    ...priorSequences,
    createBufferedAssistantSequence(result.response, now),
  ];
}

function cloneAssistantSequences(
  sequences: readonly BufferedAssistantSequence[]
): BufferedAssistantSequence[] {
  return sequences.map((sequence) => ({
    events: sequence.events.map((event) => cloneValue(event)),
    published: sequence.published,
    response: cloneValue(sequence.response),
  }));
}

function responsesMatch(
  left: TuvrenModelResponse,
  right: TuvrenModelResponse
): boolean {
  return isDeepStrictEqual(stripUndefinedDeep(left), stripUndefinedDeep(right));
}

function responsesEmitEquivalentAssistantEvents(
  liveResponse: TuvrenModelResponse,
  durableResponse: TuvrenModelResponse
): boolean {
  if (
    !finishReasonMatchesDurableAssistantContent(
      liveResponse.finishReason,
      durableResponse.parts
    )
  ) {
    return false;
  }

  if (liveResponse.parts.length !== durableResponse.parts.length) {
    return false;
  }

  for (const [index, livePart] of liveResponse.parts.entries()) {
    const durablePart = durableResponse.parts[index];

    if (durablePart === undefined) {
      return false;
    }

    if (!partsEmitEquivalentAssistantEvents(livePart, durablePart)) {
      return false;
    }
  }

  return true;
}

function finishReasonMatchesDurableAssistantContent(
  finishReason: TuvrenModelResponse["finishReason"],
  parts: TuvrenModelResponse["parts"]
): boolean {
  if (parts.some((part) => part.type === "tool_call")) {
    return finishReason === "tool_call";
  }

  return finishReason !== "tool_call";
}

function partsEmitEquivalentAssistantEvents(
  livePart: TuvrenModelResponse["parts"][number],
  durablePart: TuvrenModelResponse["parts"][number]
): boolean {
  switch (livePart.type) {
    case "file":
      return (
        durablePart.type === "file" &&
        livePart.filename === durablePart.filename &&
        livePart.mediaType === durablePart.mediaType &&
        isDeepStrictEqual(livePart.data, durablePart.data)
      );
    case "reasoning":
      return (
        durablePart.type === "reasoning" &&
        livePart.redacted === durablePart.redacted &&
        (livePart.redacted || livePart.text === durablePart.text)
      );
    case "structured":
      return (
        durablePart.type === "structured" &&
        livePart.name === durablePart.name &&
        isDeepStrictEqual(livePart.data, durablePart.data)
      );
    case "text":
      return durablePart.type === "text" && livePart.text === durablePart.text;
    case "tool_call":
      return (
        durablePart.type === "tool_call" &&
        livePart.callId === durablePart.callId &&
        livePart.name === durablePart.name &&
        isDeepStrictEqual(livePart.input, durablePart.input)
      );
    case "tool_result":
      return (
        durablePart.type === "tool_result" &&
        isDeepStrictEqual(
          stripUndefinedDeep(livePart),
          stripUndefinedDeep(durablePart)
        )
      );
    default:
      return false;
  }
}

function hasRequestedToolCalls(response: TuvrenModelResponse): boolean {
  return response.parts.some((part) => part.type === "tool_call");
}

function resolveAroundModelResponseFormat(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[],
  initialContext: AroundModelContext,
  finalContext: AroundModelContext
): TuvrenPrompt["responseFormat"] {
  const finalResponseFormat = finalContext.prompt.responseFormat;

  if (nextOutcomes.length === 0) {
    return cloneValue(finalResponseFormat);
  }

  if (
    !isDeepStrictEqual(
      stripUndefinedDeep(initialContext.prompt.responseFormat),
      stripUndefinedDeep(finalResponseFormat)
    )
  ) {
    return cloneValue(finalResponseFormat);
  }

  const matchingOutcome = findMatchingNextOutcome(
    result.response,
    nextOutcomes
  );

  if (matchingOutcome !== undefined) {
    return cloneValue(matchingOutcome.responseFormat);
  }

  return cloneValue(nextOutcomes.at(-1)?.responseFormat ?? finalResponseFormat);
}

function validateAroundModelRetryDurability(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): void {
  if (nextOutcomes.length <= 1) {
    return;
  }

  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    return;
  }

  if (responsesMatch(lastOutcome.response, result.response)) {
    return;
  }

  throw new TuvrenRuntimeError(
    "aroundModel handlers that call next() multiple times must return the final next() response",
    {
      code: "react_driver_invalid_around_model_retry",
      details: {
        finalNextResponse: lastOutcome.response,
        nextCallCount: nextOutcomes.length,
        returnedResponse: result.response,
      },
    }
  );
}

function resolveAssistantEventReconciliation(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): DriverAssistantEventReconciliation | undefined {
  if (nextOutcomes.length === 0) {
    return undefined;
  }

  const lastOutcome = nextOutcomes.at(-1);

  if (lastOutcome === undefined) {
    return undefined;
  }

  if (
    !responsesEmitEquivalentAssistantEvents(
      lastOutcome.response,
      result.response
    ) &&
    lastOutcome.assistantSequences.some((sequence) => sequence.published)
  ) {
    return "allow_final_sequence_divergence";
  }

  return lastOutcome.assistantEventReconciliation;
}

function resolveAroundModelCancellation(
  result: NormalizedAroundModelResult,
  nextOutcomes: ModelExecutionOutcome[]
): boolean | undefined {
  return nextOutcomes.some(
    (outcome) =>
      outcome.cancelled === true &&
      responsesMatch(outcome.response, result.response)
  )
    ? true
    : undefined;
}

function findMatchingNextOutcome(
  response: TuvrenModelResponse,
  nextOutcomes: ModelExecutionOutcome[]
): ModelExecutionOutcome | undefined {
  for (let index = nextOutcomes.length - 1; index >= 0; index -= 1) {
    const outcome = nextOutcomes[index];

    if (outcome !== undefined && responsesMatch(outcome.response, response)) {
      return outcome;
    }
  }

  return undefined;
}

function createProviderPrompt(aroundContext: AroundModelContext) {
  return {
    config: cloneValue(aroundContext.config),
    messages: cloneValue(aroundContext.messages),
    responseFormat: cloneValue(aroundContext.prompt.responseFormat),
    tools:
      aroundContext.tools.length === 0
        ? undefined
        : cloneValue(aroundContext.tools),
  };
}

function normalizeExecutionError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function toNonEmptyParts(
  parts: TuvrenModelResponse["parts"]
): Extract<TuvrenMessage, { role: "assistant" }>["parts"] {
  const [firstPart, ...remainingParts] = cloneValue(parts);

  if (firstPart === undefined) {
    throw new TuvrenRuntimeError(
      "assistant output must include at least one part",
      {
        code: "react_driver_empty_response",
      }
    );
  }

  return [firstPart, ...remainingParts];
}

function stripUndefinedDeep<T>(value: T): T {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as T;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, stripUndefinedDeep(item)]]
    );

    return Object.fromEntries(entries) as T;
  }

  return value;
}
