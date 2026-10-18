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

import { assertHashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "@tuvren/core/provider";
import { assertRunnerExecutionResult } from "@tuvren/core/runner";
import type { RunnerExecutionContext } from "@tuvren/core/runner";
import type { ProviderStreamChunk, TuvrenProvider } from "@tuvren/provider-api";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";

import { createReActRunner } from "../../runners/react/src/index.ts";
import {
  executeGenerateCall,
  executeStreamCall,
} from "../../runners/react/src/lib/react-runner-stream.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createClock,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createRunnerExecutionContext,
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterProviderScenarioDependencies {
  readAssistantText: (
    messages: readonly unknown[],
    expectedText: string
  ) => string | undefined;
  readFirstErrorEnvelope: (
    events: readonly unknown[]
  ) => Record<string, unknown> | undefined;
  readModelResponseProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => TuvrenModelResponse;
  readOperationScenario: (
    input: unknown,
    operation: string
  ) => Record<string, unknown>;
  readPromptProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => TuvrenPrompt;
  readProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => unknown;
  readProviderStreamChunks: (
    record: Record<string, unknown>,
    path: string
  ) => ProviderStreamChunk[];
  readResponseFormatProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => StructuredOutputRequest;
  readScenarioToolCall: (
    record: Record<string, unknown>,
    path: string
  ) => {
    readonly callId: string;
    readonly input: unknown;
    readonly name: string;
    readonly output?: unknown;
    readonly requiresApproval?: boolean;
    readonly throwMessage?: string;
  };
  readScenarioToolCalls: (
    record: Record<string, unknown>,
    path: string
  ) => {
    readonly callId: string;
    readonly input: unknown;
    readonly name: string;
    readonly output?: unknown;
    readonly requiresApproval?: boolean;
    readonly throwMessage?: string;
  }[];
  readStringProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => string;
}

const fromSynchronousWithoutArguments = <Value>(
  operation: () => Value
): (() => Promise<Value>) =>
  Promise.try.bind<typeof Promise, [() => Value], [], Promise<Value>>(
    Promise,
    operation
  );

const fromSynchronous = <Argument, Value>(
  operation: (argument: Argument) => Value
): ((argument: Argument) => Promise<Value>) =>
  Promise.try.bind<
    typeof Promise,
    [(argument: Argument) => Value],
    [Argument],
    Promise<Value>
  >(Promise, operation);

const createClonedAsyncIterable = <Value>(
  values: readonly Value[],
  onStart?: () => void
): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<Value> => {
    onStart?.();
    const iterator = values[Symbol.iterator]();
    return {
      next: fromSynchronousWithoutArguments(() => {
        const step = iterator.next();
        return step.done === true
          ? step
          : { done: false, value: structuredClone(step.value) };
      }),
    };
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readEventType = (event: unknown): string | undefined =>
  isRecord(event) && typeof event.type === "string" ? event.type : undefined;

const findEventIndex = (
  events: readonly unknown[],
  type: string,
  callId?: string
): number =>
  events.findIndex((event) => {
    if (readEventType(event) !== type) {
      return false;
    }

    return callId === undefined || (isRecord(event) && event.callId === callId);
  });

const isFirstToolCallIdOwnedByFramework = (
  response: TuvrenModelResponse
): boolean => {
  for (const part of response.parts) {
    if (part.type !== "tool_call") {
      continue;
    }

    const providerCallId = isRecord(part.providerMetadata)
      ? part.providerMetadata.providerCallId
      : undefined;

    return typeof providerCallId === "string" && part.callId !== providerCallId;
  }

  return false;
};

const didParallelWaveStartBeforeResults = (
  events: readonly unknown[]
): boolean => {
  const resultIndex = findEventIndex(events, "tool.result");

  if (resultIndex < 0) {
    return false;
  }

  const startedCallIds = new Set<string>();

  for (let index = 0; index < resultIndex; index += 1) {
    const event = events[index];

    if (
      isRecord(event) &&
      event.type === "tool.start" &&
      typeof event.callId === "string"
    ) {
      startedCallIds.add(event.callId);
    }
  }

  return startedCallIds.size >= 2;
};

const readToolResultParts = (
  messages: readonly unknown[]
): Record<string, unknown>[] => {
  const results: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") {
      continue;
    }

    const { parts } = message;

    if (!Array.isArray(parts)) {
      continue;
    }

    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }

      results.push({
        callId: part.callId,
        isError: part.isError === true,
        name: part.name,
        output: part.output,
      });
    }
  }

  return results;
};

const resolveSchemaDialect = (schema: unknown): string => {
  if (!isRecord(schema) || schema.$schema === undefined) {
    return "draft-07";
  }

  if (typeof schema.$schema !== "string") {
    return "unsupported";
  }

  if (schema.$schema.includes("2020-12")) {
    return "draft-2020-12";
  }

  if (schema.$schema.includes("2019-09")) {
    return "draft-2019-09";
  }

  if (schema.$schema.includes("draft-07")) {
    return "draft-07";
  }

  return "unsupported";
};

const readErrorCode = (error: Error): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const readCheckpointHashes = (events: readonly unknown[]): string[] => {
  const hashes: string[] = [];

  for (const event of events) {
    if (!isRecord(event) || event.type !== "state.checkpoint") {
      continue;
    }

    const { turnNodeHash } = event;

    if (typeof turnNodeHash !== "string") {
      continue;
    }

    assertHashString(turnNodeHash, "state.checkpoint.turnNodeHash");
    hashes.push(turnNodeHash);
  }

  return hashes;
};

const readRunnerObservedMessageCount = (
  events: readonly unknown[]
): number | undefined => {
  for (const event of events) {
    if (!isRecord(event) || event.type !== "custom") {
      continue;
    }

    if (event.name !== "runner.executed" || !isRecord(event.data)) {
      continue;
    }

    const { messageCount } = event.data;

    if (typeof messageCount === "number") {
      return messageCount;
    }
  }

  return undefined;
};

const readSnapshotMessageCounts = (events: readonly unknown[]): number[] => {
  const counts: number[] = [];

  for (const event of events) {
    if (
      isRecord(event) &&
      event.type === "state.snapshot" &&
      isRecord(event.manifest) &&
      typeof event.manifest.messageCount === "number"
    ) {
      counts.push(event.manifest.messageCount);
    }
  }

  return counts;
};

export const createFrameworkAdapterProviderScenarios = (
  dependencies: FrameworkAdapterProviderScenarioDependencies
): {
  runContextTransform: (input: unknown) => Promise<AdapterProjection>;
  runProviderGenerate: (input: unknown) => Promise<AdapterProjection>;
  runProviderStream: (input: unknown) => Promise<AdapterProjection>;
  runStructuredValidationFailure: (
    input: unknown
  ) => Promise<AdapterProjection>;
  runToolExecution: (input: unknown) => Promise<AdapterProjection>;
} => {
  const runProviderGenerate = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.provider-generate"
    );
    const response = dependencies.readModelResponseProperty(
      scenario,
      "providerResponse",
      "runtime.provider-generate.providerResponse"
    );
    const prompt = dependencies.readPromptProperty(
      scenario,
      "prompt",
      "runtime.provider-generate.prompt"
    );
    let generateCalls = 0;
    const provider: TuvrenProvider = {
      generate: fromSynchronousWithoutArguments(() => {
        generateCalls += 1;
        return structuredClone(response);
      }),
      id: "provider",
      stream: () => createClonedAsyncIterable([]),
    };
    const sequence = await executeGenerateCall({
      now: createClock(),
      prompt,
      provider,
    });

    return {
      evidence: {
        provider: {
          generate: {
            callCount: generateCalls,
            eventTypes: sequence.events.map((event) => event.type),
            partKeys: sequence.response.parts.map((part) => Object.keys(part)),
            response: sequence.response,
          },
        },
      },
      result: {
        provider: {
          generate: {
            callCount: generateCalls,
            eventTypes: sequence.events.map((event) => event.type),
            partKeys: sequence.response.parts.map((part) => Object.keys(part)),
            response: sequence.response,
          },
        },
      },
    };
  };

  const runProviderStream = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.provider-stream"
    );
    const chunks = dependencies.readProviderStreamChunks(
      scenario,
      "runtime.provider-stream.streamChunks"
    );
    const prompt = dependencies.readPromptProperty(
      scenario,
      "prompt",
      "runtime.provider-stream.prompt"
    );
    let streamCalls = 0;
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider: TuvrenProvider = {
      generate: fromSynchronousWithoutArguments((): never => {
        throw new Error("generate must not run during stream conformance");
      }),
      id: "provider",
      stream: () =>
        createClonedAsyncIterable(chunks, () => {
          streamCalls += 1;
        }),
    };
    const sequence = await executeStreamCall({
      now: createClock(),
      prompt,
      provider,
      runtime: {
        emit(event) {
          emittedEvents.push(event);
        },
        now: createClock(),
      },
    });

    return {
      evidence: {
        provider: {
          stream: {
            callCount: streamCalls,
            chunkTypes: chunks.map((chunk) => chunk.type),
            emittedEventTypes: emittedEvents.map((event) => event.type),
            response: sequence.response,
            structuredDeltaIndex: findEventIndex(
              emittedEvents,
              "structured.delta"
            ),
            structuredDoneIndex: findEventIndex(
              emittedEvents,
              "structured.done"
            ),
            toolCallIdOwnedByFramework: isFirstToolCallIdOwnedByFramework(
              sequence.response
            ),
          },
        },
      },
      result: {
        provider: {
          stream: {
            callCount: streamCalls,
            chunkTypes: chunks.map((chunk) => chunk.type),
            emittedEventTypes: emittedEvents.map((event) => event.type),
            response: sequence.response,
            structuredDeltaIndex: findEventIndex(
              emittedEvents,
              "structured.delta"
            ),
            structuredDoneIndex: findEventIndex(
              emittedEvents,
              "structured.done"
            ),
            toolCallIdOwnedByFramework: isFirstToolCallIdOwnedByFramework(
              sequence.response
            ),
          },
        },
      },
    };
  };

  const readScenarioToolCallList = (
    scenario: Record<string, unknown>
  ): ReturnType<
    FrameworkAdapterProviderScenarioDependencies["readScenarioToolCalls"]
  > => {
    if (Array.isArray(scenario.toolCalls)) {
      return dependencies.readScenarioToolCalls(
        scenario,
        "runtime.tool-execute.toolCalls"
      );
    }

    if (!isRecord(scenario.toolCall)) {
      throw new Error("runtime.tool-execute.toolCall must be an object");
    }

    return [
      dependencies.readScenarioToolCall(
        scenario.toolCall,
        "runtime.tool-execute.toolCall"
      ),
    ];
  };

  const runToolExecution = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.tool-execute"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.tool-execute.prompt"
    );
    const calls = readScenarioToolCallList(scenario);
    const toolResult = dependencies.readProperty(
      scenario,
      "toolResult",
      "runtime.tool-execute.toolResult"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runtime.tool-execute.finalText"
    );
    const harness = createConformanceKernelHarness();
    let toolCalls = 0;
    const toolInputs: unknown[] = [];
    const toolOutputs: unknown[] = [];
    const toolFailures: string[] = [];
    const runner = createStaticRunner(
      fromSynchronous((context: RunnerExecutionContext) => {
        if (!context.messages.some((message) => message.role === "tool")) {
          return {
            messages: [assistantToolCalls(calls)],
            resolution: { type: "continue_iteration" as const },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText(finalText)],
          resolution: {
            reason: "done",
            type: "end_turn" as const,
          },
        };
      })
    );
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: AGENT_NAME,
        tools: calls.map((call) => ({
          description: `Shared conformance tool ${call.name}`,
          execute() {
            toolCalls += 1;
            toolInputs.push(call.input);

            if (call.throwMessage !== undefined) {
              toolFailures.push(call.name);
              throw new Error(call.throwMessage);
            }

            const output = call.output ?? toolResult;
            toolOutputs.push(output);
            return output;
          },
          inputSchema: { type: "object" },
          name: call.name,
        })),
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });

    const events = await collectValues(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    return {
      evidence: {
        tool: {
          execution: {
            callCount: toolCalls,
            eventTypes: events.map((event) => readEventType(event)),
            failureNames: toolFailures,
            firstToolResultIndex: findEventIndex(events, "tool.result"),
            inputs: toolInputs,
            outputs: toolOutputs,
            parallelWaveStartedBeforeResults:
              didParallelWaveStartBeforeResults(events),
            secondToolStartIndex: findEventIndex(
              events,
              "tool.start",
              "call-email"
            ),
            toolResults: readToolResultParts(messages),
          },
        },
      },
      result: {
        tool: {
          execution: {
            callCount: toolCalls,
            eventTypes: events.map((event) => readEventType(event)),
            failureNames: toolFailures,
            firstToolResultIndex: findEventIndex(events, "tool.result"),
            inputs: toolInputs,
            outputs: toolOutputs,
            parallelWaveStartedBeforeResults:
              didParallelWaveStartBeforeResults(events),
            secondToolStartIndex: findEventIndex(
              events,
              "tool.start",
              "call-email"
            ),
            toolResults: readToolResultParts(messages),
          },
        },
      },
      state: {
        toolExecution: {
          error: dependencies.readFirstErrorEnvelope(events),
          status: handle.status(),
        },
      },
    };
  };

  const runStructuredValidationFailure = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.validate-structured-output"
    );
    const response = dependencies.readModelResponseProperty(
      scenario,
      "providerResponse",
      "runtime.validate-structured-output.providerResponse"
    );
    const responseFormat = dependencies.readResponseFormatProperty(
      scenario,
      "responseFormat",
      "runtime.validate-structured-output.responseFormat"
    );
    const provider: TuvrenProvider = {
      generate: fromSynchronousWithoutArguments(() =>
        structuredClone(response)
      ),
      id: "provider",
      stream: () => createClonedAsyncIterable([]),
    };
    const runner = createReActRunner({ providerCallMode: "generate" }).create();
    const result = await runner.execute(
      createRunnerExecutionContext({
        config: {
          model: provider,
          name: AGENT_NAME,
          responseFormat,
        },
      })
    );

    assertRunnerExecutionResult(result, "structured validation result");

    return {
      evidence: {
        validation: {
          dialect: resolveSchemaDialect(responseFormat.schema),
          error:
            result.resolution.type === "fail"
              ? {
                  code: readErrorCode(result.resolution.error),
                  message: result.resolution.error.message,
                }
              : undefined,
          resolutionType: result.resolution.type,
        },
      },
      result: {
        validation: {
          dialect: resolveSchemaDialect(responseFormat.schema),
          error:
            result.resolution.type === "fail"
              ? {
                  code: readErrorCode(result.resolution.error),
                  message: result.resolution.error.message,
                }
              : undefined,
          resolutionType: result.resolution.type,
        },
      },
    };
  };

  const runContextTransform = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.context-transform"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.context-transform.prompt"
    );
    const summaryText = dependencies.readStringProperty(
      scenario,
      "summaryText",
      "runtime.context-transform.summaryText"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runtime.context-transform.finalText"
    );
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(async (context) => {
          await context.runtime.emit({
            data: {
              messageCount: context.messages.length,
            },
            name: "runner.executed",
            timestamp: context.runtime.now(),
            type: "custom",
          });

          return {
            messages: [assistantText(finalText)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        contextPolicy: {
          evaluate(_manifest, iterationCount) {
            if (iterationCount !== 1) {
              return { action: "none" };
            }

            return {
              action: "append_shared_summary",
              execute(context) {
                return [
                  ...context.messageHashes,
                  context.helpers.storeMessage(assistantText(summaryText)),
                ];
              },
            };
          },
        },
        name: AGENT_NAME,
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });

    const events = await collectValues(handle.events());
    const manifest = await harness.readBranchManifest(thread.branchId);
    const messages = await harness.readBranchMessages(thread.branchId);
    const checkpointHashes = readCheckpointHashes(events);
    const [sourceTurnNodeHash, rewrittenTurnNodeHash] = checkpointHashes;
    const finalTurnNodeHash = checkpointHashes.at(-1);
    const sourceMessages =
      sourceTurnNodeHash === undefined
        ? []
        : await harness.readTurnNodeMessages(sourceTurnNodeHash);
    const rewrittenMessages =
      rewrittenTurnNodeHash === undefined
        ? []
        : await harness.readTurnNodeMessages(rewrittenTurnNodeHash);

    return {
      events,
      evidence: {
        context: {
          checkpointHashes,
          createdNewHead:
            sourceTurnNodeHash !== undefined &&
            rewrittenTurnNodeHash !== undefined &&
            sourceTurnNodeHash !== rewrittenTurnNodeHash,
          finalHeadChanged:
            rewrittenTurnNodeHash !== undefined &&
            finalTurnNodeHash !== undefined &&
            rewrittenTurnNodeHash !== finalTurnNodeHash,
          messageCount: messages.length,
          rewrittenMessageCount: rewrittenMessages.length,
          runnerObservedMessageCount: readRunnerObservedMessageCount(events),
          snapshotMessageCounts: readSnapshotMessageCounts(events),
          sourceMessageCount: sourceMessages.length,
          summaryText: dependencies.readAssistantText(messages, summaryText),
        },
        runtime: {
          phase: handle.status().phase,
        },
      },
      result: {
        context: {
          checkpointHashes,
          createdNewHead:
            sourceTurnNodeHash !== undefined &&
            rewrittenTurnNodeHash !== undefined &&
            sourceTurnNodeHash !== rewrittenTurnNodeHash,
          finalHeadChanged:
            rewrittenTurnNodeHash !== undefined &&
            finalTurnNodeHash !== undefined &&
            rewrittenTurnNodeHash !== finalTurnNodeHash,
          messageCount: messages.length,
          rewrittenMessageCount: rewrittenMessages.length,
          runnerObservedMessageCount: readRunnerObservedMessageCount(events),
          snapshotMessageCounts: readSnapshotMessageCounts(events),
          sourceMessageCount: sourceMessages.length,
          summaryText: dependencies.readAssistantText(messages, summaryText),
        },
        runtime: {
          phase: handle.status().phase,
        },
      },
      state: {
        context: {
          manifest,
        },
      },
    };
  };

  return {
    runContextTransform,
    runProviderGenerate,
    runProviderStream,
    runStructuredValidationFailure,
    runToolExecution,
  };
};
