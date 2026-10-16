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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";

import { createContextManifest as createRuntimeContextManifest } from "../../../runtime/src/lib/context-manifest.ts";
import { createReActRunner } from "../src/index.ts";
import {
  createRunnerExecutionContext,
  createSearchTool,
  toRecord,
} from "./react-runner-test-helpers.ts";

describe("runner-react aroundModel", () => {
  test("lets aroundModel short-circuit without touching the provider", async () => {
    let providerCalls = 0;
    const provider = {
      async generate() {
        await Promise.resolve();
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
        await Promise.resolve();
        return {
          finishReason: "stop",
          parts: [{ text: "short-circuit", type: "text" }],
        };
      },
      name: "cache",
    };
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();
    const emittedEvents: TuvrenStreamEvent[] = [];

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, proceed) {
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
                return await proceed();
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
    expect(
      capturedMessages.some(
        (message) =>
          message.role === "system" && message.content === "Injected guidance"
      )
    ).toBe(true);
    expect(capturedToolsLength).toBe(0);
  });

  test("does not let aroundModel next() mutate manifest snapshots or shared exports seen by inner handlers", async () => {
    let observedManifestSource: Record<string, unknown> | undefined;
    let observedSharedExport: unknown;
    const provider = {
      async generate() {
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              exports: ["exported"],
              name: "source",
            },
            {
              async aroundModel(context, proceed) {
                context.manifest.extensions.source = {
                  exported: "mutated-manifest",
                };
                context.sharedExports.source.exported = "mutated-shared";
                return await proceed(context);
              },
              name: "outer",
            },
            {
              async aroundModel(context, proceed) {
                observedManifestSource = toRecord(
                  context.manifest.extensions.source
                );
                observedSharedExport = context.sharedExports.source?.exported;
                return await proceed(context);
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, proceed) {
                context.prompt.responseFormat = undefined;
                return await proceed();
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, proceed) {
                const response = await proceed();
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "stream",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(_context, proceed) {
                const response = await proceed();
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(_context, proceed) {
                await proceed();
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
      name: "react_runner.around_model_error",
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
        await Promise.resolve();
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
      async aroundModel(context, proceed) {
        await proceed(context);
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
        return await proceed(retryContext);
      },
      name: "retry",
    };
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
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
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, proceed) {
                const firstResponse = await proceed(context);
                await proceed(context);
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
    ).toBe("react_runner_invalid_around_model_retry");
  });

  test("fails hard when aroundModel retry returns a stale streamed response instead of the final next() result", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    let streamCalls = 0;
    const provider = {
      async generate() {
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "stream",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, proceed) {
                const firstResponse = await proceed(context);
                await proceed(context);
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
    ).toBe("react_runner_invalid_around_model_retry");
  });

  test("keeps only the final retry state updates from nested aroundModel executions", async () => {
    let generateCalls = 0;
    const provider = {
      async generate() {
        await Promise.resolve();
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
    const runner = createReActRunner({
      providerCallMode: "generate",
    }).create();

    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(context, proceed) {
                await proceed(context);
                return await proceed(context);
              },
              name: "retry",
            },
            {
              async aroundModel(context, proceed) {
                const response = await proceed(context);
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
});
