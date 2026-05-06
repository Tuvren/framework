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
  collectEvents,
  delay,
  extractLastMessageHash,
  hasAssistantText,
  readBranchContextManifest,
  textSignal,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects malformed steering signals before they can be incorporated", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const steeringMessage = context.messages.find(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Injected steering"
            )
        );

        if (steeringMessage !== undefined) {
          return {
            messages: [assistantText("Saw valid steering.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          messages: [assistantText("Waiting for steering.")],
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
      config: { name: "primary" },
      signal: textSignal("Start steering validation"),
      threadId: thread.threadId,
    });
    const eventsPromise = collectEvents(handle.events());

    await waitForAsync(async () =>
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Waiting for steering."
      )
    );
    expect(() => handle.steer(JSON.parse('{"parts":[123]}'))).toThrow(
      "steering signal must be a valid TuvrenMessage"
    );
    handle.steer(textSignal("Injected steering"));
    await eventsPromise;
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(manifest.turnBoundaries).toEqual([0]);
    expect(messages[0]).toEqual({
      parts: [{ text: "Start steering validation", type: "text" }],
      role: "user",
    });
    expect(hasAssistantText(messages, "Waiting for steering.")).toBe(true);
    expect(
      messages.some((message) => {
        if (
          message === null ||
          typeof message !== "object" ||
          !("role" in message) ||
          message.role !== "user" ||
          !("parts" in message) ||
          !Array.isArray(message.parts)
        ) {
          return false;
        }

        return message.parts.some(
          (part) =>
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            part.text === "Injected steering"
        );
      })
    ).toBe(true);
    expect(hasAssistantText(messages, "Saw valid steering.")).toBe(true);
    expect(
      messages.some((message) => {
        if (
          message === null ||
          typeof message !== "object" ||
          !("role" in message) ||
          !("parts" in message) ||
          !Array.isArray(message.parts)
        ) {
          return false;
        }

        return message.parts.some((part) => typeof part === "number");
      })
    ).toBe(false);
  });

  test("emits steering.incorporated with the steering message hash", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const steeringMessage = context.messages.find(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Injected steering"
            )
        );

        if (steeringMessage !== undefined) {
          return {
            messages: [],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          messages: [assistantText("Waiting for steering.")],
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
      config: { name: "primary" },
      signal: textSignal("Start steering test"),
      threadId: thread.threadId,
    });

    const eventsPromise = collectEvents(handle.events());

    await waitForAsync(async () =>
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Waiting for steering."
      )
    );
    handle.steer(textSignal("Injected steering"));
    const events = await eventsPromise;
    const manifest = await harness.readBranchManifest(thread.branchId);
    const steeringEvent = events.find(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { type: "steering.incorporated" }
      > => event.type === "steering.incorporated"
    );

    expect(steeringEvent?.messageId).toBe(extractLastMessageHash(manifest));
  });

  test("rejects steering before execution has started", async () => {
    const harness = createFakeKernelHarness();
    let firstExecuteSawSteering = false;
    const driver = {
      async execute(context) {
        firstExecuteSawSteering = context.messages.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Injected too early"
            )
        );

        return {
          messages: [assistantText("No early steering.")],
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
      signal: textSignal("Start steering validation"),
      threadId: thread.threadId,
    });

    expect(() => handle.steer(textSignal("Injected too early"))).toThrow(
      "steer() is only valid while execution is running"
    );
    await collectEvents(handle.events());

    expect(firstExecuteSawSteering).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Start steering validation", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "No early steering.", type: "text" }],
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
