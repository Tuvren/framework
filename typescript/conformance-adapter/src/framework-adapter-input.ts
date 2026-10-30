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

import type { ScenarioToolCall } from "./framework-adapter-runtime.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readRecordString = (
  value: unknown,
  key: string
): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

export const parseJsonValue = (value: string): unknown => JSON.parse(value);

const readRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
};

export const readProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): unknown => {
  if (!(key in source)) {
    throw new Error(`${label} is required`);
  }

  return source[key];
};

export const readRecordProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> =>
  readRecord(readProperty(source, key, label), label);

export const readScenarioInput = (
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

export const readStringProperty = (
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

export const readOperationScenario = (
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

export const readJsonSchemaProperty = (
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

export const readPromptProperty = (
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

export const readModelResponseProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse => {
  const value = readRecordProperty(source, key, label);
  assertTuvrenModelResponse(value, label);
  return structuredClone(value);
};

export const readModelResponseArrayProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): TuvrenModelResponse[] =>
  readArrayProperty(source, key, label).map((value, index) => {
    assertTuvrenModelResponse(value, `${label}[${index}]`);
    return structuredClone(value);
  });

export const readFirstToolCallNameOptional = (
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

export const readFirstToolCallName = (
  responses: readonly TuvrenModelResponse[],
  label: string
): string => {
  const toolCallName = readFirstToolCallNameOptional(responses, label);

  if (toolCallName !== undefined) {
    return toolCallName;
  }

  throw new Error(`${label} must contain a tool_call part`);
};

export const readProviderStreamChunks = (
  scenario: Record<string, unknown>,
  label: string
): ProviderStreamChunk[] => {
  const values = readArrayProperty(scenario, "streamChunks", label);
  return values.map((value, index) => {
    assertProviderStreamChunk(value, `${label}[${index}]`);
    return structuredClone(value);
  });
};

export const readResponseFormatProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): StructuredOutputRequest =>
  readResponseFormat(readProperty(source, key, label), label);

export const readScenarioToolCall = (
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

export const readScenarioToolCalls = (
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] =>
  readArrayProperty(scenario, "toolCalls", label).map((value, index) =>
    readScenarioToolCall(
      readRecord(value, `${label}[${index}]`),
      `${label}[${index}]`
    )
  );

export const readPendingToolCalls = (
  scenario: Record<string, unknown>,
  label: string
): ScenarioToolCall[] =>
  readArrayProperty(scenario, "pendingToolCalls", label).map((value, index) =>
    readScenarioToolCall(
      readRecord(value, `${label}[${index}]`),
      `${label}[${index}]`
    )
  );

export const readApprovalDecisions = (
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

export const readAssistantText = (
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

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
