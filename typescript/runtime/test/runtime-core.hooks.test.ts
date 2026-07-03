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
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type {
  RuntimeRunner as KrakenRunner,
  RuntimeRunnerFactory as KrakenRunnerFactory,
  RunnerExecutionResult,
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
  hasAssistantText,
  startEventCapture,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("keeps runtime hook receiver state mutable across live extension execution", async () => {
    interface ReceiverExtension extends TuvrenExtension {
      beforeIteration(): undefined;
      beforeTurn(): undefined;
      beforeTurnCalls: number;
    }

    const harness = createFakeKernelHarness();
    const extension: ReceiverExtension = {
      beforeIteration() {
        if (this.beforeTurnCalls !== 1) {
          throw new Error(
            `expected beforeTurnCalls to be 1, received ${this.beforeTurnCalls}`
          );
        }

        return undefined;
      },
      beforeTurn() {
        this.beforeTurnCalls += 1;
        return undefined;
      },
      beforeTurnCalls: 0,
      name: "mutable-receiver",
    };
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([
        {
          async execute() {
            return {
              messages: [assistantText("Hook receiver stayed mutable.")],
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
        } satisfies KrakenRunner,
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [extension],
        name: "primary",
      },
      signal: textSignal("Exercise mutable hook receiver"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Hook receiver stayed mutable."
      )
    ).toBe(true);
  });

  test("persists beforeTurn state updates on terminal short-circuits", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(_context) {
        driverCalls += 1;
        return {
          messages: [assistantText("This should not run.")],
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
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            beforeTurn() {
              return {
                state: {
                  seeded: true,
                },
                reason: "stop before turn",
                verdict: "endTurn",
              };
            },
            name: "seeded",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Short-circuit beforeTurn"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(driverCalls).toBe(0);
    expect(handle.status().manifest?.extensions.seeded).toEqual({
      seeded: true,
    });
  });

  test("persists beforeIteration state updates on terminal verdicts", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(_context) {
        driverCalls += 1;
        return {
          messages: [assistantText("This should not run.")],
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
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            beforeIteration() {
              return {
                state: {
                  seeded: true,
                },
                reason: "stop before iteration",
                verdict: "endTurn",
              };
            },
            name: "seeded",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Short-circuit beforeIteration"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(driverCalls).toBe(0);
    expect(handle.status().manifest?.extensions.seeded).toEqual({
      seeded: true,
    });
  });

  test("times out beforeIteration hooks as soft failures instead of stalling the turn", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(_context) {
        driverCalls += 1;
        return {
          messages: [assistantText("Runner still completed.")],
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
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async beforeIteration() {
              await delay(30);
              return undefined;
            },
            name: "slow-hook",
            timeout: 5,
          },
        ],
        name: "primary",
      },
      signal: textSignal("Timeout hook"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(driverCalls).toBe(1);
    expect(handle.status().phase).toBe("completed");
    expect(errorEvent?.fatal).toBe(false);
    expect(errorEvent?.error.message).toContain(
      'extension "slow-hook" beforeIteration timed out after 5ms'
    );
  });

  test("suppresses late hook events after timeout soft-fail conversion", async () => {
    const harness = createFakeKernelHarness();
    let lateEmitAttempts = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Runner still completed.")],
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
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async beforeIteration(context) {
              await delay(25);
              lateEmitAttempts += 1;
              context.emit({
                data: {
                  late: true,
                },
                name: "late-event",
              });
              return undefined;
            },
            name: "slow-hook",
            timeout: 5,
          },
        ],
        name: "primary",
      },
      signal: textSignal("Timeout hook"),
      threadId: thread.threadId,
    });

    const capture = startEventCapture(handle.events());
    await capture.done;
    await delay(40);

    expect(lateEmitAttempts).toBe(1);
    expect(
      capture.events.some(
        (event) => event.type === "custom" && event.name === "late-event"
      )
    ).toBe(false);
  });

  test("surfaces afterTurn cleanup failures as non-fatal error events", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Finished main execution.")],
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
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      driverRegistry: createRunnerRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            afterTurn() {
              throw new Error("cleanup failed");
            },
            name: "cleanup-observer",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Run afterTurn cleanup"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("completed");
    expect(errorEvent?.fatal).toBe(false);
    expect(errorEvent?.error.message).toBe("cleanup failed");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Finished main execution."
      )
    ).toBe(true);
  });
});

function createRunnerRegistry(
  drivers: Array<KrakenRunner | KrakenRunnerFactory> = []
) {
  return createBaseRunnerRegistry(drivers.map(wrapRunnerEntry));
}

function wrapRunnerEntry(
  entry: KrakenRunner | KrakenRunnerFactory
): KrakenRunner | KrakenRunnerFactory {
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
  entry: KrakenRunner | KrakenRunnerFactory
): entry is KrakenRunnerFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapRunner(driver: KrakenRunner): KrakenRunner {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeRunnerResult(await driver.execute(context));
    },
    id: driver.id,
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
