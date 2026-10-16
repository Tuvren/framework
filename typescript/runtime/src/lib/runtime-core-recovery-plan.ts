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

import { type HashString, TuvrenRecoveryError } from "@tuvren/core";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";
import type {
  RecoveryState,
  RuntimeKernel,
  StagedResult,
} from "@tuvren/kernel-protocol";
import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import { readMessage } from "./runtime-core-head-state.js";
import type { InterruptedToolBatchDescriptor } from "./runtime-core-interrupted-metadata.js";
import type { HeadState } from "./runtime-core-loop.js";
import { isTurnLineageRecord } from "./runtime-core-response.js";

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
  /** Hash anchoring the original assistant without adding it a second time. */
  assistantMessageHash?: HashString;
  /** Original durable assistant message, absent for model-stream crashes. */
  assistantMessage?: Extract<TuvrenMessage, { role: "assistant" }>;
  /** Durable identity and execution policy carried across replacement runs. */
  descriptor?: InterruptedToolBatchDescriptor;
  /** Original call IDs that already have a durable decoded tool result. */
  completedCallIds: string[];
  /** Hashes for completed results in original tool-call order. */
  completedToolResultHashes: HashString[];
  /** True when current durable message order differs from call order. */
  completedToolResultsOutOfOrder: boolean;
  /** Durable results already committed for original calls, in call order. */
  completedToolResults: ToolResultPart[];
  /** Whether to re-infer, resume missing calls, or continue past a full batch. */
  disposition: InterruptedIterationRecoveryDisposition;
  /** Original tool-call parts without a matching durable result. */
  missingToolCalls: ToolCallPart[];
  /** Every original tool-call part in assistant-message order. */
  originalToolCalls: ToolCallPart[];
  /** Recovered messages whose hashes are not yet present in the branch head. */
  stagedMessages: TuvrenMessage[];
  /** Hashes for {@link stagedMessages}, in the same order. */
  stagedMessageHashes: HashString[];
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

interface ResolvedInterruptedAssistant {
  assistantMessage?: Extract<TuvrenMessage, { role: "assistant" }>;
  descriptor?: InterruptedToolBatchDescriptor;
  messages: TuvrenMessage[];
}

interface CompletedToolBatchResults {
  callIds: string[];
  resultHashes: HashString[];
  results: ToolResultPart[];
  resultsOutOfOrder: boolean;
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
  const recovered = await readInterruptedMessages(input);
  const resolvedAssistant = await resolveInterruptedAssistant(input, recovered);
  const { assistantMessage, descriptor, messages } = resolvedAssistant;

  if (assistantMessage === undefined || descriptor?.executable === false) {
    return createReInferencePlan(recovered, descriptor);
  }

  const originalToolCalls = assistantMessage.parts.filter(
    (part): part is ToolCallPart => part.type === "tool_call"
  );
  const completed = collectCompletedToolBatchResults(
    originalToolCalls,
    messages,
    recovered,
    input.recoveredHeadState.messageHashes
  );
  const completedCallIdSet = new Set(completed.callIds);
  const missingToolCalls = originalToolCalls.filter(
    (toolCall) => !completedCallIdSet.has(toolCall.callId)
  );
  const assistantMessageHash = findMessageHash(
    recovered.messagesByHash,
    assistantMessage
  );

  return {
    assistantMessage,
    ...(assistantMessageHash === undefined ? {} : { assistantMessageHash }),
    completedCallIds: completed.callIds,
    completedToolResultHashes: completed.resultHashes,
    completedToolResultsOutOfOrder: completed.resultsOutOfOrder,
    completedToolResults: completed.results,
    disposition:
      missingToolCalls.length === 0
        ? "completed_tool_batch"
        : "resume_tool_batch",
    missingToolCalls,
    originalToolCalls,
    stagedMessages: recovered.stagedMessages,
    stagedMessageHashes: recovered.stagedMessageHashes,
    ...(descriptor === undefined ? {} : { descriptor }),
  };
}

async function resolveInterruptedAssistant(
  input: InterruptedIterationRecoveryPlanInput,
  recovered: Awaited<ReturnType<typeof readInterruptedMessages>>
): Promise<ResolvedInterruptedAssistant> {
  const descriptor = await readRecoveryDescriptor(input);
  const messages = [...recovered.messages];
  const assistantHash = descriptor?.assistantMessageHash;
  if (assistantHash !== undefined) {
    appendHeadMessagesFromAssistant(
      input.recoveredHeadState,
      assistantHash,
      messages
    );
  }

  if (
    assistantHash !== undefined &&
    !recovered.messagesByHash.has(assistantHash) &&
    !input.recoveredHeadState.messageHashes.includes(assistantHash) &&
    !recovered.interruptedMessageHashes.has(assistantHash)
  ) {
    try {
      const assistant = await readMessage(
        input.kernel,
        input.payloadCodecBinding,
        assistantHash
      );
      recovered.messagesByHash.set(assistantHash, assistant);
      recovered.messages.push(assistant);
      recovered.stagedMessages.push(assistant);
      recovered.stagedMessageHashes.push(assistantHash);
    } catch (error: unknown) {
      throw createInterruptedIterationUnreadableError(
        input.turnId,
        input.staleRunId,
        error
      );
    }
  }

  const descriptorAssistant =
    assistantHash === undefined
      ? undefined
      : (recovered.messagesByHash.get(assistantHash) ??
        input.recoveredHeadState.messages[
          input.recoveredHeadState.messageHashes.indexOf(assistantHash)
        ]);
  const targetsInterruptedMessage =
    assistantHash !== undefined &&
    recovered.interruptedMessageHashes.has(assistantHash);
  const assistantMessage = targetsInterruptedMessage
    ? undefined
    : ((descriptorAssistant !== undefined &&
      isToolCallingAssistantMessage(descriptorAssistant)
        ? descriptorAssistant
        : undefined) ??
      [...messages].reverse().find(isToolCallingAssistantMessage));

  return {
    assistantMessage,
    ...(descriptor === undefined ? {} : { descriptor }),
    messages,
  };
}

function appendHeadMessagesFromAssistant(
  headState: HeadState,
  assistantHash: HashString,
  messages: TuvrenMessage[]
): void {
  const assistantIndex = headState.messageHashes.indexOf(assistantHash);
  if (assistantIndex < 0) {
    return;
  }

  for (const message of headState.messages.slice(assistantIndex)) {
    if (!messages.includes(message)) {
      messages.push(message);
    }
  }
}

function createReInferencePlan(
  recovered: Awaited<ReturnType<typeof readInterruptedMessages>>,
  descriptor: InterruptedToolBatchDescriptor | undefined
): InterruptedIterationRecoveryPlan {
  return {
    completedCallIds: [],
    completedToolResultHashes: [],
    completedToolResultsOutOfOrder: false,
    completedToolResults: [],
    disposition: "re_infer",
    missingToolCalls: [],
    originalToolCalls: [],
    stagedMessages: recovered.stagedMessages,
    stagedMessageHashes: recovered.stagedMessageHashes,
    ...(descriptor === undefined ? {} : { descriptor }),
  };
}

function collectCompletedToolBatchResults(
  originalToolCalls: ToolCallPart[],
  messages: TuvrenMessage[],
  recovered: Awaited<ReturnType<typeof readInterruptedMessages>>,
  headMessageHashes: HashString[]
): CompletedToolBatchResults {
  const originalCallIds = new Set(
    originalToolCalls.map((toolCall) => toolCall.callId)
  );
  const completedByCallId = new Map<string, ToolResultPart>();
  for (const message of messages) {
    collectResultsFromMessage(message, originalCallIds, completedByCallId);
  }

  const callIds = [...completedByCallId.keys()];
  const results = originalToolCalls.flatMap((toolCall) => {
    const result = completedByCallId.get(toolCall.callId);
    return result === undefined ? [] : [result];
  });
  const resultHashes = findCompletedToolResultHashes(
    originalToolCalls,
    recovered.messagesByHash
  );

  return {
    callIds,
    resultHashes,
    results,
    resultsOutOfOrder: areResultsOutOfOrder(resultHashes, [
      ...headMessageHashes,
      ...recovered.stagedMessageHashes,
    ]),
  };
}

function collectResultsFromMessage(
  message: TuvrenMessage,
  originalCallIds: Set<string>,
  completedByCallId: Map<string, ToolResultPart>
): void {
  if (message.role !== "tool") {
    return;
  }
  for (const part of message.parts) {
    if (
      originalCallIds.has(part.callId) &&
      !completedByCallId.has(part.callId)
    ) {
      completedByCallId.set(part.callId, part);
    }
  }
}

function findCompletedToolResultHashes(
  originalToolCalls: ToolCallPart[],
  messagesByHash: Map<string, TuvrenMessage>
): HashString[] {
  return originalToolCalls.flatMap((toolCall) => {
    const matching = [...messagesByHash.entries()].find(
      ([, message]) =>
        message.role === "tool" &&
        message.parts.some(
          (part) =>
            part.type === "tool_result" && part.callId === toolCall.callId
        )
    );
    return matching === undefined ? [] : [matching[0] as HashString];
  });
}

function areResultsOutOfOrder(
  resultHashes: HashString[],
  durableMessageOrder: HashString[]
): boolean {
  let previousResultPosition = -1;
  for (const hash of resultHashes) {
    const position = durableMessageOrder.indexOf(hash);
    if (position < previousResultPosition) {
      return true;
    }
    previousResultPosition = position;
  }
  return false;
}

function findMessageHash(
  messagesByHash: Map<string, TuvrenMessage>,
  target: TuvrenMessage
): HashString | undefined {
  return [...messagesByHash.entries()].find(
    ([, message]) => message === target
  )?.[0] as HashString | undefined;
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
): Promise<{
  interruptedMessageHashes: Set<string>;
  messagesByHash: Map<string, TuvrenMessage>;
  messages: TuvrenMessage[];
  stagedMessages: TuvrenMessage[];
  stagedMessageHashes: HashString[];
}> {
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
  const messagesByHash = new Map<string, TuvrenMessage>();
  const interruptedMessageHashes = new Set<string>();
  const stagedMessages: TuvrenMessage[] = [];
  const stagedMessageHashes: HashString[] = [];
  const seenHashes = new Set<string>();

  for (const stagedResult of stagedResults) {
    if (stagedResult.objectType !== "message") {
      continue;
    }
    if (stagedResult.status === "interrupted") {
      interruptedMessageHashes.add(stagedResult.objectHash);
      continue;
    }
    if (seenHashes.has(stagedResult.objectHash)) {
      continue;
    }

    seenHashes.add(stagedResult.objectHash);
    const committedMessage = committedMessagesByHash.get(
      stagedResult.objectHash
    );

    if (committedMessage !== undefined) {
      messages.push(committedMessage);
      messagesByHash.set(stagedResult.objectHash, committedMessage);
      continue;
    }

    try {
      const message = await readMessage(
        input.kernel,
        input.payloadCodecBinding,
        stagedResult.objectHash
      );
      messages.push(message);
      messagesByHash.set(stagedResult.objectHash, message);
      stagedMessages.push(message);
      stagedMessageHashes.push(stagedResult.objectHash);
    } catch (error: unknown) {
      throw createInterruptedIterationUnreadableError(
        input.turnId,
        input.staleRunId,
        error,
        stagedResult
      );
    }
  }

  for (const [
    index,
    hash,
  ] of input.recoveredHeadState.messageHashes.entries()) {
    const message = input.recoveredHeadState.messages[index];
    if (message !== undefined) {
      messagesByHash.set(hash, message);
    }
  }

  return {
    interruptedMessageHashes,
    messages,
    messagesByHash,
    stagedMessages,
    stagedMessageHashes,
  };
}

async function readRecoveryDescriptor(
  input: InterruptedIterationRecoveryPlanInput
): Promise<InterruptedToolBatchDescriptor | undefined> {
  const stagedLineageRecords = [
    ...input.recoveryState.consumedStagedResults,
    ...input.recoveryState.uncommittedStagedResults,
  ].filter(
    (result) =>
      result.objectType === "turn_lineage" && result.status !== "interrupted"
  );

  for (const stagedLineage of stagedLineageRecords.reverse()) {
    const payload = await input.kernel.store.get(stagedLineage.objectHash);
    if (payload === null) {
      continue;
    }
    const lineage: unknown = decodeDeterministicKernelRecord(payload);
    if (
      isTurnLineageRecord(lineage) &&
      lineage.interruptedToolBatch !== undefined
    ) {
      return lineage.interruptedToolBatch;
    }
  }

  return input.recoveredHeadState.turnLineage?.interruptedToolBatch;
}

function isToolCallingAssistantMessage(
  message: TuvrenMessage
): message is Extract<TuvrenMessage, { role: "assistant" }> {
  return (
    message.role === "assistant" &&
    message.parts.some((part) => part.type === "tool_call")
  );
}
