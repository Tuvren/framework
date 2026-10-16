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

interface BatchResultMatches {
  resultByCallId: Map<string, ToolResultPart>;
  resultHashByCallId: Map<string, HashString>;
  resultIndexes: Set<number>;
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
  // Identical assistant messages can share a content hash across Turns. The
  // interrupted batch is the latest matching occurrence in the active path.
  const assistantIndex = hashes.lastIndexOf(assistantMessageHash);
  if (assistantIndex < 0) {
    return { headState, toolResults: fallbackToolResults };
  }
  const originalCalls = assistant.parts.filter(
    (part): part is ToolCallPart => part.type === "tool_call"
  );
  const batchResults = collectBatchResults(
    hashes,
    messagesByHash,
    assistantIndex,
    originalCalls
  );

  const orderedResultHashes = originalCalls.flatMap((call) => {
    const hash = batchResults.resultHashByCallId.get(call.callId);
    return hash === undefined ? [] : [hash];
  });
  const uniqueResultHashes = [...new Set(orderedResultHashes)];
  const withoutResults: HashString[] = [];
  for (const [index, hash] of hashes.entries()) {
    if (index === assistantIndex) {
      withoutResults.push(hash, ...uniqueResultHashes);
      continue;
    }
    if (!batchResults.resultIndexes.has(index)) {
      withoutResults.push(hash);
    }
  }

  const messages = withoutResults.flatMap((hash) => {
    const message = messagesByHash.get(hash);
    return message === undefined ? [] : [message];
  });
  const toolResults = originalCalls.flatMap((call) => {
    const result = batchResults.resultByCallId.get(call.callId);
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

function collectBatchResults(
  hashes: HashString[],
  messagesByHash: Map<HashString, TuvrenMessage>,
  assistantIndex: number,
  originalCalls: ToolCallPart[]
): BatchResultMatches {
  const callIds = new Set(originalCalls.map((call) => call.callId));
  const matches: BatchResultMatches = {
    resultByCallId: new Map(),
    resultHashByCallId: new Map(),
    resultIndexes: new Set(),
  };

  for (let index = assistantIndex + 1; index < hashes.length; index += 1) {
    const hash = hashes[index];
    const message = hash === undefined ? undefined : messagesByHash.get(hash);
    if (message?.role === "assistant") {
      break;
    }
    if (message?.role !== "tool" || hash === undefined) {
      continue;
    }

    for (const part of message.parts) {
      if (
        part.type !== "tool_result" ||
        !callIds.has(part.callId) ||
        matches.resultHashByCallId.has(part.callId)
      ) {
        continue;
      }
      matches.resultHashByCallId.set(part.callId, hash);
      matches.resultByCallId.set(part.callId, part);
      matches.resultIndexes.add(index);
    }
  }

  return matches;
}
