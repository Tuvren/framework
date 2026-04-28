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

// biome-ignore-all lint/suspicious/useAwait: Test doubles intentionally match async provider and extension contracts.
import { describe, expect, test } from "bun:test";
import { TuvrenProviderError } from "@tuvren/core-types";
import {
  assertDriverExecutionResult,
  type DriverExecutionContext,
} from "@tuvren/driver-api";
import type {
  ContextManifest,
  InputSignal,
  ProviderStreamChunk,
  ToolRegistry,
  TuvrenExtension,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createContextManifest as createRuntimeContextManifest,
  createTuvrenRuntimeCore,
} from "@tuvren/runtime-core";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { createFakeKernelHarness } from "../../../runtime-core/test/fake-kernel.ts";
import { readBranchContextManifest } from "../../../runtime-core/test/runtime-core-test-helpers.ts";
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

  test("binds method-style systemPrompt callbacks to their extension receiver", async () => {
    let capturedMessages: TuvrenMessage[] = [];
    const provider = {
      async generate(prompt) {
        capturedMessages = prompt.messages;
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
    const extension = {
      name: "capsule",
      promptLabel: "Bound guidance",
      systemPrompt() {
        return this.promptLabel;
      },
    } satisfies TuvrenExtension & { promptLabel: string };
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [extension],
          model: provider,
          name: "primary",
        },
      })
    );

    expect(capturedMessages[0]).toEqual({
      content: "Bound guidance",
      role: "system",
    });
  });

  test("ignores failing systemPrompt callbacks and keeps rendering remaining prompts", async () => {
    let capturedMessages: TuvrenMessage[] = [];
    const provider = {
      async generate(prompt) {
        capturedMessages = prompt.messages;
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
              name: "broken",
              systemPrompt() {
                throw new Error("prompt render failed");
              },
            },
            {
              name: "healthy",
              systemPrompt: "Healthy guidance",
            },
          ],
          model: provider,
          name: "primary",
          systemPrompt: "Host guidance",
        },
      })
    );

    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(
      capturedMessages
        .filter(
          (
            message
          ): message is Extract<
            TuvrenMessage,
            { role: "system"; content: string }
          > => message.role === "system"
        )
        .map((message) => message.content)
    ).toEqual(["Healthy guidance", "Host guidance"]);
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

  test("allows loopPolicy to continue after a non-tool assistant response", async () => {
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: "Keep going", type: "text" }],
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
          loopPolicy: {
            evaluate(response) {
              return {
                continue: response.parts.some(
                  (part) => part.type === "text" && part.text === "Keep going"
                ),
                executeTools: false,
                reason: "custom_continue",
              };
            },
          },
          model: provider,
          name: "primary",
        },
      })
    );

    expect(generateCalls).toBe(1);
    expect(result.resolution).toEqual({
      type: "continue_iteration",
    });
    expect(result.toolExecutionMode).toBeUndefined();
  });

  test("fails hard with invalid_loop_policy when loopPolicy disables tool execution for tool-call responses", async () => {
    const provider = {
      async generate() {
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
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          loopPolicy: {
            evaluate() {
              return {
                continue: true,
                executeTools: false,
                reason: "never_run_tools",
              };
            },
          },
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "invalid_loop_policy",
    });
  });

  test("fails hard with invalid_loop_policy when loopPolicy returns a terminal decision for tool-call responses", async () => {
    const provider = {
      async generate() {
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
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          loopPolicy: {
            evaluate() {
              return {
                continue: false,
                executeTools: false,
                reason: "stop_now",
              };
            },
          },
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "invalid_loop_policy",
    });
  });

  test("fails hard when providerCallMode resolves to an invalid value", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: "unused", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        streamCalls += 1;
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode() {
        return JSON.parse('"bogus"');
      },
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
      })
    );

    expect(generateCalls).toBe(0);
    expect(streamCalls).toBe(0);
    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_driver_invalid_provider_call_mode",
    });
  });

  test("fails hard when toolExecutionMode resolves to an invalid value", async () => {
    let generateCalls = 0;
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
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
      toolExecutionMode() {
        return JSON.parse('"bogus"');
      },
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
    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_driver_invalid_tool_execution_mode",
    });
  });

  test("fails hard when loopPolicy returns a malformed IterationDecision", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "bad decision", type: "text" }],
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
          loopPolicy: {
            evaluate() {
              return JSON.parse('{"continue":"yes","executeTools":false}');
            },
          },
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "invalid_loop_policy",
    });
  });

  test("fails hard when loopPolicy returns a non-object value", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "bad primitive decision", type: "text" }],
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
          loopPolicy: {
            evaluate() {
              return JSON.parse("null");
            },
          },
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "invalid_loop_policy",
    });
  });

  test("fails hard with a stable contract error when generate returns a malformed response", async () => {
    const provider = {
      async generate() {
        return JSON.parse('{"finishReason":"stop"}');
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
        },
      })
    );

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "invalid_model_response",
    });
  });

  test("fails hard with a stable contract error when generate returns an uncloneable malformed response", async () => {
    const provider = {
      async generate() {
        const response = JSON.parse('{"finishReason":"stop"}');
        response.uncloneable = () => "invalid";
        return response;
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
        },
      })
    );

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "invalid_model_response",
    });
  });

  test("does not call generate when the driver signal is already aborted", async () => {
    const controller = new AbortController();
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: "should not run", type: "text" }],
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
    controller.abort(new Error("cancelled before provider call"));

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
        signal: controller.signal,
      })
    );

    expect(generateCalls).toBe(0);
    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_driver_execution_cancelled",
    });
  });

  test("stops waiting for generate when the driver signal aborts during the provider call", async () => {
    const controller = new AbortController();
    const provider = {
      async generate() {
        controller.abort(new Error("cancelled during provider call"));
        await wait(1000);
        return {
          finishReason: "stop",
          parts: [{ text: "too late", type: "text" }],
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

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after abort");
    }

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_driver_execution_cancelled",
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

  test("emits streamed assistant events before the provider stream finishes", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    let releaseStream: (() => void) | undefined;
    let settled = false;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "live output",
          type: "text_delta",
        } as const;
        await streamGate;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const execution = driver
      .execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
        })
      )
      .finally(() => {
        settled = true;
      });

    await waitFor(() =>
      emittedEvents.some((event) => event.type === "text.delta")
    );

    expect(settled).toBe(false);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "text.delta",
    ]);

    releaseStream?.();

    const result = await execution;

    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
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
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "text.delta",
      "text.done",
      "message.done",
    ]);
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "short-circuit", type: "text" }],
      role: "assistant",
    });
  });

  test("applies top-level aroundModel config, message, and tool mutations when next() is called without an explicit context", async () => {
    let capturedMessages: TuvrenMessage[] = [];
    let capturedConfig: TuvrenPrompt["config"];
    let capturedToolsLength = 0;
    const provider = {
      async generate(prompt) {
        capturedMessages = prompt.messages;
        capturedConfig = prompt.config;
        capturedToolsLength = prompt.tools?.length ?? 0;
        return {
          finishReason: "stop",
          parts: [{ text: "mutated prompt", type: "text" }],
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

    await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, next) {
                context.config = {
                  ...context.config,
                  model: "mutated-model",
                  settings: {
                    temperature: 0.1,
                  },
                };
                context.messages = [
                  ...context.messages,
                  {
                    content: "Injected guidance",
                    role: "system",
                  },
                ];
                context.tools = [];
                return await next();
              },
              name: "mutator",
            },
          ],
          model: provider,
          name: "primary",
        },
        toolDefinitions: [createSearchTool()],
      })
    );

    expect(capturedConfig).toEqual({
      model: "mutated-model",
      provider: "provider",
      settings: {
        temperature: 0.1,
      },
    });
    expect(capturedMessages).toEqual(
      expect.arrayContaining([
        {
          content: "Injected guidance",
          role: "system",
        },
      ])
    );
    expect(capturedToolsLength).toBe(0);
  });

  test("does not let aroundModel next() mutate manifest snapshots or shared exports seen by inner handlers", async () => {
    let observedManifestSource: Record<string, unknown> | undefined;
    let observedSharedExport: unknown;
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "isolated snapshots", type: "text" }],
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

    await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [
            {
              exports: ["exported"],
              name: "source",
            },
            {
              async aroundModel(context, next) {
                context.manifest.extensions.source = {
                  exported: "mutated-manifest",
                };
                context.sharedExports.source.exported = "mutated-shared";
                return await next(context);
              },
              name: "outer",
            },
            {
              async aroundModel(context, next) {
                observedManifestSource = toRecord(
                  context.manifest.extensions.source
                );
                observedSharedExport = context.sharedExports.source?.exported;
                return await next(context);
              },
              name: "observer",
            },
          ],
          model: provider,
          name: "primary",
        },
        manifest: createRuntimeContextManifest([], {
          source: {
            exported: "persisted-shared",
          },
        }),
      })
    );

    expect(observedManifestSource).toEqual({
      exported: "persisted-shared",
    });
    expect(observedSharedExport).toBe("persisted-shared");
  });

  test("uses the effective aroundModel responseFormat instead of the original agent config", async () => {
    let capturedResponseFormat: TuvrenPrompt["responseFormat"];
    const provider = {
      async generate(prompt) {
        capturedResponseFormat = prompt.responseFormat;
        return {
          finishReason: "stop",
          parts: [{ text: "plain text allowed", type: "text" }],
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
              async aroundModel(context, next) {
                context.prompt.responseFormat = undefined;
                return await next();
              },
              name: "schema-toggle",
            },
          ],
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

    expect(capturedResponseFormat).toBeUndefined();
    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "plain text allowed", type: "text" }],
      role: "assistant",
    });
  });

  test("honors post-next aroundModel responseFormat removal during validation", async () => {
    let capturedResponseFormat: TuvrenPrompt["responseFormat"];
    const provider = {
      async generate(prompt) {
        capturedResponseFormat = prompt.responseFormat;
        return {
          finishReason: "stop",
          parts: [{ text: "plain text allowed", type: "text" }],
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
              async aroundModel(context, next) {
                const response = await next();
                context.prompt.responseFormat = undefined;
                return response;
              },
              name: "schema-toggle",
            },
          ],
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

    expect(capturedResponseFormat).toEqual({
      name: "answer",
      schema: {
        properties: {
          answer: { type: "string" },
        },
        required: ["answer"],
        type: "object",
      },
    });
    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "plain text allowed", type: "text" }],
      role: "assistant",
    });
  });

  test("does not emit a second live assistant sequence when aroundModel replaces a single next() response", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "provider",
          type: "text_delta",
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
          extensions: [
            {
              async aroundModel(_context, next) {
                const response = await next();
                return {
                  ...response,
                  parts: [{ text: "modified", type: "text" }],
                };
              },
              name: "rewriter",
            },
          ],
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(
      emittedEvents
        .filter(
          (event): event is Extract<TuvrenStreamEvent, { type: "text.done" }> =>
            event.type === "text.done"
        )
        .map((event) => event.text)
    ).toEqual(["provider"]);
    expect(
      emittedEvents.filter((event) => event.type === "message.start").length
    ).toBe(1);
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "modified", type: "text" }],
      role: "assistant",
    });
  });

  test("keeps the next() response when aroundModel throws after next", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "provider response", type: "text" }],
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
              async aroundModel(_context, next) {
                await next();
                throw new Error("telemetry write failed");
              },
              name: "telemetry",
            },
          ],
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
    expect(result.messages?.[0]).toEqual({
      parts: [{ text: "provider response", type: "text" }],
      role: "assistant",
    });
    expect(
      emittedEvents.find(
        (event): event is Extract<TuvrenStreamEvent, { type: "custom" }> =>
          event.type === "custom"
      )
    ).toMatchObject({
      data: {
        extensionName: "telemetry",
        message: "telemetry write failed",
        phase: "post_next",
      },
      name: "react_driver.around_model_error",
      type: "custom",
    });
    expect(
      emittedEvents.filter((event) => event.type === "message.start")
    ).toHaveLength(1);
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

  test("fails hard when aroundModel retry returns a stale generate response instead of the final next() result", async () => {
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
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, next) {
                const firstResponse = await next(context);
                await next(context);
                return firstResponse;
              },
              name: "retry",
            },
          ],
          model: provider,
          name: "primary",
        },
      })
    );

    expect(generateCalls).toBe(2);
    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_invalid_around_model_retry");
  });

  test("fails hard when aroundModel retry returns a stale streamed response instead of the final next() result", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    let streamCalls = 0;
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        streamCalls += 1;
        yield {
          text: streamCalls === 1 ? "first attempt" : "second attempt",
          type: "text_delta",
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
          extensions: [
            {
              async aroundModel(context, next) {
                const firstResponse = await next(context);
                await next(context);
                return firstResponse;
              },
              name: "retry",
            },
          ],
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(streamCalls).toBe(2);
    expect(
      emittedEvents
        .filter(
          (event): event is Extract<TuvrenStreamEvent, { type: "text.done" }> =>
            event.type === "text.done"
        )
        .map((event) => event.text)
    ).toEqual(["first attempt", "second attempt"]);
    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_invalid_around_model_retry");
  });

  test("keeps only the final retry state updates from nested aroundModel executions", async () => {
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: `attempt-${generateCalls}`, type: "text" }],
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
              async aroundModel(context, next) {
                await next(context);
                return await next(context);
              },
              name: "retry",
            },
            {
              async aroundModel(context, next) {
                const response = await next(context);
                return {
                  response,
                  state:
                    generateCalls === 1
                      ? { discardedAttempt: true, retainedAttempt: false }
                      : { retainedAttempt: true },
                };
              },
              name: "budget",
            },
          ],
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(result.stateUpdates).toEqual([
      {
        extensionName: "budget",
        state: {
          retainedAttempt: true,
        },
      },
    ]);
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

  test("synthesizes structured deltas when provider streams final structured data only", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const structuredDone = {
          data: { answer: "ok" },
          name: "answer",
          type: "structured_done",
        } satisfies ProviderStreamChunk;
        const finish = {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;

        yield structuredDone;
        yield finish;
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
      "structured.delta",
      "structured.done",
      "message.done",
    ]);
    expect(
      emittedEvents.find(
        (
          event
        ): event is Extract<TuvrenStreamEvent, { type: "structured.delta" }> =>
          event.type === "structured.delta"
      )
    ).toMatchObject({
      delta: '{"answer":"ok"}',
    });
  });

  test("synthesizes tool-call args deltas when provider streams complete tool calls without incremental args chunks", async () => {
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
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "tool_call.start",
      "tool_call.args_delta",
      "tool_call.done",
      "message.done",
    ]);
    expect(
      emittedEvents.find(
        (
          event
        ): event is Extract<
          TuvrenStreamEvent,
          { type: "tool_call.args_delta" }
        > => event.type === "tool_call.args_delta"
      )
    ).toMatchObject({
      delta: '{"query":"runtime"}',
    });
  });

  test("fails hard when a provider stream finishes before tool_call_done", async () => {
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
          finishReason: "tool_call",
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

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_driver_invalid_provider_stream",
    });
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "tool_call.start",
    ]);
  });

  test("fails hard when a provider stream finishes before structured_done", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          delta: '{"answer":"yes"}',
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
        emittedEvents,
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_driver_invalid_provider_stream",
    });
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "structured.delta",
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
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_missing_provider");
  });

  test("fails hard when config.model is an object that is not a provider", async () => {
    const driver = createReActDriver().create();
    const config: DriverExecutionContext["config"] = JSON.parse(
      '{"model":{"id":"provider"},"name":"primary"}'
    );

    const result = await driver.execute(
      createDriverExecutionContext({
        config,
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_missing_provider");
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

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });

  test("validates draft 2020-12 structured output using the declared schema dialect", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: ["x"],
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
              $schema: "https://json-schema.org/draft/2020-12/schema",
              items: false,
              prefixItems: [{ type: "string" }],
              type: "array",
            },
          },
        },
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
            data: ["x"],
            name: "answer",
            type: "structured",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("validates dynamic structured schemas with reused ids independently", async () => {
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [
            {
              data: generateCalls === 1 ? { answer: "alpha" } : { answer: 42 },
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

    const firstResult = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $id: "urn:tuvren:test:answer",
              additionalProperties: false,
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
    const secondResult = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $id: "urn:tuvren:test:answer",
              additionalProperties: false,
              properties: {
                answer: { type: "number" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );

    expect(firstResult.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(secondResult.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
  });

  test("validates draft 2019-09 structured output using the declared schema dialect", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: { answer: "ok", extra: true },
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
              $schema: "https://json-schema.org/draft/2019-09/schema",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
              unevaluatedProperties: false,
            },
          },
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });

  test("fails hard when structured output declares an unsupported schema dialect", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: { answer: "ok" },
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
              $schema: "https://example.com/json-schema/latest",
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

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });

  test("fails hard when a structured response request ends with plain text only", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "plain text fallback", type: "text" }],
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

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
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

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_provider_failure");
  });

  test("preserves provider error codes from stream error chunks", async () => {
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          error: new TuvrenProviderError("provider quota exceeded", {
            code: "provider_quota_exceeded",
            details: {
              bucket: "tokens",
            },
          }),
          type: "error",
        };
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

    expect(result.resolution.error).toMatchObject({
      code: "provider_quota_exceeded",
      details: {
        bucket: "tokens",
      },
    });
  });

  test("fails hard when provider.stream yields an invalid chunk shape", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          finishReason: "stop",
          type: "finish",
          unexpected: true,
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

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("invalid_provider_stream_chunk");
    expect(emittedEvents.map((event) => event.type)).toEqual(["message.start"]);
  });

  test("fails hard when provider.stream yields an uncloneable invalid chunk shape", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const chunk = JSON.parse(
          '{"finishReason":"stop","type":"finish","unexpected":true}'
        );
        chunk.uncloneable = () => "invalid";
        yield chunk;
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

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.error).toMatchObject({
      code: "invalid_provider_stream_chunk",
    });
    expect(emittedEvents.map((event) => event.type)).toEqual(["message.start"]);
  });

  test("returns a partial failed assistant message when stream aborts after live output", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const controller = new AbortController();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "partial",
          type: "text_delta",
        };
        controller.abort(new Error("cancelled during stream"));
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after stream abort");
    }

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.partial).toBe(true);
    expect(result.messages).toEqual([
      {
        parts: [{ text: "partial", type: "text" }],
        role: "assistant",
      },
    ]);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "text.delta",
      "text.done",
      "message.done",
    ]);
  });

  test("closes the provider stream iterator when a pending stream read aborts", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const controller = new AbortController();
    let nextCalls = 0;
    let releasePendingRead: (() => void) | undefined;
    let returnCalls = 0;
    const stream = {
      [Symbol.asyncIterator](): AsyncIterator<ProviderStreamChunk> {
        return {
          async next() {
            nextCalls += 1;

            if (nextCalls === 1) {
              return {
                done: false,
                value: {
                  text: "partial",
                  type: "text_delta",
                },
              };
            }

            controller.abort(new Error("cancelled during stream"));
            await new Promise<void>((resolve) => {
              releasePendingRead = resolve;
            });

            return {
              done: true,
              value: undefined,
            };
          },
          async return() {
            returnCalls += 1;
            releasePendingRead?.();

            return {
              done: true,
              value: undefined,
            };
          },
        };
      },
    };
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      stream() {
        return stream;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after stream abort");
    }

    expect(returnCalls).toBe(1);
    expect(result.resolution.type).toBe("fail");
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "text.delta",
      "text.done",
      "message.done",
    ]);
  });

  test("returns a contract-valid partial tool-call message when stream aborts after a tool call", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const controller = new AbortController();
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
        };
        yield {
          input: { query: "runtime" },
          name: "search",
          providerCallId: "native-call-1",
          type: "tool_call_done",
        };
        controller.abort(new Error("cancelled during stream"));
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
      toolExecutionMode: "sequential",
    }).create();

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after stream abort");
    }

    expect(() => assertDriverExecutionResult(result)).not.toThrow();
    expect(result.partial).toBe(true);
    expect(result.toolExecutionMode).toBe("sequential");
    expect(result.resolution.type).toBe("fail");

    const message = result.messages?.[0];

    if (message?.role !== "assistant") {
      throw new Error("expected a partial assistant message");
    }

    const part = message.parts[0];

    if (part?.type !== "tool_call") {
      throw new Error("expected a partial tool call");
    }

    expect(part.input).toEqual({ query: "runtime" });
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "tool_call.start",
      "tool_call.args_delta",
      "tool_call.done",
      "message.done",
    ]);
    expect(
      emittedEvents.filter((event) => event.type === "tool_call.done")
    ).toHaveLength(1);
  });

  test("leaves incomplete tool-call streams open when cancellation arrives before args", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const controller = new AbortController();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const startChunk = {
          providerCallId: "native-call-1",
          name: "search",
          type: "tool_call_start",
        } satisfies ProviderStreamChunk;

        yield startChunk;
        controller.abort(new Error("cancelled during stream"));
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
      toolExecutionMode: "sequential",
    }).create();

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after stream abort");
    }

    expect(() => assertDriverExecutionResult(result)).not.toThrow();
    expect(result.partial).toBe(false);
    expect(result.messages).toBeUndefined();
    expect(result.resolution.type).toBe("fail");
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "tool_call.start",
    ]);
  });

  test("does not replay completed reasoning or structured done events during stream cancellation", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const controller = new AbortController();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "thinking",
          type: "reasoning_delta",
        };
        yield {
          type: "reasoning_done",
        };
        yield {
          data: { answer: "yes" },
          name: "answer",
          type: "structured_done",
        };
        controller.abort(new Error("cancelled during stream"));
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after stream abort");
    }

    expect(() => assertDriverExecutionResult(result)).not.toThrow();
    expect(result.partial).toBe(true);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "reasoning.delta",
      "reasoning.done",
      "structured.delta",
      "structured.done",
      "message.done",
    ]);
    expect(
      emittedEvents.filter((event) => event.type === "reasoning.done")
    ).toHaveLength(1);
    expect(
      emittedEvents.filter((event) => event.type === "structured.done")
    ).toHaveLength(1);
  });

  test("treats cancelled redacted reasoning streams as cancellation instead of provider failure", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const controller = new AbortController();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "",
          type: "reasoning_delta",
        };
        controller.abort(new Error("cancelled during stream"));
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await Promise.race([
      driver.execute(
        createDriverExecutionContext({
          config: {
            model: provider,
            name: "primary",
          },
          emittedEvents,
          signal: controller.signal,
        })
      ),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof result === "string") {
      throw new Error("driver did not stop waiting after stream abort");
    }

    expect(() => assertDriverExecutionResult(result)).not.toThrow();
    expect(result.partial).toBe(false);
    expect(result.messages).toBeUndefined();
    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected cancelled stream to fail");
    }

    expect(result.resolution.error.message).toBe("execution cancelled");
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "reasoning.done",
      "message.done",
    ]);
  });

  test("runtime-core cancellation stops a pending provider stream and checkpoints partial output", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "partial",
          type: "text_delta",
        };
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
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
      signal: textSignal("Cancel this stream"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const firstEvents = await collectUntil(
      iterator,
      (event) => event.type === "text.delta"
    );

    handle.cancel();
    const remainingEvents = await Promise.race([
      collectRemaining(iterator),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof remainingEvents === "string") {
      throw new Error("runtime did not stop waiting after cancellation");
    }

    const events = [...firstEvents, ...remainingEvents];
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("runtime_execution_cancelled");
    expect(
      events.some(
        (event) => event.type === "turn.end" && event.status === "failed"
      )
    ).toBe(true);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      partial: true,
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel this stream", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "partial", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("runtime-core cancellation after tool_call.start keeps the cancellation error", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const startChunk = {
          providerCallId: "native-call-1",
          name: "search",
          type: "tool_call_start",
        } satisfies ProviderStreamChunk;

        yield startChunk;
        await wait(1000);
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
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
      signal: textSignal("Cancel this tool call"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const firstEvents = await collectUntil(
      iterator,
      (event) => event.type === "tool_call.start"
    );

    handle.cancel();
    const remainingEvents = await Promise.race([
      collectRemaining(iterator),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof remainingEvents === "string") {
      throw new Error("runtime did not stop waiting after cancellation");
    }

    const events = [...firstEvents, ...remainingEvents];
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("runtime_execution_cancelled");
    expect(errorEvent?.error.message).toBe("execution cancelled");
    expect(events.some((event) => event.type === "message.done")).toBe(false);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel this tool call", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("runtime-core accepts final-only streamed structured output", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const structuredDone = {
          data: { answer: "ok" },
          name: "answer",
          type: "structured_done",
        } satisfies ProviderStreamChunk;
        const finish = {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;

        yield structuredDone;
        yield finish;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
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
      signal: textSignal("Return structured output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(events.map((event) => event.type)).toContain("structured.delta");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              data: { answer: "ok" },
              name: "answer",
              type: "structured",
            },
          ],
          role: "assistant",
        },
      ])
    );
  });

  test("runtime-core executes another iteration when ReAct loopPolicy requests continuation after plain assistant output", async () => {
    const harness = createFakeKernelHarness();
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [
            {
              text:
                generateCalls === 1
                  ? "Continue once more."
                  : "Now we can stop.",
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
        loopPolicy: {
          evaluate(response, _manifest, iterationCount) {
            return {
              continue:
                iterationCount === 1 &&
                response.parts.some(
                  (part) =>
                    part.type === "text" && part.text === "Continue once more."
                ),
              executeTools: false,
              reason: "done",
            };
          },
        },
        model: provider,
        name: "primary",
      },
      signal: textSignal("Follow the loop policy"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(generateCalls).toBe(2);
    expect(
      events.filter((event) => event.type === "iteration.start")
    ).toHaveLength(2);
    expect(handle.status().phase).toBe("completed");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Follow the loop policy", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Continue once more.", type: "text" }],
        role: "assistant",
      },
      {
        parts: [{ text: "Now we can stop.", type: "text" }],
        role: "assistant",
      },
    ]);
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

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_invalid_provider_stream");
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

  test("executes end to end through runtime-core with a generated response that preserves canonical metadata fields", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse: TuvrenModelResponse | undefined;
    const fileData = new Uint8Array([1, 2, 3]);
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
          finishReason: "length",
          parts: [
            {
              providerMetadata: {
                source: "openai-output-text",
              },
              text: "Generated answer",
              type: "text",
            },
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
              providerMetadata: {
                enforcement: "strict",
              },
              type: "structured",
            },
            {
              data: fileData,
              filename: "report.csv",
              mediaType: "text/csv",
              providerMetadata: {
                uploadId: "file-1",
              },
              type: "file",
            },
          ],
          providerMetadata: {
            encrypted_content: "enc-123",
            responseId: "resp-123",
          },
          usage: {
            inputTokens: 10,
            outputTokens: 7,
          },
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
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = context.response;
              return undefined;
            },
            name: "capture",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Return the full generated payload"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const messageDoneEvent = events.find(
      (event): event is Extract<TuvrenStreamEvent, { type: "message.done" }> =>
        event.type === "message.done"
    );

    expect(handle.status().phase).toBe("completed");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "message.start",
        "text.delta",
        "text.done",
        "reasoning.delta",
        "reasoning.done",
        "structured.delta",
        "structured.done",
        "file.done",
        "message.done",
      ])
    );
    expect(messageDoneEvent).toMatchObject({
      finishReason: "length",
      usage: {
        inputTokens: 10,
        outputTokens: 7,
      },
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              providerMetadata: {
                source: "openai-output-text",
              },
              text: "Generated answer",
              type: "text",
            },
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
              providerMetadata: {
                enforcement: "strict",
              },
              type: "structured",
            },
            {
              data: fileData,
              filename: "report.csv",
              mediaType: "text/csv",
              providerMetadata: {
                uploadId: "file-1",
              },
              type: "file",
            },
          ],
          providerMetadata: {
            encrypted_content: "enc-123",
            responseId: "resp-123",
          },
          role: "assistant",
        },
      ])
    );
    expect(capturedResponse).toEqual({
      finishReason: "length",
      parts: [
        {
          providerMetadata: {
            source: "openai-output-text",
          },
          text: "Generated answer",
          type: "text",
        },
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
          providerMetadata: {
            enforcement: "strict",
          },
          type: "structured",
        },
        {
          data: fileData,
          filename: "report.csv",
          mediaType: "text/csv",
          providerMetadata: {
            uploadId: "file-1",
          },
          type: "file",
        },
      ],
      providerMetadata: {
        encrypted_content: "enc-123",
        responseId: "resp-123",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 7,
      },
    });
  });

  test("executes end to end through runtime-core for generated tool calls with host-selected sequential mode", async () => {
    const harness = createFakeKernelHarness();
    let iteration = 0;
    const provider = {
      async generate() {
        if (iteration === 0) {
          iteration += 1;
          return {
            finishReason: "tool_call",
            parts: [
              {
                callId: "call-search",
                input: { query: "docs" },
                name: "search",
                providerMetadata: {
                  providerCallId: "provider-call-1",
                },
                type: "tool_call",
              },
            ],
            providerMetadata: {
              responseId: "resp-tool-1",
            },
            usage: {
              inputTokens: 8,
              outputTokens: 3,
            },
          } satisfies TuvrenModelResponse;
        }

        return {
          finishReason: "stop",
          parts: [{ text: "Tool run complete", type: "text" }],
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

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "tool_call.args_delta")).toBe(
      true
    );
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
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              callId: "call-search",
              input: { query: "docs" },
              name: "search",
              providerMetadata: {
                providerCallId: "provider-call-1",
              },
              type: "tool_call",
            },
          ],
          providerMetadata: {
            responseId: "resp-tool-1",
          },
          role: "assistant",
        },
        {
          parts: [{ text: "Tool run complete", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("does not publish generated assistant events before validation succeeds", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "plain text fallback", type: "text" }],
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
      signal: textSignal("Require structured output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "message.start")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "structured_output_validation"
      )
    ).toBe(true);
    expect(messages).toEqual([
      {
        parts: [{ text: "Require structured output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("streams assistant events through runtime-core before the provider finishes", async () => {
    const harness = createFakeKernelHarness();
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "live output",
          type: "text_delta",
        } as const;
        await streamGate;
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
      signal: textSignal("Stream live"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const streamedEvents = await collectUntil(
      iterator,
      (event) => event.type === "text.delta"
    );

    expect(streamedEvents.some((event) => event.type === "message.start")).toBe(
      true
    );
    expect(streamedEvents.some((event) => event.type === "text.delta")).toBe(
      true
    );
    expect(handle.status().phase).toBe("running");

    releaseStream?.();

    const remainingEvents = await collectRemaining(iterator);

    expect(
      [...streamedEvents, ...remainingEvents].some(
        (event) => event.type === "message.done"
      )
    ).toBe(true);
    expect(handle.status().phase).toBe("completed");
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

  test("executes end to end through runtime-core when aroundModel replaces the durable response after one next() call", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "provider",
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
            async aroundModel(_context, next) {
              const response = await next();
              return {
                ...response,
                parts: [{ text: "modified", type: "text" }],
              };
            },
            name: "rewriter",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Rewrite output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(
      events
        .filter(
          (
            event
          ): event is Extract<(typeof events)[number], { type: "text.done" }> =>
            event.type === "text.done"
        )
        .map((event) => event.text)
    ).toEqual(["provider"]);
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "modified", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("does not request final sequence divergence for metadata-only aroundModel changes", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const textDelta = {
          text: "provider",
          type: "text_delta",
        } satisfies ProviderStreamChunk;
        const finish = {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;

        yield textDelta;
        yield finish;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(_context, next) {
                const response = await next();

                return {
                  ...response,
                  providerMetadata: {
                    cache: "hit",
                  },
                } satisfies TuvrenModelResponse;
              },
              name: "metadata",
            },
          ],
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(result.assistantEventReconciliation).toBeUndefined();
    expect(result.messages).toEqual([
      {
        parts: [{ text: "provider", type: "text" }],
        providerMetadata: {
          cache: "hit",
        },
        role: "assistant",
      },
    ]);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "text.delta",
      "text.done",
      "message.done",
    ]);
  });

  test("executes end to end when aroundModel only changes response metadata after streamed next", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const textDelta = {
          text: "provider",
          type: "text_delta",
        } satisfies ProviderStreamChunk;
        const finish = {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;

        yield textDelta;
        yield finish;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
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
            async aroundModel(_context, next) {
              const response = await next();

              return {
                ...response,
                providerMetadata: {
                  cache: "hit",
                },
              } satisfies TuvrenModelResponse;
            },
            name: "metadata",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Annotate output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "provider", type: "text" }],
          providerMetadata: {
            cache: "hit",
          },
          role: "assistant",
        },
      ])
    );
  });

  test("fails end to end through runtime-core when aroundModel retry returns a stale streamed response", async () => {
    const harness = createFakeKernelHarness();
    let streamCalls = 0;
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        streamCalls += 1;
        yield {
          text: streamCalls === 1 ? "first attempt" : "second attempt",
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
            async aroundModel(context, next) {
              const firstResponse = await next(context);
              await next(context);
              return firstResponse;
            },
            name: "retry",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Trigger stale retry response"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(streamCalls).toBe(2);
    expect(handle.status().phase).toBe("failed");
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "react_driver_invalid_around_model_retry"
      )
    ).toBe(true);
    expect(
      events
        .filter(
          (
            event
          ): event is Extract<(typeof events)[number], { type: "text.done" }> =>
            event.type === "text.done"
        )
        .map((event) => event.text)
    ).toEqual(["first attempt", "second attempt"]);
    expect(messages).toEqual([
      {
        parts: [{ text: "Trigger stale retry response", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("persists aroundModel state updates through the runtime-core checkpoint path", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "Stateful response", type: "text" }],
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
            async aroundModel(_context, next) {
              const response = await next();
              return {
                response,
                state: {
                  remainingBudget: 7,
                },
              };
            },
            name: "budget",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Track budget"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(handle.status().phase).toBe("completed");
    expect(manifest.extensions).toEqual({
      budget: {
        remainingBudget: 7,
      },
    });
  });

  test("persists only the final retry state updates through the runtime-core checkpoint path", async () => {
    const harness = createFakeKernelHarness();
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: `attempt-${generateCalls}`, type: "text" }],
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
            async aroundModel(context, next) {
              await next(context);
              return await next(context);
            },
            name: "retry",
          },
          {
            async aroundModel(context, next) {
              const response = await next(context);
              return {
                response,
                state:
                  generateCalls === 1
                    ? { discardedAttempt: true, retainedAttempt: false }
                    : { retainedAttempt: true },
              };
            },
            name: "budget",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Track retry state"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(handle.status().phase).toBe("completed");
    expect(manifest.extensions).toEqual({
      budget: {
        retainedAttempt: true,
      },
    });
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

  test("executes end to end through runtime-core for streamed tool calls without provider args deltas", async () => {
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

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "tool_call.args_delta")).toBe(
      true
    );
    expect(
      events.some(
        (event) => event.type === "tool.result" && event.name === "search"
      )
    ).toBe(true);
  });

  test("surfaces provider stream failures through runtime-core without invalid assistant stream errors", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "partial output",
          type: "text_delta",
        } as const;
        yield {
          error: new Error("provider transport failed"),
          type: "error",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
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
      signal: textSignal("Trigger provider failure"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("failed");
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "react_driver_provider_failure"
      )
    ).toBe(true);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "error" && event.error.code === "invalid_stream_event"
      )
    ).toBe(false);
    expect(messages).toEqual([
      {
        parts: [{ text: "Trigger provider failure", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("projects provider-backed streamed completions through tee fanout adapters", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "Provider-backed streamed completion.",
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
      signal: textSignal("Complete through provider stream"),
      threadId: thread.threadId,
    });
    const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
      handle.events(),
      3
    );
    const [canonicalEvents, sseFrames, aguiEvents] = await Promise.all([
      collectEvents(canonicalBranch),
      collectEvents(toSseFrames(sseBranch)),
      collectEvents(toAgUiEvents(aguiBranch)),
    ]);

    expect(handle.status().phase).toBe("completed");
    expect(canonicalEvents.some((event) => event.type === "text.delta")).toBe(
      true
    );
    expect(sseFrames.some((frame) => frame.event === "text.delta")).toBe(true);
    expect(
      aguiEvents.some((event) => event.type === "TEXT_MESSAGE_START")
    ).toBe(true);
    expect(
      aguiEvents.some((event) => event.type === "TEXT_MESSAGE_CONTENT")
    ).toBe(true);
    expect(aguiEvents.some((event) => event.type === "TEXT_MESSAGE_END")).toBe(
      true
    );
    expect(aguiEvents.some((event) => event.type === "RUN_FINISHED")).toBe(
      true
    );
  });

  test("flushes provider-backed failed text streams before adapter RUN_ERROR", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "Partial provider output",
          type: "text_delta",
        } as const;
        yield {
          error: new Error("provider transport failed"),
          type: "error",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
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
      signal: textSignal("Fail through provider stream"),
      threadId: thread.threadId,
    });
    const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
      handle.events(),
      3
    );
    const [canonicalEvents, sseFrames, aguiEvents] = await Promise.all([
      collectEvents(canonicalBranch),
      collectEvents(toSseFrames(sseBranch)),
      collectEvents(toAgUiEvents(aguiBranch)),
    ]);
    const textEndIndex = aguiEvents.findIndex(
      (event) => event.type === "TEXT_MESSAGE_END"
    );
    const runErrorIndex = aguiEvents.findIndex(
      (event) => event.type === "RUN_ERROR"
    );

    expect(handle.status().phase).toBe("failed");
    expect(
      canonicalEvents.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "react_driver_provider_failure"
      )
    ).toBe(true);
    expect(sseFrames.some((frame) => frame.event === "error")).toBe(true);
    expect(textEndIndex).toBeGreaterThanOrEqual(0);
    expect(runErrorIndex).toBeGreaterThan(textEndIndex);
  });
});

function createDriverExecutionContext(input?: {
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

async function collectRemaining<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const collected: T[] = [];

  while (true) {
    const result = await iterator.next();

    if (result.done) {
      return collected;
    }

    collected.push(result.value);
  }
}

async function collectUntil<T>(
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

async function waitFor(predicate: () => boolean): Promise<void> {
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
