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

import { assertHashString, TuvrenPersistenceError } from "@tuvren/core";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type {
  BranchMessagesCursor,
  ExecutionHandle,
  InputSignal,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type {
  ApprovalDecision,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "@tuvren/runtime";
import { createFrameworkAdapterProviderScenarios } from "./framework-adapter-provider-scenarios.ts";
import { createFrameworkAdapterRecoveryScenarios } from "./framework-adapter-recovery-scenarios.ts";
import {
  type AdapterProjection,
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createConformanceRunLivenessKernelHarness,
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
  ): import("@tuvren/runtime-api").StructuredOutputRequest;
  readScenarioToolCall(
    record: Record<string, unknown>,
    path: string
  ): {
    readonly callId: string;
    readonly input: unknown;
    readonly name: string;
    readonly output?: unknown;
    readonly requiresApproval?: boolean;
    readonly throwMessage?: string;
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
    readonly throwMessage?: string;
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
  runCompletedRuntimeTurn(input: unknown): Promise<AdapterProjection>;
  runContextTransform(input: unknown): Promise<AdapterProjection>;
  runDurableReadGetTurnHistory(): Promise<AdapterProjection>;
  runDurableReadGetTurnState(): Promise<AdapterProjection>;
  runDurableReadGetTurnStateLineage(): Promise<AdapterProjection>;
  runDurableReadListBranches(): Promise<AdapterProjection>;
  runDurableReadListThreads(): Promise<AdapterProjection>;
  runDurableReadListThreadsCapabilityRejected(): Promise<AdapterProjection>;
  runDurableReadListThreadsPaginate(): Promise<AdapterProjection>;
  runDurableReadReadBranchMessages(): Promise<AdapterProjection>;
  runDurableReadReadBranchMessagesHeadDrift(): Promise<AdapterProjection>;
  runHandleTerminalValue(input: unknown): Promise<AdapterProjection>;
  runProviderGenerate(input: unknown): Promise<AdapterProjection>;
  runProviderStream(input: unknown): Promise<AdapterProjection>;
  runClientResultAsProposal(input: unknown): Promise<AdapterProjection>;
  runRecoverResult(input: unknown): Promise<AdapterProjection>;
  runRecoverStaleRun(input: unknown): Promise<AdapterProjection>;
  runOperationalTelemetry(input: unknown): Promise<AdapterProjection>;
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
    readScenarioToolCalls: dependencies.readScenarioToolCalls,
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

  async function runCompletedRuntimeTurn(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.execute-turn"
    );

    if (scenario.case === "empty_parts") {
      return await runInputSignalEmptyParts();
    }

    const harness = createConformanceKernelHarness();
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
      result: {
        runtime: {
          eventCount: events.length,
          phase: handle.status().phase,
        },
      },
    };
  }

  async function runOperationalTelemetry(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.operational-telemetry"
    );
    const capture = createTelemetryCapture();
    const harness = createConformanceKernelHarness();
    const scenarioCase = dependencies.readRecordString(scenario, "case");
    const driver = createOperationalTelemetryDriver(scenarioCase);
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
      now: createDeterministicClock(),
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const tools = createOperationalTelemetryTools(scenarioCase);
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME, tools },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });

    if (scenarioCase === "approval") {
      await collectValues(handle.events());
      const resumedHandle = handle.resolveApproval({
        decisions: [{ callId: "call-email", type: "approve" }],
      });
      await collectValues(resumedHandle.events());
    } else if (scenarioCase === "recovery") {
      return await runOperationalTelemetryRecovery(capture);
    } else {
      await collectValues(handle.events());
    }

    const telemetry = summarizeTelemetry(capture);

    return {
      evidence: { telemetry },
      result: { telemetry },
    };
  }

  function createOperationalTelemetryDriver(
    scenarioCase: string | undefined
  ): RuntimeDriver {
    let executeCount = 0;

    return {
      async execute(context) {
        await Promise.resolve();
        executeCount += 1;

        if (scenarioCase === "error") {
          throw new Error("telemetry conformance failure");
        }

        if (scenarioCase === "tool" && !hasToolMessage(context.messages)) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: {},
                  name: "search",
                  output: { ok: true },
                },
              ]),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }

        if (scenarioCase === "approval" && executeCount === 1) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: {},
                  name: "send_email",
                  output: { sent: true },
                  requiresApproval: true,
                },
              ]),
            ],
            resolution: { type: "continue_iteration" },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText("completed")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: DRIVER_ID,
    };
  }

  function createOperationalTelemetryTools(
    scenarioCase: string | undefined
  ): TuvrenToolDefinition[] {
    if (scenarioCase === "tool") {
      return [
        {
          description: "Shared conformance telemetry tool",
          execute() {
            return { ok: true };
          },
          inputSchema: { type: "object" },
          name: "search",
        },
      ];
    }

    if (scenarioCase === "approval") {
      return [
        {
          approval: true,
          description: "Shared conformance approval telemetry tool",
          execute() {
            return { sent: true };
          },
          inputSchema: { type: "object" },
          name: "send_email",
        },
      ];
    }

    return [];
  }

  async function runOperationalTelemetryRecovery(
    capture: ReturnType<typeof createTelemetryCapture>
  ): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const livenessHarness = createConformanceRunLivenessKernelHarness(harness);
    const driver = createStaticDriver(() => ({
      messages: [assistantText("recovered")],
      resolution: {
        reason: "done",
        type: "end_turn",
      },
    }));
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      now: createDeterministicClock(),
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const staleTurn = await livenessHarness.kernel.turn.create(
      "turn_operational_telemetry_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await livenessHarness.kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "worker-stale",
      leaseExpiresAtMs: 1,
      runId: "run_operational_telemetry_recovery",
      schemaId: DEFAULT_AGENT_SCHEMA.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [
        { deterministic: false, id: "incorporate_input", sideEffects: true },
      ],
      turnId: staleTurn.turnId,
    });
    await livenessHarness.kernel.staging.stage(
      "run_operational_telemetry_recovery",
      encodeDeterministicKernelRecord({
        parts: [{ text: "run", type: "text" }],
        role: "user",
      }),
      "telemetry_recovery_user_message",
      "message",
      "completed"
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("run"),
      threadId: thread.threadId,
    });
    await collectValues(handle.events());
    const telemetry = summarizeTelemetry(capture);

    return {
      evidence: { telemetry },
      result: { telemetry },
    };
  }

  async function runCancelledRuntimeTurn(controls: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  }): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
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

    const messages = await harness.readBranchMessages(thread.branchId);
    const runtimeStatus = await harness.readBranchRuntimeStatus(
      thread.branchId
    );

    const finalStatus = handle.status();

    return {
      evidence: {
        cancellation: {
          cancelInvocations,
          errorEventCount: countEventsByType(events, "error"),
          observedEventIndex,
          observedEventType,
          partialAssistantText: dependencies.readAssistantText(
            messages,
            "interrupted"
          ),
          runtimeStatusPartial:
            dependencies.isRecord(runtimeStatus) &&
            runtimeStatus.partial === true,
        },
        controls: {
          cancelAfterEvent: controls.cancelAfterEvent,
          deadlineMs: controls.deadlineMs,
        },
        runtime: {
          iterationCount: finalStatus.iterationCount,
          phase: finalStatus.phase,
        },
      },
      result: {
        cancellation: {
          cancelInvocations,
          errorEventCount: countEventsByType(events, "error"),
          observedEventIndex,
          observedEventType,
          partialAssistantText: dependencies.readAssistantText(
            messages,
            "interrupted"
          ),
          runtimeStatusPartial:
            dependencies.isRecord(runtimeStatus) &&
            runtimeStatus.partial === true,
        },
        runtime: {
          iterationCount: finalStatus.iterationCount,
          phase: finalStatus.phase,
        },
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
    const harness = createConformanceKernelHarness();
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
  }

  async function runBranchCreate(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
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
    };
  }

  async function runInputSignalEmptyParts(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("should not execute")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    // This scenario intentionally crosses the typed boundary with malformed
    // input so the shared runner can observe runtime validation behavior.
    const emptySignal = { parts: [] } as unknown as InputSignal;

    try {
      runtime.executeTurn({
        branchId: thread.branchId,
        config: { name: AGENT_NAME },
        signal: emptySignal,
        threadId: thread.threadId,
      });

      return {
        evidence: {
          inputSignal: {
            accepted: true,
          },
        },
        result: {
          inputSignal: {
            accepted: true,
          },
        },
      };
    } catch (error: unknown) {
      return {
        evidence: {
          inputSignal: {
            accepted: false,
            error: readErrorEnvelope(error),
          },
        },
        result: {
          inputSignal: {
            accepted: false,
            error: readErrorEnvelope(error),
          },
        },
      };
    }
  }

  async function runTerminalValueComplete(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("Terminal complete.")],
          resolution: { reason: "done", type: "end_turn" },
        })),
      ]),
      kernel: harness.kernel,
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
        ? finalMsg.parts.find((p) => p.type === "text")
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
  }

  async function runTerminalValueFailure(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const failureDriver = {
      execute() {
        return Promise.resolve({
          messages: JSON.parse('[{"role":"assistant","parts":[123]}]'),
          resolution: { reason: "done", type: "end_turn" },
        });
      },
      id: DRIVER_ID,
    } satisfies RuntimeDriver;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([failureDriver]),
      kernel: harness.kernel,
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
  }

  async function runTerminalValueCancelled(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    let driverStarted = false;
    const cancelDriver = {
      async execute(context) {
        driverStarted = true;
        await waitForAbort(context.signal);
        return { resolution: { type: "continue_iteration" } };
      },
      id: DRIVER_ID,
    } satisfies RuntimeDriver;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([cancelDriver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal("cancel"),
      threadId: thread.threadId,
    });
    const resultPromise = handle.awaitResult();

    while (!driverStarted) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }

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
  }

  async function runTerminalValueIdempotent(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("Idempotent.")],
          resolution: { reason: "done", type: "end_turn" },
        })),
      ]),
      kernel: harness.kernel,
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
  }

  function runHandleTerminalValue(input: unknown): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.handle-terminal-value"
    );
    const caseValue =
      dependencies.readRecordString(scenario, "case") ?? "complete";

    if (caseValue === "complete") {
      return runTerminalValueComplete();
    }
    if (caseValue === "failure") {
      return runTerminalValueFailure();
    }
    if (caseValue === "cancelled") {
      return runTerminalValueCancelled();
    }
    if (caseValue === "idempotent") {
      return runTerminalValueIdempotent();
    }

    throw new Error(
      `runtime.handle-terminal-value: unknown case "${caseValue}"`
    );
  }

  // ── Durable-read scenarios (KRT-AO006) ────────────────────────────────────

  function makeDurableReadRuntime(
    harness: ReturnType<typeof createConformanceKernelHarness>
  ) {
    return createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("conformance")],
          resolution: { reason: "done", type: "end_turn" },
        })),
      ]),
      kernel: harness.kernel,
    });
  }

  async function runDurableReadListThreads(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    await runtime.createThread({});
    await runtime.createThread({});
    const result = await runtime.listThreads();
    return {
      result: {
        durableRead: {
          listThreads: {
            hasCursor: result.nextCursor !== undefined,
            threadCount: result.threads.length,
          },
        },
      },
    };
  }

  async function runDurableReadListThreadsPaginate(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    await runtime.createThread({});
    await runtime.createThread({});
    const page1 = await runtime.listThreads({ limit: 1 });
    if (page1.nextCursor === undefined) {
      return {
        result: {
          durableRead: {
            listThreads: {
              hasFirstCursor: false,
              page1Count: page1.threads.length,
            },
          },
        },
      };
    }
    const page2 = await runtime.listThreads({
      limit: 10,
      cursor: page1.nextCursor,
    });
    const uniqueIds = new Set([
      ...page1.threads.map((t) => t.threadId),
      ...page2.threads.map((t) => t.threadId),
    ]);
    return {
      result: {
        durableRead: {
          listThreads: {
            hasFirstCursor: true,
            hasSecondCursor: page2.nextCursor !== undefined,
            page1Count: page1.threads.length,
            page2Count: page2.threads.length,
            uniqueIds: uniqueIds.size,
          },
        },
      },
    };
  }

  async function runDurableReadListThreadsCapabilityRejected(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const capKernel = {
      ...harness.kernel,
      thread: {
        ...harness.kernel.thread,
        list: () => {
          throw new TuvrenPersistenceError(
            "thread enumeration unsupported by this backend",
            { code: "kernel_capability_unsupported" }
          );
        },
      },
    } as typeof harness.kernel;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("conformance")],
          resolution: { reason: "done", type: "end_turn" },
        })),
      ]),
      kernel: capKernel,
    });
    try {
      await runtime.listThreads();
      return {
        result: {
          durableRead: {
            listThreads: { raised: false },
          },
        },
      };
    } catch (error: unknown) {
      const code =
        dependencies.isRecord(error) && typeof error.code === "string"
          ? error.code
          : undefined;
      return {
        result: {
          durableRead: {
            listThreads: { errorCode: code, raised: true },
          },
        },
      };
    }
  }

  async function runDurableReadListBranches(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    const thread = await runtime.createThread({});
    await runtime.createBranch({
      fromTurnNodeHash: thread.rootTurnNodeHash,
      threadId: thread.threadId,
    });
    const branches = await runtime.listBranches({ threadId: thread.threadId });
    const allHaveThreadId = branches.every(
      (b) => b.threadId === thread.threadId
    );
    return {
      result: {
        durableRead: {
          listBranches: {
            allHaveThreadId,
            branchCount: branches.length,
          },
        },
      },
    };
  }

  async function runDurableReadGetTurnState(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    const thread = await runtime.createThread({});
    const snapshot = await runtime.getTurnState({
      branchId: thread.branchId,
      threadId: thread.threadId,
    });
    return {
      result: {
        durableRead: {
          getTurnState: {
            hasTurnNodeHash: typeof snapshot.turnNodeHash === "string",
            hasTurnTreeHash: typeof snapshot.turnTreeHash === "string",
            previousTurnNull: snapshot.previousTurnNodeHash === null,
          },
        },
      },
    };
  }

  async function runDurableReadGetTurnStateLineage(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    const thread = await runtime.createThread({});
    const snapshot = await runtime.getTurnState({
      branchId: thread.branchId,
      threadId: thread.threadId,
      turnNodeHash: thread.rootTurnNodeHash,
    });
    return {
      result: {
        durableRead: {
          getTurnState: {
            matchesExpectedHash:
              snapshot.turnNodeHash === thread.rootTurnNodeHash,
          },
        },
      },
    };
  }

  async function runDurableReadGetTurnHistory(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    const thread = await runtime.createThread({});
    const snapshots: unknown[] = [];
    for await (const snap of runtime.getTurnHistory({
      branchId: thread.branchId,
      threadId: thread.threadId,
    })) {
      snapshots.push(snap);
    }
    const first = snapshots[0];
    const firstSnapshotHasHash =
      dependencies.isRecord(first) && typeof first.turnNodeHash === "string";
    return {
      result: {
        durableRead: {
          getTurnHistory: {
            firstSnapshotHasHash,
            snapshotCount: snapshots.length,
          },
        },
      },
    };
  }

  async function runDurableReadReadBranchMessages(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    const thread = await runtime.createThread({});
    const result = await runtime.readBranchMessages({
      branchId: thread.branchId,
    });
    return {
      result: {
        durableRead: {
          readBranchMessages: {
            hasCursor: result.nextCursor !== undefined,
            messageCount: result.messages.length,
          },
        },
      },
    };
  }

  async function runDurableReadReadBranchMessagesHeadDrift(): Promise<AdapterProjection> {
    const harness = createConformanceKernelHarness();
    const runtime = makeDurableReadRuntime(harness);
    const thread = await runtime.createThread({});
    const staleCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "branch-messages",
        branchId: thread.branchId,
        positionFromOldest: 99,
        branchHeadAtCursorIssuance: "0".repeat(64),
      })
    ).toString("base64url") as BranchMessagesCursor;
    try {
      await runtime.readBranchMessages({
        after: staleCursor,
        branchId: thread.branchId,
      });
      return {
        result: {
          durableRead: {
            readBranchMessages: { raised: false },
          },
        },
      };
    } catch (error: unknown) {
      const code =
        dependencies.isRecord(error) && typeof error.code === "string"
          ? error.code
          : undefined;
      return {
        result: {
          durableRead: {
            readBranchMessages: { errorCode: code, raised: true },
          },
        },
      };
    }
  }

  return {
    runApprovalResume,
    runBranchCreate,
    runCancelledRuntimeTurn,
    runCompletedRuntimeTurn,
    runContextTransform: providerScenarios.runContextTransform,
    runDurableReadGetTurnHistory,
    runDurableReadGetTurnState,
    runDurableReadGetTurnStateLineage,
    runDurableReadListBranches,
    runDurableReadListThreads,
    runDurableReadListThreadsCapabilityRejected,
    runDurableReadListThreadsPaginate,
    runDurableReadReadBranchMessages,
    runDurableReadReadBranchMessagesHeadDrift,
    runHandleTerminalValue,
    runProviderGenerate: providerScenarios.runProviderGenerate,
    runProviderStream: providerScenarios.runProviderStream,
    runClientResultAsProposal: recoveryScenarios.runClientResultAsProposal,
    runRecoverResult: recoveryScenarios.runRecoverResult,
    runRecoverStaleRun: recoveryScenarios.runRecoverStaleRun,
    runOperationalTelemetry,
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

  async function waitForHandlePhase(
    handle: ExecutionHandle,
    phase: "completed" | "failed" | "paused" | "running"
  ): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (handle.status().phase === phase) {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    throw new Error(`handle did not reach ${phase} phase`);
  }

  function hasAssistantText(
    messages: readonly unknown[],
    expectedText: string
  ): boolean {
    for (const message of messages) {
      if (!dependencies.isRecord(message) || message.role !== "assistant") {
        continue;
      }

      const parts = message.parts;

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

  function readLastCheckpointHash(events: readonly unknown[]): string {
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
  }

  function observeSupersededPausedHandle(
    handle: ExecutionHandle
  ): Record<string, unknown> {
    return {
      cancelErrorCode: readThrownErrorCode(() => handle.cancel()),
      resolveApprovalErrorCode: readThrownErrorCode(() =>
        handle.resolveApproval({ decisions: [] })
      ),
      statusPhaseAfterResolution: handle.status().phase,
    };
  }

  function readThrownErrorCode(action: () => void): string | undefined {
    try {
      action();
      return undefined;
    } catch (error: unknown) {
      if (dependencies.isRecord(error) && typeof error.code === "string") {
        return error.code;
      }

      return undefined;
    }
  }

  function readErrorEnvelope(error: unknown): Record<string, unknown> {
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
  }

  function readToolResultParts(
    messages: readonly unknown[]
  ): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];

    for (const message of messages) {
      if (!dependencies.isRecord(message) || message.role !== "tool") {
        continue;
      }

      const parts = message.parts;

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
  }

  function readFirstApprovalMessage(
    toolResults: readonly Record<string, unknown>[]
  ): string | undefined {
    for (const result of toolResults) {
      const output = result.output;

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
  }

  function readEventStringValues(
    events: readonly unknown[],
    key: string
  ): string[] {
    const values = new Set<string>();

    for (const event of events) {
      const value = dependencies.readRecordString(event, key);

      if (value !== undefined) {
        values.add(value);
      }
    }

    return [...values].sort();
  }

  function didEventOccurAfter(
    events: readonly unknown[],
    earlierType: string,
    laterType: string,
    laterCallId?: string
  ): boolean {
    const earlierIndex = findEventIndex(events, earlierType);
    const laterIndex = findEventIndex(events, laterType, laterCallId);

    return earlierIndex >= 0 && laterIndex > earlierIndex;
  }

  function findEventIndex(
    events: readonly unknown[],
    type: string,
    callId?: string
  ): number {
    return events.findIndex((event) => {
      if (dependencies.readRecordString(event, "type") !== type) {
        return false;
      }

      return (
        callId === undefined ||
        dependencies.readRecordString(event, "callId") === callId
      );
    });
  }

  function eventStreamsShareTurn(
    firstEvents: readonly unknown[],
    secondEvents: readonly unknown[]
  ): boolean {
    const firstTurnIds = readEventStringValues(firstEvents, "turnId");
    const secondTurnIds = readEventStringValues(secondEvents, "turnId");

    return (
      firstTurnIds.length === 1 &&
      secondTurnIds.length === 1 &&
      firstTurnIds[0] === secondTurnIds[0]
    );
  }
}

function createTelemetryCapture(): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
  spans: TelemetrySpan[];
} {
  const events: TelemetryEvent[] = [];
  const spans: TelemetrySpan[] = [];

  return {
    events,
    sink: {
      event: (event) => {
        events.push(event);
      },
      span: (span) => {
        spans.push(span);
      },
    },
    spans,
  };
}

function summarizeTelemetry(capture: {
  events: readonly TelemetryEvent[];
  spans: readonly TelemetrySpan[];
}): Record<string, unknown> {
  return {
    eventKinds: capture.events.map((event) => event.kind),
    eventsHaveLineage: capture.events.every(
      (event) =>
        event.lineage.threadId.length > 0 &&
        event.lineage.branchId.length > 0 &&
        event.lineage.turnId.length > 0
    ),
    spanKinds: capture.spans.map((span) => span.kind),
    spansHaveLineage: capture.spans.every(
      (span) =>
        span.lineage.threadId.length > 0 &&
        span.lineage.branchId.length > 0 &&
        span.lineage.turnId.length > 0
    ),
  };
}

function createDeterministicClock(): () => number {
  let now = 10_000;

  return () => {
    now += 10;
    return now;
  };
}
