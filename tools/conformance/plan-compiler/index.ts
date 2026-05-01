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
  containsPath?: string;
  equals?: unknown;
  equalsPath?: string;
  eventType?: string;
  field?: string;
  kind: AssertionKind;
  matches?: string;
  path?: string;
  schema?: string;
}

export interface ConformancePlanCheck {
  assertions: ConformancePlanAssertion[];
  capabilities?: string[];
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
  steps?: ConformancePlanStep[];
}

export interface ConformancePlanStep {
  assertions?: ConformancePlanAssertion[];
  controls?: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  };
  input?: unknown;
  inspectState?: unknown;
  operation: string;
  stepId: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonSchema(value: unknown, label: string): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
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

    const stepIds = new Set<string>();

    for (const step of check.steps ?? []) {
      if (stepIds.has(step.stepId)) {
        throw new Error(
          `${label} check ${check.checkId} repeats stepId ${step.stepId}`
        );
      }

      stepIds.add(step.stepId);
    }

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
    const path = assertionRequiredEvidencePath(assertion);

    if (path !== undefined) {
      evidence.add(path);
    }
  }

  for (const step of check.steps ?? []) {
    for (const assertion of step.assertions ?? []) {
      const path = stepAssertionRequiredEvidencePath(step.stepId, assertion);

      if (path !== undefined) {
        evidence.add(path);
      }
    }
  }

  return [...evidence].sort();
}

function assertionRequiredEvidencePath(
  assertion: ConformancePlanAssertion
): string | undefined {
  switch (assertion.kind) {
    case "evidenceField":
    case "stateField":
      return assertion.field === undefined
        ? undefined
        : normalizeEvidencePath(assertion.field);
    case "errorEnvelope":
      return normalizeEvidencePath(assertion.path ?? "$.result.error");
    default:
      return undefined;
  }
}

function stepAssertionRequiredEvidencePath(
  stepId: string,
  assertion: ConformancePlanAssertion
): string | undefined {
  const path = assertionRequiredEvidencePath(assertion);

  if (path === undefined) {
    return undefined;
  }

  switch (assertion.kind) {
    case "evidenceField":
      // Step assertions run against a step-local context, but required evidence
      // is checked against the final trace context after the lifecycle finishes.
      return `trace.${stepId}.evidence.${path}`;
    case "stateField":
      return `trace.${stepId}.state.${path}`;
    case "errorEnvelope":
      return `trace.${stepId}.${path}`;
    default:
      return undefined;
  }
}

function normalizeEvidencePath(path: string): string {
  return path.startsWith("$.") ? path.slice(2) : path;
}
