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

// biome-ignore-all lint/suspicious/useAwait: Mock async runtime/provider interfaces intentionally preserve promise-based signatures in these integration tests.

import { describe, expect, test } from "bun:test";
import { TuvrenProviderError } from "@tuvren/core";
import { assertDriverExecutionResult } from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ProviderStreamChunk,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createReActDriver } from "../src/index.ts";
import {
  createDriverExecutionContext,
  wait,
} from "./react-driver-test-helpers.ts";

describe("driver-react streamed failure handling", () => {
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
});
