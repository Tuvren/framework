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

import { assertHashString, TuvrenPersistenceError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ExecutionHandle, InputSignal } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "@tuvren/core/provider";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type {
  TelemetryDestination,
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type {
  ApprovalDecision,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type { ProviderStreamChunk } from "@tuvren/provider-api";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "@tuvren/runtime";

import { createFrameworkAdapterProviderScenarios } from "./framework-adapter-provider-scenarios.ts";
import { createFrameworkAdapterRecoveryScenarios } from "./framework-adapter-recovery-scenarios.ts";
import {
  AGENT_NAME,
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

const createTelemetryCapture = (): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
  spans: TelemetrySpan[];
} => {
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
};

const createDeterministicClock = (): (() => number) => {
  let now = 10_000;

  return () => {
    now += 10;
    return now;
  };
};

const summarizeTelemetry = (capture: {
  events: readonly TelemetryEvent[];
  spans: readonly TelemetrySpan[];
}): Record<string, unknown> => ({
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
});

// The content funnel's assistant-text surface: `text.done` stream events carry
// the full message text the session emitted (ADR-0058 §5b evidence source).
const readTextDoneTexts = (events: readonly TuvrenStreamEvent[]): string[] =>
  events.flatMap((event) => (event.type === "text.done" ? [event.text] : []));

const fromSynchronousWithoutArguments = <Value>(
  operation: () => Value
): (() => Promise<Value>) =>
  Promise.try.bind<typeof Promise, [() => Value], [], Promise<Value>>(
    Promise,
    operation
  );

const hasToolMessage = (messages: readonly TuvrenMessage[]): boolean =>
  messages.some((message) => message.role === "tool");

const waitForAbort = async (signal: AbortSignal | undefined): Promise<void> => {
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

const createOperationalTelemetryTools = (
  scenarioCase: string | undefined
): TuvrenToolDefinition[] => {
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
};

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

const runTelemetryDestinationTurn = async (options: {
  failDelivery: boolean;
}): Promise<{
  deliveredRecordKinds: string[];
  eventTypes: string[];
  operationalSignalKinds: string[];
  phase: string;
}> => {
  const deliveredRecordKinds: string[] = [];
  const operationalSignalKinds: string[] = [];
  const destination: TelemetryDestination = {
    deliver(batch) {
      if (options.failDelivery) {
        throw new Error("conformance destination unavailable");
      }

      deliveredRecordKinds.push(...batch.map((record) => record.kind));
    },
    onOperationalSignal(signal) {
      operationalSignalKinds.push(signal.kind);
    },
  };
  const harness = createConformanceKernelHarness();
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    now: createDeterministicClock(),
    runnerRegistry: createRunnerRegistry([
      createStaticRunner(() => ({
        messages: [assistantText("completed")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
    ]),
    telemetry: destination,
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
    deliveredRecordKinds,
    eventTypes: events.map((event) => event.type),
    operationalSignalKinds,
    phase: handle.status().phase,
  };
};

const runDestinationHealthEquivalence =
  async (): Promise<AdapterProjection> => {
    const healthy = await runTelemetryDestinationTurn({
      failDelivery: false,
    });
    const unavailable = await runTelemetryDestinationTurn({
      failDelivery: true,
    });
    const funnel = { healthy, unavailable };

    return {
      evidence: { funnel },
      result: { funnel },
    };
  };

const createOperationalTelemetryRunner = (
  scenarioCase: string | undefined
): RuntimeRunner => {
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
    id: RUNNER_ID,
  };
};

const runOperationalTelemetryRecovery = async (
  capture: ReturnType<typeof createTelemetryCapture>
): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const livenessHarness = createConformanceRunLivenessKernelHarness(harness);
  const runner = createStaticRunner(() => ({
    messages: [assistantText("recovered")],
    resolution: {
      reason: "done",
      type: "end_turn",
    },
  }));
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: livenessHarness.kernel,
    now: createDeterministicClock(),
    runLiveness: {
      executionOwnerId: "worker-1",
      leaseDurationMs: 50,
    },
    runnerRegistry: createRunnerRegistry([runner]),
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

  // ADR-0058 §5a/§5c (KRT-BJ005): run the same deterministic turn against a
  // telemetry destination, reporting the implementation-observed session event
  // types, terminal phase, delivered telemetry record kinds, and
  // operational-signal kinds. This function only measures; the shared
  // conformance plan owns the healthy-vs-unavailable equivalence and
  // failure-to-signal grading.
  const readContentMarkers = (
    scenario: Record<string, unknown>
  ): {
    assistant: string;
    user: string;
  } => {
    const value = dependencies.readProperty(
      scenario,
      "contentMarkers",
      "$.scenario.contentMarkers"
    );

    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0
      )
    ) {
      throw new Error(
        "content-isolation scenario requires two non-empty contentMarkers strings"
      );
    }

    return { assistant: value[1], user: value[0] };
  };

  // ADR-0058 §5b (KRT-BJ005): run a turn whose input signal and assistant reply
  // carry the scenario-owned content markers under default push-based routing,
  // and report both funnels' surfaces — the content-funnel message texts and
  // the raw telemetry records — so the shared plan can grade content-payload
  // absence on the telemetry funnel without adapter-side pass/fail decisions.
  const runContentFunnelIsolation = async (
    scenario: Record<string, unknown>
  ): Promise<AdapterProjection> => {
    const markers = readContentMarkers(scenario);
    const capture = createTelemetryCapture();
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      now: createDeterministicClock(),
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText(markers.assistant)],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      telemetry: capture.sink,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME },
      signal: textSignal(markers.user),
      threadId: thread.threadId,
    });
    const events = await collectValues(handle.events());
    const projection = {
      contentFunnel: {
        messageTexts: readTextDoneTexts(events),
      },
      telemetry: {
        events: capture.events,
        spans: capture.spans,
      },
      telemetryEventKinds: capture.events.map((event) => event.kind),
    };

    return {
      evidence: projection,
      result: projection,
    };
  };

  const runOperationalTelemetry = async (
    input: unknown
  ): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.operational-telemetry"
    );
    const scenarioCase = dependencies.readRecordString(scenario, "case");

    // ADR-0058 §5 funnel-isolation scenarios (KRT-BJ005): these cases construct
    // their own telemetry routing, so they branch before the push-based sink
    // capture the remaining cases share.
    if (scenarioCase === "destination-health") {
      return await runDestinationHealthEquivalence();
    }

    if (scenarioCase === "content-isolation") {
      return await runContentFunnelIsolation(scenario);
    }

    const capture = createTelemetryCapture();
    const harness = createConformanceKernelHarness();
    const runner = createOperationalTelemetryRunner(scenarioCase);
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      now: createDeterministicClock(),
      runnerRegistry: createRunnerRegistry([runner]),
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
      } as typeof harness.kernel;
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
    runApprovalResume,
    runBranchCreate,
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
    runHandleTerminalValue,
    runOperationalTelemetry,
    runProviderGenerate: providerScenarios.runProviderGenerate,
    runProviderStream: providerScenarios.runProviderStream,
    runRecoverResult: recoveryScenarios.runRecoverResult,
    runRecoverStaleRun: recoveryScenarios.runRecoverStaleRun,
    runStructuredValidationFailure:
      providerScenarios.runStructuredValidationFailure,
    runToolExecution: providerScenarios.runToolExecution,
  };
};
