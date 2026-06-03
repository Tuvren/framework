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
import type { Binding } from "@tuvren/core/capabilities";
import type { AgentConfig, ContextManifest } from "@tuvren/core/execution";
import type {
  AroundModelContext,
  AroundModelResult,
  TuvrenExtension,
} from "@tuvren/core/extensions";
import type { TuvrenMessage, TuvrenModelConfig } from "@tuvren/core/messages";
import type {
  ProviderMediatedToolConfig,
  ProviderNativeToolDeclaration,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "@tuvren/core/provider";
import type { RenderedToolDefinition } from "@tuvren/core/tools";

export interface PreparedPromptState {
  config: TuvrenModelConfig;
  messages: TuvrenMessage[];
  prompt: TuvrenPrompt;
  sharedExports: Record<string, Record<string, unknown>>;
  tools: RenderedToolDefinition[];
}

export interface NormalizedAroundModelResult {
  response: TuvrenModelResponse;
  state?: Record<string, unknown>;
}

export function createAroundModelContextSnapshot(input: {
  config: TuvrenModelConfig;
  emit: AroundModelContext["emit"];
  extensionState: Record<string, unknown>;
  iterationCount: number;
  manifest: ContextManifest;
  messages: TuvrenMessage[];
  prompt: TuvrenPrompt;
  sharedExports: Record<string, Record<string, unknown>>;
  tools: RenderedToolDefinition[];
}): AroundModelContext {
  const config = cloneValue(input.config);
  const messages = cloneValue(input.messages);
  const tools = cloneValue(input.tools);
  const prompt = createPromptSnapshot({
    config,
    messages,
    providerContinuity: cloneValue(input.prompt.providerContinuity),
    providerMediatedTools: cloneValue(input.prompt.providerMediatedTools),
    providerNativeTools: cloneValue(input.prompt.providerNativeTools),
    responseFormat: cloneValue(input.prompt.responseFormat),
    tools,
  });

  return {
    config,
    emit: input.emit,
    extensionState: cloneRecord(input.extensionState),
    iterationCount: input.iterationCount,
    manifest: cloneValue(input.manifest),
    messages,
    prompt,
    sharedExports: cloneValue(input.sharedExports),
    tools,
  };
}

export function preparePromptState(input: {
  config: Readonly<AgentConfig>;
  iterationCount: number;
  manifest: Readonly<ContextManifest>;
  messages: readonly TuvrenMessage[];
  tools: RenderedToolDefinition[];
}): PreparedPromptState {
  const extensions = input.config.extensions ?? [];
  const sharedExports = buildSharedExports(extensions, input.manifest);
  const systemMessages = collectSystemMessages(
    extensions,
    input.config.systemPrompt,
    input.manifest,
    input.iterationCount,
    sharedExports
  );
  const baseMessages = [
    ...systemMessages,
    ...cloneValue(input.messages),
  ] satisfies TuvrenMessage[];
  const tools = cloneValue(input.tools);
  const config = toPromptConfig(input.config.model);
  const admittedNativeTools = admitProviderTools(
    input.config.providerNativeTools,
    "provider-native",
    input.config
  );
  const admittedMediatedTools = admitProviderTools(
    input.config.providerMediatedTools,
    "provider-mediated",
    input.config
  );
  const prompt: TuvrenPrompt = {
    config,
    messages: baseMessages,
    responseFormat:
      input.config.responseFormat === undefined
        ? undefined
        : cloneValue(input.config.responseFormat),
    tools: tools.length === 0 ? undefined : tools,
    ...(admittedNativeTools.length > 0
      ? { providerNativeTools: admittedNativeTools }
      : {}),
    ...(admittedMediatedTools.length > 0
      ? { providerMediatedTools: admittedMediatedTools }
      : {}),
  };

  return {
    config,
    messages: baseMessages,
    prompt,
    sharedExports,
    tools,
  };
}

export function normalizeNextAroundModelContext(
  currentContext: AroundModelContext,
  nextContext: AroundModelContext
): AroundModelContext {
  const resolvedConfig = resolveAroundModelSurface({
    basePromptValue: currentContext.prompt.config ?? {},
    baseValue: currentContext.config,
    nextPromptValue: nextContext.prompt.config ?? {},
    nextValue: nextContext.config,
  });
  const resolvedMessages = resolveAroundModelSurface({
    basePromptValue: currentContext.prompt.messages,
    baseValue: currentContext.messages,
    nextPromptValue: nextContext.prompt.messages,
    nextValue: nextContext.messages,
  });
  const resolvedTools = resolveAroundModelSurface({
    basePromptValue: currentContext.prompt.tools ?? [],
    baseValue: currentContext.tools,
    nextPromptValue: nextContext.prompt.tools ?? [],
    nextValue: nextContext.tools,
  });

  return createAroundModelContextSnapshot({
    config: resolvedConfig,
    emit: currentContext.emit,
    extensionState: currentContext.extensionState,
    iterationCount: currentContext.iterationCount,
    manifest: currentContext.manifest,
    messages: resolvedMessages,
    prompt: {
      responseFormat: cloneValue(nextContext.prompt.responseFormat),
      ...createPromptSnapshot({
        config: resolvedConfig,
        messages: resolvedMessages,
        providerContinuity: cloneValue(nextContext.prompt.providerContinuity),
        providerMediatedTools: cloneValue(
          nextContext.prompt.providerMediatedTools
        ),
        providerNativeTools: cloneValue(nextContext.prompt.providerNativeTools),
        responseFormat: cloneValue(nextContext.prompt.responseFormat),
        tools: resolvedTools,
      }),
    },
    sharedExports: currentContext.sharedExports,
    tools: resolvedTools,
  });
}

export function normalizeAroundModelResult(
  result: AroundModelResult
): NormalizedAroundModelResult {
  if ("response" in result) {
    return {
      response: result.response,
      state: result.state === undefined ? undefined : cloneRecord(result.state),
    };
  }

  return {
    response: result,
  };
}

export function createExtensionStateSnapshot(
  manifest: Readonly<ContextManifest>,
  extensionName: string
): Record<string, unknown> {
  return cloneRecord(manifest.extensions[extensionName]);
}

function collectSystemMessages(
  extensions: readonly TuvrenExtension[],
  basePrompt: string | undefined,
  manifest: Readonly<ContextManifest>,
  iterationCount: number,
  sharedExports: Record<string, Record<string, unknown>>
): TuvrenMessage[] {
  const messages: TuvrenMessage[] = [];

  for (const extension of extensions) {
    const contribution = extension.systemPrompt;

    if (contribution === undefined) {
      continue;
    }

    try {
      const prompt =
        typeof contribution === "string"
          ? contribution
          : contribution.call(extension, {
              extensionState: createExtensionStateSnapshot(
                manifest,
                extension.name
              ),
              iterationCount,
              manifest: cloneValue(manifest),
              sharedExports: cloneValue(sharedExports),
            });

      if (prompt !== undefined) {
        messages.push({
          content: prompt,
          role: "system",
        });
      }
    } catch {
      // System-prompt contributions are best-effort and must not abort the turn.
    }
  }

  if (basePrompt !== undefined) {
    messages.push({
      content: basePrompt,
      role: "system",
    });
  }

  return messages;
}

function buildSharedExports(
  extensions: readonly TuvrenExtension[],
  manifest: Readonly<ContextManifest>
): Record<string, Record<string, unknown>> {
  const sharedExports: Record<string, Record<string, unknown>> = {};

  for (const extension of extensions) {
    if (extension.exports === undefined || extension.exports.length === 0) {
      continue;
    }

    const sourceState = asRecord(manifest.extensions[extension.name]);
    const visibleState: Record<string, unknown> = {};

    for (const key of extension.exports) {
      if (key in sourceState) {
        visibleState[key] = cloneValue(sourceState[key]);
      }
    }

    sharedExports[extension.name] = visibleState;
  }

  return sharedExports;
}

function toPromptConfig(model: AgentConfig["model"]): TuvrenModelConfig {
  if (typeof model === "string") {
    return {
      model,
    };
  }

  if (model !== undefined) {
    return {
      provider: model.id,
    };
  }

  return {};
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return asRecord(cloneValue(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value));
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function createPromptSnapshot(input: {
  config: TuvrenModelConfig;
  messages: TuvrenMessage[];
  providerContinuity?: TuvrenPrompt["providerContinuity"];
  providerMediatedTools?: TuvrenPrompt["providerMediatedTools"];
  providerNativeTools?: TuvrenPrompt["providerNativeTools"];
  responseFormat: TuvrenPrompt["responseFormat"];
  tools: RenderedToolDefinition[];
}): TuvrenPrompt {
  return {
    config: input.config,
    messages: input.messages,
    responseFormat: input.responseFormat,
    tools: input.tools.length === 0 ? undefined : input.tools,
    ...(input.providerNativeTools !== undefined &&
    input.providerNativeTools.length > 0
      ? { providerNativeTools: input.providerNativeTools }
      : {}),
    ...(input.providerMediatedTools !== undefined &&
    input.providerMediatedTools.length > 0
      ? { providerMediatedTools: input.providerMediatedTools }
      : {}),
    ...(input.providerContinuity === undefined
      ? {}
      : { providerContinuity: input.providerContinuity }),
  };
}

function resolveAroundModelSurface<T>(input: {
  basePromptValue: T;
  baseValue: T;
  nextPromptValue: T;
  nextValue: T;
}): T {
  const promptChanged = !surfacesMatch(
    input.basePromptValue,
    input.nextPromptValue
  );
  const valueChanged = !surfacesMatch(input.baseValue, input.nextValue);

  if (promptChanged && !valueChanged) {
    return cloneValue(input.nextPromptValue);
  }

  if (valueChanged && !promptChanged) {
    return cloneValue(input.nextValue);
  }

  if (promptChanged && valueChanged) {
    return surfacesMatch(input.nextPromptValue, input.nextValue)
      ? cloneValue(input.nextValue)
      : cloneValue(input.nextPromptValue);
  }

  return cloneValue(input.nextValue);
}

function surfacesMatch(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

// ---------------------------------------------------------------------------
// Provider-native / provider-mediated binding registration + policy (AY002/AY004)
// ---------------------------------------------------------------------------

function admitProviderTools<
  T extends ProviderNativeToolDeclaration | ProviderMediatedToolConfig,
>(
  tools: T[] | undefined,
  executionClass: "provider-native" | "provider-mediated",
  config: AgentConfig
): T[] {
  if (tools === undefined || tools.length === 0) {
    return [];
  }

  const admitted: T[] = [];

  for (const tool of tools) {
    const capabilityId =
      (tool as { capabilityId?: string }).capabilityId ?? tool.name;

    // Invocation-time policy check per ADR-046 §4.21. When no engine is
    // configured, all provider tools are admitted. Construct the binding
    // inline — the resolver factory lives in @tuvren/runtime which would
    // create a circular dependency here.
    if (config.capabilityPolicyEngine !== undefined) {
      const binding: Binding = {
        capabilityId,
        endpoint: { id: "provider-runtime", kind: "provider-runtime" },
        executionClass,
      };
      const decision = config.capabilityPolicyEngine.evaluateInvocation(
        binding,
        // Context dimensions land in Epic BB; baseline engine is context-insensitive.
        { modelId: "", permissions: [], providerId: "" }
      );
      if (!decision.admitted) {
        continue;
      }
    }

    admitted.push(tool);
  }

  return admitted;
}
