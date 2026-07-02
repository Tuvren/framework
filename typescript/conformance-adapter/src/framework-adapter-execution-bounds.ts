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

/**
 * Conformance adapter operations for the runtime-api-execution-bounds check set
 * (KRT-BD007). Each operation drives a real runtime over the framework bounds
 * guard (ADR-043) and returns raw observational data — captured stream events,
 * the settled ExecutionResult summary, and captured telemetry — for the shared
 * conformance runner to grade.
 *
 * Adapter rules: no assertion logic, no pass/fail grading, no verdict booleans
 * about whether a bound "held". Raw observations only.
 */

import type { ExecutionResult } from "@tuvren/core/execution";
import type {
  TelemetryEvent,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

// ---------------------------------------------------------------------------
// Raw-observation helpers (no grading)
// ---------------------------------------------------------------------------

function createBoundsTelemetryCapture(): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
} {
  const events: TelemetryEvent[] = [];
  return {
    events,
    sink: {
      event: (event) => {
        events.push(event);
      },
      span: () => {
        return;
      },
    },
  };
}

/** A clock that advances 10ms per read; large enough to keep wall-clock unset cases stable. */
function createDeterministicClock(): () => number {
  let now = 10_000;
  return () => {
    now += 10;
    return now;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function findCanonicalErrorCode(events: readonly unknown[]): string | null {
  for (const event of events) {
    const record = asRecord(event);
    if (record.type === "error" && typeof record.error === "object") {
      const code = asRecord(record.error).code;
      if (typeof code === "string") {
        return code;
      }
    }
  }
  return null;
}

function findTerminalTurnEndStatus(events: readonly unknown[]): string | null {
  const turnEnds = events.filter(
    (event) => asRecord(event).type === "turn.end"
  );
  const last = turnEnds.at(-1);
  const status = last === undefined ? undefined : asRecord(last).status;
  return typeof status === "string" ? status : null;
}

function summarizeBoundedTelemetry(
  telemetryEvents: readonly TelemetryEvent[]
): Record<string, unknown> {
  const bounded = telemetryEvents.filter(
    (event) => event.kind === "execution.bounded"
  );
  const first = bounded[0];
  return {
    bound: first?.attributes["tuvren.runtime.bound"] ?? null,
    count: bounded.length,
    limit: first?.attributes["tuvren.runtime.bound.limit"] ?? null,
    observed: first?.attributes["tuvren.runtime.bound.observed"] ?? null,
  };
}

function summarizeExecutionResult(
  result: ExecutionResult
): Record<string, unknown> {
  if (result.status === "failed") {
    return {
      errorCode: result.error.code,
      errorDetails: result.error.details ?? null,
      status: "failed",
    };
  }
  return { status: result.status };
}

interface BoundsTurnObservation {
  events: readonly unknown[];
  result: Record<string, unknown>;
}

function summarizeBoundsTurn(
  events: readonly unknown[],
  telemetryEvents: readonly TelemetryEvent[],
  result: ExecutionResult,
  extra: Record<string, unknown> = {}
): BoundsTurnObservation {
  return {
    events,
    result: {
      ...summarizeExecutionResult(result),
      boundedTelemetry: summarizeBoundedTelemetry(telemetryEvents),
      fatalErrorEventCode: findCanonicalErrorCode(events),
      terminalTurnEndStatus: findTerminalTurnEndStatus(events),
      ...extra,
    },
  };
}

const runawayTextDriver = createStaticDriver(async () => {
  await Promise.resolve();
  return {
    messages: [assistantText("keep going")],
    resolution: { type: "continue_iteration" as const },
  };
});

function noopTool(name: string): TuvrenToolDefinition {
  return {
    description: "noop bounds tool",
    execute: async () => ({ ok: true }),
    inputSchema: { type: "object" },
    name,
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.max-iterations
//
// A runaway driver that always continues breaches maxIterations. The agent also
// requests a far larger maxIterations to prove the bound clamps it from above.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsMaxIterations(): Promise<AdapterProjection> {
  const capture = createBoundsTelemetryCapture();
  const harness = createConformanceKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    bounds: { maxIterations: 3 },
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([runawayTextDriver]),
    kernel: harness.kernel,
    now: createDeterministicClock(),
    telemetry: capture.sink,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { maxIterations: 1000, name: AGENT_NAME },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());
  const result = await handle.awaitResult();
  return summarizeBoundsTurn(events, capture.events, result);
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.max-tool-calls
//
// A single parallel batch of three tool calls breaches the cumulative cap of two
// at the tool-batch boundary.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsMaxToolCalls(): Promise<AdapterProjection> {
  const capture = createBoundsTelemetryCapture();
  const harness = createConformanceKernelHarness();
  const driver = createStaticDriver(async () => {
    await Promise.resolve();
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
  });
  const runtime = createTuvrenRuntimeCore({
    bounds: { maxIterations: 100, maxToolCalls: 2 },
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
    now: createDeterministicClock(),
    telemetry: capture.sink,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME, tools: [noopTool("noop")] },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());
  const result = await handle.awaitResult();
  return summarizeBoundsTurn(events, capture.events, result);
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.max-wall-clock
//
// Deterministic loop-boundary breach: a runaway driver under a clock that
// advances past the deadline trips the wall-clock check at an iteration
// boundary, finalizing cleanly (fatal error event before the failed turn.end)
// with a bounded-execution telemetry event. The in-flight tool-abort and
// late-completion path is covered separately by wall-clock-signal-delivery.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsMaxWallClock(): Promise<AdapterProjection> {
  // Deterministic loop-boundary breach: a runaway driver under a clock that
  // advances past the deadline trips the wall-clock check at an iteration
  // boundary, finalizing cleanly (fatal error event before the failed turn.end).
  const capture = createBoundsTelemetryCapture();
  const harness = createConformanceKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    bounds: { maxIterations: 100_000, maxWallClockMs: 50 },
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([runawayTextDriver]),
    kernel: harness.kernel,
    now: createDeterministicClock(),
    telemetry: capture.sink,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());
  const result = await handle.awaitResult();
  return summarizeBoundsTurn(events, capture.events, result);
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.wall-clock-signal-delivery
//
// Exercises signal delivery and late-completion ignoring through the OWNED tool
// path. The tool awaits its cooperative cancellation signal; the real wall-clock
// abort timer fires, the tool observes the abort and completes late, and the
// turn finalizes as the bounds failure rather than the driver's later end_turn.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsWallClockSignalDelivery(): Promise<AdapterProjection> {
  const capture = createBoundsTelemetryCapture();
  const harness = createConformanceKernelHarness();
  let toolObservedAbort = false;
  let toolCompletedAfterAbort = false;

  const hangingTool: TuvrenToolDefinition = {
    description: "awaits the cooperative cancellation signal",
    async execute(_input, context) {
      const signal = (context as { signal?: AbortSignal }).signal;
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      toolObservedAbort = signal?.aborted === true;
      toolCompletedAfterAbort = true;
      return { ok: true };
    },
    inputSchema: { type: "object" },
    name: "hang",
  };

  const driver = createStaticDriver(async (context) => {
    await Promise.resolve();
    if (context.messages.some((message) => message.role === "tool")) {
      return {
        messages: [assistantText("late")],
        resolution: { reason: "done", type: "end_turn" as const },
      };
    }
    return {
      messages: [
        assistantToolCalls([{ callId: "hang-1", input: {}, name: "hang" }]),
      ],
      resolution: { type: "continue_iteration" as const },
      toolExecutionMode: "parallel" as const,
    };
  });

  const runtime = createTuvrenRuntimeCore({
    // Real clock + a real deadline comfortably larger than turn setup so the
    // out-of-band abort timer fires while the owned tool is awaiting its signal
    // (the tool hangs indefinitely until aborted).
    bounds: { maxWallClockMs: 150 },
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
    telemetry: capture.sink,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME, tools: [hangingTool] },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  // Drive the turn to completion; this op grades the result and tool
  // observations, not the event ordering (the in-flight abort path is covered
  // by the deterministic max-wall-clock op).
  await collectValues(handle.events());
  const result = await handle.awaitResult();
  return {
    result: {
      ...summarizeExecutionResult(result),
      boundedTelemetry: summarizeBoundedTelemetry(capture.events),
      toolCompletedAfterAbort,
      toolObservedAbort,
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.concurrency-throttle
//
// A driver requesting three parallel tool calls with a high agent parallelism
// is clamped to maxConcurrentToolCalls = 1; the probe tool records the maximum
// observed concurrency.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsConcurrencyThrottle(): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  let active = 0;
  let maxObservedConcurrency = 0;

  const probeTool: TuvrenToolDefinition = {
    description: "concurrency probe",
    async execute() {
      active += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15);
      });
      active -= 1;
      return { ok: true };
    },
    inputSchema: { type: "object" },
    name: "probe",
  };

  const driver = createStaticDriver(async (context) => {
    await Promise.resolve();
    if (context.messages.some((message) => message.role === "tool")) {
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" as const },
      };
    }
    return {
      messages: [
        assistantToolCalls([
          { callId: "p1", input: {}, name: "probe" },
          { callId: "p2", input: {}, name: "probe" },
          { callId: "p3", input: {}, name: "probe" },
        ]),
      ],
      resolution: { type: "continue_iteration" as const },
      toolExecutionMode: "parallel" as const,
    };
  });

  const runtime = createTuvrenRuntimeCore({
    bounds: { maxConcurrentToolCalls: 1 },
    createId: createConformanceIdFactory(),
    // Both the agent-level maxParallelToolCalls and the runtime
    // defaultMaxParallelToolCalls request 10; the bound clamps the effective
    // parallelism to 1.
    defaultMaxParallelToolCalls: 10,
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      maxParallelToolCalls: 10,
      name: AGENT_NAME,
      tools: [probeTool],
    },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  await collectValues(handle.events());
  const result = await handle.awaitResult();
  return {
    result: {
      ...summarizeExecutionResult(result),
      maxObservedConcurrency,
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.invalid-config
//
// Records, for each invalid bound value, whether runtime construction was
// rejected and with which error code. The runner grades.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsInvalidConfig(): Promise<AdapterProjection> {
  await Promise.resolve();
  const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
  const rejections = invalidValues.map((value) => {
    try {
      const harness = createConformanceKernelHarness();
      createTuvrenRuntimeCore({
        bounds: { maxIterations: value },
        createId: createConformanceIdFactory(),
        defaultDriverId: DRIVER_ID,
        driverRegistry: createDriverRegistry([runawayTextDriver]),
        kernel: harness.kernel,
      });
      return { code: null, rejected: false, value: String(value) };
    } catch (error: unknown) {
      const code =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null;
      return { code, rejected: true, value: String(value) };
    }
  });
  return { result: { rejections } };
}

// ---------------------------------------------------------------------------
// Operation: runtime.execution-bounds.within-bounds
//
// A control turn under default bounds completes normally.
// ---------------------------------------------------------------------------

export async function runExecutionBoundsWithinBounds(): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  const driver = createStaticDriver(async () => {
    await Promise.resolve();
    return {
      messages: [assistantText("all done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
    kernel: harness.kernel,
    now: createDeterministicClock(),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());
  const result = await handle.awaitResult();
  return {
    events,
    result: {
      ...summarizeExecutionResult(result),
      terminalTurnEndStatus: findTerminalTurnEndStatus(events),
    },
  };
}
