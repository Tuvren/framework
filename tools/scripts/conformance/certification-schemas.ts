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

interface SchemaScope {
  readonly root: unknown;
  readonly id: string | undefined;
}

const IN_PLACE_LISTS = ["allOf", "anyOf", "oneOf"] as const;
const IN_PLACE_SCHEMAS = ["then", "else"] as const;
const IN_PLACE_MAPS = ["dependentSchemas"] as const;
const CHILD_LISTS = ["prefixItems"] as const;
const CHILD_SCHEMAS = [
  "additionalProperties",
  "unevaluatedProperties",
  "items",
  "unevaluatedItems",
] as const;
const CHILD_MAPS = ["properties", "patternProperties"] as const;

let encodingScope: SchemaScope | undefined;

const loadEncodingScope = (): SchemaScope => {
  if (encodingScope === undefined) {
    const root: unknown = JSON.parse(
      readFileSync(
        nodePath.resolve(
          REPO_ROOT,
          CERTIFICATION_SCHEMA_PATHS.observationEncoding
        ),
        "utf-8"
      )
    );
    encodingScope = {
      id: isRecord(root) && typeof root.$id === "string" ? root.$id : "",
      root,
    };
  }

  return encodingScope;
};

const resolvePointer = (root: unknown, fragment: string): unknown => {
  if (fragment === "") {
    return root;
  }

  if (!fragment.startsWith("/")) {
    return undefined;
  }

  let current = root;

  for (const raw of fragment.slice(1).split("/")) {
    const segment = decodeURIComponent(raw)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");

    if (!(isRecord(current) || Array.isArray(current))) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
};

const scopeForBase = (
  base: string,
  scope: SchemaScope
): SchemaScope | undefined => {
  if (base === "" || base === scope.id) {
    return scope;
  }

  const encoding = loadEncodingScope();
  return base === encoding.id ? encoding : undefined;
};

const resolveRef = (
  ref: string,
  scope: SchemaScope
): { schema: unknown; scope: SchemaScope } | undefined => {
  const [base = "", fragment = ""] = ref.split("#", 2);
  const target = scopeForBase(base, scope);
  const schema =
    target === undefined ? undefined : resolvePointer(target.root, fragment);

  return target === undefined || schema === undefined
    ? undefined
    : { schema, scope: target };
};

const declaresObject = (schema: Record<string, unknown>): boolean =>
  schema.type === "object" ||
  (Array.isArray(schema.type) && schema.type.includes("object")) ||
  isRecord(schema.properties) ||
  isRecord(schema.patternProperties);

const closesObject = (schema: Record<string, unknown>): boolean =>
  schema.additionalProperties === false ||
  schema.unevaluatedProperties === false;

interface SubschemaEdge {
  readonly schema: unknown;
  readonly path: string;
  readonly inPlace: boolean;
}

/** Subschemas other than `$ref`, marked by whether they apply in place. */
const subschemaEdges = (node: Record<string, unknown>): SubschemaEdge[] => {
  const edges: SubschemaEdge[] = [];
  const addList = (keys: readonly string[], inPlace: boolean): void => {
    for (const key of keys) {
      const list = node[key];

      if (Array.isArray(list)) {
        for (const [index, schema] of list.entries()) {
          edges.push({ inPlace, path: `/${key}/${index}`, schema });
        }
      }
    }
  };
  const addMap = (keys: readonly string[], inPlace: boolean): void => {
    for (const key of keys) {
      const map = node[key];

      if (isRecord(map)) {
        for (const [name, schema] of Object.entries(map)) {
          edges.push({ inPlace, path: `/${key}/${name}`, schema });
        }
      }
    }
  };

  addList(IN_PLACE_LISTS, true);
  addMap(IN_PLACE_MAPS, true);
  addList(CHILD_LISTS, false);
  addMap(CHILD_MAPS, false);

  for (const key of IN_PLACE_SCHEMAS) {
    edges.push({ inPlace: true, path: `/${key}`, schema: node[key] });
  }

  for (const key of CHILD_SCHEMAS) {
    edges.push({ inPlace: false, path: `/${key}`, schema: node[key] });
  }

  return edges;
};

/**
 * Reports every object schema reachable from an observation schema that does
 * not close its instance. Subschemas applied in place (allOf, anyOf, oneOf,
 * then/else, dependentSchemas, $ref) inherit closure from their parent;
 * subschemas for nested instances (properties, items, and similar) must close
 * themselves.
 */
const collectOpenObjectSchemas = (schema: unknown, label: string): string[] => {
  const failures: string[] = [];
  const visited = new Map<object, Set<boolean>>();

  const walk = (
    node: unknown,
    scope: SchemaScope,
    path: string,
    closedInPlace: boolean
  ): void => {
    if (!isRecord(node) || visited.get(node)?.has(closedInPlace) === true) {
      return;
    }

    visited.set(node, new Set([...(visited.get(node) ?? []), closedInPlace]));
    const closed = closedInPlace || closesObject(node);

    if (declaresObject(node) && !closed) {
      failures.push(`${label}${path} admits an open object`);
    }

    if (node.$dynamicRef !== undefined) {
      failures.push(`${label}${path} uses an unsupported $dynamicRef`);
    }

    if (typeof node.$ref === "string") {
      const resolved = resolveRef(node.$ref, scope);

      if (resolved === undefined) {
        failures.push(`${label}${path} has unresolvable $ref ${node.$ref}`);
      } else {
        walk(resolved.schema, resolved.scope, `${path}/$ref`, closed);
      }
    }

    for (const edge of subschemaEdges(node)) {
      walk(edge.schema, scope, `${path}${edge.path}`, edge.inPlace && closed);
    }
  };

  const id =
    isRecord(schema) && typeof schema.$id === "string" ? schema.$id : undefined;
  walk(schema, { id, root: schema }, "", false);
  return failures;
};

const collectObservationClosureFailures = (
  operations: readonly Record<string, unknown>[]
): string[] =>
  operations.flatMap((operation) => {
    const { observation } = operation;

    if (!isRecord(observation)) {
      return [];
    }

    return (["result", "events", "state"] as const).flatMap((surface) =>
      Object.hasOwn(observation, surface)
        ? collectOpenObjectSchemas(
            observation[surface],
            `operation ${String(operation.operationId)} observation.${surface}`
          )
        : []
    );
  });

/**
 * Cross-item rules JSON Schema cannot express: unique ids within one
 * catalog, profile file, or control manifest, catalog seams that name
 * catalogued operations, and closure of every object schema reachable from
 * an observation schema.
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
        ...collectObservationClosureFailures(operations),
      ];
    }
    default: {
      const unsupported: never = name;
      return unsupported;
    }
  }
};
