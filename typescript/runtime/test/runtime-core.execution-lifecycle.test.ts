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
  fromSynchronousVariadicAwaited,
  assistantText,
  collectEvents,
  delay,
  readBranchCheckpointEventTypes,
  readBranchContextManifest,
  textSignal,
  waitFor,
  waitForAbort,
} from "./runtime-core-test-helpers.ts";

const isKrakenRunnerFactory = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory =>
  "create" in entry && typeof entry.create === "function";

const requestsToolExecution = (result: RunnerExecutionResult): boolean =>
  (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );

const normalizeRunnerResult = (
  result: RunnerExecutionResult
): RunnerExecutionResult => {
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
};

const wrapRunner = (runner: RuntimeRunner): RuntimeRunner => {
  const resume = runner.resume?.bind(runner);

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
};

const wrapRunnerEntry = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory => {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
};

const createRunnerRegistry = (
  runners: (RuntimeRunner | RuntimeRunnerFactory)[] = []
) => createBaseRunnerRegistry(runners.map(wrapRunnerEntry));
describe("framework-runtime-core", () => {
  test("executes a runner-neutral turn and persists the input plus assistant output", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute(context) {
        await context.runtime.emit({
          messageId: "assistant-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        await context.runtime.emit({
          delta: "Hello from Kraken.",
          messageId: "assistant-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        await context.runtime.emit({
          messageId: "assistant-1",
          text: "Hello from Kraken.",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        await context.runtime.emit({
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
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    expect(checkpointEventTypes).toContain("input_received");
    expect(checkpointEventTypes).toContain("iteration_step_completed");
    expect(checkpointEventTypes).toContain("turn_status_finalized");
  });

  test("synthesizes assistant content events when a runner returns durable output without streaming it", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute: fromSynchronousVariadicAwaited(() => ({
        messages: [assistantText("Visible without explicit runtime.emit.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    const runner = {
      execute: fromSynchronousVariadicAwaited((_context) => {
        executeCalls += 1;
        return {
          messages: [assistantText("Started on demand.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      }),
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    let runnerStarted = false;
    let observedAbort = false;
    const runner = {
      async execute(context) {
        runnerStarted = true;
        await waitForAbort(context.signal);
        observedAbort = context.signal?.aborted === true;
        return {
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    if (firstEvent.done === true) {
      throw new Error("expected the event stream to yield turn.start");
    }
    expect(firstEvent.value.type).toBe("turn.start");

    await waitFor(() => runnerStarted);
    await iterator.return?.();
    await waitFor(() => handle.status().phase === "failed");

    expect(observedAbort).toBe(true);
    expect(handle.status().phase).toBe("failed");
  });
});
