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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core";
import type { TurnEndEvent, TuvrenStreamEvent } from "@tuvren/core/events";
import type { RuntimeResolution } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type { RunnerAssistantEventReconciliation } from "@tuvren/core/runner";
import type { ApprovalRequest, ApprovalResponse } from "@tuvren/core/tools";
import type {
  PathValue,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { inferFinishReason } from "./runtime-core-recovery.js";
import { isRecord, normalizeError } from "./runtime-core-shared.js";

/**
 * Shape of the durable `turn.lineage` record stored on a turn tree, naming
 * the turn that is currently active on the branch.
 */
export interface TurnLineageRecord {
  /** Id of the branch's currently active turn. */
  activeTurnId: string;
}

/**
 * Build the deterministic task id for a tool-result message.
 *
 * The order index is zero-padded to six digits so ids sort lexicographically
 * in tool-call order, e.g. `tool_message_000003_<callId>`.
 */
export function formatToolResultTaskId(
  orderIndex: number,
  callId: string
): string {
  return `tool_message_${orderIndex.toString().padStart(6, "0")}_${callId}`;
}

/**
 * Rank a resolution for {@link composeResolutions}.
 *
 * Higher wins: hard fail (6) > pause (5) > handoff (4) > end_turn (3) >
 * soft fail (2) > continue_iteration (1) > unknown (0).
 */
export function resolutionPriority(resolution: RuntimeResolution): number {
  switch (resolution.type) {
    case "fail":
      return resolution.fatality === "hard" ? 6 : 2;
    case "pause":
      return 5;
    case "handoff":
      return 4;
    case "end_turn":
      return 3;
    case "continue_iteration":
      return 1;
    default:
      return 0;
  }
}

/**
 * Combine two resolutions, keeping the one with the higher
 * {@link resolutionPriority}; the base resolution wins ties and is returned
 * unchanged when there is no override.
 */
export function composeResolutions(
  baseResolution: RuntimeResolution,
  overrideResolution: RuntimeResolution | undefined
): RuntimeResolution {
  if (overrideResolution === undefined) {
    return baseResolution;
  }

  return resolutionPriority(baseResolution) >=
    resolutionPriority(overrideResolution)
    ? baseResolution
    : overrideResolution;
}

/**
 * Map a runtime resolution to the `turn.end` status it terminates the turn
 * with: `paused` for pause, `failed` for fail (or an unknown type), and
 * `completed` for continue_iteration, end_turn, and handoff.
 */
export function resolutionToPhase(
  resolution: RuntimeResolution
): TurnEndEvent["status"] {
  switch (resolution.type) {
    case "pause":
      return "paused";
    case "fail":
      return "failed";
    case "continue_iteration":
    case "end_turn":
    case "handoff":
      return "completed";
    default:
      return "failed";
  }
}

/**
 * Synthesize the model response for an iteration from its durable messages
 * and emitted stream events.
 *
 * The first assistant message provides the parts and provider metadata. The
 * finish reason comes from the last `message.done` event when one was
 * emitted, unless the runner declared `allow_final_sequence_divergence`, in
 * which case the durable message is authoritative (a failing resolution
 * always yields `"error"`). Usage is taken from the last `message.done`
 * event. Without an assistant message an empty response is returned with
 * finish reason `"error"` or `"stop"` depending on the resolution.
 */
export function synthesizeResponse(
  messages: TuvrenMessage[],
  resolution: RuntimeResolution,
  emittedEvents: TuvrenStreamEvent[],
  assistantEventReconciliation: RunnerAssistantEventReconciliation | undefined
): TuvrenModelResponse {
  const assistantMessage = messages.find(
    (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
      message.role === "assistant"
  );
  const lastMessageDoneEvent = findLastMessageDoneEvent(emittedEvents);

  if (assistantMessage !== undefined) {
    const durableFinishReason =
      resolution.type === "fail"
        ? "error"
        : inferFinishReason(assistantMessage);
    const finishReason =
      assistantEventReconciliation === "allow_final_sequence_divergence"
        ? durableFinishReason
        : (lastMessageDoneEvent?.finishReason ?? durableFinishReason);

    return {
      finishReason,
      parts: assistantMessage.parts,
      providerMetadata: assistantMessage.providerMetadata,
      usage: lastMessageDoneEvent?.usage,
    };
  }

  return {
    finishReason: resolution.type === "fail" ? "error" : "stop",
    parts: [],
  };
}

/**
 * Return the last `message.done` event in the emitted stream, or `undefined`
 * when none was emitted.
 */
export function findLastMessageDoneEvent(
  events: TuvrenStreamEvent[]
): Extract<TuvrenStreamEvent, { type: "message.done" }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type === "message.done") {
      return event;
    }
  }

  return undefined;
}

/**
 * Build an approval response that rejects every tool call in the request,
 * used when a paused approval is cancelled instead of being answered.
 */
export function createRejectedApprovalResponse(
  request: ApprovalRequest
): ApprovalResponse {
  return {
    decisions: request.toolCalls.map((toolCall) => ({
      callId: toolCall.callId,
      type: "reject",
    })),
  };
}

/**
 * Build the `end_turn` resolution (reason `approval_rejected`) used when all
 * pending tool approvals were rejected.
 */
export function createApprovalRejectionResolution(): RuntimeResolution {
  return {
    reason: "approval_rejected",
    type: "end_turn",
  };
}

/**
 * Narrow a kernel tree path value to a single hash or `null` (path absent).
 *
 * @throws TuvrenRuntimeError with code `invalid_path_value_shape` when the
 *   value is an ordered array, i.e. the path was not a single-hash path.
 */
export function toOptionalHash(value: PathValue): HashString | null {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return null;
  }

  throw new TuvrenRuntimeError("expected a single-hash path value", {
    code: "invalid_path_value_shape",
    details: {
      value,
    },
  });
}

/**
 * Narrow a kernel tree path value to an ordered hash array.
 *
 * @throws TuvrenRuntimeError with code `invalid_path_value_shape` when the
 *   value is not an array, i.e. the path was not an ordered-collection path.
 */
export function toOrderedHashArray(value: PathValue): HashString[] {
  if (Array.isArray(value)) {
    return value;
  }

  throw new TuvrenRuntimeError("expected an ordered hash array path value", {
    code: "invalid_path_value_shape",
    details: {
      value,
    },
  });
}

/**
 * Type guard for {@link TurnLineageRecord}: an object carrying a string
 * `activeTurnId`.
 */
export function isTurnLineageRecord(
  value: unknown
): value is TurnLineageRecord {
  return isRecord(value) && typeof value.activeTurnId === "string";
}

/**
 * Type guard detecting whether a kernel exposes the optional run-liveness
 * surface (a non-null `runLiveness` object), enabling leased runs and lease
 * renewal.
 */
export function hasRunLivenessKernel(
  kernel: unknown
): kernel is RuntimeKernel & RuntimeKernelRunLiveness {
  return (
    typeof kernel === "object" &&
    kernel !== null &&
    "runLiveness" in kernel &&
    typeof (kernel as { runLiveness?: unknown }).runLiveness === "object" &&
    (kernel as { runLiveness?: unknown }).runLiveness !== null
  );
}

/**
 * Normalize an error from lease renewal, translating kernel lease-fence
 * errors (see {@link isRunLeaseFenceError}) into a
 * `runtime_execution_lease_lost` TuvrenRuntimeError that preserves the
 * original code and message in its details; other errors are returned
 * normalized but otherwise unchanged.
 */
export function createRunLeaseLostError(error: unknown): Error {
  const normalizedError = normalizeError(error);

  if (!isRunLeaseFenceError(normalizedError)) {
    return normalizedError;
  }

  return new TuvrenRuntimeError("execution lease lost", {
    code: "runtime_execution_lease_lost",
    details: {
      cause:
        isRecord(normalizedError) && typeof normalizedError.code === "string"
          ? normalizedError.code
          : undefined,
      message: normalizedError.message,
    },
  });
}

/**
 * Build the `runtime_execution_recovery_contended` error raised when another
 * owner claimed the stale-run recovery this session attempted.
 */
export function createStaleRecoveryContendedError(): Error {
  return new TuvrenRuntimeError(
    "stale run recovery was claimed by another owner",
    {
      code: "runtime_execution_recovery_contended",
    }
  );
}

/**
 * Whether an error carries one of the kernel run-lease fencing codes
 * (expired, not leased, owner mismatch, or token mismatch), meaning this
 * owner no longer holds execution authority for the run.
 */
export function isRunLeaseFenceError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") {
    return false;
  }

  return (
    error.code === "kernel_runtime_run_lease_expired" ||
    error.code === "kernel_runtime_run_not_leased" ||
    error.code === "kernel_runtime_run_lease_owner_mismatch" ||
    error.code === "kernel_runtime_run_lease_token_mismatch"
  );
}

/**
 * Wait for `durationMs`, resolving immediately for a non-positive duration or
 * an already-aborted signal. Like {@link awaitableDelay}, an abort resolves
 * the promise early — it never rejects.
 */
export function waitForDelay(
  durationMs: number,
  signal: AbortSignal
): Promise<void> {
  if (durationMs <= 0 || signal.aborted) {
    return Promise.resolve();
  }

  return awaitableDelay(durationMs, signal);
}

/**
 * Abortable timer: resolves after `durationMs` or as soon as the signal
 * aborts, whichever comes first, always cleaning up the timeout and abort
 * listener. Never rejects; callers that must distinguish abort from timeout
 * should check `signal.aborted` afterwards.
 */
export function awaitableDelay(
  durationMs: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Assert that a turn-tree schema satisfies the framework's contract.
 *
 * The schema must define the ordered `messages` path and the single-value
 * `context.manifest`, `turn.lineage`, and `runtime.status` paths, and must
 * declare incorporation rules mapping the `message`, `context_manifest`,
 * `turn_lineage`, and `runtime_status` object types to those paths.
 *
 * @throws TuvrenRuntimeError with code `invalid_framework_schema` naming the
 *   first missing or mismatched path or incorporation rule.
 */
export function assertFrameworkSchemaCompatibility(
  schema: TurnTreeSchema
): void {
  const requiredPathKinds = new Map<string, "ordered" | "single">([
    ["messages", "ordered"],
    ["context.manifest", "single"],
    ["turn.lineage", "single"],
    ["runtime.status", "single"],
  ]);
  const requiredIncorporationRules = new Map<string, string>([
    ["message", "messages"],
    ["context_manifest", "context.manifest"],
    ["turn_lineage", "turn.lineage"],
    ["runtime_status", "runtime.status"],
  ]);

  for (const [path, collection] of requiredPathKinds) {
    const definition = schema.paths.find(
      (candidate) => candidate.path === path
    );

    if (definition?.collection !== collection) {
      throw new TuvrenRuntimeError(
        `schema "${schema.schemaId}" must define ${collection} path "${path}"`,
        {
          code: "invalid_framework_schema",
          details: {
            path,
            schemaId: schema.schemaId,
          },
        }
      );
    }
  }

  for (const [objectType, targetPath] of requiredIncorporationRules) {
    const rule = schema.incorporationRules.find(
      (candidate) => candidate.objectType === objectType
    );

    if (rule?.targetPath !== targetPath) {
      throw new TuvrenRuntimeError(
        `schema "${schema.schemaId}" must incorporate "${objectType}" into "${targetPath}"`,
        {
          code: "invalid_framework_schema",
          details: {
            objectType,
            schemaId: schema.schemaId,
            targetPath,
          },
        }
      );
    }
  }
}
