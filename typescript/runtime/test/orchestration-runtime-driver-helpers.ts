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

// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity lint/suspicious/useAwait: Shared driver test doubles intentionally centralize event emission and async contract stubs.

import type {
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
  RuntimeDriverFactory as KrakenDriverFactory,
} from "@tuvren/core/driver";
import { createDriverRegistry as createBaseDriverRegistry } from "../src/index.ts";

export function createDriverRegistry(
  drivers: Array<KrakenDriver | KrakenDriverFactory> = []
) {
  return createBaseDriverRegistry(drivers.map(wrapDriverEntry));
}

function wrapDriverEntry(
  entry: KrakenDriver | KrakenDriverFactory
): KrakenDriver | KrakenDriverFactory {
  if (isKrakenDriverFactory(entry)) {
    return {
      create() {
        return wrapDriver(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapDriver(entry);
}

function isKrakenDriverFactory(
  entry: KrakenDriver | KrakenDriverFactory
): entry is KrakenDriverFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapDriver(driver: KrakenDriver): KrakenDriver {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeDriverResult(await driver.execute(context));
    },
    id: driver.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeDriverResult(await resume(context));
          },
        }),
  };
}

function normalizeDriverResult(
  result: DriverExecutionResult
): DriverExecutionResult {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
}

function requestsToolExecution(result: DriverExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}

export function createStaticDriver(
  execute: (
    context: DriverExecutionContext
  ) => DriverExecutionResult | Promise<DriverExecutionResult>,
  id = "fake"
): KrakenDriver {
  let emittedMessageSequence = 0;

  return {
    async execute(context) {
      const result = await execute(context);

      for (const message of result.messages ?? []) {
        if (message.role !== "assistant") {
          continue;
        }

        emittedMessageSequence += 1;
        const messageId = `assistant-${emittedMessageSequence}`;
        context.runtime.emit({
          messageId,
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });

        for (const part of message.parts) {
          switch (part.type) {
            case "file":
              context.runtime.emit({
                data:
                  typeof part.data === "string"
                    ? part.data
                    : new Uint8Array(part.data),
                filename: part.filename,
                mediaType: part.mediaType,
                messageId,
                timestamp: context.runtime.now(),
                type: "file.done",
              });
              break;
            case "structured":
              context.runtime.emit({
                delta: serializeDriverDeltaValue(part.data),
                messageId,
                timestamp: context.runtime.now(),
                type: "structured.delta",
              });
              context.runtime.emit({
                data: part.data,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "structured.done",
              });
              break;
            case "tool_call":
              context.runtime.emit({
                callId: part.callId,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "tool_call.start",
              });
              context.runtime.emit({
                callId: part.callId,
                delta: serializeDriverDeltaValue(part.input),
                timestamp: context.runtime.now(),
                type: "tool_call.args_delta",
              });
              context.runtime.emit({
                callId: part.callId,
                input: part.input,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "tool_call.done",
              });
              break;
            case "text":
              context.runtime.emit({
                delta: part.text,
                messageId,
                timestamp: context.runtime.now(),
                type: "text.delta",
              });
              context.runtime.emit({
                messageId,
                text: part.text,
                timestamp: context.runtime.now(),
                type: "text.done",
              });
              break;
            case "reasoning":
              if (!part.redacted) {
                context.runtime.emit({
                  delta: part.text,
                  messageId,
                  timestamp: context.runtime.now(),
                  type: "reasoning.delta",
                });
              }

              context.runtime.emit({
                messageId,
                timestamp: context.runtime.now(),
                type: "reasoning.done",
              });
              break;
            default:
              break;
          }
        }

        context.runtime.emit({
          finishReason: message.parts.some((part) => part.type === "tool_call")
            ? "tool_call"
            : "stop",
          messageId,
          timestamp: context.runtime.now(),
          type: "message.done",
        });
      }

      return result;
    },
    id,
    async resume() {
      throw new Error("resume was not expected");
    },
  };
}

function serializeDriverDeltaValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value) ?? "null";
}
