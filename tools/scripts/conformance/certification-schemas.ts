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

import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");

export const CERTIFICATION_SCHEMA_PATHS = {
  authorityPacket: "tools/schemas/authority-packet.schema.json",
  certificationEvidence: "tools/schemas/certification-evidence.schema.json",
  certificationProfile: "tools/schemas/certification-profile.schema.json",
  conformancePlan: "tools/schemas/conformance-plan.schema.json",
  negativeControlManifest:
    "tools/schemas/negative-control-manifest.schema.json",
  observationEncoding:
    "tools/schemas/conformance-observation-encoding.schema.json",
  operationCatalog: "tools/schemas/conformance-operation-catalog.schema.json",
} as const;

export type CertificationSchemaName = keyof typeof CERTIFICATION_SCHEMA_PATHS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

let validators:
  | ReadonlyMap<CertificationSchemaName, ValidateFunction>
  | undefined;

const loadValidators = (): ReadonlyMap<
  CertificationSchemaName,
  ValidateFunction
> => {
  if (validators !== undefined) {
    return validators;
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  const ids = new Map<CertificationSchemaName, string>();

  for (const [name, relativePath] of Object.entries(
    CERTIFICATION_SCHEMA_PATHS
  ) as [CertificationSchemaName, string][]) {
    const schema: unknown = JSON.parse(
      readFileSync(nodePath.resolve(REPO_ROOT, relativePath), "utf-8")
    );

    if (!isRecord(schema) || typeof schema.$id !== "string") {
      throw new Error(`${relativePath} must be a JSON Schema with an $id`);
    }

    ajv.addSchema(schema);
    ids.set(name, schema.$id);
  }

  const compiled = new Map<CertificationSchemaName, ValidateFunction>();

  for (const [name, id] of ids) {
    const validate = ajv.getSchema(id);

    if (validate === undefined) {
      throw new Error(`${name} schema did not compile`);
    }

    compiled.set(name, validate);
  }

  validators = compiled;
  return compiled;
};

/** Returns schema violations as `<instancePath> <message>` strings. */
export const validateCertificationDocument = (
  name: CertificationSchemaName,
  value: unknown
): readonly string[] => {
  const validate = loadValidators().get(name);

  if (validate === undefined) {
    throw new Error(`unknown certification schema ${name}`);
  }

  if (validate(value)) {
    return [];
  }

  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
};

const readRecords = (value: unknown, key: string): Record<string, unknown>[] =>
  isRecord(value) && Array.isArray(value[key])
    ? value[key].filter((entry) => isRecord(entry))
    : [];

const duplicateIds = (
  records: readonly Record<string, unknown>[],
  key: string
): string[] => {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const record of records) {
    const id = record[key];

    if (typeof id !== "string") {
      continue;
    }

    if (seen.has(id)) {
      duplicates.push(`duplicate ${key} ${id}`);
    }

    seen.add(id);
  }

  return duplicates;
};

/**
 * Cross-item rules JSON Schema cannot express: unique ids within one
 * catalog, profile file, or control manifest, and catalog seams that name
 * catalogued operations.
 */
export const collectCertificationIntegrityFailures = (
  name: "certificationProfile" | "negativeControlManifest" | "operationCatalog",
  value: unknown
): readonly string[] => {
  switch (name) {
    case "certificationProfile": {
      return duplicateIds(readRecords(value, "profiles"), "profileId");
    }
    case "negativeControlManifest": {
      return duplicateIds(readRecords(value, "controls"), "mutantId");
    }
    case "operationCatalog": {
      const operations = readRecords(value, "operations");
      const seams = readRecords(value, "seams");
      const operationIds = new Set(
        operations.map((operation) => operation.operationId)
      );
      const unknownSeamOperations = seams.flatMap((seam) =>
        (Array.isArray(seam.operationIds) ? seam.operationIds : [])
          .filter((operationId) => !operationIds.has(operationId))
          .map(
            (operationId) =>
              `seam ${String(seam.seamId)} names uncatalogued operation ${String(operationId)}`
          )
      );
      return [
        ...duplicateIds(operations, "operationId"),
        ...duplicateIds(seams, "seamId"),
        ...unknownSeamOperations,
      ];
    }
    default: {
      const unsupported: never = name;
      return unsupported;
    }
  }
};
