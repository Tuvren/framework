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

import { TuvrenPersistenceError } from "@tuvren/core";
import type { InputSignal } from "@tuvren/core/execution";
import type {
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "@tuvren/core/provider";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type { ApprovalDecision } from "@tuvren/core/tools";
import type { ProviderStreamChunk } from "@tuvren/provider-api";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";

import { createFrameworkAdapterProviderScenarios } from "./framework-adapter-provider-scenarios.ts";
import { createFrameworkAdapterRecoveryScenarios } from "./framework-adapter-recovery-scenarios.ts";
import {
  createFrameworkAdapterRuntimeLifecycleScenarios,
  waitForAbort,
} from "./framework-adapter-runtime-lifecycle-scenarios.ts";
import { createFrameworkAdapterRuntimeTelemetryScenarios } from "./framework-adapter-runtime-telemetry-scenarios.ts";
import {
  AGENT_NAME,
  assistantText,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

export interface FrameworkAdapterRuntimeScenarioDependencies {
  isRecord: (value: unknown) => value is Record<string, unknown>;
  readApprovalDecisions: (
    record: Record<string, unknown>,
    path: string
  ) => ApprovalDecision[];
  readAssistantText: (
    messages: readonly unknown[],
    expectedText: string
  ) => string | undefined;
  readFirstErrorEnvelope: (
    events: readonly unknown[]
  ) => Record<string, unknown> | undefined;
  readModelResponseArrayProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => TuvrenModelResponse[];
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
  readRecordProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => Record<string, unknown>;
  readRecordString: (value: unknown, key: string) => string | undefined;
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

const makeDurableReadRuntime = (
  harness: ReturnType<typeof createConformanceKernelHarness>
) =>
  createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([
      createStaticRunner(() => ({
        messages: [assistantText("conformance")],
        resolution: { reason: "done", type: "end_turn" },
      })),
    ]),
  });

const runDurableReadListThreads = async (): Promise<AdapterProjection> => {
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
};

const runDurableReadListThreadsPaginate =
  async (): Promise<AdapterProjection> => {
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
      cursor: page1.nextCursor,
      limit: 10,
    });
    const uniqueIds = new Set([
      ...page1.threads.map((thread) => thread.threadId),
      ...page2.threads.map((thread) => thread.threadId),
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
  };

const runDurableReadListBranches = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runtime = makeDurableReadRuntime(harness);
  const thread = await runtime.createThread({});
  await runtime.createBranch({
    fromTurnNodeHash: thread.rootTurnNodeHash,
    threadId: thread.threadId,
  });
  const branches = await runtime.listBranches({ threadId: thread.threadId });
  const allHaveThreadId = branches.every(
    (branch) => branch.threadId === thread.threadId
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
};

const runDurableReadGetTurnState = async (): Promise<AdapterProjection> => {
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
};

const runDurableReadGetTurnStateLineage =
  async (): Promise<AdapterProjection> => {
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
  };

const runDurableReadReadBranchMessages =
  async (): Promise<AdapterProjection> => {
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
  };

export const createFrameworkAdapterRuntimeScenarios = (
  dependencies: FrameworkAdapterRuntimeScenarioDependencies
): {
  runApprovalResume: (input: unknown) => Promise<AdapterProjection>;
  runBranchCreate: () => Promise<AdapterProjection>;
  runCancelledRuntimeTurn: (controls: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  }) => Promise<AdapterProjection>;
  runCompletedRuntimeTurn: (input: unknown) => Promise<AdapterProjection>;
  runContextTransform: (input: unknown) => Promise<AdapterProjection>;
  runDurableReadGetTurnHistory: () => Promise<AdapterProjection>;
  runDurableReadGetTurnState: () => Promise<AdapterProjection>;
  runDurableReadGetTurnStateLineage: () => Promise<AdapterProjection>;
  runDurableReadListBranches: () => Promise<AdapterProjection>;
  runDurableReadListThreads: () => Promise<AdapterProjection>;
  runDurableReadListThreadsCapabilityRejected: () => Promise<AdapterProjection>;
  runDurableReadListThreadsPaginate: () => Promise<AdapterProjection>;
  runDurableReadReadBranchMessages: () => Promise<AdapterProjection>;
  runDurableReadReadBranchMessagesHeadDrift: () => Promise<AdapterProjection>;
  runHandleTerminalValue: (input: unknown) => Promise<AdapterProjection>;
  runProviderGenerate: (input: unknown) => Promise<AdapterProjection>;
  runProviderStream: (input: unknown) => Promise<AdapterProjection>;
  runClientResultAsProposal: (input: unknown) => Promise<AdapterProjection>;
  runRecoverResult: (input: unknown) => Promise<AdapterProjection>;
  runRecoverStaleRun: (input: unknown) => Promise<AdapterProjection>;
  runOperationalTelemetry: (input: unknown) => Promise<AdapterProjection>;
  runStructuredValidationFailure: (
    input: unknown
  ) => Promise<AdapterProjection>;
  runToolExecution: (input: unknown) => Promise<AdapterProjection>;
} => {
  const providerScenarios = createFrameworkAdapterProviderScenarios({
    readAssistantText: (...arguments_) =>
      dependencies.readAssistantText(...arguments_),
    readFirstErrorEnvelope: (...arguments_) =>
      dependencies.readFirstErrorEnvelope(...arguments_),
    readModelResponseProperty: (...arguments_) =>
      dependencies.readModelResponseProperty(...arguments_),
    readOperationScenario: (...arguments_) =>
      dependencies.readOperationScenario(...arguments_),
    readPromptProperty: (...arguments_) =>
      dependencies.readPromptProperty(...arguments_),
    readProperty: (...arguments_) => dependencies.readProperty(...arguments_),
    readProviderStreamChunks: (...arguments_) =>
      dependencies.readProviderStreamChunks(...arguments_),
    readResponseFormatProperty: (...arguments_) =>
      dependencies.readResponseFormatProperty(...arguments_),
    readScenarioToolCall: (...arguments_) =>
      dependencies.readScenarioToolCall(...arguments_),
    readScenarioToolCalls: (...arguments_) =>
      dependencies.readScenarioToolCalls(...arguments_),
    readStringProperty: (...arguments_) =>
      dependencies.readStringProperty(...arguments_),
  });
  const recoveryScenarios = createFrameworkAdapterRecoveryScenarios({
    isRecord: (value) => dependencies.isRecord(value),
    readOperationScenario: (...arguments_) =>
      dependencies.readOperationScenario(...arguments_),
    readProperty: (...arguments_) => dependencies.readProperty(...arguments_),
    readRecordProperty: (...arguments_) =>
      dependencies.readRecordProperty(...arguments_),
    readRecordString: (...arguments_) =>
      dependencies.readRecordString(...arguments_),
    readStringProperty: (...arguments_) =>
      dependencies.readStringProperty(...arguments_),
  });
  const lifecycleScenarios = createFrameworkAdapterRuntimeLifecycleScenarios({
    isRecord: (value) => dependencies.isRecord(value),
    readApprovalDecisions: (...arguments_) =>
      dependencies.readApprovalDecisions(...arguments_),
    readOperationScenario: (...arguments_) =>
      dependencies.readOperationScenario(...arguments_),
    readRecordString: (...arguments_) =>
      dependencies.readRecordString(...arguments_),
    readScenarioToolCalls: (...arguments_) =>
      dependencies.readScenarioToolCalls(...arguments_),
    readStringProperty: (...arguments_) =>
      dependencies.readStringProperty(...arguments_),
  });
  const telemetryScenarios = createFrameworkAdapterRuntimeTelemetryScenarios({
    readOperationScenario: (...arguments_) =>
      dependencies.readOperationScenario(...arguments_),
    readProperty: (...arguments_) => dependencies.readProperty(...arguments_),
    readRecordString: (...arguments_) =>
      dependencies.readRecordString(...arguments_),
  });

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

  const runInputSignalEmptyParts = async (): Promise<AdapterProjection> => {
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText("should not execute")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
    });
    const thread = await runtime.createThread({});
    // This scenario intentionally crosses the typed boundary with malformed
    // input so the shared runner can observe runtime validation behavior.
    const emptySignal: InputSignal = textSignal("invalid empty input");
    emptySignal.parts.pop();

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
  };

  const runCompletedRuntimeTurn = async (
    input: unknown
  ): Promise<AdapterProjection> => {
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
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText("completed")],
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
  };

  const countEventsByType = (
    events: readonly unknown[],
    type: string
  ): number => {
    let count = 0;

    for (const event of events) {
      if (dependencies.readRecordString(event, "type") === type) {
        count += 1;
      }
    }

    return count;
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

  const runCancelledRuntimeTurn = async (controls: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  }): Promise<AdapterProjection> => {
    const harness = createConformanceKernelHarness();
    let executeCount = 0;
    const runner = {
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
            error: new Error("runner observed cancellation"),
            fatality: "hard",
            type: "fail",
          },
        };
      },
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
      config: { name: AGENT_NAME },
      signal: textSignal("cancel"),
      threadId: thread.threadId,
    });
    const events: unknown[] = [];
    const { cancelAfterEvent } = controls;
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
        error: readFirstErrorEnvelope(events),
        runtime: {
          iterationCount: finalStatus.iterationCount,
          phase: finalStatus.phase,
        },
      },
    };
  };

  // ── Durable-read scenarios (KRT-AO006) ────────────────────────────────────

  const runDurableReadListThreadsCapabilityRejected =
    async (): Promise<AdapterProjection> => {
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
      } satisfies typeof harness.kernel;
      const runtime = createTuvrenRuntimeCore({
        createId: createConformanceIdFactory(),
        defaultRunnerId: RUNNER_ID,
        kernel: capKernel,
        runnerRegistry: createRunnerRegistry([
          createStaticRunner(() => ({
            messages: [assistantText("conformance")],
            resolution: { reason: "done", type: "end_turn" },
          })),
        ]),
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
    };

  const runDurableReadGetTurnHistory = async (): Promise<AdapterProjection> => {
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
    const [first] = snapshots;
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
  };

  const runDurableReadReadBranchMessagesHeadDrift =
    async (): Promise<AdapterProjection> => {
      const harness = createConformanceKernelHarness();
      const runtime = makeDurableReadRuntime(harness);
      const thread = await runtime.createThread({});
      const staleCursor = Buffer.from(
        JSON.stringify({
          branchHeadAtCursorIssuance: "0".repeat(64),
          branchId: thread.branchId,
          kind: "branch-messages",
          positionFromOldest: 99,
          v: 1,
        })
      ).toString("base64url");
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
    };

  return {
    runApprovalResume: lifecycleScenarios.runApprovalResume,
    runBranchCreate: lifecycleScenarios.runBranchCreate,
    runCancelledRuntimeTurn,
    runClientResultAsProposal: recoveryScenarios.runClientResultAsProposal,
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
    runHandleTerminalValue: lifecycleScenarios.runHandleTerminalValue,
    runOperationalTelemetry: telemetryScenarios.runOperationalTelemetry,
    runProviderGenerate: providerScenarios.runProviderGenerate,
    runProviderStream: providerScenarios.runProviderStream,
    runRecoverResult: recoveryScenarios.runRecoverResult,
    runRecoverStaleRun: recoveryScenarios.runRecoverStaleRun,
    runStructuredValidationFailure:
      providerScenarios.runStructuredValidationFailure,
    runToolExecution: providerScenarios.runToolExecution,
  };
};
