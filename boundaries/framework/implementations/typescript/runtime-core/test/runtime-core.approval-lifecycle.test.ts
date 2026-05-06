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
} from "@tuvren/driver-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntimeCore,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  startEventCapture,
  textSignal,
  waitFor,
  waitForAbort,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("persists paused runtime status with the framework-owned active agent", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-email",
                input: { subject: "Pause", to: "ops@example.com" },
                name: "email",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
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
            approval: true,
            description: "Pause with approval",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause with framework agent"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("paused");
    expect(handle.status().activeAgent).toBe("primary");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      pauseReason: "approval_required",
      state: "paused",
    });
  });

  test("finalizes failed runtime status when afterIteration upgrades an approval pause to hard fail", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-email",
                input: { subject: "Pause", to: "ops@example.com" },
                name: "email",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
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
              if (context.resolution.type !== "pause") {
                return undefined;
              }

              return {
                error: new Error("afterIteration rejected the approval pause"),
                verdict: "hardFail",
              };
            },
            name: "pause-hard-fail",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Pause with approval",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause then fail"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const turnEndEvent = events.findLast(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "turn.end" }> =>
        event.type === "turn.end"
    );

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(errorEvent?.error.message).toBe(
      "afterIteration rejected the approval pause"
    );
    expect(turnEndEvent?.status).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("keeps live handle activeAgent framework-owned while a turn is still running", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    let releaseSecondIteration: (() => void) | undefined;
    const secondIterationGate = new Promise<void>((resolve) => {
      releaseSecondIteration = resolve;
    });
    const driver = {
      async execute(_context) {
        executeCount += 1;

        if (executeCount === 1) {
          return {
            messages: [assistantText("First pass complete.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        await secondIterationGate;
        return {
          messages: [assistantText("Second pass complete.")],
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Keep the turn running"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await waitFor(() => {
      const status = handle.status();
      return status.phase === "running" && status.manifest?.messageCount === 2;
    });

    expect(handle.status().activeAgent).toBe("primary");

    if (releaseSecondIteration === undefined) {
      throw new Error("second iteration gate was not initialized");
    }

    releaseSecondIteration();
    await capture.done;

    expect(handle.status().phase).toBe("completed");
  });

  test("ends the loop at maxIterations and finalizes completed runtime status", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute() {
        executeCount += 1;
        return {
          messages: [assistantText(`Iteration ${executeCount} complete.`)],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        maxIterations: 2,
        name: "primary",
      },
      signal: textSignal("Stop at the loop limit"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const turnEndEvent = events.find(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "turn.end" }> =>
        event.type === "turn.end"
    );

    expect(executeCount).toBe(2);
    expect(
      events.filter((event) => event.type === "iteration.start").length
    ).toBe(2);
    expect(
      events.filter((event) => event.type === "iteration.end").length
    ).toBe(2);
    expect(turnEndEvent?.status).toBe("completed");
    expect(handle.status().phase).toBe("completed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "completed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Stop at the loop limit", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Iteration 1 complete.", type: "text" }],
        role: "assistant",
      },
      {
        parts: [{ text: "Iteration 2 complete.", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("stops the iteration loop after cancellation without entering another pass", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute(context) {
        executeCount += 1;

        if (executeCount === 1) {
          return {
            messages: [assistantText("First pass complete.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        await waitForAbort(context.signal);
        return {
          messages: [assistantText("Interrupted second pass.")],
          partial: true,
          resolution: {
            error: new Error("driver noticed cancellation"),
            fatality: "hard",
            type: "fail",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Cancel during the second pass"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await waitFor(() => handle.status().phase === "running");
    await waitFor(() => handle.status().iterationCount === 2);

    handle.cancel();
    await capture.done;

    const errorEvent = capture.events.find(
      (
        event
      ): event is Extract<(typeof capture.events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(executeCount).toBe(2);
    expect(handle.status().phase).toBe("failed");
    expect(
      capture.events.filter((event) => event.type === "iteration.start").length
    ).toBe(2);
    expect(
      capture.events.filter((event) => event.type === "iteration.end").length
    ).toBe(2);
    expect(errorEvent?.error.code).toBe("runtime_execution_cancelled");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      partial: true,
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel during the second pass", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "First pass complete.", type: "text" }],
        role: "assistant",
      },
      {
        parts: [{ text: "Interrupted second pass.", type: "text" }],
        role: "assistant",
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
