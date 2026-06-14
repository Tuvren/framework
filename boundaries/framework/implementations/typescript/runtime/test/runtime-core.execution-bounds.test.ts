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
import type { EpochMs } from "@tuvren/core";
import type { RuntimeDriver as KrakenDriver } from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ExecutionBoundExceededDetails,
  ExecutionResult,
} from "@tuvren/core/execution";
import type {
  TelemetryEvent,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import {
  createDriverRegistry,
  createTuvrenRuntime,
  type RuntimeCoreOptions,
} from "../src/index.ts";
import {
  DEFAULT_EXECUTION_BOUNDS,
  normalizeExecutionBounds,
} from "../src/lib/runtime-core-bounds.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const AGENT = "bounds-agent";

interface TelemetryCapture {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
}

function createTelemetryCapture(): TelemetryCapture {
  const events: TelemetryEvent[] = [];
  return {
    events,
    sink: {
      event(event) {
        events.push(event);
      },
      span() {
        return;
      },
    },
  };
}

/** A driver that never stops — it always requests another iteration. */
const runawayTextDriver = {
  async execute() {
    return {
      messages: [assistantText("keep going")],
      resolution: { type: "continue_iteration" as const },
    };
  },
  id: "runaway",
  async resume() {
    throw new Error("resume was not expected");
  },
} satisfies KrakenDriver;

function createBoundsRuntime(options: {
  bounds?: RuntimeCoreOptions["bounds"];
  driver: KrakenDriver;
  now?: () => EpochMs;
  telemetry?: TuvrenTelemetrySink;
}) {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntime({
    defaultDriverId: options.driver.id,
    driverRegistry: createDriverRegistry([options.driver]),
    kernel: harness.kernel,
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  });
  return { harness, runtime };
}

function expectBoundsFailure(
  result: ExecutionResult,
  bound: ExecutionBoundExceededDetails["bound"]
): ExecutionBoundExceededDetails {
  expect(result.status).toBe("failed");
  if (result.status !== "failed") {
    throw new Error("expected a failed result");
  }
  expect(result.error.code).toBe("execution_bound_exceeded");
  const details = result.error.details as ExecutionBoundExceededDetails;
  expect(details.bound).toBe(bound);
  expect(typeof details.limit).toBe("number");
  expect(typeof details.observed).toBe("number");
  return details;
}

function eventIndex(
  events: TuvrenStreamEvent[],
  predicate: (event: TuvrenStreamEvent) => boolean
): number {
  return events.findIndex(predicate);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("framework execution bounds (KRT-BD006)", () => {
  test("breaching maxIterations fails the turn with execution_bound_exceeded", async () => {
    const { runtime } = createBoundsRuntime({
      bounds: { maxIterations: 3 },
      driver: runawayTextDriver,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    const events = (await collectEvents(
      handle.events()
    )) as TuvrenStreamEvent[];
    const result = await handle.awaitResult();

    const details = expectBoundsFailure(result, "maxIterations");
    expect(details.limit).toBe(3);
    expect(details.observed).toBe(3);

    // The fatal error event precedes the failed terminal turn.end event.
    const errorIdx = eventIndex(
      events,
      (event) =>
        event.type === "error" &&
        (event as { error?: { code?: string } }).error?.code ===
          "execution_bound_exceeded"
    );
    const turnEndIdx = eventIndex(
      events,
      (event) =>
        event.type === "turn.end" &&
        (event as { status?: string }).status === "failed"
    );
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(turnEndIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(turnEndIdx);
  });

  test("AgentConfig.maxIterations is clamped by bounds.maxIterations", async () => {
    const { runtime } = createBoundsRuntime({
      bounds: { maxIterations: 2 },
      driver: runawayTextDriver,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      // A driver/agent asking for far more iterations cannot bypass the bound.
      config: { name: AGENT, maxIterations: 1000 },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    const result = await handle.awaitResult();
    const details = expectBoundsFailure(result, "maxIterations");
    expect(details.limit).toBe(2);
    expect(details.observed).toBe(2);
  });

  test("breaching maxToolCalls fails the turn with execution_bound_exceeded", async () => {
    // A single batch of three tool calls exceeds the cumulative cap of two,
    // tripping the bound at the tool-batch boundary.
    const batchDriver = {
      async execute() {
        return {
          messages: [
            assistantToolCalls([
              { callId: "t1", input: {}, name: "noop" },
              { callId: "t2", input: {}, name: "noop" },
              { callId: "t3", input: {}, name: "noop" },
            ]),
          ],
          resolution: { type: "continue_iteration" as const },
          toolExecutionMode: "parallel" as const,
        };
      },
      id: "batch",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const { runtime } = createBoundsRuntime({
      bounds: { maxToolCalls: 2, maxIterations: 100 },
      driver: batchDriver,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: AGENT,
        tools: [
          {
            description: "noop tool",
            execute: async () => ({ ok: true }),
            inputSchema: { type: "object" },
            name: "noop",
          },
        ],
      },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    const result = await handle.awaitResult();
    const details = expectBoundsFailure(result, "maxToolCalls");
    expect(details.limit).toBe(2);
    expect(details.observed).toBe(3);
  });

  test("breaching maxWallClockMs fails the turn with execution_bound_exceeded", async () => {
    // Deterministic clock that advances past the deadline within a few ticks.
    let clock = 0;
    const now = (): EpochMs => {
      clock += 40;
      return clock as EpochMs;
    };
    const { runtime } = createBoundsRuntime({
      bounds: { maxWallClockMs: 100, maxIterations: 100_000 },
      driver: runawayTextDriver,
      now,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    const result = await handle.awaitResult();
    const details = expectBoundsFailure(result, "maxWallClockMs");
    expect(details.limit).toBe(100);
  });

  test("emits an execution.bounded telemetry event on a hard-stop breach", async () => {
    const capture = createTelemetryCapture();
    const { runtime } = createBoundsRuntime({
      bounds: { maxIterations: 2 },
      driver: runawayTextDriver,
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    await handle.awaitResult();

    const bounded = capture.events.filter(
      (event) => event.kind === "execution.bounded"
    );
    expect(bounded.length).toBe(1);
    const attributes = bounded[0]?.attributes ?? {};
    expect(attributes["tuvren.runtime.bound"]).toBe("maxIterations");
    expect(attributes["tuvren.runtime.bound.limit"]).toBe("2");
    expect(attributes["tuvren.runtime.bound.observed"]).toBe("2");
  });

  test("throttles parallel tool execution to maxConcurrentToolCalls", async () => {
    let active = 0;
    let maxActive = 0;
    const concurrencyTool = {
      description: "concurrency probe",
      async execute() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        return { ok: true };
      },
      inputSchema: { type: "object" },
      name: "probe",
    };
    const parallelDriver = {
      async execute(context) {
        const done = context.messages.some((m) => m.role === "tool");
        if (done) {
          return {
            messages: [assistantText("done")],
            resolution: { reason: "done", type: "end_turn" as const },
          };
        }
        return {
          messages: [
            assistantToolCalls([
              { callId: "c1", input: {}, name: "probe" },
              { callId: "c2", input: {}, name: "probe" },
              { callId: "c3", input: {}, name: "probe" },
            ]),
          ],
          resolution: { type: "continue_iteration" as const },
          toolExecutionMode: "parallel" as const,
        };
      },
      id: "parallel",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;

    const { runtime } = createBoundsRuntime({
      bounds: { maxConcurrentToolCalls: 1 },
      driver: parallelDriver,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      // A high agent parallelism is clamped by the bound to 1.
      config: {
        name: AGENT,
        maxParallelToolCalls: 10,
        tools: [concurrencyTool],
      },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    const result = await handle.awaitResult();
    expect(result.status).toBe("completed");
    expect(maxActive).toBe(1);
  });

  test("rejects invalid bound configuration at construction time", () => {
    const driver = runawayTextDriver;
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createBoundsRuntime({ bounds: { maxIterations: bad }, driver })
      ).toThrow();
    }
  });

  test("a within-bounds turn completes normally under default bounds", async () => {
    const normalDriver = {
      async execute() {
        return {
          messages: [assistantText("all done")],
          resolution: { reason: "done", type: "end_turn" as const },
        };
      },
      id: "normal",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const { runtime } = createBoundsRuntime({ driver: normalDriver });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    const result = await handle.awaitResult();
    expect(result.status).toBe("completed");
  });

  test("normalizeExecutionBounds applies safe defaults and validates fields", () => {
    expect(normalizeExecutionBounds(undefined)).toEqual(
      DEFAULT_EXECUTION_BOUNDS
    );
    expect(normalizeExecutionBounds({ maxIterations: 10 })).toEqual({
      ...DEFAULT_EXECUTION_BOUNDS,
      maxIterations: 10,
    });
    expect(() => normalizeExecutionBounds({ maxToolCalls: 0 })).toThrow();
    expect(() => normalizeExecutionBounds({ maxWallClockMs: -5 })).toThrow();
    expect(() =>
      normalizeExecutionBounds({ maxConcurrentToolCalls: 2.5 })
    ).toThrow();
  });
});
