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

export type ConformanceStatus = "fail" | "pass";

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
}

export interface ConformanceCheckResult {
  assertionResults: readonly ConformanceAssertionResult[];
  checkId: string;
  details?: Record<string, unknown>;
  status: ConformanceStatus;
}

export interface ConformanceEvidenceSummary {
  failedChecks: number;
  passedChecks: number;
  totalChecks: number;
}

export interface ConformanceEvidence {
  boundary: string;
  checkResults: readonly ConformanceCheckResult[];
  implementationId: string;
  language: string;
  status: ConformanceStatus;
  suiteId: string;
  suiteVersion: string;
  summary: ConformanceEvidenceSummary;
}

export function assertConformanceSuiteManifest(
  value: unknown,
  label: string
): asserts value is ConformanceSuiteManifest {
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
}

export function assertConformanceEvidence(
  value: unknown,
  label: string
): asserts value is ConformanceEvidence {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.boundary, `${label}.boundary`);
  assertNonEmptyString(value.implementationId, `${label}.implementationId`);
  assertNonEmptyString(value.language, `${label}.language`);
  assertNonEmptyString(value.suiteId, `${label}.suiteId`);
  assertNonEmptyString(value.suiteVersion, `${label}.suiteVersion`);
  assertConformanceStatus(value.status, `${label}.status`);

  const checkResults = readCheckResults(
    value.checkResults,
    `${label}.checkResults`
  );
  const expectedSummary = createConformanceEvidenceSummary(checkResults);

  if (!isRecord(value.summary)) {
    throw new Error(`${label}.summary must be an object`);
  }

  assertSafeInteger(
    value.summary.totalChecks,
    `${label}.summary.totalChecks`,
    expectedSummary.totalChecks
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

  const expectedStatus = expectedSummary.failedChecks === 0 ? "pass" : "fail";

  if (value.status !== expectedStatus) {
    throw new Error(
      `${label}.status must be ${expectedStatus} for the provided check results`
    );
  }
}

export function createConformanceEvidenceSummary(
  checkResults: readonly ConformanceCheckResult[]
): ConformanceEvidenceSummary {
  let passedChecks = 0;
  let failedChecks = 0;

  for (const checkResult of checkResults) {
    if (checkResult.status === "pass") {
      passedChecks += 1;
    } else {
      failedChecks += 1;
    }
  }

  return {
    failedChecks,
    passedChecks,
    totalChecks: checkResults.length,
  };
}

export function createCheckResult(
  checkId: string,
  assertionResults: readonly ConformanceAssertionResult[],
  details?: Record<string, unknown>
): ConformanceCheckResult {
  const status = assertionResults.every(
    (assertionResult) => assertionResult.status === "pass"
  )
    ? "pass"
    : "fail";

  return {
    assertionResults: [...assertionResults],
    checkId,
    details,
    status,
  };
}

export function createAssertionResult(
  assertionId: string,
  passed: boolean,
  message?: string
): ConformanceAssertionResult {
  return {
    assertionId,
    message,
    status: passed ? "pass" : "fail",
  };
}

function readSuiteFixtures(
  value: unknown,
  label: string
): readonly SuiteFixture[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when present`);
  }

  const fixtures = value.map((fixture, index) =>
    readFixture(fixture, `${label}[${index}]`)
  );
  assertUniqueIds(
    fixtures.map((fixture) => fixture.id),
    label
  );
  return fixtures;
}

function readFixture(value: unknown, label: string): SuiteFixture {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.id, `${label}.id`);
  assertNonEmptyString(value.path, `${label}.path`);
  return {
    id: value.id,
    path: value.path,
  };
}

function readSuiteScenarios(
  value: unknown,
  label: string
): readonly SuiteScenario[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when present`);
  }

  const scenarios = value.map((scenario, index) =>
    readScenario(scenario, `${label}[${index}]`)
  );
  assertUniqueIds(
    scenarios.map((scenario) => scenario.id),
    label
  );
  return scenarios;
}

function readScenario(value: unknown, label: string): SuiteScenario {
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
}

function readSuiteChecks(value: unknown, label: string): readonly SuiteCheck[] {
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
}

function readSuiteCheck(value: unknown, label: string): SuiteCheck {
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
}

function readCheckResults(
  value: unknown,
  label: string
): readonly ConformanceCheckResult[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  const checkResults = value.map((checkResult, index) =>
    readCheckResult(checkResult, `${label}[${index}]`)
  );
  assertUniqueIds(
    checkResults.map((checkResult) => checkResult.checkId),
    label
  );
  return checkResults;
}

function readCheckResult(
  value: unknown,
  label: string
): ConformanceCheckResult {
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
  const expectedStatus = assertionResults.every(
    (assertionResult) => assertionResult.status === "pass"
  )
    ? "pass"
    : "fail";

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
}

function readAssertionResults(
  value: unknown,
  label: string
): readonly ConformanceAssertionResult[] {
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
}

function readAssertionResult(
  value: unknown,
  label: string
): ConformanceAssertionResult {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertNonEmptyString(value.assertionId, `${label}.assertionId`);
  assertConformanceStatus(value.status, `${label}.status`);

  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error(`${label}.message must be a string when present`);
  }

  return {
    assertionId: value.assertionId,
    message: value.message,
    status: value.status,
  };
}

function readOptionalStringArray(
  value: unknown,
  label: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readStringArray(value, label, true);
}

function readStringArray(
  value: unknown,
  label: string,
  requireNonEmpty: boolean
): string[] {
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
}

function assertUniqueIds(values: readonly string[], label: string): void {
  const seenValues = new Set<string>();

  for (const value of values) {
    if (seenValues.has(value)) {
      throw new Error(`${label} must not contain duplicate ids`);
    }

    seenValues.add(value);
  }
}

function assertConformanceStatus(
  value: unknown,
  label: string
): asserts value is ConformanceStatus {
  if (value !== "fail" && value !== "pass") {
    throw new Error(`${label} must be "pass" or "fail"`);
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  expectedValue: number
): void {
  if (!Number.isSafeInteger(value) || value !== expectedValue) {
    throw new Error(`${label} must equal ${expectedValue}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
