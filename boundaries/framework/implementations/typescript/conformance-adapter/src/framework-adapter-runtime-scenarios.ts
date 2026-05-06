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

import { assertHashString, type HashString } from "@tuvren/core-types";
import type { RuntimeDriver } from "@tuvren/driver-api";
import type {
  ApprovalDecision,
  TuvrenMessage,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "../../runtime-core/src/index.ts";
import { createFakeKernelHarness } from "../../runtime-core/test/fake-kernel.ts";
import { createFrameworkAdapterProviderScenarios } from "./framework-adapter-provider-scenarios.ts";
import { createFrameworkAdapterRecoveryScenarios } from "./framework-adapter-recovery-scenarios.ts";
import {
  type AdapterProjection,
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterRuntimeScenarioDependencies {
  isRecord(value: unknown): value is Record<string, unknown>;
  readApprovalDecisions(
    record: Record<string, unknown>,
    path: string
  ): ApprovalDecision[];
  readAssistantText(
    messages: readonly unknown[],
    expectedText: string
  ): string | undefined;
  readFirstErrorEnvelope(
    events: readonly unknown[]
  ): Record<string, unknown> | undefined;
  readModelResponseArrayProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): import("@tuvren/runtime-api").TuvrenModelResponse[];
  readModelResponseProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): import("@tuvren/runtime-api").TuvrenModelResponse;
  readOperationScenario(
    input: unknown,
    operation: string
  ): Record<string, unknown>;
  readPromptProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): import("@tuvren/runtime-api").TuvrenPrompt;
  readProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): unknown;
  readProviderStreamChunks(
    record: Record<string, unknown>,
    path: string
  ): import("@tuvren/provider-api").ProviderStreamChunk[];
  readRecordProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): Record<string, unknown>;
  readRecordString(value: unknown, key: string): string | undefined;
  readResponseFormatProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): import("@tuvren/runtime-api").StructuredOutputRequest | undefined;
  readScenarioToolCall(
    record: Record<string, unknown>,
    path: string
  ): {
    readonly callId: string;
    readonly input: unknown;
    readonly name: string;
    readonly output?: unknown;
    readonly requiresApproval?: boolean;
  };
  readScenarioToolCalls(
    record: Record<string, unknown>,
    path: string
  ): Array<{
    readonly callId: string;
    readonly input: unknown;
    readonly name: string;
    readonly output?: unknown;
    readonly requiresApproval?: boolean;
  }>;
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterRuntimeScenarios(
  dependencies: FrameworkAdapterRuntimeScenarioDependencies
): {
  runApprovalResume(input: unknown): Promise<AdapterProjection>;
  runBranchCreate(): Promise<AdapterProjection>;
  runCancelledRuntimeTurn(controls: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  }): Promise<AdapterProjection>;
  runCompletedRuntimeTurn(): Promise<AdapterProjection>;
  runContextTransform(input: unknown): Promise<AdapterProjection>;
  runProviderGenerate(input: unknown): Promise<AdapterProjection>;
  runProviderStream(input: unknown): Promise<AdapterProjection>;
  runRecoverResult(input: unknown): Promise<AdapterProjection>;
  runRecoverStaleRun(input: unknown): Promise<AdapterProjection>;
  runStructuredValidationFailure(input: unknown): Promise<AdapterProjection>;
  runToolExecution(input: unknown): Promise<AdapterProjection>;
} {
  const providerScenarios = createFrameworkAdapterProviderScenarios({
    readAssistantText: dependencies.readAssistantText,
    readFirstErrorEnvelope: dependencies.readFirstErrorEnvelope,
    readModelResponseProperty: dependencies.readModelResponseProperty,
    readOperationScenario: dependencies.readOperationScenario,
    readPromptProperty: dependencies.readPromptProperty,
    readProperty: dependencies.readProperty,
    readProviderStreamChunks: dependencies.readProviderStreamChunks,
    readResponseFormatProperty: dependencies.readResponseFormatProperty,
    readScenarioToolCall: dependencies.readScenarioToolCall,
    readStringProperty: dependencies.readStringProperty,
  });
  const recoveryScenarios = createFrameworkAdapterRecoveryScenarios({
    isRecord: dependencies.isRecord,
    readOperationScenario: dependencies.readOperationScenario,
    readProperty: dependencies.readProperty,
    readRecordProperty: dependencies.readRecordProperty,
    readRecordString: dependencies.readRecordString,
    readStringProperty: dependencies.readStringProperty,
  });

  async function runCompletedRuntimeTurn(): Promise<AdapterProjection> {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("completed")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    const events = await collectValues(handle.events());

    return {
      evidence: {
        runtime: {
          eventCount: events.length,
          phase: handle.status().phase,
        },
      },
    };
  }

  async function runCancelledRuntimeTurn(controls: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  }): Promise<AdapterProjection> {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute(context) {
        executeCount += 1;

        if (executeCount === 1) {
          return {
            messages: [assistantText("first pass")],
            resolution: { type: "continue_iteration" },
          };
        }

        await waitForAbort(context.signal);
        return {
          messages: [assistantText("interrupted")],
          partial: true,
          resolution: {
            error: new Error("driver observed cancellation"),
            fatality: "hard",
            type: "fail",
          },
        };
      },
      id: DRIVER_ID,
    } satisfies RuntimeDriver;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("cancel"),
      threadId: thread.threadId,
    });
    const events: unknown[] = [];
    const cancelAfterEvent = controls.cancelAfterEvent;
    let cancelInvocations = 0;
    let observedEventIndex: number | undefined;
    let observedEventType: string | undefined;

    if (cancelAfterEvent === undefined) {
      throw new Error(
        "runtime cancellation checks must declare cancelAfterEvent"
      );
    }

    for await (const event of handle.events()) {
      events.push(event);

      if (observedEventType !== undefined) {
        continue;
      }

      const eventType = dependencies.readRecordString(event, "type");

      if (eventType === cancelAfterEvent) {
        observedEventIndex = events.length - 1;
        observedEventType = eventType;
        handle.cancel();
        cancelInvocations += 1;
        handle.cancel();
        cancelInvocations += 1;
      }
    }

    return {
      evidence: {
        cancellation: {
          cancelInvocations,
          errorEventCount: countEventsByType(events, "error"),
          observedEventIndex,
          observedEventType,
        },
        controls: {
          cancelAfterEvent: controls.cancelAfterEvent,
          deadlineMs: controls.deadlineMs,
        },
        runtime: {
          iterationCount: handle.status().iterationCount,
          phase: handle.status().phase,
        },
      },
      result: {
        error: readFirstErrorEnvelope(events),
      },
    };
  }

  async function runApprovalResume(input: unknown): Promise<AdapterProjection> {
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
    const harness = createFakeKernelHarness();
    const executedNames: string[] = [];
    const driver = {
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
      id: DRIVER_ID,
    } satisfies RuntimeDriver;
    const tools = calls.map(
      (call): TuvrenToolDefinition => ({
        approval: call.requiresApproval,
        description: `Shared conformance tool ${call.name}`,
        execute() {
          executedNames.push(call.name);
          return call.output;
        },
        inputSchema: { type: "object" },
        name: call.name,
      })
    );
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
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
        state: {
          approval: pausedHandle.status(),
          approvalError: readFirstErrorEnvelope(pausedEvents),
        },
      };
    }

    const resumedHandle = pausedHandle.resolveApproval({
      decisions,
    });

    const resumedEvents = await collectValues(resumedHandle.events());

    return {
      evidence: {
        approval: {
          decisions,
          pausedApprovalCallIds,
          pausedEventTypes: pausedEvents.map((event) =>
            dependencies.readRecordString(event, "type")
          ),
          pausedPhase,
          resumedEventTypes: resumedEvents.map((event) =>
            dependencies.readRecordString(event, "type")
          ),
          resumedPhase: resumedHandle.status().phase,
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
  }

  async function runBranchCreate(): Promise<AdapterProjection> {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("branch base")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      kernel: harness.kernel,
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
  }

  return {
    runApprovalResume,
    runBranchCreate,
    runCancelledRuntimeTurn,
    runCompletedRuntimeTurn,
    runContextTransform: providerScenarios.runContextTransform,
    runProviderGenerate: providerScenarios.runProviderGenerate,
    runProviderStream: providerScenarios.runProviderStream,
    runRecoverResult: recoveryScenarios.runRecoverResult,
    runRecoverStaleRun: recoveryScenarios.runRecoverStaleRun,
    runStructuredValidationFailure:
      providerScenarios.runStructuredValidationFailure,
    runToolExecution: providerScenarios.runToolExecution,
  };

  function hasToolMessage(messages: readonly TuvrenMessage[]): boolean {
    return messages.some((message) => message.role === "tool");
  }

  function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined || signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  function readFirstErrorEnvelope(
    events: readonly unknown[]
  ): Record<string, unknown> | undefined {
    for (const event of events) {
      if (dependencies.isRecord(event) && dependencies.isRecord(event.error)) {
        return event.error;
      }
    }

    return undefined;
  }

  function countEventsByType(events: readonly unknown[], type: string): number {
    let count = 0;

    for (const event of events) {
      if (dependencies.readRecordString(event, "type") === type) {
        count += 1;
      }
    }

    return count;
  }

  function readLastCheckpointHash(events: readonly unknown[]): HashString {
    let checkpointHash: HashString | undefined;

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
  }
}
