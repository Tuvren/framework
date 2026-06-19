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

import type { EpochMs, HashString, TuvrenErrorCode } from "../index.js";

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

export type TelemetryAttributeValue = boolean | number | string;

export type TelemetrySpanKind =
  | "turn"
  | "run"
  | "iteration"
  | "model_call"
  | "tool_call"
  | "checkpoint"
  | "recovery";

export interface TelemetrySpanError {
  code: TuvrenErrorCode;
  message: string;
}

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

export interface TelemetryEvent {
  atMs: EpochMs;
  attributes: Record<string, TelemetryAttributeValue>;
  kind: TelemetryEventKind;
  lineage: TelemetryLineage;
}

export interface TuvrenTelemetrySink {
  event(event: TelemetryEvent): void;
  span(span: TelemetrySpan): void;
}

export const NoopTelemetrySink: TuvrenTelemetrySink = Object.freeze({
  event: () => undefined,
  span: () => undefined,
});
