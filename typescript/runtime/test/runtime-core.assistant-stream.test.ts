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
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects assistant stream events when the driver does not return a durable assistant message", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-ghost",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-ghost",
          text: "ghost output",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-ghost",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
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
      signal: textSignal("Reject ghost assistant output"),
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
        (event) => event.type === "text.done" && event.text === "ghost output"
      )
    ).toBe(true);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject ghost assistant output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant stream events without a durable assistant message on soft driver failures", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(context) {
        driverCalls += 1;

        if (driverCalls === 1) {
          context.runtime.emit({
            messageId: "assistant-soft-fail",
            role: "assistant",
            timestamp: context.runtime.now(),
            type: "message.start",
          });
          context.runtime.emit({
            delta: "partial",
            messageId: "assistant-soft-fail",
            timestamp: context.runtime.now(),
            type: "text.delta",
          });

          return {
            resolution: {
              error: new Error("soft retry"),
              fatality: "soft",
              type: "fail",
            },
          };
        }

        return {
          messages: [assistantText("second iteration should not run")],
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
      signal: textSignal("Reject soft-fail assistant leak"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(driverCalls).toBe(1);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "text.delta" && event.delta === "partial"
      )
    ).toBe(true);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject soft-fail assistant leak", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant stream events that do not match the durable assistant message", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "streamed-wrong",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("persisted-right")],
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
      signal: textSignal("Reject mismatched assistant stream"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(events.map((event) => event.type)).toContain("iteration.end");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched assistant stream", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("does not allow durable/live assistant divergence from a no-op aroundModel alone", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "live",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "live",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("durable mismatch")],
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
      config: {
        extensions: [
          {
            async aroundModel(_context, next) {
              return await next();
            },
            name: "noop-around",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Reject inferred aroundModel divergence"),
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
        parts: [
          { text: "Reject inferred aroundModel divergence", type: "text" },
        ],
        role: "user",
      },
    ]);
  });

  test("does not allow assistantEventReconciliation divergence without active aroundModel extensions", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "live",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "live",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable mismatch")],
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
      config: {
        name: "primary",
      },
      signal: textSignal("Reject reconciliation escape hatch"),
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
        parts: [{ text: "Reject reconciliation escape hatch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("does not allow assistantEventReconciliation without emitted assistant events", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable only")],
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
      config: {
        extensions: [
          {
            async aroundModel(_context, next) {
              return await next();
            },
            name: "noop-around",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Reject unused reconciliation flag"),
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
        parts: [{ text: "Reject unused reconciliation flag", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("passes a coherent durable response into afterIteration when final assistant divergence is allowed", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse:
      | {
          finishReason: string;
          parts: TuvrenModelResponse["parts"];
          usage: TuvrenModelResponse["usage"];
        }
      | undefined;
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "live",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "live",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "length",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
          usage: {
            inputTokens: 3,
            outputTokens: 5,
          },
        });

        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable replacement")],
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
      config: {
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = {
                finishReason: context.response.finishReason,
                parts: context.response.parts,
                usage: context.response.usage,
              };
              return undefined;
            },
            async aroundModel(_context, next) {
              return await next();
            },
            name: "capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture durable divergence response"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(capturedResponse).toEqual({
      finishReason: "stop",
      parts: [{ text: "durable replacement", type: "text" }],
      usage: {
        inputTokens: 3,
        outputTokens: 5,
      },
    });
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
