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

const ENCODING_DEFINITIONS = new Set([
  "bytes",
  "safeInteger",
  "hash",
  "identifier",
  "handle",
  "record",
  "map",
]);
const UNSUPPORTED_KEYWORDS = [
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "$dynamicRef",
] as const;
const DIALECT_HINT =
  "use the certification observation dialect: typed schemas with closed objects and direct items, local #/$defs or encoding $refs, anyOf/oneOf, or const/enum";

let encodingId: string | undefined;

const loadEncodingId = (): string => {
  if (encodingId === undefined) {
    const root: unknown = JSON.parse(
      readFileSync(
        nodePath.resolve(
          REPO_ROOT,
          CERTIFICATION_SCHEMA_PATHS.observationEncoding
        ),
        "utf-8"
      )
    );
    encodingId = isRecord(root) && typeof root.$id === "string" ? root.$id : "";
  }

  return encodingId;
};

const escapePointer = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const unescapePointer = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const LOCAL_DEF_REF = /^#\/\$defs\/([^/]+)$/u;

const declaresType = (
  schema: Record<string, unknown>,
  type: "array" | "object"
): boolean =>
  schema.type === type ||
  (Array.isArray(schema.type) && schema.type.includes(type));

interface DialectContext {
  readonly defs: Record<string, unknown>;
  readonly checkedDefs: Set<string>;
  readonly report: (pointer: string, problem: string) => void;
}

type InPlaceDefs = ReadonlySet<string>;

const NO_DEFS: InPlaceDefs = new Set();

/** Why a node is outside the dialect before its keywords are inspected. */
const shapeProblem = (node: unknown, pointer: string): string | undefined => {
  if (node === true) {
    return "is true, which admits any value";
  }

  if (!isRecord(node)) {
    return "is not a schema";
  }

  const unsupported = [
    ...UNSUPPORTED_KEYWORDS.filter((key) => Object.hasOwn(node, key)),
    ...(pointer !== "" && Object.hasOwn(node, "$id") ? ["$id"] : []),
  ];

  if (unsupported.length > 0) {
    return `uses unsupported ${unsupported.join(", ")}`;
  }

  const anchored =
    typeof node.$ref === "string" ||
    Array.isArray(node.anyOf) ||
    Array.isArray(node.oneOf) ||
    node.type !== undefined ||
    Object.hasOwn(node, "const") ||
    Array.isArray(node.enum);

  return anchored
    ? undefined
    : "declares no type, $ref, anyOf, oneOf, const, or enum";
};

const walkDialect = (
  context: DialectContext,
  node: unknown,
  pointer: string,
  inPlaceDefs: InPlaceDefs
): void => {
  if (node === false) {
    return;
  }

  const problem = shapeProblem(node, pointer);

  if (problem !== undefined || !isRecord(node)) {
    context.report(pointer, problem ?? "is not a schema");
    return;
  }

  if (typeof node.$ref === "string") {
    walkDialectRef(context, node.$ref, pointer, inPlaceDefs);
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];

    if (Array.isArray(branches)) {
      for (const [index, branch] of branches.entries()) {
        walkDialect(context, branch, `${pointer}/${key}/${index}`, inPlaceDefs);
      }
    }
  }

  if (declaresType(node, "object")) {
    walkDialectObject(context, node, pointer);
  }

  if (declaresType(node, "array")) {
    walkDialectArray(context, node, pointer);
  }
};

const walkDialectObject = (
  context: DialectContext,
  node: Record<string, unknown>,
  pointer: string
): void => {
  if (
    node.additionalProperties !== false &&
    node.unevaluatedProperties !== false
  ) {
    context.report(
      pointer,
      "is an object type without additionalProperties: false or unevaluatedProperties: false"
    );
  }

  for (const key of ["properties", "patternProperties"] as const) {
    const map = node[key];

    if (isRecord(map)) {
      for (const [name, child] of Object.entries(map)) {
        walkDialect(
          context,
          child,
          `${pointer}/${key}/${escapePointer(name)}`,
          NO_DEFS
        );
      }
    }
  }

  if (Object.hasOwn(node, "additionalProperties")) {
    walkDialect(
      context,
      node.additionalProperties,
      `${pointer}/additionalProperties`,
      NO_DEFS
    );
  }
};

const walkDialectArray = (
  context: DialectContext,
  node: Record<string, unknown>,
  pointer: string
): void => {
  if (Object.hasOwn(node, "items")) {
    walkDialect(context, node.items, `${pointer}/items`, NO_DEFS);
  } else {
    context.report(pointer, "is an array type without a direct items schema");
  }

  if (Array.isArray(node.prefixItems)) {
    for (const [index, child] of node.prefixItems.entries()) {
      walkDialect(context, child, `${pointer}/prefixItems/${index}`, NO_DEFS);
    }
  }
};

const walkDialectRef = (
  context: DialectContext,
  ref: string,
  pointer: string,
  inPlaceDefs: InPlaceDefs
): void => {
  const encodingPrefix = `${loadEncodingId()}#/$defs/`;

  if (ref.startsWith(encodingPrefix)) {
    if (!ENCODING_DEFINITIONS.has(ref.slice(encodingPrefix.length))) {
      context.report(
        pointer,
        `has $ref ${ref}, which is not an encoding definition (${[...ENCODING_DEFINITIONS].join(", ")})`
      );
    }
    return;
  }

  const escaped = LOCAL_DEF_REF.exec(ref)?.[1];
  const name = escaped === undefined ? undefined : unescapePointer(escaped);

  if (name === undefined || !Object.hasOwn(context.defs, name)) {
    context.report(
      pointer,
      `has $ref ${ref}, which is neither a local #/$defs entry nor an encoding definition`
    );
  } else if (inPlaceDefs.has(name)) {
    context.report(
      pointer,
      `has $ref ${ref}, which cycles in place without descending into a property or item`
    );
  } else if (!context.checkedDefs.has(name)) {
    context.checkedDefs.add(name);
    walkDialect(
      context,
      context.defs[name],
      `/$defs/${escapePointer(name)}`,
      new Set([...inPlaceDefs, name])
    );
  }
};

/**
 * Enforces the certification observation dialect (ADR-0075 decision 3). Every
 * reachable subschema is `false`, a `$ref` to a local `#/$defs/<name>` or to an
 * encoding definition, `anyOf`/`oneOf` of dialect branches, `const`/`enum`, or
 * an explicitly typed schema whose object types close and whose array types
 * carry a direct `items` schema. Valid but composed schemas outside this
 * dialect are rejected on purpose.
 */
const collectDialectViolations = (schema: unknown, label: string): string[] => {
  const failures: string[] = [];
  const context: DialectContext = {
    checkedDefs: new Set(),
    defs: isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : {},
    report: (pointer, problem) => {
      failures.push(`${label}#${pointer} ${problem}; ${DIALECT_HINT}`);
    },
  };

  walkDialect(context, schema, "", NO_DEFS);
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
        ? collectDialectViolations(
            observation[surface],
            `operation ${String(operation.operationId)} observation.${surface}`
          )
        : []
    );
  });

/**
 * Cross-item rules JSON Schema cannot express: unique ids within one
 * catalog, profile file, or control manifest, catalog seams that name
 * catalogued operations, and the certification observation dialect for
 * every observation schema.
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
