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

import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenProvider,
} from "@tuvren/core/provider";

import { createReActRunner } from "../src/index.ts";
import {
  createRunnerExecutionContext,
  createSearchTool,
  wait,
} from "./react-runner-test-helpers.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

describe("runner-react", () => {
  test("renders host and extension system prompts plus tools into the provider prompt", async () => {
    let capturedMessages: TuvrenMessage[] = [];
    let capturedToolsLength = 0;
    const provider = {
      async generate(prompt) {
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: () => "generate",
      toolExecutionMode: () => "sequential",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runnerOptions = { providerCallMode: "generate" as const };
    Reflect.set(runnerOptions, "providerCallMode", () => "bogus");
    const runner = createReActRunner(runnerOptions).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
      code: "react_runner_invalid_provider_call_mode",
    });
  });

  test("fails hard when toolExecutionMode resolves to an invalid value", async () => {
    let generateCalls = 0;
    const provider = {
      async generate() {
        await Promise.resolve();
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
    const runnerOptions = {
      providerCallMode: "generate",
      toolExecutionMode: "parallel",
    } as const;
    Reflect.set(runnerOptions, "toolExecutionMode", () => "bogus");
    const runner = createReActRunner(runnerOptions).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
      code: "react_runner_invalid_tool_execution_mode",
    });
  });

  test("fails hard when loopPolicy returns a malformed IterationDecision", async () => {
    const provider = {
      async generate() {
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const loopPolicy = {
      evaluate() {
        return { continue: false, executeTools: false };
      },
    };
    Reflect.set(loopPolicy, "evaluate", () => ({
      continue: "yes",
      executeTools: false,
    }));

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          loopPolicy,
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const loopPolicy = {
      evaluate() {
        return { continue: false, executeTools: false };
      },
    };
    Reflect.set(loopPolicy, "evaluate", () => null);

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          loopPolicy,
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
    const provider: TuvrenProvider = {
      async generate() {
        await Promise.resolve();
        return {
          finishReason: "stop",
          parts: [{ text: "valid placeholder", type: "text" }],
        };
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    };
    Reflect.set(provider, "generate", async () => {
      await Promise.resolve();
      return { finishReason: "stop" };
    });
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
    const provider: TuvrenProvider = {
      async generate() {
        await Promise.resolve();
        return {
          finishReason: "stop",
          parts: [{ text: "valid placeholder", type: "text" }],
        };
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    };
    Reflect.set(provider, "generate", async () => {
      await Promise.resolve();
      return {
        finishReason: "stop",
        uncloneable: () => "invalid",
      };
    });
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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

  test("does not call generate when the runner signal is already aborted", async () => {
    const controller = new AbortController();
    let generateCalls = 0;
    const provider = {
      async generate() {
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();
    controller.abort(new Error("cancelled before provider call"));

    const result = await runner.execute(
      createRunnerExecutionContext({
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
      code: "react_runner_execution_cancelled",
    });
  });

  test("stops waiting for generate when the runner signal aborts during the provider call", async () => {
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await Promise.race([
      runner.execute(
        createRunnerExecutionContext({
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
      throw new TypeError("runner did not stop waiting after abort");
    }

    expect(result.resolution.type).toBe("fail");
    if (result.resolution.type !== "fail") {
      throw new Error("expected a failed resolution");
    }
    expect(result.resolution.fatality).toBe("hard");
    expect(result.resolution.error).toMatchObject({
      code: "react_runner_execution_cancelled",
    });
  });

  // ---------------------------------------------------------------------------
  // Provider-native / provider-mediated stream path (AY002/AY004)
  // ---------------------------------------------------------------------------

  test("stream path: provider_tool_result chunk produces pre-staged tool message without local execution", async () => {
    const runnerFactory = createReActRunner();
    const runner = runnerFactory.create();
    const chunks: ProviderStreamChunk[] = [
      {
        name: "code_execution",
        providerCallId: "native-stream-call-1",
        providerMetadata: {
          executionClass: "provider-native",
          owner: "provider",
        },
        result: { output: "hello world" },
        type: "provider_tool_result",
      },
      {
        finishReason: "stop",
        type: "finish",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ];

    const provider: TuvrenProvider = {
      generate() {
        throw new Error("should not call generate in stream mode");
      },
      id: "mock",
      async *stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    const config = {
      model: provider,
      name: "test-agent",
      providerNativeTools: [
        { id: "anthropic.code_execution_20260120", name: "code_execution" },
      ],
    };

    const context = createRunnerExecutionContext({ config });
    const result = await runner.execute(context);

    // Pure stream: no model text output, only the provider_tool_result chunk.
    // The runner returns just the pre-staged tool message (no preceding assistant
    // content to assemble). The framework can continue from this state.
    expect(result.messages).toHaveLength(1);
    const toolMessage = result.messages?.[0];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") {
      throw new TypeError("expected a tool message");
    }
    const [toolResultPart] = toolMessage.parts;
    expect(toolResultPart?.name).toBe("code_execution");
    expect(toolResultPart?.type).toBe("tool_result");
    if (toolResultPart?.type !== "tool_result") {
      throw new TypeError("expected a tool result part");
    }
    const nativeMeta = toolResultPart.providerMetadata;
    expect(isRecord(nativeMeta) ? nativeMeta.owner : undefined).toBe(
      "provider"
    );
    expect(isRecord(nativeMeta) ? nativeMeta.executionClass : undefined).toBe(
      "provider-native"
    );

    // Resolution should be end_turn (no regular tool calls dispatched)
    expect(result.resolution.type).toBe("end_turn");
  });

  test("stream path: provider-mediated provider_tool_result chunk preserves executionClass in pre-staged result", async () => {
    const runnerFactory = createReActRunner();
    const runner = runnerFactory.create();
    const chunks: ProviderStreamChunk[] = [
      {
        name: "mcp_tool",
        providerCallId: "mediated-stream-call-1",
        providerMetadata: {
          executionClass: "provider-mediated",
          owner: "provider",
        },
        result: { items: ["a", "b"] },
        type: "provider_tool_result",
      },
      {
        finishReason: "stop",
        type: "finish",
        usage: { inputTokens: 3, outputTokens: 1 },
      },
    ];

    const provider: TuvrenProvider = {
      generate() {
        throw new Error("should not call generate");
      },
      id: "mock",
      async *stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    const config = {
      model: provider,
      name: "test-agent",
      providerMediatedTools: [
        {
          endpoint: "https://example.com/mcp",
          mediationType: "mcp" as const,
          name: "mcp_tool",
        },
      ],
    };

    const context = createRunnerExecutionContext({ config });
    const result = await runner.execute(context);

    expect(result.messages).toHaveLength(1);
    const toolMessage = result.messages?.[0];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") {
      throw new TypeError("expected a tool message");
    }
    const [toolResultPart] = toolMessage.parts;
    expect(toolResultPart?.name).toBe("mcp_tool");
    if (toolResultPart?.type !== "tool_result") {
      throw new TypeError("expected a tool result part");
    }
    // Canonical attribution fields must survive end-to-end
    const meta = toolResultPart.providerMetadata;
    expect(isRecord(meta) ? meta.owner : undefined).toBe("provider");
    expect(isRecord(meta) ? meta.executionClass : undefined).toBe(
      "provider-mediated"
    );
    expect(result.resolution.type).toBe("end_turn");
  });
});
