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

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type ApprovalResolvedEvent,
  assertTuvrenStreamEvent,
  isTuvrenStreamEvent,
  type StateCheckpointEvent,
  type TextDoneEvent,
} from "../src/index.ts";

const EXPECTED_EVENT_STREAM_ARTIFACT_SCHEMAS = [
  "ApprovalDecision",
  "ApprovalRequest",
  "ApprovalRequestedEvent",
  "ApprovalResolvedEvent",
  "ApprovalResponse",
  "BaseEvent",
  "ContextManifest",
  "ContextManifestCounters",
  "ContextManifestNameCountMap",
  "ContextManifestNameCounters",
  "CustomEvent",
  "EpochMs",
  "ErrorEnvelope",
  "ErrorEvent",
  "EventSource",
  "FileDoneEvent",
  "FinishReason",
  "HashString",
  "IterationEndEvent",
  "IterationStartEvent",
  "MessageDoneEvent",
  "MessageIndex",
  "MessageStartEvent",
  "Metadata",
  "NonEmptyString",
  "NonNegativeSafeInt",
  "PendingToolCall",
  "ProviderUsage",
  "ReasoningDeltaEvent",
  "ReasoningDoneEvent",
  "StateCheckpointEvent",
  "StateSnapshotEvent",
  "SteeringIncorporatedEvent",
  "StructuredDeltaEvent",
  "StructuredDoneEvent",
  "TextDeltaEvent",
  "TextDoneEvent",
  "ToolCallArgsDeltaEvent",
  "ToolCallDoneEvent",
  "ToolCallStartEvent",
  "ToolResultEvent",
  "ToolResultPart",
  "ToolStartEvent",
  "TurnEndEvent",
  "TurnStartEvent",
  "TuvrenStreamEvent",
] as const;

describe("event-stream contracts", () => {
  test("re-exports the canonical runtime event vocabulary and named variants", () => {
    const event = {
      messageId: "message-1",
      source: {
        agent: "primary",
        driver: "react",
        threadId: "thread-main",
      },
      text: "Need approval before continuing.",
      timestamp: 1_717_171_717_171,
      type: "text.done",
    } satisfies TextDoneEvent;

    expect(isTuvrenStreamEvent(event)).toBe(true);
    expect(() => assertTuvrenStreamEvent(event)).not.toThrow();
  });

  test("emits JSON Schema artifacts that match richer event payload variants", () => {
    const ajv = loadJsonSchemas(
      new URL("../../../artifacts/json-schema/", import.meta.url)
    );
    const approvalResolvedEvent = {
      response: {
        decisions: [
          {
            callId: "call-search",
            message: "Proceed with the reviewed input.",
            type: "approve",
          },
        ],
      },
      source: {
        agent: "primary",
        driver: "react",
        threadId: "thread-main",
      },
      timestamp: 1_717_171_717_171,
      type: "approval.resolved",
    } satisfies ApprovalResolvedEvent;
    const stateCheckpointEvent = {
      iterationCount: 2,
      source: {
        agent: "primary",
      },
      timestamp: 1_717_171_717_172,
      turnNodeHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      type: "state.checkpoint",
    } satisfies StateCheckpointEvent;
    const invalidManifestEvent = {
      manifest: {
        byRole: {
          assistant: -1,
          system: 0,
          tool: 0,
          user: 1,
        },
        extensions: {},
        lastAssistantMessageIndex: -1,
        lastUserMessageIndex: 0,
        messageCount: 1,
        tokenEstimate: 1,
        toolCalls: {
          byName: {
            "": 1,
          },
          total: 1,
        },
        toolResults: {
          byName: {},
          total: 0,
        },
        turnBoundaries: [0],
      },
      timestamp: 1_717_171_717_173,
      type: "state.snapshot",
    };

    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/framework/event-stream/ApprovalResolvedEvent.json",
      approvalResolvedEvent
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/framework/event-stream/StateCheckpointEvent.json",
      stateCheckpointEvent
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/framework/event-stream/StateSnapshotEvent.json",
      invalidManifestEvent
    );
  });
});

function loadJsonSchemas(directoryUrl: URL): Ajv2020 {
  const directory = fileURLToPath(directoryUrl);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const entries = readdirSync(directory).filter((entry) =>
    entry.endsWith(".json")
  );

  expect(entries.sort()).toEqual(
    EXPECTED_EVENT_STREAM_ARTIFACT_SCHEMAS.map(
      (schemaName) => `${schemaName}.json`
    ).sort()
  );

  for (const entry of entries) {
    const schemaPath = join(directory, entry);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    ajv.addSchema(schema);
  }

  return ajv;
}

function expectSchemaValidation(
  ajv: Ajv2020,
  schemaId: string,
  value: unknown
): void {
  const validate = ajv.getSchema(schemaId);

  if (validate === undefined) {
    throw new Error(`missing JSON Schema artifact ${schemaId}`);
  }

  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

function expectSchemaRejection(
  ajv: Ajv2020,
  schemaId: string,
  value: unknown
): void {
  const validate = ajv.getSchema(schemaId);

  if (validate === undefined) {
    throw new Error(`missing JSON Schema artifact ${schemaId}`);
  }

  expect(validate(value)).toBe(false);
}
