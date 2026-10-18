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

import { setTimeout as delay } from "node:timers/promises";

import { assertHashString } from "@tuvren/core";
import type { ExecutionHandle } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type {
  ApprovalDecision,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";

import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

interface RuntimeLifecycleScenarioDependencies {
  isRecord: (value: unknown) => value is Record<string, unknown>;
  readApprovalDecisions: (
    record: Record<string, unknown>,
    path: string
  ) => ApprovalDecision[];
  readOperationScenario: (
    input: unknown,
    operation: string
  ) => Record<string, unknown>;
  readRecordString: (value: unknown, key: string) => string | undefined;
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

const hasToolMessage = (messages: readonly TuvrenMessage[]): boolean =>
  messages.some((message) => message.role === "tool");

export const waitForAbort = async (
  signal: AbortSignal | undefined
): Promise<void> => {
  if (signal === undefined || signal.aborted) {
    return;
  }

  const aborted = Promise.withResolvers<undefined>();
  signal.addEventListener(
    "abort",
    () => {
      aborted.resolve();
    },
    { once: true }
  );
  await aborted.promise;
};

const waitForHandlePhase = async (
  handle: ExecutionHandle,
  phase: "completed" | "failed" | "paused" | "running",
  attemptsRemaining = 50
): Promise<void> => {
  if (handle.status().phase === phase) {
    return;
  }
  if (attemptsRemaining === 0) {
    throw new Error(`handle did not reach ${phase} phase`);
  }

  await delay(1);
  await waitForHandlePhase(handle, phase, attemptsRemaining - 1);
};

const runTerminalValueComplete = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([
      createStaticRunner(() => ({
        messages: [assistantText("Terminal complete.")],
        resolution: { reason: "done", type: "end_turn" },
      })),
    ]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("complete"),
    threadId: thread.threadId,
  });
  const result = await handle.awaitResult();
  const finalMsg =
    result.status === "completed" ? result.finalAssistantMessage : undefined;
  const textPart =
    finalMsg?.role === "assistant"
      ? finalMsg.parts.find((part) => part.type === "text")
      : undefined;

  return {
    result: {
      handle: {
        awaitResult: {
          finalAssistantMessage:
            textPart?.type === "text"
              ? { parts: [{ text: textPart.text, type: "text" }] }
              : undefined,
          status: result.status,
        },
      },
    },
  };
};

const runTerminalValueFailure = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const malformedMessage = assistantText("malformed");
  Object.defineProperty(malformedMessage, "parts", { value: [123] });
  const failureRunner = {
    execute: fromSynchronousWithoutArguments(() => ({
      messages: [malformedMessage],
      resolution: { reason: "done", type: "end_turn" },
    })),
    id: RUNNER_ID,
  } satisfies RuntimeRunner;
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([failureRunner]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("failure"),
    threadId: thread.threadId,
  });
  const result = await handle.awaitResult();

  return {
    result: { handle: { awaitResult: { status: result.status } } },
  };
};

const runTerminalValueIdempotent = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([
      createStaticRunner(() => ({
        messages: [assistantText("Idempotent.")],
        resolution: { reason: "done", type: "end_turn" },
      })),
    ]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("idempotent"),
    threadId: thread.threadId,
  });
  const result1 = await handle.awaitResult();
  const result2 = await handle.awaitResult();
  const result3 = await handle.awaitResult();

  const allCompleted =
    result1.status === "completed" &&
    result2.status === "completed" &&
    result3.status === "completed";
  const resultsIdentical =
    JSON.stringify(result2) === JSON.stringify(result1) &&
    JSON.stringify(result3) === JSON.stringify(result1);

  return {
    result: {
      handle: {
        awaitResult: { allCompleted, callCount: 3, resultsIdentical },
      },
    },
  };
};

export const createFrameworkAdapterRuntimeLifecycleScenarios = (
  dependencies: RuntimeLifecycleScenarioDependencies
): {
  runApprovalResume: (input: unknown) => Promise<AdapterProjection>;
  runBranchCreate: () => Promise<AdapterProjection>;
  runHandleTerminalValue: (input: unknown) => Promise<AdapterProjection>;
} => {
  const readErrorEnvelope = (error: unknown): Record<string, unknown> => {
    if (error instanceof Error) {
      return {
        code:
          dependencies.isRecord(error) && typeof error.code === "string"
            ? error.code
            : "runtime_error",
        message: error.message,
      };
    }

    return {
      code: "runtime_error",
      message: String(error),
    };
  };

  const readFirstErrorEnvelope = (
    events: readonly unknown[]
  ): Record<string, unknown> | undefined => {
    for (const event of events) {
      if (dependencies.isRecord(event) && dependencies.isRecord(event.error)) {
        return event.error;
      }
    }

    return undefined;
  };

  const readToolResultParts = (
    messages: readonly unknown[]
  ): Record<string, unknown>[] => {
    const results: Record<string, unknown>[] = [];

    for (const message of messages) {
      if (!dependencies.isRecord(message) || message.role !== "tool") {
        continue;
      }

      const { parts } = message;

      if (!Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (!dependencies.isRecord(part)) {
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

  const hasAssistantText = (
    messages: readonly unknown[],
    expectedText: string
  ): boolean => {
    for (const message of messages) {
      if (!dependencies.isRecord(message) || message.role !== "assistant") {
        continue;
      }

      const { parts } = message;

      if (!Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (
          dependencies.isRecord(part) &&
          part.type === "text" &&
          part.text === expectedText
        ) {
          return true;
        }
      }
    }

    return false;
  };

  const readThrownErrorCode = (action: () => void): string | undefined => {
    try {
      action();
      return undefined;
    } catch (error: unknown) {
      if (dependencies.isRecord(error) && typeof error.code === "string") {
        return error.code;
      }

      return undefined;
    }
  };

  const observeSupersededPausedHandle = (
    handle: ExecutionHandle
  ): Record<string, unknown> => ({
    cancelErrorCode: readThrownErrorCode(() => {
      handle.cancel();
    }),
    resolveApprovalErrorCode: readThrownErrorCode(() => {
      handle.resolveApproval({ decisions: [] });
    }),
    statusPhaseAfterResolution: handle.status().phase,
  });

  const findEventIndex = (
    events: readonly unknown[],
    type: string,
    callId?: string
  ): number =>
    events.findIndex((event) => {
      if (dependencies.readRecordString(event, "type") !== type) {
        return false;
      }

      return (
        callId === undefined ||
        dependencies.readRecordString(event, "callId") === callId
      );
    });

  const didEventOccurAfter = (
    events: readonly unknown[],
    earlierType: string,
    laterType: string,
    laterCallId?: string
  ): boolean => {
    const earlierIndex = findEventIndex(events, earlierType);
    const laterIndex = findEventIndex(events, laterType, laterCallId);

    return earlierIndex >= 0 && laterIndex > earlierIndex;
  };

  const readFirstApprovalMessage = (
    toolResults: readonly Record<string, unknown>[]
  ): string | undefined => {
    for (const result of toolResults) {
      const { output } = result;

      if (!dependencies.isRecord(output)) {
        continue;
      }

      const message = dependencies.readRecordString(output, "message");

      if (message !== undefined) {
        return message;
      }

      const error = dependencies.readRecordString(output, "error");

      if (error !== undefined) {
        return error;
      }
    }

    return undefined;
  };

  const readEventStringValues = (
    events: readonly unknown[],
    key: string
  ): string[] => {
    const values = new Set<string>();

    for (const event of events) {
      const value = dependencies.readRecordString(event, key);

      if (value !== undefined) {
        values.add(value);
      }
    }

    return [...values].toSorted();
  };

  const eventStreamsShareTurn = (
    firstEvents: readonly unknown[],
    secondEvents: readonly unknown[]
  ): boolean => {
    const firstTurnIds = readEventStringValues(firstEvents, "turnId");
    const secondTurnIds = readEventStringValues(secondEvents, "turnId");

    return (
      firstTurnIds.length === 1 &&
      secondTurnIds.length === 1 &&
      firstTurnIds[0] === secondTurnIds[0]
    );
  };

  const runApprovalResume = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.approval-resolve"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.approval-resolve.prompt"
    );
    const calls = dependencies.readScenarioToolCalls(
      scenario,
      "runtime.approval-resolve.toolCalls"
    );
    const decisions = dependencies.readApprovalDecisions(
      scenario,
      "runtime.approval-resolve.approvalDecisions"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runtime.approval-resolve.finalText"
    );
    const harness = createConformanceKernelHarness();
    const executedNames: string[] = [];
    const runner = {
      async execute(context) {
        await Promise.resolve();

        if (!hasToolMessage(context.messages)) {
          return {
            messages: [assistantToolCalls(calls)],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText(finalText)],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: RUNNER_ID,
    } satisfies RuntimeRunner;
    const tools = calls.map((call): TuvrenToolDefinition => ({
      approval: call.requiresApproval,
      description: `Shared conformance tool ${call.name}`,
      execute() {
        executedNames.push(call.name);
        return call.output;
      },
      inputSchema: { type: "object" },
      name: call.name,
    }));
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME, tools },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });

    const pausedEvents = await collectValues(pausedHandle.events());
    const pausedPhase = pausedHandle.status().phase;
    const executedNamesBeforeResume = [...executedNames];
    const pausedApprovalCallIds =
      pausedHandle
        .status()
        .approval?.toolCalls.map((toolCall) => toolCall.callId) ?? [];

    if (pausedPhase !== "paused") {
      return {
        evidence: {
          approval: {
            pausedApprovalCallIds,
            pausedEventTypes: pausedEvents.map((event) =>
              dependencies.readRecordString(event, "type")
            ),
            pausedPhase,
          },
          tool: {
            execution: {
              executedNames,
              executedNamesAfterResume: [...executedNames],
              executedNamesBeforeResume,
            },
          },
        },
        result: {
          approval: {
            pausedApprovalCallIds,
            pausedEventTypes: pausedEvents.map((event) =>
              dependencies.readRecordString(event, "type")
            ),
            pausedPhase,
          },
          tool: {
            execution: {
              executedNames,
              executedNamesAfterResume: [...executedNames],
              executedNamesBeforeResume,
            },
          },
        },
        state: {
          approval: pausedHandle.status(),
          approvalError: readFirstErrorEnvelope(pausedEvents),
        },
      };
    }

    if (dependencies.readRecordString(scenario, "case") === "cancel_paused") {
      pausedHandle.cancel();
      await waitForHandlePhase(pausedHandle, "completed");
      const messages = await harness.readBranchMessages(thread.branchId);
      const toolResults = readToolResultParts(messages);

      return {
        evidence: {
          approval: {
            cancelledPhase: pausedHandle.status().phase,
            cancelledToolResults: toolResults,
            pausedApprovalCallIds,
            pausedEventTypes: pausedEvents.map((event) =>
              dependencies.readRecordString(event, "type")
            ),
            pausedPhase,
            resumedTextAbsent: !hasAssistantText(messages, finalText),
          },
          tool: {
            execution: {
              executedNamesAfterCancel: [...executedNames],
              executedNamesBeforeResume,
            },
          },
        },
        result: {
          approval: {
            cancelledPhase: pausedHandle.status().phase,
            cancelledToolResults: toolResults,
            pausedApprovalCallIds,
            pausedEventTypes: pausedEvents.map((event) =>
              dependencies.readRecordString(event, "type")
            ),
            pausedPhase,
            resumedTextAbsent: !hasAssistantText(messages, finalText),
          },
          tool: {
            execution: {
              executedNamesAfterCancel: [...executedNames],
              executedNamesBeforeResume,
            },
          },
        },
      };
    }

    const resumedHandle = pausedHandle.resolveApproval({
      decisions,
    });

    const resumedEvents = await collectValues(resumedHandle.events());
    const handleOwnership = observeSupersededPausedHandle(pausedHandle);
    const messages = await harness.readBranchMessages(thread.branchId);
    const toolResults = readToolResultParts(messages);

    return {
      evidence: {
        approval: {
          decisions,
          gatedToolStartAfterResume: didEventOccurAfter(
            resumedEvents,
            "approval.resolved",
            "tool.start",
            "call-email"
          ),
          handleOwnership,
          messageAttachment: readFirstApprovalMessage(toolResults),
          pausedApprovalCallIds,
          pausedEventTypes: pausedEvents.map((event) =>
            dependencies.readRecordString(event, "type")
          ),
          pausedPhase,
          pausedTurnIds: readEventStringValues(pausedEvents, "turnId"),
          resumedEventTypes: resumedEvents.map((event) =>
            dependencies.readRecordString(event, "type")
          ),
          resumedPhase: resumedHandle.status().phase,
          resumedTurnIds: readEventStringValues(resumedEvents, "turnId"),
          sameTurn: eventStreamsShareTurn(pausedEvents, resumedEvents),
          toolResults,
        },
        tool: {
          execution: {
            executedNames,
            executedNamesAfterResume: [...executedNames],
            executedNamesBeforeResume,
          },
        },
      },
      result: {
        approval: {
          decisions,
          gatedToolStartAfterResume: didEventOccurAfter(
            resumedEvents,
            "approval.resolved",
            "tool.start",
            "call-email"
          ),
          handleOwnership,
          messageAttachment: readFirstApprovalMessage(toolResults),
          pausedApprovalCallIds,
          pausedEventTypes: pausedEvents.map((event) =>
            dependencies.readRecordString(event, "type")
          ),
          pausedPhase,
          pausedTurnIds: readEventStringValues(pausedEvents, "turnId"),
          resumedEventTypes: resumedEvents.map((event) =>
            dependencies.readRecordString(event, "type")
          ),
          resumedPhase: resumedHandle.status().phase,
          resumedTurnIds: readEventStringValues(resumedEvents, "turnId"),
          sameTurn: eventStreamsShareTurn(pausedEvents, resumedEvents),
          toolResults,
        },
        tool: {
          execution: {
            executedNames,
            executedNamesAfterResume: [...executedNames],
            executedNamesBeforeResume,
          },
        },
      },
    };
  };

  const readLastCheckpointHash = (events: readonly unknown[]): string => {
    let checkpointHash: string | undefined;

    for (const event of events) {
      const turnNodeHash = dependencies.readRecordString(event, "turnNodeHash");

      if (turnNodeHash !== undefined) {
        assertHashString(turnNodeHash, "state.checkpoint.turnNodeHash");
        checkpointHash = turnNodeHash;
      }
    }

    if (checkpointHash === undefined) {
      throw new Error(
        "completed branch scenario did not emit a checkpoint hash"
      );
    }

    return checkpointHash;
  };

  const runBranchCreate = async (): Promise<AdapterProjection> => {
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText("branch base")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("complete before branch"),
      threadId: thread.threadId,
    });
    const completedEvents = await collectValues(handle.events());
    const completedHeadTurnNodeHash = readLastCheckpointHash(completedEvents);
    const sourceMessages = await harness.readBranchMessages(thread.branchId);
    const branch = await runtime.createBranch({
      fromTurnNodeHash: completedHeadTurnNodeHash,
      threadId: thread.threadId,
    });

    return {
      result: {
        branch: {
          completedTurnPhase: handle.status().phase,
          createdBranchId: branch.branchId,
          createdHeadTurnNodeHash: branch.headTurnNodeHash,
          sourceBranchId: thread.branchId,
          sourceHeadTurnNodeHash: completedHeadTurnNodeHash,
          sourceMessageCount: sourceMessages.length,
        },
      },
      state: {
        branch: {
          completedTurnPhase: handle.status().phase,
          createdBranchId: branch.branchId,
          createdHeadTurnNodeHash: branch.headTurnNodeHash,
          sourceBranchId: thread.branchId,
          sourceHeadTurnNodeHash: completedHeadTurnNodeHash,
          sourceMessageCount: sourceMessages.length,
        },
      },
    };
  };

  const runTerminalValueCancelled = async (): Promise<AdapterProjection> => {
    const harness = createConformanceKernelHarness();
    const runnerStarted = Promise.withResolvers<undefined>();
    const cancelRunner = {
      async execute(context) {
        runnerStarted.resolve();
        await waitForAbort(context.signal);
        return { resolution: { type: "continue_iteration" } };
      },
      id: RUNNER_ID,
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([cancelRunner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("cancel"),
      threadId: thread.threadId,
    });
    const resultPromise = handle.awaitResult();

    await runnerStarted.promise;

    handle.cancel();

    let rejected = false;
    let errorEnvelope: Record<string, unknown> | undefined;

    try {
      await resultPromise;
    } catch (error: unknown) {
      rejected = true;
      errorEnvelope = readErrorEnvelope(error);
    }

    return {
      result: { handle: { awaitResult: { error: errorEnvelope, rejected } } },
    };
  };

  const runHandleTerminalValue = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.handle-terminal-value"
    );
    const caseValue =
      dependencies.readRecordString(scenario, "case") ?? "complete";

    if (caseValue === "complete") {
      return await runTerminalValueComplete();
    }
    if (caseValue === "failure") {
      return await runTerminalValueFailure();
    }
    if (caseValue === "cancelled") {
      return await runTerminalValueCancelled();
    }
    if (caseValue === "idempotent") {
      return await runTerminalValueIdempotent();
    }

    throw new Error(
      `runtime.handle-terminal-value: unknown case "${caseValue}"`
    );
  };

  return { runApprovalResume, runBranchCreate, runHandleTerminalValue };
};
