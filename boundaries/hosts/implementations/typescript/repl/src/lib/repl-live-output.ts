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

import type { ApprovalRequest, TuvrenStreamEvent } from "@tuvren/runtime";

const ANSI_RESET = "\u001B[0m";
const MAX_INLINE_EVENT_TEXT_LENGTH = 180;

type LiveLineKind = "assistant" | "thinking";
type LiveColor =
  | "blue"
  | "cyan"
  | "green"
  | "grey"
  | "magenta"
  | "red"
  | "yellow";

export interface ReplLiveTurnWriter {
  finish(): void;
  observe(event: TuvrenStreamEvent): void;
}

export interface ReplLiveTurnWriterOptions {
  useAnsiColors?: boolean;
}

export function createLiveTurnWriter(
  write: (chunk: string) => void,
  options?: ReplLiveTurnWriterOptions
): ReplLiveTurnWriter {
  let activeLine: LiveLineKind | undefined;
  const useAnsiColors = options?.useAnsiColors ?? false;

  return {
    finish() {
      if (activeLine === undefined) {
        return;
      }

      write("\n");
      activeLine = undefined;
    },
    observe(event) {
      switch (event.type) {
        case "message.done":
          if (activeLine === "assistant") {
            write("\n");
            activeLine = undefined;
          }
          return;
        case "reasoning.delta":
          ensureLine("thinking");
          write(styleText(event.delta, "grey"));
          return;
        case "reasoning.done":
          if (activeLine === "thinking") {
            write("\n");
            activeLine = undefined;
          }
          return;
        case "structured.delta":
          ensureLine("assistant");
          write(styleText(event.delta, "blue"));
          return;
        case "text.delta":
          ensureLine("assistant");
          write(styleText(event.delta, "cyan"));
          return;
        case "approval.requested":
          writeStandaloneLine(
            "approval",
            renderApprovalRequest(event.request),
            "yellow"
          );
          return;
        case "approval.resolved":
          writeStandaloneLine(
            "approval",
            renderApprovalResolved(event.response),
            "yellow"
          );
          return;
        case "custom":
          writeStandaloneLine(
            "event",
            `${event.name} ${renderInlineValue(event.data)}`,
            "magenta"
          );
          return;
        case "error":
          writeStandaloneLine(
            "error",
            renderErrorLine(event),
            "red"
          );
          return;
        case "steering.incorporated":
          writeStandaloneLine(
            "steering",
            "incorporated",
            "blue"
          );
          return;
        case "tool_call.done":
          writeStandaloneLine(
            "tool-call",
            `${event.name} ${renderInlineValue(event.input)}`,
            "yellow"
          );
          return;
        case "tool.result":
          writeStandaloneLine(
            event.isError === true ? "tool-error" : "tool-result",
            `${event.name} ${renderInlineValue(event.output)}`,
            event.isError === true ? "red" : "green"
          );
          return;
        default:
          return;
      }
    },
  };

  function ensureLine(next: LiveLineKind): void {
    if (activeLine === next) {
      return;
    }

    if (activeLine !== undefined) {
      write("\n");
    }

    write(
      next === "thinking"
        ? styleText("thinking> ", "grey")
        : styleText("assistant> ", "cyan")
    );
    activeLine = next;
  }

  function writeStandaloneLine(
    label: string,
    message: string,
    color: LiveColor
  ): void {
    if (activeLine !== undefined) {
      write("\n");
      activeLine = undefined;
    }

    write(
      `${styleText(`${label}> `, color)}${styleText(message, color)}\n`
    );
  }

  function renderInlineValue(value: unknown): string {
    const serialized = serializeInlineValue(value);

    if (serialized.length <= MAX_INLINE_EVENT_TEXT_LENGTH) {
      return serialized;
    }

    return `${serialized.slice(0, MAX_INLINE_EVENT_TEXT_LENGTH - 3)}...`;
  }

  function serializeInlineValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    try {
      const serialized = JSON.stringify(value);

      if (serialized !== undefined) {
        return serialized;
      }
    } catch (_error: unknown) {
      return String(value);
    }

    return String(value);
  }

  function renderApprovalRequest(request: ApprovalRequest): string {
    const pendingTools = request.toolCalls
      .map((toolCall) => `${toolCall.name} ${renderInlineValue(toolCall.input)}`)
      .join("; ");
    const completedCount = request.completedResults.length;
    const completedSuffix =
      completedCount === 0 ? "" : ` | completed: ${completedCount}`;

    return `1 approve | 2 reject | 3 edit | pending: ${pendingTools}${completedSuffix}`;
  }

  function renderApprovalResolved(
    response: Extract<TuvrenStreamEvent, { type: "approval.resolved" }>["response"]
  ): string {
    const decisionTypes = response.decisions.map((decision) => decision.type);

    return `resolved: ${decisionTypes.join(", ")}`;
  }

  function renderErrorLine(
    event: Extract<TuvrenStreamEvent, { type: "error" }>
  ): string {
    const errorCode =
      typeof event.error.code === "string" ? `${event.error.code} ` : "";
    const fatality = event.fatal ? "fatal " : "";

    return `${fatality}${errorCode}${event.error.message}`.trim();
  }

  function styleText(text: string, color: LiveColor): string {
    if (!useAnsiColors) {
      return text;
    }

    return `${readAnsiCode(color)}${text}${ANSI_RESET}`;
  }

  function readAnsiCode(color: LiveColor): string {
    switch (color) {
      case "blue":
        return "\u001B[34m";
      case "cyan":
        return "\u001B[36m";
      case "green":
        return "\u001B[32m";
      case "grey":
        return "\u001B[90m";
      case "magenta":
        return "\u001B[35m";
      case "red":
        return "\u001B[31m";
      case "yellow":
        return "\u001B[33m";
      default:
        return "";
    }
  }
}
