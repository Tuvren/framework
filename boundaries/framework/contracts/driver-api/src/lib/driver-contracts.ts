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

import type { EpochMs, HashString } from "@tuvren/core-types";
import { TuvrenValidationError } from "@tuvren/core-types";
import type { TuvrenStreamEvent } from "@tuvren/runtime-api/events";
import type {
  AgentConfig,
  ContextManifest,
  HandoffContextBuilder,
  HandoffContextMode,
  HandoffContextPlan,
  HandoffSourceContext,
  RuntimeResolution,
  TuvrenMessage,
} from "@tuvren/runtime-api/execution";
import {
  assertContextManifest,
  assertTuvrenMessage,
} from "@tuvren/runtime-api/execution";
import type { ApprovalResponse, ToolRegistry } from "@tuvren/runtime-api/tools";
import {
  assertApprovalRequest,
  assertTuvrenToolDefinition,
} from "@tuvren/runtime-api/tools";

export interface DriverRuntimePort {
  emit(event: TuvrenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

export interface DriverHandoffPort {
  createContextPlan(input: {
    builder?: HandoffContextBuilder;
    mode?: HandoffContextMode;
    payload?: unknown;
    reason: string;
    targetAgent: string;
  }): HandoffContextPlan;
}

// This is the shared driver boundary, not a convenience bag for one concrete
// driver. New fields here are shared-core contract changes and should only land
// when the framework spec proves they belong below every future driver.
export interface DriverExecutionContext {
  branchId: string;
  config: Readonly<AgentConfig>;
  handoff: DriverHandoffPort;
  iterationCount: number;
  manifest: Readonly<ContextManifest>;
  messages: readonly TuvrenMessage[];
  runtime: DriverRuntimePort;
  schemaId: string;
  signal?: AbortSignal;
  threadId: string;
  toolRegistry: Readonly<ToolRegistry>;
  turnId: string;
}

export interface DriverResumeContext extends DriverExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

export type DriverToolExecutionMode = "parallel" | "sequential";

export type DriverAssistantEventReconciliation =
  "allow_final_sequence_divergence";

export interface DriverExtensionStateUpdate {
  extensionName: string;
  state: Record<string, unknown>;
}

// Keep the result seam intentionally minimal. If a future need cannot be
// expressed through resolution/messages/partial/toolExecutionMode/stateUpdates/
// assistantEventReconciliation,
// treat that as a spec discussion rather than extending the shared contract
// casually.
export interface DriverExecutionResult {
  assistantEventReconciliation?: DriverAssistantEventReconciliation;
  messages?: TuvrenMessage[];
  partial?: boolean;
  resolution: RuntimeResolution;
  stateUpdates?: DriverExtensionStateUpdate[];
  toolExecutionMode?: DriverToolExecutionMode;
}

export interface RuntimeDriver {
  execute(context: DriverExecutionContext): Promise<DriverExecutionResult>;
  readonly id: string;
  resume?(context: DriverResumeContext): Promise<DriverExecutionResult>;
}

export interface RuntimeDriverFactory {
  create(): RuntimeDriver;
  readonly id: string;
}

export interface DriverRegistry {
  list(): Array<RuntimeDriver | RuntimeDriverFactory>;
  register(driver: RuntimeDriver | RuntimeDriverFactory): void;
  resolve(driverId: string): RuntimeDriver | RuntimeDriverFactory | undefined;
}

const DRIVER_RESULT_KEYS = new Set([
  "assistantEventReconciliation",
  "messages",
  "partial",
  "resolution",
  "stateUpdates",
  "toolExecutionMode",
]);
const EXTENSION_STATE_UPDATE_KEYS = new Set(["extensionName", "state"]);
const CONTINUE_RESOLUTION_KEYS = new Set(["type"]);
const END_TURN_RESOLUTION_KEYS = new Set(["reason", "type"]);
const PAUSE_RESOLUTION_KEYS = new Set(["approval", "reason", "type"]);
const HANDOFF_RESOLUTION_KEYS = new Set(["contextPlan", "targetAgent", "type"]);
const FAIL_RESOLUTION_KEYS = new Set(["error", "fatality", "type"]);
const AGENT_CONFIG_KEYS = new Set([
  "contextPolicy",
  "extensions",
  "loopPolicy",
  "maxIterations",
  "model",
  "name",
  "responseFormat",
  "systemPrompt",
  "tools",
]);
const EXTENSION_KEYS = new Set([
  "afterIteration",
  "afterTurn",
  "aroundModel",
  "aroundTool",
  "beforeIteration",
  "beforeTurn",
  "exports",
  "name",
  "state",
  "systemPrompt",
  "timeout",
  "tools",
]);
const STRUCTURED_OUTPUT_REQUEST_KEYS = new Set(["name", "schema", "strict"]);
const CONTEXT_POLICY_KEYS = new Set(["evaluate"]);
const LOOP_POLICY_KEYS = new Set(["evaluate"]);

export function isRuntimeDriver(value: unknown): value is RuntimeDriver {
  // Driver installation guards stay structural on purpose. Verifying execute
  // or resume result semantics would require invoking arbitrary plugin code,
  // so runtime-core validates the returned data at the call boundary instead.
  return safePredicate(
    () =>
      value !== null &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      value.id.trim().length > 0 &&
      "execute" in value &&
      typeof value.execute === "function" &&
      (!("resume" in value) || typeof value.resume === "function")
  );
}

export function assertRuntimeDriver(
  value: unknown,
  label = "value"
): asserts value is RuntimeDriver {
  if (!isRuntimeDriver(value)) {
    throw new TuvrenValidationError(`${label} must be a valid RuntimeDriver`, {
      code: "invalid_driver_contract",
      details: value,
    });
  }
}

export function assertDriverExecutionResult(
  value: unknown,
  label = "value"
): asserts value is DriverExecutionResult {
  if (
    !isRecord(value) ||
    ("partial" in value && typeof value.partial !== "boolean")
  ) {
    throw new TuvrenValidationError(
      `${label} must include only valid optional driver metadata fields`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (
    "assistantEventReconciliation" in value &&
    value.assistantEventReconciliation !== undefined &&
    value.assistantEventReconciliation !== "allow_final_sequence_divergence"
  ) {
    throw new TuvrenValidationError(
      `${label}.assistantEventReconciliation must be "allow_final_sequence_divergence" when provided`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (
    "toolExecutionMode" in value &&
    value.toolExecutionMode !== undefined &&
    value.toolExecutionMode !== "parallel" &&
    value.toolExecutionMode !== "sequential"
  ) {
    throw new TuvrenValidationError(
      `${label}.toolExecutionMode must be "parallel" or "sequential"`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  assertDriverStateUpdates(value.stateUpdates, `${label}.stateUpdates`);
  assertDriverMessages(value, label);

  assertOnlyAllowedKeys(value, DRIVER_RESULT_KEYS, label);

  assertDriverRuntimeResolution(value.resolution, `${label}.resolution`);
  assertDriverPartialResult(
    {
      messages: Array.isArray(value.messages) ? value.messages : undefined,
      partial: value.partial === true,
      resolution: value.resolution,
    },
    `${label}`
  );
  const toolExecutionMode =
    value.toolExecutionMode === "parallel" ||
    value.toolExecutionMode === "sequential"
      ? value.toolExecutionMode
      : undefined;
  assertDriverToolExecutionMode(
    {
      messages: Array.isArray(value.messages) ? value.messages : undefined,
      toolExecutionMode,
    },
    `${label}`
  );
  assertDriverResolutionCompatibility(
    {
      assistantEventReconciliation:
        value.assistantEventReconciliation === "allow_final_sequence_divergence"
          ? value.assistantEventReconciliation
          : undefined,
      messages: Array.isArray(value.messages) ? value.messages : undefined,
      partial: value.partial === true,
      resolution: value.resolution,
    },
    `${label}`
  );
}

export function assertDriverRuntimeResolution(
  value: unknown,
  label = "value"
): asserts value is RuntimeResolution {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TuvrenValidationError(`${label} must be a valid resolution`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  switch (value.type) {
    case "continue_iteration":
      assertOnlyAllowedKeys(value, CONTINUE_RESOLUTION_KEYS, label);
      return;
    case "end_turn":
      if (typeof value.reason === "string") {
        assertOnlyAllowedKeys(value, END_TURN_RESOLUTION_KEYS, label);
        return;
      }
      break;
    case "pause":
      if (typeof value.reason === "string" && "approval" in value) {
        assertApprovalRequest(value.approval, `${label}.approval`);
        assertOnlyAllowedKeys(value, PAUSE_RESOLUTION_KEYS, label);
        return;
      }
      break;
    case "handoff":
      if (typeof value.targetAgent === "string") {
        assertDriverHandoffContextPlan(
          value.contextPlan,
          `${label}.contextPlan`
        );
        assertOnlyAllowedKeys(value, HANDOFF_RESOLUTION_KEYS, label);

        if (value.contextPlan.targetAgent !== value.targetAgent) {
          throw new TuvrenValidationError(
            `${label}.targetAgent must match ${label}.contextPlan.targetAgent`,
            {
              code: "invalid_driver_result",
              details: {
                contextPlanTargetAgent: value.contextPlan.targetAgent,
                resolutionTargetAgent: value.targetAgent,
              },
            }
          );
        }

        return;
      }
      break;
    case "fail":
      if (
        value.error instanceof Error &&
        (value.fatality === "hard" || value.fatality === "soft")
      ) {
        assertOnlyAllowedKeys(value, FAIL_RESOLUTION_KEYS, label);
        return;
      }
      break;
    default:
      break;
  }

  throw new TuvrenValidationError(`${label} must be a valid resolution`, {
    code: "invalid_driver_result",
    details: value,
  });
}

export function assertDriverHandoffContextPlan(
  value: unknown,
  label = "value"
): asserts value is HandoffContextPlan {
  if (
    !isRecord(value) ||
    typeof value.targetAgent !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.builder !== "function" ||
    !isRecord(value.sourceContext)
  ) {
    throw new TuvrenValidationError(`${label} must be a valid handoff plan`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  assertDriverHandoffSourceContext(
    value.sourceContext,
    `${label}.sourceContext`
  );

  if (value.sourceContext.handoffIntent.targetAgent !== value.targetAgent) {
    throw new TuvrenValidationError(
      `${label}.sourceContext.handoffIntent.targetAgent must match ${label}.targetAgent`,
      {
        code: "invalid_driver_result",
        details: {
          contextPlanTargetAgent: value.targetAgent,
          sourceContextTargetAgent:
            value.sourceContext.handoffIntent.targetAgent,
        },
      }
    );
  }

  if (value.sourceContext.targetAgent.name !== value.targetAgent) {
    throw new TuvrenValidationError(
      `${label}.sourceContext.targetAgent.name must match ${label}.targetAgent`,
      {
        code: "invalid_driver_result",
        details: {
          contextPlanTargetAgent: value.targetAgent,
          sourceContextTargetAgent: value.sourceContext.targetAgent.name,
        },
      }
    );
  }
}

export function assertDriverHandoffSourceContext(
  value: unknown,
  label = "value"
): asserts value is HandoffSourceContext {
  if (!isRecord(value)) {
    throw new TuvrenValidationError(`${label} must be a valid handoff source`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  if (!Array.isArray(value.messages)) {
    throw new TuvrenValidationError(`${label}.messages must be an array`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const [index, message] of value.messages.entries()) {
    assertTuvrenMessage(message, `${label}.messages[${index}]`);
  }

  assertContextManifest(value.manifest, `${label}.manifest`);

  if (
    !isRecord(value.handoffIntent) ||
    typeof value.handoffIntent.targetAgent !== "string" ||
    !isRecord(value.helpers) ||
    typeof value.helpers.loadMessage !== "function" ||
    typeof value.helpers.storeMessage !== "function" ||
    typeof value.helpers.storeMessages !== "function"
  ) {
    throw new TuvrenValidationError(`${label} must be a valid handoff source`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  assertDriverAgentConfigSnapshot(value.sourceAgent, `${label}.sourceAgent`);
  assertDriverAgentConfigSnapshot(value.targetAgent, `${label}.targetAgent`);
}

function safePredicate(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function assertDriverMessage(message: TuvrenMessage, label: string): void {
  if (message.role !== "assistant") {
    throw new TuvrenValidationError(`${label} must be an assistant message`, {
      code: "invalid_driver_result",
      details: message,
    });
  }

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "tool_result") {
      throw new TuvrenValidationError(
        `${label}.parts[${index}] must not be a tool_result`,
        {
          code: "invalid_driver_result",
          details: part,
        }
      );
    }
  }
}

function assertDriverMessages(
  value: Record<string, unknown>,
  label: string
): void {
  if (!("messages" in value) || value.messages === undefined) {
    return;
  }

  if (!Array.isArray(value.messages)) {
    throw new TuvrenValidationError(`${label}.messages must be an array`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const [index, message] of value.messages.entries()) {
    assertTuvrenMessage(message, `${label}.messages[${index}]`);
    assertDriverMessage(message, `${label}.messages[${index}]`);
  }

  if (value.messages.length > 1) {
    throw new TuvrenValidationError(
      `${label}.messages must not contain more than one assistant message`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
}

function assertDriverPartialResult(
  value: {
    messages?: TuvrenMessage[];
    partial: boolean;
    resolution: RuntimeResolution;
  },
  label: string
): void {
  if (!value.partial) {
    return;
  }

  if (value.resolution.type !== "fail") {
    throw new TuvrenValidationError(
      `${label}.partial is only valid for failed execution results`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (!value.messages?.some((message) => message.role === "assistant")) {
    throw new TuvrenValidationError(
      `${label}.partial requires a staged assistant message`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
}

function assertDriverToolExecutionMode(
  value: {
    messages?: TuvrenMessage[];
    toolExecutionMode?: DriverToolExecutionMode;
  },
  label: string
): void {
  const requestedToolCalls = hasRequestedToolCalls(value.messages);

  if (requestedToolCalls && value.toolExecutionMode === undefined) {
    throw new TuvrenValidationError(
      `${label}.toolExecutionMode is required when driver messages request tool calls`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (!requestedToolCalls && value.toolExecutionMode !== undefined) {
    throw new TuvrenValidationError(
      `${label}.toolExecutionMode is only valid when driver messages request tool calls`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
}

function assertDriverResolutionCompatibility(
  value: {
    assistantEventReconciliation?: DriverAssistantEventReconciliation;
    messages?: TuvrenMessage[];
    partial: boolean;
    resolution: RuntimeResolution;
  },
  label: string
): void {
  const requestedToolCalls = hasRequestedToolCalls(value.messages);
  const failedPartialToolCall =
    value.partial && value.resolution.type === "fail";

  if (
    requestedToolCalls &&
    value.resolution.type !== "continue_iteration" &&
    !failedPartialToolCall
  ) {
    throw new TuvrenValidationError(
      `${label}.resolution must continue iteration when driver messages request tool calls`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (!requestedToolCalls && value.resolution.type === "pause") {
    throw new TuvrenValidationError(
      `${label}.resolution.pause requires driver messages with tool calls`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  if (
    value.assistantEventReconciliation !== undefined &&
    !value.messages?.some((message) => message.role === "assistant")
  ) {
    throw new TuvrenValidationError(
      `${label}.assistantEventReconciliation requires an assistant message`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
}

function assertDriverAgentConfigSnapshot(
  value: unknown,
  label: string
): asserts value is AgentConfig {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new TuvrenValidationError(`${label} must be a valid AgentConfig`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  assertOnlyAllowedKeys(value, AGENT_CONFIG_KEYS, label);
  assertDriverContextPolicySnapshot(
    value.contextPolicy,
    `${label}.contextPolicy`
  );
  assertDriverLoopPolicySnapshot(value.loopPolicy, `${label}.loopPolicy`);
  assertFiniteOptionalNumber(
    value.maxIterations,
    `${label}.maxIterations`,
    "must be a finite number"
  );
  assertDriverModelSnapshot(value.model, `${label}.model`);
  assertDriverResponseFormatSnapshot(
    value.responseFormat,
    `${label}.responseFormat`
  );
  assertOptionalString(value.systemPrompt, `${label}.systemPrompt`);
  assertToolDefinitions(value.tools, `${label}.tools`);
  assertDriverExtensionsSnapshot(value.extensions, `${label}.extensions`);
}

function assertDriverExtensionSnapshot(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenExtension`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  assertOnlyAllowedKeys(value, EXTENSION_KEYS, label);

  assertDriverExtensionHandlers(value, label);
  assertDriverAroundToolSnapshot(value.aroundTool, `${label}.aroundTool`);
  assertOptionalStringArray(value.exports, `${label}.exports`);
  assertOptionalRecord(value.state, `${label}.state`);
  assertOptionalStringOrFunction(value.systemPrompt, `${label}.systemPrompt`);
  assertFiniteOptionalNumber(
    value.timeout,
    `${label}.timeout`,
    "must be a finite number"
  );
  assertToolDefinitions(value.tools, `${label}.tools`);
}

function assertDriverContextPolicySnapshot(
  value: unknown,
  label: string
): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value) || typeof value.evaluate !== "function") {
    throw new TuvrenValidationError(`${label} must be a valid ContextPolicy`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  assertOnlyAllowedKeys(value, CONTEXT_POLICY_KEYS, label);
}

function assertDriverLoopPolicySnapshot(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value) || typeof value.evaluate !== "function") {
    throw new TuvrenValidationError(`${label} must be a valid LoopPolicy`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  assertOnlyAllowedKeys(value, LOOP_POLICY_KEYS, label);
}

function assertDriverModelSnapshot(value: unknown, label: string): void {
  if (value === undefined || typeof value === "string") {
    return;
  }

  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.generate !== "function" ||
    typeof value.stream !== "function"
  ) {
    throw new TuvrenValidationError(
      `${label} must be a string model id or TuvrenProvider`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
  // TuvrenProvider is an open runtime object. Shared core only relies on the
  // callable provider surface and must not reject provider-owned extra state.
}

function assertDriverResponseFormatSnapshot(
  value: unknown,
  label: string
): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    throw new TuvrenValidationError(
      `${label} must be a valid StructuredOutputRequest`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }

  assertOnlyAllowedKeys(value, STRUCTURED_OUTPUT_REQUEST_KEYS, label);

  if (!("schema" in value)) {
    throw new TuvrenValidationError(`${label}.schema is required`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  if (
    ("name" in value &&
      value.name !== undefined &&
      typeof value.name !== "string") ||
    ("strict" in value &&
      value.strict !== undefined &&
      typeof value.strict !== "boolean")
  ) {
    throw new TuvrenValidationError(
      `${label} must be a valid StructuredOutputRequest`,
      {
        code: "invalid_driver_result",
        details: value,
      }
    );
  }
}

function assertDriverExtensionsSnapshot(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new TuvrenValidationError(`${label} must be an array`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const [index, extension] of value.entries()) {
    assertDriverExtensionSnapshot(extension, `${label}[${index}]`);
  }
}

function assertDriverExtensionHandlers(
  value: Record<string, unknown>,
  label: string
): void {
  const handlers = [
    ["afterIteration", value.afterIteration],
    ["afterTurn", value.afterTurn],
    ["aroundModel", value.aroundModel],
    ["beforeIteration", value.beforeIteration],
    ["beforeTurn", value.beforeTurn],
  ] as const;

  for (const [name, handler] of handlers) {
    if (handler !== undefined && typeof handler !== "function") {
      throw new TuvrenValidationError(
        `${label}.${name} must be a function when provided`,
        {
          code: "invalid_driver_result",
          details: handler,
        }
      );
    }
  }
}

function assertDriverAroundToolSnapshot(value: unknown, label: string): void {
  if (value === undefined || typeof value === "function") {
    return;
  }

  const tools = isRecord(value) ? value.tools : undefined;
  const handler = isRecord(value) ? value.handler : undefined;

  if (!Array.isArray(tools) || typeof handler !== "function") {
    throw new TuvrenValidationError(`${label} must be a valid AroundToolSpec`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const toolName of tools) {
    if (typeof toolName !== "string") {
      throw new TuvrenValidationError(
        `${label} must be a valid AroundToolSpec`,
        {
          code: "invalid_driver_result",
          details: value,
        }
      );
    }
  }
}

function assertOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new TuvrenValidationError(`${label} must be an array of strings`, {
      code: "invalid_driver_result",
      details: value,
    });
  }
}

function assertOptionalRecord(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    throw new TuvrenValidationError(`${label} must be a record`, {
      code: "invalid_driver_result",
      details: value,
    });
  }
}

function assertDriverStateUpdates(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new TuvrenValidationError(`${label} must be an array`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const [index, update] of value.entries()) {
    if (
      !isRecord(update) ||
      typeof update.extensionName !== "string" ||
      !isRecord(update.state)
    ) {
      throw new TuvrenValidationError(
        `${label}[${index}] must be a valid DriverExtensionStateUpdate`,
        {
          code: "invalid_driver_result",
          details: update,
        }
      );
    }

    assertOnlyAllowedKeys(
      update,
      EXTENSION_STATE_UPDATE_KEYS,
      `${label}[${index}]`
    );
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new TuvrenValidationError(`${label} must be a string`, {
      code: "invalid_driver_result",
      details: value,
    });
  }
}

function assertOptionalStringOrFunction(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" && typeof value !== "function") {
    throw new TuvrenValidationError(`${label} must be a string or function`, {
      code: "invalid_driver_result",
      details: value,
    });
  }
}

function assertFiniteOptionalNumber(
  value: unknown,
  label: string,
  message: string
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TuvrenValidationError(`${label} ${message}`, {
      code: "invalid_driver_result",
      details: value,
    });
  }
}

function assertToolDefinitions(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new TuvrenValidationError(`${label} must be an array`, {
      code: "invalid_driver_result",
      details: value,
    });
  }

  for (const [index, tool] of value.entries()) {
    assertTuvrenToolDefinition(tool, `${label}[${index}]`);
  }
}

function assertOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TuvrenValidationError(
        `${label} must not include unsupported field "${key}"`,
        {
          code: "invalid_driver_result",
          details: value,
        }
      );
    }
  }
}

function hasRequestedToolCalls(messages?: TuvrenMessage[]): boolean {
  return (
    messages?.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "tool_call")
    ) ?? false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
