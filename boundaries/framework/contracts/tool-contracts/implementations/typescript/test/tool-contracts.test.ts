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
  type ApprovalRequest,
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertTuvrenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isTuvrenToolDefinition,
  type TuvrenToolDefinition,
} from "../src/index.ts";

const EXPECTED_TOOL_ARTIFACT_SCHEMAS = [
  "ApprovalDecision",
  "ApprovalDecisionType",
  "ApprovalRequest",
  "ApprovalResponse",
  "ApprovalToolResultBatch",
  "CompletedToolResultBatch",
  "InvalidValidationResult",
  "Metadata",
  "NonEmptyString",
  "PendingToolCall",
  "RenderedToolDefinition",
  "ToolCallPart",
  "ToolResultPart",
  "TuvrenJsonSchema",
  "TuvrenJsonSchemaObject",
  "TuvrenToolResultBatch",
  "ValidationErrorPayload",
  "ValidationResult",
  "ValidValidationResult",
] as const;

describe("tool-contracts", () => {
  test("re-exports tool and approval contracts from the shared runtime anchor", () => {
    const approvalRequest = {
      completedResults: [
        {
          callId: "call-1",
          name: "search",
          output: { hits: 1 },
          type: "tool_result",
        },
      ],
      toolCalls: [
        {
          callId: "call-2",
          decisions: ["approve", "edit", "reject"],
          input: { query: "latest status" },
          message: "Approve the outbound search?",
          name: "search",
        },
      ],
    } satisfies ApprovalRequest;
    const toolDefinition = {
      description: "Search documentation",
      execute() {
        return { hits: 1 };
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    } satisfies TuvrenToolDefinition;

    expect(isApprovalRequest(approvalRequest)).toBe(true);
    expect(
      isApprovalResponse({ decisions: [{ callId: "call-1", type: "approve" }] })
    ).toBe(true);
    expect(isTuvrenToolDefinition(toolDefinition)).toBe(true);
    expect(() => assertApprovalRequest(approvalRequest)).not.toThrow();
    expect(() =>
      assertApprovalResponse({
        decisions: [{ callId: "call-1", type: "approve" }],
      })
    ).not.toThrow();
    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call-2", type: "approve" }] },
        approvalRequest
      )
    ).toBe(true);
    expect(() =>
      assertApprovalResponseForRequest(
        { decisions: [{ callId: "call-2", type: "approve" }] },
        approvalRequest
      )
    ).not.toThrow();
    expect(() => assertTuvrenToolDefinition(toolDefinition)).not.toThrow();
  });

  test("emits TypeSpec JSON Schema artifacts for serializable tool payloads", () => {
    // The generated artifact catalog stays contract-root owned even though the
    // TypeScript package itself now lives under implementations/typescript.
    const ajv = loadJsonSchemas(
      new URL(
        "../../../../../../../spec/tools/artifacts/json-schema/",
        import.meta.url
      )
    );
    const approvalRequest = {
      completedResults: [
        {
          callId: "call-1",
          name: "search",
          output: { hits: 1 },
          type: "tool_result",
        },
      ],
      toolCalls: [
        {
          callId: "call-2",
          decisions: ["approve", "edit", "reject"],
          input: { query: "latest status" },
          message: "Approve the outbound search?",
          name: "search",
        },
      ],
    };
    const renderedTool = {
      description: "Search documentation",
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    };
    const whitespaceCallIdApprovalRequest = {
      ...approvalRequest,
      toolCalls: [{ ...approvalRequest.toolCalls[0], callId: "   " }],
    };
    const editDecisionWithoutInput = {
      decisions: [{ callId: "call-2", type: "edit" }],
    };
    const approveDecisionWithEditedInput = {
      decisions: [
        {
          callId: "call-2",
          editedInput: { query: "changed" },
          type: "approve",
        },
      ],
    };
    const invalidJsonSchemaTool = {
      ...renderedTool,
      inputSchema: { type: "definitely_not_json_schema_type" },
    };

    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/framework/tool-contracts/ApprovalRequest.json",
      approvalRequest
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/framework/tool-contracts/RenderedToolDefinition.json",
      renderedTool
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/framework/tool-contracts/ApprovalRequest.json",
      whitespaceCallIdApprovalRequest
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/framework/tool-contracts/ApprovalResponse.json",
      editDecisionWithoutInput
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/framework/tool-contracts/ApprovalResponse.json",
      approveDecisionWithEditedInput
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/framework/tool-contracts/RenderedToolDefinition.json",
      invalidJsonSchemaTool
    );
  });

  test("emits the reviewed OpenAPI component catalog for tool payloads", () => {
    const document = readJsonObject(
      new URL(
        "../../../../../../../spec/tools/artifacts/openapi/tool-contracts.openapi.json",
        import.meta.url
      )
    );

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(readOpenApiSchemas(document)).sort()).toEqual(
      [...EXPECTED_TOOL_ARTIFACT_SCHEMAS].sort()
    );
    // Epic S intentionally emits a component catalog rather than an HTTP API;
    // endpoints belong to future transport work, not this contract artifact.
    expect(document.paths).toEqual({});
  });
});

function loadJsonSchemas(directoryUrl: URL): Ajv2020 {
  const directory = fileURLToPath(directoryUrl);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const entries = readdirSync(directory).filter((entry) =>
    entry.endsWith(".json")
  );

  expect(entries.sort()).toEqual(
    EXPECTED_TOOL_ARTIFACT_SCHEMAS.map(
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

function readJsonObject(url: URL): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(url, "utf8"));

  if (!isRecord(value)) {
    throw new Error(`${url.pathname} must contain a JSON object`);
  }

  return value;
}

function readOpenApiSchemas(
  document: Record<string, unknown>
): Record<string, unknown> {
  const components = document.components;

  if (!(isRecord(components) && isRecord(components.schemas))) {
    throw new Error("OpenAPI artifact must contain components.schemas");
  }

  return components.schemas;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
