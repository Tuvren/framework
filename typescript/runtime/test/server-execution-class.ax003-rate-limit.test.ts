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
 * KRT-AX003: Tenant isolation and rate-limiting for server capabilities.
 *
 * Acceptance criteria:
 * - Server-side invocations are scoped so one tenant cannot observe another
 *   tenant's invocation state.
 * - Server-side invocations beyond the configured rate are throttled or
 *   rejected with a typed result rather than executed unbounded.
 * - A within-budget invocation executes normally.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import { TOOL_INVOCATION_RATE_LIMITED } from "@tuvren/core/errors";
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
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMultiCallDriver(
  toolName: string,
  callCount: number
): RuntimeDriver {
  return {
    id: "ax003-driver",
    async execute(context) {
      const toolMessages = context.messages.filter((m) => m.role === "tool");

      if (toolMessages.length < callCount) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: `call-${toolMessages.length}`,
                input: {},
                name: toolName,
              },
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

function findToolResults(events: unknown[]) {
  return events.filter(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      "type" in e &&
      (e as Record<string, unknown>).type === "tool.result"
  ) as Record<string, unknown>[];
}

async function runTurnWithRateLimit(
  toolName: string,
  tool: TuvrenToolDefinition,
  maxCalls: number,
  totalCallsToRequest: number
) {
  const harness = createFakeKernelHarness();
  const driver = makeMultiCallDriver(toolName, totalCallsToRequest);
  const runtime = createTuvrenRuntime({
    defaultDriverId: "ax003-driver",
    driverRegistry: createBaseDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      name: "primary",
      tools: [tool],
      serverExecution: {
        rateLimit: { maxCalls, windowMs: 60_000 },
      },
    },
    signal: textSignal("ax003 test"),
    threadId: thread.threadId,
  });
  return collectEvents(handle.events());
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("KRT-AX003 — rate limiting", () => {
  const toolName = "ax003-rate-limited-tool";

  const simpleTool: TuvrenToolDefinition = {
    name: toolName,
    description: "simple tool for rate limit testing",
    inputSchema: { type: "object" },
    execute() {
      return { ok: true };
    },
  };

  test("within-budget invocation executes normally and returns tool result", async () => {
    const events = await runTurnWithRateLimit(toolName, simpleTool, 5, 1);
    const results = findToolResults(events);

    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBeFalsy();
    expect((results[0]?.output as Record<string, unknown>)?.ok).toBe(true);
  });

  test("invocation beyond budget is rejected with typed result", async () => {
    // Allow 1 call, request 2 → second should be rate-limited
    const events = await runTurnWithRateLimit(toolName, simpleTool, 1, 2);
    const results = findToolResults(events);

    expect(results).toHaveLength(2);
    // First call: success
    const successResult = results.find((r) => !r.isError);
    expect(successResult).toBeDefined();
    // Second call: rate-limited
    const limitedResult = results.find((r) => r.isError === true);
    expect(limitedResult).toBeDefined();
    const output = limitedResult?.output as Record<string, unknown> | undefined;
    expect(output?.code).toBe(TOOL_INVOCATION_RATE_LIMITED);
  });

  test("rate-limited result is typed (not an unhandled error)", async () => {
    const events = await runTurnWithRateLimit(toolName, simpleTool, 0, 1);
    const results = findToolResults(events);

    // All calls rate-limited immediately (maxCalls: 0)
    expect(results.length).toBeGreaterThan(0);
    const output = results[0]?.output as Record<string, unknown> | undefined;
    expect(output?.code).toBe(TOOL_INVOCATION_RATE_LIMITED);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("KRT-AX003 — tenant isolation", () => {
  const toolName = "ax003-isolated-tool";

  const simpleTool: TuvrenToolDefinition = {
    name: toolName,
    description: "simple tool for isolation testing",
    inputSchema: { type: "object" },
    execute() {
      return { ok: true };
    },
  };

  test("exhausting one runtime's rate limit does not affect another runtime", async () => {
    const harness1 = createFakeKernelHarness();
    const harness2 = createFakeKernelHarness();

    const driver1 = makeMultiCallDriver(toolName, 2);
    const driver2 = makeMultiCallDriver(toolName, 1);

    // Runtime 1: budget 1, requests 2 → second call rate-limited
    const runtime1 = createTuvrenRuntime({
      defaultDriverId: "ax003-driver",
      driverRegistry: createBaseDriverRegistry([driver1]),
      kernel: harness1.kernel,
    });

    // Runtime 2: budget 5 (no depletion from runtime 1)
    const runtime2 = createTuvrenRuntime({
      defaultDriverId: "ax003-driver",
      driverRegistry: createBaseDriverRegistry([driver2]),
      kernel: harness2.kernel,
    });

    const thread1 = await runtime1.createThread({});
    const handle1 = runtime1.executeTurn({
      branchId: thread1.branchId,
      config: {
        name: "primary",
        tools: [simpleTool],
        serverExecution: { rateLimit: { maxCalls: 1, windowMs: 60_000 } },
      },
      signal: textSignal("runtime1 test"),
      threadId: thread1.threadId,
    });
    const events1 = await collectEvents(handle1.events());

    const thread2 = await runtime2.createThread({});
    const handle2 = runtime2.executeTurn({
      branchId: thread2.branchId,
      config: {
        name: "primary",
        tools: [simpleTool],
        serverExecution: { rateLimit: { maxCalls: 5, windowMs: 60_000 } },
      },
      signal: textSignal("runtime2 test"),
      threadId: thread2.threadId,
    });
    const events2 = await collectEvents(handle2.events());

    const results1 = findToolResults(events1);
    const results2 = findToolResults(events2);

    // Runtime 1 has a rate-limited result (budget exhausted)
    const limited1 = results1.find(
      (r) =>
        r.isError === true &&
        (r.output as Record<string, unknown>)?.code ===
          TOOL_INVOCATION_RATE_LIMITED
    );
    expect(limited1).toBeDefined();

    // Runtime 2 executes normally — not affected by runtime 1's budget
    const success2 = results2.find((r) => !r.isError);
    expect(success2).toBeDefined();
    const anyLimited2 = results2.find(
      (r) =>
        (r.output as Record<string, unknown>)?.code ===
        TOOL_INVOCATION_RATE_LIMITED
    );
    expect(anyLimited2).toBeUndefined();
  });
});
