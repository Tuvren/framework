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

import { describe, expect, test } from "bun:test";
import type { DriverExecutionContext } from "@tuvren/driver-api";
import type {
  ContextManifest,
  InputSignal,
  TuvrenExtension,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenProvider,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
  ToolRegistry,
} from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "@tuvren/runtime-core";
import { createFakeKernelHarness } from "../../../runtime-core/test/fake-kernel.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";

describe("driver-react", () => {
  test("renders host and extension system prompts plus tools into the provider prompt", async () => {
    let capturedMessages: TuvrenMessage[] = [];
    let capturedToolsLength = 0;
    const provider = {
      async generate(prompt) {
        capturedMessages = prompt.messages;
        capturedToolsLength = prompt.tools?.length ?? 0;
        return {
          finishReason: "stop",
          parts: [{ text: "Rendered prompt", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [
            {
              name: "capsule",
              systemPrompt: "Extension guidance",
            },
          ],
          model: provider,
          name: "primary",
          systemPrompt: "Host guidance",
        },
        toolDefinitions: [createSearchTool()],
      })
    );

    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(capturedMessages.slice(0, 2)).toEqual([
      { content: "Extension guidance", role: "system" },
      { content: "Host guidance", role: "system" },
    ]);
    expect(capturedToolsLength).toBe(1);
  });

  test("keeps provider call mode and tool execution mode host-configurable", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "tool_call",
          parts: [
            {
              callId: "tool-1",
              input: { query: "docs" },
              name: "search",
              type: "tool_call",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        streamCalls += 1;
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: () => "generate",
      toolExecutionMode: () => "sequential",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
      })
    );

    expect(generateCalls).toBe(1);
    expect(streamCalls).toBe(0);
    expect(result.toolExecutionMode).toBe("sequential");
    expect(result.resolution).toEqual({
      type: "continue_iteration",
    });
  });

  test("streams canonical tool-call events and preserves provider call metadata", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          providerCallId: "native-call-1",
          name: "search",
          type: "tool_call_start",
        } as const;
        yield {
          delta: '{"query":"runtime"}',
          providerCallId: "native-call-1",
          type: "tool_call_args_delta",
        } as const;
        yield {
          input: { query: "runtime" },
          name: "search",
          providerCallId: "native-call-1",
          type: "tool_call_done",
        } as const;
        yield {
          finishReason: "tool_call",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
      toolExecutionMode: "parallel",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(result.resolution).toEqual({
      type: "continue_iteration",
    });
    expect(result.toolExecutionMode).toBe("parallel");
    const firstMessage = result.messages?.[0];

    if (firstMessage?.role !== "assistant") {
      throw new Error("expected an assistant message");
    }

    const firstPart = firstMessage.parts[0];

    if (firstPart?.type !== "tool_call") {
      throw new Error("expected a tool call");
    }

    expect(firstPart.input).toEqual({ query: "runtime" });
    expect(firstPart.name).toBe("search");
    expect(firstPart.callId).not.toBe("native-call-1");
    expect(firstPart.providerMetadata).toEqual({
      providerCallId: "native-call-1",
    });
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "tool_call.start",
      "tool_call.args_delta",
      "tool_call.done",
      "message.done",
    ]);
  });

  test("lets aroundModel short-circuit without touching the provider", async () => {
    let providerCalls = 0;
    const provider = {
      async generate() {
        providerCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: "provider", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const extension: TuvrenExtension = {
      async aroundModel(_context, _next) {
        return {
          finishReason: "stop",
          parts: [{ text: "short-circuit", type: "text" }],
        };
      },
      name: "cache",
    };
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();
    const emittedEvents: TuvrenStreamEvent[] = [];

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [extension],
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(providerCalls).toBe(0);
    expect(emittedEvents).toEqual([]);
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "short-circuit", type: "text" }],
      role: "assistant",
    });
  });

  test("supports aroundModel retry with distinct generated assistant sequences", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [
            {
              text: generateCalls === 1 ? "first attempt" : "second attempt",
              type: "text",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const extension: TuvrenExtension = {
      async aroundModel(context, next) {
        await next(context);
        const retryContext = {
          ...context,
          prompt: {
            ...context.prompt,
            messages: [
              ...context.prompt.messages,
              {
                content: "Retry with fallback provider behavior",
                role: "system" as const,
              },
            ],
          },
        };
        return await next(retryContext);
      },
      name: "retry",
    };
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [extension],
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(generateCalls).toBe(2);
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "second attempt", type: "text" }],
      role: "assistant",
    });
    expect(
      emittedEvents.filter((event) => event.type === "message.start").length
    ).toBe(2);
  });

  test("maps reasoning and structured parts from streamed provider responses", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "internal reasoning",
          signature: "sig-1",
          type: "reasoning_delta",
        } as const;
        yield {
          type: "reasoning_done",
        } as const;
        yield {
          delta: '{"answer":"ok"}',
          type: "structured_delta",
        } as const;
        yield {
          data: { answer: "ok" },
          name: "answer",
          type: "structured_done",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(result.messages).toEqual([
      {
        parts: [
          {
            providerMetadata: {
              signature: "sig-1",
            },
            redacted: false,
            text: "internal reasoning",
            type: "reasoning",
          },
          {
            data: { answer: "ok" },
            name: "answer",
            type: "structured",
          },
        ],
        role: "assistant",
      },
    ]);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "reasoning.delta",
      "reasoning.done",
      "structured.delta",
      "structured.done",
      "message.done",
    ]);
  });

  test("fails hard when config.model is not a concrete provider", async () => {
    const driver = createReActDriver().create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: "gpt-test",
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect("code" in result.resolution.error ? result.resolution.error.code : undefined).toBe(
      "react_driver_missing_provider"
    );
  });

  test("fails hard when structured output violates the requested schema", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: { answer: 42 },
              name: "answer",
              type: "structured",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect("code" in result.resolution.error ? result.resolution.error.code : undefined).toBe(
      "structured_output_validation"
    );
  });

  test("fails hard when provider emits an error chunk", async () => {
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          error: new Error("provider transport failed"),
          type: "error",
        } as const;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect("code" in result.resolution.error ? result.resolution.error.code : undefined).toBe(
      "react_driver_provider_failure"
    );
  });

  test("fails hard when streamed structured output cannot be parsed", async () => {
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          delta: '{"answer":',
          type: "structured_delta",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect("code" in result.resolution.error ? result.resolution.error.code : undefined).toBe(
      "react_driver_invalid_provider_stream"
    );
  });

  test("executes end to end through runtime-core with a generated terminal response", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
        }),
      ]),
      kernel: harness.kernel,
    });
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "Hello from ReAct.", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Say hello"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(events.some((event) => event.type === "message.done")).toBe(true);
    expect(handle.status().phase).toBe("completed");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "Hello from ReAct.", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("executes end to end through runtime-core for aroundModel short-circuit synthesis", async () => {
    const harness = createFakeKernelHarness();
    let providerCalls = 0;
    const provider = {
      async generate() {
        providerCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: "provider output", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundModel() {
              return {
                finishReason: "stop",
                parts: [{ text: "cached answer", type: "text" }],
              };
            },
            name: "cache",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Use cache"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(providerCalls).toBe(0);
    expect(events.some((event) => event.type === "message.done")).toBe(true);
    expect(handle.status().phase).toBe("completed");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "cached answer", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("executes end to end through runtime-core for streamed tool calls with host-selected sequential mode", async () => {
    const harness = createFakeKernelHarness();
    let iteration = 0;
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        if (iteration === 0) {
          iteration += 1;
          yield {
            providerCallId: "provider-call-1",
            name: "search",
            type: "tool_call_start",
          } as const;
          yield {
            delta: '{"query":"docs"}',
            providerCallId: "provider-call-1",
            type: "tool_call_args_delta",
          } as const;
          yield {
            input: { query: "docs" },
            name: "search",
            providerCallId: "provider-call-1",
            type: "tool_call_done",
          } as const;
          yield {
            finishReason: "tool_call",
            type: "finish",
          } as const;
          return;
        }

        yield {
          text: "Tool run complete",
          type: "text_delta",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
          toolExecutionMode: "sequential",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Use the search tool"),
      threadId: thread.threadId,
      tools: [createSearchTool()],
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(
      events.some(
        (event) => event.type === "tool_call.done" && event.name === "search"
      )
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "tool.result" && event.name === "search"
      )
    ).toBe(true);
    expect(handle.status().phase).toBe("completed");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "Tool run complete", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });
});

function createDriverExecutionContext(input?: {
  config?: DriverExecutionContext["config"];
  emittedEvents?: TuvrenStreamEvent[];
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
    manifest: createContextManifest(),
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
    threadId: "thread-1",
    toolRegistry: createToolRegistry(toolDefinitions),
    turnId: "turn-1",
  };
}

function createToolRegistry(tools: TuvrenToolDefinition[]): ToolRegistry {
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

function createSearchTool(): TuvrenToolDefinition {
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

function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

function toRecord(value: unknown): Record<string, unknown> {
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
): inputSchema is Extract<TuvrenToolDefinition["inputSchema"], { toJSONSchema(): unknown }> {
  return (
    inputSchema !== null &&
    typeof inputSchema === "object" &&
    "toJSONSchema" in inputSchema &&
    typeof inputSchema.toJSONSchema === "function"
  );
}
