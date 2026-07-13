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
 * `@tuvren/core/telemetry` — the host-facing telemetry contract: the
 * span/event vocabulary with its lineage correlation context, the
 * `TuvrenTelemetrySink` seam with its behavior-free `NoopTelemetrySink`
 * default, and the telemetry-funnel destination/routing contract (ADR-058)
 * re-published from the sibling `telemetry-destination` module.
 *
 * @packageDocumentation
 */

import type { EpochMs, HashString, TuvrenErrorCode } from "../index.js";

/**
 * Durable-identity correlation context attached to every telemetry span and
 * event, tying observability output back to the thread/branch/turn (and
 * optionally run and turn-node hash) it was produced for.
 */
export interface TelemetryLineage {
  branchId: string;
  runId?: string;
  /**
   * The host-bound Scope (tenancy partition identity, ADR-048) the runtime is
   * constructed against. Correlation context only; it is never a kernel syscall
   * argument. Single-tenant hosts carry the default Scope.
   */
  scope: string;
  threadId: string;
  turnId: string;
  turnNodeHash?: HashString;
}

/** Scalar attribute value allowed on telemetry spans and events. */
export type TelemetryAttributeValue = boolean | number | string;

/** The fixed vocabulary of span kinds the runtime emits. */
export type TelemetrySpanKind =
  | "turn"
  | "run"
  | "iteration"
  | "model_call"
  | "tool_call"
  | "checkpoint"
  | "recovery";

/** Error summary carried by a span whose `status` is `"error"`. */
export interface TelemetrySpanError {
  code: TuvrenErrorCode;
  message: string;
}

/**
 * A completed, timed unit of runtime work (turn, run, iteration, model
 * call, tool call, checkpoint, or recovery) with attributes, lineage, and
 * an ok/error status. Spans are reported whole, after they end.
 */
export interface TelemetrySpan {
  attributes: Record<string, TelemetryAttributeValue>;
  endMs: EpochMs;
  error?: TelemetrySpanError;
  kind: TelemetrySpanKind;
  lineage: TelemetryLineage;
  name: string;
  startMs: EpochMs;
  status: "error" | "ok";
}

/** The fixed vocabulary of point-in-time telemetry event kinds. */
export type TelemetryEventKind =
  | "turn.start"
  | "turn.end"
  | "approval.requested"
  | "approval.resolved"
  | "state.checkpoint"
  | "recovery.resumed"
  | "recovery.failed"
  | "execution.bounded"
  | "error";

/**
 * A point-in-time telemetry occurrence (as opposed to a timed
 * {@link TelemetrySpan}) with attributes and lineage.
 */
export interface TelemetryEvent {
  atMs: EpochMs;
  attributes: Record<string, TelemetryAttributeValue>;
  kind: TelemetryEventKind;
  lineage: TelemetryLineage;
}

/**
 * Host-supplied destination for runtime telemetry: receives completed
 * {@link TelemetrySpan}s and point-in-time {@link TelemetryEvent}s. Both
 * methods are synchronous, fire-and-forget notifications.
 */
export interface TuvrenTelemetrySink {
  event(event: TelemetryEvent): void;
  span(span: TelemetrySpan): void;
}

/**
 * The behavior-free default sink: discards every span and event. Used by
 * the runtime when the host does not supply a telemetry sink.
 */
export const NoopTelemetrySink: TuvrenTelemetrySink = Object.freeze({
  event: () => undefined,
  span: () => undefined,
});

// ── Telemetry-funnel destination contract (ADR-058) ───────────────────────────
// The durable-destination half of the two-funnel routing seam lives in a
// sibling module to keep the frozen sink/span/event block above untouched; it is
// re-published here so `@tuvren/core/telemetry` remains the single import site.
export type {
  TelemetryBufferingPolicy,
  TelemetryDestination,
  TelemetryOperationalSignal,
  TelemetryOperationalSignalKind,
  TelemetryRoute,
  TelemetryRouting,
} from "./telemetry-destination.js";
