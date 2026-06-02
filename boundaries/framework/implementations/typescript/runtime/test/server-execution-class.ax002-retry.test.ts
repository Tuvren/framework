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

/**
 * KRT-AX002: Idempotent retry and cancellation for server invocations.
 *
 * Acceptance criteria:
 * - An idempotent server invocation is retried on a retriable failure up to
 *   the configured limit.
 * - A non-idempotent server invocation is never silently retried.
 * - Cancellation propagates an abort signal into in-flight server tool work.
 * - A late completion after cancellation is ignored and cannot mutate the
 *   invocation.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  extractToolMessages,
  textSignal,
  waitForAbort,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeDriver(toolName: string, input: unknown = {}): RuntimeDriver {
  return {
    id: "ax002-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-ax002", input, name: toolName },
            ]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
    async resume() {
      throw new Error("resume not expected");
    },
  };
}

async function runWithTool(tool: TuvrenToolDefinition) {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntime({
    defaultDriverId: "ax002-driver",
    driverRegistry: createBaseDriverRegistry([makeDriver(tool.name)]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary", tools: [tool] },
    signal: textSignal("ax002 test"),
    threadId: thread.threadId,
  });
  return { events: await collectEvents(handle.events()), handle };
}

function findToolResult(events: unknown[]) {
  return events.find(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      "type" in e &&
      (e as Record<string, unknown>).type === "tool.result"
  ) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Idempotent retry
// ---------------------------------------------------------------------------

describe("KRT-AX002 — idempotent retry", () => {
  test("idempotent tool retried once on retriable failure, then succeeds", async () => {
    let callCount = 0;
    const tool: TuvrenToolDefinition = {
      name: "ax002-idempotent-retry",
      description: "idempotent tool",
      idempotent: true,
      maxRetries: 1,
      inputSchema: { type: "object" },
      execute() {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("transient failure");
        }
        return { result: "ok" };
      },
    };

    const { events } = await runWithTool(tool);
    const toolResult = findToolResult(events);

    expect(callCount).toBe(2);
    expect(toolResult?.isError).toBeFalsy();
    expect((toolResult?.output as Record<string, unknown>)?.result).toBe("ok");
  });

  test("idempotent tool fails with error after exhausting maxRetries", async () => {
    let callCount = 0;
    const tool: TuvrenToolDefinition = {
      name: "ax002-idempotent-exhaust",
      description: "idempotent tool that always fails",
      idempotent: true,
      maxRetries: 2,
      inputSchema: { type: "object" },
      execute() {
        callCount += 1;
        throw new Error("persistent failure");
      },
    };

    const { events } = await runWithTool(tool);
    const toolResult = findToolResult(events);

    // 1 initial + 2 retries = 3 total attempts
    expect(callCount).toBe(3);
    expect(toolResult?.isError).toBe(true);
  });

  test("non-idempotent tool is never retried on failure", async () => {
    let callCount = 0;
    const tool: TuvrenToolDefinition = {
      name: "ax002-non-idempotent",
      description: "non-idempotent tool",
      // idempotent not set (defaults to false/undefined)
      inputSchema: { type: "object" },
      execute() {
        callCount += 1;
        throw new Error("failure");
      },
    };

    const { events } = await runWithTool(tool);
    const toolResult = findToolResult(events);

    expect(callCount).toBe(1);
    expect(toolResult?.isError).toBe(true);
  });

  test("non-idempotent tool with maxRetries set is still never retried", async () => {
    let callCount = 0;
    const tool: TuvrenToolDefinition = {
      name: "ax002-non-idempotent-maxretries",
      description:
        "non-idempotent tool with maxRetries set but idempotent false",
      idempotent: false,
      maxRetries: 5,
      inputSchema: { type: "object" },
      execute() {
        callCount += 1;
        throw new Error("failure");
      },
    };

    await runWithTool(tool);
    expect(callCount).toBe(1);
  });

  test("idempotent default maxRetries is 1 when not specified", async () => {
    let callCount = 0;
    const tool: TuvrenToolDefinition = {
      name: "ax002-idempotent-default",
      description: "idempotent tool with default maxRetries",
      idempotent: true,
      // maxRetries not set — should default to 1
      inputSchema: { type: "object" },
      execute() {
        callCount += 1;
        if (callCount <= 1) {
          throw new Error("transient");
        }
        return { ok: true };
      },
    };

    const { events } = await runWithTool(tool);
    const toolResult = findToolResult(events);

    expect(callCount).toBe(2);
    expect(toolResult?.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("KRT-AX002 — cancellation", () => {
  test("cancellation propagates abort signal into in-flight tool work", async () => {
    let signalAbortedDuringExecution = false;
    let releaseToolLatch: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      releaseToolLatch = resolve;
    });

    const harness = createFakeKernelHarness();
    const toolName = "ax002-cancel-signal";

    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool that observes abort signal",
      inputSchema: { type: "object" },
      async execute(_input, context) {
        releaseToolLatch?.(); // signal to the test that execution has started
        await waitForAbort(context.signal);
        signalAbortedDuringExecution = context.signal?.aborted === true;
        return { observed: true };
      },
    };

    const driver = makeDriver(toolName);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax002-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary", tools: [tool] },
      signal: textSignal("cancel test"),
      threadId: thread.threadId,
    });

    // Drive events in background; cancel only after the tool has started
    const eventsPromise = collectEvents(handle.events()).catch(() => undefined);
    await toolStarted;
    handle.cancel();
    await eventsPromise;

    expect(signalAbortedDuringExecution).toBe(true);
  });

  test("late completion after cancellation is not committed to durable invocation state", async () => {
    const LATE_VALUE = "late-should-not-appear";
    let releaseTool: (() => void) | undefined;
    let releaseToolLatch: (() => void) | undefined;

    const toolStarted = new Promise<void>((resolve) => {
      releaseToolLatch = resolve;
    });

    const harness = createFakeKernelHarness();
    const toolName = "ax002-late-completion";

    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool that completes after cancellation",
      inputSchema: { type: "object" },
      async execute() {
        releaseToolLatch?.(); // signal that execution started
        // Wait until the test releases the tool (after cancel has been called)
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        return { value: LATE_VALUE };
      },
    };

    const driver = makeDriver(toolName);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax002-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary", tools: [tool] },
      signal: textSignal("late completion test"),
      threadId: thread.threadId,
    });

    const eventsPromise = collectEvents(handle.events()).catch(() => undefined);

    // Wait for tool to start, then cancel
    await toolStarted;
    handle.cancel();

    // Release the tool AFTER cancellation — simulates a slow operation that
    // completes after the run was cancelled
    releaseTool?.();
    await eventsPromise;

    // The late completion must not appear as a committed tool.result
    const messages = await harness.readBranchMessages(thread.branchId);
    const toolMessages = extractToolMessages(messages);
    const lateResult = toolMessages.find((m) =>
      m.parts.some(
        (p) =>
          typeof p.output === "object" &&
          p.output !== null &&
          "value" in (p.output as Record<string, unknown>) &&
          (p.output as Record<string, unknown>).value === LATE_VALUE
      )
    );

    expect(lateResult).toBeUndefined();
  });
});
