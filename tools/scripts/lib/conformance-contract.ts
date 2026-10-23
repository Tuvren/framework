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

export type ConformanceStatus = "fail" | "pass" | "unsupported";

/** Raw run status (ADR-0031); `pass` requires at least one applicable check. */
export type ConformanceRunStatus =
  | "fail"
  | "not_applicable"
  | "pass"
  | "unsupported";

export interface SuiteFixture {
  id: string;
  path: string;
}

export interface SuiteScenario {
  id: string;
  path?: string;
}

export interface SuiteCheck {
  assertions: string[];
  checkId: string;
  description?: string;
  expectedEvidence: string[];
  fixtureIds?: string[];
  implementations?: string[];
  interopPairs?: string[];
  scenarioIds?: string[];
}

export interface ConformanceSuiteManifest {
  boundary: string;
  checks: SuiteCheck[];
  fixtureSchemaPath?: string;
  fixtures?: SuiteFixture[];
  scenarios?: SuiteScenario[];
  suiteId: string;
  suiteVersion: string;
}

export interface ConformanceAssertionResult {
  assertionId: string;
  message?: string;
  status: ConformanceStatus;
  when?: "applied" | "not_applied";
}

/** Preliminary runner classification of a failed check (ADR-0081 decision 5). */
export type ConformanceFailureClassification =
  | "adapter_protocol"
  | "environment"
  | "implementation"
  | "verification";

export interface ConformanceFailureOperand {
  actual?: unknown;
  expected?: unknown;
  expectedSource: string;
  path: string;
}

/** Failure artifact of one failed check (ADR-0081 decision 4). */
export interface ConformanceFailure {
  arguments?: unknown;
  classification: ConformanceFailureClassification;
  exit?: { code?: number | null; signal?: string | null };
  fault?: unknown;
  frameLog?: readonly unknown[];
  observation?: unknown;
  operands?: readonly ConformanceFailureOperand[];
  replay: string;
  stderrTail?: string;
  storageRef?: string;
}

export interface ConformanceCheckResult {
  assertionResults: readonly ConformanceAssertionResult[];
  checkId: string;
  details?: Record<string, unknown>;
  failure?: ConformanceFailure;
  status: ConformanceStatus;
}

export interface ConformanceEvidenceSummary {
  applicableChecks?: number;
  failedChecks: number;
  nonApplicableChecks?: number;
  passedChecks: number;
  totalChecks: number;
  unsupportedChecks?: number;
}

export interface ConformanceEvidence {
  adapterId?: string;
  boundary: string;
  capabilities?: readonly string[];
  checkResults: readonly ConformanceCheckResult[];
  implementationId: string;
  language: string;
  nonApplicableCheckIds?: readonly string[];
  selection?: readonly {
    checkId: string;
    selected: boolean;
    reason?: string;
  }[];
  status: ConformanceRunStatus;
  suiteId: string;
  suiteVersion: string;
  summary: ConformanceEvidenceSummary;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CERTIFICATION_EVIDENCE_SCHEMA =
  "tools/schemas/certification-evidence.schema.json";

let evidenceSchemaValidator: ValidateFunction | undefined;

const assertCertificationEvidenceSchema = (
  value: unknown,
  label: string
): void => {
  evidenceSchemaValidator ??= new Ajv2020({
    allErrors: true,
    strict: false,
  }).compile(
    JSON.parse(
      readFileSync(
        nodePath.resolve(
          import.meta.dirname,
          "../../..",
          CERTIFICATION_EVIDENCE_SCHEMA
        ),
        "utf-8"
      )
    ) as Record<string, unknown>
  );
  const validate = evidenceSchemaValidator;

  if (validate(JSON.parse(JSON.stringify(value)) as unknown)) {
    return;
  }

  const violations = (validate.errors ?? [])
    .map(
      (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
    )
    .join("; ");
  throw new Error(
    `${label} does not match ${CERTIFICATION_EVIDENCE_SCHEMA}: ${violations}`
  );
};

const assertNonEmptyString: (
  value: unknown,
  label: string
) => asserts value is string = (
  value: unknown,
  label: string
): asserts value is string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
};

const readFixture = (value: unknown, label: string): SuiteFixture => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.id, `${label}.id`);
  assertNonEmptyString(value.path, `${label}.path`);
  return {
    id: value.id,
    path: value.path,
  };
};

const assertUniqueIds = (values: readonly string[], label: string): void => {
  const seenValues = new Set<string>();

  for (const value of values) {
    if (seenValues.has(value)) {
      throw new Error(`${label} must not contain duplicate ids`);
    }

    seenValues.add(value);
  }
};

const readSuiteFixtures = (
  value: unknown,
  label: string
): readonly SuiteFixture[] => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array when present`);
  }

  const fixtures = value.map((fixture, index) =>
    readFixture(fixture, `${label}[${index}]`)
  );
  assertUniqueIds(
    fixtures.map((fixture) => fixture.id),
    label
  );
  return fixtures;
};

const readScenario = (value: unknown, label: string): SuiteScenario => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.id, `${label}.id`);

  if (value.path !== undefined && typeof value.path !== "string") {
    throw new Error(`${label}.path must be a string when present`);
  }

  return {
    id: value.id,
    path: value.path,
  };
};

const readSuiteScenarios = (
  value: unknown,
  label: string
): readonly SuiteScenario[] => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array when present`);
  }

  const scenarios = value.map((scenario, index) =>
    readScenario(scenario, `${label}[${index}]`)
  );
  assertUniqueIds(
    scenarios.map((scenario) => scenario.id),
    label
  );
  return scenarios;
};

const readStringArray = (
  value: unknown,
  label: string,
  requireNonEmpty: boolean
): string[] => {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw new Error(
      `${label} must be ${requireNonEmpty ? "a non-empty" : "an"} array`
    );
  }

  const strings = value.map((entry, index) => {
    assertNonEmptyString(entry, `${label}[${index}]`);
    return entry;
  });
  assertUniqueIds(strings, label);
  return strings;
};

const readOptionalStringArray = (
  value: unknown,
  label: string,
  requireNonEmpty = true
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return readStringArray(value, label, requireNonEmpty);
};

const readSuiteCheck = (value: unknown, label: string): SuiteCheck => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.checkId, `${label}.checkId`);
  const assertions = readStringArray(
    value.assertions,
    `${label}.assertions`,
    true
  );
  const expectedEvidence = readStringArray(
    value.expectedEvidence,
    `${label}.expectedEvidence`,
    true
  );
  const fixtureIds = readOptionalStringArray(
    value.fixtureIds,
    `${label}.fixtureIds`
  );
  const scenarioIds = readOptionalStringArray(
    value.scenarioIds,
    `${label}.scenarioIds`
  );
  const implementations = readOptionalStringArray(
    value.implementations,
    `${label}.implementations`
  );
  const interopPairs = readOptionalStringArray(
    value.interopPairs,
    `${label}.interopPairs`
  );

  if (fixtureIds === undefined && scenarioIds === undefined) {
    throw new Error(
      `${label} must declare fixtureIds, scenarioIds, or both for traceability`
    );
  }

  if (implementations === undefined && interopPairs === undefined) {
    throw new Error(
      `${label} must declare implementations, interopPairs, or both`
    );
  }

  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    throw new Error(`${label}.description must be a string when present`);
  }

  return {
    assertions,
    checkId: value.checkId,
    description: value.description,
    expectedEvidence,
    fixtureIds,
    implementations,
    interopPairs,
    scenarioIds,
  };
};

const readSuiteChecks = (
  value: unknown,
  label: string
): readonly SuiteCheck[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  const checks = value.map((check, index) =>
    readSuiteCheck(check, `${label}[${index}]`)
  );
  assertUniqueIds(
    checks.map((check) => check.checkId),
    label
  );
  return checks;
};

export const assertConformanceSuiteManifest: (
  value: unknown,
  label: string
) => asserts value is ConformanceSuiteManifest = (
  value: unknown,
  label: string
): asserts value is ConformanceSuiteManifest => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.boundary, `${label}.boundary`);
  assertNonEmptyString(value.suiteId, `${label}.suiteId`);
  assertNonEmptyString(value.suiteVersion, `${label}.suiteVersion`);

  if (
    value.fixtureSchemaPath !== undefined &&
    typeof value.fixtureSchemaPath !== "string"
  ) {
    throw new Error(`${label}.fixtureSchemaPath must be a string when present`);
  }

  const fixtures = readSuiteFixtures(value.fixtures, `${label}.fixtures`);
  const scenarios = readSuiteScenarios(value.scenarios, `${label}.scenarios`);
  const checks = readSuiteChecks(value.checks, `${label}.checks`);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));

  for (const check of checks) {
    for (const fixtureId of check.fixtureIds ?? []) {
      if (!fixtureIds.has(fixtureId)) {
        throw new Error(
          `${label}.checks contains unknown fixture id ${JSON.stringify(
            fixtureId
          )}`
        );
      }
    }

    for (const scenarioId of check.scenarioIds ?? []) {
      if (!scenarioIds.has(scenarioId)) {
        throw new Error(
          `${label}.checks contains unknown scenario id ${JSON.stringify(
            scenarioId
          )}`
        );
      }
    }
  }
};

const assertConformanceStatus: (
  value: unknown,
  label: string
) => asserts value is ConformanceStatus = (
  value: unknown,
  label: string
): asserts value is ConformanceStatus => {
  if (value !== "fail" && value !== "pass" && value !== "unsupported") {
    throw new Error(`${label} must be "pass", "fail", or "unsupported"`);
  }
};

const readAssertionResult = (
  value: unknown,
  label: string
): ConformanceAssertionResult => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.assertionId, `${label}.assertionId`);
  assertConformanceStatus(value.status, `${label}.status`);

  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error(`${label}.message must be a string when present`);
  }

  if (
    value.when !== undefined &&
    value.when !== "applied" &&
    value.when !== "not_applied"
  ) {
    throw new Error(`${label}.when must be "applied" or "not_applied"`);
  }

  if (value.when === "not_applied" && value.status !== "pass") {
    throw new Error(
      `${label}.status must be pass when the branch did not apply`
    );
  }

  return {
    assertionId: value.assertionId,
    message: value.message,
    status: value.status,
    ...(value.when === undefined ? {} : { when: value.when }),
  };
};

const readAssertionResults = (
  value: unknown,
  label: string
): readonly ConformanceAssertionResult[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  const assertionResults = value.map((assertionResult, index) =>
    readAssertionResult(assertionResult, `${label}[${index}]`)
  );
  assertUniqueIds(
    assertionResults.map((assertionResult) => assertionResult.assertionId),
    label
  );
  return assertionResults;
};

const readCheckResult = (
  value: unknown,
  label: string
): ConformanceCheckResult => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.checkId, `${label}.checkId`);
  assertConformanceStatus(value.status, `${label}.status`);

  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error(`${label}.details must be an object when present`);
  }

  const assertionResults = readAssertionResults(
    value.assertionResults,
    `${label}.assertionResults`
  );
  const expectedStatus = deriveAssertionStatus(assertionResults);

  if (value.status !== expectedStatus) {
    throw new Error(
      `${label}.status must be ${expectedStatus} for the provided assertion results`
    );
  }

  return {
    assertionResults,
    checkId: value.checkId,
    details: value.details,
    status: value.status,
  };
};

const readCheckResults = (
  value: unknown,
  label: string
): readonly ConformanceCheckResult[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  const checkResults = value.map((checkResult, index) =>
    readCheckResult(checkResult, `${label}[${index}]`)
  );
  assertUniqueIds(
    checkResults.map((checkResult) => checkResult.checkId),
    label
  );
  return checkResults;
};

export const createConformanceEvidenceSummary = (
  checkResults: readonly ConformanceCheckResult[]
): ConformanceEvidenceSummary => {
  let passedChecks = 0;
  let failedChecks = 0;
  let unsupportedChecks = 0;

  for (const checkResult of checkResults) {
    if (checkResult.status === "pass") {
      passedChecks += 1;
    } else if (checkResult.status === "unsupported") {
      unsupportedChecks += 1;
    } else {
      failedChecks += 1;
    }
  }

  return {
    ...(unsupportedChecks === 0 ? {} : { unsupportedChecks }),
    failedChecks,
    passedChecks,
    totalChecks: checkResults.length,
  };
};

export const deriveConformanceRunStatus = (summary: {
  applicableChecks: number;
  failedChecks: number;
  nonApplicableChecks: number;
  unsupportedChecks?: number;
}): ConformanceRunStatus => {
  if (summary.failedChecks > 0) {
    return "fail";
  }

  const unsupportedChecks = summary.unsupportedChecks ?? 0;
  if (summary.applicableChecks - unsupportedChecks === 0) {
    return summary.nonApplicableChecks + unsupportedChecks > 0
      ? "unsupported"
      : "not_applicable";
  }

  return "pass";
};

const assertSafeInteger = (
  value: unknown,
  label: string,
  expectedValue: number
): void => {
  if (!Number.isSafeInteger(value) || value !== expectedValue) {
    throw new Error(`${label} must equal ${expectedValue}`);
  }
};

export const assertConformanceEvidence: (
  value: unknown,
  label: string
) => asserts value is ConformanceEvidence = (
  value: unknown,
  label: string
): asserts value is ConformanceEvidence => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.boundary, `${label}.boundary`);
  assertNonEmptyString(value.implementationId, `${label}.implementationId`);
  assertNonEmptyString(value.language, `${label}.language`);
  assertNonEmptyString(value.suiteId, `${label}.suiteId`);
  assertNonEmptyString(value.suiteVersion, `${label}.suiteVersion`);

  const checkResults = readCheckResults(
    value.checkResults,
    `${label}.checkResults`
  );
  const nonApplicableCheckIds =
    readOptionalStringArray(
      value.nonApplicableCheckIds,
      `${label}.nonApplicableCheckIds`,
      false
    ) ?? [];
  const expectedSummary = createConformanceEvidenceSummary(checkResults);

  if (!isRecord(value.summary)) {
    throw new Error(`${label}.summary must be an object`);
  }

  assertSafeInteger(
    value.summary.totalChecks,
    `${label}.summary.totalChecks`,
    expectedSummary.totalChecks + nonApplicableCheckIds.length
  );
  assertSafeInteger(
    value.summary.passedChecks,
    `${label}.summary.passedChecks`,
    expectedSummary.passedChecks
  );
  assertSafeInteger(
    value.summary.failedChecks,
    `${label}.summary.failedChecks`,
    expectedSummary.failedChecks
  );
  assertSafeInteger(
    value.summary.applicableChecks,
    `${label}.summary.applicableChecks`,
    checkResults.length
  );
  assertSafeInteger(
    value.summary.nonApplicableChecks,
    `${label}.summary.nonApplicableChecks`,
    nonApplicableCheckIds.length
  );

  assertSafeInteger(
    value.summary.unsupportedChecks ?? 0,
    `${label}.summary.unsupportedChecks`,
    expectedSummary.unsupportedChecks ?? 0
  );
  const expectedStatus = deriveConformanceRunStatus({
    unsupportedChecks: expectedSummary.unsupportedChecks,
    applicableChecks: checkResults.length,
    failedChecks: expectedSummary.failedChecks,
    nonApplicableChecks: nonApplicableCheckIds.length,
  });

  if (value.status !== expectedStatus) {
    throw new Error(
      `${label}.status must be ${expectedStatus} for the provided check results`
    );
  }

  assertCertificationEvidenceSchema(value, label);
};

const deriveAssertionStatus = (
  assertionResults: readonly ConformanceAssertionResult[]
): ConformanceStatus => {
  if (assertionResults.some((result) => result.status === "fail")) {
    return "fail";
  }
  return assertionResults.some((result) => result.status === "unsupported")
    ? "unsupported"
    : "pass";
};

export const createCheckResult = (
  checkId: string,
  assertionResults: readonly ConformanceAssertionResult[],
  details?: Record<string, unknown>
): ConformanceCheckResult => {
  const status = deriveAssertionStatus(assertionResults);

  return {
    assertionResults: [...assertionResults],
    checkId,
    details,
    status,
  };
};

/**
 * Checked-in evidence keeps only the classification and replay of a failure;
 * raw arguments, observations, operands, frames, and stderr stay in the run
 * log directory so adapter output never reaches the repository.
 */
export const toCheckedInCheckResult = (
  checkResult: ConformanceCheckResult
): ConformanceCheckResult => {
  if (checkResult.failure === undefined) {
    return checkResult;
  }

  const { classification, replay } = checkResult.failure;
  return { ...checkResult, failure: { classification, replay } };
};

const FAILURE_CLASSIFICATIONS: ReadonlySet<unknown> = new Set([
  "adapter_protocol",
  "environment",
  "implementation",
  "verification",
]);
const CHECKED_IN_FAILURE_KEYS: ReadonlySet<string> = new Set([
  "classification",
  "replay",
]);

/** Violations of the compact failure shape that checked-in evidence keeps. */
export const findCheckedInFailureViolations = (
  checkResults: unknown
): string[] => {
  if (!Array.isArray(checkResults)) {
    return [];
  }

  return checkResults.flatMap((checkResult: unknown, index) => {
    if (!isRecord(checkResult) || checkResult.failure === undefined) {
      return [];
    }

    const label = `checkResults[${index}].failure`;
    const { failure } = checkResult;

    if (!isRecord(failure)) {
      return [`${label} must be an object`];
    }

    const violations: string[] = [];
    const rawKeys = Object.keys(failure)
      .filter((key) => !CHECKED_IN_FAILURE_KEYS.has(key))
      .toSorted();

    if (rawKeys.length > 0) {
      violations.push(
        `${label} must keep only classification and replay; found ${rawKeys.join(", ")}`
      );
    }

    if (!FAILURE_CLASSIFICATIONS.has(failure.classification)) {
      violations.push(`${label}.classification is not a known classification`);
    }

    if (typeof failure.replay !== "string" || failure.replay.length === 0) {
      violations.push(`${label}.replay must be a non-empty string`);
    }

    if (checkResult.status !== "fail") {
      violations.push(`${label} is only allowed on a failed check`);
    }

    return violations;
  });
};

export const createAssertionResult = (
  assertionId: string,
  passed: boolean,
  message?: string
): ConformanceAssertionResult => ({
  assertionId,
  message,
  status: passed ? "pass" : "fail",
});
