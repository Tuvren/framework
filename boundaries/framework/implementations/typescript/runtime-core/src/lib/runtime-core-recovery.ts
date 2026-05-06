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
import { TuvrenRuntimeError } from "@tuvren/core-types";
import {
  decodeDeterministicKernelRecord,
  type RecoveryState,
} from "@tuvren/kernel-protocol";
import type {
  ContextEngineeringPlan,
  InputSignal,
  RuntimeResolution,
  TuvrenMessage,
} from "@tuvren/runtime-api";
import { assertTuvrenMessage } from "@tuvren/runtime-api";
import {
  createExecutionCancelledError,
  isRecord,
  normalizeError,
} from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { PauseContext } from "./runtime-execution-types.js";

export interface DurableRuntimeStatus {
  activeAgent?: string;
  partial?: boolean;
  pauseReason?: string;
  state: "completed" | "failed" | "paused" | "running";
}

export interface ExpiredExecutionRecovery {
  activeAgentName?: string;
  iterationCount?: number;
  mode?: "reuse_turn" | "skip_fresh_prelude" | "complete_terminal_status";
  needsInputReincorporation?: boolean;
  preempted: boolean;
  recoveryContended?: boolean;
  runtimeStatus?: DurableRuntimeStatus;
  turnId?: string;
}

export interface LoopOutcome {
  partial?: boolean;
  pauseContext?: PauseContext;
  resolution: RuntimeResolution;
}

export function inferFinishReason(
  message: Extract<TuvrenMessage, { role: "assistant" }>
): "content_filter" | "error" | "length" | "stop" | "tool_call" {
  return message.parts.some((part) => part.type === "tool_call")
    ? "tool_call"
    : "stop";
}

export function isContextEngineeringPlan(
  value: ContextEngineeringPlan | { action: "none" }
): value is ContextEngineeringPlan {
  return value.action !== "none";
}

export function decodeKrakenMessageRecord(
  payload: Uint8Array,
  label: string
): TuvrenMessage {
  const decoded = decodeDeterministicKernelRecord(payload);
  assertTuvrenMessage(decoded, label);
  return decoded;
}

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

export function shouldDiscardDriverProgressAfterLeaseLoss(
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

export function isRunLeaseLostError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error.code === "runtime_execution_lease_lost";
}

export function doesSignalMatchRecoveredTurn(
  signal: InputSignal,
  messages: readonly TuvrenMessage[]
): boolean {
  return classifyRecoveredTurnSignalState(signal, messages) === "match";
}

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

export function shouldSuppressBufferedDriverEvents(
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
    (code === "invalid_driver_result" ||
      code === "invalid_driver_resolution" ||
      code === "invalid_stream_event")
  );
}

export function hasAssistantOutputMessages(messages: TuvrenMessage[]): boolean {
  return messages.some((message) => message.role === "assistant");
}

export function normalizeRecoveryError(error: unknown): Error {
  return normalizeError(error);
}
