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

import type { RuntimeDriver } from "@tuvren/driver-api";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "../../runtime-core/src/index.ts";
import {
  createFakeKernelHarness,
  createFakeRunLivenessKernelHarness,
} from "../../runtime-core/test/fake-kernel.ts";
import {
  type AdapterProjection,
  assistantText,
  collectValues,
  createConformanceIdFactory,
  createStaticDriver,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterRecoveryScenarioDependencies {
  isRecord(value: unknown): value is Record<string, unknown>;
  readOperationScenario(
    input: unknown,
    operation: string
  ): Record<string, unknown>;
  readProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): unknown;
  readRecordProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): Record<string, unknown>;
  readRecordString(value: unknown, key: string): string | undefined;
  readStringProperty(
    record: Record<string, unknown>,
    property: string,
    path: string
  ): string;
}

export function createFrameworkAdapterRecoveryScenarios(
  dependencies: FrameworkAdapterRecoveryScenarioDependencies
): {
  runRecoverResult(input: unknown): Promise<AdapterProjection>;
  runRecoverStaleRun(input: unknown): Promise<AdapterProjection>;
} {
  async function runRecoverResult(input: unknown): Promise<AdapterProjection> {
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
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createStaticDriver(() => ({
          messages: [assistantText("recovery placeholder")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const runId = "shared-recovery-run";

    await harness.kernel.run.create(
      runId,
      "shared-recovery-turn",
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

    return {
      evidence: {
        recovery: {
          firstObjectType: firstStagedResult?.objectType,
          firstTaskId: firstStagedResult?.taskId,
          lastTurnNodeHash: recovery.lastTurnNodeHash,
          uncommittedStagedResults: recovery.uncommittedStagedResults.length,
        },
      },
      state: { recovery },
    };
  }

  async function runRecoverStaleRun(
    input: unknown
  ): Promise<AdapterProjection> {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.recover-stale-run"
    );
    const recoveryCase = dependencies.readStringProperty(
      scenario,
      "recoveryCase",
      "runtime.recover-stale-run.recoveryCase"
    );
    const prompt = dependencies.readStringProperty(
      scenario,
      "prompt",
      "runtime.recover-stale-run.prompt"
    );
    const recoveredAssistantText =
      typeof scenario.recoveredAssistantText === "string"
        ? scenario.recoveredAssistantText
        : undefined;
    const harness = createFakeKernelHarness();
    const livenessHarness = createFakeRunLivenessKernelHarness(harness);
    let executeCalls = 0;

    const driver = {
      execute() {
        executeCalls += 1;
        return Promise.resolve({
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
        });
      },
      id: DRIVER_ID,
    } satisfies RuntimeDriver;
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultDriverId: DRIVER_ID,
      driverRegistry: createDriverRegistry([driver]),
      kernel: livenessHarness.kernel,
      resolveAgentConfig(agentName) {
        if (agentName === "primary" || agentName === "reviewer") {
          return { name: agentName };
        }
        return undefined;
      },
      runLiveness: {
        executionOwnerId: "worker-1",
        leaseDurationMs: 50,
      },
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

    switch (recoveryCase) {
      case "same_signal_iterate":
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
      case "signal_mismatch":
        break;
      case "handoff_context":
        await stageRecoveredRuntimeStatus(
          livenessHarness,
          staleRunId,
          `${recoveryCase}_runtime_status`,
          { activeAgent: "reviewer", state: "running" }
        );
        break;
      case "finalize_turn_status":
        await stageRecoveredRuntimeStatus(
          livenessHarness,
          staleRunId,
          `${recoveryCase}_runtime_status`,
          { activeAgent: "primary", state: "completed" }
        );
        break;
      default:
        throw new Error(
          `runtime.recover-stale-run declared unsupported recoveryCase ${recoveryCase}`
        );
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

    return {
      evidence: {
        recovery: {
          activeAgent: handle.status().activeAgent,
          branchRuntimePhase: dependencies.readRecordString(
            branchRuntimeStatus,
            "state"
          ),
          branchStatusActiveAgent: dependencies.readRecordString(
            branchRuntimeStatus,
            "activeAgent"
          ),
          driverExecuteCalls: executeCalls,
          freshUserMessageCount: countUserTextMessages(
            branchMessages,
            signalText
          ),
          originalUserMessageCount: countUserTextMessages(
            branchMessages,
            prompt
          ),
          phase: handle.status().phase,
          preemptCalls: livenessHarness.getPreemptCalls(),
          recoveredAssistantVisible: hasTextMessage(
            branchMessages,
            "assistant",
            recoveredAssistantText ?? ""
          ),
          sameTurn: observedTurnId === staleTurn.turnId,
          staleRunStatus:
            branchRuns.find((run) => run.runId === staleRunId)?.status ?? null,
        },
      },
    };
  }

  return {
    runRecoverResult,
    runRecoverStaleRun,
  };

  function hasTextMessage(
    messages: readonly unknown[],
    role: "assistant" | "user",
    expectedText: string
  ): boolean {
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
      return message.parts.some((part) => {
        return (
          dependencies.isRecord(part) &&
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text === expectedText
        );
      });
    });
  }

  function countUserTextMessages(
    messages: readonly unknown[],
    expectedText: string
  ): number {
    let count = 0;
    for (const message of messages) {
      if (hasTextMessage([message], "user", expectedText)) {
        count += 1;
      }
    }
    return count;
  }

  function readTurnId(events: readonly unknown[]): string | undefined {
    for (const event of events) {
      const turnId = dependencies.readRecordString(event, "turnId");
      if (turnId !== undefined) {
        return turnId;
      }
    }
    return undefined;
  }

  async function stageRecoveredMessage(
    livenessHarness: ReturnType<typeof createFakeRunLivenessKernelHarness>,
    runId: string,
    taskId: string,
    text: string,
    role: "assistant" | "user" = "user"
  ): Promise<void> {
    await livenessHarness.kernel.staging.stage(
      runId,
      encodeDeterministicKernelRecord({
        parts: [{ text, type: "text" }],
        role,
      }),
      taskId,
      "message",
      "completed"
    );
  }

  async function stageRecoveredRuntimeStatus(
    livenessHarness: ReturnType<typeof createFakeRunLivenessKernelHarness>,
    runId: string,
    taskId: string,
    status: { activeAgent: string; state: "completed" | "running" }
  ): Promise<void> {
    await livenessHarness.kernel.staging.stage(
      runId,
      encodeDeterministicKernelRecord(status),
      taskId,
      "runtime_status",
      "completed"
    );
  }
}
