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
import type { TuvrenModelResponse, TuvrenPrompt } from "@tuvren/provider-api";
import { assertTuvrenModelResponse } from "@tuvren/provider-api";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

/**
 * The prompt/response fixtures loaded from `spec/conformance/providers/`,
 * schema-validated at module init.
 */
export interface ProviderTestkitFixtureSet {
  prompt: TuvrenPrompt;
  response: TuvrenModelResponse;
  structuredPrompt: TuvrenPrompt;
  toolPrompt: TuvrenPrompt;
}

// Walk-up probe segments are repo-root-anchored since 87-M4.1 moved the
// providers conformance tree to spec/conformance/providers/ — the ancestor
// walk now terminates at the repository root regardless of where this
// package lives in the language tree.
/** Repo-root-relative path segments to the providers conformance suite manifest. */
const MANIFEST_PATH_SEGMENTS = [
  "spec",
  "conformance",
  "providers",
  "scenarios",
  "suite-manifest.json",
];
/** Path to the manifest's own JSON Schema, relative to the manifest file. */
const MANIFEST_SCHEMA_RELATIVE_PATH = "../schemas/suite-manifest.schema.json";
/** Shared Ajv (2020-12 dialect) instance used to validate the manifest and its fixture. */
const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * The schema-validated fixture set (prompts, response) shared by provider
 * conformance tests, loaded once at module init from
 * `spec/conformance/providers/`. See {@link providerTestkitFixtures} in
 * `provider-testkit.ts` for the re-export public consumers import.
 */
export const providerTestkitFixtures: ProviderTestkitFixtureSet =
  loadProviderTestkitFixtures();

/**
 * Locates the providers conformance suite manifest, reads its declared
 * fixture and fixture schema, validates the fixture against that schema,
 * and asserts it satisfies {@link ProviderTestkitFixtureSet}.
 *
 * @throws Error when the manifest cannot be located, is malformed, or the
 *   fixture fails schema validation or shape assertion.
 */
function loadProviderTestkitFixtures(): ProviderTestkitFixtureSet {
  const manifestPath = resolveFixturePath(
    import.meta.url,
    MANIFEST_PATH_SEGMENTS
  );
  const manifest = readConformanceManifest(manifestPath);
  const fixturePath = join(dirname(manifestPath), manifest.fixturePath);
  const schemaPath = join(dirname(manifestPath), manifest.fixtureSchemaPath);
  const fixtureText = readFileSync(fixturePath, "utf8");
  const schemaText = readFileSync(schemaPath, "utf8");
  const parsedFixture = JSON.parse(fixtureText);
  const parsedSchema = readJsonSchema(JSON.parse(schemaText));
  assertSchemaValid(
    parsedSchema,
    parsedFixture,
    "provider conformance fixture"
  );
  assertProviderTestkitFixtureSet(parsedFixture);
  return parsedFixture;
}

/**
 * Walks up from `metaUrl`'s directory looking for `pathSegments` joined onto
 * each ancestor, returning the first match.
 *
 * @throws Error when no ancestor within 8 levels contains the path.
 */
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

/**
 * Reads and schema-validates the suite manifest, then extracts its single
 * declared fixture's path plus the fixture schema path.
 *
 * @throws Error when the manifest fails schema validation, does not declare
 *   exactly one fixture, or that fixture entry is malformed.
 */
function readConformanceManifest(manifestPath: string): {
  fixturePath: string;
  fixtureSchemaPath: string;
} {
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifestSchemaText = readFileSync(
    join(dirname(manifestPath), MANIFEST_SCHEMA_RELATIVE_PATH),
    "utf8"
  );
  const parsedManifest = JSON.parse(manifestText);
  const parsedManifestSchema = readJsonSchema(JSON.parse(manifestSchemaText));
  assertSchemaValid(
    parsedManifestSchema,
    parsedManifest,
    "provider conformance manifest"
  );

  if (
    !isRecord(parsedManifest) ||
    typeof parsedManifest.fixtureSchemaPath !== "string" ||
    !Array.isArray(parsedManifest.fixtures) ||
    parsedManifest.fixtures.length !== 1
  ) {
    throw new Error("provider conformance manifest is invalid");
  }

  const [fixture] = parsedManifest.fixtures;

  if (!isRecord(fixture) || typeof fixture.path !== "string") {
    throw new Error("provider conformance manifest fixture entry is invalid");
  }

  return {
    fixturePath: fixture.path,
    fixtureSchemaPath: parsedManifest.fixtureSchemaPath,
  };
}

/**
 * Narrows a parsed JSON value to an Ajv `AnySchema` (boolean or object).
 *
 * @throws Error when the value is neither.
 */
function readJsonSchema(value: unknown): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error("provider conformance schema must be an object or boolean");
}

/**
 * Compiles `schema` with the shared Ajv instance and asserts `value`
 * validates against it.
 *
 * @throws Error with the Ajv error text when validation fails.
 */
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

/**
 * Asserts a parsed fixture value has the `prompt`/`response`/
 * `structuredPrompt`/`toolPrompt` shape of {@link ProviderTestkitFixtureSet}.
 *
 * @throws Error when the value or any of its required fields is malformed.
 */
function assertProviderTestkitFixtureSet(
  value: unknown
): asserts value is ProviderTestkitFixtureSet {
  if (!isRecord(value)) {
    throw new Error("provider conformance fixture set must be an object");
  }

  assertTuvrenPrompt(value.prompt, "prompt");
  assertTuvrenModelResponse(value.response, "response");
  assertTuvrenPrompt(value.structuredPrompt, "structuredPrompt");
  assertTuvrenPrompt(value.toolPrompt, "toolPrompt");
}

/**
 * Asserts a value is at least shaped like a `TuvrenPrompt` (a non-empty
 * `messages` array). The manifest-declared JSON Schema (validated earlier in
 * {@link loadProviderTestkitFixtures}) owns the full prompt shape; this is
 * only a narrowing guard for TypeScript.
 *
 * @throws Error when the value is not an object or `messages` is not a
 *   non-empty array.
 */
function assertTuvrenPrompt(
  value: unknown,
  label: string
): asserts value is TuvrenPrompt {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  // The manifest-declared JSON Schema above owns the full prompt shape. This
  // focused guard keeps the loader's TypeScript narrowing explicit until the
  // public provider contract exports a dedicated prompt assertion helper.
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new Error(`${label}.messages must be a non-empty array`);
  }
}

/** True when a value is a non-null object (loose record predicate; no plain-object or key-shape checks). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
