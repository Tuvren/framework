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

import type { DriverExecutionContext } from "@tuvren/driver-api";
import type {
  ContextManifest,
  InputSignal,
  ToolRegistry,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";

export function createDriverExecutionContext(input?: {
  config?: DriverExecutionContext["config"];
  emittedEvents?: TuvrenStreamEvent[];
  manifest?: ContextManifest;
  signal?: AbortSignal;
  toolDefinitions?: TuvrenToolDefinition[];
}): DriverExecutionContext {
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
}

export function createToolRegistry(
  tools: TuvrenToolDefinition[]
): ToolRegistry {
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
}

export function createContextManifest(): ContextManifest {
  return {
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
  };
}

export function createSearchTool(): TuvrenToolDefinition {
  return {
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
  };
}

export function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

export async function collectRemaining<T>(
  iterator: AsyncIterator<T>
): Promise<T[]> {
  const collected: T[] = [];

  while (true) {
    const result = await iterator.next();

    if (result.done) {
      return collected;
    }

    collected.push(result.value);
  }
}

export async function collectUntil<T>(
  iterator: AsyncIterator<T>,
  predicate: (value: T) => boolean
): Promise<T[]> {
  const collected: T[] = [];

  while (true) {
    const result = await iterator.next();

    if (result.done) {
      return collected;
    }

    collected.push(result.value);

    if (predicate(result.value)) {
      return collected;
    }
  }
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }

  throw new Error("condition was not met before timeout");
}

export function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value));
}

function toToolInputSchema(
  tool: TuvrenToolDefinition
): ReturnType<ToolRegistry["toDefinitions"]>[number]["inputSchema"] {
  const { inputSchema } = tool;

  if (isCustomSchema(inputSchema)) {
    return inputSchema.toJSONSchema();
  }

  return inputSchema;
}

function isCustomSchema(
  inputSchema: TuvrenToolDefinition["inputSchema"]
): inputSchema is Extract<
  TuvrenToolDefinition["inputSchema"],
  { toJSONSchema(): unknown }
> {
  return (
    inputSchema !== null &&
    typeof inputSchema === "object" &&
    "toJSONSchema" in inputSchema &&
    typeof inputSchema.toJSONSchema === "function"
  );
}
