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
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import { assertTuvrenStreamEvent } from "@tuvren/event-stream";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

export interface FrameworkStreamTestFixtureSet {
  completedTurn: readonly TuvrenStreamEvent[];
  failedTurn: readonly TuvrenStreamEvent[];
  pausedTurn: readonly TuvrenStreamEvent[];
}

const MANIFEST_PATH_SEGMENTS = [
  "conformance",
  "scenarios",
  "suite-manifest.json",
];
const ajv = new Ajv2020({ allErrors: true, strict: false });

export const frameworkStreamTestFixtures: FrameworkStreamTestFixtureSet =
  loadFrameworkStreamFixtures();

function loadFrameworkStreamFixtures(): FrameworkStreamTestFixtureSet {
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
    "framework conformance fixture"
  );
  assertFrameworkStreamTestFixtureSet(parsedFixture);
  return parsedFixture;
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

  throw new Error("unable to locate framework conformance fixture file");
}

function readConformanceManifest(manifestPath: string): {
  fixturePath: string;
  fixtureSchemaPath: string;
} {
  const manifestText = readFileSync(manifestPath, "utf8");
  const parsedManifest = JSON.parse(manifestText);

  if (
    !isRecord(parsedManifest) ||
    typeof parsedManifest.fixtureSchemaPath !== "string" ||
    !Array.isArray(parsedManifest.fixtures) ||
    parsedManifest.fixtures.length !== 1
  ) {
    throw new Error("framework conformance manifest is invalid");
  }

  const [fixture] = parsedManifest.fixtures;

  if (!isRecord(fixture) || typeof fixture.path !== "string") {
    throw new Error("framework conformance manifest fixture entry is invalid");
  }

  return {
    fixturePath: fixture.path,
    fixtureSchemaPath: parsedManifest.fixtureSchemaPath,
  };
}

function readJsonSchema(value: unknown): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error("framework conformance schema must be an object or boolean");
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

function assertFrameworkStreamTestFixtureSet(
  value: unknown
): asserts value is FrameworkStreamTestFixtureSet {
  if (!isRecord(value)) {
    throw new Error("framework conformance fixture set must be an object");
  }

  assertTuvrenStreamEventArray(value.completedTurn, "completedTurn");
  assertTuvrenStreamEventArray(value.failedTurn, "failedTurn");
  assertTuvrenStreamEventArray(value.pausedTurn, "pausedTurn");
}

function assertTuvrenStreamEventArray(
  value: unknown,
  label: string
): asserts value is readonly TuvrenStreamEvent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  for (const [index, event] of value.entries()) {
    assertTuvrenStreamEvent(event, `${label}[${index}]`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
