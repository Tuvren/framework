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
  ContextManifest,
  KrakenMessage,
} from "@kraken/framework-runtime-api";
import type { ExtensionStateUpdate } from "./extension-runtime.js";

const TOKEN_ESTIMATE_DIVISOR = 4;

export function createEmptyContextManifest(): ContextManifest {
  return {
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
  };
}

export function createContextManifest(
  messages: KrakenMessage[],
  extensionState: Record<string, unknown> = {},
  turnBoundaryOffsets: number[] = inferUserTurnBoundaryOffsets(messages)
): ContextManifest {
  const manifest = createEmptyContextManifest();
  manifest.extensions = cloneRecord(extensionState);
  return updateContextManifest(manifest, messages, [], turnBoundaryOffsets);
}

export function updateContextManifest(
  manifest: ContextManifest,
  messages: KrakenMessage[],
  updates: ExtensionStateUpdate[] = [],
  turnBoundaryOffsets: number[] = inferUserTurnBoundaryOffsets(messages)
): ContextManifest {
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
}

export function cloneContextManifest(
  manifest: ContextManifest
): ContextManifest {
  return {
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
  };
}

function appendMessage(
  manifest: ContextManifest,
  message: KrakenMessage,
  isTurnBoundary: boolean
): void {
  const messageIndex = manifest.messageCount;
  manifest.messageCount += 1;
  manifest.tokenEstimate += estimateMessageTokens(message);

  switch (message.role) {
    case "assistant":
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
    case "system":
      manifest.byRole.system += 1;
      return;
    case "tool":
      manifest.byRole.tool += 1;
      for (const part of message.parts) {
        incrementNameCounter(manifest.toolResults.byName, part.name);
        manifest.toolResults.total += 1;
      }
      return;
    case "user":
      manifest.byRole.user += 1;
      manifest.lastUserMessageIndex = messageIndex;
      if (isTurnBoundary) {
        manifest.turnBoundaries.push(messageIndex);
      }
      return;
    default:
      return;
  }
}

function estimateMessageTokens(message: KrakenMessage): number {
  const textLength =
    message.role === "system"
      ? message.content.length
      : message.parts.reduce((length, part) => {
          switch (part.type) {
            case "file":
              return (
                length +
                estimateFilePayloadLength(part.data) +
                (part.filename?.length ?? 0) +
                part.mediaType.length
              );
            case "reasoning":
            case "text":
              return length + part.text.length;
            case "structured":
              return length + JSON.stringify(part.data).length;
            case "tool_call":
              return (
                length +
                part.name.length +
                JSON.stringify(part.input).length +
                part.callId.length
              );
            case "tool_result":
              return (
                length +
                part.name.length +
                JSON.stringify(part.output).length +
                part.callId.length
              );
            default:
              return length;
          }
        }, 0);

  return Math.ceil(textLength / TOKEN_ESTIMATE_DIVISOR);
}

function estimateFilePayloadLength(payload: string | Uint8Array): number {
  return typeof payload === "string" ? payload.length : payload.byteLength;
}

function incrementNameCounter(
  counter: Record<string, number>,
  name: string
): void {
  counter[name] = (counter[name] ?? 0) + 1;
}

function applyExtensionStateUpdates(
  currentState: Record<string, unknown>,
  updates: ExtensionStateUpdate[]
): Record<string, unknown> {
  const nextState = cloneRecord(currentState);

  for (const update of updates) {
    const currentExtensionState = asRecord(nextState[update.extensionName]);
    nextState[update.extensionName] = {
      ...cloneRecord(currentExtensionState),
      ...cloneRecord(update.state),
    };
  }

  return nextState;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return globalThis.structuredClone(record);
}

function inferUserTurnBoundaryOffsets(messages: KrakenMessage[]): number[] {
  const turnBoundaryOffsets: number[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      turnBoundaryOffsets.push(index);
    }
  }

  return turnBoundaryOffsets;
}

function cloneCountRecord(
  record: Record<string, number>
): Record<string, number> {
  return { ...record };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}
