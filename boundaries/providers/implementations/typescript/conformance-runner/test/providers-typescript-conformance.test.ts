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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type ProviderTestkitFixtureSet,
  providerTestkitFixtures,
} from "../../../../testkit/src/index.ts";

const PROVIDER_SUITE_MANIFEST = new URL(
  "../../../../conformance/scenarios/suite-manifest.json",
  import.meta.url
);
const PROVIDER_SUITE_MANIFEST_SCHEMA = new URL(
  "../../../../conformance/schemas/suite-manifest.schema.json",
  import.meta.url
);

describe("providers TypeScript conformance runner", () => {
  test("executes the shared provider fixture suite", () => {
    const fixture = readValidatedSingleFixtureSuite(
      PROVIDER_SUITE_MANIFEST,
      "provider-fixtures"
    );

    // The TypeScript helper package is intentionally a consumer facade now.
    // Compatibility evidence starts from the boundary-owned JSON fixture.
    expect(providerTestkitFixtures).toEqual(fixture);
    expect(fixture.prompt.messages).toHaveLength(1);
    expect(fixture.response).toEqual({
      finishReason: "stop",
      parts: [{ text: "ready", type: "text" }],
      usage: {
        inputTokens: 4,
        outputTokens: 1,
      },
    });
    expect(fixture.structuredPrompt.responseFormat).toEqual({
      name: "answer",
      schema: {
        properties: {
          answer: {
            type: "string",
          },
        },
        required: ["answer"],
        type: "object",
      },
    });
    expect(fixture.toolPrompt.tools?.[0]).toEqual({
      description: "Search docs",
      inputSchema: {
        properties: {
          query: {
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    });
  });
});

function readValidatedSingleFixtureSuite(
  manifestUrl: URL,
  expectedFixtureId: string
): ProviderTestkitFixtureSet {
  const manifest = readSuiteManifest(manifestUrl);
  const manifestSchema = readJsonSchema(
    fileURLToPath(PROVIDER_SUITE_MANIFEST_SCHEMA)
  );
  const manifestAjv = new Ajv2020({ allErrors: true, strict: false });
  const validateManifest = manifestAjv.compile(manifestSchema);

  expect(
    validateManifest(readJsonObject(fileURLToPath(manifestUrl))),
    manifestAjv.errorsText(validateManifest.errors)
  ).toBe(true);
  expect(manifest).toMatchObject({
    boundary: "providers",
    suiteId: "tuvren.providers.api-fixtures",
    suiteVersion: "0.2.0",
  });
  expect(manifest.fixtures).toEqual([
    {
      id: expectedFixtureId,
      path: "../fixtures/provider-fixtures.json",
    },
  ]);

  const manifestDirectory = dirname(fileURLToPath(manifestUrl));
  const schema = readJsonSchema(
    join(manifestDirectory, manifest.fixtureSchemaPath)
  );
  const fixturePath = join(manifestDirectory, manifest.fixtures[0].path);
  const fixture = readJsonObject(fixturePath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  expect(validate(fixture), ajv.errorsText(validate.errors)).toBe(true);
  assertProviderTestkitFixtureSet(fixture, fixturePath);
  return fixture;
}

interface SuiteFixture {
  id: string;
  path: string;
}

interface SuiteManifest {
  boundary: string;
  fixtureSchemaPath: string;
  fixtures: [SuiteFixture];
  suiteId: string;
  suiteVersion: string;
}

function readSuiteManifest(url: URL): SuiteManifest {
  const value = readJsonObject(fileURLToPath(url));

  if (
    typeof value.boundary !== "string" ||
    typeof value.fixtureSchemaPath !== "string" ||
    !Array.isArray(value.fixtures) ||
    value.fixtures.length !== 1 ||
    typeof value.suiteId !== "string" ||
    typeof value.suiteVersion !== "string"
  ) {
    throw new Error(`${url.pathname} must be a valid suite manifest`);
  }

  const fixture = value.fixtures[0];

  if (
    !isRecord(fixture) ||
    typeof fixture.id !== "string" ||
    typeof fixture.path !== "string"
  ) {
    throw new Error(`${url.pathname} must contain valid fixture entries`);
  }

  return {
    boundary: value.boundary,
    fixtureSchemaPath: value.fixtureSchemaPath,
    fixtures: [{ id: fixture.id, path: fixture.path }],
    suiteId: value.suiteId,
    suiteVersion: value.suiteVersion,
  };
}

function assertProviderTestkitFixtureSet(
  value: unknown,
  label: string
): asserts value is ProviderTestkitFixtureSet {
  if (
    !(
      isRecord(value) &&
      isRecord(value.prompt) &&
      isRecord(value.response) &&
      isRecord(value.structuredPrompt) &&
      isRecord(value.toolPrompt)
    )
  ) {
    throw new Error(`${label} must contain provider prompt/response fixtures`);
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (!isRecord(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }

  return value;
}

function readJsonSchema(path: string): AnySchema {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${path} must contain a JSON Schema object or boolean`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
