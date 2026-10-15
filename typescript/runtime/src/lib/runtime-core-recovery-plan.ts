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

import { TuvrenRecoveryError } from "@tuvren/core";
import type { ToolCallPart, TuvrenMessage } from "@tuvren/core/messages";
import type {
  RecoveryState,
  RuntimeKernel,
  StagedResult,
} from "@tuvren/kernel-protocol";

import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import { readMessage } from "./runtime-core-head-state.js";
import type { HeadState } from "./runtime-core-loop.js";

/** Durable action the runtime should take for a recovered iterate step. */
export type InterruptedIterationRecoveryDisposition =
  | "re_infer"
  | "resume_tool_batch"
  | "completed_tool_batch";

/**
 * Durable reconstruction of the tool batch interrupted by process death.
 *
 * This plan deliberately retains the decoded assistant message and its
 * original tool-call parts. KRT-CR003 consumes it to resume the missing calls
 * without asking the model to mint replacement identities.
 */
export interface InterruptedIterationRecoveryPlan {
  /** Original durable assistant message, absent for model-stream crashes. */
  assistantMessage?: Extract<TuvrenMessage, { role: "assistant" }>;
  /** Original call IDs that already have a durable decoded tool result. */
  completedCallIds: string[];
  /** Whether to re-infer, resume missing calls, or continue past a full batch. */
  disposition: InterruptedIterationRecoveryDisposition;
  /** Original tool-call parts without a matching durable result. */
  missingToolCalls: ToolCallPart[];
  /** Every original tool-call part in assistant-message order. */
  originalToolCalls: ToolCallPart[];
}

/** Inputs needed to reconstruct one interrupted iterate step. */
export interface InterruptedIterationRecoveryPlanInput {
  kernel: RuntimeKernel;
  payloadCodecBinding: PayloadCodecBinding;
  recoveredHeadState: HeadState;
  recoveryState: RecoveryState;
  staleRunId: string;
  turnId: string;
}

/**
 * Reconstruct an interrupted tool batch from durable committed and staged
 * message objects.
 *
 * The recovery state's consumed results identify messages reactively
 * checkpointed by stale preemption. Uncommitted results cover the wider
 * protocol-valid crash shape. Both are resolved by object hash and decoded
 * through the same payload-codec seam as ordinary branch-head reads.
 * Fulfillment is joined only by decoded `ToolResultPart.callId`; `taskId` is
 * intentionally ignored because different runtime paths spell it differently.
 */
export async function deriveInterruptedIterationRecoveryPlan(
  input: InterruptedIterationRecoveryPlanInput
): Promise<InterruptedIterationRecoveryPlan> {
  const interruptedMessages = await readInterruptedMessages(input);
  const assistantMessage = [...interruptedMessages]
    .reverse()
    .find(isToolCallingAssistantMessage);

  if (assistantMessage === undefined) {
    return {
      completedCallIds: [],
      disposition: "re_infer",
      missingToolCalls: [],
      originalToolCalls: [],
    };
  }

  const originalToolCalls = assistantMessage.parts.filter(
    (part): part is ToolCallPart => part.type === "tool_call"
  );
  const originalCallIds = new Set(
    originalToolCalls.map((toolCall) => toolCall.callId)
  );
  const completedCallIds: string[] = [];
  const completedCallIdSet = new Set<string>();

  for (const message of interruptedMessages) {
    if (message.role !== "tool") {
      continue;
    }

    for (const part of message.parts) {
      if (
        originalCallIds.has(part.callId) &&
        !completedCallIdSet.has(part.callId)
      ) {
        completedCallIdSet.add(part.callId);
        completedCallIds.push(part.callId);
      }
    }
  }

  const missingToolCalls = originalToolCalls.filter(
    (toolCall) => !completedCallIdSet.has(toolCall.callId)
  );

  return {
    assistantMessage,
    completedCallIds,
    disposition:
      missingToolCalls.length === 0
        ? "completed_tool_batch"
        : "resume_tool_batch",
    missingToolCalls,
    originalToolCalls,
  };
}

/**
 * Wrap a durable-message read failure with the stable recovery error exposed
 * to hosts. The original failure remains available as `cause`.
 */
export function createInterruptedIterationUnreadableError(
  turnId: string,
  staleRunId: string,
  cause: unknown,
  stagedResult?: StagedResult
): TuvrenRecoveryError {
  return new TuvrenRecoveryError(
    `interrupted iteration for turn "${turnId}" from stale run "${staleRunId}" could not be read`,
    {
      cause,
      code: "runtime_recovery_interrupted_iteration_unreadable",
      details: {
        ...(stagedResult === undefined
          ? {}
          : {
              objectHash: stagedResult.objectHash,
              taskId: stagedResult.taskId,
            }),
        staleRunId,
        turnId,
      },
    }
  );
}

async function readInterruptedMessages(
  input: InterruptedIterationRecoveryPlanInput
): Promise<TuvrenMessage[]> {
  const committedMessagesByHash = new Map<string, TuvrenMessage>();

  for (const [
    index,
    hash,
  ] of input.recoveredHeadState.messageHashes.entries()) {
    const message = input.recoveredHeadState.messages[index];

    if (message !== undefined) {
      committedMessagesByHash.set(hash, message);
    }
  }

  const stagedResults = [
    ...input.recoveryState.consumedStagedResults,
    ...input.recoveryState.uncommittedStagedResults,
  ];
  const messages: TuvrenMessage[] = [];
  const seenHashes = new Set<string>();

  for (const stagedResult of stagedResults) {
    if (
      stagedResult.objectType !== "message" ||
      seenHashes.has(stagedResult.objectHash)
    ) {
      continue;
    }

    seenHashes.add(stagedResult.objectHash);
    const committedMessage = committedMessagesByHash.get(
      stagedResult.objectHash
    );

    if (committedMessage !== undefined) {
      messages.push(committedMessage);
      continue;
    }

    try {
      messages.push(
        await readMessage(
          input.kernel,
          input.payloadCodecBinding,
          stagedResult.objectHash
        )
      );
    } catch (error: unknown) {
      throw createInterruptedIterationUnreadableError(
        input.turnId,
        input.staleRunId,
        error,
        stagedResult
      );
    }
  }

  return messages;
}

function isToolCallingAssistantMessage(
  message: TuvrenMessage
): message is Extract<TuvrenMessage, { role: "assistant" }> {
  return (
    message.role === "assistant" &&
    message.parts.some((part) => part.type === "tool_call")
  );
}
