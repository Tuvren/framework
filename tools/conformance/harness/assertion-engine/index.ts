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

import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type {
  CompiledConformancePlanCheck,
  ConformancePlanAssertion,
  ConformancePlanCheck,
  ConformancePlanElementAssertion,
  ConformancePlanNumericOperand,
  ConformancePlanValueOperators,
} from "../../plan-compiler/index.js";
import {
  findSecretLeaks,
  findSecretPatternLeaks,
} from "../secret-absence/index.js";

export interface AssertionContext {
  events?: readonly unknown[];
  evidence?: Record<string, unknown>;
  fixture?: unknown;
  input?: unknown;
  result?: unknown;
  scenario?: unknown;
  state?: unknown;
}

export interface AssertionEvaluation {
  assertionId: string;
  message?: string;
  status: "fail" | "pass";
  when?: "applied" | "not_applied";
}

// Compile each distinct schema once per process instead of once per
// schemaValid assertion (KRT-BM004; audit finding [C-02]). Schemas arrive as
// fixture-embedded values without a reliable `$id`, and the same logical
// schema is re-read as a fresh object per plan/fixture load — so reference
// identity is NOT a safe cache key. Key by content (stable JSON) instead:
// two structurally identical schemas share a compiled validator, and two
// distinct schemas can never collide. Mirrors the memoization pattern in
// typescript/runtime/src/lib/tool-execution-helpers.ts.
const schemaValidatorCache = new Map<string, ValidateFunction>();

class UnresolvedOperandError extends Error {}

const readEvents = (context: AssertionContext): readonly unknown[] => {
  if (context.events === undefined) {
    throw new Error("assertion requires events");
  }

  return context.events;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readPath = (source: unknown, path: string): unknown => {
  if (path === "$") {
    return source;
  }

  if (!path.startsWith("$.")) {
    throw new Error(`unsupported path ${path}`);
  }

  let current = source;
  const segments = path.slice(2).split(".");

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
};

const valuesAreEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => valuesAreEqual(entry, right[index]))
    );
  }

  if (isRecord(left) || isRecord(right)) {
    if (!(isRecord(left) && isRecord(right))) {
      return false;
    }

    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();

    // JSON object field order is language-specific, so equality is structural
    // and key-order independent across TypeScript/Rust adapter observations.
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && valuesAreEqual(left[key], right[key])
      )
    );
  }

  return false;
};

const valueContains = (value: unknown, expected: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => valuesAreEqual(entry, expected));
  }

  if (typeof value === "string" && typeof expected === "string") {
    return value.includes(expected);
  }

  if (isRecord(value) && typeof expected === "string") {
    return Object.hasOwn(value, expected);
  }

  return false;
};

const VALUE_OPERATOR_KEYS = [
  "contains",
  "containsPath",
  "equals",
  "equalsPath",
  "every",
  "greaterThan",
  "greaterThanOrEqual",
  "length",
  "lessThan",
  "lessThanOrEqual",
  "matches",
  "notEquals",
  "notEqualsPath",
  "some",
] as const satisfies readonly (keyof ConformancePlanValueOperators)[];

type ValueOperatorKey = (typeof VALUE_OPERATOR_KEYS)[number];

const LITERAL_OPERATOR_KEYS: ReadonlySet<ValueOperatorKey> = new Set([
  "contains",
  "equals",
  "notEquals",
]);

const declaresOperator = (
  operators: ConformancePlanValueOperators,
  key: ValueOperatorKey
): boolean =>
  LITERAL_OPERATOR_KEYS.has(key)
    ? key in operators
    : operators[key] !== undefined;

const resolveOperandPath = (
  context: AssertionContext,
  path: string,
  operator: string
): unknown => {
  const value = readPath(context, path);

  if (value === undefined) {
    throw new UnresolvedOperandError(`unresolved ${operator} operand ${path}`);
  }

  return value;
};

const resolveNumber = (
  context: AssertionContext,
  operand: ConformancePlanNumericOperand,
  operator: string
): number => {
  const value =
    typeof operand === "number"
      ? operand
      : resolveOperandPath(context, operand, operator);

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${operator} operand must be a finite number`);
  }

  return value;
};

const readArrayActual = (value: unknown, operator: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${operator} requires an array actual value`);
  }

  const entries: unknown[] = value;
  return entries;
};

const compareNumbers = (
  operator: ValueOperatorKey,
  actual: number,
  expected: number
): boolean => {
  switch (operator) {
    case "greaterThan": {
      return actual > expected;
    }
    case "greaterThanOrEqual": {
      return actual >= expected;
    }
    case "lessThan": {
      return actual < expected;
    }
    default: {
      return actual <= expected;
    }
  }
};

const elementSatisfies = (
  element: ConformancePlanElementAssertion,
  value: unknown,
  context: AssertionContext
): boolean => {
  try {
    return assertValue(element, readPath(value, element.field ?? "$"), context);
  } catch (error: unknown) {
    // Another element's match must not conceal an unresolved operand.
    if (error instanceof UnresolvedOperandError) {
      throw error;
    }
    return false;
  }
};

const applyOperator = (
  operators: ConformancePlanValueOperators,
  key: ValueOperatorKey,
  value: unknown,
  context: AssertionContext
): boolean => {
  switch (key) {
    case "equals": {
      return valuesAreEqual(value, operators.equals);
    }
    case "equalsPath": {
      return valuesAreEqual(
        value,
        resolveOperandPath(context, operators.equalsPath ?? "", key)
      );
    }
    case "notEquals": {
      return !valuesAreEqual(value, operators.notEquals);
    }
    case "notEqualsPath": {
      return !valuesAreEqual(
        value,
        resolveOperandPath(context, operators.notEqualsPath ?? "", key)
      );
    }
    case "contains": {
      return valueContains(value, operators.contains);
    }
    case "containsPath": {
      return valueContains(
        value,
        resolveOperandPath(context, operators.containsPath ?? "", key)
      );
    }
    case "matches": {
      return (
        typeof value === "string" &&
        new RegExp(operators.matches ?? "", "u").test(value)
      );
    }
    case "greaterThan":
    case "greaterThanOrEqual":
    case "lessThan":
    case "lessThanOrEqual": {
      if (typeof value !== "number") {
        throw new TypeError(`${key} requires a numeric actual value`);
      }
      return compareNumbers(
        key,
        value,
        resolveNumber(context, operators[key] ?? Number.NaN, key)
      );
    }
    case "length": {
      return (
        readArrayActual(value, key).length ===
        resolveNumber(context, operators.length ?? Number.NaN, key)
      );
    }
    case "every":
    case "some": {
      const element = operators[key];
      if (element === undefined) {
        return false;
      }
      if (operators.length === undefined) {
        throw new Error(`${key} requires an explicit length assertion`);
      }
      const entries = readArrayActual(value, key);
      // Evaluate every element so no unresolved operand is short-circuited.
      const results = entries.map((entry) =>
        elementSatisfies(element, entry, context)
      );
      return key === "every" ? results.every(Boolean) : results.some(Boolean);
    }
    default: {
      const unsupported: never = key;
      throw new Error(`unsupported operator ${String(unsupported)}`);
    }
  }
};

// Every declared operator must hold. An absent actual value is an unresolved
// operand and fails unless the assertion explicitly expects absence.
const assertValue = (
  operators: ConformancePlanValueOperators,
  value: unknown,
  context: AssertionContext
): boolean => {
  const declared = VALUE_OPERATOR_KEYS.filter((key) =>
    declaresOperator(operators, key)
  );

  if (operators.present === false) {
    if (declared.length > 0) {
      throw new Error("present: false cannot be combined with value operators");
    }
    return value === undefined;
  }

  if (declared.length === 0 && operators.present === undefined) {
    throw new Error(
      "assertion declares no operator; presence-only assertions must use present"
    );
  }

  if (value === undefined) {
    throw new UnresolvedOperandError("unresolved actual operand");
  }

  return declared.every((key) => applyOperator(operators, key, value, context));
};

const projectEvents = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): unknown[] => {
  const path = assertion.path ?? "$.type";
  return readEvents(context).map((event, index) => {
    const value = readPath(event, path);
    if (value === undefined) {
      throw new UnresolvedOperandError(
        `unresolved event projection ${path} at event ${index}`
      );
    }
    return value;
  });
};

const assertEventSequence = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean =>
  assertValue(assertion, projectEvents(assertion, context), context);

const assertTerminalEvent = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  const events = readEvents(context);
  const terminalEvent = events.at(-1);

  if (terminalEvent === undefined) {
    return false;
  }

  // When eventType is supplied, callers expect the assertion to read the
  // event's discriminant by default. Defaulting path to "$" forced every plan
  // to redundantly write path: "$.type" for the comparison to ever match.
  const defaultPath = assertion.eventType === undefined ? "$" : "$.type";
  const value = readPath(terminalEvent, assertion.path ?? defaultPath);

  return assertion.eventType === undefined
    ? assertValue(assertion, value, context)
    : value === assertion.eventType;
};

// JSON.stringify is key-order sensitive, so serialize with sorted object
// keys: the same schema loaded from differently-ordered JSON still hits one
// cache entry, while any semantic difference changes the key. The rebuilt
// object uses own data properties so a literal "__proto__" property name lands as
// an own property instead of vanishing through the inherited setter — with
// a plain {} two schemas differing only in a "__proto__" member would
// serialize identically and collide.
const canonicalSchemaKey = (value: unknown): string =>
  JSON.stringify(value, (_key, node: unknown) => {
    if (isRecord(node)) {
      return Object.fromEntries(
        Object.keys(node)
          .toSorted()
          .map((key) => [key, node[key]])
      );
    }
    return node;
  });

// Exported for the assertion-engine unit tests (memoization identity and
// collision-safety assertions); production callers go through
// assertSchemaValid.
export const getCompiledSchemaValidator = (
  schema: AnySchema
): ValidateFunction => {
  const key = canonicalSchemaKey(schema);
  const cached = schemaValidatorCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  // schemaValid is synchronous; reject Ajv's async validators before caching.
  if ("$async" in validate && validate.$async) {
    throw new Error(
      "schemaValid assertion does not support asynchronous schemas"
    );
  }

  schemaValidatorCache.set(key, validate);
  return validate;
};

const readJsonSchema = (
  value: unknown,
  label: string
): boolean | Record<string, unknown> => {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
};

const assertSchemaValid = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  if (assertion.schema === undefined) {
    throw new Error("schemaValid assertion requires schema");
  }

  const value = readPath(context, assertion.path ?? "$.result");
  const schema = readPath(context, assertion.schema);
  const validate = getCompiledSchemaValidator(
    readJsonSchema(schema, assertion.schema)
  );
  return validate(value);
};

const assertErrorEnvelope = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  const value = readPath(context, assertion.path ?? "$.result.error");

  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string"
  ) {
    return false;
  }

  const declaresValueOperator =
    assertion.present !== undefined ||
    VALUE_OPERATOR_KEYS.some((key) => declaresOperator(assertion, key));

  return declaresValueOperator ? assertValue(assertion, value, context) : true;
};

const assertField = (
  assertion: ConformancePlanAssertion,
  source: unknown,
  context: AssertionContext
): boolean => {
  if (assertion.field === undefined) {
    throw new Error(`${assertion.kind} assertion requires field`);
  }

  return assertValue(assertion, readPath(source, assertion.field), context);
};

const resolveExpectedPair = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): readonly unknown[] => {
  const contains =
    assertion.containsPath === undefined
      ? assertion.contains
      : readPath(context, assertion.containsPath);

  if (!Array.isArray(contains) || contains.length !== 2) {
    throw new Error(
      "ordering assertion requires contains with two event types"
    );
  }

  return contains;
};

const assertOrdering = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  const contains = resolveExpectedPair(assertion, context);
  const [first, second] = contains;

  if (typeof first !== "string" || typeof second !== "string") {
    throw new TypeError("ordering assertion event types must be strings");
  }

  const eventTypes = projectEvents(assertion, context);
  const firstIndex = eventTypes.indexOf(first);
  const secondIndex = eventTypes.indexOf(second);
  return firstIndex !== -1 && secondIndex !== -1 && firstIndex < secondIndex;
};

const assertNoEvent = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  if (assertion.eventType === undefined) {
    throw new Error("noEvent assertion requires eventType");
  }

  return projectEvents(assertion, context).every(
    (value) => value !== assertion.eventType
  );
};

const assertSecretAbsence = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  if (assertion.field === undefined) {
    throw new Error("secretAbsence assertion requires field");
  }
  if (assertion.secretsPath === undefined) {
    throw new Error("secretAbsence assertion requires secretsPath");
  }

  const surface = readPath(context.result, assertion.field);
  // A secret-absence check must fail loud on a missing surface: absence cannot
  // be proven on something that was never scanned. `null` is treated the same
  // as `undefined` so a surface that resolves to an explicit null fails rather
  // than passing vacuously (which would silently report "secret-free").
  if (surface === undefined || surface === null) {
    throw new Error(
      `secretAbsence surface ${assertion.field} is missing from the result`
    );
  }

  const secretsValue = readPath(context, assertion.secretsPath);
  if (!Array.isArray(secretsValue)) {
    throw new TypeError(
      `secretAbsence secretsPath ${assertion.secretsPath} must resolve to an array`
    );
  }
  const secrets = secretsValue.filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (secrets.length === 0) {
    throw new Error("secretAbsence requires at least one configured secret");
  }

  const findings = findSecretLeaks(surface, secrets);
  if (findings.length > 0) {
    throw new Error(
      `secret leak detected in ${assertion.field}: ${findings
        .map((finding) => finding.variant)
        .join(", ")}`
    );
  }

  return true;
};

const assertSecretPatternAbsence = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  if (assertion.field === undefined) {
    throw new Error("secretPatternAbsence assertion requires field");
  }

  const surface = readPath(context.result, assertion.field);
  // Mirrors assertSecretAbsence: a pattern-absence check must fail loud on a
  // missing surface too — absence cannot be proven on something that was
  // never scanned, and a surface that resolves to an explicit null must fail
  // rather than vacuously pass.
  if (surface === undefined || surface === null) {
    throw new Error(
      `secretPatternAbsence surface ${assertion.field} is missing from the result`
    );
  }

  const findings = findSecretPatternLeaks(surface);
  if (findings.length > 0) {
    throw new Error(
      `secret-pattern leak detected in ${assertion.field}: ${findings
        .map((finding) => finding.pattern)
        .join(", ")}`
    );
  }

  return true;
};

const assertNever = (value: never): never => {
  throw new Error(`unsupported assertion kind ${String(value)}`);
};

const evaluateAssertion = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  switch (assertion.kind) {
    case "eventSequence": {
      return assertEventSequence(assertion, context);
    }
    case "terminalEvent": {
      return assertTerminalEvent(assertion, context);
    }
    case "schemaValid": {
      return assertSchemaValid(assertion, context);
    }
    case "errorEnvelope": {
      return assertErrorEnvelope(assertion, context);
    }
    case "stateField": {
      return assertField(assertion, context.state, context);
    }
    case "evidenceField": {
      return assertField(assertion, context.evidence, context);
    }
    case "resultField": {
      return assertField(assertion, context.result, context);
    }
    case "ordering": {
      return assertOrdering(assertion, context);
    }
    case "noEvent": {
      return assertNoEvent(assertion, context);
    }
    case "secretAbsence": {
      return assertSecretAbsence(assertion, context);
    }
    case "secretPatternAbsence": {
      return assertSecretPatternAbsence(assertion, context);
    }
    default: {
      return assertNever(assertion.kind);
    }
  }
};

export interface AssertionOperand {
  actual?: unknown;
  expected?: unknown;
  expectedSource: string;
  path: string;
}

/** An evaluation plus the operands a failure artifact records for it. */
export interface AssertionDiagnosis {
  evaluation: AssertionEvaluation;
  operands: AssertionOperand[];
  unresolved: boolean;
}

const FIELD_ROOTS: Partial<Record<ConformancePlanAssertion["kind"], string>> = {
  evidenceField: "$.evidence",
  resultField: "$.result",
  secretAbsence: "$.result",
  secretPatternAbsence: "$.result",
  stateField: "$.state",
};

const EVENT_PROJECTION_KINDS: ReadonlySet<ConformancePlanAssertion["kind"]> =
  new Set(["eventSequence", "noEvent", "ordering"]);

const joinPath = (root: string, path: string): string =>
  path === "$" ? root : `${root}${path.slice(1)}`;

const TRACE_PATH = /^\$\.(?:state|result|evidence)\.trace\./u;

const describePathSource = (path: string): string => {
  if (TRACE_PATH.test(path)) {
    return "trace";
  }

  switch (path.split(".")[1]) {
    case "fixture": {
      return "fixture";
    }
    case "capture": {
      return "capture";
    }
    case "input": {
      return "plan input";
    }
    case "scenario": {
      return "scenario";
    }
    default: {
      return "observation";
    }
  }
};

const readSubject = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): { actual: unknown; path: string } => {
  const fieldRoot = FIELD_ROOTS[assertion.kind];

  if (fieldRoot !== undefined) {
    const path = joinPath(fieldRoot, assertion.field ?? "$");
    return { actual: readPath(context, path), path };
  }

  if (EVENT_PROJECTION_KINDS.has(assertion.kind)) {
    const projection = assertion.path ?? "$.type";
    return {
      actual: context.events?.map((event) => readPath(event, projection)),
      path: joinPath("$.events[*]", projection),
    };
  }

  if (assertion.kind === "terminalEvent") {
    const projection =
      assertion.path ?? (assertion.eventType === undefined ? "$" : "$.type");
    return {
      actual: readPath(context.events?.at(-1), projection),
      path: joinPath("$.events[-1]", projection),
    };
  }

  const path =
    assertion.path ??
    (assertion.kind === "errorEnvelope" ? "$.result.error" : "$.result");
  return { actual: readPath(context, path), path };
};

const PATH_OPERAND_KEYS: ReadonlySet<string> = new Set([
  "containsPath",
  "equalsPath",
  "notEqualsPath",
  "schema",
]);

const NUMERIC_OPERAND_KEYS: ReadonlySet<string> = new Set([
  "greaterThan",
  "greaterThanOrEqual",
  "length",
  "lessThan",
  "lessThanOrEqual",
]);

const describeExpected = (
  key: string,
  operand: unknown,
  context: AssertionContext
): Pick<AssertionOperand, "expected" | "expectedSource"> => {
  if (
    typeof operand === "string" &&
    (PATH_OPERAND_KEYS.has(key) || NUMERIC_OPERAND_KEYS.has(key))
  ) {
    return {
      expected: readPath(context, operand),
      expectedSource: `${key}: ${describePathSource(operand)} ${operand}`,
    };
  }

  return { expected: operand, expectedSource: `${key}: plan literal` };
};

const EXPECTATION_KEYS = [
  ...VALUE_OPERATOR_KEYS,
  "eventType",
  "present",
] as const;

interface OperandSubject {
  actual: unknown;
  path: string;
}

const elementPath = (path: string, index: number): string =>
  path.includes("[*]")
    ? path.replace("[*]", `.${index}`)
    : joinPath(path, `$.${index}`);

const elementHolds = (
  element: ConformancePlanElementAssertion,
  value: unknown,
  context: AssertionContext
): boolean => {
  try {
    return elementSatisfies(element, value, context);
  } catch {
    return false;
  }
};

// Quantifiers record the evaluated operands of each element that failed them.
const describeValueOperands = (
  operators: ConformancePlanValueOperators &
    Pick<ConformancePlanAssertion, "eventType">,
  subject: OperandSubject,
  context: AssertionContext
): AssertionOperand[] =>
  EXPECTATION_KEYS.filter((key) =>
    key === "present" || key === "eventType"
      ? operators[key] !== undefined
      : declaresOperator(operators, key)
  ).flatMap((key) => {
    if (key !== "every" && key !== "some") {
      return [
        { ...subject, ...describeExpected(key, operators[key], context) },
      ];
    }

    const element = operators[key];
    if (element === undefined || !Array.isArray(subject.actual)) {
      return [{ ...subject, expectedSource: `${key}: plan element assertion` }];
    }

    const entries: unknown[] = subject.actual;
    const holds = entries.map((entry) => elementHolds(element, entry, context));
    if (key === "some" && holds.some(Boolean)) {
      return [];
    }

    const field = element.field ?? "$";
    return entries.flatMap((entry, index) =>
      holds[index]
        ? []
        : describeValueOperands(
            element,
            {
              actual: readPath(entry, field),
              path: joinPath(elementPath(subject.path, index), field),
            },
            context
          )
    );
  });

const describeOperands = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): AssertionOperand[] => {
  const subject = readSubject(assertion, context);

  if (assertion.kind === "secretAbsence") {
    // Configured secrets never leave the plan context.
    return [
      {
        ...subject,
        expectedSource: `secretsPath: ${describePathSource(assertion.secretsPath ?? "$")} ${assertion.secretsPath ?? ""}`,
      },
    ];
  }

  if (assertion.kind === "secretPatternAbsence") {
    return [{ ...subject, expectedSource: "secretPatternAbsence: harness" }];
  }

  if (assertion.kind === "schemaValid") {
    return [
      {
        ...subject,
        ...describeExpected("schema", assertion.schema, context),
      },
    ];
  }

  const operands = describeValueOperands(assertion, subject, context);

  return operands.length > 0
    ? operands
    : [{ ...subject, expectedSource: `${assertion.kind}: plan` }];
};

const describeOperandsSafely = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): AssertionOperand[] => {
  try {
    return describeOperands(assertion, context);
  } catch {
    return [];
  }
};

/**
 * Evaluates like evaluateAssertions and, for failed assertions, records the
 * operands read and whether an unresolved operand caused the failure.
 */
export const diagnoseAssertions = (
  check: ConformancePlanCheck,
  context: AssertionContext
): AssertionDiagnosis[] =>
  check.assertions.map((assertion, index) => {
    const assertionId = `${check.checkId}.${index + 1}.${assertion.kind}`;
    const { when } = assertion;
    let branch: Pick<AssertionEvaluation, "when"> = {};
    const failed = (
      message: string | undefined,
      unresolved: boolean
    ): AssertionDiagnosis => ({
      evaluation: {
        assertionId,
        ...(message === undefined ? {} : { message }),
        status: "fail",
        ...branch,
      },
      operands: describeOperandsSafely(assertion, context),
      unresolved,
    });

    try {
      if (when !== undefined) {
        const condition = resolveOperandPath(context, when.path, "when");

        if (!valuesAreEqual(condition, when.equals)) {
          return {
            evaluation: {
              assertionId,
              message: `when branch not applied: ${when.path} did not equal ${JSON.stringify(when.equals)}`,
              status: "pass",
              when: "not_applied",
            },
            operands: [],
            unresolved: false,
          };
        }

        branch = { when: "applied" };
      }

      return evaluateAssertion(assertion, context)
        ? {
            evaluation: { assertionId, status: "pass", ...branch },
            operands: [],
            unresolved: false,
          }
        : failed(undefined, false);
    } catch (error: unknown) {
      return failed(
        error instanceof Error ? error.message : String(error),
        error instanceof UnresolvedOperandError
      );
    }
  });

export const evaluateAssertions = (
  check: ConformancePlanCheck,
  context: AssertionContext
): AssertionEvaluation[] =>
  diagnoseAssertions(check, context).map(({ evaluation }) => evaluation);

const hasRequiredEvidence = (
  context: AssertionContext,
  path: string
): boolean => {
  if (path === "result") {
    return context.result !== undefined;
  }

  if (path.startsWith("result.")) {
    // resultField evidence is intentionally result-only; do not satisfy it
    // from mirrored evidence/state surfaces or the contract becomes fuzzy
    // again.
    return (
      context.result !== undefined &&
      readPath(context.result, `$.${path.slice("result.".length)}`) !==
        undefined
    );
  }

  const jsonPath = `$.${path}`;

  if (readPath(context, jsonPath) !== undefined) {
    return true;
  }

  if (readPath(context.evidence, jsonPath) !== undefined) {
    return true;
  }

  if (readPath(context.state, jsonPath) !== undefined) {
    return true;
  }

  if (
    context.events !== undefined &&
    readPath({ events: context.events }, jsonPath) !== undefined
  ) {
    return true;
  }

  return (
    context.result !== undefined &&
    readPath({ result: context.result }, jsonPath) !== undefined
  );
};

export const evaluateRequiredEvidence = (
  compiledCheck: CompiledConformancePlanCheck,
  context: AssertionContext
): AssertionEvaluation[] =>
  compiledCheck.requiredEvidence.map((path) => {
    const present = hasRequiredEvidence(context, path);

    return {
      assertionId: `${compiledCheck.check.checkId}.requiredEvidence.${path}`,
      ...(present ? {} : { message: `missing required evidence ${path}` }),
      status: present ? "pass" : "fail",
    };
  });

export const diagnoseRequiredEvidence = (
  compiledCheck: CompiledConformancePlanCheck,
  context: AssertionContext
): AssertionDiagnosis[] =>
  evaluateRequiredEvidence(compiledCheck, context).map((evaluation, index) => ({
    evaluation,
    operands:
      evaluation.status === "pass"
        ? []
        : [
            {
              expected: true,
              expectedSource: "evidence: plan literal",
              path: `$.${compiledCheck.requiredEvidence[index] ?? ""}`,
            },
          ],
    unresolved: false,
  }));
