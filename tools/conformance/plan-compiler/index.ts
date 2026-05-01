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

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

export type AssertionKind =
  | "eventSequence"
  | "terminalEvent"
  | "schemaValid"
  | "errorEnvelope"
  | "stateField"
  | "evidenceField"
  | "ordering"
  | "noEvent";

export interface ConformancePlanAssertion {
  contains?: unknown;
  equals?: unknown;
  eventType?: string;
  field?: string;
  kind: AssertionKind;
  matches?: string;
  path?: string;
  schema?: string;
}

export interface ConformancePlanCheck {
  assertions: ConformancePlanAssertion[];
  checkId: string;
  controls?: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  };
  evidence?: string[];
  fixture?: string;
  input?: unknown;
  operation: string;
  scenario?: string;
}

export interface ConformancePlan {
  applicability: {
    capabilities: string[];
  };
  checks: ConformancePlanCheck[];
  fixtures?: Record<string, string>;
  packetId: string;
  planId: string;
  planVersion: string;
  scenarios?: Record<string, string>;
}

export interface CompiledConformancePlanCheck {
  check: ConformancePlanCheck;
  requiredEvidence: readonly string[];
}

export interface CompiledConformancePlan {
  checks: readonly CompiledConformancePlanCheck[];
  fixtures: ReadonlyMap<string, unknown>;
  path: string;
  plan: ConformancePlan;
  scenarios: ReadonlyMap<string, unknown>;
}

export interface AssertionContext {
  events?: readonly unknown[];
  evidence?: Record<string, unknown>;
  result?: unknown;
  state?: unknown;
}

export interface AssertionEvaluation {
  assertionId: string;
  message?: string;
  status: "fail" | "pass";
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const PLAN_SCHEMA_PATH = resolve(
  REPO_ROOT,
  "tools/schemas/conformance-plan.schema.json"
);
const PLAN_FILE_PATTERN = /\.json$/u;

export async function loadConformancePlan(
  planPath: string
): Promise<CompiledConformancePlan> {
  const absolutePlanPath = resolve(REPO_ROOT, planPath);
  const planValue = JSON.parse(
    await readFile(absolutePlanPath, "utf8")
  ) as unknown;
  const validatePlan = await createPlanValidator();

  if (!validatePlan(planValue)) {
    throw new Error(
      `${planPath} failed JSON Schema validation: ${validatePlan.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
        .join("; ")}`
    );
  }

  const plan = planValue as ConformancePlan;
  validatePlanIntegrity(plan, planPath);
  const fixtures = new Map<string, unknown>();
  const scenarios = new Map<string, unknown>();

  for (const [fixtureId, fixturePath] of Object.entries(plan.fixtures ?? {})) {
    const absoluteFixturePath = resolve(dirname(absolutePlanPath), fixturePath);
    const fixture = JSON.parse(
      await readFile(absoluteFixturePath, "utf8")
    ) as unknown;
    fixtures.set(fixtureId, fixture);
  }

  for (const [scenarioId, scenarioPath] of Object.entries(
    plan.scenarios ?? {}
  )) {
    const absoluteScenarioPath = resolve(
      dirname(absolutePlanPath),
      scenarioPath
    );
    const scenario = JSON.parse(
      await readFile(absoluteScenarioPath, "utf8")
    ) as unknown;
    scenarios.set(scenarioId, scenario);
  }

  return {
    checks: plan.checks.map((check) => ({
      check,
      requiredEvidence: expandRequiredEvidence(check),
    })),
    fixtures,
    path: absolutePlanPath,
    plan,
    scenarios,
  };
}

export async function findConformancePlans(): Promise<string[]> {
  const paths = await findPlanFiles(BOUNDARIES_ROOT);
  return paths.map((path) => relative(REPO_ROOT, path)).sort();
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

async function createPlanValidator(): Promise<ValidateFunction<unknown>> {
  const schema = readJsonSchema(
    JSON.parse(await readFile(PLAN_SCHEMA_PATH, "utf8")) as unknown,
    PLAN_SCHEMA_PATH
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

async function findPlanFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const plans: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      plans.push(...(await findPlanFiles(entryPath)));
      continue;
    }

    if (
      entry.isFile() &&
      PLAN_FILE_PATTERN.test(entry.name) &&
      entryPath.includes("/conformance/plans/")
    ) {
      plans.push(entryPath);
    }
  }

  return plans;
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
      return assertField(assertion, context.state);
    case "evidenceField":
      return assertField(assertion, context.evidence);
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
  return valuesAreEqual(actual, assertion.equals);
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

  const value = readPath(terminalEvent, assertion.path ?? "$");

  return assertion.eventType === undefined
    ? assertValue(assertion, value)
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

  if (!isRecord(value) || typeof value.code !== "string") {
    return false;
  }

  return assertValue(assertion, value);
}

function assertField(
  assertion: ConformancePlanAssertion,
  source: unknown
): boolean {
  if (assertion.field === undefined) {
    throw new Error(`${assertion.kind} assertion requires field`);
  }

  return assertValue(assertion, readPath(source, assertion.field));
}

function assertOrdering(
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean {
  const events = readEvents(context);

  if (!Array.isArray(assertion.contains) || assertion.contains.length !== 2) {
    throw new Error(
      "ordering assertion requires contains with two event types"
    );
  }

  const [first, second] = assertion.contains;

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

  const events = readEvents(context);
  return events.every(
    (event) =>
      readPath(event, assertion.path ?? "$.type") !== assertion.eventType
  );
}

function assertValue(
  assertion: ConformancePlanAssertion,
  value: unknown
): boolean {
  if ("equals" in assertion) {
    return valuesAreEqual(value, assertion.equals);
  }

  if ("contains" in assertion) {
    return valueContains(value, assertion.contains);
  }

  if (assertion.matches !== undefined) {
    return (
      typeof value === "string" &&
      new RegExp(assertion.matches, "u").test(value)
    );
  }

  return value !== undefined;
}

function readEvents(context: AssertionContext): readonly unknown[] {
  if (context.events === undefined) {
    throw new Error("assertion requires events");
  }

  return context.events;
}

function readPath(source: unknown, path: string): unknown {
  if (path === "$") {
    return source;
  }

  if (!path.startsWith("$.")) {
    throw new Error(`unsupported path ${path}`);
  }

  // Conformance plans intentionally get a tiny JSON-path subset here. Keeping
  // the compiler small prevents the runner from gaining its own query language
  // semantics while still covering field and array lookup used by current plans.
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
  return JSON.stringify(left) === JSON.stringify(right);
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

function validatePlanIntegrity(plan: ConformancePlan, label: string): void {
  const checkIds = new Set<string>();
  const fixtureIds = new Set(Object.keys(plan.fixtures ?? {}));
  const scenarioIds = new Set(Object.keys(plan.scenarios ?? {}));

  for (const check of plan.checks) {
    if (checkIds.has(check.checkId)) {
      throw new Error(`${label} repeats checkId ${check.checkId}`);
    }

    checkIds.add(check.checkId);

    if (check.fixture !== undefined && !fixtureIds.has(check.fixture)) {
      throw new Error(
        `${label} check ${check.checkId} references unknown fixture ${check.fixture}`
      );
    }

    if (check.scenario !== undefined && !scenarioIds.has(check.scenario)) {
      throw new Error(
        `${label} check ${check.checkId} references unknown scenario ${check.scenario}`
      );
    }
  }
}

function expandRequiredEvidence(
  check: ConformancePlanCheck
): readonly string[] {
  const evidence = new Set(check.evidence ?? []);

  for (const assertion of check.assertions) {
    const path = assertion.field ?? assertion.path;

    if (
      path !== undefined &&
      (assertion.kind === "evidenceField" ||
        assertion.kind === "stateField" ||
        assertion.kind === "errorEnvelope")
    ) {
      evidence.add(normalizeEvidencePath(path));
    }
  }

  return [...evidence].sort();
}

function normalizeEvidencePath(path: string): string {
  return path.startsWith("$.") ? path.slice(2) : path;
}

function assertNever(value: never): never {
  throw new Error(`unsupported assertion kind ${value}`);
}
