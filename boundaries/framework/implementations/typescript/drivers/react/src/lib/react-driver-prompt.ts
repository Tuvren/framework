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
  AgentConfig,
  AroundModelContext,
  AroundModelResult,
  ContextManifest,
  RenderedToolDefinition,
  TuvrenExtension,
  TuvrenMessage,
  TuvrenModelConfig,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "@tuvren/runtime-api";

export interface PreparedPromptState {
  config: TuvrenModelConfig;
  messages: TuvrenMessage[];
  prompt: TuvrenPrompt;
  sharedExports: Record<string, Record<string, unknown>>;
  tools: RenderedToolDefinition[];
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
  const prompt: TuvrenPrompt = {
    config,
    messages: baseMessages,
    responseFormat:
      input.config.responseFormat === undefined
        ? undefined
        : cloneValue(input.config.responseFormat),
    tools: tools.length === 0 ? undefined : tools,
  };

  return {
    config,
    messages: baseMessages,
    prompt,
    sharedExports,
    tools,
  };
}

export function cloneAroundModelContext(
  context: AroundModelContext
): AroundModelContext {
  return {
    config: cloneValue(context.config),
    emit: context.emit,
    extensionState: cloneRecord(context.extensionState),
    iterationCount: context.iterationCount,
    manifest: cloneValue(context.manifest),
    messages: cloneValue(context.messages),
    prompt: cloneValue(context.prompt),
    sharedExports: cloneValue(context.sharedExports),
    tools: cloneValue(context.tools),
  };
}

export function normalizeAroundModelResult(
  result: AroundModelResult
): TuvrenModelResponse {
  return "response" in result ? result.response : result;
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

    const prompt =
      typeof contribution === "string"
        ? contribution
        : contribution({
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
