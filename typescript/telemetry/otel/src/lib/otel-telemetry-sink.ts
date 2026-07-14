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

/** Construction options for {@link createOtelTelemetrySink}. */
export interface CreateOtelTelemetrySinkOptions {
  /**
   * Instrumentation scope name used to resolve a tracer via
   * `trace.getTracer` when `tracer` is not supplied.
   *
   * @defaultValue `"@tuvren/telemetry-otel"`
   */
  instrumentationName?: string;
  /** Instrumentation scope version passed to `trace.getTracer`, when resolving a tracer by name. */
  instrumentationVersion?: string;
  /**
   * A pre-built OTel `Tracer` to use directly, bypassing
   * `trace.getTracer(instrumentationName, instrumentationVersion)`.
   */
  tracer?: Tracer;
}

/**
 * Builds a `TuvrenTelemetrySink` backed by the OpenTelemetry JS API.
 *
 * `span` entries become OTel spans with explicit `startTime`/`endTime`
 * (`SpanKind.INTERNAL`) and a status derived from `telemetrySpan.status` (see
 * {@link applyStatus}). `event` entries attach to the currently active OTel
 * span (`trace.getActiveSpan()`) as a span event when one exists; otherwise a
 * short-lived wrapper span is created and immediately ended so the event is
 * never silently dropped for lack of an active span. Every span and event
 * carries the Tuvren lineage (`branchId`, `runId`, `scope`, `threadId`,
 * `turnId`, `turnNodeHash`) as `tuvren.runtime.*` attributes alongside any
 * caller-supplied attributes.
 *
 * @param options.tracer - Takes precedence over
 *   `instrumentationName`/`instrumentationVersion` when supplied.
 */
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

/** Projects one `TelemetrySpan` onto an OTel span with explicit start/end times and lineage attributes. */
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

/**
 * Projects one `TelemetryEvent` onto OTel: added to the active span if one
 * exists, otherwise emitted on a short-lived wrapper span created and ended
 * at `event.atMs` so the event is never dropped for lack of an active span.
 */
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

/**
 * Sets the OTel span status from `telemetrySpan.status`: `"ok"` maps to
 * `SpanStatusCode.OK`; anything else maps to `SpanStatusCode.ERROR`, with an
 * `exception` span event added when `telemetrySpan.error` is present.
 */
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

/** Drops `undefined`-valued entries, since `SpanAttributes` does not accept them. */
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
