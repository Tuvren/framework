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

import type {
  CapabilityInvocationAttribution,
  ExecutionClass,
} from "./capability-shapes.js";
import type { EpochMs, HashString } from "./kernel-records.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ContextManifest,
  ProviderUsage,
} from "./runtime-data-contract-shapes.js";

/**
 * Multi-agent attribution carried on every {@link TuvrenStreamEvent}
 * (KrakenFrameworkSpecification §1.8): the emitting agent name, and
 * optional runner, thread, and worker identifiers for descendant/worker
 * event attribution in orchestration.
 *
 * @see {@link isEventSource} for the runtime guard.
 */
export interface EventSource {
  agent: string;
  runner?: string;
  threadId?: string;
  workerId?: string;
}

/**
 * Alias for {@link EventSource} used at runner-facing seams
 * (KrakenFrameworkSpecification §5.6) where the attribution is specifically
 * the source a runner stamps onto emitted events, as distinct from
 * framework-owned lifecycle event sources.
 */
export type RunnerAttributedEventSource = EventSource;

/**
 * The serializable, data-only projection of an error carried by the
 * `error` stream event (KrakenFrameworkSpecification §1.8). Deliberately
 * excludes the `Error` instance itself so the event stays JSON-serializable
 * across the wire.
 *
 * @see {@link isTuvrenErrorProjection} for the runtime guard.
 */
export interface TuvrenErrorProjection {
  code?: string;
  details?: unknown;
  message: string;
}

/** The `error` branch of a {@link ValidationResult}: a failed schema check. */
export interface ValidationErrorPayload {
  details?: unknown;
  message: string;
}

/**
 * Emitted once at the start of a Turn (KrakenFrameworkSpecification §1.8).
 * `resumedFrom`, when present, is the TurnNode hash of the pause point being
 * resumed; absent means a fresh Turn. Protocol adapters use its presence to
 * distinguish fresh Turns from resumed Turns.
 */
export interface TurnStartEvent {
  resumedFrom?: HashString;
  source?: EventSource;
  threadId: string;
  timestamp: EpochMs;
  turnId: string;
  type: "turn.start";
}

/**
 * Emitted once when a Turn reaches a terminal or paused stop
 * (KrakenFrameworkSpecification §1.8). `status` mirrors the terminal
 * `ExecutionStatus.phase` for that outcome.
 */
export interface TurnEndEvent {
  source?: EventSource;
  status: "completed" | "paused" | "failed";
  timestamp: EpochMs;
  turnId: string;
  type: "turn.end";
}

/** Lifecycle {@link TuvrenStreamEvent}: fires at the start of each iteration. */
export interface IterationStartEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  type: "iteration.start";
}

/** Lifecycle {@link TuvrenStreamEvent}: fires at the end of each iteration. */
export interface IterationEndEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  type: "iteration.end";
}

/**
 * Model-output {@link TuvrenStreamEvent}: precedes all content events for a
 * given assistant `messageId`.
 */
export interface MessageStartEvent {
  messageId: string;
  role: "assistant";
  source?: EventSource;
  timestamp: EpochMs;
  type: "message.start";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental text fragment for
 * `messageId`, arriving in order.
 */
export interface TextDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "text.delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the complete accumulated text for
 * `messageId` once the text run finishes.
 */
export interface TextDoneEvent {
  messageId: string;
  source?: EventSource;
  text: string;
  timestamp: EpochMs;
  type: "text.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental reasoning/thinking
 * fragment for `messageId`.
 */
export interface ReasoningDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "reasoning.delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: signals the reasoning run for
 * `messageId` has finished.
 */
export interface ReasoningDoneEvent {
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "reasoning.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental structured-output
 * fragment for `messageId`, arriving in order.
 */
export interface StructuredDeltaEvent {
  delta: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "structured.delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the complete parsed structured
 * output for `messageId`, following all of its `structured.delta` events.
 */
export interface StructuredDoneEvent {
  data: unknown;
  messageId: string;
  name?: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "structured.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: one complete file content part,
 * emitted between `message.start` and `message.done`.
 */
export interface FileDoneEvent {
  data: string | Uint8Array;
  filename?: string;
  mediaType: string;
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "file.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the model has requested a tool
 * call; precedes that call's `tool_call.args_delta` events. Distinct from
 * `tool.start`, which marks framework-side execution.
 */
export interface ToolCallStartEvent {
  callId: string;
  messageId: string;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.start";
}

/**
 * Model-output {@link TuvrenStreamEvent}: an incremental fragment of a
 * requested tool call's argument text.
 */
export interface ToolCallArgsDeltaEvent {
  callId: string;
  delta: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.args_delta";
}

/**
 * Model-output {@link TuvrenStreamEvent}: the complete, parsed input for a
 * requested tool call.
 */
export interface ToolCallDoneEvent {
  callId: string;
  input: unknown;
  name: string;
  providerMetadata?: Record<string, unknown>;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool_call.done";
}

/**
 * Model-output {@link TuvrenStreamEvent}: closes out `messageId`, following
 * all of that message's content events.
 */
export interface MessageDoneEvent {
  finishReason: "stop" | "tool_call" | "length" | "error" | "content_filter";
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "message.done";
  usage?: ProviderUsage;
}

/**
 * Tool-execution {@link TuvrenStreamEvent}: emitted only after approval has
 * resolved, immediately before the framework enters the first executable
 * aroundTool/execute step for this call — never merely because the model
 * requested the tool (that is `tool_call.done`).
 */
export interface ToolStartEvent {
  /** Additive per ADR-0046 AW006: execution-class and owner attribution. */
  attribution?: CapabilityInvocationAttribution;
  callId: string;
  input: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool.start";
}

/**
 * Tool-execution {@link TuvrenStreamEvent}: the outcome of a tool
 * invocation, emitted after the aroundTool chain returns for that call.
 */
export interface ToolResultEvent {
  /** Additive per ADR-0046 AW006: execution-class and owner attribution. */
  attribution?: CapabilityInvocationAttribution;
  callId: string;
  isError?: boolean;
  name: string;
  output: unknown;
  source?: EventSource;
  timestamp: EpochMs;
  type: "tool.result";
}

/**
 * Lifecycle audit event for Tuvren-server invocations. Carries only structural
 * lineage keys and lifecycle identifiers — no input, output, or metadata values
 * that could contain secret material. (AX005)
 */
export interface ToolAuditEvent {
  /** Retry attempt number (1-based), present when lifecycle is retry_attempt. */
  attempt?: number;
  /** Unique call identifier matching the tool_call / tool_result pair. */
  callId: string;
  /** Stable tool name; used as the capability id for tuvren-server bindings. */
  capabilityId: string;
  executionClass: ExecutionClass;
  /**
   * Which lifecycle point this event records.
   * "cancelled" is reserved for future use when cooperative cancellation
   * emits an explicit audit signal; currently observable via handle.cancel()
   * + the existing event stream (canCancel: true in CapabilityObservation).
   */
  lifecycle:
    | "input_validated"
    | "output_validated"
    | "policy_denied"
    | "retry_attempt"
    | "rate_limited"
    | "cancelled";
  runId: string;
  source?: EventSource;
  timestamp: EpochMs;
  turnId: string;
  type: "tool.audit";
  /** Whether the validation passed, present for input_validated / output_validated. */
  validationPassed?: boolean;
}

/** Control {@link TuvrenStreamEvent}: a Turn has paused on `request`. */
export interface ApprovalRequestedEvent {
  request: ApprovalRequest;
  source?: EventSource;
  timestamp: EpochMs;
  type: "approval.requested";
}

/** Control {@link TuvrenStreamEvent}: the paused Turn has resumed with `response`. */
export interface ApprovalResolvedEvent {
  response: ApprovalResponse;
  source?: EventSource;
  timestamp: EpochMs;
  type: "approval.resolved";
}

/**
 * Control {@link TuvrenStreamEvent}: a `steer()` signal was consumed at an
 * iteration boundary and incorporated as `messageId`.
 */
export interface SteeringIncorporatedEvent {
  messageId: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "steering.incorporated";
}

/**
 * Control {@link TuvrenStreamEvent}: an error condition occurred. `fatal`
 * distinguishes a Turn-terminating error from a recorded but non-terminal
 * one (e.g. `fail(soft)`).
 */
export interface ErrorEvent {
  error: TuvrenErrorProjection;
  fatal: boolean;
  source?: EventSource;
  timestamp: EpochMs;
  type: "error";
}

/**
 * The internal event vocabulary: a discriminated union on `type` over every
 * event the framework and its runners emit (KrakenFrameworkSpecification
 * §1.8). Every event carries `type`, `timestamp`, and optional `source` for
 * multi-agent attribution. Grouped into lifecycle, model-output, tool-
 * execution, control, state, and custom events. Protocol adapters consume
 * this canonical stream and bridge it into AG-UI, ACP, OpenResponses-style
 * transports, or any other host protocol.
 *
 * @see {@link isTuvrenStreamEvent} for the runtime guard.
 */
export type TuvrenStreamEvent =
  | TurnStartEvent
  | TurnEndEvent
  | IterationStartEvent
  | IterationEndEvent
  | MessageStartEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ReasoningDeltaEvent
  | ReasoningDoneEvent
  | FileDoneEvent
  | StructuredDeltaEvent
  | StructuredDoneEvent
  | ToolCallStartEvent
  | ToolCallArgsDeltaEvent
  | ToolCallDoneEvent
  | MessageDoneEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolAuditEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | SteeringIncorporatedEvent
  | StateSnapshotEvent
  | StateCheckpointEvent
  | ErrorEvent
  | CustomEvent;

/**
 * State {@link TuvrenStreamEvent}: an observability affordance carrying the
 * current `manifest`. Standardized but optional — hosts and protocol
 * adapters must tolerate its absence.
 */
export interface StateSnapshotEvent {
  manifest: ContextManifest;
  source?: EventSource;
  timestamp: EpochMs;
  type: "state.snapshot";
}

/**
 * State {@link TuvrenStreamEvent}: an observability affordance marking a
 * durable checkpoint at `turnNodeHash`. Standardized but optional — hosts
 * and protocol adapters must tolerate its absence.
 */
export interface StateCheckpointEvent {
  iterationCount: number;
  source?: EventSource;
  timestamp: EpochMs;
  turnNodeHash: HashString;
  type: "state.checkpoint";
}

/**
 * Extension-defined {@link TuvrenStreamEvent} injected via `ctx.emit`.
 * `name` and `data` are entirely extension-owned; the framework does not
 * interpret them.
 */
export interface CustomEvent {
  data: unknown;
  name: string;
  source?: EventSource;
  timestamp: EpochMs;
  type: "custom";
}
