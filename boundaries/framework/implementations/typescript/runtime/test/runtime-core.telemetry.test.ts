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
import type { RuntimeDriver as KrakenDriver } from "@tuvren/core/driver";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import { createDriverRegistry, createTuvrenRuntime } from "../src/index.ts";
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
    const driver = {
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
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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

  test("isolates throwing telemetry sinks from runtime execution", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
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
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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

function createDeterministicClock(): () => number {
  let now = 1000;

  return () => {
    now += 10;
    return now;
  };
}
