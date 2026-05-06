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
import type {
  TuvrenExtension,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenProvider,
} from "@tuvren/runtime-api";
import { createReActDriver } from "../src/index.ts";
import {
  createDriverExecutionContext,
  createSearchTool,
  wait,
} from "./react-driver-test-helpers.ts";

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
});
