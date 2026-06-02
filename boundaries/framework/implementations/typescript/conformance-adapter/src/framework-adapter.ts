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
  type ProviderStreamChunk,
} from "@tuvren/provider-api";
import {
  type AdapterCapabilities,
  type AdapterControls,
  createAdapterErrorEnvelope,
  type OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createFrameworkAdapterBatteriesIncluded } from "./framework-adapter-batteries-included.ts";
import {
  runCapabilityOrchestrationFoundation,
  runCapabilityOrchestrationPolicyDecisions,
} from "./framework-adapter-capability-orchestration.ts";
import { createFrameworkAdapterDriver } from "./framework-adapter-driver.ts";
import { createFrameworkAdapterEventStream } from "./framework-adapter-event-stream.ts";
import { createFrameworkAdapterEventStreamSse } from "./framework-adapter-event-stream-sse.ts";
import { createFrameworkAdapterOrchestration } from "./framework-adapter-orchestration.ts";
import { createFrameworkAdapterProvingHost } from "./framework-adapter-proving-host.ts";
import type {
  AdapterProjection,
  ScenarioToolCall,
} from "./framework-adapter-runtime.ts";
import { createFrameworkAdapterRuntimeScenarios } from "./framework-adapter-runtime-scenarios.ts";
import { createFrameworkAdapterSchemaAuthoring } from "./framework-adapter-schema-authoring.ts";
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
} from "../../../../../../tools/conformance/adapter-protocol/index.js";

export interface ImplementationAdapter {
  dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<OperationOutcome>;
  events(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): AsyncIterable<unknown>;
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities>;
  inspectState?(query: unknown): Promise<unknown | null>;
  shutdown(): Promise<void>;
}

interface OperationObservation {
  adapterEvents: number;
  initialized: boolean;
  status: OperationStatus;
}

type OperationStatus = "completed" | "failed" | "paused";

const driverScenarios = createFrameworkAdapterDriver({
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
      const projection = await this.projectOperation(
        operation,
        input,
        controls
      );
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

  async *events(
    operation: string,
    _input: unknown,
    controls: AdapterControls
  ): AsyncIterable<unknown> {
    await Promise.resolve();
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

    yield event;
  }

  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    this.capabilities = {
      adapterId: "typescript-framework",
      capabilities: [
        "framework.driver-api",
        "framework.event-stream",
        "framework.event-stream-sse",
        "framework.orchestration",
        "framework.run-liveness",
        "framework.react-driver",
        "framework.runtime-api",
        "framework.tool-contracts",
        "providers.framework-owned-approval-boundary",
        "providers.framework-owned-tool-execution",
        "providers.rejects-native-strict-structured-output",
      ],
      packetId,
      planVersion,
    };
    return Promise.resolve(this.capabilities);
  }

  inspectState(query: unknown): Promise<unknown | null> {
    if (!isRecord(query) || typeof query.operation !== "string") {
      return Promise.resolve(this.latestState);
    }

    const observation = this.observations.get(query.operation);

    return Promise.resolve({
      ...(this.latestState ?? {}),
      adapter: observation,
    });
  }

  shutdown(): Promise<void> {
    this.capabilities = undefined;
    this.latestState = null;
    this.observations.clear();
    return Promise.resolve();
  }

  private requireInitialized(): AdapterCapabilities {
    if (this.capabilities === undefined) {
      throw new Error("implementation adapter must be initialized first");
    }

    return this.capabilities;
  }

  private projectOperation(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<AdapterProjection> {
    // This switch is language-local adapter routing only; shared plans own the
    // assertions and expected semantics, and this file must only measure TS behavior.
    switch (operation) {
      case "runtime.execute-turn":
        return runtimeScenarios.runCompletedRuntimeTurn(input);
      case "runtime.cancel-execution":
        return runtimeScenarios.runCancelledRuntimeTurn(controls);
      case "runtime.approval-resolve":
        return runtimeScenarios.runApprovalResume(input);
      case "runtime.operational-telemetry":
        return runtimeScenarios.runOperationalTelemetry(input);
      case "runtime.branch-create":
        return runtimeScenarios.runBranchCreate();
      case "runtime.durable-read.list-threads":
        return runtimeScenarios.runDurableReadListThreads();
      case "runtime.durable-read.list-threads-paginate":
        return runtimeScenarios.runDurableReadListThreadsPaginate();
      case "runtime.durable-read.list-threads-capability-rejected":
        return runtimeScenarios.runDurableReadListThreadsCapabilityRejected();
      case "runtime.durable-read.list-branches":
        return runtimeScenarios.runDurableReadListBranches();
      case "runtime.durable-read.get-turn-state":
        return runtimeScenarios.runDurableReadGetTurnState();
      case "runtime.durable-read.get-turn-state-lineage":
        return runtimeScenarios.runDurableReadGetTurnStateLineage();
      case "runtime.durable-read.get-turn-history":
        return runtimeScenarios.runDurableReadGetTurnHistory();
      case "runtime.durable-read.read-branch-messages":
        return runtimeScenarios.runDurableReadReadBranchMessages();
      case "runtime.durable-read.read-branch-messages-head-drift":
        return runtimeScenarios.runDurableReadReadBranchMessagesHeadDrift();
      case "runtime.handle-terminal-value":
        return runtimeScenarios.runHandleTerminalValue(input);
      case "runtime.provider-generate":
        return runtimeScenarios.runProviderGenerate(input);
      case "runtime.provider-stream":
        return runtimeScenarios.runProviderStream(input);
      case "runtime.tool-execute":
        return runtimeScenarios.runToolExecution(input);
      case "runtime.validate-structured-output":
        return runtimeScenarios.runStructuredValidationFailure(input);
      case "runtime.context-transform":
        return runtimeScenarios.runContextTransform(input);
      case "runtime.recover-result":
        return runtimeScenarios.runRecoverResult(input);
      case "runtime.recover-stale-run":
        return runtimeScenarios.runRecoverStaleRun(input);
      case "runtime.orchestration.launch-preconditions":
        return orchestrationScenarios.runOrchestrationLaunchPreconditions(
          input
        );
      case "runtime.orchestration.lifecycle-locality":
        return orchestrationScenarios.runOrchestrationLifecycleLocality(input);
      case "runtime.orchestration.event-surfaces":
        return orchestrationScenarios.runOrchestrationEventSurfaces(input);
      case "runtime.orchestration.execution-inheritance":
        return orchestrationScenarios.runOrchestrationExecutionInheritance(
          input
        );
      case "runtime.orchestration.nested-attribution":
        return orchestrationScenarios.runOrchestrationNestedAttribution(input);
      case "runtime.batteries-included.lifecycle":
        return batteriesIncludedScenarios.runBatteriesIncludedLifecycle(input);
      case "runtime.proving-host.headless-transcript-replay":
        return provingHostScenarios.runHeadlessTranscriptReplay(input);
      case "runtime.schema-authoring.route":
        return schemaAuthoringScenarios.runSchemaAuthoringRoute(input);
      case "runtime.schema-authoring.define-tool":
        return schemaAuthoringScenarios.runSchemaAuthoringDefineTool(input);
      case "driver.execute":
        return driverScenarios.runDriverExecute(input);
      case "driver.resume":
        return driverScenarios.runDriverResume(input);
      case "driver.checkpoint":
        return driverScenarios.runDriverCheckpoint(input);
      case "event-stream.runtime-agui-projection":
        return eventStreamScenarios.runAgUiProjection(input);
      case "event-stream.runtime-sse-eager-subscription":
        return eventStreamScenarios.runSseEagerSubscription(input);
      case "event-stream.runtime-sse-projection":
        return eventStreamScenarios.runSseProjection(input);
      case "event-stream-sse.decode-trace":
        return eventStreamSseScenarios.runDecodeTrace(input);
      case "event-stream-sse.report-wire-compliance":
        return eventStreamSseScenarios.runReportWireCompliance(input);
      case "runtime.capability-orchestration.foundation":
        return runCapabilityOrchestrationFoundation(
          readStringProperty(
            readOperationScenario(
              input,
              "runtime.capability-orchestration.foundation"
            ),
            "toolName",
            "runtime.capability-orchestration.foundation.toolName"
          )
        );
      case "runtime.capability-orchestration.policy-decisions":
        return runCapabilityOrchestrationPolicyDecisions();
      case "runtime.tuvren-server.lifecycle":
        return runTuvrenServerLifecycle();
      case "runtime.tuvren-server.binding-classification":
        return runTuvrenServerBindingClassification();
      case "runtime.tuvren-server.cancellation":
        return runTuvrenServerCancellation();
      case "runtime.tuvren-server.tenant-isolation":
        return runTuvrenServerTenantIsolation();
      default:
        throw new Error(
          `unsupported promoted framework operation ${operation}`
        );
    }
  }
}

function toObservedErrorEnvelope(error: unknown): Record<string, unknown> {
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
}

function readFirstErrorEnvelope(
  events: readonly unknown[]
): Record<string, unknown> | undefined {
  for (const event of events) {
    if (isRecord(event) && isRecord(event.error)) {
      return event.error;
    }
  }

  return undefined;
}

function errorToEnvelope(error: Error): Record<string, unknown> {
  const errorRecord: Record<string, unknown> = isRecord(error) ? error : {};
  const code =
    typeof errorRecord.code === "string" ? errorRecord.code : "driver_error";
  const envelope: Record<string, unknown> = {
    code,
    message: error.message,
  };

  if (errorRecord.details !== undefined) {
    envelope.details = errorRecord.details;
  }

  return envelope;
}

function readRecordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function parseJsonValue(value: string): unknown {
  return JSON.parse(value);
}

function projectionStatus(projection: AdapterProjection): OperationStatus {
  if (isRecord(projection.result) && projection.result.error !== undefined) {
    return "failed";
  }

  return "completed";
}

function throwIfCancelled(controls: AdapterControls): void {
  if (controls.cancel !== undefined) {
    throw new Error(controls.cancel.reason);
  }
}

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function readOperationScenario(
  input: unknown,
  operation: string
): Record<string, unknown> {
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
}

function readScenarioInput(
  input: unknown,
  label: string
): Record<string, unknown> {
  const envelope = readRecord(input, `${label}.input`);
  const scenario = readRecordProperty(
    envelope,
    "scenario",
    `${label}.input.scenario`
  );

  return scenario;
}

function readPromptProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenPrompt {
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
}

function readModelResponseProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse {
  const value = readRecordProperty(source, key, label);
  assertTuvrenModelResponse(value, label);
  return structuredClone(value);
}

function readModelResponseArrayProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse[] {
  return readArrayProperty(source, key, label).map((value, index) => {
    assertTuvrenModelResponse(value, `${label}[${index}]`);
    return structuredClone(value);
  });
}

function readFirstToolCallName(
  responses: readonly TuvrenModelResponse[],
  label: string
): string {
  const toolCallName = readFirstToolCallNameOptional(responses, label);

  if (toolCallName !== undefined) {
    return toolCallName;
  }

  throw new Error(`${label} must contain a tool_call part`);
}

function readFirstToolCallNameOptional(
  responses: readonly TuvrenModelResponse[],
  _label: string
): string | undefined {
  for (const response of responses) {
    for (const part of response.parts) {
      if (part.type === "tool_call") {
        return part.name;
      }
    }
  }

  return undefined;
}

function readProviderStreamChunks(
  scenario: Record<string, unknown>,
  label: string
): ProviderStreamChunk[] {
  const values = readArrayProperty(scenario, "streamChunks", label);
  return values.map((value, index) => {
    assertProviderStreamChunk(value, `${label}[${index}]`);
    return structuredClone(value);
  });
}

function readResponseFormatProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): StructuredOutputRequest {
  return readResponseFormat(readProperty(source, key, label), label);
}

function readResponseFormat(
  value: unknown,
  label: string
): StructuredOutputRequest {
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
}

function readScenarioToolCalls(
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] {
  return readArrayProperty(scenario, "toolCalls", label).map((value, index) =>
    readScenarioToolCall(
      readRecord(value, `${label}[${index}]`),
      `${label}[${index}]`
    )
  );
}

function readScenarioToolCall(
  record: Record<string, unknown>,
  label: string
): ScenarioToolCall {
  return {
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
  };
}

function readPendingToolCalls(
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] {
  return readArrayProperty(scenario, "pendingToolCalls", label).map(
    (value, index) =>
      readScenarioToolCall(
        readRecord(value, `${label}[${index}]`),
        `${label}[${index}]`
      )
  );
}

function readApprovalDecisions(
  scenario: Record<string, unknown>,
  label: string
): ApprovalDecision[] {
  return readArrayProperty(scenario, "approvalDecisions", label).map(
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
}

function readAssistantText(
  messages: readonly unknown[],
  expectedText: string
): string | undefined {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const parts = message.parts;

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
}

function readJsonSchemaProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenJsonSchema {
  const value = readProperty(source, key, label);

  if (typeof value === "boolean") {
    return value;
  }

  return readJsonObject(value, label);
}

function readArrayProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown[] {
  const value = readProperty(source, key, label);

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function readRecordProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> {
  return readRecord(readProperty(source, key, label), label);
}

function readStringProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = readProperty(source, key, label);

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function readBooleanProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): boolean {
  const value = readProperty(source, key, label);

  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function readProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown {
  if (!(key in source)) {
    throw new Error(`${label} is required`);
  }

  return source[key];
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function readJsonValue(value: unknown, label: string): JsonValue {
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

  return readJsonObject(value, label);
}

function readJsonObject(
  value: unknown,
  label: string
): { [key: string]: JsonValue } {
  const record = readRecord(value, label);
  const object: { [key: string]: JsonValue } = {};

  for (const [key, item] of Object.entries(record)) {
    object[key] = readJsonValue(item, `${label}.${key}`);
  }

  return object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
