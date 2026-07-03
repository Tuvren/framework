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

import type { HandoffContextBuilder } from "@tuvren/core/execution";
import type { ToolResultPart, TuvrenMessage } from "@tuvren/core/messages";

type UserMessageParts = Extract<TuvrenMessage, { role: "user" }>["parts"];

export function createPreserveTraceHandoffContextBuilder(): HandoffContextBuilder {
  return (context) => {
    // `preserve_trace` is a chronological summarized trace on purpose. The
    // framework must preserve causal order across user, assistant, and tool
    // outcomes without forwarding raw reasoning or raw tool-call inputs.
    const handoffMessage = {
      parts: [
        {
          text: [
            `[Handoff from ${context.sourceAgent.name}]`,
            `Reason: ${context.handoffIntent.reason ?? "unspecified"}`,
            "--- Chronological Trace ---",
            ...extractChronologicalTrace(context.messages),
            "Continue from where the previous agent left off.",
          ].join("\n"),
          type: "text",
        },
      ],
      role: "user",
    } satisfies TuvrenMessage;

    return [context.helpers.storeMessage(handoffMessage)];
  };
}

export function createLastOutputOnlyHandoffContextBuilder(): HandoffContextBuilder {
  return (context) => {
    // `last_output_only` forwards the prior agent's final visible output parts
    // directly rather than textifying them, so structured data and files survive
    // the handoff as canonical content parts.
    const handoffMessage = {
      parts: extractLastVisibleAssistantOutputParts(context.messages),
      role: "user",
    } satisfies TuvrenMessage;

    return [context.helpers.storeMessage(handoffMessage)];
  };
}

function extractChronologicalTrace(
  messages: readonly TuvrenMessage[]
): string[] {
  const excerpts: string[] = [];

  for (const message of messages) {
    excerpts.push(...summarizeChronologicalMessage(message));
  }

  return excerpts;
}

function summarizeChronologicalMessage(message: TuvrenMessage): string[] {
  switch (message.role) {
    case "assistant": {
      return [formatTraceLine("Assistant", summarizeAssistantMessage(message))];
    }
    case "system": {
      return [];
    }
    case "tool": {
      return message.parts.map((part) =>
        formatTraceLine(`Tool:${part.name}`, summarizeToolResult(part))
      );
    }
    case "user": {
      return [formatTraceLine("User", summarizeUserMessage(message))];
    }
    default: {
      return [];
    }
  }
}

function formatTraceLine(label: string, text: string): string {
  return text.length === 0 ? `[${label}]` : `[${label}] ${text}`;
}

function summarizeTraceText(text: string, limit = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function summarizeTraceValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${summarizeTraceText(value)}"`;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  try {
    return summarizeTraceText(JSON.stringify(value));
  } catch {
    return "[Unserializable result]";
  }
}

function extractLastVisibleAssistantOutputParts(
  messages: readonly TuvrenMessage[]
): UserMessageParts {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message === undefined || message.role !== "assistant") {
      continue;
    }

    const visibleParts = cloneVisibleAssistantParts(message.parts);
    const nonEmptyVisibleParts = toNonEmptyArray(visibleParts);

    return nonEmptyVisibleParts ?? [{ text: "", type: "text" }];
  }

  return [{ text: "", type: "text" }];
}

function cloneVisibleAssistantParts(
  parts: Extract<TuvrenMessage, { role: "assistant" }>["parts"]
): UserMessageParts[number][] {
  const visibleParts: UserMessageParts[number][] = [];

  for (const part of parts) {
    switch (part.type) {
      case "file": {
        visibleParts.push({
          data:
            typeof part.data === "string"
              ? part.data
              : new Uint8Array(part.data),
          filename: part.filename,
          mediaType: part.mediaType,
          type: "file",
        });
        break;
      }
      case "structured": {
        visibleParts.push({
          data: structuredClone(part.data),
          name: part.name,
          type: "structured",
        });
        break;
      }
      case "text": {
        visibleParts.push({
          text: part.text,
          type: "text",
        });
        break;
      }
      default: {
        break;
      }
    }
  }

  return visibleParts;
}

function toNonEmptyArray<T>(values: T[]): [T, ...T[]] | undefined {
  const [firstValue, ...remainingValues] = values;

  if (firstValue === undefined) {
    return undefined;
  }

  return [firstValue, ...remainingValues];
}

function summarizeUserMessage(
  message: Extract<TuvrenMessage, { role: "user" }>
): string {
  const summaryParts: string[] = [];
  let structuredCount = 0;
  let fileCount = 0;

  for (const part of message.parts) {
    switch (part.type) {
      case "text": {
        summaryParts.push(`Text request: ${summarizeTraceText(part.text)}`);
        break;
      }
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
        ? "Structured input provided"
        : `${structuredCount} structured inputs provided`
    );
  }

  if (fileCount > 0) {
    summaryParts.push(
      fileCount === 1
        ? "File attachment provided"
        : `${fileCount} file attachments provided`
    );
  }

  return summaryParts.length > 0
    ? summaryParts.join("; ")
    : "Non-text user content provided";
}

function summarizeToolResult(part: ToolResultPart): string {
  return part.isError === true
    ? `Reported an error result: ${summarizeTraceValue(part.output)}`
    : `Returned a result: ${summarizeTraceValue(part.output)}`;
}

function summarizeAssistantMessage(
  message: Extract<TuvrenMessage, { role: "assistant" }>
): string {
  const summaryParts: string[] = [];
  let structuredCount = 0;
  let fileCount = 0;

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        summaryParts.push(`Text output: ${summarizeTraceText(part.text)}`);
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
    ? summaryParts.join("; ")
    : "[Previous agent work omitted for compatibility]";
}
