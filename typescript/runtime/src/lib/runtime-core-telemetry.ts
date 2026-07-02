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

import type { EpochMs, HashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ExecutionBoundExceededDetails } from "@tuvren/core/execution";
import {
  NoopTelemetrySink,
  type TelemetryAttributeValue,
  type TelemetryEvent,
  type TelemetryEventKind,
  type TelemetryLineage,
  type TelemetrySpan,
  type TelemetrySpanError,
  type TelemetrySpanKind,
  type TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type { LoopState } from "./runtime-core-loop.js";
import { projectError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import {
  filterTelemetryAttributes,
  sanitizeTelemetryErrorSummary,
} from "./telemetry-secret-screening.js";

interface TimedSpanStart {
  atMs: EpochMs;
  lineage: TelemetryLineage;
}

export interface RuntimeTelemetryEmitter {
  /**
   * Emit the bounded-execution telemetry event when a hard-stop execution bound
   * is breached (ADR-043, KRT-BD006). The authoritative integer limit/observed
   * values also live on the failed `ExecutionResult` and the canonical `error`
   * event details; the telemetry attributes carry decimal-string encodings.
   */
  bounded(input: {
    details: ExecutionBoundExceededDetails;
    handle: RuntimeExecutionHandle;
    loopState: LoopState;
  }): void;
  eventFromStream(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): void;
  recovery(input: {
    error?: unknown;
    handle: RuntimeExecutionHandle;
    loopState: LoopState;
    status: "error" | "ok";
  }): void;
  span(input: {
    attributes?: Record<string, TelemetryAttributeValue>;
    error?: unknown;
    handle: RuntimeExecutionHandle;
    kind: TelemetrySpanKind;
    loopState: LoopState;
    name: string;
    runId?: string;
    startMs: EpochMs;
    status: "error" | "ok";
    turnNodeHash?: HashString;
  }): void;
}

export function createRuntimeTelemetryEmitter(input: {
  now(): EpochMs;
  scope: string;
  sink?: TuvrenTelemetrySink;
}): RuntimeTelemetryEmitter {
  const sink = input.sink ?? NoopTelemetrySink;
  let sinkWarningEmitted = false;
  const turnStarts = new WeakMap<RuntimeExecutionHandle, TimedSpanStart>();
  const iterationStarts = new WeakMap<RuntimeExecutionHandle, TimedSpanStart>();
  const toolStarts = new WeakMap<
    RuntimeExecutionHandle,
    Map<string, TimedSpanStart>
  >();

  const emitSinkWarning = () => {
    if (sinkWarningEmitted) {
      return;
    }

    sinkWarningEmitted = true;
    console.warn("Tuvren telemetry sink threw; dropping telemetry record");
  };

  const safeEvent = (event: TelemetryEvent) => {
    try {
      sink.event(event);
    } catch {
      emitSinkWarning();
    }
  };

  const safeSpan = (span: TelemetrySpan) => {
    try {
      sink.span(span);
    } catch {
      emitSinkWarning();
    }
  };

  const emitEvent = (
    kind: TelemetryEventKind,
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    attributes: Record<string, TelemetryAttributeValue> = {},
    turnNodeHash?: HashString
  ) => {
    safeEvent({
      atMs,
      attributes: filterTelemetryAttributes(attributes),
      kind,
      lineage: createLineage(input.scope, handle, turnNodeHash),
    });
  };

  const handleTurnStart = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    loopState: LoopState,
    resumedFrom?: HashString
  ) => {
    const lineage = createLineage(input.scope, handle);
    const attributes = {
      ...baseAttributes(handle, loopState),
      ...(resumedFrom === undefined
        ? {}
        : { "tuvren.runtime.resumed_from.hash": resumedFrom }),
    };

    turnStarts.set(handle, { atMs, lineage });
    emitEvent("turn.start", handle, atMs, attributes);
  };

  const handleTurnEnd = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    loopState: LoopState,
    status: "completed" | "failed" | "paused"
  ) => {
    emitEvent("turn.end", handle, atMs, baseAttributes(handle, loopState));
    const started = turnStarts.get(handle);

    if (started !== undefined) {
      const spanStatus = status === "failed" ? "error" : "ok";

      emitSpan({
        attributes: baseAttributes(handle, loopState),
        endMs: atMs,
        kind: "turn",
        lineage: started.lineage,
        name: "tuvren.runtime.turn",
        startMs: started.atMs,
        status: spanStatus,
      });
      emitSpan({
        attributes: baseAttributes(handle, loopState),
        endMs: atMs,
        kind: "run",
        lineage: started.lineage,
        name: "tuvren.runtime.run",
        startMs: started.atMs,
        status: spanStatus,
      });
    }

    turnStarts.delete(handle);
  };

  const handleIterationEnd = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    loopState: LoopState
  ) => {
    const started = iterationStarts.get(handle);

    if (started !== undefined) {
      emitSpan({
        attributes: baseAttributes(handle, loopState),
        endMs: atMs,
        kind: "iteration",
        lineage: started.lineage,
        name: "tuvren.runtime.iteration",
        startMs: started.atMs,
        status: "ok",
      });
    }

    iterationStarts.delete(handle);
  };

  const handleToolStart = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    callId: string
  ) => {
    let starts = toolStarts.get(handle);

    if (starts === undefined) {
      starts = new Map<string, TimedSpanStart>();
      toolStarts.set(handle, starts);
    }

    starts.set(callId, {
      atMs,
      lineage: createLineage(input.scope, handle),
    });
  };

  const handleToolResult = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    loopState: LoopState,
    event: Extract<TuvrenStreamEvent, { type: "tool.result" }>
  ) => {
    const started = toolStarts.get(handle)?.get(event.callId);

    if (started !== undefined) {
      const attributionAttributes: Record<string, string> =
        event.attribution === undefined
          ? {}
          : {
              "tuvren.runtime.capability.execution_class":
                event.attribution.executionClass,
              "tuvren.runtime.capability.owner": event.attribution.owner,
            };
      emitSpan({
        attributes: {
          ...baseAttributes(handle, loopState),
          ...attributionAttributes,
          "tuvren.runtime.tool_call.id": event.callId,
        },
        endMs: atMs,
        kind: "tool_call",
        lineage: started.lineage,
        name: `tuvren.runtime.tool.${event.name}`,
        startMs: started.atMs,
        status: event.isError === true ? "error" : "ok",
      });
    }

    toolStarts.get(handle)?.delete(event.callId);
  };

  const handleCheckpoint = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    loopState: LoopState,
    turnNodeHash: HashString
  ) => {
    const attributes = {
      ...baseAttributes(handle, loopState),
      "tuvren.runtime.checkpoint.hash": turnNodeHash,
    };

    emitEvent("state.checkpoint", handle, atMs, attributes, turnNodeHash);
    emitSpan({
      attributes,
      endMs: atMs,
      kind: "checkpoint",
      lineage: createLineage(input.scope, handle, turnNodeHash),
      name: "tuvren.runtime.checkpoint",
      startMs: atMs,
      status: "ok",
    });
  };

  const handleRuntimeError = (
    handle: RuntimeExecutionHandle,
    atMs: EpochMs,
    loopState: LoopState,
    error: Extract<TuvrenStreamEvent, { type: "error" }>["error"]
  ) => {
    emitEvent("error", handle, atMs, baseAttributes(handle, loopState));
    emitSpan({
      attributes: baseAttributes(handle, loopState),
      endMs: atMs,
      error: {
        code: error.code ?? "runtime_error",
        message: error.message,
      },
      kind: "run",
      lineage: createLineage(input.scope, handle),
      name: "tuvren.runtime.error",
      startMs: atMs,
      status: "error",
    });
  };

  const emitSpan = (span: TelemetrySpan) => {
    safeSpan({
      ...span,
      attributes: filterTelemetryAttributes(span.attributes),
      error:
        span.error === undefined
          ? undefined
          : {
              code: span.error.code,
              message: sanitizeTelemetryErrorSummary(span.error.message),
            },
    });
  };

  return {
    bounded: (boundedInput) => {
      const atMs = input.now();
      emitEvent("execution.bounded", boundedInput.handle, atMs, {
        ...baseAttributes(boundedInput.handle, boundedInput.loopState),
        "tuvren.runtime.bound": boundedInput.details.bound,
        "tuvren.runtime.bound.limit": String(boundedInput.details.limit),
        "tuvren.runtime.bound.observed": String(boundedInput.details.observed),
      });
    },
    eventFromStream: (handle, event, loopState) => {
      const atMs = event.timestamp as EpochMs;

      switch (event.type) {
        case "turn.start":
          handleTurnStart(handle, atMs, loopState, event.resumedFrom);
          return;
        case "turn.end":
          handleTurnEnd(handle, atMs, loopState, event.status);
          return;
        case "iteration.start": {
          iterationStarts.set(handle, {
            atMs,
            lineage: createLineage(input.scope, handle),
          });
          return;
        }
        case "iteration.end":
          handleIterationEnd(handle, atMs, loopState);
          return;
        case "tool.start":
          handleToolStart(handle, atMs, event.callId);
          return;
        case "tool.result":
          handleToolResult(handle, atMs, loopState, event);
          return;
        case "approval.requested":
          emitEvent(
            "approval.requested",
            handle,
            atMs,
            baseAttributes(handle, loopState)
          );
          return;
        case "approval.resolved":
          emitEvent(
            "approval.resolved",
            handle,
            atMs,
            baseAttributes(handle, loopState)
          );
          return;
        case "state.checkpoint":
          handleCheckpoint(handle, atMs, loopState, event.turnNodeHash);
          return;
        case "error":
          handleRuntimeError(handle, atMs, loopState, event.error);
          return;
        default:
          return;
      }
    },
    recovery: (recoveryInput) => {
      const atMs = input.now();
      const error = createSpanError(recoveryInput.error);

      emitEvent(
        recoveryInput.status === "error"
          ? "recovery.failed"
          : "recovery.resumed",
        recoveryInput.handle,
        atMs,
        baseAttributes(recoveryInput.handle, recoveryInput.loopState)
      );
      emitSpan({
        attributes: baseAttributes(
          recoveryInput.handle,
          recoveryInput.loopState
        ),
        endMs: atMs,
        error,
        kind: "recovery",
        lineage: createLineage(input.scope, recoveryInput.handle),
        name: "tuvren.runtime.recovery",
        startMs: atMs,
        status: recoveryInput.status,
      });
    },
    span: (spanInput) => {
      emitSpan({
        attributes:
          spanInput.attributes ??
          baseAttributes(spanInput.handle, spanInput.loopState),
        endMs: input.now(),
        error: createSpanError(spanInput.error),
        kind: spanInput.kind,
        lineage: createLineage(
          input.scope,
          spanInput.handle,
          spanInput.turnNodeHash,
          spanInput.runId ?? spanInput.handle.getActiveRunId()
        ),
        name: spanInput.name,
        startMs: spanInput.startMs,
        status: spanInput.status,
      });
    },
  };
}

function createLineage(
  scope: string,
  handle: RuntimeExecutionHandle,
  turnNodeHash?: HashString,
  runId = handle.getActiveRunId()
): TelemetryLineage {
  return {
    branchId: handle.request.branchId,
    ...(runId === undefined ? {} : { runId }),
    scope,
    threadId: handle.request.threadId,
    turnId: handle.turnId,
    ...(turnNodeHash === undefined ? {} : { turnNodeHash }),
  };
}

function baseAttributes(
  handle: RuntimeExecutionHandle,
  loopState: LoopState
): Record<string, TelemetryAttributeValue> {
  return {
    "tuvren.runtime.branch.id": handle.request.branchId,
    "tuvren.runtime.driver.id": loopState.activeDriverId,
    ...(handle.getActiveRunId() === undefined
      ? {}
      : { "tuvren.runtime.run.id": handle.getActiveRunId() as string }),
    "tuvren.runtime.turn.id": handle.turnId,
  };
}

function createSpanError(error: unknown): TelemetrySpanError | undefined {
  if (error === undefined) {
    return undefined;
  }

  const projection = projectError(
    error instanceof Error ? error : new Error(String(error))
  );
  return {
    code: projection.code ?? "runtime_error",
    message: projection.message,
  };
}
