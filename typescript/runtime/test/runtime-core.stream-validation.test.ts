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

// biome-ignore-all lint/suspicious/useAwait: Test drivers intentionally match the async framework driver contract.
import { describe, expect, test } from "bun:test";
import type {
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
  RuntimeDriverFactory as KrakenDriverFactory,
} from "@tuvren/core/driver";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantStructured,
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects text assistant streams that omit text.delta", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-text-without-delta",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-text-without-delta",
          text: "missing delta",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-text-without-delta",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("missing delta")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject missing text delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
  });

  test("rejects structured assistant streams that omit structured.delta", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-structured-without-delta",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          data: { answer: "ok" },
          messageId: "assistant-structured-without-delta",
          name: "result",
          timestamp: context.runtime.now(),
          type: "structured.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-structured-without-delta",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantStructured("result", { answer: "ok" })],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject missing structured delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
  });

  test("rejects tool-call stream previews that do not match the durable tool call", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-call",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-call",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "streamed-wrong" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-call",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject mismatched tool preview"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched tool preview", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects tool-call assistant streams that omit tool_call.args_delta", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-call-without-delta",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-call-without-delta",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "persisted-right" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-call-without-delta",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject missing tool-call args delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
  });

  test("rejects incomplete assistant event sequences", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-incomplete",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-incomplete",
          text: "missing message.done",
          timestamp: context.runtime.now(),
          type: "text.done",
        });

        return {
          messages: [assistantText("missing message.done")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject incomplete assistant events"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(events.some((event) => event.type === "message.done")).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject incomplete assistant events", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant stream events whose message ids do not reconcile", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-a",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-b",
          text: "split identity",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-b",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("split identity")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject split assistant identity"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject split assistant identity", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant delta events that arrive before message.start", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          delta: "out-of-order",
          messageId: "assistant-out-of-order",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-out-of-order",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-out-of-order",
          text: "out-of-order",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-out-of-order",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("out-of-order")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject out-of-order assistant delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "text.delta" && event.delta === "out-of-order"
      )
    ).toBe(true);
  });

  test("rejects tool-call args deltas that do not reconcile to the durable tool input", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-args",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-args",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          delta: '{"value":"WRONG"}',
          timestamp: context.runtime.now(),
          type: "tool_call.args_delta",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "persisted-right" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-args",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject mismatched args delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(events.some((event) => event.type === "tool_call.args_delta")).toBe(
      true
    );
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched args delta", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects tool-call args deltas whose call ids do not match the current tool call", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-call-id",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-call-id",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-other",
          delta: '{"value":"persisted-right"}',
          timestamp: context.runtime.now(),
          type: "tool_call.args_delta",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "persisted-right" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-call-id",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject mismatched args delta call id"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
  });

  test("rejects assistant message.done events whose finishReason disagrees with durable output", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-finish-reason",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-finish-reason",
          text: "wrong finish reason",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-finish-reason",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("wrong finish reason")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject mismatched finish reason"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched finish reason", type: "text" }],
        role: "user",
      },
    ]);
  });
});

function createDriverRegistry(
  drivers: Array<KrakenDriver | KrakenDriverFactory> = []
) {
  return createBaseDriverRegistry(drivers.map(wrapDriverEntry));
}

function wrapDriverEntry(
  entry: KrakenDriver | KrakenDriverFactory
): KrakenDriver | KrakenDriverFactory {
  if (isKrakenDriverFactory(entry)) {
    return {
      create() {
        return wrapDriver(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapDriver(entry);
}

function isKrakenDriverFactory(
  entry: KrakenDriver | KrakenDriverFactory
): entry is KrakenDriverFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapDriver(driver: KrakenDriver): KrakenDriver {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeDriverResult(await driver.execute(context));
    },
    id: driver.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeDriverResult(await resume(context));
          },
        }),
  };
}

function normalizeDriverResult(
  result: DriverExecutionResult
): DriverExecutionResult {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
}

function requestsToolExecution(result: DriverExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
