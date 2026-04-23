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

import Ajv from "ajv";
import {
  TuvrenProviderError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core-types";
import type {
  DriverExecutionContext,
  DriverExecutionResult,
  DriverToolExecutionMode,
  RuntimeDriver,
  RuntimeDriverFactory,
} from "@tuvren/driver-api";
import type {
  AgentConfig,
  AroundModelContext,
  StructuredPart,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenProvider,
  TuvrenExtension,
} from "@tuvren/runtime-api";
import { assertTuvrenModelResponse } from "@tuvren/provider-api";
import {
  cloneAroundModelContext,
  createExtensionStateSnapshot,
  normalizeAroundModelResult,
  preparePromptState,
} from "./react-driver-prompt.js";
import { executeGenerateCall, executeStreamCall } from "./react-driver-stream.js";

const AJV = new Ajv({
  allErrors: true,
  strict: false,
});

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

class ReActDriver implements RuntimeDriver {
  readonly id = REACT_DRIVER_ID;

  constructor(private readonly options: ResolvedReActDriverOptions) {}

  async execute(context: DriverExecutionContext): Promise<DriverExecutionResult> {
    try {
      const execution = await executeIteration(context, this.options);
      return execution;
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
  const response = await runAroundModelChain(context, options, aroundModelContext);

  assertTuvrenModelResponse(response, "response");
  validateStructuredOutput(context, response);

  if (response.finishReason === "error") {
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
    throw new TuvrenRuntimeError("provider responses must contain assistant output", {
      code: "react_driver_empty_response",
      details: {
        response,
      },
    });
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

  return requestsTools
    ? {
        messages: [assistantMessage],
        resolution: {
          type: "continue_iteration",
        },
        toolExecutionMode: resolveToolExecutionMode(
          options.toolExecutionMode,
          context,
          response
        ),
      }
    : {
        messages: [assistantMessage],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      };
}

async function runAroundModelChain(
  context: DriverExecutionContext,
  options: ResolvedReActDriverOptions,
  initialContext: AroundModelContext
): Promise<TuvrenModelResponse> {
  const handlers = (context.config.extensions ?? []).filter(
    (extension): extension is TuvrenExtension & {
      aroundModel: NonNullable<TuvrenExtension["aroundModel"]>;
    } => extension.aroundModel !== undefined
  );

  const invokeAt = async (
    index: number,
    currentContext: AroundModelContext
  ): Promise<TuvrenModelResponse> => {
    if (index >= handlers.length) {
      return await callProvider(currentContext, context, options);
    }

    const extension = handlers[index];
    const extensionContext = {
      ...cloneAroundModelContext(currentContext),
      extensionState: createExtensionStateSnapshot(
        currentContext.manifest,
        extension.name
      ),
    } satisfies AroundModelContext;
    const result = await extension.aroundModel(
      extensionContext,
      async (nextContext) =>
        await invokeAt(
          index + 1,
          nextContext === undefined
            ? cloneAroundModelContext(currentContext)
            : cloneAroundModelContext(nextContext)
        )
    );

    return normalizeAroundModelResult(result);
  };

  return await invokeAt(0, initialContext);
}

async function callProvider(
  aroundContext: AroundModelContext,
  context: DriverExecutionContext,
  options: ResolvedReActDriverOptions
): Promise<TuvrenModelResponse> {
  const provider = resolveProvider(context.config.model);
  const providerCallMode = resolveProviderCallMode(
    options.providerCallMode,
    context,
    provider
  );

  return providerCallMode === "generate"
    ? await executeGenerateCall({
        prompt: aroundContext.prompt,
        provider,
        runtime: context.runtime,
      })
    : await executeStreamCall({
        prompt: aroundContext.prompt,
        provider,
        runtime: context.runtime,
      });
}

function createAroundModelContext(
  context: DriverExecutionContext,
  promptState: ReturnType<typeof preparePromptState>
): AroundModelContext {
  return {
    config: cloneValue(promptState.config),
    emit: (event) => {
      context.runtime.emit({
        data: cloneValue(event.data),
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
  };
}

function resolveProvider(model: AgentConfig["model"]): TuvrenProvider {
  if (model !== undefined && typeof model !== "string") {
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

function resolveProviderCallMode(
  resolver: ReActDriverProviderCallModeResolver,
  context: DriverExecutionContext,
  provider: TuvrenProvider
): ReActDriverProviderCallMode {
  return typeof resolver === "function"
    ? resolver({
        config: context.config,
        iterationCount: context.iterationCount,
        provider,
      })
    : resolver;
}

function resolveToolExecutionMode(
  resolver: ReActDriverToolExecutionModeResolver,
  context: DriverExecutionContext,
  response: TuvrenModelResponse
): DriverToolExecutionMode {
  return typeof resolver === "function"
    ? resolver({
        config: context.config,
        iterationCount: context.iterationCount,
        response,
      })
    : resolver;
}

function validateStructuredOutput(
  context: DriverExecutionContext,
  response: TuvrenModelResponse
): void {
  const request = context.config.responseFormat;

  if (request === undefined) {
    return;
  }

  const validator = AJV.compile(request.schema);
  const structuredParts = response.parts.filter(
    (part): part is StructuredPart => part.type === "structured"
  );

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
    throw new TuvrenRuntimeError("assistant output must include at least one part", {
      code: "react_driver_empty_response",
    });
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
