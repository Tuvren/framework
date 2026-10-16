/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { HashString } from "@tuvren/core";
import type {
  ToolCallPart,
  ToolResultPart,
  TuvrenMessage,
} from "@tuvren/core/messages";

interface ToolBatchHistoryState {
  branchHeadHash: HashString;
  manifest: import("@tuvren/core/execution").ContextManifest;
  messageHashes: HashString[];
  messages: TuvrenMessage[];
  turnNode: { turnTreeHash: HashString };
}

export interface FinalizedToolBatchProjection {
  headState: ToolBatchHistoryState;
  toolResults: ToolResultPart[];
}

/**
 * Projects a recovered or approval-resumed tool batch into original call
 * order once all newly completed results have joined the durable history.
 */
export function finalizeToolBatchProjection(
  headState: ToolBatchHistoryState,
  assistantMessageHash: HashString | undefined,
  appendedHashes: HashString[],
  appendedMessages: TuvrenMessage[],
  fallbackToolResults: ToolResultPart[]
): FinalizedToolBatchProjection {
  if (assistantMessageHash === undefined) {
    return { headState, toolResults: fallbackToolResults };
  }

  const hashes = [...headState.messageHashes, ...appendedHashes];
  const messagesByHash = new Map<HashString, TuvrenMessage>();
  for (const [index, hash] of headState.messageHashes.entries()) {
    const message = headState.messages[index];
    if (message !== undefined) {
      messagesByHash.set(hash, message);
    }
  }
  for (const [index, hash] of appendedHashes.entries()) {
    const message = appendedMessages[index];
    if (message !== undefined) {
      messagesByHash.set(hash, message);
    }
  }

  const assistant = messagesByHash.get(assistantMessageHash);
  if (assistant?.role !== "assistant") {
    return { headState, toolResults: fallbackToolResults };
  }
  const originalCalls = assistant.parts.filter(
    (part): part is ToolCallPart => part.type === "tool_call"
  );
  const callIds = new Set(originalCalls.map((call) => call.callId));
  const resultHashByCallId = new Map<string, HashString>();
  const resultByCallId = new Map<string, ToolResultPart>();
  for (const [hash, message] of messagesByHash) {
    if (message.role !== "tool") {
      continue;
    }
    for (const part of message.parts) {
      if (
        part.type === "tool_result" &&
        callIds.has(part.callId) &&
        !resultHashByCallId.has(part.callId)
      ) {
        resultHashByCallId.set(part.callId, hash);
        resultByCallId.set(part.callId, part);
      }
    }
  }

  const orderedResultHashes = originalCalls.flatMap((call) => {
    const hash = resultHashByCallId.get(call.callId);
    return hash === undefined ? [] : [hash];
  });
  const uniqueResultHashes = [...new Set(orderedResultHashes)];
  const withoutResults = hashes.filter(
    (hash) => !uniqueResultHashes.includes(hash)
  );
  const assistantIndex = withoutResults.indexOf(assistantMessageHash);
  if (assistantIndex < 0) {
    return { headState, toolResults: fallbackToolResults };
  }
  withoutResults.splice(assistantIndex + 1, 0, ...uniqueResultHashes);

  const messages = withoutResults.flatMap((hash) => {
    const message = messagesByHash.get(hash);
    return message === undefined ? [] : [message];
  });
  const toolResults = originalCalls.flatMap((call) => {
    const result = resultByCallId.get(call.callId);
    return result === undefined ? [] : [result];
  });

  return {
    headState: {
      ...headState,
      messageHashes: withoutResults,
      messages,
    },
    toolResults,
  };
}
