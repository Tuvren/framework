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

import type { ContextManifest } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";

import type { ExtensionStateUpdate } from "./extension-runtime.js";

const TOKEN_ESTIMATE_DIVISOR = 4;

/**
 * Builds a zeroed `ContextManifest` (KrakenFrameworkSpecification §1.6):
 * empty counters and extension state, `-1` sentinels for the last
 * assistant/user message indexes, and no turn boundaries.
 */
export const createEmptyContextManifest = (): ContextManifest => ({
  byRole: {
    assistant: 0,
    system: 0,
    tool: 0,
    user: 0,
  },
  extensions: {},
  lastAssistantMessageIndex: -1,
  lastUserMessageIndex: -1,
  messageCount: 0,
  tokenEstimate: 0,
  toolCalls: {
    byName: {},
    total: 0,
  },
  toolResults: {
    byName: {},
    total: 0,
  },
  turnBoundaries: [],
});

const inferUserTurnBoundaryOffsets = (messages: TuvrenMessage[]): number[] => {
  const turnBoundaryOffsets: number[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      turnBoundaryOffsets.push(index);
    }
  }

  return turnBoundaryOffsets;
};

const cloneRecord = (
  record: Record<string, unknown>
): Record<string, unknown> => globalThis.structuredClone(record);

const cloneCountRecord = (
  record: Record<string, number>
): Record<string, number> => ({ ...record });

/** Deep-copies a manifest so callers can evolve one without aliasing. */
export const cloneContextManifest = (
  manifest: ContextManifest
): ContextManifest => ({
  byRole: {
    assistant: manifest.byRole.assistant,
    system: manifest.byRole.system,
    tool: manifest.byRole.tool,
    user: manifest.byRole.user,
  },
  extensions: cloneRecord(manifest.extensions),
  lastAssistantMessageIndex: manifest.lastAssistantMessageIndex,
  lastUserMessageIndex: manifest.lastUserMessageIndex,
  messageCount: manifest.messageCount,
  tokenEstimate: manifest.tokenEstimate,
  toolCalls: {
    byName: cloneCountRecord(manifest.toolCalls.byName),
    total: manifest.toolCalls.total,
  },
  toolResults: {
    byName: cloneCountRecord(manifest.toolResults.byName),
    total: manifest.toolResults.total,
  },
  turnBoundaries: [...manifest.turnBoundaries],
});

const estimateFilePayloadLength = (payload: string | Uint8Array): number =>
  typeof payload === "string" ? payload.length : payload.byteLength;

const estimateMessageTokens = (message: TuvrenMessage): number => {
  if (message.role === "system") {
    return Math.ceil(message.content.length / TOKEN_ESTIMATE_DIVISOR);
  }

  let textLength = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "file": {
        textLength +=
          estimateFilePayloadLength(part.data) +
          (part.filename?.length ?? 0) +
          part.mediaType.length;
        break;
      }
      case "reasoning":
      case "text": {
        textLength += part.text.length;
        break;
      }
      case "structured": {
        textLength += JSON.stringify(part.data).length;
        break;
      }
      case "tool_call": {
        textLength +=
          part.name.length +
          JSON.stringify(part.input).length +
          part.callId.length;
        break;
      }
      case "tool_result": {
        textLength +=
          part.name.length +
          JSON.stringify(part.output).length +
          part.callId.length;
        break;
      }
      default: {
        break;
      }
    }
  }

  return Math.ceil(textLength / TOKEN_ESTIMATE_DIVISOR);
};

const incrementNameCounter = (
  counter: Record<string, number>,
  name: string
): void => {
  counter[name] = (counter[name] ?? 0) + 1;
};

const appendMessage = (
  manifest: ContextManifest,
  message: TuvrenMessage,
  isTurnBoundary: boolean
): void => {
  const messageIndex = manifest.messageCount;
  manifest.messageCount += 1;
  manifest.tokenEstimate += estimateMessageTokens(message);

  switch (message.role) {
    case "assistant": {
      manifest.byRole.assistant += 1;
      manifest.lastAssistantMessageIndex = messageIndex;
      for (const part of message.parts) {
        if (part.type === "tool_call") {
          incrementNameCounter(manifest.toolCalls.byName, part.name);
          manifest.toolCalls.total += 1;
        }

        if (part.type === "tool_result") {
          incrementNameCounter(manifest.toolResults.byName, part.name);
          manifest.toolResults.total += 1;
        }
      }
      return;
    }
    case "system": {
      manifest.byRole.system += 1;
      return;
    }
    case "tool": {
      manifest.byRole.tool += 1;
      for (const part of message.parts) {
        incrementNameCounter(manifest.toolResults.byName, part.name);
        manifest.toolResults.total += 1;
      }
      return;
    }
    case "user": {
      manifest.byRole.user += 1;
      manifest.lastUserMessageIndex = messageIndex;
      if (isTurnBoundary) {
        manifest.turnBoundaries.push(messageIndex);
      }
      break;
    }
    default: {
      break;
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const applyExtensionStateUpdates = (
  currentState: Record<string, unknown>,
  updates: ExtensionStateUpdate[]
): Record<string, unknown> => {
  if (updates.length === 0) {
    return currentState;
  }

  const nextState = cloneRecord(currentState);

  for (const update of updates) {
    const currentExtensionState = asRecord(nextState[update.extensionName]);
    nextState[update.extensionName] = {
      ...cloneRecord(currentExtensionState),
      ...cloneRecord(update.state),
    };
  }

  return nextState;
};

/**
 * Returns a new manifest with `messages` appended to `manifest`'s counters
 * (role tallies, tool call/result totals, token estimate, boundaries) and
 * with each {@link ExtensionStateUpdate} shallow-merged into its extension's
 * state slice. The input manifest is never mutated; `turnBoundaryOffsets`
 * indexes into `messages` and defaults to its user-message offsets.
 */
export const updateContextManifest = (
  manifest: ContextManifest,
  messages: TuvrenMessage[],
  updates: ExtensionStateUpdate[] = [],
  turnBoundaryOffsets: number[] = inferUserTurnBoundaryOffsets(messages)
): ContextManifest => {
  const nextManifest = cloneContextManifest(manifest);
  const turnBoundaryOffsetSet = new Set(turnBoundaryOffsets);

  for (const [index, message] of messages.entries()) {
    appendMessage(nextManifest, message, turnBoundaryOffsetSet.has(index));
  }

  nextManifest.extensions = applyExtensionStateUpdates(
    nextManifest.extensions,
    updates
  );

  return nextManifest;
};

/**
 * Builds a `ContextManifest` from a full message history plus optional
 * initial per-extension state. Turn boundaries default to the offsets of the
 * user messages when `turnBoundaryOffsets` is not supplied.
 */
export const createContextManifest = (
  messages: TuvrenMessage[],
  extensionState: Record<string, unknown> = {},
  turnBoundaryOffsets: number[] = inferUserTurnBoundaryOffsets(messages)
): ContextManifest => {
  const manifest = createEmptyContextManifest();
  manifest.extensions = cloneRecord(extensionState);
  return updateContextManifest(manifest, messages, [], turnBoundaryOffsets);
};
