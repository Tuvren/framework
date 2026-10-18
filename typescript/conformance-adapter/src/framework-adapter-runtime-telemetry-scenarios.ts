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
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type {
  TelemetryDestination,
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "@tuvren/runtime";

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

interface RuntimeTelemetryScenarioDependencies {
  readOperationScenario: (
    input: unknown,
    operation: string
  ) => Record<string, unknown>;
  readProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => unknown;
  readRecordString: (value: unknown, key: string) => string | undefined;
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

const hasToolMessage = (messages: readonly TuvrenMessage[]): boolean =>
  messages.some((message) => message.role === "tool");

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

export const createFrameworkAdapterRuntimeTelemetryScenarios = (
  dependencies: RuntimeTelemetryScenarioDependencies
): {
  runOperationalTelemetry: (input: unknown) => Promise<AdapterProjection>;
} => {
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

  return { runOperationalTelemetry };
};
