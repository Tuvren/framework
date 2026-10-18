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

import type { KernelRecord } from "@tuvren/core";
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "@tuvren/runtime";

import {
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createConformanceRunLivenessKernelHarness,
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterRecoveryScenarioDependencies {
  isRecord: (value: unknown) => value is Record<string, unknown>;
  readOperationScenario: (
    input: unknown,
    operation: string
  ) => Record<string, unknown>;
  readProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => unknown;
  readRecordProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => Record<string, unknown>;
  readRecordString: (value: unknown, key: string) => string | undefined;
  readStringProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => string;
}

interface InterruptedToolCallScenario {
  callId: string;
  name: string;
  nonRetryable: boolean;
  state: "completed" | "missing";
}

interface ObservedToolDispatch {
  callId: string;
  idempotencyKey: string | null;
}

type RunnerContext = Parameters<RuntimeRunner["execute"]>[0];
type RunnerExecutionResult = Awaited<ReturnType<RuntimeRunner["execute"]>>;
type RunLivenessHarness = ReturnType<
  typeof createConformanceRunLivenessKernelHarness
>;

const fromSynchronous = <Argument, Value>(
  operation: (argument: Argument) => Value
): ((argument: Argument) => Promise<Value>) =>
  Promise.try.bind<
    typeof Promise,
    [(argument: Argument) => Value],
    [Argument],
    Promise<Value>
  >(Promise, operation);

const fromSynchronousWithoutArguments = <Value>(
  operation: () => Value
): (() => Promise<Value>) =>
  Promise.try.bind<typeof Promise, [() => Value], [], Promise<Value>>(
    Promise,
    operation
  );

const createObservedToolDefinitions = (
  calls: readonly InterruptedToolCallScenario[],
  dispatches: ObservedToolDispatch[]
): TuvrenToolDefinition[] =>
  calls.map((call) => ({
    description: `Observe dispatch for ${call.name}`,
    execute(_input, context) {
      dispatches.push({
        callId: context.callId,
        idempotencyKey: context.idempotencyKey ?? null,
      });
      return { callId: context.callId };
    },
    inputSchema: { type: "object" },
    name: call.name,
    ...(call.nonRetryable ? { nonRetryable: true } : {}),
  }));

const stageRecoveredRecord = async (
  livenessHarness: RunLivenessHarness,
  runId: string,
  taskId: string,
  record: KernelRecord
): Promise<void> => {
  await livenessHarness.kernel.staging.stage(
    runId,
    encodeDeterministicKernelRecord(record),
    taskId,
    "message",
    "completed"
  );
};

const stageRecoveredMessage = async (
  livenessHarness: RunLivenessHarness,
  runId: string,
  taskId: string,
  text: string,
  role: "assistant" | "user" = "user"
): Promise<void> => {
  await stageRecoveredRecord(livenessHarness, runId, taskId, {
    parts: [{ text, type: "text" }],
    role,
  });
};

const stageRecoveredToolResults = async (
  livenessHarness: RunLivenessHarness,
  runId: string,
  calls: readonly InterruptedToolCallScenario[],
  index = 0
): Promise<void> => {
  const call = calls[index];
  if (call === undefined) {
    return;
  }
  if (call.state === "completed") {
    await stageRecoveredRecord(
      livenessHarness,
      runId,
      `interrupted_batch_result_${call.callId}`,
      {
        parts: [
          {
            callId: call.callId,
            name: call.name,
            output: { recovered: true },
            type: "tool_result",
          },
        ],
        role: "tool",
      }
    );
  }
  await stageRecoveredToolResults(livenessHarness, runId, calls, index + 1);
};

const stageRecoveredTurnLineage = async (
  livenessHarness: RunLivenessHarness,
  runId: string,
  taskId: string,
  turnId: string
): Promise<void> => {
  await livenessHarness.kernel.staging.stage(
    runId,
    encodeDeterministicKernelRecord({ activeTurnId: turnId }),
    taskId,
    "turn_lineage",
    "completed"
  );
};

const stageRecoveredRuntimeStatus = async (
  livenessHarness: RunLivenessHarness,
  runId: string,
  taskId: string,
  status: { activeAgent: string; state: "completed" | "running" }
): Promise<void> => {
  await livenessHarness.kernel.staging.stage(
    runId,
    encodeDeterministicKernelRecord(status),
    taskId,
    "runtime_status",
    "completed"
  );
};

const sortDispatches = (
  dispatches: readonly ObservedToolDispatch[]
): ObservedToolDispatch[] =>
  dispatches.toSorted((left, right) => left.callId.localeCompare(right.callId));

export const createFrameworkAdapterRecoveryScenarios = (
  dependencies: FrameworkAdapterRecoveryScenarioDependencies
): {
  runClientResultAsProposal: (input: unknown) => Promise<AdapterProjection>;
  runRecoverResult: (input: unknown) => Promise<AdapterProjection>;
  runRecoverStaleRun: (input: unknown) => Promise<AdapterProjection>;
} => {
  const runRecoverResult = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.recover-result"
    );
    const stagedObject = dependencies.readRecordProperty(
      scenario,
      "stagedObject",
      "runtime.recover-result.stagedObject"
    );
    const taskId = dependencies.readStringProperty(
      stagedObject,
      "taskId",
      "runtime.recover-result.stagedObject.taskId"
    );
    const objectType = dependencies.readStringProperty(
      stagedObject,
      "objectType",
      "runtime.recover-result.stagedObject.objectType"
    );
    const payload = dependencies.readProperty(
      stagedObject,
      "payload",
      "runtime.recover-result.stagedObject.payload"
    );
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText("recovery placeholder")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
    });
    const thread = await runtime.createThread({});
    const recoveryTurnId = "shared-recovery-turn";
    const runId = "shared-recovery-run";

    const turn = await harness.kernel.turn.create(
      recoveryTurnId,
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await harness.kernel.run.create(
      runId,
      turn.turnId,
      thread.branchId,
      DEFAULT_AGENT_SCHEMA.schemaId,
      thread.rootTurnNodeHash,
      [{ deterministic: false, id: taskId, sideEffects: false }]
    );
    await harness.kernel.staging.stage(
      runId,
      new TextEncoder().encode(JSON.stringify(payload)),
      taskId,
      objectType,
      "completed"
    );

    const recovery = await harness.kernel.run.recover(runId);
    const [firstStagedResult] = recovery.uncommittedStagedResults;
    const recoveryProjection = {
      firstObjectType: firstStagedResult?.objectType,
      firstTaskId: firstStagedResult?.taskId,
      lastTurnNodeHash: recovery.lastTurnNodeHash,
      uncommittedStagedResults: recovery.uncommittedStagedResults.length,
    };

    return {
      evidence: {
        recovery: recoveryProjection,
      },
      result: {
        recovery: recoveryProjection,
      },
      state: {
        recovery,
        trace: {
          recovery: {
            evidence: {
              recovery: recoveryProjection,
            },
          },
        },
      },
    };
  };

  const readInterruptedToolCalls = (
    scenario: Record<string, unknown>
  ): InterruptedToolCallScenario[] => {
    const value = scenario.toolCalls;
    if (!Array.isArray(value)) {
      throw new TypeError(
        "runtime.recover-stale-run.toolCalls must be an array"
      );
    }

    return value.map((entry, index) => {
      if (!dependencies.isRecord(entry)) {
        throw new Error(
          `runtime.recover-stale-run.toolCalls.${index.toString()} must be an object`
        );
      }
      const path = `runtime.recover-stale-run.toolCalls.${index.toString()}`;
      const state = dependencies.readStringProperty(entry, "state", path);
      if (state !== "completed" && state !== "missing") {
        throw new Error(`${path}.state must be completed or missing`);
      }
      if (typeof entry.nonRetryable !== "boolean") {
        throw new TypeError(`${path}.nonRetryable must be a boolean`);
      }
      return {
        callId: dependencies.readStringProperty(entry, "callId", path),
        name: dependencies.readStringProperty(entry, "name", path),
        nonRetryable: entry.nonRetryable,
        state,
      };
    });
  };

  const readTurnId = (events: readonly unknown[]): string | undefined => {
    for (const event of events) {
      const turnId = dependencies.readRecordString(event, "turnId");
      if (turnId !== undefined) {
        return turnId;
      }
    }
    return undefined;
  };

  const observeOriginalToolDispatches = async (
    calls: readonly InterruptedToolCallScenario[],
    prompt: string,
    finalText: string
  ): Promise<{
    dispatches: ObservedToolDispatch[];
    turnId: string;
  }> => {
    const harness = createConformanceKernelHarness();
    const dispatches: ObservedToolDispatch[] = [];
    let runnerExecuteCalls = 0;
    const runner = {
      execute: fromSynchronousWithoutArguments((): RunnerExecutionResult => {
        runnerExecuteCalls += 1;
        if (runnerExecuteCalls === 1) {
          return {
            messages: [
              assistantToolCalls(
                calls.map((call) => ({
                  callId: call.callId,
                  input: {},
                  name: call.name,
                }))
              ),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }
        return {
          messages: [assistantText(finalText)],
          resolution: { reason: "done", type: "end_turn" },
        };
      }),
      id: RUNNER_ID,
    } satisfies RuntimeRunner;
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
        name: "primary",
        tools: createObservedToolDefinitions(calls, dispatches),
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });
    const events = await collectValues(handle.events());
    const turnId = readTurnId(events);

    if (turnId === undefined) {
      throw new Error("original tool dispatch emitted no turn identity");
    }

    return { dispatches, turnId };
  };

  const readMessagePartCallIds = (
    messages: readonly unknown[],
    partType: "tool_call" | "tool_result"
  ): string[] => {
    const callIds: string[] = [];
    for (const message of messages) {
      if (!(dependencies.isRecord(message) && Array.isArray(message.parts))) {
        continue;
      }
      for (const part of message.parts) {
        if (
          dependencies.isRecord(part) &&
          part.type === partType &&
          typeof part.callId === "string"
        ) {
          callIds.push(part.callId);
        }
      }
    }
    return callIds;
  };

  const runInterruptedToolBatchRecovery = async (
    scenario: Record<string, unknown>
  ): Promise<AdapterProjection> => {
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.recover-stale-run.prompt"
    );
    const finalText = dependencies.readStringProperty(
      scenario,
      "finalText",
      "runtime.recover-stale-run.finalText"
    );
    const calls = readInterruptedToolCalls(scenario);
    const originalAttempt = await observeOriginalToolDispatches(
      calls,
      prompt,
      finalText
    );
    const harness = createConformanceKernelHarness();
    const livenessHarness = createConformanceRunLivenessKernelHarness(harness);
    const resumedDispatches: ObservedToolDispatch[] = [];
    const runnerDispatchCountsAtExecute: number[] = [];
    const runner = {
      execute: fromSynchronousWithoutArguments((): RunnerExecutionResult => {
        runnerDispatchCountsAtExecute.push(resumedDispatches.length);
        return {
          messages: [assistantText(finalText)],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      }),
      id: RUNNER_ID,
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: livenessHarness.kernel,
      resolveAgentConfig(agentName) {
        return agentName === "primary" ? { name: agentName } : undefined;
      },
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      originalAttempt.turnId,
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    const staleRunId = "run_interrupted_tool_batch";

    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: staleRunId,
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        {
          deterministic: false,
          id: "iterate",
          sideEffects: true,
        },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.run.beginStep(staleRunId, "iterate");
    await stageRecoveredMessage(
      livenessHarness,
      staleRunId,
      "interrupted_batch_user_message",
      prompt
    );
    await stageRecoveredTurnLineage(
      livenessHarness,
      staleRunId,
      "interrupted_batch_turn_lineage",
      staleTurn.turnId
    );
    await stageRecoveredRecord(
      livenessHarness,
      staleRunId,
      "interrupted_batch_assistant_message",
      {
        parts: calls.map((call) => ({
          callId: call.callId,
          input: {},
          name: call.name,
          type: "tool_call",
        })),
        role: "assistant",
      }
    );

    await stageRecoveredToolResults(livenessHarness, staleRunId, calls);

    const durableBeforeRecovery = await harness.readRunningStagedMessages(
      thread.branchId
    );
    const durableToolCallIds = readMessagePartCallIds(
      durableBeforeRecovery,
      "tool_call"
    );
    const durableToolResultIds = new Set(
      readMessagePartCallIds(durableBeforeRecovery, "tool_result")
    );
    const durableMissingCallIds = durableToolCallIds
      .filter((callId) => !durableToolResultIds.has(callId))
      .toSorted();

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: createObservedToolDefinitions(calls, resumedDispatches),
      },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });
    const events = await collectValues(handle.events());
    const durableAfterRecovery = await harness.readBranchMessages(
      thread.branchId
    );
    const missingCallIdSet = new Set(durableMissingCallIds);
    const recoveryProjection = {
      dispatchedCallIds: resumedDispatches
        .map((dispatch) => dispatch.callId)
        .toSorted(),
      durableMissingCallIds,
      originalAttemptDispatches: sortDispatches(
        originalAttempt.dispatches.filter((dispatch) =>
          missingCallIdSet.has(dispatch.callId)
        )
      ),
      resumedDispatches: sortDispatches(resumedDispatches),
      runnerDispatchCountsAtExecute,
    };

    return {
      events,
      result: { recovery: recoveryProjection },
      state: {
        durableAfterRecovery,
        durableBeforeRecovery,
      },
    };
  };

  const hasTextMessage = (
    messages: readonly unknown[],
    role: "assistant" | "user",
    expectedText: string
  ): boolean => {
    if (expectedText.length === 0) {
      return false;
    }
    return messages.some((message) => {
      if (
        !dependencies.isRecord(message) ||
        message.role !== role ||
        !Array.isArray(message.parts)
      ) {
        return false;
      }
      return message.parts.some(
        (part) =>
          dependencies.isRecord(part) &&
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text === expectedText
      );
    });
  };

  const countUserTextMessages = (
    messages: readonly unknown[],
    expectedText: string
  ): number => {
    let count = 0;
    for (const message of messages) {
      if (hasTextMessage([message], "user", expectedText)) {
        count += 1;
      }
    }
    return count;
  };

  const runRecoverStaleRun = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.recover-stale-run"
    );
    const recoveryCase = dependencies.readStringProperty(
      scenario,
      "recoveryCase",
      "runtime.recover-stale-run.recoveryCase"
    );
    if (recoveryCase === "interrupted_tool_batch") {
      return await runInterruptedToolBatchRecovery(scenario);
    }

    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.recover-stale-run.prompt"
    );
    const recoveredAssistantText =
      typeof scenario.recoveredAssistantText === "string"
        ? scenario.recoveredAssistantText
        : undefined;
    const harness = createConformanceKernelHarness();
    const livenessHarness = createConformanceRunLivenessKernelHarness(harness);
    let executeCalls = 0;

    const runner = {
      execute: fromSynchronousWithoutArguments((): RunnerExecutionResult => {
        executeCalls += 1;
        return {
          messages: [
            assistantText(
              dependencies.readStringProperty(
                scenario,
                "finalText",
                "runtime.recover-stale-run.finalText"
              )
            ),
          ],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      }),
      id: RUNNER_ID,
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: livenessHarness.kernel,
      resolveAgentConfig(agentName) {
        return agentName === "primary" || agentName === "reviewer"
          ? { name: agentName }
          : undefined;
      },
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      `turn_${recoveryCase}`,
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    const staleRunId = `run_${recoveryCase}`;
    const staleStepId = dependencies.readStringProperty(
      scenario,
      "staleStepId",
      "runtime.recover-stale-run.staleStepId"
    );
    const staleStepSideEffects = !(
      staleStepId === "handoff_context" ||
      staleStepId === "finalize_turn_status"
    );

    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: staleRunId,
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        {
          deterministic: false,
          id: staleStepId,
          sideEffects: staleStepSideEffects,
        },
      ],
      turnId: staleTurn.turnId,
    });
    await stageRecoveredMessage(
      livenessHarness,
      staleRunId,
      `${recoveryCase}_user_message`,
      prompt
    );
    await stageRecoveredTurnLineage(
      livenessHarness,
      staleRunId,
      `${recoveryCase}_turn_lineage`,
      staleTurn.turnId
    );

    switch (recoveryCase) {
      case "same_signal_iterate": {
        await stageRecoveredMessage(
          livenessHarness,
          staleRunId,
          `${recoveryCase}_assistant_message`,
          recoveredAssistantText ??
            dependencies.readStringProperty(
              scenario,
              "recoveredAssistantText",
              "runtime.recover-stale-run.recoveredAssistantText"
            ),
          "assistant"
        );
        break;
      }
      case "signal_mismatch": {
        break;
      }
      case "handoff_context": {
        await stageRecoveredRuntimeStatus(
          livenessHarness,
          staleRunId,
          `${recoveryCase}_runtime_status`,
          { activeAgent: "reviewer", state: "running" }
        );
        break;
      }
      case "finalize_turn_status": {
        await stageRecoveredRuntimeStatus(
          livenessHarness,
          staleRunId,
          `${recoveryCase}_runtime_status`,
          { activeAgent: "primary", state: "completed" }
        );
        break;
      }
      default: {
        throw new Error(
          `runtime.recover-stale-run declared unsupported recoveryCase ${recoveryCase}`
        );
      }
    }

    const signalText =
      recoveryCase === "signal_mismatch"
        ? dependencies.readStringProperty(
            scenario,
            "freshPrompt",
            "runtime.recover-stale-run.freshPrompt"
          )
        : prompt;
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal(signalText),
      threadId: thread.threadId,
    });
    const events = await collectValues(handle.events());
    const branchMessages = await harness.readBranchMessages(thread.branchId);
    const branchRuns = await harness.readBranchRuns(thread.branchId);
    const branchRuntimeStatus = await harness.readBranchRuntimeStatus(
      thread.branchId
    );
    const observedTurnId = readTurnId(events);

    const recoveryProjection = {
      activeAgent: handle.status().activeAgent,
      branchRuntimePhase: dependencies.readRecordString(
        branchRuntimeStatus,
        "state"
      ),
      branchStatusActiveAgent: dependencies.readRecordString(
        branchRuntimeStatus,
        "activeAgent"
      ),
      freshUserMessageCount: countUserTextMessages(branchMessages, signalText),
      originalUserMessageCount: countUserTextMessages(branchMessages, prompt),
      phase: handle.status().phase,
      preemptCalls: livenessHarness.getPreemptCalls(),
      recoveredAssistantVisible: hasTextMessage(
        branchMessages,
        "assistant",
        recoveredAssistantText ?? ""
      ),
      runnerExecuteCalls: executeCalls,
      sameTurn: observedTurnId === staleTurn.turnId,
      staleRunStatus:
        branchRuns.find((run) => run.runId === staleRunId)?.status ?? null,
    };

    return {
      evidence: {
        recovery: recoveryProjection,
      },
      result: {
        recovery: recoveryProjection,
      },
    };
  };

  const isClientSuccessMessage = (message: unknown): boolean => {
    if (
      !dependencies.isRecord(message) ||
      message.role !== "tool" ||
      !Array.isArray(message.parts)
    ) {
      return false;
    }
    return message.parts.some(
      (part) =>
        dependencies.isRecord(part) &&
        dependencies.isRecord(part.output) &&
        part.output.committed === true
    );
  };

  /**
   * Client-result-as-proposal under loss of execution authority (KRT-BG005;
   * ADR-0052 decision 3). A side-effecting client-endpoint dispatch is in flight
   * when the worker loses its run lease (renewal is preempted by a peer). The
   * client still performs the effect and reports a result, but because the run
   * lost write authority the reported result is a stale proposal: it must never
   * become committed history under the dead owner. The scenario projects that
   * the client dispatch fired (the external effect happened) yet no committed
   * message carries the client's success — proving no stale client report is
   * committed.
   */
  const runClientResultAsProposal = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.client-result-as-proposal"
    );
    const capabilityId = dependencies.readStringProperty(
      scenario,
      "capabilityId",
      "runtime.client-result-as-proposal.capabilityId"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.client-result-as-proposal.prompt"
    );

    const harness = createConformanceKernelHarness();
    const dispatchHeld = Promise.withResolvers<undefined>();
    const livenessHarness = createConformanceRunLivenessKernelHarness(harness, {
      onRenewLease: fromSynchronousWithoutArguments((): never => {
        // Release the held dispatch on a macrotask so the reported result returns
        // into an already-aborted (dead-owner) context and the
        // client-result-as-proposal gate fires. This is ordered, not raced: the
        // event loop drains the whole microtask queue before any macrotask, and
        // this rejection propagates synchronously through the lease loop's catch
        // into handle.abortWithError (a microtask chain), so the abort always
        // lands before this setTimeout. If that abort is ever deferred behind its
        // own macrotask/await boundary, replace this with an explicit
        // await-on-abort handshake.
        setTimeout(() => {
          dispatchHeld.resolve();
        }, 0);
        throw new Error("lease preempted by a peer worker");
      }),
    });

    let clientDispatchCount = 0;
    const endpoint: AttachedClientEndpoint = {
      advertisedCapabilities: [
        {
          capabilityId,
          description: "side-effecting client capability",
          inputSchema: { type: "object" },
        },
      ],
      async dispatch(
        envelope: ClientInvocationEnvelope
      ): Promise<ClientReportedResult> {
        clientDispatchCount += 1;
        // Hold the dispatch open until the run loses its lease.
        await dispatchHeld.promise;
        return {
          callId: envelope.callId,
          content: { committed: true },
          leaseToken: envelope.leaseToken,
        };
      },
      endpointId: "conformance-client-endpoint",
    };

    const runner: RuntimeRunner = {
      execute: fromSynchronous(
        (context: RunnerContext): RunnerExecutionResult => {
          if (!context.messages.some((message) => message.role === "tool")) {
            return {
              messages: [
                assistantToolCalls([
                  { callId: "call-proposal", input: {}, name: capabilityId },
                ]),
              ],
              resolution: { type: "continue_iteration" },
              toolExecutionMode: "parallel",
            };
          }
          return {
            messages: [assistantText("done")],
            resolution: { reason: "done", type: "end_turn" },
          };
        }
      ),
      id: RUNNER_ID,
    };

    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: livenessHarness.kernel,
      resolveAgentConfig(agentName) {
        return agentName === "primary" ? { name: agentName } : undefined;
      },
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 40,
        renewBeforeMs: 20,
      },
      runnerRegistry: createRunnerRegistry([runner]),
    });

    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { clientEndpoints: [endpoint], name: "primary" },
      signal: textSignal(prompt),
      threadId: thread.threadId,
    });
    // Loss of authority surfaces as a rejected event stream; swallow it so the
    // assertions can inspect durable state.
    await collectValues(handle.events()).catch(() => {
      // Lease loss is the expected observation for this scenario.
    });

    const branchMessages = await harness.readBranchMessages(thread.branchId);
    const clientSuccessCommitted = branchMessages.some((message) =>
      isClientSuccessMessage(message)
    );

    const proposal = {
      // The client performed the side effect exactly once...
      clientDispatchCount,
      // ...but its reported result never became committed history.
      clientSuccessCommitted,
    };
    return {
      evidence: { proposal },
      result: { proposal },
    };
  };

  return {
    runClientResultAsProposal,
    runRecoverResult,
    runRecoverStaleRun,
  };
};
