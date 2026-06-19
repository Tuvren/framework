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
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createOtelTelemetrySink } from "@tuvren/telemetry-otel";

describe("createOtelTelemetrySink", () => {
  test("projects telemetry spans into OpenTelemetry spans", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const sink = createOtelTelemetrySink({
      tracer: provider.getTracer("test"),
    });

    sink.span({
      attributes: { "tuvren.runtime.driver.id": "react" },
      endMs: 2000,
      kind: "model_call",
      lineage: {
        branchId: "branch-main",
        runId: "run-main",
        scope: "tenant-a",
        threadId: "thread-main",
        turnId: "turn-main",
      },
      name: "tuvren.runtime.model_call",
      startMs: 1000,
      status: "ok",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("tuvren.runtime.model_call");
    expect(spans[0]?.attributes["tuvren.runtime.driver.id"]).toBe("react");
    expect(spans[0]?.attributes["tuvren.runtime.thread.id"]).toBe(
      "thread-main"
    );
    expect(spans[0]?.attributes["tuvren.runtime.turn.id"]).toBe("turn-main");
    expect(spans[0]?.attributes["tuvren.runtime.scope.id"]).toBe("tenant-a");
  });

  test("projects standalone telemetry events into short OpenTelemetry spans", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const sink = createOtelTelemetrySink({
      tracer: provider.getTracer("test"),
    });

    sink.event({
      atMs: 3000,
      attributes: { "tuvren.runtime.driver.id": "react" },
      kind: "turn.start",
      lineage: {
        branchId: "branch-main",
        scope: "tenant-a",
        threadId: "thread-main",
        turnId: "turn-main",
      },
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("tuvren.runtime.turn.start");
    expect(spans[0]?.events[0]?.name).toBe("turn.start");
    expect(spans[0]?.attributes["tuvren.runtime.thread.id"]).toBe(
      "thread-main"
    );
    expect(spans[0]?.attributes["tuvren.runtime.scope.id"]).toBe("tenant-a");
  });

  test("projects telemetry errors through authored semconv attributes", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const sink = createOtelTelemetrySink({
      tracer: provider.getTracer("test"),
    });

    sink.span({
      attributes: {},
      endMs: 2000,
      error: {
        code: "runtime_error",
        message: "failed",
      },
      kind: "run",
      lineage: {
        branchId: "branch-main",
        scope: "tenant-a",
        threadId: "thread-main",
        turnId: "turn-main",
      },
      name: "tuvren.runtime.run",
      startMs: 1000,
      status: "error",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.events[0]?.attributes?.["tuvren.runtime.error.code"]).toBe(
      "runtime_error"
    );
  });
});
