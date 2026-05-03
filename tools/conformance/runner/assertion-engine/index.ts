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

import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type {
  CompiledConformancePlanCheck,
  ConformancePlanAssertion,
  ConformancePlanCheck,
} from "../../plan-compiler/index.js";

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
}

export function evaluateAssertions(
  check: ConformancePlanCheck,
  context: AssertionContext
): AssertionEvaluation[] {
  return check.assertions.map((assertion, index) => {
    const assertionId = `${check.checkId}.${index + 1}.${assertion.kind}`;

    try {
      const passed = evaluateAssertion(assertion, context);
      return {
        assertionId,
        status: passed ? "pass" : "fail",
      };
    } catch (error: unknown) {
      return {
        assertionId,
        message: error instanceof Error ? error.message : String(error),
        status: "fail",
      };
    }
  });
}

export function evaluateRequiredEvidence(
  compiledCheck: CompiledConformancePlanCheck,
  context: AssertionContext
): AssertionEvaluation[] {
  return compiledCheck.requiredEvidence.map((path) => {
    const present = hasRequiredEvidence(context, path);

    return {
      assertionId: `${compiledCheck.check.checkId}.requiredEvidence.${path}`,
      ...(present ? {} : { message: `missing required evidence ${path}` }),
      status: present ? "pass" : "fail",
    };
  });
}

export function readPath(source: unknown, path: string): unknown {
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
}

function evaluateAssertion(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  switch (assertion.kind) {
    case "eventSequence":
      return assertEventSequence(assertion, context);
    case "terminalEvent":
      return assertTerminalEvent(assertion, context);
    case "schemaValid":
      return assertSchemaValid(assertion, context);
    case "errorEnvelope":
      return assertErrorEnvelope(assertion, context);
    case "stateField":
      return assertField(assertion, context.state, context);
    case "evidenceField":
      return assertField(assertion, context.evidence, context);
    case "ordering":
      return assertOrdering(assertion, context);
    case "noEvent":
      return assertNoEvent(assertion, context);
    default:
      return assertNever(assertion.kind);
  }
}

function assertEventSequence(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  const events = readEvents(context);
  const actual = events.map((event) =>
    readPath(event, assertion.path ?? "$.type")
  );
  return assertValue(assertion, actual, context);
}

function assertTerminalEvent(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
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
}

function assertSchemaValid(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  if (assertion.schema === undefined) {
    throw new Error("schemaValid assertion requires schema");
  }

  const value = readPath(context, assertion.path ?? "$.result");
  const schema = readPath(context, assertion.schema);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(readJsonSchema(schema, assertion.schema));
  return validate(value) === true;
}

function assertErrorEnvelope(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  const value = readPath(context, assertion.path ?? "$.result.error");

  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string"
  ) {
    return false;
  }

  return assertValue(assertion, value, context);
}

function assertField(
  assertion: ConformancePlanAssertion,
  source: unknown,
  context: AssertionContext
): boolean {
  if (assertion.field === undefined) {
    throw new Error(`${assertion.kind} assertion requires field`);
  }

  return assertValue(assertion, readPath(source, assertion.field), context);
}

function assertOrdering(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  const events = readEvents(context);
  const contains = resolveExpectedPair(assertion, context);
  const [first, second] = contains;

  if (typeof first !== "string" || typeof second !== "string") {
    throw new Error("ordering assertion event types must be strings");
  }

  const eventTypes = events.map((event) =>
    readPath(event, assertion.path ?? "$.type")
  );
  const firstIndex = eventTypes.indexOf(first);
  const secondIndex = eventTypes.indexOf(second);
  return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex;
}

function assertNoEvent(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  if (assertion.eventType === undefined) {
    throw new Error("noEvent assertion requires eventType");
  }

  if (assertion.field !== undefined) {
    const value = readPath(context.evidence, assertion.field);

    if (!Array.isArray(value)) {
      return value !== assertion.eventType;
    }

    return value.every((entry) => entry !== assertion.eventType);
  }

  const events = readEvents(context);
  return events.every(
    (event) =>
      readPath(event, assertion.path ?? "$.type") !== assertion.eventType
  );
}

function assertValue(
  assertion: ConformancePlanAssertion,
  value: unknown,
  context: AssertionContext
): boolean {
  if ("equals" in assertion) {
    return valuesAreEqual(value, assertion.equals);
  }

  if (assertion.equalsPath !== undefined) {
    return valuesAreEqual(value, readPath(context, assertion.equalsPath));
  }

  if ("contains" in assertion) {
    return valueContains(value, assertion.contains);
  }

  if (assertion.containsPath !== undefined) {
    return valueContains(value, readPath(context, assertion.containsPath));
  }

  if (assertion.matches !== undefined) {
    return (
      typeof value === "string" &&
      new RegExp(assertion.matches, "u").test(value)
    );
  }

  return value !== undefined;
}

function resolveExpectedPair(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): readonly unknown[] {
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
}

function hasRequiredEvidence(context: AssertionContext, path: string): boolean {
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
}

function readEvents(context: AssertionContext): readonly unknown[] {
  if (context.events === undefined) {
    throw new Error("assertion requires events");
  }

  return context.events;
}

function valueContains(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => valuesAreEqual(entry, expected));
  }

  if (typeof value === "string" && typeof expected === "string") {
    return value.includes(expected);
  }

  if (isRecord(value) && typeof expected === "string") {
    return expected in value;
  }

  return false;
}

function valuesAreEqual(left: unknown, right: unknown): boolean {
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

    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

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
}

function readJsonSchema(value: unknown, label: string): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`unsupported assertion kind ${value}`);
}
