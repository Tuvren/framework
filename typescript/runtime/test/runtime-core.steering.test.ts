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

// biome-ignore-all lint/suspicious/useAwait: Test runners intentionally match the async framework runner contract.
import { describe, expect, test } from "bun:test";
import type {
  RunnerExecutionResult,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";
import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
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
    const runner = {
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
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
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
    const runner = {
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
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
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
    const runner = {
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
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
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

function createRunnerRegistry(
  runners: Array<RuntimeRunner | RuntimeRunnerFactory> = []
) {
  return createBaseRunnerRegistry(runners.map(wrapRunnerEntry));
}

function wrapRunnerEntry(
  entry: RuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
}

function isKrakenRunnerFactory(
  entry: RuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapRunner(runner: RuntimeRunner): RuntimeRunner {
  const resume = runner.resume;

  return {
    async execute(context) {
      return normalizeRunnerResult(await runner.execute(context));
    },
    id: runner.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeRunnerResult(await resume(context));
          },
        }),
  };
}

function normalizeRunnerResult(
  result: RunnerExecutionResult
): RunnerExecutionResult {
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

function requestsToolExecution(result: RunnerExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
