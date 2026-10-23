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

import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { collectPlanEvidenceOracleShapeFailures } from "../../scripts/authority-guardrails/authority-guardrails.js";
import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../scripts/conformance/certification-schemas.js";
import {
  controlConsumesInstance,
  controlInputProblem,
} from "./control-input.js";
import type {
  ConformancePlan,
  ConformancePlanAssertion,
  ConformancePlanCheck,
  ConformancePlanStep,
  ConformancePlanValueOperators,
} from "./index.js";

/** ADR-0075 decisions 4 and 5, plus ADR-0030's evidence rule. */
export const CERTIFICATION_RULE_IDS = [
  "operation-catalogued",
  "control-input",
  "fault-action",
  "observation-path",
  "literal-boolean",
  "no-echo",
  "integrity-observation",
  "expected-root-reference",
  "evidence-only-proof",
] as const;

export type CertificationRuleId = (typeof CERTIFICATION_RULE_IDS)[number];

export interface CertificationViolation {
  /** Absent for plan-level violations. */
  checkId?: string;
  message: string;
  rule: CertificationRuleId;
  stepId?: string;
}

type JsonSchema = boolean | Record<string, unknown>;
type ObservationDomain = "events" | "result" | "state";

export interface CatalogOperation {
  deprecated?: boolean;
  input?: JsonSchema;
  handles?: { consumes?: readonly string[] };
  faultOutcome?: { code: string; unsupportedCode: string };
  errors?: readonly string[];
  kind: "control" | "double" | "syscall";
  observation: Partial<Record<ObservationDomain, JsonSchema>>;
  operationId: string;
}

export interface OperationCatalog {
  catalogId: string;
  operations: ReadonlyMap<string, CatalogOperation>;
  packetId: string;
}

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const SCHEMA_ROOT = nodePath.resolve(REPO_ROOT, "tools/schemas");
const OBSERVATION_DOMAINS: readonly ObservationDomain[] = [
  "events",
  "result",
  "state",
];
const EXTERNAL_ROOTS = new Set(["capture", "fixture", "input", "scenario"]);
const EXPECTED_SOURCE_ROOTS = new Set(["fixture", "input", "scenario"]);
const ARGUMENT_REFERENCE_PATTERN =
  /^(?:input|fixture\.input|capture)(?:\.[^.]+)+$/u;
const ARRAY_INDEX_PATTERN = /^\d+$/u;
const EVIDENCE_ONLY_GUARDRAIL_CHECKS = new Set([
  "plan-decisive-assertion",
  "plan-oracle-shape",
  "step-decisive-assertion",
]);
const OPERAND_PATH_KEYS = [
  "equalsPath",
  "notEqualsPath",
  "containsPath",
] as const satisfies readonly (keyof ConformancePlanValueOperators)[];
const NUMERIC_OPERAND_KEYS = [
  "greaterThan",
  "greaterThanOrEqual",
  "length",
  "lessThan",
  "lessThanOrEqual",
] as const satisfies readonly (keyof ConformancePlanValueOperators)[];
const LITERAL_EQUALITY_KEYS = ["equals", "notEquals"] as const;

const EACH = Symbol("each array element");
const REFERENCE_EACH = Symbol("each reference collection member");
type PathSegment = string | typeof EACH | typeof REFERENCE_EACH;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonSchema = (value: unknown): value is JsonSchema =>
  typeof value === "boolean" || isRecord(value);

let schemaRegistry: ReadonlyMap<string, unknown> | undefined;

const loadSchemaRegistry = (): ReadonlyMap<string, unknown> => {
  if (schemaRegistry !== undefined) {
    return schemaRegistry;
  }

  const registry = new Map<string, unknown>();

  for (const name of readdirSync(SCHEMA_ROOT).toSorted()) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const schema: unknown = JSON.parse(
      readFileSync(nodePath.resolve(SCHEMA_ROOT, name), "utf-8")
    );

    if (isRecord(schema) && typeof schema.$id === "string") {
      registry.set(schema.$id, schema);
    }
  }

  schemaRegistry = registry;
  return registry;
};

const readOperation = (value: Record<string, unknown>): CatalogOperation => {
  const observation: Partial<Record<ObservationDomain, JsonSchema>> = {};
  const declared = isRecord(value.observation) ? value.observation : {};

  for (const domain of OBSERVATION_DOMAINS) {
    const schema = declared[domain];

    if (isJsonSchema(schema)) {
      observation[domain] = schema;
    }
  }

  return {
    ...(isJsonSchema(value.input) ? { input: value.input } : {}),
    ...(isRecord(value.handles) && Array.isArray(value.handles.consumes)
      ? { handles: { consumes: value.handles.consumes.map(String) } }
      : {}),
    ...(isRecord(value.faultOutcome) &&
    typeof value.faultOutcome.code === "string" &&
    typeof value.faultOutcome.unsupportedCode === "string"
      ? {
          faultOutcome: {
            code: value.faultOutcome.code,
            unsupportedCode: value.faultOutcome.unsupportedCode,
          },
        }
      : {}),
    deprecated: value.deprecated === true,
    errors: Array.isArray(value.errors) ? value.errors.map(String) : [],
    kind: value.kind as CatalogOperation["kind"],
    observation,
    operationId: String(value.operationId),
  };
};

/** Validates against the pinned catalog schema before reading anything. */
export const parseOperationCatalog = (
  value: unknown,
  label: string
): OperationCatalog => {
  const failures = [
    ...validateCertificationDocument("operationCatalog", value),
    ...collectCertificationIntegrityFailures("operationCatalog", value),
  ];

  if (failures.length > 0 || !isRecord(value)) {
    throw new Error(
      `${label} is not a valid operation catalog: ${failures.join("; ")}`
    );
  }

  const operations = new Map<string, CatalogOperation>();

  for (const entry of Array.isArray(value.operations) ? value.operations : []) {
    if (isRecord(entry)) {
      const operation = readOperation(entry);
      operations.set(operation.operationId, operation);
    }
  }

  return {
    catalogId: String(value.catalogId),
    operations,
    packetId: String(value.packetId),
  };
};

const splitContextPath = (path: string): PathSegment[] | undefined => {
  if (path === "$") {
    return [];
  }

  return path.startsWith("$.") ? path.slice(2).split(".") : undefined;
};

const renderPath = (segments: readonly PathSegment[]): string =>
  segments
    .map((segment) => (typeof segment === "symbol" ? "[*]" : segment))
    .join(".");

const isPrefix = (
  prefix: readonly PathSegment[],
  path: readonly PathSegment[]
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const pathsOverlap = (
  left: readonly PathSegment[],
  right: readonly PathSegment[]
): boolean => isPrefix(left, right) || isPrefix(right, left);

interface SchemaNode {
  document: unknown;
  schema: JsonSchema;
}

const readPointer = (document: unknown, fragment: string): unknown => {
  if (fragment === "") {
    return document;
  }

  if (!fragment.startsWith("/")) {
    return undefined;
  }

  let current = document;

  for (const raw of fragment.slice(1).split("/")) {
    const key = decodeURIComponent(raw)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    current =
      isRecord(current) || Array.isArray(current)
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }

  return current;
};

const dereference = (
  node: SchemaNode,
  reference: string
): SchemaNode | undefined => {
  const hashIndex = reference.indexOf("#");
  const base = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
  const document =
    base === "" || (isRecord(node.document) && node.document.$id === base)
      ? node.document
      : loadSchemaRegistry().get(base);
  const target = readPointer(document, fragment);

  return document !== undefined && isJsonSchema(target)
    ? { document, schema: target }
    : undefined;
};

const expandSchema = (
  node: SchemaNode,
  seen = new Set<unknown>()
): SchemaNode[] => {
  if (typeof node.schema === "boolean") {
    return [node];
  }

  if (seen.has(node.schema)) {
    return [];
  }

  seen.add(node.schema);
  const { schema } = node;
  const nodes: SchemaNode[] = [node];
  const branches: unknown[] = [schema.then, schema.else];

  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const value = schema[key];

    if (Array.isArray(value)) {
      branches.push(...value);
    }
  }

  if (typeof schema.$ref === "string") {
    const target = dereference(node, schema.$ref);

    if (target !== undefined) {
      nodes.push(...expandSchema(target, seen));
    }
  }

  for (const branch of branches) {
    if (isJsonSchema(branch)) {
      nodes.push(
        ...expandSchema({ document: node.document, schema: branch }, seen)
      );
    }
  }

  return nodes;
};

const arrayChildSchemas = (
  schema: Record<string, unknown>,
  segment: PathSegment
): unknown[] => {
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : [];

  if (segment === EACH || segment === REFERENCE_EACH) {
    return [...prefixItems, schema.items];
  }

  if (!ARRAY_INDEX_PATTERN.test(segment)) {
    return [];
  }

  return [prefixItems[Number(segment)] ?? schema.items];
};

const objectChildSchemas = (
  schema: Record<string, unknown>,
  segment: string
): unknown[] => {
  const declared: unknown[] = [];

  if (
    isRecord(schema.properties) &&
    Object.hasOwn(schema.properties, segment)
  ) {
    declared.push(schema.properties[segment]);
  }

  if (isRecord(schema.patternProperties)) {
    for (const [pattern, value] of Object.entries(schema.patternProperties)) {
      if (new RegExp(pattern, "u").test(segment)) {
        declared.push(value);
      }
    }
  }

  if (declared.length === 0 && schema.additionalProperties !== false) {
    declared.push(schema.additionalProperties);
  }

  return declared;
};

const childSchemas = (node: SchemaNode, segment: PathSegment): SchemaNode[] => {
  if (typeof node.schema === "boolean") {
    return [];
  }

  const children = arrayChildSchemas(node.schema, segment);
  if (segment === REFERENCE_EACH) {
    children.push(
      ...Object.values(
        isRecord(node.schema.properties) ? node.schema.properties : {}
      ),
      ...Object.values(
        isRecord(node.schema.patternProperties)
          ? node.schema.patternProperties
          : {}
      ),
      node.schema.additionalProperties
    );
  } else if (segment !== EACH) {
    children.push(...objectChildSchemas(node.schema, segment));
  }

  return children
    .filter((child) => isJsonSchema(child) && child !== false)
    .flatMap((child) =>
      expandSchema({ document: node.document, schema: child as JsonSchema })
    );
};

/** Expanded leaf candidates; empty when the schema does not declare the path. */
const resolveSchemaPath = (
  root: SchemaNode,
  segments: readonly PathSegment[]
): SchemaNode[] => {
  let frontier = expandSchema(root);

  for (const segment of segments) {
    frontier = frontier.flatMap((node) => childSchemas(node, segment));
  }

  return frontier;
};

const isBooleanLeaf = (nodes: readonly SchemaNode[]): boolean =>
  nodes.some(
    ({ schema }) =>
      typeof schema !== "boolean" &&
      (schema.type === "boolean" ||
        (Array.isArray(schema.type) && schema.type.includes("boolean")) ||
        typeof schema.const === "boolean")
  );

type AssertionScope =
  | { kind: "operation"; operationId: string }
  | { kind: "trace"; stepOperations: ReadonlyMap<string, string> };

type PathTarget =
  | { kind: "external"; segments: readonly PathSegment[] }
  | { kind: "invalid"; reason: string }
  | {
      domain: ObservationDomain;
      kind: "observation";
      operationId: string;
      segments: readonly PathSegment[];
    };

const locatePath = (
  segments: readonly PathSegment[],
  scope: AssertionScope
): PathTarget => {
  const [root, ...rest] = segments;

  if (typeof root === "string" && EXTERNAL_ROOTS.has(root)) {
    return { kind: "external", segments };
  }

  if (scope.kind === "trace") {
    const [traceKey, stepId] = rest;

    if (
      (root === "result" || root === "state" || root === "evidence") &&
      traceKey === "trace" &&
      typeof stepId === "string"
    ) {
      const operationId = scope.stepOperations.get(stepId);

      return operationId === undefined
        ? { kind: "invalid", reason: `names unknown trace step ${stepId}` }
        : locatePath(rest.slice(2), { kind: "operation", operationId });
    }

    return {
      kind: "invalid",
      reason: `reads $.${renderPath(segments)}, which is not inside a trace step observation`,
    };
  }

  if (root === "result" || root === "state" || root === "events") {
    return {
      domain: root,
      kind: "observation",
      operationId: scope.operationId,
      segments: rest,
    };
  }

  if (root === "evidence") {
    return {
      kind: "invalid",
      reason: `reads $.${renderPath(segments)}; adapter evidence is diagnostic, not an observation domain`,
    };
  }

  return {
    kind: "invalid",
    reason: `reads $.${renderPath(segments)}, which is not an observation path`,
  };
};

const prefixed = (
  root: string,
  path: string | undefined
): PathSegment[] | undefined => {
  const segments = splitContextPath(path ?? "$");
  return segments === undefined ? undefined : [root, ...segments];
};

const eventProjection = (path: string): PathSegment[] | undefined => {
  const segments = splitContextPath(path);
  return segments === undefined ? undefined : ["events", EACH, ...segments];
};

const assertionActualPath = (
  assertion: ConformancePlanAssertion
): PathSegment[] | undefined => {
  switch (assertion.kind) {
    case "resultField":
    case "secretAbsence":
    case "secretPatternAbsence": {
      return prefixed("result", assertion.field);
    }
    case "stateField": {
      return prefixed("state", assertion.field);
    }
    case "evidenceField": {
      return prefixed("evidence", assertion.field);
    }
    case "errorEnvelope": {
      return splitContextPath(assertion.path ?? "$.result.error");
    }
    case "faultActivated":
    case "digest":
    case "canonicalCbor":
    case "identity":
    case "referenceWalk":
    case "schemaValid": {
      return splitContextPath(assertion.path ?? "$.result");
    }
    case "eventSequence":
    case "noEvent":
    case "ordering": {
      return eventProjection(assertion.path ?? "$.type");
    }
    case "terminalEvent": {
      return eventProjection(
        assertion.path ?? (assertion.eventType === undefined ? "$" : "$.type")
      );
    }
    default: {
      const unsupported: never = assertion.kind;
      return unsupported;
    }
  }
};

interface OperatorNode {
  actual: PathSegment[] | undefined;
  label: string;
  operators: ConformancePlanValueOperators;
}

const operatorNodes = (
  operators: ConformancePlanValueOperators,
  actual: PathSegment[] | undefined,
  label: string
): OperatorNode[] => [
  { actual, label, operators },
  ...(["every", "some"] as const).flatMap((quantifier) => {
    const element = operators[quantifier];

    if (element === undefined) {
      return [];
    }

    const field = splitContextPath(element.field ?? "$");
    return operatorNodes(
      element,
      actual === undefined || field === undefined
        ? undefined
        : [...actual, EACH, ...field],
      `${label} ${quantifier}`
    );
  }),
];

const operandPaths = (operators: ConformancePlanValueOperators): string[] =>
  [
    ...OPERAND_PATH_KEYS.map((key) => operators[key]),
    ...NUMERIC_OPERAND_KEYS.map((key) => operators[key]),
  ].filter((operand): operand is string => typeof operand === "string");

/** Uses the compiler's assertion paths and capture provenance to identify native-error proof. */
export const nativeErrorAsserted = (
  check: ConformancePlanCheck,
  step?: ConformancePlanStep
): boolean => {
  const targetId = step?.stepId ?? check.operation;
  const captures = new Map<string, { path: PathSegment[]; stepId: string }>();
  const observesError = (
    segments: PathSegment[] | undefined,
    scope: AssertionScope
  ): boolean => {
    if (segments === undefined) {
      return false;
    }
    let target: PathTarget;
    if (segments[0] === "capture" && typeof segments[1] === "string") {
      const captured = captures.get(segments[1]);
      if (captured === undefined) {
        return false;
      }
      target = locatePath([...captured.path, ...segments.slice(2)], {
        kind: "operation",
        operationId: captured.stepId,
      });
    } else {
      target = locatePath(segments, scope);
    }
    return (
      target.kind === "observation" &&
      target.operationId === targetId &&
      target.domain === "state" &&
      target.segments[0] === "adapterError"
    );
  };
  const asserted = (
    assertions: readonly ConformancePlanAssertion[],
    scope: AssertionScope
  ): boolean =>
    assertions.some((assertion) =>
      operatorNodes(
        assertion,
        assertionActualPath(assertion),
        "native error"
      ).some(
        (node) =>
          observesError(node.actual, scope) ||
          operandPaths(node.operators).some((path) =>
            observesError(splitContextPath(path), scope)
          )
      )
    );
  const steps = check.steps ?? [];
  for (const current of steps) {
    for (const capture of current.capture ?? []) {
      captures.set(capture.name, {
        path: capture.path.split("."),
        stepId: current.stepId,
      });
    }
    if (
      asserted(current.assertions ?? [], {
        kind: "operation",
        operationId: current.stepId,
      })
    ) {
      return true;
    }
  }
  return asserted(
    check.assertions,
    steps.length === 0
      ? { kind: "operation", operationId: check.operation }
      : {
          kind: "trace",
          stepOperations: new Map(
            steps.map((current) => [current.stepId, current.stepId])
          ),
        }
  );
};

interface RuleContext {
  catalog: OperationCatalog | undefined;
  checkId: string;
  stepId?: string;
  violations: CertificationViolation[];
}

const report = (
  context: RuleContext,
  rule: CertificationRuleId,
  message: string
): void => {
  context.violations.push({
    checkId: context.checkId,
    message,
    rule,
    ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
  });
};

const subject = (context: RuleContext): string =>
  context.stepId === undefined
    ? `check ${context.checkId}`
    : `check ${context.checkId} step ${context.stepId}`;

/** Local `$ref`s resolve within the observation schema, as integrity validation does. */
const observationRoot = (schema: JsonSchema): SchemaNode => ({
  document: schema,
  schema,
});

/** The schema problem with an observation target, or undefined when it resolves. */
const observationProblem = (
  catalog: OperationCatalog,
  target: Extract<PathTarget, { kind: "observation" }>
): string | undefined => {
  const operation = catalog.operations.get(target.operationId);

  if (operation === undefined) {
    return `reads ${target.domain} of uncatalogued operation ${target.operationId}`;
  }

  if (
    target.domain === "state" &&
    target.segments.length === 0 &&
    (operation.errors?.length ?? 0) > 0
  ) {
    return "reads an ancestor of state.adapterError; assert the native error explicitly";
  }

  if (
    target.domain === "state" &&
    target.segments[0] === "adapterError" &&
    (target.segments.length === 1 ||
      (target.segments.length === 2 &&
        ["code", "message"].includes(String(target.segments[1])))) &&
    (operation.errors?.length ?? 0) > 0
  ) {
    return undefined;
  }

  const schema = operation.observation[target.domain];

  if (schema === undefined) {
    return `reads ${target.domain}, which ${target.operationId} does not observe`;
  }

  const leaves = resolveSchemaPath(observationRoot(schema), target.segments);

  return leaves.length === 0
    ? `reads ${target.domain}.${renderPath(target.segments)}, which the ${target.operationId} observation schema does not declare`
    : undefined;
};

const nativeErrorEqualityProblem = (
  catalog: OperationCatalog,
  target: Extract<PathTarget, { kind: "observation" }>,
  equals: unknown
): string | undefined => {
  if (
    target.domain !== "state" ||
    target.segments[0] !== "adapterError" ||
    target.segments[1] === "message" ||
    equals === undefined
  ) {
    return undefined;
  }
  const code =
    target.segments.length === 1 && isRecord(equals) ? equals.code : equals;
  const errors = catalog.operations.get(target.operationId)?.errors ?? [];
  return typeof code === "string" && errors.includes(code)
    ? undefined
    : `asserts an error code not declared by ${target.operationId}`;
};

const checkObservationPath = (
  context: RuleContext,
  scope: AssertionScope,
  segments: PathSegment[] | undefined,
  label: string,
  allowExternal: boolean,
  equals?: unknown
): boolean => {
  if (context.catalog === undefined) {
    return true;
  }

  if (segments === undefined) {
    report(
      context,
      "observation-path",
      `${subject(context)} ${label} is not a $-rooted path`
    );
    return false;
  }

  const target = locatePath(segments, scope);
  let problem: string | undefined;

  if (target.kind === "invalid") {
    problem = target.reason;
  } else if (target.kind === "external") {
    problem = allowExternal
      ? undefined
      : `reads $.${renderPath(segments)}, which is not an observation`;
  } else {
    problem =
      observationProblem(context.catalog, target) ??
      nativeErrorEqualityProblem(context.catalog, target, equals);
  }

  if (problem !== undefined) {
    report(
      context,
      "observation-path",
      `${subject(context)} ${label} ${problem}`
    );
  }

  return problem === undefined;
};

const literalBooleanProblem = (
  catalog: OperationCatalog | undefined,
  target: PathTarget
): string | undefined => {
  if (catalog === undefined) {
    return "the packet has no operation catalog to declare a native boolean";
  }

  if (target.kind !== "observation") {
    return "the compared value is not a catalogued observation";
  }

  const operation = catalog.operations.get(target.operationId);
  const schema = operation?.observation[target.domain];

  if (operation === undefined || schema === undefined) {
    return `${target.operationId} does not observe ${target.domain}`;
  }

  if (operation.kind !== "syscall") {
    return `${target.operationId} is a ${operation.kind} operation, not a syscall`;
  }

  const leaves = resolveSchemaPath(observationRoot(schema), target.segments);

  return isBooleanLeaf(leaves)
    ? undefined
    : `${target.domain}.${renderPath(target.segments)} is not typed boolean by ${target.operationId}`;
};

const checkLiteralBooleans = (
  context: RuleContext,
  scope: AssertionScope,
  node: OperatorNode
): void => {
  for (const key of LITERAL_EQUALITY_KEYS) {
    const literal = node.operators[key];

    if (typeof literal !== "boolean") {
      continue;
    }

    const target: PathTarget =
      node.actual === undefined
        ? { kind: "invalid", reason: "unparseable path" }
        : locatePath(node.actual, scope);
    const problem = literalBooleanProblem(context.catalog, target);

    if (problem !== undefined) {
      report(
        context,
        "literal-boolean",
        `${subject(context)} ${node.label} compares ${key} ${String(literal)}, but ${problem}`
      );
    }
  }
};

const checkNoEcho = (
  context: RuleContext,
  node: OperatorNode,
  forwarded: readonly (readonly PathSegment[])[]
): void => {
  for (const operand of operandPaths(node.operators)) {
    const expected = splitContextPath(operand);
    const root = expected?.[0];

    if (
      expected === undefined ||
      typeof root !== "string" ||
      !EXPECTED_SOURCE_ROOTS.has(root)
    ) {
      continue;
    }

    const leak = forwarded.find((path) => pathsOverlap(path, expected));

    if (leak !== undefined) {
      report(
        context,
        "no-echo",
        `${subject(context)} ${node.label} expects ${operand}, which reaches the adapter through ${leak.length === 0 ? "$" : `$.${renderPath(leak)}`}`
      );
    }
  }
};

const checkIntegrityObservation = (
  context: RuleContext,
  scope: AssertionScope,
  path: string | undefined,
  label: string
): void => {
  const expected = splitContextPath(path ?? "");
  if (
    expected === undefined ||
    locatePath(expected, scope).kind !== "observation"
  ) {
    report(
      context,
      "integrity-observation",
      `${subject(context)} ${label} must reference a kernel-reported observation`
    );
  }
};

const referenceNodes = (
  context: RuleContext,
  scope: AssertionScope,
  assertion: ConformancePlanAssertion,
  actual: PathSegment[] | undefined,
  label: string
): OperatorNode[] => {
  const nodes: OperatorNode[] = [];
  for (const reference of assertion.references ?? []) {
    if (reference.hashPath !== undefined) {
      checkIntegrityObservation(
        context,
        scope,
        reference.targetPath,
        `${label} reference hashPath`
      );
    }

    const relative = splitContextPath(reference.path)?.map((segment) =>
      segment === "*" ? REFERENCE_EACH : segment
    );
    nodes.push({
      actual:
        actual === undefined || relative === undefined
          ? undefined
          : [...actual, ...relative],
      label: `${label} reference ${reference.path}`,
      operators: {
        equalsPath: reference.targetPath,
        ...(reference.length === undefined ? {} : { length: reference.length }),
      },
    });
    for (const targetField of [
      ...(reference.hashPath === undefined ? [] : [reference.hashPath]),
      reference.valuePath ?? "$",
    ]) {
      const target = splitContextPath(reference.targetPath);
      const field = splitContextPath(targetField);
      const candidates: PathSegment[][] =
        target === undefined || field === undefined
          ? []
          : [
              [...target, EACH, ...field],
              [...target, ...field],
            ];
      const resolved = candidates.find((segments) => {
        const location = locatePath(segments, scope);
        return (
          location.kind === "external" ||
          (location.kind === "observation" &&
            context.catalog !== undefined &&
            observationProblem(context.catalog, location) === undefined)
        );
      });
      checkObservationPath(
        context,
        scope,
        resolved ?? candidates[0],
        `${label} reference target ${targetField}`,
        true
      );
    }
  }
  return nodes;
};

const checkAssertion = (
  context: RuleContext,
  scope: AssertionScope,
  assertion: ConformancePlanAssertion,
  index: number,
  forwarded: readonly (readonly PathSegment[])[]
): void => {
  const label = `assertion ${index} (${assertion.kind})`;
  if (assertion.kind === "identity" || assertion.kind === "digest") {
    checkIntegrityObservation(
      context,
      scope,
      assertion.equalsPath,
      `${label} equalsPath`
    );
  }
  const actual = assertionActualPath(assertion);
  const nodes = operatorNodes(assertion, actual, label);
  nodes.push(...referenceNodes(context, scope, assertion, actual, label));
  let actualResolves = true;

  for (const node of nodes) {
    if (actualResolves) {
      actualResolves = checkObservationPath(
        context,
        scope,
        node.actual,
        node.label,
        assertion.kind === "faultActivated",
        node.operators.equals
      );
    }

    for (const operand of operandPaths(node.operators)) {
      checkObservationPath(
        context,
        scope,
        splitContextPath(operand),
        `${node.label} operand ${operand}`,
        true
      );
    }

    checkLiteralBooleans(context, scope, node);
    checkNoEcho(context, node, forwarded);
  }

  if (assertion.when !== undefined) {
    checkObservationPath(
      context,
      scope,
      splitContextPath(assertion.when.path),
      `${label} when ${assertion.when.path}`,
      true
    );
  }
};

const collectArgumentReferences = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(collectArgumentReferences);
  }

  if (!isRecord(value) || Object.hasOwn(value, "$literal")) {
    return [];
  }

  if (typeof value.$ref === "string") {
    return [value.$ref];
  }

  return Object.values(value).flatMap(collectArgumentReferences);
};

const collectLegacyReferences = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.startsWith("$.") ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectLegacyReferences);
  }

  return isRecord(value)
    ? Object.values(value).flatMap(collectLegacyReferences)
    : [];
};

/** `$ref`s the runner resolves for a projected step's dispatch and inspection. */
const projectedReferences = (step: ConformancePlanStep): string[] =>
  step.arguments === undefined
    ? []
    : [step.arguments, step.inspectState].flatMap(collectArgumentReferences);

/** Context paths of everything a step hands to the adapter. */
const forwardedPaths = (
  check: ConformancePlanCheck,
  step?: ConformancePlanStep
): PathSegment[][] => {
  if (step?.arguments !== undefined) {
    // A projected check still hands its whole input to createInstance.
    return [
      ...(check.input === undefined ? [] : [["input"]]),
      ...projectedReferences(step)
        .map((reference) => reference.split("."))
        .filter((segments) => segments[0] !== "capture"),
    ];
  }

  return [
    ["input"],
    ...(check.fixture === undefined ? [] : [["fixture"]]),
    ...(check.scenario === undefined ? [] : [["scenario"]]),
  ];
};

const checkExpectedRootReferences = (
  context: RuleContext,
  step: ConformancePlanStep
): void => {
  for (const reference of projectedReferences(step)) {
    if (!ARGUMENT_REFERENCE_PATTERN.test(reference)) {
      report(
        context,
        "expected-root-reference",
        `${subject(context)} arguments or inspectState reference ${reference}; only input, fixture.input, and capture roots may reach the adapter`
      );
    }
  }

  for (const reference of [
    ...collectLegacyReferences(step.input),
    ...collectLegacyReferences(step.inspectState),
  ]) {
    const [root, section] = splitContextPath(reference) ?? [];

    if (root === "fixture" && section === "expected") {
      report(
        context,
        "expected-root-reference",
        `${subject(context)} input references ${reference}, an expected fixture root`
      );
    }
  }
};

/** A projected check forwards its input verbatim to createInstance. */
const checkInstanceInputReferences = (
  context: RuleContext,
  check: ConformancePlanCheck
): void => {
  const references = [
    ...collectArgumentReferences(check.input),
    ...collectLegacyReferences(check.input).map((reference) =>
      reference.slice(2)
    ),
  ];

  for (const reference of references) {
    const [root, section] = reference.split(".");

    if (root === "fixture" && section === "expected") {
      report(
        context,
        "expected-root-reference",
        `${subject(context)} input, which createInstance receives, references ${reference}, an expected fixture root`
      );
    }
  }
};

const checkStep = (
  context: RuleContext,
  check: ConformancePlanCheck,
  step: ConformancePlanStep
): void => {
  const scope: AssertionScope = {
    kind: "operation",
    operationId: step.operation,
  };

  if (
    context.catalog !== undefined &&
    !context.catalog.operations.has(step.operation)
  ) {
    report(
      context,
      "operation-catalogued",
      `${subject(context)} uses uncatalogued operation ${step.operation}`
    );
  }

  const operation = context.catalog?.operations.get(step.operation);
  if (
    context.catalog !== undefined &&
    (operation?.faultOutcome !== undefined) !== (step.action === "armFault")
  ) {
    report(
      context,
      "fault-action",
      `${subject(context)} must use action armFault exactly when the catalog operation declares faultOutcome`
    );
  }

  if (operation?.kind === "control" && step.arguments !== undefined) {
    const input = controlConsumesInstance(operation)
      ? { ...step.arguments, instance: "runner-instance" }
      : step.arguments;
    const problem = controlInputProblem(operation, input, true);
    if (problem !== undefined) {
      report(context, "control-input", `${subject(context)} ${problem}`);
    }
  }

  for (const capture of step.capture ?? []) {
    checkObservationPath(
      context,
      scope,
      capture.path.split("."),
      `capture ${capture.name}`,
      false
    );
  }

  checkExpectedRootReferences(context, step);
  const forwarded = forwardedPaths(check, step);

  for (const [index, assertion] of (step.assertions ?? []).entries()) {
    checkAssertion(context, scope, assertion, index, forwarded);
  }
};

const checkEvidenceOnlyProof = (
  context: RuleContext,
  check: ConformancePlanCheck,
  planId: string
): void => {
  for (const failure of collectPlanEvidenceOracleShapeFailures(
    { checks: [check] },
    planId
  )) {
    if (EVIDENCE_ONLY_GUARDRAIL_CHECKS.has(failure.check)) {
      report(context, "evidence-only-proof", failure.message);
    }
  }
};

const checkCheck = (
  plan: ConformancePlan,
  check: ConformancePlanCheck,
  catalog: OperationCatalog | undefined,
  violations: CertificationViolation[]
): void => {
  const context: RuleContext = { catalog, checkId: check.checkId, violations };
  const steps = check.steps ?? [];

  if (catalog !== undefined && !catalog.operations.has(check.operation)) {
    report(
      context,
      "operation-catalogued",
      `${subject(context)} uses uncatalogued operation ${check.operation}`
    );
  }

  for (const step of steps) {
    checkStep({ ...context, stepId: step.stepId }, check, step);
  }

  if (steps.some((step) => step.arguments !== undefined)) {
    checkInstanceInputReferences(context, check);
  }

  const scope: AssertionScope =
    steps.length === 0
      ? { kind: "operation", operationId: check.operation }
      : {
          kind: "trace",
          stepOperations: new Map(
            steps.map((step) => [step.stepId, step.operation])
          ),
        };
  const forwarded =
    steps.length === 0
      ? forwardedPaths(check)
      : steps.flatMap((step) =>
          forwardedPaths(check, step).filter(
            (path) => path[0] !== "input" || step.input === undefined
          )
        );

  for (const [index, assertion] of check.assertions.entries()) {
    checkAssertion(context, scope, assertion, index, forwarded);
  }

  checkEvidenceOnlyProof(context, check, plan.planId);
};

/**
 * Evaluates every certification rule against one schema-valid plan. Without a
 * catalog the catalog-membership and observation-path rules cannot run, and
 * every literal boolean comparison counts because nothing declares it native.
 */
export const evaluateCertificationRules = (
  plan: ConformancePlan,
  catalog: OperationCatalog | undefined
): CertificationViolation[] => {
  const violations: CertificationViolation[] = [];

  for (const check of plan.checks) {
    checkCheck(plan, check, catalog, violations);
  }

  return violations;
};
