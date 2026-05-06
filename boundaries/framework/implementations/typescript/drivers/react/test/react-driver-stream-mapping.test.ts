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

// biome-ignore-all lint/suspicious/useAwait: Mock async runtime/provider interfaces intentionally preserve promise-based signatures in these stream-mapping tests.

import { describe, expect, test } from "bun:test";
import type {
  ProviderStreamChunk,
  TuvrenProvider,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { createReActDriver } from "../src/index.ts";
import {
  createDriverExecutionContext,
  waitFor,
} from "./react-driver-test-helpers.ts";

describe("driver-react streamed mapping", () => {
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
          providerMetadata: {
            google: {
              thoughtSignature: "tool-thought-1",
            },
          },
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
      google: {
        thoughtSignature: "tool-thought-1",
      },
      providerCallId: "native-call-1",
    });
    expect(
      emittedEvents.find(
        (
          event
        ): event is Extract<TuvrenStreamEvent, { type: "tool_call.done" }> =>
          event.type === "tool_call.done"
      )
    ).toMatchObject({
      providerMetadata: {
        google: {
          thoughtSignature: "tool-thought-1",
        },
      },
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
});
