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

import { assertTuvrenToolDefinition } from "./runtime-contract-guards.js";
import type { AgentConfig } from "./runtime-contract-shapes.js";
import { TuvrenValidationError } from "./tuvren-error.js";

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

const assertRunnerExtensionHandlers = (
  value: Record<string, unknown>,
  label: string
): void => {
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
};

const assertOptionalStringArray = (value: unknown, label: string): void => {
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
};

const assertOptionalString = (value: unknown, label: string): void => {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new TuvrenValidationError(`${label} must be a string`, {
      code: "invalid_runner_result",
      details: value,
    });
  }
};

const assertOptionalStringOrFunction = (
  value: unknown,
  label: string
): void => {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" && typeof value !== "function") {
    throw new TuvrenValidationError(`${label} must be a string or function`, {
      code: "invalid_runner_result",
      details: value,
    });
  }
};

const assertFiniteOptionalNumber = (
  value: unknown,
  label: string,
  message: string
): void => {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TuvrenValidationError(`${label} ${message}`, {
      code: "invalid_runner_result",
      details: value,
    });
  }
};

const assertPositiveSafeIntegerOptionalNumber = (
  value: unknown,
  label: string
): void => {
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
};

const assertToolDefinitions = (value: unknown, label: string): void => {
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
};

export const assertOnlyAllowedKeys = (
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string
): void => {
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
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const assertRunnerContextPolicySnapshot = (
  value: unknown,
  label: string
): void => {
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
};

const assertRunnerLoopPolicySnapshot = (
  value: unknown,
  label: string
): void => {
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
};

const assertRunnerModelSnapshot = (value: unknown, label: string): void => {
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
};

const assertRunnerResponseFormatSnapshot = (
  value: unknown,
  label: string
): void => {
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
};

const assertRunnerAroundToolSnapshot = (
  value: unknown,
  label: string
): void => {
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
};

const assertOptionalRecord = (value: unknown, label: string): void => {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    throw new TuvrenValidationError(`${label} must be a record`, {
      code: "invalid_runner_result",
      details: value,
    });
  }
};

const assertRunnerExtensionSnapshot = (value: unknown, label: string): void => {
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
};

const assertRunnerExtensionsSnapshot = (
  value: unknown,
  label: string
): void => {
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
};

export const assertRunnerAgentConfigSnapshot: (
  value: unknown,
  label: string
) => asserts value is AgentConfig = (
  value: unknown,
  label: string
): asserts value is AgentConfig => {
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
};
