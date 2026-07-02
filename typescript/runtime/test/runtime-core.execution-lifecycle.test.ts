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
  assistantText,
  collectEvents,
  delay,
  readBranchCheckpointEventTypes,
  readBranchContextManifest,
  textSignal,
  waitFor,
  waitForAbort,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("executes a driver-neutral turn and persists the input plus assistant output", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Hello from Kraken.",
          messageId: "assistant-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-1",
          text: "Hello from Kraken.",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-1",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("Hello from Kraken.")],
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
      signal: textSignal("Hello Kraken"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const checkpointEventTypes = await readBranchCheckpointEventTypes(
      harness.kernel,
      thread.branchId
    );

    expect(events.map((event) => event.type)).toContain("turn.start");
    expect(events.map((event) => event.type)).toContain("iteration.start");
    expect(events.map((event) => event.type)).toContain("turn.end");
    expect(handle.status().phase).toBe("completed");
    expect(handle.status().manifest).toEqual(
      await readBranchContextManifest(harness.kernel, thread.branchId)
    );
    expect(messages).toHaveLength(2);
    expect(checkpointEventTypes).toEqual(
      expect.arrayContaining([
        "input_received",
        "iteration_step_completed",
        "turn_status_finalized",
      ])
    );
  });

  test("synthesizes assistant content events when a driver returns durable output without streaming it", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantText("Visible without explicit runtime.emit.")],
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
      signal: textSignal("Show durable output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messageStartIndex = events.findIndex(
      (event) => event.type === "message.start"
    );
    const textDeltaIndex = events.findIndex(
      (event) =>
        event.type === "text.delta" &&
        event.delta === "Visible without explicit runtime.emit."
    );
    const textDoneIndex = events.findIndex(
      (event) =>
        event.type === "text.done" &&
        event.text === "Visible without explicit runtime.emit."
    );
    const messageDoneIndex = events.findIndex(
      (event) => event.type === "message.done"
    );

    expect(
      events.some(
        (event) =>
          event.type === "text.delta" &&
          event.delta === "Visible without explicit runtime.emit."
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "text.done" &&
          event.text === "Visible without explicit runtime.emit."
      )
    ).toBe(true);
    expect(events.some((event) => event.type === "message.done")).toBe(true);
    expect(messageStartIndex).toBeLessThan(textDeltaIndex);
    expect(textDeltaIndex).toBeLessThan(textDoneIndex);
    expect(textDoneIndex).toBeLessThan(messageDoneIndex);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Show durable output", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            text: "Visible without explicit runtime.emit.",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("does not start execution until the event stream is consumed", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const driver = {
      async execute(_context) {
        executeCalls += 1;
        return {
          messages: [assistantText("Started on demand.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Wait to start"),
      threadId: thread.threadId,
    });
    const events = handle.events();

    await delay(25);

    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);

    await collectEvents(events);

    expect(executeCalls).toBe(1);
    expect(handle.status().phase).toBe("completed");
  });

  test("cancels running execution when the last event subscriber stops consuming", async () => {
    const harness = createFakeKernelHarness();
    let driverStarted = false;
    let observedAbort = false;
    const driver = {
      async execute(context) {
        driverStarted = true;
        await waitForAbort(context.signal);
        observedAbort = context.signal?.aborted === true;
        return {
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Cancel on stream close"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const firstEvent = await iterator.next();

    expect(firstEvent.done).toBe(false);
    expect(firstEvent.value?.type).toBe("turn.start");

    await waitFor(() => driverStarted);
    await iterator.return?.();
    await waitFor(() => handle.status().phase === "failed");

    expect(observedAbort).toBe(true);
    expect(handle.status().phase).toBe("failed");
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
