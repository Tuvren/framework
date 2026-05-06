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

import { type HashString, TuvrenRuntimeError } from "@tuvren/core-types";
import type { DriverAssistantEventReconciliation } from "@tuvren/driver-api";
import type {
  RuntimeKernel as KrakenKernel,
  PathValue,
  RuntimeKernelRunLiveness,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type {
  ApprovalRequest,
  ApprovalResponse,
  RuntimeResolution,
  TurnEndEvent,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { inferFinishReason } from "./runtime-core-recovery.js";
import { isRecord, normalizeError } from "./runtime-core-shared.js";

export interface TurnLineageRecord {
  activeTurnId: string;
}

export function formatToolResultTaskId(
  orderIndex: number,
  callId: string
): string {
  return `tool_message_${orderIndex.toString().padStart(6, "0")}_${callId}`;
}

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

export function synthesizeResponse(
  messages: TuvrenMessage[],
  resolution: RuntimeResolution,
  emittedEvents: TuvrenStreamEvent[],
  assistantEventReconciliation: DriverAssistantEventReconciliation | undefined
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

export function createApprovalRejectionResolution(): RuntimeResolution {
  return {
    reason: "approval_rejected",
    type: "end_turn",
  };
}

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

export function isTurnLineageRecord(
  value: unknown
): value is TurnLineageRecord {
  return isRecord(value) && typeof value.activeTurnId === "string";
}

export function hasRunLivenessKernel(
  kernel: unknown
): kernel is KrakenKernel & RuntimeKernelRunLiveness {
  return (
    typeof kernel === "object" &&
    kernel !== null &&
    "runLiveness" in kernel &&
    typeof (kernel as { runLiveness?: unknown }).runLiveness === "object" &&
    (kernel as { runLiveness?: unknown }).runLiveness !== null
  );
}

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

export function createStaleRecoveryContendedError(): Error {
  return new TuvrenRuntimeError(
    "stale run recovery was claimed by another owner",
    {
      code: "runtime_execution_recovery_contended",
    }
  );
}

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

export function waitForDelay(
  durationMs: number,
  signal: AbortSignal
): Promise<void> {
  if (durationMs <= 0 || signal.aborted) {
    return Promise.resolve();
  }

  return awaitableDelay(durationMs, signal);
}

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
