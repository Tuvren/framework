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

import type {
  RunnerAssistantEventReconciliation,
  RunnerExecutionResult,
  RunnerToolExecutionMode,
  RuntimeRunner,
} from "./runner-contract-shapes.js";
import {
  assertApprovalRequest,
  assertContextManifest,
  assertTuvrenMessage,
  assertTuvrenToolDefinition,
} from "./runtime-contract-guards.js";
import type {
  AgentConfig,
  HandoffContextPlan,
  HandoffSourceContext,
  RuntimeResolution,
  TuvrenMessage,
} from "./runtime-contract-shapes.js";
import { TuvrenValidationError } from "./tuvren-error.js";

const RUNNER_RESULT_KEYS = new Set([
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
  "maxParallelToolCalls",
  "model",
  "name",
  "providerMediatedTools",
  "providerNativeTools",
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

/**
 * Returns `true` when `value` structurally satisfies the {@link RuntimeRunner}
 * contract (KrakenFrameworkSpecification §5.6).
 *
 * A valid runner is an object with:
 * - `id`: a non-empty (after trimming) string identifier, and
 * - `execute`: a function, and
 * - `resume`: absent or a function (approval resume is framework-owned, so
 *   `resume` is optional on the shared seam).
 *
 * Never throws: property-access traps or other probe failures collapse to
 * `false`.
 *
 * @param value - Untrusted candidate to probe.
 * @returns `true` when `value` can be used as a `RuntimeRunner`.
 * @see {@link assertRuntimeRunner} for the throwing variant.
 */
export function isRuntimeRunner(value: unknown): value is RuntimeRunner {
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

/**
 * Asserts that `value` satisfies the {@link RuntimeRunner} contract.
 *
 * Same structural check as {@link isRuntimeRunner}, expressed as a TypeScript
 * assertion for registration seams that must reject invalid runners eagerly.
 *
 * @param value - Untrusted candidate runner.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_runner_contract` when the
 *   value is not a valid runner; the offending value is attached as `details`.
 */
export function assertRuntimeRunner(
  value: unknown,
  label = "value"
): asserts value is RuntimeRunner {
  if (!isRuntimeRunner(value)) {
    throw new TuvrenValidationError(`${label} must be a valid RuntimeRunner`, {
      code: "invalid_runner_contract",
      details: value,
    });
  }
}

/**
 * Asserts that `value` is a contract-valid {@link RunnerExecutionResult}
 * (KrakenFrameworkSpecification §5.6, "`RunnerExecutionResult` is
 * intentionally minimal").
 *
 * Field-level invariants enforced:
 * - Only the keys `resolution`, `messages`, `partial`,
 *   `assistantEventReconciliation`, `stateUpdates`, and `toolExecutionMode`
 *   may be present; any other key is rejected.
 * - `resolution` is required and must be a valid {@link RuntimeResolution}
 *   variant (see {@link assertRunnerRuntimeResolution}).
 * - `partial`, when present, must be a boolean.
 * - `assistantEventReconciliation`, when provided, must be exactly
 *   `"allow_final_sequence_divergence"` (the aroundModel post-stream
 *   replacement opt-in).
 * - `toolExecutionMode`, when provided, must be `"parallel"` or
 *   `"sequential"`.
 * - `stateUpdates`, when present, must be an array of records containing
 *   exactly `extensionName` (string) and `state` (object).
 * - `messages`, when present, must be an array of valid `TuvrenMessage`
 *   values in which every entry is either a single assistant message with no
 *   `tool_result` parts, or a pre-staged provider tool message (AY003: role
 *   `tool` whose parts are all `tool_result` with
 *   `providerMetadata.owner === "provider"`). At most one assistant message
 *   is allowed per result.
 *
 * Cross-field invariants enforced:
 * - `partial: true` is only valid when `resolution.type === "fail"` and the
 *   result stages an assistant message.
 * - `toolExecutionMode` is required exactly when an assistant message
 *   requests tool calls (contains a `tool_call` part), and invalid otherwise.
 * - When tool calls are requested, `resolution` must be
 *   `continue_iteration` — except for a failed `partial` result, whose
 *   interrupted tool calls are durable context only and are never executed.
 * - A `pause` resolution requires runner messages with tool calls.
 * - `assistantEventReconciliation` requires an assistant message to
 *   reconcile against.
 *
 * @param value - Untrusted result returned by a runner `execute`/`resume`.
 * @param label - Prefix used in error messages (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_runner_result` naming the
 *   first violated invariant.
 */
export function assertRunnerExecutionResult(
  value: unknown,
  label = "value"
): asserts value is RunnerExecutionResult {
  if (
    !isRecord(value) ||
    ("partial" in value && typeof value.partial !== "boolean")
  ) {
    throw new TuvrenValidationError(
      `${label} must include only valid optional runner metadata fields`,
      {
        code: "invalid_runner_result",
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
        code: "invalid_runner_result",
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
        code: "invalid_runner_result",
        details: value,
      }
    );
  }

  assertRunnerStateUpdates(value.stateUpdates, `${label}.stateUpdates`);
  assertRunnerMessages(value, label);
  assertOnlyAllowedKeys(value, RUNNER_RESULT_KEYS, label);
  assertRunnerRuntimeResolution(value.resolution, `${label}.resolution`);

  assertRunnerPartialResult(
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
  assertRunnerToolExecutionMode(
    {
      messages: Array.isArray(value.messages) ? value.messages : undefined,
      toolExecutionMode,
    },
    `${label}`
  );
  assertRunnerResolutionCompatibility(
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

/**
 * Asserts that `value` is a valid {@link RuntimeResolution} discriminated
 * union variant (KrakenFrameworkSpecification §1.5).
 *
 * Each variant is validated against its exact key set — unknown extra keys
 * are rejected:
 * - `continue_iteration`: no payload fields.
 * - `end_turn`: requires a string `reason`.
 * - `pause`: requires a string `reason` and a valid `approval`
 *   `ApprovalRequest` (validated via `assertApprovalRequest`).
 * - `handoff`: requires a string `targetAgent` and a valid `contextPlan`
 *   (validated via {@link assertRunnerHandoffContextPlan}); additionally,
 *   `contextPlan.targetAgent` must equal the resolution's `targetAgent`.
 * - `fail`: requires `error` to be an `Error` instance and `fatality` to be
 *   `"hard"` or `"soft"`.
 *
 * @param value - Untrusted candidate resolution.
 * @param label - Prefix used in error messages (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_runner_result` when the
 *   value is not one of the variants above.
 */
export function assertRunnerRuntimeResolution(
  value: unknown,
  label = "value"
): asserts value is RuntimeResolution {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TuvrenValidationError(`${label} must be a valid resolution`, {
      code: "invalid_runner_result",
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
        assertRunnerHandoffContextPlan(
          value.contextPlan,
          `${label}.contextPlan`
        );
        assertOnlyAllowedKeys(value, HANDOFF_RESOLUTION_KEYS, label);

        if (value.contextPlan.targetAgent !== value.targetAgent) {
          throw new TuvrenValidationError(
            `${label}.targetAgent must match ${label}.contextPlan.targetAgent`,
            {
              code: "invalid_runner_result",
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
    code: "invalid_runner_result",
    details: value,
  });
}

/**
 * Asserts that `value` is a valid {@link HandoffContextPlan}
 * (KrakenFrameworkSpecification §1.5).
 *
 * Enforces:
 * - `targetAgent`, `reason`, and `mode` are strings, `builder` is a function,
 *   and `sourceContext` is an object.
 * - `sourceContext` is a valid {@link HandoffSourceContext} (see
 *   {@link assertRunnerHandoffSourceContext}).
 * - Target-agent identity is consistent across the plan:
 *   `sourceContext.handoffIntent.targetAgent` and
 *   `sourceContext.targetAgent.name` must both equal the plan's
 *   `targetAgent`.
 *
 * @param value - Untrusted candidate handoff plan.
 * @param label - Prefix used in error messages (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_runner_result` on any
 *   structural or identity mismatch.
 */
export function assertRunnerHandoffContextPlan(
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
      code: "invalid_runner_result",
      details: value,
    });
  }

  assertRunnerHandoffSourceContext(
    value.sourceContext,
    `${label}.sourceContext`
  );

  if (value.sourceContext.handoffIntent.targetAgent !== value.targetAgent) {
    throw new TuvrenValidationError(
      `${label}.sourceContext.handoffIntent.targetAgent must match ${label}.targetAgent`,
      {
        code: "invalid_runner_result",
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
        code: "invalid_runner_result",
        details: {
          contextPlanTargetAgent: value.targetAgent,
          sourceContextTargetAgent: value.sourceContext.targetAgent.name,
        },
      }
    );
  }
}

/**
 * Asserts that `value` is a valid {@link HandoffSourceContext}
 * (KrakenFrameworkSpecification §1.5).
 *
 * Enforces:
 * - `messages` is an array whose entries are all valid `TuvrenMessage`
 *   values (any role — this is source conversation history, not runner
 *   output).
 * - `manifest` is a valid `ContextManifest`.
 * - `handoffIntent` is an object with a string `targetAgent`.
 * - `helpers` exposes the context-engineering functions `loadMessage`,
 *   `storeMessage`, and `storeMessages`.
 * - `sourceAgent` and `targetAgent` are structurally valid `AgentConfig`
 *   snapshots (exact key allowlist, policy/model/responseFormat/tool/
 *   extension shape checks).
 *
 * @param value - Untrusted candidate handoff source context.
 * @param label - Prefix used in error messages (defaults to `"value"`).
 * @throws TuvrenValidationError with code `invalid_runner_result` on the
 *   first violated invariant.
 */
export function assertRunnerHandoffSourceContext(
  value: unknown,
  label = "value"
): asserts value is HandoffSourceContext {
  if (!isRecord(value)) {
    throw new TuvrenValidationError(`${label} must be a valid handoff source`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  if (!Array.isArray(value.messages)) {
    throw new TuvrenValidationError(`${label}.messages must be an array`, {
      code: "invalid_runner_result",
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
      code: "invalid_runner_result",
      details: value,
    });
  }

  assertRunnerAgentConfigSnapshot(value.sourceAgent, `${label}.sourceAgent`);
  assertRunnerAgentConfigSnapshot(value.targetAgent, `${label}.targetAgent`);
}

function safePredicate(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function assertRunnerMessage(message: TuvrenMessage, label: string): void {
  if (message.role !== "assistant") {
    throw new TuvrenValidationError(`${label} must be an assistant message`, {
      code: "invalid_runner_result",
      details: message,
    });
  }

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "tool_result") {
      throw new TuvrenValidationError(
        `${label}.parts[${index}] must not be a tool_result`,
        {
          code: "invalid_runner_result",
          details: part,
        }
      );
    }
  }
}

function assertRunnerMessages(
  value: Record<string, unknown>,
  label: string
): void {
  if (!("messages" in value) || value.messages === undefined) {
    return;
  }

  if (!Array.isArray(value.messages)) {
    throw new TuvrenValidationError(`${label}.messages must be an array`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  let assistantCount = 0;

  for (const [index, message] of value.messages.entries()) {
    assertTuvrenMessage(message, `${label}.messages[${index}]`);
    // Pre-staged provider tool messages (AY003) are allowed alongside the assistant
    // message so the framework can stage provider results without dispatching them
    // through the Tool Execution Gateway.
    if (isPrestagedProviderToolMessage(message as TuvrenMessage)) {
      continue;
    }
    assertRunnerMessage(message, `${label}.messages[${index}]`);
    assistantCount++;
  }

  if (assistantCount > 1) {
    throw new TuvrenValidationError(
      `${label}.messages must not contain more than one assistant message`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

/**
 * True for a role-`tool` message whose parts are all `tool_result` parts
 * attributed to the provider (`providerMetadata.owner === "provider"`).
 * These AY003 pre-staged provider results may accompany the assistant
 * message in `RunnerExecutionResult.messages`.
 */
function isPrestagedProviderToolMessage(message: TuvrenMessage): boolean {
  if (message.role !== "tool") {
    return false;
  }
  return message.parts.every((part) => {
    if (part.type !== "tool_result") {
      return false;
    }
    const meta = part.providerMetadata;
    return (
      typeof meta === "object" &&
      meta !== null &&
      (meta as Record<string, unknown>).owner === "provider"
    );
  });
}

/**
 * Enforces the `partial` invariant: `partial: true` is only valid for failed
 * execution results (`resolution.type === "fail"`) that stage at least one
 * assistant message (KrakenFrameworkSpecification §5.6).
 */
function assertRunnerPartialResult(
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
        code: "invalid_runner_result",
        details: value,
      }
    );
  }

  if (!value.messages?.some((message) => message.role === "assistant")) {
    throw new TuvrenValidationError(
      `${label}.partial requires a staged assistant message`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

/**
 * Enforces the `toolExecutionMode` invariant: the mode is required when the
 * staged assistant message requests tool calls and invalid when it does not
 * (KrakenFrameworkSpecification §5.6).
 */
function assertRunnerToolExecutionMode(
  value: {
    messages?: TuvrenMessage[];
    toolExecutionMode?: RunnerToolExecutionMode;
  },
  label: string
): void {
  const requestedToolCalls = hasRequestedToolCalls(value.messages);

  if (requestedToolCalls && value.toolExecutionMode === undefined) {
    throw new TuvrenValidationError(
      `${label}.toolExecutionMode is required when runner messages request tool calls`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }

  if (!requestedToolCalls && value.toolExecutionMode !== undefined) {
    throw new TuvrenValidationError(
      `${label}.toolExecutionMode is only valid when runner messages request tool calls`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

/**
 * Enforces cross-field compatibility between staged messages and the
 * resolution: requested tool calls force `continue_iteration` (except a
 * failed `partial` result), `pause` requires pending tool calls, and
 * `assistantEventReconciliation` requires an assistant message.
 */
function assertRunnerResolutionCompatibility(
  value: {
    assistantEventReconciliation?: RunnerAssistantEventReconciliation;
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
      `${label}.resolution must continue iteration when runner messages request tool calls`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }

  if (!requestedToolCalls && value.resolution.type === "pause") {
    throw new TuvrenValidationError(
      `${label}.resolution.pause requires runner messages with tool calls`,
      {
        code: "invalid_runner_result",
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
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

function assertRunnerAgentConfigSnapshot(
  value: unknown,
  label: string
): asserts value is AgentConfig {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new TuvrenValidationError(`${label} must be a valid AgentConfig`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  assertOnlyAllowedKeys(value, AGENT_CONFIG_KEYS, label);
  assertRunnerContextPolicySnapshot(
    value.contextPolicy,
    `${label}.contextPolicy`
  );
  assertRunnerLoopPolicySnapshot(value.loopPolicy, `${label}.loopPolicy`);
  assertFiniteOptionalNumber(
    value.maxIterations,
    `${label}.maxIterations`,
    "must be a finite number"
  );
  assertPositiveSafeIntegerOptionalNumber(
    value.maxParallelToolCalls,
    `${label}.maxParallelToolCalls`
  );
  assertRunnerModelSnapshot(value.model, `${label}.model`);
  assertRunnerResponseFormatSnapshot(
    value.responseFormat,
    `${label}.responseFormat`
  );
  assertOptionalString(value.systemPrompt, `${label}.systemPrompt`);
  assertToolDefinitions(value.tools, `${label}.tools`);
  assertRunnerExtensionsSnapshot(value.extensions, `${label}.extensions`);
}

function assertRunnerExtensionSnapshot(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new TuvrenValidationError(
      `${label} must be a valid TuvrenExtension`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }

  assertOnlyAllowedKeys(value, EXTENSION_KEYS, label);

  assertRunnerExtensionHandlers(value, label);
  assertRunnerAroundToolSnapshot(value.aroundTool, `${label}.aroundTool`);
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

function assertRunnerContextPolicySnapshot(
  value: unknown,
  label: string
): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value) || typeof value.evaluate !== "function") {
    throw new TuvrenValidationError(`${label} must be a valid ContextPolicy`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  assertOnlyAllowedKeys(value, CONTEXT_POLICY_KEYS, label);
}

function assertRunnerLoopPolicySnapshot(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value) || typeof value.evaluate !== "function") {
    throw new TuvrenValidationError(`${label} must be a valid LoopPolicy`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  assertOnlyAllowedKeys(value, LOOP_POLICY_KEYS, label);
}

function assertRunnerModelSnapshot(value: unknown, label: string): void {
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
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

function assertRunnerResponseFormatSnapshot(
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
        code: "invalid_runner_result",
        details: value,
      }
    );
  }

  assertOnlyAllowedKeys(value, STRUCTURED_OUTPUT_REQUEST_KEYS, label);

  if (!("schema" in value)) {
    throw new TuvrenValidationError(`${label}.schema is required`, {
      code: "invalid_runner_result",
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
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

function assertRunnerExtensionsSnapshot(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new TuvrenValidationError(`${label} must be an array`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  for (const [index, extension] of value.entries()) {
    assertRunnerExtensionSnapshot(extension, `${label}[${index}]`);
  }
}

function assertRunnerExtensionHandlers(
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
          code: "invalid_runner_result",
          details: handler,
        }
      );
    }
  }
}

function assertRunnerAroundToolSnapshot(value: unknown, label: string): void {
  if (value === undefined || typeof value === "function") {
    return;
  }

  const tools = isRecord(value) ? value.tools : undefined;
  const handler = isRecord(value) ? value.handler : undefined;

  if (!Array.isArray(tools) || typeof handler !== "function") {
    throw new TuvrenValidationError(`${label} must be a valid AroundToolSpec`, {
      code: "invalid_runner_result",
      details: value,
    });
  }

  for (const toolName of tools) {
    if (typeof toolName !== "string") {
      throw new TuvrenValidationError(
        `${label} must be a valid AroundToolSpec`,
        {
          code: "invalid_runner_result",
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
      code: "invalid_runner_result",
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
      code: "invalid_runner_result",
      details: value,
    });
  }
}

function assertRunnerStateUpdates(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new TuvrenValidationError(`${label} must be an array`, {
      code: "invalid_runner_result",
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
        `${label}[${index}] must be a valid RunnerExtensionStateUpdate`,
        {
          code: "invalid_runner_result",
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
      code: "invalid_runner_result",
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
      code: "invalid_runner_result",
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
      code: "invalid_runner_result",
      details: value,
    });
  }
}

function assertPositiveSafeIntegerOptionalNumber(
  value: unknown,
  label: string
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TuvrenValidationError(
      `${label} must be a positive safe integer`,
      {
        code: "invalid_runner_result",
        details: value,
      }
    );
  }
}

function assertToolDefinitions(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new TuvrenValidationError(`${label} must be an array`, {
      code: "invalid_runner_result",
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
          code: "invalid_runner_result",
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
