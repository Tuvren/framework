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

import type { TuvrenJsonSchema } from "@tuvren/core/messages";
import { assertTuvrenMessage } from "@tuvren/core/messages";
import type {
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
} from "@tuvren/core/provider";
import type { ApprovalDecision } from "@tuvren/core/tools";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
} from "@tuvren/provider-api";
import type { ProviderStreamChunk } from "@tuvren/provider-api";

import { createAdapterErrorEnvelope } from "../../../tools/conformance/adapter-protocol/index.js";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../tools/conformance/adapter-protocol/index.js";
import { runAdmissionKeySteerCarriage } from "./framework-adapter-admission-key-session.ts";
import { createFrameworkAdapterAdmissionKeyScenarios } from "./framework-adapter-admission-key.ts";
import { createFrameworkAdapterBatteriesIncluded } from "./framework-adapter-batteries-included.ts";
import { runCapabilityOrchestrationIntegration } from "./framework-adapter-capability-orchestration-integration.ts";
import {
  runCapabilityOrchestrationFoundation,
  runCapabilityOrchestrationPolicyDecisions,
} from "./framework-adapter-capability-orchestration.ts";
import {
  runCapabilityPolicyComposition,
  runCapabilityPolicyExposureDimensions,
  runCapabilityPolicyInvocationDimensions,
  runCapabilityPolicyNonretryablePolicy,
  runCapabilityPolicyWiredInvocationDenial,
  runCapabilityPolicyWiredRiskApproval,
} from "./framework-adapter-capability-policy.ts";
import { createFrameworkAdapterEventStreamResume } from "./framework-adapter-event-stream-resume.ts";
import { createFrameworkAdapterEventStreamSse } from "./framework-adapter-event-stream-sse.ts";
import { createFrameworkAdapterEventStreamWs } from "./framework-adapter-event-stream-ws.ts";
import { createFrameworkAdapterEventStream } from "./framework-adapter-event-stream.ts";
import {
  runExecutionBoundsConcurrencyThrottle,
  runExecutionBoundsInvalidConfig,
  runExecutionBoundsMaxIterations,
  runExecutionBoundsMaxToolCalls,
  runExecutionBoundsMaxWallClock,
  runExecutionBoundsWallClockSignalDelivery,
  runExecutionBoundsWithinBounds,
} from "./framework-adapter-execution-bounds.ts";
import { runInvocationLifecycleCrossClass } from "./framework-adapter-invocation-lifecycle.ts";
import { createFrameworkAdapterOrchestration } from "./framework-adapter-orchestration.ts";
import { createFrameworkAdapterProvingHost } from "./framework-adapter-proving-host.ts";
import { createFrameworkAdapterRunner } from "./framework-adapter-runner.ts";
import { createFrameworkAdapterRuntimeScenarios } from "./framework-adapter-runtime-scenarios.ts";
import type {
  AdapterProjection,
  ScenarioToolCall,
} from "./framework-adapter-runtime.ts";
import { createFrameworkAdapterSchemaAuthoring } from "./framework-adapter-schema-authoring.ts";
import {
  runSanitizeSeamToolResult,
  runScopeIsolationSurfaces,
  runSecretIsolationProviderBridge,
  runSecretIsolationRuntimeApi,
  runSecretIsolationTelemetry,
} from "./framework-adapter-secret-isolation.ts";
import {
  runApprovalResponseResume,
  runCancelCooperative,
  runCancelWhilePaused,
  runDispatchTimeout,
  runGraceWindowExpiry,
  runReattachRedelivery,
  runSequenceContinuity,
  runStaleClientResult,
  runValidateFrameFixtures,
} from "./framework-adapter-session.ts";
import {
  runTrustBoundaryApprovalNonBypassable,
  runTrustBoundaryLocalToolInput,
} from "./framework-adapter-trust-boundary.ts";
import {
  runTuvrenClientLifecycle,
  runTuvrenClientNetworkReconnectRedelivery,
  runTuvrenClientResultDurability,
} from "./framework-adapter-tuvren-client-execution-class.ts";
import {
  runTuvrenServerBindingClassification,
  runTuvrenServerCancellation,
  runTuvrenServerLifecycle,
  runTuvrenServerTenantIsolation,
} from "./framework-adapter-tuvren-server-execution-class.ts";

export type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../tools/conformance/adapter-protocol/index.js";

export interface ImplementationAdapter {
  dispatch: (
    operation: string,
    input: unknown,
    controls: AdapterControls
  ) => Promise<OperationOutcome>;
  events: (
    operation: string,
    input: unknown,
    controls: AdapterControls
  ) => AsyncIterable<unknown>;
  initialize: (
    packetId: string,
    planVersion: string
  ) => AdapterCapabilities | Promise<AdapterCapabilities>;
  inspectState?: (query: unknown) => Promise<unknown>;
  shutdown: () => Promise<void>;
}
interface OperationObservation {
  adapterEvents: number;
  initialized: boolean;
  status: OperationStatus;
}
type OperationStatus = "completed" | "failed" | "paused";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toObservedErrorEnvelope = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    const envelope: Record<string, unknown> = {
      code:
        isRecord(error) && typeof error.code === "string"
          ? error.code
          : "adapter_operation_failed",
      message: error.message,
    };

    if (isRecord(error) && error.details !== undefined) {
      envelope.details = error.details;
    }

    return envelope;
  }

  return { ...createAdapterErrorEnvelope(error) };
};

const readFirstErrorEnvelope = (
  events: readonly unknown[]
): Record<string, unknown> | undefined => {
  for (const event of events) {
    if (isRecord(event) && isRecord(event.error)) {
      return event.error;
    }
  }

  return undefined;
};

const errorToEnvelope = (error: Error): Record<string, unknown> => {
  const errorRecord: Record<string, unknown> = isRecord(error) ? error : {};
  const code =
    typeof errorRecord.code === "string" ? errorRecord.code : "runner_error";
  const envelope: Record<string, unknown> = {
    code,
    message: error.message,
  };

  if (errorRecord.details !== undefined) {
    envelope.details = errorRecord.details;
  }

  return envelope;
};

const readRecordString = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

const parseJsonValue = (value: string): unknown => JSON.parse(value);

const projectionStatus = (projection: AdapterProjection): OperationStatus => {
  if (isRecord(projection.result) && projection.result.error !== undefined) {
    return "failed";
  }

  return "completed";
};

const throwIfCancelled = (controls: AdapterControls): void => {
  if (controls.cancel !== undefined) {
    throw new Error(controls.cancel.reason);
  }
};

const readRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
};

const readProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown => {
  if (!(key in source)) {
    throw new Error(`${label} is required`);
  }

  return source[key];
};

const readRecordProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> =>
  readRecord(readProperty(source, key, label), label);

const readScenarioInput = (
  input: unknown,
  label: string
): Record<string, unknown> => {
  const envelope = readRecord(input, `${label}.input`);
  const scenario = readRecordProperty(
    envelope,
    "scenario",
    `${label}.input.scenario`
  );

  return scenario;
};

const readStringProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): string => {
  const value = readProperty(source, key, label);

  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  return value;
};

const readOperationScenario = (
  input: unknown,
  operation: string
): Record<string, unknown> => {
  const scenario = readScenarioInput(input, operation);
  const scenarioOperation = readStringProperty(
    scenario,
    "operation",
    `${operation}.scenario.operation`
  );

  if (scenarioOperation !== operation) {
    throw new Error(
      `${operation} scenario declared operation ${scenarioOperation}`
    );
  }

  return scenario;
};

const readArrayProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown[] => {
  const value = readProperty(source, key, label);

  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  return value;
};

const readJsonValue = (value: unknown, label: string): JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      readJsonValue(item, `${label}[${index}]`)
    );
  }

  const record = readRecord(value, label);
  const object: Record<string, JsonValue> = {};

  for (const [key, item] of Object.entries(record)) {
    object[key] = readJsonValue(item, `${label}.${key}`);
  }

  return object;
};

const readJsonObject = (
  value: unknown,
  label: string
): Record<string, JsonValue> => {
  const object = readJsonValue(value, label);
  if (object === null || Array.isArray(object) || typeof object !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return object;
};

const readJsonSchemaProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenJsonSchema => {
  const value = readProperty(source, key, label);

  if (typeof value === "boolean") {
    return value;
  }

  return readJsonObject(value, label);
};

const readBooleanProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): boolean => {
  const value = readProperty(source, key, label);

  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }

  return value;
};

const readResponseFormat = (
  value: unknown,
  label: string
): StructuredOutputRequest => {
  const record = readRecord(value, label);
  const schema = readJsonSchemaProperty(record, "schema", `${label}.schema`);
  const name =
    record.name === undefined
      ? undefined
      : readStringProperty(record, "name", `${label}.name`);
  const strict =
    record.strict === undefined
      ? undefined
      : readBooleanProperty(record, "strict", `${label}.strict`);

  return {
    ...(name === undefined ? {} : { name }),
    schema,
    ...(strict === undefined ? {} : { strict }),
  };
};

const readPromptProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenPrompt => {
  const value = readRecordProperty(source, key, label);
  const messages = readArrayProperty(value, "messages", `${label}.messages`);
  const promptMessages = messages.map((message, index) => {
    assertTuvrenMessage(message, `${label}.messages[${index}]`);
    return structuredClone(message);
  });
  const responseFormat =
    value.responseFormat === undefined
      ? undefined
      : readResponseFormat(value.responseFormat, `${label}.responseFormat`);

  return responseFormat === undefined
    ? { messages: promptMessages }
    : { messages: promptMessages, responseFormat };
};

const readModelResponseProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse => {
  const value = readRecordProperty(source, key, label);
  assertTuvrenModelResponse(value, label);
  return structuredClone(value);
};

const readModelResponseArrayProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse[] =>
  readArrayProperty(source, key, label).map((value, index) => {
    assertTuvrenModelResponse(value, `${label}[${index}]`);
    return structuredClone(value);
  });

const readFirstToolCallNameOptional = (
  responses: readonly TuvrenModelResponse[],
  _label: string
): string | undefined => {
  for (const response of responses) {
    for (const part of response.parts) {
      if (part.type === "tool_call") {
        return part.name;
      }
    }
  }

  return undefined;
};

const readFirstToolCallName = (
  responses: readonly TuvrenModelResponse[],
  label: string
): string => {
  const toolCallName = readFirstToolCallNameOptional(responses, label);

  if (toolCallName !== undefined) {
    return toolCallName;
  }

  throw new Error(`${label} must contain a tool_call part`);
};

const readProviderStreamChunks = (
  scenario: Record<string, unknown>,
  label: string
): ProviderStreamChunk[] => {
  const values = readArrayProperty(scenario, "streamChunks", label);
  return values.map((value, index) => {
    assertProviderStreamChunk(value, `${label}[${index}]`);
    return structuredClone(value);
  });
};

const readResponseFormatProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): StructuredOutputRequest =>
  readResponseFormat(readProperty(source, key, label), label);

const readScenarioToolCall = (
  record: Record<string, unknown>,
  label: string
): ScenarioToolCall => ({
  callId: readStringProperty(record, "callId", `${label}.callId`),
  input: readProperty(record, "input", `${label}.input`),
  name: readStringProperty(record, "name", `${label}.name`),
  output: record.output,
  requiresApproval:
    record.requiresApproval === undefined
      ? undefined
      : readBooleanProperty(
          record,
          "requiresApproval",
          `${label}.requiresApproval`
        ),
  throwMessage:
    record.throwMessage === undefined
      ? undefined
      : readStringProperty(record, "throwMessage", `${label}.throwMessage`),
});

const readScenarioToolCalls = (
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] =>
  readArrayProperty(scenario, "toolCalls", label).map((value, index) =>
    readScenarioToolCall(
      readRecord(value, `${label}[${index}]`),
      `${label}[${index}]`
    )
  );

const readPendingToolCalls = (
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] =>
  readArrayProperty(scenario, "pendingToolCalls", label).map((value, index) =>
    readScenarioToolCall(
      readRecord(value, `${label}[${index}]`),
      `${label}[${index}]`
    )
  );

const readApprovalDecisions = (
  scenario: Record<string, unknown>,
  label: string
): ApprovalDecision[] =>
  readArrayProperty(scenario, "approvalDecisions", label).map(
    (value, index) => {
      const record = readRecord(value, `${label}[${index}]`);
      return {
        callId: readStringProperty(
          record,
          "callId",
          `${label}[${index}].callId`
        ),
        ...(record.message === undefined
          ? {}
          : {
              message: readStringProperty(
                record,
                "message",
                `${label}[${index}].message`
              ),
            }),
        type: readStringProperty(record, "type", `${label}[${index}].type`),
      };
    }
  );

const readAssistantText = (
  messages: readonly unknown[],
  expectedText: string
): string | undefined => {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const { parts } = message;

    if (!Array.isArray(parts)) {
      continue;
    }

    for (const part of parts) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        part.text === expectedText
      ) {
        return expectedText;
      }
    }
  }

  return undefined;
};

const runnerScenarios = createFrameworkAdapterRunner({
  errorToEnvelope,
  readApprovalDecisions,
  readFirstToolCallNameOptional,
  readModelResponseArrayProperty,
  readOperationScenario,
  readPendingToolCalls,
  readProperty,
  readProviderStreamChunks,
  readStringProperty,
});

const orchestrationScenarios = createFrameworkAdapterOrchestration({
  createObservedErrorEnvelope: toObservedErrorEnvelope,
  isRecord,
  readOperationScenario,
  readRecordString,
  readStringProperty,
});

const eventStreamSseScenarios = createFrameworkAdapterEventStreamSse();
const eventStreamResumeScenarios = createFrameworkAdapterEventStreamResume();
const eventStreamWsScenarios = createFrameworkAdapterEventStreamWs();

const eventStreamScenarios = createFrameworkAdapterEventStream({
  isRecord,
  parseJsonValue,
  readApprovalDecisions,
  readFirstToolCallName,
  readModelResponseArrayProperty,
  readProperty,
  readRecordString,
  readScenarioInput,
  readStringProperty,
});

const batteriesIncludedScenarios = createFrameworkAdapterBatteriesIncluded();
const provingHostScenarios = createFrameworkAdapterProvingHost();
const schemaAuthoringScenarios = createFrameworkAdapterSchemaAuthoring();
const admissionKeyScenarios = createFrameworkAdapterAdmissionKeyScenarios({
  readOperationScenario,
  readStringProperty,
});
const runtimeScenarios = createFrameworkAdapterRuntimeScenarios({
  isRecord,
  readApprovalDecisions,
  readAssistantText,
  readFirstErrorEnvelope,
  readModelResponseArrayProperty,
  readModelResponseProperty,
  readOperationScenario,
  readPromptProperty,
  readProperty,
  readProviderStreamChunks,
  readRecordProperty,
  readRecordString,
  readResponseFormatProperty,
  readScenarioToolCall,
  readScenarioToolCalls,
  readStringProperty,
});

type OperationHandler = (
  input: unknown,
  controls: AdapterControls
) => AdapterProjection | Promise<AdapterProjection>;

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

const fromSingleSynchronousValue = <Value>(
  readValue: () => Value
): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: () => {
    let emitted = false;

    return {
      next: fromSynchronousWithoutArguments((): IteratorResult<Value> => {
        if (emitted) {
          return { done: true, value: undefined };
        }

        emitted = true;
        return { done: false, value: readValue() };
      }),
    };
  },
});

const fromSynchronousWithTwoArguments = <First, Second, Value>(
  operation: (first: First, second: Second) => Value
): ((first: First, second: Second) => Promise<Value>) =>
  Promise.try.bind<
    typeof Promise,
    [(first: First, second: Second) => Value],
    [First, Second],
    Promise<Value>
  >(Promise, operation);

const runCancelledRuntimeTurn: OperationHandler = async (_input, controls) =>
  await runtimeScenarios.runCancelledRuntimeTurn(controls);

const runCapabilityOrchestrationFoundationFromInput: OperationHandler = async (
  input
) =>
  await runCapabilityOrchestrationFoundation(
    readStringProperty(
      readOperationScenario(
        input,
        "runtime.capability-orchestration.foundation"
      ),
      "toolName",
      "runtime.capability-orchestration.foundation.toolName"
    )
  );

const OPERATION_HANDLERS = new Map<string, OperationHandler>([
  ["runtime.execute-turn", runtimeScenarios.runCompletedRuntimeTurn],
  ["runtime.cancel-execution", runCancelledRuntimeTurn],
  ["runtime.approval-resolve", runtimeScenarios.runApprovalResume],
  ["runtime.operational-telemetry", runtimeScenarios.runOperationalTelemetry],
  ["runtime.branch-create", runtimeScenarios.runBranchCreate],
  [
    "runtime.durable-read.list-threads",
    runtimeScenarios.runDurableReadListThreads,
  ],
  [
    "runtime.durable-read.list-threads-paginate",
    runtimeScenarios.runDurableReadListThreadsPaginate,
  ],
  [
    "runtime.durable-read.list-threads-capability-rejected",
    runtimeScenarios.runDurableReadListThreadsCapabilityRejected,
  ],
  [
    "runtime.durable-read.list-branches",
    runtimeScenarios.runDurableReadListBranches,
  ],
  [
    "runtime.durable-read.get-turn-state",
    runtimeScenarios.runDurableReadGetTurnState,
  ],
  [
    "runtime.durable-read.get-turn-state-lineage",
    runtimeScenarios.runDurableReadGetTurnStateLineage,
  ],
  [
    "runtime.durable-read.get-turn-history",
    runtimeScenarios.runDurableReadGetTurnHistory,
  ],
  [
    "runtime.durable-read.read-branch-messages",
    runtimeScenarios.runDurableReadReadBranchMessages,
  ],
  [
    "runtime.durable-read.read-branch-messages-head-drift",
    runtimeScenarios.runDurableReadReadBranchMessagesHeadDrift,
  ],
  ["runtime.handle-terminal-value", runtimeScenarios.runHandleTerminalValue],
  ["runtime.provider-generate", runtimeScenarios.runProviderGenerate],
  ["runtime.provider-stream", runtimeScenarios.runProviderStream],
  ["runtime.tool-execute", runtimeScenarios.runToolExecution],
  [
    "runtime.validate-structured-output",
    runtimeScenarios.runStructuredValidationFailure,
  ],
  ["runtime.context-transform", runtimeScenarios.runContextTransform],
  ["runtime.recover-result", runtimeScenarios.runRecoverResult],
  ["runtime.recover-stale-run", runtimeScenarios.runRecoverStaleRun],
  [
    "runtime.client-result-as-proposal",
    runtimeScenarios.runClientResultAsProposal,
  ],
  [
    "runtime.admission-key.crash-recovery",
    admissionKeyScenarios.runCrashRecovery,
  ],
  [
    "runtime.admission-key.provider-exclusion",
    admissionKeyScenarios.runProviderExclusion,
  ],
  [
    "runtime.admission-key.initial-input-recovery",
    admissionKeyScenarios.runInitialInputRecovery,
  ],
  [
    "runtime.admission-key.keyless-identity",
    admissionKeyScenarios.runKeylessIdentity,
  ],
  [
    "runtime.orchestration.launch-preconditions",
    orchestrationScenarios.runOrchestrationLaunchPreconditions,
  ],
  [
    "runtime.orchestration.lifecycle-locality",
    orchestrationScenarios.runOrchestrationLifecycleLocality,
  ],
  [
    "runtime.orchestration.event-surfaces",
    orchestrationScenarios.runOrchestrationEventSurfaces,
  ],
  [
    "runtime.orchestration.execution-inheritance",
    orchestrationScenarios.runOrchestrationExecutionInheritance,
  ],
  [
    "runtime.orchestration.nested-attribution",
    orchestrationScenarios.runOrchestrationNestedAttribution,
  ],
  [
    "runtime.batteries-included.lifecycle",
    batteriesIncludedScenarios.runBatteriesIncludedLifecycle,
  ],
  [
    "runtime.proving-host.headless-transcript-replay",
    provingHostScenarios.runHeadlessTranscriptReplay,
  ],
  [
    "runtime.schema-authoring.route",
    schemaAuthoringScenarios.runSchemaAuthoringRoute,
  ],
  [
    "runtime.schema-authoring.define-tool",
    schemaAuthoringScenarios.runSchemaAuthoringDefineTool,
  ],
  ["runner.execute", runnerScenarios.runRunnerExecute],
  ["runner.resume", runnerScenarios.runRunnerResume],
  ["runner.checkpoint", runnerScenarios.runRunnerCheckpoint],
  [
    "event-stream.runtime-agui-projection",
    eventStreamScenarios.runAgUiProjection,
  ],
  [
    "event-stream.runtime-sse-eager-subscription",
    eventStreamScenarios.runSseEagerSubscription,
  ],
  [
    "event-stream.runtime-sse-projection",
    eventStreamScenarios.runSseProjection,
  ],
  ["event-stream-sse.decode-trace", eventStreamSseScenarios.runDecodeTrace],
  [
    "event-stream-sse.report-wire-compliance",
    eventStreamSseScenarios.runReportWireCompliance,
  ],
  [
    "event-stream-resume.replay-scenario",
    eventStreamResumeScenarios.runReplayScenario,
  ],
  [
    "event-stream-resume.sse-reconnect",
    eventStreamResumeScenarios.runSseReconnect,
  ],
  [
    "runtime.capability-orchestration.foundation",
    runCapabilityOrchestrationFoundationFromInput,
  ],
  [
    "runtime.capability-orchestration.policy-decisions",
    runCapabilityOrchestrationPolicyDecisions,
  ],
  [
    "runtime.capability-orchestration.integration",
    runCapabilityOrchestrationIntegration,
  ],
  [
    "runtime.invocation-lifecycle.cross-class",
    runInvocationLifecycleCrossClass,
  ],
  ["runtime.execution-bounds.max-iterations", runExecutionBoundsMaxIterations],
  ["runtime.execution-bounds.max-tool-calls", runExecutionBoundsMaxToolCalls],
  ["runtime.execution-bounds.max-wall-clock", runExecutionBoundsMaxWallClock],
  [
    "runtime.execution-bounds.wall-clock-signal-delivery",
    runExecutionBoundsWallClockSignalDelivery,
  ],
  [
    "runtime.execution-bounds.concurrency-throttle",
    runExecutionBoundsConcurrencyThrottle,
  ],
  ["runtime.execution-bounds.invalid-config", runExecutionBoundsInvalidConfig],
  ["runtime.execution-bounds.within-bounds", runExecutionBoundsWithinBounds],
  ["runtime.secret-isolation.surfaces", runSecretIsolationRuntimeApi],
  ["runtime.secret-isolation.telemetry", runSecretIsolationTelemetry],
  [
    "runtime.secret-isolation.provider-bridge",
    runSecretIsolationProviderBridge,
  ],
  ["runtime.sanitize-seam.tool-result", runSanitizeSeamToolResult],
  ["runtime.scope-isolation.surfaces", runScopeIsolationSurfaces],
  [
    "runtime.trust-boundary.approval-gate",
    runTrustBoundaryApprovalNonBypassable,
  ],
  ["runtime.trust-boundary.local-tool-input", runTrustBoundaryLocalToolInput],
  ["runtime.tuvren-client.lifecycle", runTuvrenClientLifecycle],
  [
    "runtime.tuvren-client.network-reconnect-redelivery",
    runTuvrenClientNetworkReconnectRedelivery,
  ],
  ["runtime.tuvren-client.result-durability", runTuvrenClientResultDurability],
  ["runtime.tuvren-server.lifecycle", runTuvrenServerLifecycle],
  [
    "runtime.tuvren-server.binding-classification",
    runTuvrenServerBindingClassification,
  ],
  ["runtime.tuvren-server.cancellation", runTuvrenServerCancellation],
  ["runtime.tuvren-server.tenant-isolation", runTuvrenServerTenantIsolation],
  [
    "runtime.capability-policy.exposure-dimensions",
    runCapabilityPolicyExposureDimensions,
  ],
  [
    "runtime.capability-policy.invocation-dimensions",
    runCapabilityPolicyInvocationDimensions,
  ],
  ["runtime.capability-policy.composition", runCapabilityPolicyComposition],
  [
    "runtime.capability-policy.wired-invocation-denial",
    runCapabilityPolicyWiredInvocationDenial,
  ],
  [
    "runtime.capability-policy.nonretryable-policy",
    runCapabilityPolicyNonretryablePolicy,
  ],
  [
    "runtime.capability-policy.wired-risk-approval",
    runCapabilityPolicyWiredRiskApproval,
  ],
  ["host-session.stale-client-result", runStaleClientResult],
  ["host-session.approval-response-resume", runApprovalResponseResume],
  ["host-session.cancel-cooperative", runCancelCooperative],
  ["host-session.cancel-while-paused", runCancelWhilePaused],
  ["host-session.validate-frame-fixtures", runValidateFrameFixtures],
  ["host-session.reattach-redelivery", runReattachRedelivery],
  ["host-session.grace-window-expiry", runGraceWindowExpiry],
  ["host-session.dispatch-timeout", runDispatchTimeout],
  ["host-session.sequence-continuity", runSequenceContinuity],
  ["host-session.admission-key-steer-carriage", runAdmissionKeySteerCarriage],
  ["event-stream-ws.decode-trace", eventStreamWsScenarios.runDecodeTrace],
  [
    "event-stream-ws.session-roundtrip",
    eventStreamWsScenarios.runSessionRoundtrip,
  ],
  [
    "event-stream-ws.reconnect-with-cursor",
    eventStreamWsScenarios.runReconnectWithCursor,
  ],
  [
    "event-stream-ws.handshake-rejections",
    eventStreamWsScenarios.runHandshakeRejections,
  ],
  ["event-stream-ws.policy-closures", eventStreamWsScenarios.runPolicyClosures],
]);

const projectOperation = async (
  operation: string,
  input: unknown,
  controls: AdapterControls
): Promise<AdapterProjection> => {
  const handler = OPERATION_HANDLERS.get(operation);
  if (handler === undefined) {
    throw new Error(`unsupported promoted framework operation ${operation}`);
  }
  return await handler(input, controls);
};

export class TypeScriptFrameworkAdapter implements ImplementationAdapter {
  private capabilities?: AdapterCapabilities;
  private readonly observations = new Map<string, OperationObservation>();
  private latestState: Record<string, unknown> | null = null;

  async dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<OperationOutcome> {
    this.requireInitialized();
    throwIfCancelled(controls);

    try {
      const projection = await projectOperation(operation, input, controls);
      const status = projectionStatus(projection);
      this.latestState = projection.state ?? null;
      this.observations.set(operation, {
        adapterEvents: 0,
        initialized: true,
        status,
      });

      return {
        kind: "result",
        value: projection,
      };
    } catch (error: unknown) {
      const envelope = createAdapterErrorEnvelope(error);
      this.latestState = {
        adapterError: envelope,
      };
      this.observations.set(operation, {
        adapterEvents: 0,
        initialized: true,
        status: "failed",
      });

      return {
        error: envelope,
        kind: "error",
      };
    }
  }

  events(
    operation: string,
    _input: unknown,
    controls: AdapterControls
  ): AsyncIterable<unknown> {
    return fromSingleSynchronousValue(() => {
      this.requireInitialized();
      throwIfCancelled(controls);

      const observation = this.observations.get(operation);
      const event = {
        operation,
        status: observation?.status ?? "completed",
        type: "adapter.operation.observed",
      };

      if (observation !== undefined) {
        this.observations.set(operation, {
          ...observation,
          adapterEvents: observation.adapterEvents + 1,
        });
      }

      return event;
    });
  }

  initialize = fromSynchronousWithTwoArguments(
    (packetId: string, planVersion: string): AdapterCapabilities =>
      this.setCapabilities({
        adapterId: "typescript-framework",
        capabilities: [
          "framework.runner-api",
          "framework.event-stream",
          "framework.event-stream-sse",
          "framework.event-stream-resume",
          "framework.host-session",
          "framework.event-stream-ws",
          "framework.orchestration",
          "framework.run-liveness",
          "framework.react-runner",
          "framework.runtime-api",
          "framework.tool-contracts",
          "providers.framework-owned-approval-boundary",
          "providers.framework-owned-tool-execution",
          "providers.rejects-native-strict-structured-output",
        ],
        packetId,
        planVersion,
      })
  );

  inspectState = fromSynchronous((query: unknown): unknown => {
    if (!isRecord(query) || typeof query.operation !== "string") {
      return this.latestState;
    }

    const observation = this.observations.get(query.operation);

    return {
      ...this.latestState,
      adapter: observation,
    };
  });

  shutdown = fromSynchronousWithoutArguments((): void => {
    this.capabilities = undefined;
    this.latestState = null;
    this.observations.clear();
  });

  protected setCapabilities(
    capabilities: AdapterCapabilities
  ): AdapterCapabilities {
    this.capabilities = capabilities;
    return capabilities;
  }

  private requireInitialized(): AdapterCapabilities {
    if (this.capabilities === undefined) {
      throw new Error("implementation adapter must be initialized first");
    }

    return this.capabilities;
  }
}

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
