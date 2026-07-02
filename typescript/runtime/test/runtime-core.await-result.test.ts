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
import type { RuntimeDriver as KrakenDriver } from "@tuvren/core/driver";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  textSignal,
  waitFor,
  waitForAbort,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core awaitResult", () => {
  test("resolves with status=completed and the final assistant message on a successful turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "msg-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Hello world.",
          messageId: "msg-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "msg-1",
          text: "Hello world.",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "msg-1",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("Hello world.")],
          resolution: { reason: "done", type: "end_turn" },
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
      signal: textSignal("Go"),
      threadId: thread.threadId,
    });

    const result = await handle.awaitResult();

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error("unreachable");
    }
    expect(result.executionStatus.phase).toBe("completed");
    expect(result.finalAssistantMessage).toEqual({
      parts: [{ text: "Hello world.", type: "text" }],
      providerMetadata: undefined,
      role: "assistant",
    });
  });

  test("resolves (does not reject) with status=failed when the driver returns an error resolution", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: JSON.parse('[{"role":"assistant","parts":[123]}]'),
          resolution: { reason: "done", type: "end_turn" },
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
      signal: textSignal("Trigger failure"),
      threadId: thread.threadId,
    });

    const result = await handle.awaitResult();

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("unreachable");
    }
    expect(result.executionStatus.phase).toBe("failed");
    expect(result.error).toBeDefined();
  });

  test("rejects with TuvrenRuntimeError code=execution_cancelled when the execution is cancelled mid-run", async () => {
    const harness = createFakeKernelHarness();
    let driverStarted = false;
    const driver = {
      async execute(context) {
        driverStarted = true;
        await waitForAbort(context.signal);

        return {
          resolution: { type: "continue_iteration" },
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
      signal: textSignal("Cancel me"),
      threadId: thread.threadId,
    });

    const resultPromise = handle.awaitResult();
    await waitFor(() => driverStarted);
    handle.cancel();

    await expect(resultPromise).rejects.toMatchObject({
      code: "execution_cancelled",
    });
    expect(handle.status().phase).toBe("failed");
  });

  test("rejects with execution_cancelled when cancel() is called before awaitResult() starts execution", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const driver = {
      async execute() {
        executeCalls += 1;
        return {
          messages: [assistantText("Should not run.")],
          resolution: { reason: "done", type: "end_turn" },
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
      signal: textSignal("Pre-cancel"),
      threadId: thread.threadId,
    });

    handle.cancel();
    const resultPromise = handle.awaitResult();

    await expect(resultPromise).rejects.toMatchObject({
      code: "execution_cancelled",
    });
    expect(handle.status().phase).toBe("failed");
    expect(executeCalls).toBe(0);
  });

  test("returns the same ExecutionResult when awaited multiple times (idempotent)", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantText("Done.")],
          resolution: { reason: "done", type: "end_turn" },
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
      signal: textSignal("Repeat await"),
      threadId: thread.threadId,
    });

    const first = await handle.awaitResult();
    const second = await handle.awaitResult();
    const third = await handle.awaitResult();

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(third.status).toBe("completed");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test("does not interfere with concurrent events() iteration", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "msg-2",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Concurrent.",
          messageId: "msg-2",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "msg-2",
          text: "Concurrent.",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "msg-2",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("Concurrent.")],
          resolution: { reason: "done", type: "end_turn" },
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
      signal: textSignal("Concurrent test"),
      threadId: thread.threadId,
    });

    const [events, result] = await Promise.all([
      collectEvents(handle.events()),
      handle.awaitResult(),
    ]);

    expect(result.status).toBe("completed");
    expect(events.map((e) => e.type)).toContain("turn.end");
    expect(events.some((e) => e.type === "turn.start")).toBe(true);
  });
});

function createDriverRegistry(drivers: KrakenDriver[] = []) {
  return createBaseDriverRegistry(drivers);
}
