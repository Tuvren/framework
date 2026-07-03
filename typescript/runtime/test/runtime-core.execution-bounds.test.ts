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
import type { EpochMs } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ExecutionBoundExceededDetails,
  ExecutionResult,
} from "@tuvren/core/execution";
import type { RuntimeRunner as KrakenRunner } from "@tuvren/core/runner";
import type {
  TelemetryEvent,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import {
  createCapabilityPolicyEngine,
  createRunnerRegistry,
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
  waitForAbort,
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

/** A runner that never stops — it always requests another iteration. */
const runawayTextRunner = {
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
} satisfies KrakenRunner;

function createBoundsRuntime(options: {
  bounds?: RuntimeCoreOptions["bounds"];
  runner: KrakenRunner;
  now?: () => EpochMs;
  telemetry?: TuvrenTelemetrySink;
}) {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntime({
    defaultRunnerId: options.runner.id,
    runnerRegistry: createRunnerRegistry([options.runner]),
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
      runner: runawayTextRunner,
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
      runner: runawayTextRunner,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      // A runner/agent asking for far more iterations cannot bypass the bound.
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
    const batchRunner = {
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
    } satisfies KrakenRunner;
    const { runtime } = createBoundsRuntime({
      bounds: { maxToolCalls: 2, maxIterations: 100 },
      runner: batchRunner,
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
      runner: runawayTextRunner,
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

  test("the real wall-clock timer aborts in-flight work and ignores its late completion", async () => {
    // No mock clock: a small real maxWallClockMs lets the out-of-band abort
    // timer fire while the runner is awaiting its cooperative cancellation
    // signal (standing in for in-flight model/tool work).
    let lateCompletion = false;
    const hangingRunner = {
      async execute(context) {
        await waitForAbort(context.signal);
        // The interrupted work completes only AFTER the bounded abort. Its
        // end_turn must be ignored and cannot reopen the failed turn.
        lateCompletion = true;
        return {
          messages: [assistantText("late completion")],
          resolution: { reason: "done", type: "end_turn" as const },
        };
      },
      id: "hanging",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenRunner;
    const { runtime } = createBoundsRuntime({
      bounds: { maxWallClockMs: 25 },
      runner: hangingRunner,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    const result = await handle.awaitResult();

    const details = expectBoundsFailure(result, "maxWallClockMs");
    expect(details.limit).toBe(25);
    // The in-flight work did complete late, but its terminal resolution was
    // ignored: the turn is the bounds failure, not a completed turn.
    expect(lateCompletion).toBe(true);
    expect(result.status).toBe("failed");
  });

  test("a resumed turn carries the wall-clock deadline forward across an approval pause", async () => {
    // Execution bounds are per logical turn: a resumed handle continues the same
    // turn, so the end-to-end wall-clock deadline is carried forward rather than
    // reset (runtime-core.ts resumeApprovedExecution / getBoundsTurnState).
    // Otherwise a runner could reset the hard-stop budget on every approval
    // pause. We pin that here — the deadline is captured on the first run, the
    // turn pauses for human approval, the controllable clock then advances past
    // the original deadline, and the resume MUST fail with maxWallClockMs at the
    // carried deadline (limit 1000). If the deadline were reset on resume it
    // would become now()+1000 = 6000 and the turn would proceed instead.
    let clockValue = 0;
    const now = (): EpochMs => clockValue as EpochMs;

    const highRiskTool = "dangerous.delete";
    let toolExecutedAtPause = false;

    const engine = createCapabilityPolicyEngine({
      requireApprovalForRiskClass: "high",
    });
    const approvalRunner = {
      async execute(context) {
        if (!context.messages.some((m) => m.role === "tool")) {
          return {
            messages: [
              assistantToolCalls([
                { callId: "risk-1", input: {}, name: highRiskTool },
              ]),
            ],
            resolution: { type: "continue_iteration" as const },
            toolExecutionMode: "parallel" as const,
          };
        }
        return {
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" as const },
        };
      },
      id: "bounds-approval",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenRunner;

    const { runtime } = createBoundsRuntime({
      bounds: { maxWallClockMs: 1000, maxIterations: 100 },
      runner: approvalRunner,
      now,
    });

    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        capabilityPolicyEngine: engine,
        name: AGENT,
        tools: [
          {
            description: "High-risk dangerous tool",
            execute() {
              toolExecutedAtPause = true;
              return { deleted: true };
            },
            inputSchema: { type: "object" },
            name: highRiskTool,
            riskClass: "high",
          },
        ],
      },
      signal: textSignal("approval bounds carry"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    // The turn paused awaiting approval, well before the 1000ms deadline.
    expect(handle.status().phase).toBe("paused");
    expect(toolExecutedAtPause).toBe(false);

    // Human deliberation elapses past the original deadline.
    clockValue = 5000;

    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "risk-1", type: "approve" }],
    });
    await collectEvents(resumedHandle.events());
    const result = await resumedHandle.awaitResult();

    // The carried (not reset) deadline trips on resume.
    const details = expectBoundsFailure(result, "maxWallClockMs");
    expect(details.limit).toBe(1000);
  });

  test("emits an execution.bounded telemetry event on a hard-stop breach", async () => {
    const capture = createTelemetryCapture();
    const { runtime } = createBoundsRuntime({
      bounds: { maxIterations: 2 },
      runner: runawayTextRunner,
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
    const parallelRunner = {
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
    } satisfies KrakenRunner;

    const { runtime } = createBoundsRuntime({
      bounds: { maxConcurrentToolCalls: 1 },
      runner: parallelRunner,
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
    const runner = runawayTextRunner;
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createBoundsRuntime({ bounds: { maxIterations: bad }, runner })
      ).toThrow();
    }
  });

  test("a within-bounds turn completes normally under default bounds", async () => {
    const normalRunner = {
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
    } satisfies KrakenRunner;
    const { runtime } = createBoundsRuntime({ runner: normalRunner });
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
