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
  assertProviderStreamChunk,
  isProviderStreamChunk,
  type ProviderStreamChunk,
  type TuvrenProvider,
} from "../src/index.ts";

const EXPECTED_PROVIDER_ARTIFACT_SCHEMAS = [
  "AssistantMessage",
  "ContentPart",
  "ErrorChunk",
  "FilePart",
  "FinishChunk",
  "FinishReason",
  "Metadata",
  "NonEmptyString",
  "ProviderMediatedToolConfig",
  "ProviderNativeInvocationRecord",
  "ProviderNativeToolDeclaration",
  "ProviderStreamChunk",
  "ProviderToolResultChunk",
  "ProviderUsage",
  "ReasoningDeltaChunk",
  "ReasoningDoneChunk",
  "ReasoningPart",
  "RenderedToolDefinition",
  "StructuredDeltaChunk",
  "StructuredDoneChunk",
  "StructuredOutputRequest",
  "StructuredPart",
  "SystemMessage",
  "TextDeltaChunk",
  "TextPart",
  "ToolCallArgsDeltaChunk",
  "ToolCallDoneChunk",
  "ToolCallPart",
  "ToolCallStartChunk",
  "ToolMessage",
  "ToolResultPart",
  "TuvrenJsonSchema",
  "TuvrenJsonSchemaObject",
  "TuvrenMessage",
  "TuvrenModelConfig",
  "TuvrenModelResponse",
  "TuvrenPrompt",
  "UserMessage",
] as const;

describe("provider-api", () => {
  test("re-exports the provider-neutral seam under its canonical public name", () => {
    const chunk = {
      delta: '{"status":"pending"}',
      type: "structured_delta",
    } satisfies ProviderStreamChunk;
    const provider = {
      generate: () =>
        Promise.resolve({
          finishReason: "stop",
          parts: [],
        }),
      id: "provider-1",
      async *stream() {
        await Promise.resolve();
        yield chunk;
      },
    } satisfies TuvrenProvider;

    expect(provider.id).toBe("provider-1");
    expect(isProviderStreamChunk(chunk)).toBe(true);
    expect(() => assertProviderStreamChunk(chunk)).not.toThrow();
  });

  test("emits TypeSpec JSON Schema artifacts for provider payload fixtures", () => {
    // Epic X keeps TypeSpec artifacts and boundary conformance fixtures at the
    // contract and boundary roots; only the TypeScript package root moved.
    const ajv = loadJsonSchemas(
      new URL("../../../artifacts/json-schema/", import.meta.url)
    );
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../conformance/fixtures/provider-fixtures.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    const negativeUsageResponse = {
      ...fixture.response,
      usage: {
        inputTokens: -1,
        outputTokens: -2,
      },
    };
    const nonRedactedEmptyReasoningResponse = {
      ...fixture.response,
      parts: [{ redacted: false, text: "", type: "reasoning" }],
    };
    const emptyStructuredNameResponse = {
      ...fixture.response,
      parts: [{ data: { status: "ok" }, name: "", type: "structured" }],
    };
    const emptyStringPromptFields = {
      ...fixture.prompt,
      messages: [{ role: "system", content: "" }],
      config: {
        model: "",
        provider: "",
        settings: {},
      },
      responseFormat: {
        name: "",
        schema: { type: "object" },
      },
    };
    const whitespaceToolPrompt = {
      ...fixture.toolPrompt,
      tools: [{ ...fixture.toolPrompt.tools[0], name: "   " }],
    };
    const invalidStructuredPrompt = {
      ...fixture.structuredPrompt,
      responseFormat: {
        ...fixture.structuredPrompt.responseFormat,
        schema: { type: "definitely_not_json_schema_type" },
      },
    };

    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      fixture.prompt
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenModelResponse.json",
      fixture.response
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      fixture.structuredPrompt
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      fixture.toolPrompt
    );
    // The provider-facing packet mirrors the focused provider binding rather
    // than durable-runtime message predicates, so empty optional strings remain
    // valid on the transport contract here.
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      emptyStringPromptFields
    );
    // StructuredPart.name mirrors the framework durable contract where an
    // empty optional schema name is still a valid string, not NonEmptyString.
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenModelResponse.json",
      emptyStructuredNameResponse
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenModelResponse.json",
      negativeUsageResponse
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenModelResponse.json",
      nonRedactedEmptyReasoningResponse
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      whitespaceToolPrompt
    );
    expectSchemaRejection(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      invalidStructuredPrompt
    );
  });

  test("emits the reviewed OpenAPI component catalog for provider payloads", () => {
    const document = readJsonObject(
      new URL(
        "../../../artifacts/openapi/provider-api.openapi.json",
        import.meta.url
      )
    );

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(readOpenApiSchemas(document)).sort()).toEqual(
      [...EXPECTED_PROVIDER_ARTIFACT_SCHEMAS].sort()
    );
    // Provider artifacts are schema catalogs only; introducing HTTP paths here
    // would accidentally move Epic T transport scope into Epic S.
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
    EXPECTED_PROVIDER_ARTIFACT_SCHEMAS.map(
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
