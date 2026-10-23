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
import nodePath from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { OperationCatalog } from "./certification-rules.js";

export type AssertionKind =
  | "digest"
  | "canonicalCbor"
  | "identity"
  | "referenceWalk"
  | "eventSequence"
  | "terminalEvent"
  | "schemaValid"
  | "errorEnvelope"
  | "resultField"
  | "stateField"
  | "evidenceField"
  | "ordering"
  | "noEvent"
  | "secretAbsence"
  | "secretPatternAbsence";

/** A JSON number literal, or a `$`-rooted path read from the assertion context. */
export type ConformancePlanNumericOperand = number | string;

export interface ConformancePlanValueOperators {
  contains?: unknown;
  containsPath?: string;
  equals?: unknown;
  equalsPath?: string;
  every?: ConformancePlanElementAssertion;
  greaterThan?: ConformancePlanNumericOperand;
  greaterThanOrEqual?: ConformancePlanNumericOperand;
  length?: ConformancePlanNumericOperand;
  lessThan?: ConformancePlanNumericOperand;
  lessThanOrEqual?: ConformancePlanNumericOperand;
  matches?: string;
  notEquals?: unknown;
  notEqualsPath?: string;
  present?: boolean;
  some?: ConformancePlanElementAssertion;
}

/** Applied to each array element; `field` is read from the element. */
export interface ConformancePlanElementAssertion extends ConformancePlanValueOperators {
  field?: string;
}

export interface ConformancePlanWhen {
  equals: unknown;
  path: string;
}

export interface ConformancePlanReference {
  length?: ConformancePlanNumericOperand;
  path: string;
  targetPath: string;
  recordType: string;
  hashPath?: string;
  valuePath?: string;
}

export interface ConformancePlanAssertion extends ConformancePlanValueOperators {
  recordType?: string;
  references?: ConformancePlanReference[];
  eventType?: string;
  field?: string;
  kind: AssertionKind;
  path?: string;
  schema?: string;
  /**
   * For `secretAbsence`: JSONPath (from the assertion context root) to the list
   * of configured secret values to scan for, e.g. `$.fixture.secretValues`. The
   * observation surface is read from the result via `field`. (KRT-BD004)
   *
   * Not used by `secretPatternAbsence`, which is structural (detects
   * secret-*shaped* values via the shared pattern set, KRT-BK004) rather than
   * value-equality against a configured list.
   */
  secretsPath?: string;
  when?: ConformancePlanWhen;
}

export type ConformancePlanStepAction =
  | "armFault"
  | "await"
  | "barrier"
  | "cancel"
  | "dispatch"
  | "kill"
  | "openInstance"
  | "pull"
  | "release"
  | "respawn"
  | "restart"
  | "setClock"
  | "start"
  | "subscribe";

/** Rooted at `input.`, `fixture.input.`, or `capture.`. */
export interface ConformancePlanArgumentReference {
  $ref: string;
}

export interface ConformancePlanArgumentLiteral {
  $literal: unknown;
}

export interface ConformancePlanCapture {
  name: string;
  /** Rooted at `result`, `events`, or `state` of the step's observation. */
  path: string;
}

export interface ConformancePlanCheck {
  assertions: ConformancePlanAssertion[];
  capabilities?: string[];
  checkId: string;
  claimIds?: string[];
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
  action?: ConformancePlanStepAction;
  /** Literals, references, and `$literal` wrappers; exclusive with `input`. */
  arguments?: Record<string, unknown>;
  assertions?: ConformancePlanAssertion[];
  barrierId?: string;
  capture?: ConformancePlanCapture[];
  claimIds?: string[];
  controls?: {
    cancelAfterEvent?: string;
    deadlineMs?: number;
  };
  input?: unknown;
  inspectState?: unknown;
  operation: string;
  participants?: string[];
  seam?: string;
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
  catalog?: OperationCatalog;
  checks: readonly CompiledConformancePlanCheck[];
  fixtures: ReadonlyMap<string, unknown>;
  path: string;
  plan: ConformancePlan;
  scenarios: ReadonlyMap<string, unknown>;
}

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const SPEC_ROOT = nodePath.resolve(REPO_ROOT, "spec");
const PLAN_SCHEMA_PATH = nodePath.resolve(
  REPO_ROOT,
  "tools/schemas/conformance-plan.schema.json"
);

// Read and compile the plan schema once per process instead of once per
// loadConformancePlan call (KRT-BM004; audit finding [C-02]). The schema is
// a single fixed file (PLAN_SCHEMA_PATH), so the memo is a lone promise —
// no cache-key collision surface. Caching the promise (not the resolved
// value) also collapses concurrent first calls onto one read+compile.
let planValidatorPromise:
  | Promise<ValidateFunction<ConformancePlan>>
  | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonSchema = (
  value: unknown,
  label: string
): boolean | Record<string, unknown> => {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
};

const createPlanValidator = async (): Promise<
  ValidateFunction<ConformancePlan>
> => {
  planValidatorPromise ??= (async () => {
    const schema = readJsonSchema(
      JSON.parse(await readFile(PLAN_SCHEMA_PATH, "utf-8")) as unknown,
      PLAN_SCHEMA_PATH
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    return ajv.compile<ConformancePlan>(schema);
  })();

  return await planValidatorPromise;
};

const assertUniqueCheckId = (
  seenCheckIds: Set<string>,
  checkId: string,
  label: string
): void => {
  if (seenCheckIds.has(checkId)) {
    throw new Error(`${label} repeats checkId ${checkId}`);
  }

  seenCheckIds.add(checkId);
};

const assertUniqueStepId = (
  seenStepIds: Set<string>,
  stepId: string,
  context: string
): void => {
  if (seenStepIds.has(stepId)) {
    throw new Error(`${context} repeats stepId ${stepId}`);
  }

  seenStepIds.add(stepId);
};

const assertValidAssertion = (
  assertion: ConformancePlanAssertion,
  context: string
): void => {
  if (assertion.kind === "noEvent" && assertion.field !== undefined) {
    throw new Error(`${context} has field configured on noEvent assertion`);
  }

  if (assertion.kind === "resultField" && assertion.field === undefined) {
    throw new Error(
      `${context} has no field configured on resultField assertion`
    );
  }
};

const validateCheckAssertions = (
  check: ConformancePlanCheck,
  label: string
): void => {
  const context = `${label} check ${check.checkId}`;
  const stepIds = new Set<string>();

  for (const step of check.steps ?? []) {
    assertUniqueStepId(stepIds, step.stepId, context);

    for (const assertion of step.assertions ?? []) {
      assertValidAssertion(assertion, context);
    }
  }

  for (const assertion of check.assertions) {
    assertValidAssertion(assertion, context);
  }
};

const validateCheckReferences = (
  check: ConformancePlanCheck,
  fixtureIds: ReadonlySet<string>,
  scenarioIds: ReadonlySet<string>,
  label: string
): void => {
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
};

const validatePlanIntegrity = (plan: ConformancePlan, label: string): void => {
  const checkIds = new Set<string>();
  const fixtureIds = new Set(Object.keys(plan.fixtures ?? {}));
  const scenarioIds = new Set(Object.keys(plan.scenarios ?? {}));

  for (const check of plan.checks) {
    assertUniqueCheckId(checkIds, check.checkId, label);
    validateCheckAssertions(check, label);
    validateCheckReferences(check, fixtureIds, scenarioIds, label);
  }
};

const normalizeEvidencePath = (path: string): string =>
  path.startsWith("$.") ? path.slice(2) : path;

const resultFieldRequiredEvidencePath = (field: string): string => {
  if (field === "$") {
    return "result";
  }

  // Required evidence is evaluated against the whole assertion context, so
  // resultField paths must be rooted under `result` to avoid mirroring the
  // evidence/state surface and accidentally accepting the wrong namespace.
  return `result.${normalizeEvidencePath(field)}`;
};

const isIntegrityKind = (
  kind: AssertionKind
): kind is "digest" | "canonicalCbor" | "identity" | "referenceWalk" =>
  ["digest", "canonicalCbor", "identity", "referenceWalk"].includes(kind);

const assertionRequiredEvidencePath = (
  assertion: ConformancePlanAssertion
): string | undefined => {
  if (
    isIntegrityKind(assertion.kind) ||
    assertion.present === false ||
    assertion.when !== undefined
  ) {
    return undefined;
  }

  switch (assertion.kind) {
    case "evidenceField":
    case "stateField": {
      return assertion.field === undefined
        ? undefined
        : normalizeEvidencePath(assertion.field);
    }
    case "resultField": {
      return assertion.field === undefined
        ? undefined
        : resultFieldRequiredEvidencePath(assertion.field);
    }
    case "errorEnvelope": {
      return normalizeEvidencePath(assertion.path ?? "$.result.error");
    }
    case "eventSequence":
    case "noEvent":
    case "ordering":
    case "schemaValid":
    case "secretAbsence":
    case "secretPatternAbsence":
    case "terminalEvent": {
      return undefined;
    }
    default: {
      const unsupported: never = assertion.kind;
      return unsupported;
    }
  }
};

const stepAssertionRequiredEvidencePath = (
  stepId: string,
  assertion: ConformancePlanAssertion
): string | undefined => {
  if (isIntegrityKind(assertion.kind)) {
    return undefined;
  }
  const path = assertionRequiredEvidencePath(assertion);

  if (path === undefined) {
    return undefined;
  }

  switch (assertion.kind) {
    case "evidenceField": {
      // Step assertions run against a step-local context, but required evidence
      // is checked against the final trace context after the lifecycle finishes.
      return `trace.${stepId}.evidence.${path}`;
    }
    case "resultField": {
      if (assertion.field === undefined) {
        return undefined;
      }

      return assertion.field === "$"
        ? `result.trace.${stepId}.result`
        : `result.trace.${stepId}.result.${normalizeEvidencePath(
            assertion.field
          )}`;
    }
    case "stateField": {
      return `trace.${stepId}.state.${path}`;
    }
    case "errorEnvelope": {
      return `trace.${stepId}.${path}`;
    }
    case "eventSequence":
    case "noEvent":
    case "ordering":
    case "schemaValid":
    case "secretAbsence":
    case "secretPatternAbsence":
    case "terminalEvent": {
      return undefined;
    }
    default: {
      const unsupported: never = assertion.kind;
      return unsupported;
    }
  }
};

const expandRequiredEvidence = (
  check: ConformancePlanCheck
): readonly string[] => {
  const evidence = new Set(check.evidence);

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

  return [...evidence].toSorted();
};

const loadReferences = async (
  absolutePlanPath: string,
  references: Record<string, string> | undefined
): Promise<Map<string, unknown>> => {
  const entries = Object.entries(references ?? {});
  const values = new Map<string, unknown>();
  const visit = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (entry === undefined) {
      return;
    }
    const [id, path] = entry;
    const value: unknown = JSON.parse(
      await readFile(
        nodePath.resolve(nodePath.dirname(absolutePlanPath), path),
        "utf-8"
      )
    );
    values.set(id, value);
    await visit(index + 1);
  };
  await visit(0);
  return values;
};

export const loadConformancePlan = async (
  planPath: string
): Promise<CompiledConformancePlan> => {
  const absolutePlanPath = nodePath.resolve(REPO_ROOT, planPath);
  const planValue = JSON.parse(
    await readFile(absolutePlanPath, "utf-8")
  ) as unknown;
  const validatePlan = await createPlanValidator();

  if (!validatePlan(planValue)) {
    throw new Error(
      `${planPath} failed JSON Schema validation: ${validatePlan.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
        .join("; ")}`
    );
  }

  const plan = planValue;
  validatePlanIntegrity(plan, planPath);
  const fixtures = await loadReferences(absolutePlanPath, plan.fixtures);
  const scenarios = await loadReferences(absolutePlanPath, plan.scenarios);

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
};

// Tolerates a port segment between "conformance" and "plans" (e.g.
// spec/conformance/kernel/plans/x.json) — only the immediate parent
// directory name and a "conformance" ancestor segment are required.
const isConformancePlansPath = (entryPath: string): boolean => {
  const segments = entryPath.split("/");
  const plansIndex = segments.lastIndexOf("plans");
  return (
    plansIndex === segments.length - 2 &&
    segments.slice(0, plansIndex).includes("conformance")
  );
};

const findPlanFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const plans: string[] = [];

  const visit = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (entry === undefined) {
      return;
    }
    const entryPath = nodePath.resolve(directory, entry.name);

    if (entry.isDirectory()) {
      plans.push(...(await findPlanFiles(entryPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      isConformancePlansPath(entryPath)
    ) {
      plans.push(entryPath);
    }
    await visit(index + 1);
  };
  await visit(0);

  return plans;
};

export const findConformancePlans = async (): Promise<string[]> => {
  // No existsSync guard on the root: a missing spec/ (sparse checkout,
  // wrong cwd) must fail loudly, never yield an empty plan set that lets
  // downstream validation pass vacuously.
  const paths = await findPlanFiles(SPEC_ROOT);
  if (paths.length === 0) {
    throw new Error(
      `found zero conformance plans under ${SPEC_ROOT} — refusing to report a vacuous pass`
    );
  }
  return paths.map((path) => nodePath.relative(REPO_ROOT, path)).toSorted();
};
