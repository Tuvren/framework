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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { runCommand } from "./lib/command-runner.js";
import {
  assertConformanceEvidence,
  type ConformanceCheckResult,
  type ConformanceEvidence,
  type ConformanceSuiteManifest,
  createAssertionResult,
  createCheckResult,
  createConformanceEvidenceSummary,
} from "./lib/conformance-contract.js";
import { readConformanceSuiteManifest } from "./lib/conformance-runner.js";

interface CompatibilityMatrix {
  generatedAtMs: number;
  implementations: CompatibilityImplementation[];
  interop: CompatibilityInteropResult[];
  sourceRevision: string;
  suites: CompatibilitySuite[];
}

interface CompatibilityImplementation {
  implementationId: string;
  language: string;
  results: CompatibilityImplementationResult[];
  version: string;
}

interface CompatibilityImplementationResult {
  checkIds: string[];
  checkSummary: CompatibilityCheckSummary;
  evidencePath: string;
  status: "fail" | "pass";
  suiteId: string;
  suiteVersion: string;
}

interface CompatibilityInteropResult {
  checkIds: string[];
  checkSummary: CompatibilityCheckSummary;
  evidencePath: string;
  pairId: string;
  status: "fail" | "pass";
  suiteId: string;
  suiteVersion: string;
}

interface CompatibilityCheckSummary {
  applicableChecks?: number;
  failedChecks: number;
  nonApplicableChecks?: number;
  passedChecks: number;
  totalChecks: number;
}

interface CompatibilityConformanceEvidence {
  adapterId?: string;
  boundary: string;
  capabilities?: readonly string[];
  checkResults: readonly ConformanceCheckResult[];
  command: string[];
  exitCode: number;
  implementationId: string;
  nonApplicableCheckIds?: readonly string[];
  project: string;
  status: "fail" | "pass";
  stderr?: string;
  stdout?: string;
  suiteId: string;
  suiteVersion: string;
  summary: CompatibilityCheckSummary;
}

interface InteropTelemetrySummary {
  observedKeys: string[];
  scenarios: Array<{
    observedKeys: string[];
    scenario: string;
  }>;
  schemaUrl: string;
}

interface RawInteropTelemetry {
  attributes: Record<string, string | string[] | null>;
  observedKeys: string[];
  scenario: string;
  schemaUrl: string;
}

interface InteropScenarioReport {
  reports: Array<{
    checks: Record<string, boolean>;
    scenario: string;
    telemetry: RawInteropTelemetry;
  }>;
  scenarios: string[];
}

interface CompatibilitySuite {
  boundary: string;
  suiteId: string;
  suiteVersion: string;
}

interface ConformanceRunner {
  command?: string[];
  implementationId: string;
  language: string;
  manifestPath?: string;
  project: string;
}

interface InteropRunner {
  command?: string[];
  manifestPath: string;
  pairId: string;
  project: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPATIBILITY_MATRIX_PATH = resolve(
  REPO_ROOT,
  "reports/compatibility/compatibility-matrix.json"
);
const COMPATIBILITY_SCHEMA_PATH = resolve(
  REPO_ROOT,
  "reports/compatibility/compatibility-matrix.schema.json"
);
const EVIDENCE_DIRECTORY = resolve(REPO_ROOT, "reports/compatibility/evidence");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const TRANSITION_IMPLEMENTATION_VERSION = "unreleased-workspace";
const PREFIXED_OUTPUT_PATTERN = /^[A-Za-z0-9_.-]+: /u;
const COMPATIBILITY_METADATA = {
  generatedAtMs: 0,
  sourceRevision: "checked-in-workspace",
} as const;
// Evidence refresh can intentionally record known red lanes, but the default
// compatibility codegen path remains a pass/fail gate for verification.
const ALLOW_FAILING_EVIDENCE_FLAG = "--allow-failing-evidence";

const CONFORMANCE_RUNNERS: readonly ConformanceRunner[] = [
  {
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/framework/implementations/typescript/conformance-adapter/adapter.json",
    ],
    implementationId: "typescript-framework",
    language: "typescript",
    project: "framework-typescript-conformance-runner",
  },
  {
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter.json",
    ],
    implementationId: "typescript-kernel",
    language: "typescript",
    project: "kernel-typescript-conformance-runner",
  },
  {
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/providers/implementations/typescript/conformance-adapter/adapter.json",
    ],
    implementationId: "typescript-providers",
    language: "typescript",
    project: "providers-typescript-conformance-runner",
  },
  {
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/kernel/implementations/rust/conformance-adapter/adapter.json",
    ],
    implementationId: "rust-kernel",
    language: "rust",
    project: "kernel-rust-conformance-runner",
  },
  {
    // This lane is expected to emit red evidence today; the shared runner keeps
    // the structured JSON parseable after the process exits nonzero.
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/framework/implementations/rust/conformance-adapter/adapter.json",
    ],
    implementationId: "rust-framework",
    language: "rust",
    project: "framework-rust-conformance-runner",
  },
];

const INTEROP_RUNNERS: readonly InteropRunner[] = [
  {
    command: ["bun", "tools/scripts/playground-interop-smoke.ts"],
    manifestPath:
      "boundaries/framework/interop/rust-kernel/scenarios/suite-manifest.json",
    pairId: "typescript-framework__rust-kernel",
    project: "host-playground:interop-smoke",
  },
] as const;

await main();

async function main(): Promise<void> {
  const allowFailingEvidence = process.argv.includes(
    ALLOW_FAILING_EVIDENCE_FLAG
  );
  // Checked-in evidence must describe only the currently measured suite set,
  // so codegen clears the directory before regenerating the authoritative
  // suite-specific artifacts.
  await rm(EVIDENCE_DIRECTORY, { force: true, recursive: true });
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });

  const seenSuiteIds = new Set<string>();
  const suites: CompatibilitySuite[] = [];
  const implementations: CompatibilityImplementation[] = [];
  const interop: CompatibilityInteropResult[] = [];
  let hasFailure = false;

  for (const runner of CONFORMANCE_RUNNERS) {
    const suiteManifest =
      runner.manifestPath === undefined
        ? undefined
        : await readSuiteManifest(runner.manifestPath);
    const result = await runConformanceTarget(runner, suiteManifest);

    if (!seenSuiteIds.has(result.suite.suiteId)) {
      suites.push({
        boundary: result.suite.boundary,
        suiteId: result.suite.suiteId,
        suiteVersion: result.suite.suiteVersion,
      });
      seenSuiteIds.add(result.suite.suiteId);
    }
    // Epic R establishes the first measured TypeScript baseline only. Later
    // language lines append peer implementation evidence here rather than
    // treating TypeScript as the semantic root.
    implementations.push({
      implementationId: runner.implementationId,
      language: runner.language,
      results: [result.matrixResult],
      // The current TypeScript line is still an unreleased workspace
      // implementation, so the matrix records that explicitly instead of
      // echoing the private testkit packages' placeholder 0.0.0 versions.
      version: TRANSITION_IMPLEMENTATION_VERSION,
    });

    if (result.matrixResult.status === "fail") {
      hasFailure = true;
    }
  }

  for (const runner of INTEROP_RUNNERS) {
    const suiteManifest = await readSuiteManifest(runner.manifestPath);

    if (!seenSuiteIds.has(suiteManifest.suiteId)) {
      suites.push({
        boundary: suiteManifest.boundary,
        suiteId: suiteManifest.suiteId,
        suiteVersion: suiteManifest.suiteVersion,
      });
      seenSuiteIds.add(suiteManifest.suiteId);
    }

    const result = await runInteropTarget(runner, suiteManifest);
    interop.push(result.matrixResult);

    if (result.matrixResult.status === "fail") {
      hasFailure = true;
    }
  }

  const matrix: CompatibilityMatrix = {
    // The compatibility ledger is checked in as deterministic evidence. Git
    // history already records when and from which revision that evidence was
    // committed, so the JSON payload keeps stable sentinel metadata instead of
    // embedding wall-clock or HEAD-derived values that would churn on reruns.
    generatedAtMs: COMPATIBILITY_METADATA.generatedAtMs,
    implementations,
    interop,
    sourceRevision: COMPATIBILITY_METADATA.sourceRevision,
    suites,
  };

  assertCompatibilityMatrix(matrix);
  await assertCompatibilityMatrixSchema(matrix);
  await writeFile(
    COMPATIBILITY_MATRIX_PATH,
    `${JSON.stringify(matrix, null, 2)}\n`
  );
  // These generated files are checked in as reviewable evidence, so codegen
  // must leave them formatter-clean or the verify lane fails after a truthful
  // regeneration.
  await formatGeneratedOutputs();

  if (hasFailure && !allowFailingEvidence) {
    throw new Error("one or more conformance targets failed");
  }
}

async function readSuiteManifest(
  manifestPath: string
): Promise<ConformanceSuiteManifest> {
  return await readConformanceSuiteManifest(resolve(REPO_ROOT, manifestPath));
}

async function runConformanceTarget(
  runner: ConformanceRunner,
  suiteManifest: ConformanceSuiteManifest | undefined
): Promise<{
  matrixResult: CompatibilityImplementationResult;
  suite: CompatibilitySuite;
}> {
  // The compatibility matrix is meant to be measured evidence, not replayed
  // cached console output, so each conformance lane is forced to execute.
  const command = [
    ...(runner.command ?? [
      "bun",
      "run",
      "nx",
      "run",
      `${runner.project}:conformance`,
      "--skipNxCache",
    ]),
  ];
  const commandResult = await runCommand(command, {
    captureOutput: true,
    cwd: REPO_ROOT,
  });
  const evidenceFilePath = resolve(
    EVIDENCE_DIRECTORY,
    `shared-conformance-runner.${runner.implementationId}.json`
  );
  const relativeEvidencePath = relative(REPO_ROOT, evidenceFilePath);
  const fallbackCheckResults =
    suiteManifest === undefined
      ? []
      : createFallbackCheckResults(
          suiteManifest,
          "implementations",
          runner.implementationId,
          "runner exited without structured conformance evidence"
        );
  const parsedEvidence = readConformanceEvidence(commandResult.stdout);
  const evidencePayload =
    parsedEvidence === undefined
      ? createFallbackEvidence(
          suiteManifest ?? {
            boundary: "unknown",
            checks: [],
            suiteId: runner.project,
            suiteVersion: "0.0.0",
          },
          runner.implementationId,
          runner.language,
          fallbackCheckResults
        )
      : parsedEvidence;
  const status: "fail" | "pass" =
    commandResult.code === 0 && evidencePayload.status === "pass"
      ? "pass"
      : "fail";
  const evidence: CompatibilityConformanceEvidence = {
    adapterId: evidencePayload.adapterId,
    boundary: evidencePayload.boundary,
    capabilities: evidencePayload.capabilities,
    checkResults: evidencePayload.checkResults,
    command: sanitizeEvidenceCommand(command),
    exitCode: commandResult.code,
    implementationId: runner.implementationId,
    nonApplicableCheckIds: evidencePayload.nonApplicableCheckIds,
    project: runner.project,
    status,
    summary: evidencePayload.summary,
    suiteId: evidencePayload.suiteId,
    suiteVersion: evidencePayload.suiteVersion,
  };

  if (status === "fail" && parsedEvidence === undefined) {
    evidence.stderr = commandResult.stderr;
    evidence.stdout = commandResult.stdout;
  }

  await writeFile(evidenceFilePath, `${JSON.stringify(evidence, null, 2)}\n`);

  return {
    matrixResult: {
      checkIds: evidencePayload.checkResults.map((result) => result.checkId),
      checkSummary: evidencePayload.summary,
      evidencePath: relativeEvidencePath,
      status,
      suiteId: evidencePayload.suiteId,
      suiteVersion: evidencePayload.suiteVersion,
    },
    suite: {
      boundary: evidencePayload.boundary,
      suiteId: evidencePayload.suiteId,
      suiteVersion: evidencePayload.suiteVersion,
    },
  };
}

function sanitizeEvidenceCommand(command: readonly string[]): string[] {
  return command.map((part) =>
    part.includes("/conformance-adapter/") ? "[adapter-manifest]" : part
  );
}

async function runInteropTarget(
  runner: InteropRunner,
  suiteManifest: ConformanceSuiteManifest
): Promise<{
  matrixResult: CompatibilityInteropResult;
}> {
  // Interop evidence must measure the authoritative smoke implementation
  // directly. Using a mutable Nx wrapper here would let unrelated task-graph
  // fan-out change the compatibility result without any Rust-kernel regression.
  const command = runner.command ?? [
    "bun",
    "run",
    "nx",
    "run",
    runner.project,
    "--skipNxCache",
  ];
  const commandResult = await runCommand(command, {
    captureOutput: true,
    cwd: REPO_ROOT,
  });
  const evidenceFilePath = resolve(
    EVIDENCE_DIRECTORY,
    `${suiteManifest.suiteId}.${runner.pairId}.json`
  );
  const relativeEvidencePath = relative(REPO_ROOT, evidenceFilePath);
  const fallbackCheckResults = createFallbackCheckResults(
    suiteManifest,
    "interopPairs",
    runner.pairId,
    "interop runner exited without a parseable scenario report"
  );
  let status: "fail" | "pass" = commandResult.code === 0 ? "pass" : "fail";
  const evidence: {
    boundary: string;
    checkResults: ConformanceCheckResult[];
    command: string[];
    exitCode: number;
    pairId: string;
    project: string;
    status: "fail" | "pass";
    summary: CompatibilityCheckSummary;
    stderr?: string;
    stdout?: string;
    telemetry?: InteropTelemetrySummary;
    suiteId: string;
    suiteVersion: string;
  } = {
    boundary: suiteManifest.boundary,
    checkResults: fallbackCheckResults,
    command,
    exitCode: commandResult.code,
    pairId: runner.pairId,
    project: runner.project,
    status,
    summary: createConformanceEvidenceSummary(fallbackCheckResults),
    suiteId: suiteManifest.suiteId,
    suiteVersion: suiteManifest.suiteVersion,
  };

  if (status === "fail") {
    evidence.stderr = commandResult.stderr;
    evidence.stdout = commandResult.stdout;
  } else {
    const telemetry = readInteropTelemetrySummary(commandResult.stdout);
    const report = readInteropScenarioReport(commandResult.stdout);

    if (telemetry === undefined || report === undefined) {
      // Epic V treats telemetry as part of the measured interop evidence, so a
      // smoke target that exits 0 but stops emitting the report payload must
      // fail here instead of silently downgrading the checked-in artifact.
      evidence.stderr =
        "interop smoke completed without a parseable scenario report";
      evidence.stdout = commandResult.stdout;
      status = "fail";
      evidence.status = status;
    } else {
      evidence.checkResults = createInteropCheckResults(
        suiteManifest,
        runner.pairId,
        report
      );
      evidence.summary = createConformanceEvidenceSummary(
        evidence.checkResults
      );
      evidence.telemetry = telemetry;
      if (evidence.summary.failedChecks > 0) {
        status = "fail";
        evidence.status = status;
      }
    }
  }

  await writeFile(evidenceFilePath, `${JSON.stringify(evidence, null, 2)}\n`);

  return {
    matrixResult: {
      checkIds: evidence.checkResults.map((result) => result.checkId),
      checkSummary: evidence.summary,
      evidencePath: relativeEvidencePath,
      pairId: runner.pairId,
      status,
      suiteId: suiteManifest.suiteId,
      suiteVersion: suiteManifest.suiteVersion,
    },
  };
}

function readInteropTelemetrySummary(
  stdout: string
): InteropTelemetrySummary | undefined {
  // Nx target wrappers may prepend human-readable logs before the final JSON
  // matrix payload, so the evidence parser intentionally reads the trailing
  // object instead of assuming stdout is pure JSON from byte zero.
  const parsed = readInteropScenarioReport(stdout);

  if (parsed === undefined) {
    return undefined;
  }

  const expectedScenarios = readExpectedInteropScenarios(parsed.scenarios);

  if (expectedScenarios.length === 0) {
    return undefined;
  }

  const expectedScenarioSet = new Set(expectedScenarios);
  const seenScenarios = new Set<string>();
  const scenarios: InteropTelemetrySummary["scenarios"] = [];
  const observedKeys = new Set<string>();
  let schemaUrl: string | undefined;

  for (const report of parsed.reports) {
    const scenarioReport = readInteropTelemetryScenarioReport(
      report,
      expectedScenarioSet,
      seenScenarios,
      schemaUrl
    );

    if (scenarioReport === undefined) {
      return undefined;
    }

    schemaUrl = scenarioReport.schemaUrl;

    for (const key of scenarioReport.observedKeys) {
      observedKeys.add(key);
    }

    scenarios.push(scenarioReport.scenario);
  }

  if (
    schemaUrl === undefined ||
    scenarios.length !== expectedScenarios.length ||
    seenScenarios.size !== expectedScenarios.length
  ) {
    return undefined;
  }

  return {
    observedKeys: [...observedKeys].sort(),
    scenarios,
    schemaUrl,
  };
}

function readInteropScenarioReport(
  stdout: string
): InteropScenarioReport | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractTrailingJsonObject(stdout));
  } catch {
    return undefined;
  }

  if (
    !(
      isRecord(parsed) &&
      Array.isArray(parsed.reports) &&
      Array.isArray(parsed.scenarios)
    )
  ) {
    return undefined;
  }

  const scenarios = readExpectedInteropScenarios(parsed.scenarios);

  if (scenarios.length === 0) {
    return undefined;
  }

  const reports = parsed.reports
    .map((report) => readInteropScenarioEntry(report))
    .filter(
      (report): report is InteropScenarioReport["reports"][number] =>
        report !== undefined
    );

  if (reports.length !== scenarios.length) {
    return undefined;
  }

  return {
    reports,
    scenarios,
  };
}

function readExpectedInteropScenarios(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readInteropScenarioEntry(
  value: unknown
): InteropScenarioReport["reports"][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.scenario !== "string" ||
    !isRecord(value.checks) ||
    !isRecord(value.telemetry) ||
    !Array.isArray(value.telemetry.observedKeys) ||
    !isRecord(value.telemetry.attributes) ||
    typeof value.telemetry.schemaUrl !== "string"
  ) {
    return undefined;
  }

  const checks = Object.fromEntries(
    Object.entries(value.checks).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
    )
  );

  return {
    checks,
    scenario: value.scenario,
    telemetry: {
      attributes: value.telemetry.attributes as Record<
        string,
        string | string[] | null
      >,
      observedKeys: value.telemetry.observedKeys.filter(
        (entry): entry is string => typeof entry === "string"
      ),
      scenario: value.scenario,
      schemaUrl: value.telemetry.schemaUrl,
    },
  };
}

function readInteropTelemetryScenarioReport(
  report: unknown,
  expectedScenarioSet: Set<string>,
  seenScenarios: Set<string>,
  currentSchemaUrl: string | undefined
):
  | {
      observedKeys: string[];
      scenario: InteropTelemetrySummary["scenarios"][number];
      schemaUrl: string;
    }
  | undefined {
  if (
    !isRecord(report) ||
    typeof report.scenario !== "string" ||
    !expectedScenarioSet.has(report.scenario) ||
    seenScenarios.has(report.scenario)
  ) {
    return undefined;
  }

  const telemetry = report.telemetry;

  if (
    !isRecord(telemetry) ||
    typeof telemetry.schemaUrl !== "string" ||
    !Array.isArray(telemetry.observedKeys) ||
    !isRecord(telemetry.attributes)
  ) {
    return undefined;
  }

  if (
    currentSchemaUrl !== undefined &&
    currentSchemaUrl !== telemetry.schemaUrl
  ) {
    // Mixed schema URLs would make the checked-in evidence internally
    // inconsistent, so reject the whole summary instead of weakening it.
    return undefined;
  }

  const observedKeys = telemetry.observedKeys.filter(
    (value): value is string => typeof value === "string"
  );
  const scenario = {
    // Interop telemetry values include run ids, branch ids, and checkpoint
    // hashes that are intentionally different on every smoke execution. The
    // checked-in compatibility evidence keeps only the stable key coverage and
    // schema identity so reruns stay reviewable instead of churning on known
    // per-run entropy.
    observedKeys,
    scenario: report.scenario,
  };

  seenScenarios.add(report.scenario);
  return {
    observedKeys,
    scenario,
    schemaUrl: telemetry.schemaUrl,
  };
}

function extractTrailingJsonObject(stdout: string): string {
  const prefixedJsonLines = stdout
    .split("\n")
    .filter((line) => PREFIXED_OUTPUT_PATTERN.test(line))
    .map((line) => line.replace(PREFIXED_OUTPUT_PATTERN, ""));

  if (prefixedJsonLines.length > 0) {
    const jsonStart = prefixedJsonLines.findIndex((line) =>
      line.trimStart().startsWith("{")
    );

    if (jsonStart !== -1) {
      return prefixedJsonLines.slice(jsonStart).join("\n").trim();
    }
  }

  const trimmed = stdout.trim();
  const objectStart = trimmed.lastIndexOf("\n{");

  if (objectStart === -1) {
    return trimmed;
  }

  return trimmed.slice(objectStart + 1);
}

function readConformanceEvidence(
  stdout: string
): ConformanceEvidence | undefined {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(extractTrailingJsonObject(stdout));
    assertConformanceEvidence(parsed, "runner evidence");
    return parsed;
  } catch {
    return undefined;
  }
}

function createFallbackEvidence(
  suiteManifest: ConformanceSuiteManifest,
  implementationId: string,
  language: string,
  checkResults: readonly ConformanceCheckResult[]
): ConformanceEvidence {
  const summary = createConformanceEvidenceSummary(checkResults);

  return {
    boundary: suiteManifest.boundary,
    checkResults: [...checkResults],
    implementationId,
    language,
    status: summary.failedChecks === 0 ? "pass" : "fail",
    suiteId: suiteManifest.suiteId,
    suiteVersion: suiteManifest.suiteVersion,
    summary,
  };
}

function createFallbackCheckResults(
  suiteManifest: ConformanceSuiteManifest,
  applicabilityKey: "implementations" | "interopPairs",
  applicabilityId: string,
  message: string
): ConformanceCheckResult[] {
  return suiteManifest.checks
    .filter((check) => check[applicabilityKey]?.includes(applicabilityId))
    .map((check) =>
      createCheckResult(
        check.checkId,
        check.assertions.map((assertionId) =>
          createAssertionResult(assertionId, false, message)
        ),
        {
          expectedEvidence: check.expectedEvidence,
        }
      )
    );
}

function createInteropCheckResults(
  suiteManifest: ConformanceSuiteManifest,
  pairId: string,
  report: InteropScenarioReport
): ConformanceCheckResult[] {
  const reportByScenario = new Map(
    report.reports.map((entry) => [entry.scenario, entry] as const)
  );

  return suiteManifest.checks
    .filter((check) => check.interopPairs?.includes(pairId))
    .map((check) => {
      // One named interop check may intentionally aggregate more than one
      // scenario report. We keep that fan-in explicit here so the checked-in
      // evidence matches the boundary-owned check catalog rather than the
      // playground script's current scenario granularity.
      const expectedScenarioIds = check.scenarioIds ?? [];
      const scenarioReports = expectedScenarioIds
        .map((scenarioId) => reportByScenario.get(scenarioId))
        .filter(
          (
            scenarioReport
          ): scenarioReport is InteropScenarioReport["reports"][number] =>
            scenarioReport !== undefined
        );
      const missingScenarioIds = expectedScenarioIds.filter(
        (scenarioId) => !reportByScenario.has(scenarioId)
      );
      const assertionResults = check.assertions.map((assertionId) => {
        const passed =
          missingScenarioIds.length === 0 &&
          scenarioReports.every(
            (scenarioReport) => scenarioReport.checks[assertionId] === true
          );
        let message: string | undefined;

        if (missingScenarioIds.length > 0) {
          message = `interop scenario report is missing required scenarios: ${missingScenarioIds.join(", ")}`;
        } else if (
          // Missing manifest-declared scenarios must fail the whole check.
          // Otherwise `every()` on an empty subset would let a vanished
          // smoke lane produce a false green compatibility artifact.
          !scenarioReports.some(
            (scenarioReport) => scenarioReport.checks[assertionId] === true
          )
        ) {
          message =
            "interop scenario report did not mark this assertion as passing";
        }

        return createAssertionResult(assertionId, passed, message);
      });

      return createCheckResult(check.checkId, assertionResults, {
        missingScenarioIds,
        scenario: check.scenarioIds ?? [],
        telemetry: scenarioReports.map((scenarioReport) => ({
          observedKeys: scenarioReport.telemetry.observedKeys,
          scenario: scenarioReport.scenario,
          schemaUrl: scenarioReport.telemetry.schemaUrl,
        })),
      });
    });
}

async function formatGeneratedOutputs(): Promise<void> {
  const result = await runCommand(
    [
      "bunx",
      "--bun",
      "@biomejs/biome",
      "check",
      "--write",
      COMPATIBILITY_MATRIX_PATH,
      EVIDENCE_DIRECTORY,
    ],
    {
      captureOutput: true,
      cwd: REPO_ROOT,
    }
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        "formatting generated compatibility outputs failed"
    );
  }
}

async function assertCompatibilityMatrixSchema(
  value: CompatibilityMatrix
): Promise<void> {
  const schemaText = await readFile(COMPATIBILITY_SCHEMA_PATH, "utf8");
  const parsedSchema = readJsonSchema(JSON.parse(schemaText));
  const validate = ajv.compile(parsedSchema);

  // The checked-in schema is the machine contract for compatibility evidence,
  // so codegen validates against it directly instead of relying only on the
  // narrower TypeScript assertions above.
  if (validate(value)) {
    return;
  }

  throw new Error(
    `compatibility matrix failed JSON Schema validation: ${ajv.errorsText(validate.errors)}`
  );
}

function readJsonSchema(value: unknown): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error("compatibility matrix schema must be an object or boolean");
}

function assertCompatibilityMatrix(
  value: CompatibilityMatrix
): asserts value is CompatibilityMatrix {
  if (
    !Number.isSafeInteger(value.generatedAtMs) ||
    value.generatedAtMs < 0 ||
    value.sourceRevision.length === 0
  ) {
    throw new Error(
      "compatibility matrix must contain a generatedAtMs timestamp and sourceRevision"
    );
  }

  for (const suite of value.suites) {
    if (
      suite.boundary.length === 0 ||
      suite.suiteId.length === 0 ||
      suite.suiteVersion.length === 0
    ) {
      throw new Error(
        "compatibility matrix suites must contain non-empty fields"
      );
    }
  }

  for (const implementation of value.implementations) {
    if (
      implementation.implementationId.length === 0 ||
      implementation.language.length === 0 ||
      implementation.version.length === 0
    ) {
      throw new Error(
        "compatibility matrix implementations must contain non-empty fields"
      );
    }

    for (const result of implementation.results) {
      if (
        result.evidencePath.length === 0 ||
        result.suiteId.length === 0 ||
        result.suiteVersion.length === 0
      ) {
        throw new Error(
          "compatibility matrix implementation results must contain non-empty fields"
        );
      }

      assertCompatibilityCheckSummary(result.checkSummary);
      assertCompatibilityResultCheckIds(
        result.checkIds,
        result.checkSummary,
        "compatibility matrix implementation results"
      );
    }
  }

  for (const interopResult of value.interop) {
    if (
      interopResult.evidencePath.length === 0 ||
      interopResult.pairId.length === 0 ||
      interopResult.suiteId.length === 0 ||
      interopResult.suiteVersion.length === 0
    ) {
      throw new Error(
        "compatibility matrix interop results must contain non-empty fields"
      );
    }

    assertCompatibilityCheckSummary(interopResult.checkSummary);
    assertCompatibilityResultCheckIds(
      interopResult.checkIds,
      interopResult.checkSummary,
      "compatibility matrix interop results"
    );
  }
}

function assertCompatibilityResultCheckIds(
  checkIds: readonly string[],
  summary: CompatibilityCheckSummary,
  label: string
): void {
  if (checkIds.length > 0) {
    return;
  }

  if (
    summary.totalChecks === (summary.nonApplicableChecks ?? 0) &&
    (summary.applicableChecks ?? 0) === 0
  ) {
    return;
  }

  throw new Error(`${label} must contain check ids for applicable checks`);
}

function assertCompatibilityCheckSummary(
  value: CompatibilityCheckSummary
): void {
  const applicableChecks =
    value.applicableChecks ?? value.failedChecks + value.passedChecks;
  const nonApplicableChecks = value.nonApplicableChecks ?? 0;

  if (
    !(
      Number.isSafeInteger(applicableChecks) &&
      Number.isSafeInteger(value.failedChecks) &&
      Number.isSafeInteger(value.passedChecks) &&
      Number.isSafeInteger(value.totalChecks) &&
      Number.isSafeInteger(nonApplicableChecks)
    ) ||
    applicableChecks < 0 ||
    value.failedChecks < 0 ||
    value.passedChecks < 0 ||
    nonApplicableChecks < 0 ||
    value.totalChecks <= 0 ||
    applicableChecks !== value.failedChecks + value.passedChecks ||
    applicableChecks + nonApplicableChecks !== value.totalChecks
  ) {
    throw new Error(
      "compatibility matrix check summaries must be internally consistent"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
