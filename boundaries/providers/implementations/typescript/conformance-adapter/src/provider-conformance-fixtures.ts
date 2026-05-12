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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTuvrenModelResponse,
  type TuvrenModelResponse,
  type TuvrenPrompt,
} from "@tuvren/provider-api";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

export interface ProviderConformanceFixtureSet {
  prompt: TuvrenPrompt;
  response: TuvrenModelResponse;
  structuredPrompt: TuvrenPrompt;
  toolPrompt: TuvrenPrompt;
}

const MANIFEST_PATH_SEGMENTS = [
  "conformance",
  "scenarios",
  "suite-manifest.json",
];
const MANIFEST_SCHEMA_RELATIVE_PATH = "../schemas/suite-manifest.schema.json";
const ajv = new Ajv2020({ allErrors: true, strict: false });

export const providerConformanceFixtures: ProviderConformanceFixtureSet =
  loadProviderConformanceFixtures();

function loadProviderConformanceFixtures(): ProviderConformanceFixtureSet {
  const manifestPath = resolveFixturePath(
    import.meta.url,
    MANIFEST_PATH_SEGMENTS
  );
  const manifest = readConformanceManifest(manifestPath);
  const fixturePath = join(dirname(manifestPath), manifest.fixturePath);
  const schemaPath = join(dirname(manifestPath), manifest.fixtureSchemaPath);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const schema = readJsonSchema(JSON.parse(readFileSync(schemaPath, "utf8")));

  assertSchemaValid(schema, fixture, "provider conformance fixture");
  assertProviderConformanceFixtureSet(fixture);
  return fixture;
}

function resolveFixturePath(
  metaUrl: string,
  pathSegments: readonly string[]
): string {
  const currentFilePath = fileURLToPath(metaUrl);
  let currentDirectory = dirname(currentFilePath);

  for (let index = 0; index < 8; index += 1) {
    const candidatePath = join(currentDirectory, ...pathSegments);

    if (existsSync(candidatePath)) {
      return candidatePath;
    }

    currentDirectory = dirname(currentDirectory);
  }

  throw new Error("unable to locate provider conformance fixture file");
}

function readConformanceManifest(manifestPath: string): {
  fixturePath: string;
  fixtureSchemaPath: string;
} {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestSchema = readJsonSchema(
    JSON.parse(
      readFileSync(
        join(dirname(manifestPath), MANIFEST_SCHEMA_RELATIVE_PATH),
        "utf8"
      )
    )
  );

  assertSchemaValid(manifestSchema, manifest, "provider conformance manifest");

  if (
    !isRecord(manifest) ||
    typeof manifest.fixtureSchemaPath !== "string" ||
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length !== 1
  ) {
    throw new Error("provider conformance manifest is invalid");
  }

  const [fixture] = manifest.fixtures;

  if (!isRecord(fixture) || typeof fixture.path !== "string") {
    throw new Error("provider conformance manifest fixture entry is invalid");
  }

  return {
    fixturePath: fixture.path,
    fixtureSchemaPath: manifest.fixtureSchemaPath,
  };
}

function readJsonSchema(value: unknown): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error("provider conformance schema must be an object or boolean");
}

function assertSchemaValid(
  schema: AnySchema,
  value: unknown,
  label: string
): void {
  const validate = ajv.compile(schema);

  if (validate(value)) {
    return;
  }

  throw new Error(
    `${label} failed JSON Schema validation: ${ajv.errorsText(validate.errors)}`
  );
}

function assertProviderConformanceFixtureSet(
  value: unknown
): asserts value is ProviderConformanceFixtureSet {
  if (!isRecord(value)) {
    throw new Error("provider conformance fixture set must be an object");
  }

  assertTuvrenPrompt(value.prompt, "prompt");
  assertTuvrenModelResponse(value.response, "response");
  assertTuvrenPrompt(value.structuredPrompt, "structuredPrompt");
  assertTuvrenPrompt(value.toolPrompt, "toolPrompt");
}

function assertTuvrenPrompt(
  value: unknown,
  label: string
): asserts value is TuvrenPrompt {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  // The boundary-owned JSON Schema defines the complete prompt shape. This
  // explicit guard keeps the fixture loader's local type narrowing readable.
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new Error(`${label}.messages must be a non-empty array`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
