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
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver,
} from "@tuvren/driver-api";
import type { TuvrenProvider } from "@tuvren/provider-api";
import type {
  ContextManifest,
  InputSignal,
  ToolCallPart,
  ToolRegistry,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import { createReActDriver } from "../../drivers/react/src/index.ts";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "../../runtime-core/src/index.ts";
import { createFakeKernelHarness } from "../../runtime-core/test/fake-kernel.ts";

export interface AdapterProjection {
  events?: readonly unknown[];
  evidence?: Record<string, unknown>;
  result?: unknown;
  state?: Record<string, unknown>;
}

export interface ScenarioToolCall {
  readonly callId: string;
  readonly input: unknown;
  readonly name: string;
  readonly output?: unknown;
  readonly requiresApproval?: boolean;
}

export const DRIVER_ID = "typescript-conformance-driver";
export const AGENT_NAME = "typescript-conformance-agent";

export function createConformanceIdFactory(): () => string {
  let nextId = 1;

  // Compatibility evidence is checked in, so conformance-only runtime IDs stay
  // deterministic while the production runtime keeps its random default IDs.
  return () => `conformance-id-${nextId++}`;
}

export function createScenarioProvider(
  responses: readonly TuvrenModelResponse[],
  onGenerate: () => void
): TuvrenProvider {
  let responseIndex = 0;

  return {
    generate() {
      onGenerate();

      const response = responses[responseIndex] ?? responses.at(-1);

      if (response === undefined) {
        return Promise.reject(
          new Error("driver scenario must provide at least one response")
        );
      }

      responseIndex += 1;
      return Promise.resolve(structuredClone(response));
    },
    id: "provider",
    async *stream() {
      await Promise.resolve();
      yield* [];
    },
  };
}

export function createRuntimeWithReactDriver(): ReturnType<
  typeof createTuvrenRuntimeCore
> {
  const reactDriver = createReActDriver({
    providerCallMode: "generate",
  }).create();

  return createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: reactDriver.id,
    driverRegistry: createDriverRegistry([reactDriver]),
    kernel: createFakeKernelHarness().kernel,
  });
}

export function createStaticDriver(
  execute: (
    context: DriverExecutionContext
  ) => DriverExecutionResult | Promise<DriverExecutionResult>
): RuntimeDriver {
  return {
    execute(context) {
      return Promise.resolve(execute(context));
    },
    id: DRIVER_ID,
  };
}

export function createDriverExecutionContext(input?: {
  config?: DriverExecutionContext["config"];
  emittedEvents?: TuvrenStreamEvent[];
  manifest?: ContextManifest;
  messages?: readonly TuvrenMessage[];
  signal?: AbortSignal;
  toolDefinitions?: TuvrenToolDefinition[];
}): DriverExecutionContext {
  const emittedEvents = input?.emittedEvents ?? [];
  const toolDefinitions = input?.toolDefinitions ?? [];

  return {
    branchId: "branch-1",
    config: input?.config ?? { name: AGENT_NAME },
    handoff: {
      createContextPlan({ reason, targetAgent }) {
        return {
          builder() {
            return [];
          },
          mode: "preserve_trace",
          reason,
          sourceContext: {
            handoffIntent: { targetAgent },
            helpers: {
              loadMessage() {
                return null;
              },
              storeMessage() {
                return "0".repeat(64);
              },
              storeMessages() {
                return [];
              },
            },
            manifest: createContextManifest(),
            messages: [],
            sourceAgent: { name: AGENT_NAME },
            targetAgent: { name: targetAgent },
          },
          targetAgent,
        };
      },
    },
    iterationCount: 1,
    manifest: input?.manifest ?? createContextManifest(),
    messages: input?.messages ?? [
      {
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    ],
    runtime: {
      emit(event) {
        emittedEvents.push(event);
      },
      now: createClock(),
    },
    schemaId: "tuvren.agent.v1",
    signal: input?.signal,
    threadId: "thread-1",
    toolRegistry: createToolRegistry(toolDefinitions),
    turnId: "turn-1",
  };
}

function createToolRegistry(
  tools: readonly TuvrenToolDefinition[]
): ToolRegistry {
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
      return [...toolsByName.values()].map((tool) => ({
        description: tool.description,
        inputSchema: { type: "object" },
        name: tool.name,
      }));
    },
  };
}

function createContextManifest(): ContextManifest {
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

export function assistantText(text: string): TuvrenMessage {
  return {
    parts: [{ text, type: "text" }],
    role: "assistant",
  };
}

export function assistantToolCalls(
  calls: readonly ScenarioToolCall[]
): TuvrenMessage {
  const firstCall = calls[0];

  if (firstCall === undefined) {
    throw new Error("tool call scenario must contain at least one call");
  }

  const remainingCalls = calls.slice(1);
  const parts: [ToolCallPart, ...ToolCallPart[]] = [
    toToolCallPart(firstCall),
    ...remainingCalls.map(toToolCallPart),
  ];

  return {
    parts,
    role: "assistant",
  };
}

function toToolCallPart(call: {
  callId: string;
  input: unknown;
  name: string;
}): ToolCallPart {
  return {
    callId: call.callId,
    input: call.input,
    name: call.name,
    type: "tool_call",
  };
}

export function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}

export function createClock(): () => number {
  let now = 1;
  return () => now++;
}

export async function collectValues<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
}
