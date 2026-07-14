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
  type TelemetryDestination,
  type TelemetryEvent,
  type TelemetryEventKind,
  type TelemetryLineage,
  type TelemetryOperationalSignal,
  type TelemetryOperationalSignalKind,
  type TelemetryRoute,
  type TelemetryRouting,
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

/**
 * Start timestamp and captured lineage for a span opened by a `*.start`
 * stream event, held until the matching end event closes the span.
 */
interface TimedSpanStart {
  atMs: EpochMs;
  lineage: TelemetryLineage;
}

/**
 * Emitter that projects runtime execution activity onto the telemetry funnel
 * as events and spans.
 *
 * All emission paths are throw-proof toward the caller: sink or destination
 * failures are converted into operational signals (or a single last-resort
 * console warning) and never propagate back into the execution path
 * (ADR-058 §3).
 */
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
  /**
   * Derive telemetry from a runtime stream event. Turn, iteration, and tool
   * start events open timed spans keyed by the execution handle (and call id
   * for tools); the matching end/result events close them. Checkpoint,
   * approval, and error events emit point-in-time telemetry events (and, for
   * checkpoints and errors, zero-duration spans). Unrecognized event types
   * are ignored.
   */
  eventFromStream(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): void;
  /**
   * Emit the recovery outcome for an expired execution: a
   * `recovery.resumed` or `recovery.failed` event plus a zero-duration
   * `recovery` span whose status mirrors `input.status`.
   */
  recovery(input: {
    error?: unknown;
    handle: RuntimeExecutionHandle;
    loopState: LoopState;
    status: "error" | "ok";
  }): void;
  /**
   * Emit an explicit span with a caller-supplied start time; the end time is
   * taken from the emitter's clock at call time. When `attributes` is
   * omitted, the standard branch/runner/run/turn attribute set is used, and
   * the span error (if any) is secret-screened before emission.
   */
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

/**
 * Creates the {@link RuntimeTelemetryEmitter} for one runtime instance.
 *
 * The `telemetry` routing union (bare sink, bare destination, or route
 * object) is normalized once at construction (ADR-058 §2); a missing sink
 * falls back to `NoopTelemetrySink`. Every record fans out to both the sink
 * and, when routed, the durable destination. Failures on either channel are
 * reported through the destination's operational-signal callback, degrading
 * to a single last-resort `console.warn` when that channel is absent or
 * itself throws — telemetry can never fail or delay execution (ADR-058
 * §1/§3). Attributes are secret-screened before emission.
 *
 * @param input.now - Clock used for span end times and event timestamps not
 *   carried by a stream event.
 * @param input.scope - Scope identifier stamped into every record's lineage.
 */
export function createRuntimeTelemetryEmitter(input: {
  now(): EpochMs;
  scope: string;
  telemetry?: TelemetryRouting;
}): RuntimeTelemetryEmitter {
  // ADR-058 §2: normalize the construction-time routing union (bare sink, bare
  // destination, or a route object) once into its sink + destination channels.
  const { sink: routedSink, destination } = normalizeTelemetryRouting(
    input.telemetry
  );
  const sink = routedSink ?? NoopTelemetrySink;
  let fallbackWarningEmitted = false;
  const turnStarts = new WeakMap<RuntimeExecutionHandle, TimedSpanStart>();
  const iterationStarts = new WeakMap<RuntimeExecutionHandle, TimedSpanStart>();
  const toolStarts = new WeakMap<
    RuntimeExecutionHandle,
    Map<string, TimedSpanStart>
  >();

  // ADR-058 §1/§3: the operational-signal channel is the destination's
  // callback. When present it is invoked for every funnel-health event (never
  // one-shot, so an operator sees each failure); when absent, or when the
  // callback itself throws, the runtime falls back to a single last-resort
  // warning so a degraded funnel is never fully silent. Neither path ever
  // rethrows into the session/content-funnel path.
  const emitFallbackWarning = () => {
    if (fallbackWarningEmitted) {
      return;
    }

    fallbackWarningEmitted = true;
    console.warn("Tuvren telemetry delivery failed; dropping telemetry record");
  };

  const emitOperationalSignal = (signal: TelemetryOperationalSignal) => {
    if (destination?.onOperationalSignal !== undefined) {
      try {
        destination.onOperationalSignal(signal);
        return;
      } catch {
        // A broken health callback must not silence the funnel entirely; fall
        // through to the last-resort warning. Never rethrow.
      }
    }

    emitFallbackWarning();
  };

  // The isolation boundary is absolute: even a secondary failure while
  // projecting or signaling the original throw (e.g. a thrown value whose
  // string coercion itself throws) must degrade to the last-resort warning,
  // never re-enter the session/content-funnel path.
  const signalTelemetryFailure = (
    kind: TelemetryOperationalSignalKind,
    error: unknown
  ) => {
    try {
      emitOperationalSignal({
        error: toOperationalSignalError(error),
        kind,
      });
    } catch {
      emitFallbackWarning();
    }
  };

  // ADR-058 §3: one-directional failure isolation. A sink or destination throw
  // is caught here at the telemetry boundary, converted to an operational
  // signal, and can never fail, block, or delay a kernel checkpoint or a
  // content-funnel commit. Every runtime telemetry record fans out to both the
  // emission sink and (if routed) the durable destination.
  const safeDeliver = (
    records: ReadonlyArray<TelemetryEvent | TelemetrySpan>
  ) => {
    if (destination === undefined) {
      return;
    }

    try {
      destination.deliver(records);
    } catch (error) {
      signalTelemetryFailure("delivery_failed", error);
    }
  };

  const safeEvent = (event: TelemetryEvent) => {
    try {
      sink.event(event);
    } catch (error) {
      signalTelemetryFailure("sink_failed", error);
    }

    safeDeliver([event]);
  };

  const safeSpan = (span: TelemetrySpan) => {
    try {
      sink.span(span);
    } catch (error) {
      signalTelemetryFailure("sink_failed", error);
    }

    safeDeliver([span]);
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

/**
 * Builds the {@link TelemetryLineage} for a record from the execution
 * handle's identifiers, defaulting `runId` to the handle's active run.
 */
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

/**
 * Standard attribute set stamped on runtime telemetry records: branch id,
 * active runner id, turn id, and the active run id when one exists.
 */
function baseAttributes(
  handle: RuntimeExecutionHandle,
  loopState: LoopState
): Record<string, TelemetryAttributeValue> {
  return {
    "tuvren.runtime.branch.id": handle.request.branchId,
    "tuvren.runtime.runner.id": loopState.activeRunnerId,
    ...(handle.getActiveRunId() === undefined
      ? {}
      : { "tuvren.runtime.run.id": handle.getActiveRunId() as string }),
    "tuvren.runtime.turn.id": handle.turnId,
  };
}

/**
 * Projects an arbitrary thrown value into the span error shape, defaulting
 * the code to `runtime_error`; returns `undefined` when there is no error.
 */
function createSpanError(error: unknown): TelemetrySpanError | undefined {
  if (error === undefined) {
    return undefined;
  }

  const projection = projectError(
    error instanceof Error ? error : new Error(coerceThrownToMessage(error))
  );
  return {
    code: projection.code ?? "runtime_error",
    message: projection.message,
  };
}

// A host can throw a value whose string coercion itself throws (a null-prototype
// object, a throwing `toString`). The telemetry boundary must stay throw-proof
// even while describing such a value (ADR-058 §3), so the coercion is guarded.
function coerceThrownToMessage(thrown: unknown): string {
  try {
    return String(thrown);
  } catch {
    return "thrown value could not be coerced to a message";
  }
}

// ADR-058 §2: resolve the construction-time `telemetry` routing union into its
// sink + destination channels. Detection is structural because the route object
// (`{ sink?; destination? }`) has all-optional members and would otherwise
// subsume the bare-sink/bare-destination forms: a value exposing `event`+`span`
// is a sink, a value exposing `deliver` is a destination, and anything else is
// treated as a route.
function normalizeTelemetryRouting(telemetry: TelemetryRouting | undefined): {
  destination?: TelemetryDestination;
  sink?: TuvrenTelemetrySink;
} {
  if (telemetry === undefined) {
    return {};
  }

  const shape = telemetry as {
    deliver?: unknown;
    event?: unknown;
    span?: unknown;
  };

  if (typeof shape.event === "function" && typeof shape.span === "function") {
    return { sink: telemetry as TuvrenTelemetrySink };
  }

  if (typeof shape.deliver === "function") {
    return { destination: telemetry as TelemetryDestination };
  }

  const route = telemetry as TelemetryRoute;
  return {
    ...(route.destination === undefined
      ? {}
      : { destination: route.destination }),
    ...(route.sink === undefined ? {} : { sink: route.sink }),
  };
}

// Project a caught throw into the already-secret-screened operational-signal
// error shape (ADR-058 §1 reuses `TelemetrySpanError`), applying the same
// summary sanitization the span emitter uses so a delivery failure cannot leak
// credential-shaped text onto the telemetry funnel (ADR-044).
function toOperationalSignalError(
  error: unknown
): TelemetrySpanError | undefined {
  const projected = createSpanError(error);
  if (projected === undefined) {
    return undefined;
  }

  return {
    code: projected.code,
    message: sanitizeTelemetryErrorSummary(projected.message),
  };
}
