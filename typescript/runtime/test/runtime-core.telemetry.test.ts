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

import { describe, expect, spyOn, test } from "bun:test";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { RuntimeRunner as KrakenRunner } from "@tuvren/core/runner";
import type {
  TelemetryDestination,
  TelemetryEvent,
  TelemetryOperationalSignal,
  TelemetryRoute,
  TelemetryRouting,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import { createRunnerRegistry, createTuvrenRuntime } from "../src/index.ts";
import {
  filterTelemetryAttributes,
  sanitizeTelemetryErrorSummary,
} from "../src/lib/telemetry-secret-screening.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("runtime operational telemetry", () => {
  test("emits lineage-keyed events and spans for a completed turn", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const runner = {
      execute() {
        return Promise.resolve({
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        });
      },
      id: "fake",
      resume() {
        return Promise.reject(new Error("resume was not expected"));
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
      now: createDeterministicClock(),
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("hello"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capture.events.map((event) => event.kind)).toContain("turn.start");
    expect(capture.events.map((event) => event.kind)).toContain("turn.end");
    expect(capture.events.map((event) => event.kind)).toContain(
      "state.checkpoint"
    );
    expect(capture.spans.map((span) => span.kind)).toContain("turn");
    expect(capture.spans.map((span) => span.kind)).toContain("run");
    expect(capture.spans.map((span) => span.kind)).toContain("iteration");
    expect(capture.spans.map((span) => span.kind)).toContain("model_call");
    expect(
      capture.events
        .filter((event) => event.kind === "state.checkpoint")
        .every(
          (event) =>
            typeof event.attributes["tuvren.runtime.checkpoint.hash"] ===
            "string"
        )
    ).toBe(true);
    expect(capture.spans.every((span) => span.lineage.threadId)).toBe(true);
    expect(capture.spans.every((span) => span.lineage.branchId)).toBe(true);
    expect(
      capture.spans.every((span) => span.attributes.authorization === undefined)
    ).toBe(true);
  });

  test("tags every telemetry record with the constructing scope and never leaks another scope (KRT-BE008)", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const runner = {
      execute() {
        return Promise.resolve({
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        });
      },
      id: "fake",
      resume() {
        return Promise.reject(new Error("resume was not expected"));
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
      scope: "tenant-a",
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("hello"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    // Every event and span emitted under scope A is correlated to scope A and
    // carries no other scope's identity.
    expect(capture.events.length).toBeGreaterThan(0);
    expect(capture.spans.length).toBeGreaterThan(0);
    expect(
      capture.events.every((event) => event.lineage.scope === "tenant-a")
    ).toBe(true);
    expect(
      capture.spans.every((span) => span.lineage.scope === "tenant-a")
    ).toBe(true);
    // Load-bearing leak guard: had the runtime ignored the "tenant-a" binding,
    // its surfaces would carry the default scope, so asserting that the default
    // scope is absent proves the bound scope actually displaced the fallback
    // rather than a never-bound literal that could never appear regardless.
    const serialized = JSON.stringify({
      events: capture.events,
      spans: capture.spans,
    });
    expect(serialized).not.toContain("tuvren.scope.default");
  });

  test("defaults telemetry correlation to the default scope when the host binds none", async () => {
    const capture = createTelemetryCapture();
    const harness = createFakeKernelHarness();
    const runner = {
      execute() {
        return Promise.resolve({
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        });
      },
      id: "fake",
      resume() {
        return Promise.reject(new Error("resume was not expected"));
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("hello"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    // Guard against a vacuous pass: `every` is true on an empty array, so the
    // default-scope claim is only meaningful once spans were actually emitted.
    expect(capture.spans.length).toBeGreaterThan(0);
    expect(
      capture.spans.every(
        (span) => span.lineage.scope === "tuvren.scope.default"
      )
    ).toBe(true);
  });

  test("rejects an empty scope binding at runtime construction (KRT-BE008)", () => {
    const harness = createFakeKernelHarness();
    expect(() =>
      createTuvrenRuntime({
        defaultRunnerId: "fake",
        kernel: harness.kernel,
        scope: "",
      })
    ).toThrow(TypeError);
  });

  test("isolates throwing telemetry sinks from runtime execution", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute() {
        return Promise.resolve({
          messages: [assistantText("done")],
          resolution: { reason: "done", type: "end_turn" },
        });
      },
      id: "fake",
      resume() {
        return Promise.reject(new Error("resume was not expected"));
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
      telemetry: {
        event() {
          throw new Error("sink failed");
        },
        span() {
          throw new Error("sink failed");
        },
      },
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("hello"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
  });

  test("routes every telemetry record to a bare destination (ADR-058)", async () => {
    const capture = createDestinationCapture();
    const { phase } = await runTelemetryTurn(capture.destination);

    expect(phase).toBe("completed");
    expect(capture.records.length).toBeGreaterThan(0);
    // both an event kind and a span kind fan out to the durable destination
    expect(capture.records.map((record) => record.kind)).toContain(
      "turn.start"
    );
    expect(capture.records.map((record) => record.kind)).toContain("turn");
    expect(capture.batches.every((batch) => batch.length > 0)).toBe(true);
    // a healthy destination raises no operational signal
    expect(capture.signals).toHaveLength(0);
  });

  test("threads a route object to both the sink and the destination (ADR-058 §2)", async () => {
    const sinkCapture = createTelemetryCapture();
    const destinationCapture = createDestinationCapture();
    const route: TelemetryRoute = {
      destination: destinationCapture.destination,
      sink: sinkCapture.sink,
    };

    const { phase } = await runTelemetryTurn(route);

    expect(phase).toBe("completed");
    expect(sinkCapture.events.length).toBeGreaterThan(0);
    expect(sinkCapture.spans.length).toBeGreaterThan(0);
    // the same set of records reaches both funnels
    expect(destinationCapture.records.length).toBe(
      sinkCapture.events.length + sinkCapture.spans.length
    );
  });

  test("isolates a throwing destination and surfaces an operational signal (ADR-058 §3)", async () => {
    const capture = createDestinationCapture({ failDelivery: true });
    const { phase } = await runTelemetryTurn(capture.destination);

    // one-directional isolation: the session still completes despite delivery failure
    expect(phase).toBe("completed");
    // the throw was contained (no record captured) and reported as a signal
    expect(capture.records).toHaveLength(0);
    expect(capture.signals.length).toBeGreaterThan(0);
    expect(
      capture.signals.every((signal) => signal.kind === "delivery_failed")
    ).toBe(true);
  });

  test("routes a sink failure to the destination operational-signal channel (ADR-058 §1)", async () => {
    const destinationCapture = createDestinationCapture();
    const route: TelemetryRoute = {
      destination: destinationCapture.destination,
      sink: {
        event() {
          throw new Error("sink failed");
        },
        span() {
          throw new Error("sink failed");
        },
      },
    };

    const { phase } = await runTelemetryTurn(route);

    expect(phase).toBe("completed");
    // the destination still receives every record even though the sink throws
    expect(destinationCapture.records.length).toBeGreaterThan(0);
    expect(destinationCapture.signals.length).toBeGreaterThan(0);
    expect(
      destinationCapture.signals.every(
        (signal) => signal.kind === "sink_failed"
      )
    ).toBe(true);
  });

  test("produces an identical session result whether the destination is healthy or unavailable (ADR-058 §5a)", async () => {
    const healthy = await runTelemetryTurn(
      createDestinationCapture().destination
    );
    const unavailable = await runTelemetryTurn(
      createDestinationCapture({ failDelivery: true }).destination
    );

    expect(unavailable.phase).toBe(healthy.phase);
    expect(unavailable.events.map((event) => event.type)).toEqual(
      healthy.events.map((event) => event.type)
    );
  });

  test("contains a pathological non-coercible destination throw at the boundary (ADR-058 §3)", async () => {
    const signals: TelemetryOperationalSignal[] = [];
    const destination: TelemetryDestination = {
      deliver() {
        // A null-prototype object defeats String(): no toString, no
        // Symbol.toPrimitive. The projection inside the catch handler must not
        // itself throw into the session path while describing this value.
        throw Object.create(null);
      },
      onOperationalSignal(signal) {
        signals.push(signal);
      },
    };

    const { phase } = await runTelemetryTurn(destination);

    expect(phase).toBe("completed");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.kind === "delivery_failed")).toBe(
      true
    );
  });

  test("falls back to a one-shot warning when a failing destination has no signal callback (ADR-058 §1)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {
      /* silence the last-resort warning in test output */
    });
    try {
      const destination: TelemetryDestination = {
        deliver() {
          throw new Error("destination unavailable");
        },
      };

      const { phase } = await runTelemetryTurn(destination);

      expect(phase).toBe("completed");
      // anti-spam: exactly one lifetime warning per emitter despite a full
      // turn's worth of failed deliveries
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("degrades to the last-resort warning when the signal callback itself throws (ADR-058 §1)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {
      /* silence the last-resort warning in test output */
    });
    try {
      const destination: TelemetryDestination = {
        deliver() {
          // biome-ignore lint/style/useThrowOnlyError: a non-Error throw whose string coercion itself throws is the regression under test (ADR-058 §3 boundary hardening)
          throw {
            toString() {
              throw new Error("uncoercible");
            },
          };
        },
        onOperationalSignal() {
          throw new Error("broken health callback");
        },
      };

      const { phase } = await runTelemetryTurn(destination);

      expect(phase).toBe("completed");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("redacts credential-shaped error summaries", () => {
    expect(
      sanitizeTelemetryErrorSummary("backend failed password=hunter2")
    ).toBe("[redacted]");
    expect(sanitizeTelemetryErrorSummary("provider token=abc123")).toBe(
      "[redacted]"
    );
  });

  test("preserves UUID identity attributes while dropping secret-looking values", () => {
    const attributes = filterTelemetryAttributes({
      "tuvren.runtime.branch.id": "123e4567-e89b-12d3-a456-426614174000",
      "tuvren.runtime.provider.id": "abcdefghijklmnopqrstuvwxyzabcdef123456",
      "tuvren.runtime.run.id": "123e4567-e89b-12d3-a456-426614174001",
      "tuvren.runtime.thread.id": "123e4567-e89b-12d3-a456-426614174002",
      "tuvren.runtime.turn.id": "123e4567-e89b-12d3-a456-426614174003",
    });

    expect(attributes["tuvren.runtime.branch.id"]).toBe(
      "123e4567-e89b-12d3-a456-426614174000"
    );
    expect(attributes["tuvren.runtime.provider.id"]).toBeUndefined();
    expect(attributes["tuvren.runtime.run.id"]).toBe(
      "123e4567-e89b-12d3-a456-426614174001"
    );
    expect(attributes["tuvren.runtime.thread.id"]).toBe(
      "123e4567-e89b-12d3-a456-426614174002"
    );
    expect(attributes["tuvren.runtime.turn.id"]).toBe(
      "123e4567-e89b-12d3-a456-426614174003"
    );
  });
});

function createTelemetryCapture(): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
  spans: TelemetrySpan[];
} {
  const events: TelemetryEvent[] = [];
  const spans: TelemetrySpan[] = [];

  return {
    events,
    sink: {
      event: (event) => {
        events.push(event);
      },
      span: (span) => {
        spans.push(span);
      },
    },
    spans,
  };
}

function createDestinationCapture(options?: { failDelivery?: boolean }): {
  batches: ReadonlyArray<TelemetryEvent | TelemetrySpan>[];
  destination: TelemetryDestination;
  records: Array<TelemetryEvent | TelemetrySpan>;
  signals: TelemetryOperationalSignal[];
} {
  const batches: ReadonlyArray<TelemetryEvent | TelemetrySpan>[] = [];
  const records: Array<TelemetryEvent | TelemetrySpan> = [];
  const signals: TelemetryOperationalSignal[] = [];

  return {
    batches,
    destination: {
      deliver(batch) {
        if (options?.failDelivery === true) {
          throw new Error("destination unavailable");
        }

        batches.push(batch);
        records.push(...batch);
      },
      onOperationalSignal(signal) {
        signals.push(signal);
      },
    },
    records,
    signals,
  };
}

async function runTelemetryTurn(
  telemetry: TelemetryRouting
): Promise<{ events: TuvrenStreamEvent[]; phase: string }> {
  const harness = createFakeKernelHarness();
  const runner = {
    execute() {
      return Promise.resolve({
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      });
    },
    id: "fake",
    resume() {
      return Promise.reject(new Error("resume was not expected"));
    },
  } satisfies KrakenRunner;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: "fake",
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
    telemetry,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: textSignal("hello"),
    threadId: thread.threadId,
  });
  const events = await collectEvents(handle.events());

  return { events, phase: handle.status().phase };
}

function createDeterministicClock(): () => number {
  let now = 1000;

  return () => {
    now += 10;
    return now;
  };
}
