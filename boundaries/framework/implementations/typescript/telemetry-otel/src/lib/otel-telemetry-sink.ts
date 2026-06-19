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

import {
  type Span,
  type SpanAttributes,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";

const DEFAULT_INSTRUMENTATION_NAME = "@tuvren/telemetry-otel";

export interface CreateOtelTelemetrySinkOptions {
  instrumentationName?: string;
  instrumentationVersion?: string;
  tracer?: Tracer;
}

export function createOtelTelemetrySink(
  options: CreateOtelTelemetrySinkOptions = {}
): TuvrenTelemetrySink {
  const tracer =
    options.tracer ??
    trace.getTracer(
      options.instrumentationName ?? DEFAULT_INSTRUMENTATION_NAME,
      options.instrumentationVersion
    );

  return {
    event: (event) => emitTelemetryEvent(tracer, event),
    span: (span) => emitTelemetrySpan(tracer, span),
  };
}

function emitTelemetrySpan(tracer: Tracer, telemetrySpan: TelemetrySpan): void {
  const span = tracer.startSpan(telemetrySpan.name, {
    attributes: toOtelAttributes({
      ...telemetrySpan.attributes,
      "tuvren.runtime.branch.id": telemetrySpan.lineage.branchId,
      "tuvren.runtime.run.id": telemetrySpan.lineage.runId,
      "tuvren.runtime.scope.id": telemetrySpan.lineage.scope,
      "tuvren.runtime.thread.id": telemetrySpan.lineage.threadId,
      "tuvren.runtime.turn.id": telemetrySpan.lineage.turnId,
      "tuvren.runtime.checkpoint.hash": telemetrySpan.lineage.turnNodeHash,
    }),
    kind: SpanKind.INTERNAL,
    startTime: telemetrySpan.startMs,
  });

  applyStatus(span, telemetrySpan);
  span.end(telemetrySpan.endMs);
}

function emitTelemetryEvent(tracer: Tracer, event: TelemetryEvent): void {
  const activeSpan = trace.getActiveSpan();
  const attributes = toOtelAttributes({
    ...event.attributes,
    "tuvren.runtime.branch.id": event.lineage.branchId,
    "tuvren.runtime.run.id": event.lineage.runId,
    "tuvren.runtime.scope.id": event.lineage.scope,
    "tuvren.runtime.thread.id": event.lineage.threadId,
    "tuvren.runtime.turn.id": event.lineage.turnId,
    "tuvren.runtime.checkpoint.hash": event.lineage.turnNodeHash,
  });

  if (activeSpan !== undefined) {
    activeSpan.addEvent(event.kind, attributes, event.atMs);
    return;
  }

  const span = tracer.startSpan(`tuvren.runtime.${event.kind}`, {
    attributes,
    kind: SpanKind.INTERNAL,
    startTime: event.atMs,
  });
  span.addEvent(event.kind, attributes, event.atMs);
  span.end(event.atMs);
}

function applyStatus(span: Span, telemetrySpan: TelemetrySpan): void {
  if (telemetrySpan.status === "ok") {
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: telemetrySpan.error?.message,
  });

  if (telemetrySpan.error !== undefined) {
    span.addEvent("exception", {
      "exception.message": telemetrySpan.error.message,
      "tuvren.runtime.error.code": telemetrySpan.error.code,
    });
  }
}

function toOtelAttributes(
  attributes: Record<string, boolean | number | string | undefined>
): SpanAttributes {
  const otelAttributes: SpanAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      otelAttributes[key] = value;
    }
  }

  return otelAttributes;
}
