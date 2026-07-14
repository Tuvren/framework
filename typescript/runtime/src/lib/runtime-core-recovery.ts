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

import { isDeepStrictEqual } from "node:util";
import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  ContextEngineeringPlan,
  InputSignal,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { assertTuvrenMessage } from "@tuvren/core/messages";
import {
  decodeDeterministicKernelRecord,
  type RecoveryState,
} from "@tuvren/kernel-protocol";
import {
  createExecutionCancelledError,
  isRecord,
  normalizeError,
} from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext } from "./runtime-execution-types.js";

/**
 * Runtime status record staged into the kernel turn tree at
 * `runtime.status`, making the execution phase durably recoverable.
 */
export interface DurableRuntimeStatus {
  /** Name of the agent active when the status was staged. */
  activeAgent?: string;
  /** True when a failed turn produced partial assistant output. */
  partial?: boolean;
  /** Reason string for a `paused` state. */
  pauseReason?: string;
  /** Durable execution phase of the turn. */
  state: "completed" | "failed" | "paused" | "running";
}

/**
 * Outcome of attempting to recover a branch whose previous execution's run
 * lease expired.
 *
 * Produced by `recoverExpiredExecutionBranchIfNeeded` in
 * `runtime-core-expired-recovery.ts` and consumed by the execution prelude
 * to decide how the new execution should proceed.
 */
export interface ExpiredExecutionRecovery {
  /** Active-agent name recovered from the durable turn tree, if readable. */
  activeAgentName?: string;
  /** Estimated iteration count already completed by the expired execution. */
  iterationCount?: number;
  /**
   * How the new execution should resume: `reuse_turn` re-enters the
   * recovered turn from the input step, `skip_fresh_prelude` continues an
   * in-progress turn without re-running the fresh-turn prelude, and
   * `complete_terminal_status` only replays the recovered terminal status.
   */
  mode?: "reuse_turn" | "skip_fresh_prelude" | "complete_terminal_status";
  /** True when the recovered turn is missing the incoming input message. */
  needsInputReincorporation?: boolean;
  /** True when the expired run was successfully preempted by this owner. */
  preempted: boolean;
  /**
   * True when another owner won the preemption race (the run was no longer
   * running or its lease had not expired), so this execution must not
   * recover it.
   */
  recoveryContended?: boolean;
  /** Durable runtime status recovered from the turn tree, if readable. */
  runtimeStatus?: DurableRuntimeStatus;
  /** Turn ID of the recovered expired run. */
  turnId?: string;
}

/**
 * Terminal result of the execution loop for one turn.
 */
export interface LoopOutcome {
  /** True when the turn failed after producing partial assistant output. */
  partial?: boolean;
  /** Resumable pause state; present only for `pause` resolutions. */
  pauseContext?: PauseContext;
  /** The resolution that ended the loop. */
  resolution: RuntimeResolution;
}

/**
 * Infer a provider-style finish reason for an assistant message.
 *
 * Returns `"tool_call"` when the message contains any tool-call part and
 * `"stop"` otherwise; the wider return type mirrors the finish-reason union
 * used by callers, but only those two values are produced here.
 */
export function inferFinishReason(
  message: Extract<TuvrenMessage, { role: "assistant" }>
): "content_filter" | "error" | "length" | "stop" | "tool_call" {
  return message.parts.some((part) => part.type === "tool_call")
    ? "tool_call"
    : "stop";
}

/**
 * Narrow a context-policy evaluation result to an actionable
 * {@link ContextEngineeringPlan}, excluding the `{ action: "none" }` no-op.
 */
export function isContextEngineeringPlan(
  value: ContextEngineeringPlan | { action: "none" }
): value is ContextEngineeringPlan {
  return value.action !== "none";
}

/**
 * Decode a deterministic kernel record payload into a {@link TuvrenMessage}.
 *
 * @param payload - Encoded kernel record bytes.
 * @param label - Diagnostic label used in the assertion error on shape
 *   mismatch.
 * @throws When the decoded value is not a valid Tuvren message.
 */
export function decodeKrakenMessageRecord(
  payload: Uint8Array,
  label: string
): TuvrenMessage {
  const decoded = decodeDeterministicKernelRecord(payload);
  assertTuvrenMessage(decoded, label);
  return decoded;
}

/**
 * Build a hard-fail {@link LoopOutcome} when the handle's abort signal has
 * fired, or `undefined` when execution has not been cancelled.
 *
 * @param partial - Whether partial assistant output was already produced.
 * @see createCancelledResolution
 */
export function createCancelledLoopOutcome(
  handle: RuntimeExecutionHandle,
  partial = false
): LoopOutcome | undefined {
  const cancelledResolution = createCancelledResolution(handle);

  if (cancelledResolution === undefined) {
    return undefined;
  }

  return {
    partial,
    resolution: cancelledResolution,
  };
}

/**
 * Build a hard-fail resolution from the handle's abort state.
 *
 * Returns `undefined` when the abort signal has not fired. When it has, the
 * abort reason is used as the failure error if it is an `Error`; otherwise a
 * generic execution-cancelled error is created.
 */
export function createCancelledResolution(
  handle: RuntimeExecutionHandle
): RuntimeResolution | undefined {
  if (!handle.abortSignal.aborted) {
    return undefined;
  }

  return {
    error:
      handle.abortSignal.reason instanceof Error
        ? handle.abortSignal.reason
        : createExecutionCancelledError(),
    fatality: "hard",
    type: "fail",
  };
}

/**
 * Report whether in-flight runner progress must be discarded because the
 * execution was aborted specifically for run-lease loss.
 *
 * True only when the handle is aborted and the abort reason carries the
 * `runtime_execution_lease_lost` error code.
 */
export function shouldDiscardRunnerProgressAfterLeaseLoss(
  handle: RuntimeExecutionHandle
): boolean {
  const resolution = createCancelledResolution(handle);

  if (resolution === undefined) {
    return false;
  }

  if (resolution.type !== "fail") {
    return false;
  }

  return isRunLeaseLostError(resolution.error);
}

/**
 * Report whether an error value carries the `runtime_execution_lease_lost`
 * code, i.e. the run's kernel lease was fenced away from this execution.
 */
export function isRunLeaseLostError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error.code === "runtime_execution_lease_lost";
}

/**
 * Report whether the incoming input signal matches the last user message of
 * a recovered turn (convenience wrapper over
 * {@link classifyRecoveredTurnSignalState} that treats only `"match"` as
 * true).
 */
export function doesSignalMatchRecoveredTurn(
  signal: InputSignal,
  messages: readonly TuvrenMessage[]
): boolean {
  return classifyRecoveredTurnSignalState(signal, messages) === "match";
}

/**
 * Compare the incoming input signal against the most recent user message in
 * a recovered turn's messages.
 *
 * @returns `"missing"` when the recovered turn has no user message,
 *   `"match"` when the last user message's parts deep-equal the signal's
 *   parts, and `"mismatch"` otherwise.
 */
export function classifyRecoveredTurnSignalState(
  signal: InputSignal,
  messages: readonly TuvrenMessage[]
): "match" | "mismatch" | "missing" {
  const recoveredUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  if (recoveredUserMessage === undefined) {
    return "missing";
  }

  return isDeepStrictEqual(recoveredUserMessage.parts, signal.parts)
    ? "match"
    : "mismatch";
}

/**
 * Map a preempted run's recovered step sequence to a resumption mode.
 *
 * The first step ID of the recovered run determines the phase it died in:
 * `incorporate_input` recoveries reuse the turn; iteration-adjacent steps
 * (`iterate`, `commit_extension_state`, `context_engineering`,
 * `incorporate_steering`, `handoff_context`, `resume_running_status`) skip
 * the fresh-turn prelude; `finalize_turn_status` only completes the terminal
 * status.
 *
 * @throws TuvrenRuntimeError with code
 *   `unsupported_stale_run_recovery_phase` when the recovered step is not a
 *   phase that can be safely resumed.
 */
export function classifyRecoveredExecutionMode(
  recoveryState: RecoveryState
): ExpiredExecutionRecovery["mode"] {
  const recoveredStepId = recoveryState.stepSequence[0]?.id;

  switch (recoveredStepId) {
    case "incorporate_input":
      return "reuse_turn";
    case "iterate":
    case "commit_extension_state":
    case "context_engineering":
    case "incorporate_steering":
    case "handoff_context":
    case "resume_running_status":
      return "skip_fresh_prelude";
    case "finalize_turn_status":
      return "complete_terminal_status";
    default:
      throw new TuvrenRuntimeError(
        "stale run recovery cannot safely resume the recovered phase",
        {
          code: "unsupported_stale_run_recovery_phase",
          details: {
            lastCompletedStepId: recoveryState.lastCompletedStepId,
            recoveredStepId: recoveredStepId ?? null,
          },
        }
      );
  }
}

/**
 * Interpret a preemption failure as a lost stale-recovery race.
 *
 * Returns a `recoveryContended` result when the kernel reports the run is no
 * longer running (`kernel_runtime_run_not_running`) or its lease has not
 * expired (`kernel_runtime_run_lease_not_expired`) — both meaning another
 * owner recovered or still holds the run. Returns `undefined` for any other
 * error, which the caller should rethrow.
 */
export function classifyStaleRecoveryRace(
  error: unknown
): ExpiredExecutionRecovery | undefined {
  if (!isRecord(error) || typeof error.code !== "string") {
    return undefined;
  }

  switch (error.code) {
    case "kernel_runtime_run_not_running":
    case "kernel_runtime_run_lease_not_expired":
      return {
        preempted: false,
        recoveryContended: true,
      };
    default:
      return undefined;
  }
}

/**
 * Report whether buffered runner events must be suppressed instead of
 * flushed to the canonical stream.
 *
 * Suppression applies only to hard failures caused by invalid runner output
 * (`invalid_runner_result`, `invalid_runner_resolution`,
 * `invalid_stream_event`), where the buffered events cannot be trusted.
 */
export function shouldSuppressBufferedRunnerEvents(
  resolution: RuntimeResolution
): boolean {
  if (resolution.type !== "fail" || resolution.fatality !== "hard") {
    return false;
  }

  if (!isRecord(resolution.error)) {
    return false;
  }

  const code = resolution.error.code;

  return (
    typeof code === "string" &&
    (code === "invalid_runner_result" ||
      code === "invalid_runner_resolution" ||
      code === "invalid_stream_event")
  );
}

/** Report whether any message in the list is an assistant message. */
export function hasAssistantOutputMessages(messages: TuvrenMessage[]): boolean {
  return messages.some((message) => message.role === "assistant");
}

/**
 * Normalize an unknown recovery failure into an `Error` instance
 * (delegates to the shared runtime error normalizer).
 */
export function normalizeRecoveryError(error: unknown): Error {
  return normalizeError(error);
}
