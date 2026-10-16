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
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  assertProviderStreamChunk,
  isProviderStreamChunk,
} from "../src/index.ts";
import type { ProviderStreamChunk, TuvrenProvider } from "../src/index.ts";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonObject = (url: URL): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(url, "utf-8"));

  if (!isRecord(value)) {
    throw new Error(`${url.pathname} must contain a JSON object`);
  }

  return value;
};

const readOpenApiSchemas = (
  document: Record<string, unknown>
): Record<string, unknown> => {
  const { components } = document;

  if (!(isRecord(components) && isRecord(components.schemas))) {
    throw new Error("OpenAPI artifact must contain components.schemas");
  }

  return components.schemas;
};

const loadJsonSchemas = (directoryUrl: URL): Ajv2020 => {
  const directory = fileURLToPath(directoryUrl);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const entries = readdirSync(directory).filter((entry) =>
    entry.endsWith(".json")
  );

  expect(entries.toSorted()).toEqual(
    EXPECTED_PROVIDER_ARTIFACT_SCHEMAS.map(
      (schemaName) => `${schemaName}.json`
    ).toSorted()
  );

  for (const entry of entries) {
    const schemaPath = path.join(directory, entry);
    const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf-8"));

    if (!(typeof schema === "boolean" || isRecord(schema))) {
      throw new Error(
        `${schemaPath} must contain a JSON Schema object or boolean`
      );
    }

    ajv.addSchema(schema);
  }

  return ajv;
};

const expectSchemaValidation = (
  ajv: Ajv2020,
  schemaId: string,
  value: unknown
): void => {
  const validate = ajv.getSchema(schemaId);

  if (validate === undefined) {
    throw new Error(`missing JSON Schema artifact ${schemaId}`);
  }

  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
};

const expectSchemaRejection = (
  ajv: Ajv2020,
  schemaId: string,
  value: unknown
): void => {
  const validate = ajv.getSchema(schemaId);

  if (validate === undefined) {
    throw new Error(`missing JSON Schema artifact ${schemaId}`);
  }

  expect(validate(value)).toBe(false);
};

describe("provider-api", () => {
  test("re-exports the provider-neutral seam under its canonical public name", () => {
    const chunk = {
      delta: '{"status":"pending"}',
      type: "structured_delta",
    } satisfies ProviderStreamChunk;
    const provider = {
      generate: async () => {
        await Promise.resolve();
        return {
          finishReason: "stop",
          parts: [],
        };
      },
      id: "provider-1",
      async *stream() {
        await Promise.resolve();
        yield chunk;
      },
    } satisfies TuvrenProvider;

    expect(provider.id).toBe("provider-1");
    expect(isProviderStreamChunk(chunk)).toBe(true);
    expect(() => {
      assertProviderStreamChunk(chunk);
    }).not.toThrow();
  });

  test("emits TypeSpec JSON Schema artifacts for provider payload fixtures", () => {
    // 87-M4.1 lifted the TypeSpec artifacts and conformance fixtures to
    // spec/; the trailing slash on the URL base below is load-bearing for
    // per-schema URL resolution.
    const ajv = loadJsonSchemas(
      new URL(
        "../../../../spec/providers/artifacts/json-schema/",
        import.meta.url
      )
    );
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../../../spec/conformance/providers/fixtures/provider-fixtures.json",
          import.meta.url
        ),
        "utf-8"
      )
    );

    if (!isRecord(fixture)) {
      throw new Error("provider fixture must contain a JSON object");
    }

    const { prompt, response, structuredPrompt, toolPrompt } = fixture;

    if (
      !(
        isRecord(prompt) &&
        isRecord(response) &&
        isRecord(structuredPrompt) &&
        isRecord(structuredPrompt.responseFormat) &&
        isRecord(toolPrompt) &&
        Array.isArray(toolPrompt.tools)
      )
    ) {
      throw new Error(
        "provider fixture must contain the expected prompt and response objects"
      );
    }

    const firstTool: unknown = toolPrompt.tools[0];

    if (!isRecord(firstTool)) {
      throw new Error("provider tool prompt must contain a tool definition");
    }

    const negativeUsageResponse = {
      ...response,
      usage: {
        inputTokens: -1,
        outputTokens: -2,
      },
    };
    const nonRedactedEmptyReasoningResponse = {
      ...response,
      parts: [{ redacted: false, text: "", type: "reasoning" }],
    };
    const emptyStructuredNameResponse = {
      ...response,
      parts: [{ data: { status: "ok" }, name: "", type: "structured" }],
    };
    const emptyStringPromptFields = {
      ...prompt,
      config: {
        model: "",
        provider: "",
        settings: {},
      },
      messages: [{ content: "", role: "system" }],
      responseFormat: {
        name: "",
        schema: { type: "object" },
      },
    };
    const whitespaceToolPrompt = {
      ...toolPrompt,
      tools: [{ ...firstTool, name: "   " }],
    };
    const invalidStructuredPrompt = {
      ...structuredPrompt,
      responseFormat: {
        ...structuredPrompt.responseFormat,
        schema: { type: "definitely_not_json_schema_type" },
      },
    };

    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      prompt
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenModelResponse.json",
      response
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      structuredPrompt
    );
    expectSchemaValidation(
      ajv,
      "https://tuvren.dev/schemas/providers/provider-api/TuvrenPrompt.json",
      toolPrompt
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
        "../../../../spec/providers/artifacts/openapi/provider-api.openapi.json",
        import.meta.url
      )
    );

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(readOpenApiSchemas(document)).toSorted()).toEqual(
      [...EXPECTED_PROVIDER_ARTIFACT_SCHEMAS].toSorted()
    );
    // Provider artifacts are schema catalogs only; introducing HTTP paths here
    // would accidentally move Epic T transport scope into Epic S.
    expect(document.paths).toEqual({});
  });
});
