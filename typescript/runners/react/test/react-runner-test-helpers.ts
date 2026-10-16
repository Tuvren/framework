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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ContextManifest, InputSignal } from "@tuvren/core/execution";
import type { RunnerExecutionContext } from "@tuvren/core/runner";
import type { ToolRegistry, TuvrenToolDefinition } from "@tuvren/core/tools";

export const createContextManifest = (): ContextManifest => ({
  byRole: {
    assistant: 0,
    system: 0,
    tool: 0,
    user: 1,
  },
  extensions: {},
  lastAssistantMessageIndex: -1,
  lastUserMessageIndex: 0,
  messageCount: 1,
  tokenEstimate: 0,
  toolCalls: {
    byName: {},
    total: 0,
  },
  toolResults: {
    byName: {},
    total: 0,
  },
  turnBoundaries: [0],
});

const isCustomSchema = (
  inputSchema: TuvrenToolDefinition["inputSchema"]
): inputSchema is Extract<
  TuvrenToolDefinition["inputSchema"],
  { toJSONSchema: () => unknown }
> =>
  inputSchema !== null &&
  typeof inputSchema === "object" &&
  "toJSONSchema" in inputSchema &&
  typeof inputSchema.toJSONSchema === "function";

const toToolInputSchema = (
  tool: TuvrenToolDefinition
): ReturnType<ToolRegistry["toDefinitions"]>[number]["inputSchema"] => {
  const { inputSchema } = tool;

  if (isCustomSchema(inputSchema)) {
    return inputSchema.toJSONSchema();
  }

  return inputSchema;
};

export const createToolRegistry = (
  tools: TuvrenToolDefinition[]
): ToolRegistry => {
  const definitions = tools.map((tool) => ({
    description: tool.description,
    inputSchema: toToolInputSchema(tool),
    name: tool.name,
  }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    get(name: string) {
      return toolsByName.get(name);
    },
    has(name: string) {
      return toolsByName.has(name);
    },
    list() {
      return [...toolsByName.values()];
    },
    register(tool: TuvrenToolDefinition) {
      toolsByName.set(tool.name, tool);
    },
    toDefinitions() {
      return definitions;
    },
  };
};

export const createRunnerExecutionContext = (input?: {
  config?: RunnerExecutionContext["config"];
  emittedEvents?: TuvrenStreamEvent[];
  manifest?: ContextManifest;
  signal?: AbortSignal;
  toolDefinitions?: TuvrenToolDefinition[];
}): RunnerExecutionContext => {
  const emittedEvents = input?.emittedEvents ?? [];
  const toolDefinitions = input?.toolDefinitions ?? [];

  return {
    branchId: "branch-1",
    config: input?.config ?? {
      name: "primary",
    },
    handoff: {
      createContextPlan({ reason, targetAgent }) {
        return {
          builder() {
            return [];
          },
          mode: "preserve_trace",
          reason,
          sourceContext: {
            handoffIntent: {
              targetAgent,
            },
            helpers: {
              loadMessage() {
                return null;
              },
              storeMessage() {
                return "hash";
              },
              storeMessages() {
                return [];
              },
            },
            manifest: createContextManifest(),
            messages: [],
            sourceAgent: {
              name: "primary",
            },
            targetAgent: {
              name: targetAgent,
            },
          },
          targetAgent,
        };
      },
    },
    iterationCount: 1,
    manifest: input?.manifest ?? createContextManifest(),
    messages: [
      {
        parts: [{ text: "Hello", type: "text" }],
        role: "user",
      },
    ],
    runtime: {
      emit(event) {
        emittedEvents.push(event);
      },
      now() {
        return 1;
      },
    },
    schemaId: "tuvren.agent.v1",
    signal: input?.signal,
    threadId: "thread-1",
    toolRegistry: createToolRegistry(toolDefinitions),
    turnId: "turn-1",
  };
};

export const toRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value));
};

export const createSearchTool = (): TuvrenToolDefinition => ({
  description: "Search project docs",
  execute(input) {
    return {
      ...toRecord(input),
      result: "matched docs",
    };
  },
  inputSchema: {
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
    type: "object",
  },
  name: "search",
});

export const textSignal = (text: string): InputSignal => ({
  parts: [{ text, type: "text" }],
});

export const wait = async (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, milliseconds);
  await promise;
};

export const collectEvents = async <T>(
  events: AsyncIterable<T>
): Promise<T[]> => {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

const nextOnly = <T>(iterator: AsyncIterator<T>): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => await iterator.next(),
  }),
});

const fixedPollAttempts =
  async function* fixedPollAttempts(): AsyncGenerator<null> {
    await Promise.resolve();

    for (let attempt = 0; attempt < 50; attempt += 1) {
      yield null;
    }
  };

export const collectRemaining = async <T>(
  iterator: AsyncIterator<T>
): Promise<T[]> => {
  const collected: T[] = [];

  for await (const value of nextOnly(iterator)) {
    collected.push(value);
  }

  return collected;
};

export const collectUntil = async <T>(
  iterator: AsyncIterator<T>,
  predicate: (value: T) => boolean
): Promise<T[]> => {
  const collected: T[] = [];

  for await (const value of nextOnly(iterator)) {
    collected.push(value);

    if (predicate(value)) {
      return collected;
    }
  }

  return collected;
};

export const waitFor = async (predicate: () => boolean): Promise<void> => {
  for await (const _attempt of fixedPollAttempts()) {
    if (predicate()) {
      return;
    }

    const { promise, resolve } = Promise.withResolvers<null>();
    setTimeout(() => {
      resolve(null);
    }, 1);
    await promise;
  }

  throw new Error("condition was not met before timeout");
};
