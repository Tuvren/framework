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

import {
  TuvrenProviderError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
import type { AgentConfig, IterationDecision } from "@tuvren/core/execution";
import type { AroundModelContext } from "@tuvren/core/extensions";
import type {
  StructuredPart,
  TuvrenJsonSchema,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type {
  ProviderNativeInvocationRecord,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
import type {
  RunnerExecutionContext,
  RunnerExecutionResult,
  RunnerResumeContext,
  RunnerToolExecutionMode,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";
import { assertTuvrenModelResponse } from "@tuvren/provider-api";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type ModelExecutionOutcome,
  runAroundModelChain,
} from "./react-runner-around-model.js";
import {
  createAroundModelContextSnapshot,
  preparePromptState,
} from "./react-runner-prompt.js";
import {
  executeGenerateCall,
  executeStreamCall,
  flushBufferedAssistantSequences,
} from "./react-runner-stream.js";

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

/** `RuntimeRunner.id` reported by every runner instance this package creates. */
export const REACT_RUNNER_ID = "react";

/**
 * Provider call strategy for a single ReAct iteration: `"generate"` calls
 * `TuvrenProvider.generate` and synthesizes stream events from the complete
 * response (framework spec §6.3); `"stream"` calls `TuvrenProvider.stream`
 * and emits assistant events live as chunks arrive (framework spec §6.2).
 */
export type ReActRunnerProviderCallMode = "generate" | "stream";

/**
 * Resolves the {@link ReActRunnerProviderCallMode} for an iteration: either a
 * fixed mode, or a function evaluated per call so the choice can vary by
 * agent config, iteration count, or the resolved provider (for example,
 * falling back to `"generate"` for a provider without streaming support).
 */
export type ReActRunnerProviderCallModeResolver =
  | ReActRunnerProviderCallMode
  | ((input: {
      config: Readonly<AgentConfig>;
      iterationCount: number;
      provider: TuvrenProvider;
    }) => ReActRunnerProviderCallMode);

/**
 * Resolves the `toolExecutionMode` the runner reports on
 * `RunnerExecutionResult` when the model requests tool calls: either a fixed
 * mode, or a function evaluated per response so the choice can vary by agent
 * config, iteration count, or the model's response (framework spec §6.4).
 */
export type ReActRunnerToolExecutionModeResolver =
  | RunnerToolExecutionMode
  | ((input: {
      config: Readonly<AgentConfig>;
      iterationCount: number;
      response: TuvrenModelResponse;
    }) => RunnerToolExecutionMode);

/**
 * Construction options for {@link createReActRunner}.
 *
 * Both fields accept either a fixed value or a resolver function, letting
 * hosts vary provider-call strategy and tool-batch concurrency mode per
 * iteration without replacing the runner.
 */
export interface ReActRunnerOptions {
  /**
   * Strategy for calling the model each iteration.
   *
   * @defaultValue `"stream"`
   */
  providerCallMode?: ReActRunnerProviderCallModeResolver;
  /**
   * Execution mode reported for tool-call batches.
   *
   * @defaultValue `"parallel"`
   */
  toolExecutionMode?: ReActRunnerToolExecutionModeResolver;
}

interface ResolvedReActRunnerOptions {
  providerCallMode: ReActRunnerProviderCallModeResolver;
  toolExecutionMode: ReActRunnerToolExecutionModeResolver;
}

/**
 * `RuntimeRunner` implementation for the ReAct strategy: one model call per
 * iteration, no internal multi-step planning. `execute` and `resume` share
 * the same iteration engine ({@link executeIteration}); `resume` additionally
 * validates that every approval decision targets a tool call left pending by
 * the prior iteration before continuing.
 *
 * Both methods normalize any thrown error into a `fail` resolution with
 * `fatality: "hard"` instead of letting it escape the runner boundary,
 * matching the shared-core expectation that a runner never throws across the
 * seam.
 */
class ReActRunner implements RuntimeRunner {
  readonly id = REACT_RUNNER_ID;
  private readonly options: ResolvedReActRunnerOptions;

  constructor(options: ResolvedReActRunnerOptions) {
    this.options = options;
  }

  async execute(
    context: RunnerExecutionContext
  ): Promise<RunnerExecutionResult> {
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

  async resume(context: RunnerResumeContext): Promise<RunnerExecutionResult> {
    try {
      validateResumeApprovalContext(context);
      // Resume uses the same ReAct iteration engine as execute after validating
      // that approval decisions correspond to already-pending tool calls.
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

/**
 * Builds a `RuntimeRunnerFactory` for the ReAct runner.
 *
 * Each call to the returned factory's `create()` produces a fresh, stateless
 * `ReActRunner` instance bound to the resolved options; the factory itself
 * can be registered once and reused across agent configs.
 *
 * @param options - Optional provider-call and tool-execution mode overrides.
 *   Omitted fields default to `"stream"` and `"parallel"` respectively.
 * @returns A factory whose `id` is {@link REACT_RUNNER_ID}.
 */
export function createReActRunner(
  options?: ReActRunnerOptions
): RuntimeRunnerFactory {
  const resolvedOptions: ResolvedReActRunnerOptions = {
    providerCallMode: options?.providerCallMode ?? "stream",
    toolExecutionMode: options?.toolExecutionMode ?? "parallel",
  };

  return {
    create() {
      return new ReActRunner(resolvedOptions);
    },
    id: REACT_RUNNER_ID,
  };
}

/**
 * Builds the `RunnerExecutionResult` for a model response with no
 * model-facing content parts.
 *
 * A response can legitimately have zero `parts` when the provider executed a
 * provider-native or provider-mediated tool and only returned its result
 * (AY002/AY004): in that case the pre-staged tool message is returned alone
 * so the framework can continue the turn without dispatching through the
 * Tool Execution Gateway. A cancelled execution short-circuits to the
 * cancelled resolution. Any other empty-parts response is a provider
 * contract violation.
 *
 * @throws TuvrenRuntimeError with code `react_runner_empty_response` when the
 *   response has no parts, is not cancelled, and carries no provider tool
 *   results to fall back on.
 */
function buildEmptyPartsResult(
  context: RunnerExecutionContext,
  response: TuvrenModelResponse,
  execution: ModelExecutionOutcome,
  cancelled: boolean
): RunnerExecutionResult {
  if (cancelled) {
    return {
      partial: false,
      resolution: createExecutionCancelledResolution(),
    };
  }

  // A response with only provider-native/mediated results and no model-facing
  // output is valid: the provider executed a tool and returned its result.
  // Return only the pre-staged tool message so the framework can continue. (AY002/AY004)
  if ((response.providerToolResults?.length ?? 0) > 0) {
    const prestagedOnlyToolMessage = buildPrestagedProviderToolMessage(
      response.providerToolResults
    );
    if (prestagedOnlyToolMessage !== undefined) {
      const iterationDecisionNoTools = resolveIterationDecision(
        context.config,
        response,
        context.manifest,
        context.iterationCount,
        false
      );
      const earlyStateUpdates =
        execution.stateUpdates.length === 0
          ? undefined
          : execution.stateUpdates.map((update) => ({
              extensionName: update.extensionName,
              state: cloneValue(update.state),
            }));
      // Do not flush buffered assistant sequences for a pure provider-tool
      // response: the sequences have no content (response.parts is empty),
      // so flushing would emit empty message.start/done events that fail
      // the "assistant events require a durable assistant message" invariant.
      return {
        messages: [prestagedOnlyToolMessage],
        resolution: iterationDecisionToResolution(iterationDecisionNoTools),
        stateUpdates: earlyStateUpdates,
      };
    }
  }

  throw new TuvrenRuntimeError(
    "provider responses must contain assistant output",
    {
      code: "react_runner_empty_response",
      details: { response },
    }
  );
}

/**
 * Runs one ReAct iteration: prepares the prompt, calls the model through the
 * `aroundModel` chain, validates the response, and translates it into a
 * `RunnerExecutionResult`.
 *
 * Validation order after the model call: the response shape
 * (`assertTuvrenModelResponse`), structured-output conformance (skipped when
 * cancelled), an `error` finish reason (rejected unless cancelled), and the
 * absence of stray `tool_result` parts (provider-native results travel
 * separately via `response.providerToolResults`, not `response.parts`).
 *
 * An empty `parts` response is delegated to {@link buildEmptyPartsResult}.
 * Otherwise the single assistant message is built from the response parts,
 * `context.config.loopPolicy` (or the built-in default) decides whether the
 * turn continues, and `toolExecutionMode` is attached exactly when the
 * assistant message requests tool calls. A cancelled execution instead
 * returns a `partial: true` failed result carrying whatever assistant content
 * had accumulated. On the non-cancelled path, buffered assistant stream
 * events are flushed to `context.runtime` only after the result is fully
 * assembled, so a later validation failure cannot leave a live stream
 * inconsistent with the returned durable message.
 *
 * @throws TuvrenProviderError when the response's finish reason is `"error"`.
 * @throws TuvrenRuntimeError when the response contains `tool_result` parts
 *   or (via {@link buildEmptyPartsResult}) an unsupported empty response.
 */
async function executeIteration(
  context: RunnerExecutionContext,
  options: ResolvedReActRunnerOptions
): Promise<RunnerExecutionResult> {
  const promptState = preparePromptState({
    config: context.config,
    iterationCount: context.iterationCount,
    manifest: context.manifest,
    messages: context.messages,
    tools: context.toolRegistry.toDefinitions(),
  });
  const aroundModelContext = createAroundModelContext(context, promptState);
  const execution = await runAroundModelChain({
    callProvider: async (currentContext) =>
      await callProvider(currentContext, context, options),
    context,
    initialContext: aroundModelContext,
    normalizeExecutionError,
  });
  const response = execution.response;
  const cancelled = execution.cancelled === true;

  assertTuvrenModelResponse(response, "response");
  if (!cancelled) {
    validateStructuredOutput(execution.responseFormat, response);
  }

  if (response.finishReason === "error" && !cancelled) {
    throw new TuvrenProviderError("provider returned an error finish reason", {
      code: "react_runner_provider_failure",
      details: {
        response,
      },
    });
  }

  // Provider responses must not contain tool_result parts — but provider-native
  // invocation results arrive in the separate providerToolResults field (AY002/AY004),
  // so this guard only checks for unexpected tool_result contamination in parts.
  if (response.parts.some((part) => part.type === "tool_result")) {
    throw new TuvrenRuntimeError(
      "provider responses must not contain tool_result parts",
      {
        code: "react_runner_invalid_model_response",
        details: {
          response,
        },
      }
    );
  }

  if (response.parts.length === 0) {
    return buildEmptyPartsResult(context, response, execution, cancelled);
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

  // Build a pre-staged tool message for provider-native/mediated results so the
  // framework does not route them through the Tool Execution Gateway. (AY002/AY004)
  const prestagedToolMessage = buildPrestagedProviderToolMessage(
    response.providerToolResults
  );
  const stateUpdates =
    execution.stateUpdates.length === 0
      ? undefined
      : execution.stateUpdates.map((update) => ({
          extensionName: update.extensionName,
          state: cloneValue(update.state),
        }));
  // Build the messages array. When provider-native results exist, include the
  // pre-staged tool message so the framework does not dispatch those results
  // to the Tool Execution Gateway. (AY002/AY004)
  const runnerMessages =
    prestagedToolMessage === undefined
      ? [assistantMessage]
      : [assistantMessage, prestagedToolMessage];

  if (cancelled) {
    return {
      ...(execution.assistantEventReconciliation === undefined
        ? {}
        : {
            assistantEventReconciliation:
              execution.assistantEventReconciliation,
          }),
      messages: runnerMessages,
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

  const iterationDecision = resolveIterationDecision(
    context.config,
    response,
    context.manifest,
    context.iterationCount,
    requestsTools
  );

  const runnerResult: RunnerExecutionResult = requestsTools
    ? {
        ...(execution.assistantEventReconciliation === undefined
          ? {}
          : {
              assistantEventReconciliation:
                execution.assistantEventReconciliation,
            }),
        messages: runnerMessages,
        resolution: iterationDecisionToResolution(iterationDecision),
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
        messages: runnerMessages,
        resolution: iterationDecisionToResolution(iterationDecision),
        stateUpdates,
      };

  await flushBufferedAssistantSequences(
    execution.assistantSequences,
    context.runtime
  );

  return runnerResult;
}

async function callProvider(
  aroundContext: AroundModelContext,
  context: RunnerExecutionContext,
  options: ResolvedReActRunnerOptions
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
  context: RunnerExecutionContext,
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
  RunnerExecutionResult["resolution"],
  { type: "fail" }
> {
  return {
    error: new TuvrenRuntimeError("execution cancelled", {
      code: "react_runner_execution_cancelled",
    }),
    fatality: "hard",
    type: "fail",
  };
}

function validateResumeApprovalContext(context: RunnerResumeContext): void {
  const pendingCallIds = new Set<string>();

  for (const message of context.messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (part.type === "tool_call") {
        pendingCallIds.add(part.callId);
      }
    }
  }

  if (context.approval.decisions.length === 0) {
    throw new TuvrenRuntimeError(
      "runner resume requires at least one approval decision",
      {
        code: "runner_resume_missing_approval_decision",
      }
    );
  }

  for (const decision of context.approval.decisions) {
    if (!pendingCallIds.has(decision.callId)) {
      throw new TuvrenRuntimeError(
        "runner resume approval decision does not match a pending tool call",
        {
          code: "runner_resume_unknown_approval_call",
          details: {
            callId: decision.callId,
          },
        }
      );
    }
  }
}

function resolveProvider(model: AgentConfig["model"]): TuvrenProvider {
  if (isConcreteProvider(model)) {
    return model;
  }

  throw new TuvrenValidationError(
    "ReAct runner execution requires config.model to be a concrete TuvrenProvider",
    {
      code: "react_runner_missing_provider",
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
  resolver: ReActRunnerProviderCallModeResolver,
  context: RunnerExecutionContext,
  provider: TuvrenProvider
): ReActRunnerProviderCallMode {
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
      code: "react_runner_invalid_provider_call_mode",
      details: {
        providerCallMode: resolvedMode,
      },
    }
  );
}

function resolveToolExecutionMode(
  resolver: ReActRunnerToolExecutionModeResolver,
  context: RunnerExecutionContext,
  response: TuvrenModelResponse
): RunnerToolExecutionMode {
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
      code: "react_runner_invalid_tool_execution_mode",
      details: {
        toolExecutionMode: resolvedMode,
      },
    }
  );
}

function resolveIterationDecision(
  config: Readonly<AgentConfig>,
  response: TuvrenModelResponse,
  manifest: RunnerExecutionContext["manifest"],
  iterationCount: number,
  requestsTools: boolean
): IterationDecision {
  const decision =
    config.loopPolicy === undefined
      ? defaultIterationDecision(response)
      : config.loopPolicy.evaluate(
          cloneValue(response),
          cloneValue(manifest),
          iterationCount
        );

  if (
    !isRecord(decision) ||
    typeof decision.continue !== "boolean" ||
    typeof decision.executeTools !== "boolean" ||
    (decision.reason !== undefined && typeof decision.reason !== "string")
  ) {
    throw new TuvrenRuntimeError(
      "loopPolicy.evaluate() must return a valid IterationDecision",
      {
        code: "invalid_loop_policy",
        details: {
          decision,
        },
      }
    );
  }

  if (requestsTools && !(decision.continue && decision.executeTools)) {
    throw new TuvrenRuntimeError(
      "tool-call responses require loopPolicy to continue and execute tools",
      {
        code: "invalid_loop_policy",
        details: {
          decision,
          finishReason: response.finishReason,
        },
      }
    );
  }

  return decision;
}

function defaultIterationDecision(
  response: TuvrenModelResponse
): IterationDecision {
  if (response.finishReason === "tool_call") {
    return {
      continue: true,
      executeTools: true,
    };
  }

  return {
    continue: false,
    executeTools: false,
    reason: "done",
  };
}

function iterationDecisionToResolution(
  decision: IterationDecision
): RunnerExecutionResult["resolution"] {
  if (decision.continue) {
    return {
      type: "continue_iteration",
    };
  }

  return {
    reason: decision.reason ?? "done",
    type: "end_turn",
  };
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

function hasRequestedToolCalls(response: TuvrenModelResponse): boolean {
  return response.parts.some((part) => part.type === "tool_call");
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
    ...(aroundContext.prompt.providerNativeTools !== undefined &&
    aroundContext.prompt.providerNativeTools.length > 0
      ? {
          providerNativeTools: cloneValue(
            aroundContext.prompt.providerNativeTools
          ),
        }
      : {}),
    ...(aroundContext.prompt.providerMediatedTools !== undefined &&
    aroundContext.prompt.providerMediatedTools.length > 0
      ? {
          providerMediatedTools: cloneValue(
            aroundContext.prompt.providerMediatedTools
          ),
        }
      : {}),
    ...(aroundContext.prompt.providerContinuity === undefined
      ? {}
      : {
          providerContinuity: cloneValue(
            aroundContext.prompt.providerContinuity
          ),
        }),
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
        code: "react_runner_empty_response",
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

// ---------------------------------------------------------------------------
// Provider-native / provider-mediated pre-staged tool message (AY002/AY004)
// ---------------------------------------------------------------------------

function buildPrestagedProviderToolMessage(
  providerToolResults: ProviderNativeInvocationRecord[] | undefined
): Extract<TuvrenMessage, { role: "tool" }> | undefined {
  if (providerToolResults === undefined || providerToolResults.length === 0) {
    return undefined;
  }

  const parts = providerToolResults.map((record) => ({
    callId: record.callId,
    ...(record.isError === true ? { isError: true as const } : {}),
    name: record.name,
    output: record.result,
    providerMetadata: {
      // Spread record.providerMetadata first so canonical attribution fields
      // below are always authoritative regardless of what the provider stamps. (AY002/AY004)
      ...(record.providerMetadata ?? {}),
      executionClass: record.executionClass,
      owner: "provider",
      providerCallId: record.providerCallId,
    },
    type: "tool_result" as const,
  }));

  const [first, ...rest] = parts;

  return {
    parts: [first, ...rest],
    role: "tool",
  };
}
