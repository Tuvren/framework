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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  RunnerExecutionContext,
  RunnerExecutionResult,
  RunnerResumeContext,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";

import { createRunnerRegistry as createBaseRunnerRegistry } from "../src/index.ts";
import { fromSynchronousVariadicAwaited } from "./runtime-core-test-helpers.ts";

const isKrakenRunnerFactory = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory =>
  "create" in entry && typeof entry.create === "function";

const requestsToolExecution = (result: RunnerExecutionResult): boolean =>
  (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );

const normalizeRunnerResult = (
  result: RunnerExecutionResult
): RunnerExecutionResult => {
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
};

const resumeRunner = async (
  runner: RuntimeRunner,
  context: RunnerResumeContext
): Promise<RunnerExecutionResult> => {
  if (runner.resume === undefined) {
    throw new Error(`runner "${runner.id}" does not support resume`);
  }

  return normalizeRunnerResult(await runner.resume(context));
};

const wrapRunner = (runner: RuntimeRunner): RuntimeRunner => {
  if (runner.resume === undefined) {
    return {
      async execute(context) {
        return normalizeRunnerResult(await runner.execute(context));
      },
      id: runner.id,
    };
  }

  return {
    async execute(context) {
      return normalizeRunnerResult(await runner.execute(context));
    },
    id: runner.id,
    async resume(context) {
      return await resumeRunner(runner, context);
    },
  };
};

const wrapRunnerEntry = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory => {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
};

export const createRunnerRegistry = (
  runners: (RuntimeRunner | RuntimeRunnerFactory)[] = []
) => createBaseRunnerRegistry(runners.map(wrapRunnerEntry));

const serializeRunnerDeltaValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value) ?? "null";
};

const emitAfter = async (
  runtime: RunnerExecutionContext["runtime"],
  previous: Promise<void>,
  event: TuvrenStreamEvent
): Promise<void> => {
  await previous;
  await runtime.emit(event);
};

const createSequentialEventEmitter = (
  runtime: RunnerExecutionContext["runtime"]
) => {
  let pending: Promise<void> | undefined;

  return {
    emit(event: TuvrenStreamEvent) {
      if (pending === undefined) {
        const result = runtime.emit(event);
        if (result instanceof Promise) {
          pending = result;
        }
        return;
      }

      pending = emitAfter(runtime, pending, event);
    },
    async finish() {
      if (pending !== undefined) {
        await pending;
      }
    },
  };
};

export const createStaticRunner = (
  execute: (
    context: RunnerExecutionContext
  ) => RunnerExecutionResult | Promise<RunnerExecutionResult>,
  id = "fake"
): RuntimeRunner => {
  let emittedMessageSequence = 0;

  return {
    async execute(context) {
      const result = await execute(context);
      const emitter = createSequentialEventEmitter(context.runtime);

      for (const message of result.messages ?? []) {
        if (message.role !== "assistant") {
          continue;
        }

        emittedMessageSequence += 1;
        const messageId = `assistant-${emittedMessageSequence}`;
        emitter.emit({
          messageId,
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });

        for (const part of message.parts) {
          switch (part.type) {
            case "file": {
              emitter.emit({
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
            }
            case "structured": {
              emitter.emit({
                delta: serializeRunnerDeltaValue(part.data),
                messageId,
                timestamp: context.runtime.now(),
                type: "structured.delta",
              });
              emitter.emit({
                data: part.data,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "structured.done",
              });
              break;
            }
            case "tool_call": {
              emitter.emit({
                callId: part.callId,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "tool_call.start",
              });
              emitter.emit({
                callId: part.callId,
                delta: serializeRunnerDeltaValue(part.input),
                timestamp: context.runtime.now(),
                type: "tool_call.args_delta",
              });
              emitter.emit({
                callId: part.callId,
                input: part.input,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "tool_call.done",
              });
              break;
            }
            case "text": {
              emitter.emit({
                delta: part.text,
                messageId,
                timestamp: context.runtime.now(),
                type: "text.delta",
              });
              emitter.emit({
                messageId,
                text: part.text,
                timestamp: context.runtime.now(),
                type: "text.done",
              });
              break;
            }
            case "reasoning": {
              if (!part.redacted) {
                emitter.emit({
                  delta: part.text,
                  messageId,
                  timestamp: context.runtime.now(),
                  type: "reasoning.delta",
                });
              }

              emitter.emit({
                messageId,
                timestamp: context.runtime.now(),
                type: "reasoning.done",
              });
              break;
            }
            case "tool_result": {
              break;
            }
            default: {
              break;
            }
          }
        }

        emitter.emit({
          finishReason: message.parts.some((part) => part.type === "tool_call")
            ? "tool_call"
            : "stop",
          messageId,
          timestamp: context.runtime.now(),
          type: "message.done",
        });
      }

      await emitter.finish();
      return result;
    },
    id,
    resume: fromSynchronousVariadicAwaited(() => {
      throw new Error("resume was not expected");
    }),
  };
};
