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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import {
  assertConformanceEvidence,
  assertConformanceSuiteManifest,
  type ConformanceEvidence,
  type ConformanceSuiteManifest,
  type SuiteCheck,
} from "./conformance-contract.js";

const SUITE_MANIFEST_SCHEMA_RELATIVE_PATH =
  "../schemas/suite-manifest.schema.json";

export async function readConformanceSuiteManifest(
  manifestPath: string
): Promise<ConformanceSuiteManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  // The suite manifest schema lives next to the owning boundary instead of
  // being referenced from inside the manifest. Keeping that path conventional
  // avoids a second layer of manifest indirection that could drift silently.
  const schemaPath = resolve(
    dirname(manifestPath),
    SUITE_MANIFEST_SCHEMA_RELATIVE_PATH
  );
  const schema = readJsonSchema(
    JSON.parse(await readFile(schemaPath, "utf8")) as unknown,
    schemaPath
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  if (!validate(manifest)) {
    throw new Error(
      `${manifestPath} failed JSON Schema validation: ${ajv.errorsText(validate.errors)}`
    );
  }

  assertConformanceSuiteManifest(manifest, manifestPath);
  return manifest;
}

export function selectImplementationChecks(
  manifest: ConformanceSuiteManifest,
  implementationId: string
): readonly SuiteCheck[] {
  return manifest.checks.filter((check) =>
    check.implementations?.includes(implementationId)
  );
}

export function emitConformanceEvidence(evidence: ConformanceEvidence): void {
  assertConformanceEvidence(evidence, "conformance evidence");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

  if (evidence.status !== "pass") {
    process.exitCode = 1;
  }
}

function readJsonSchema(value: unknown, label: string): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
