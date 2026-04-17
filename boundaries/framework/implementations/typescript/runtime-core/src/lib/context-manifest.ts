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
  HandoffContextBuilder,
  HandoffSourceContext,
  KrakenMessage,
  ToolResultPart,
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
  extensionState: Record<string, unknown> = {}
): ContextManifest {
  const manifest = createEmptyContextManifest();
  manifest.extensions = cloneRecord(extensionState);
  return updateContextManifest(manifest, messages);
}

export function updateContextManifest(
  manifest: ContextManifest,
  messages: KrakenMessage[],
  updates: ExtensionStateUpdate[] = []
): ContextManifest {
  const nextManifest = cloneContextManifest(manifest);

  for (const message of messages) {
    appendMessage(nextManifest, message);
  }

  nextManifest.extensions = applyExtensionStateUpdates(
    nextManifest.extensions,
    updates
  );

  return nextManifest;
}

export function createPreserveTraceHandoffContextBuilder(): HandoffContextBuilder {
  return (context) => {
    const handoffMessage = {
      parts: [
        {
          text: [
            `[Handoff from ${context.sourceAgent.name}]`,
            `Reason: ${context.handoffIntent.reason ?? "unspecified"}`,
            "--- User Messages ---",
            ...extractMessagesByRole(context.messages, "user"),
            "--- Previous Agent's Work ---",
            ...extractMessagesByRole(context.messages, "assistant"),
            "--- Key Outcomes ---",
            ...extractToolOutcomes(context.messages),
            "Continue from where the previous agent left off.",
          ].join("\n"),
          type: "text",
        },
      ],
      role: "user",
    } satisfies KrakenMessage;

    return [context.helpers.storeMessage(handoffMessage)];
  };
}

export function createLastOutputOnlyHandoffContextBuilder(): HandoffContextBuilder {
  return (context) => {
    const handoffMessage = {
      parts: [
        {
          text: extractLastAssistantOutput(context),
          type: "text",
        },
      ],
      role: "user",
    } satisfies KrakenMessage;

    return [context.helpers.storeMessage(handoffMessage)];
  };
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
  message: KrakenMessage
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
      manifest.turnBoundaries.push(messageIndex);
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
      ...currentExtensionState,
      ...update.state,
    };
  }

  return nextState;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record };
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

function extractMessagesByRole(
  messages: KrakenMessage[],
  role: KrakenMessage["role"]
): string[] {
  const excerpts: string[] = [];

  if (role === "assistant") {
    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      excerpts.push(summarizeAssistantMessage(message));
    }

    return excerpts;
  }

  for (const message of messages) {
    if (message.role !== role) {
      continue;
    }

    excerpts.push(renderMessageText(message));
  }

  return excerpts;
}

function extractToolOutcomes(messages: KrakenMessage[]): string[] {
  const outcomes: string[] = [];

  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }

    for (const part of message.parts) {
      outcomes.push(`${part.name}: ${renderToolResult(part)}`);
    }
  }

  return outcomes;
}

function renderMessageText(message: KrakenMessage): string {
  if (message.role === "system") {
    return message.content;
  }

  const fragments: string[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case "reasoning":
      case "text":
        fragments.push(part.text);
        break;
      case "structured":
        fragments.push(JSON.stringify(part.data));
        break;
      case "tool_call":
        fragments.push(`[tool:${part.name}] ${JSON.stringify(part.input)}`);
        break;
      case "tool_result":
        fragments.push(`${part.name}: ${renderToolResult(part)}`);
        break;
      case "file":
        fragments.push(
          `[file:${part.filename ?? "unnamed"}:${part.mediaType}]`
        );
        break;
      default:
        break;
    }
  }

  return fragments.join("\n");
}

function renderToolResult(part: ToolResultPart): string {
  return typeof part.output === "string"
    ? part.output
    : JSON.stringify(part.output);
}

function summarizeAssistantMessage(
  message: Extract<KrakenMessage, { role: "assistant" }>
): string {
  const summaryParts: string[] = [];
  let structuredCount = 0;
  let fileCount = 0;

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        summaryParts.push(part.text);
        break;
      case "structured":
        structuredCount += 1;
        break;
      case "file":
        fileCount += 1;
        break;
      default:
        break;
    }
  }

  if (structuredCount > 0) {
    summaryParts.push(
      structuredCount === 1
        ? "[Structured output produced]"
        : `[${structuredCount} structured outputs produced]`
    );
  }

  if (fileCount > 0) {
    summaryParts.push(
      fileCount === 1
        ? "[File attachment produced]"
        : `[${fileCount} file attachments produced]`
    );
  }

  return summaryParts.length > 0
    ? summaryParts.join("\n")
    : "[Previous agent work omitted for compatibility]";
}

function extractLastAssistantOutput(context: HandoffSourceContext): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];

    if (message.role === "assistant") {
      return summarizeAssistantMessage(message);
    }
  }

  return "";
}
