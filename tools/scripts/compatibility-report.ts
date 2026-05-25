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

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

type CompatibilityReportStatus =
  | "capability_subset_pass"
  | "expected_fail"
  | "full_pass"
  | "not_applicable"
  | "unexpected_fail"
  | "unsupported";

type CompatibilityResultStatus =
  | "fail"
  | "not_applicable"
  | "pass"
  | "unsupported";

interface CompatibilityImplementationResult {
  checkIds: string[];
  checkSummary: CompatibilityCheckSummary;
  declaredCapabilities?: readonly string[];
  evidencePath: string;
  reportLabel: string;
  reportStatus: CompatibilityReportStatus;
  status: CompatibilityResultStatus;
  suiteId: string;
  suiteVersion: string;
}

interface CompatibilityInteropResult {
  checkIds: string[];
  checkSummary: CompatibilityCheckSummary;
  evidencePath: string;
  pairId: string;
  reportLabel: string;
  reportStatus: CompatibilityReportStatus;
  status: CompatibilityResultStatus;
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
  reportLabel: string;
  reportStatus: CompatibilityReportStatus;
  status: CompatibilityResultStatus;
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
  // Path (relative to repo root) to the adapter manifest this lane drives.
  // The expected "full capability set" is derived from the topology this
  // manifest exposes (its `authorityPackets` → each packet's
  // `conformancePlans` → each plan's plan-level and check-level
  // `capabilities`). Compatibility-report no longer carries a parallel
  // hardcoded list — see KRT-AL003 followup review wave 4.
  adapterManifestPath: string;
  command?: string[];
  expectedFailure?: boolean;
  implementationId: string;
  language: string;
  manifestPath?: string;
  prerequisiteCommands?: string[][];
  project: string;
  reportLabel: string;
}

interface InteropRunner {
  command?: string[];
  manifestPath: string;
  pairId: string;
  project: string;
  reportLabel: string;
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
const HERMETIC_BUILD_OUTPUT_DIRECTORIES = [
  "boundaries/kernel/implementations/typescript/conformance-adapter/dist",
  "boundaries/kernel/implementations/typescript/backend-memory/dist",
  "boundaries/kernel/implementations/typescript/backend-sqlite/dist",
  "boundaries/kernel/implementations/typescript/runtime-kernel/dist",
] as const;
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
const CHECK_FLAG = "--check";

const CONFORMANCE_RUNNERS: readonly ConformanceRunner[] = [
  {
    adapterManifestPath:
      "boundaries/framework/implementations/typescript/conformance-adapter/adapter.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/framework/implementations/typescript/conformance-adapter/adapter.json",
    ],
    implementationId: "typescript-framework",
    language: "typescript",
    prerequisiteCommands: [
      [
        "bun",
        "run",
        "nx",
        "run",
        "kernel-interop-grpc:codegen",
        "--skipNxCache",
      ],
      ["bun", "run", "nx", "run", "host-repl:build", "--skipNxCache"],
    ],
    project: "framework-typescript-conformance-runner",
    reportLabel: "TypeScript framework runtime baseline",
  },
  {
    adapterManifestPath:
      "boundaries/framework/implementations/typescript/conformance-adapter/adapter-batteries-included.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/framework/implementations/typescript/conformance-adapter/adapter-batteries-included.json",
    ],
    implementationId: "typescript-framework",
    language: "typescript",
    prerequisiteCommands: [
      [
        "bun",
        "run",
        "nx",
        "run",
        "framework-typescript-conformance-adapter:build-batteries-included",
        "--skipNxCache",
      ],
    ],
    project: "framework-batteries-included-conformance-runner",
    reportLabel: "TypeScript framework batteries-included runtime",
  },
  {
    adapterManifestPath:
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter.json",
      "--concurrency",
      "4",
    ],
    implementationId: "typescript-kernel-memory",
    language: "typescript",
    prerequisiteCommands: [
      [
        "bun",
        "run",
        "nx",
        "run-many",
        "-t",
        "build",
        "-p",
        "backend-memory,kernel-runtime,kernel-typescript-conformance-adapter",
        "--skipNxCache",
      ],
    ],
    project: "kernel-typescript-conformance-runner",
    reportLabel: "TypeScript process-local kernel baseline",
  },
  {
    adapterManifestPath:
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter-sqlite.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter-sqlite.json",
      "--concurrency",
      "4",
    ],
    implementationId: "typescript-kernel-sqlite",
    language: "typescript",
    prerequisiteCommands: [
      [
        "bun",
        "run",
        "nx",
        "run-many",
        "-t",
        "build",
        "-p",
        "backend-sqlite,kernel-runtime,kernel-typescript-conformance-adapter",
        "--skipNxCache",
      ],
    ],
    project: "kernel-typescript-sqlite-conformance-runner",
    reportLabel: "TypeScript SQLite durable kernel",
  },
  {
    // The Postgres-backed kernel is the third measured kernel persistence
    // tier and is already part of the canonical `bun run conformance` set, so
    // the compatibility matrix needs to record it alongside the memory and
    // SQLite tiers — otherwise the PR's "memory + SQLite + PostgreSQL"
    // platform-gate claim is not actually proved in checked-in evidence.
    // This lane runs through Nx so it shares the canonical Postgres runner
    // target. The caller is responsible for starting the direnv-provisioned
    // Postgres service before refreshing measured evidence.
    adapterManifestPath:
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter-postgres.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/kernel/implementations/typescript/conformance-adapter/adapter-postgres.json",
      "--concurrency",
      "4",
    ],
    implementationId: "typescript-kernel-postgres",
    language: "typescript",
    prerequisiteCommands: [
      [
        "bun",
        "run",
        "nx",
        "run-many",
        "-t",
        "build",
        "-p",
        "backend-postgres,kernel-runtime,kernel-typescript-conformance-adapter",
        "--skipNxCache",
      ],
    ],
    project: "kernel-typescript-postgres-conformance-runner",
    reportLabel: "TypeScript PostgreSQL durable kernel",
  },
  {
    adapterManifestPath:
      "boundaries/providers/implementations/typescript/conformance-adapter/adapter.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/providers/implementations/typescript/conformance-adapter/adapter.json",
    ],
    implementationId: "typescript-providers",
    language: "typescript",
    project: "providers-typescript-conformance-runner",
    reportLabel: "TypeScript AI SDK provider bridge",
  },
  {
    adapterManifestPath:
      "boundaries/kernel/implementations/rust/conformance-adapter/adapter.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/kernel/implementations/rust/conformance-adapter/adapter.json",
    ],
    implementationId: "rust-kernel",
    language: "rust",
    project: "kernel-rust-conformance-runner",
    reportLabel: "Rust process-local kernel baseline",
  },
  {
    adapterManifestPath:
      "boundaries/framework/implementations/rust/conformance-adapter/adapter.json",
    command: [
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      "boundaries/framework/implementations/rust/conformance-adapter/adapter.json",
    ],
    implementationId: "rust-framework",
    language: "rust",
    project: "framework-rust-conformance-runner",
    reportLabel: "Rust framework unsupported stub",
  },
];

const INTEROP_RUNNERS: readonly InteropRunner[] = [
  {
    command: ["bun", "tools/scripts/repl-host-interop-smoke.ts"],
    manifestPath:
      "boundaries/framework/interop/rust-kernel/scenarios/suite-manifest.json",
    pairId: "typescript-framework__rust-kernel",
    project: "host-repl:interop-smoke",
    reportLabel: "TypeScript framework to Rust kernel interop",
  },
] as const;

await main();

async function main(): Promise<void> {
  const allowFailingEvidence = process.argv.includes(
    ALLOW_FAILING_EVIDENCE_FLAG
  );

  if (process.argv.includes(CHECK_FLAG)) {
    await checkCompatibilityEvidence();
    return;
  }

  // Compatibility evidence must prove the SQLite lane can rebuild from a clean
  // checkout instead of inheriting prior local dist residue.
  await resetHermeticBuildBoundary();
  // Checked-in evidence must describe only the currently measured suite set,
  // so codegen clears the directory before regenerating the authoritative
  // suite-specific artifacts.
  await rm(EVIDENCE_DIRECTORY, { force: true, recursive: true });
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });

  // Derive the expected "full capability set" for each runner from the
  // adapter manifest topology (its `authorityPackets` → packets' plans →
  // plan-level + check-level `capabilities`). Computing this once up front
  // means classifying each lane's pass/subset status remains a pure lookup
  // in the inner loop while the source of truth stays on disk in the
  // packets and plans.
  const expectedCapabilitiesByRunner = new Map<string, ReadonlySet<string>>();

  for (const runner of CONFORMANCE_RUNNERS) {
    expectedCapabilitiesByRunner.set(
      createConformanceRunnerKey(runner),
      await computeExpectedCapabilitiesFromTopology(runner.adapterManifestPath)
    );
  }

  const seenSuiteKeys = new Set<string>();
  const suites: CompatibilitySuite[] = [];
  const implementations: CompatibilityImplementation[] = [];
  const interop: CompatibilityInteropResult[] = [];
  let hasFailure = false;

  for (const runner of CONFORMANCE_RUNNERS) {
    const suiteManifest =
      runner.manifestPath === undefined
        ? undefined
        : await readSuiteManifest(runner.manifestPath);
    const expectedCapabilities = expectedCapabilitiesByRunner.get(
      createConformanceRunnerKey(runner)
    );

    if (expectedCapabilities === undefined) {
      throw new Error(
        `internal: expected capabilities not pre-computed for ${runner.implementationId}`
      );
    }

    const result = await runConformanceTarget(
      runner,
      suiteManifest,
      expectedCapabilities
    );

    const suiteKey = createSuiteKey(
      result.suite.boundary,
      result.suite.suiteId,
      result.suite.suiteVersion
    );

    if (!seenSuiteKeys.has(suiteKey)) {
      suites.push({
        boundary: result.suite.boundary,
        suiteId: result.suite.suiteId,
        suiteVersion: result.suite.suiteVersion,
      });
      seenSuiteKeys.add(suiteKey);
    }
    upsertCompatibilityImplementation(
      implementations,
      runner,
      result.matrixResult
    );

    if (result.matrixResult.status === "fail") {
      hasFailure = true;
    }
  }

  for (const runner of INTEROP_RUNNERS) {
    const suiteManifest = await readSuiteManifest(runner.manifestPath);
    const suiteKey = createSuiteKey(
      suiteManifest.boundary,
      suiteManifest.suiteId,
      suiteManifest.suiteVersion
    );

    if (!seenSuiteKeys.has(suiteKey)) {
      suites.push({
        boundary: suiteManifest.boundary,
        suiteId: suiteManifest.suiteId,
        suiteVersion: suiteManifest.suiteVersion,
      });
      seenSuiteKeys.add(suiteKey);
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

function upsertCompatibilityImplementation(
  implementations: CompatibilityImplementation[],
  runner: ConformanceRunner,
  result: CompatibilityImplementationResult
): void {
  const existingImplementation = implementations.find(
    (implementation) =>
      implementation.implementationId === runner.implementationId &&
      implementation.language === runner.language &&
      implementation.version === TRANSITION_IMPLEMENTATION_VERSION
  );

  if (existingImplementation === undefined) {
    // The current workspace implementations are unreleased, so the matrix
    // records that explicitly instead of echoing private package placeholders.
    implementations.push({
      implementationId: runner.implementationId,
      language: runner.language,
      results: [result],
      version: TRANSITION_IMPLEMENTATION_VERSION,
    });
    return;
  }

  existingImplementation.results.push(result);
}

async function checkCompatibilityEvidence(): Promise<void> {
  const matrix = JSON.parse(
    await readFile(COMPATIBILITY_MATRIX_PATH, "utf8")
  ) as CompatibilityMatrix;
  assertCompatibilityMatrix(matrix);
  await assertCompatibilityMatrixSchema(matrix);

  const matrixEvidencePaths = new Set<string>();
  const failures: string[] = [];

  await checkLiveSuiteTopology(matrix.suites, failures);
  await checkImplementationEvidence(
    matrix.implementations,
    matrixEvidencePaths,
    failures
  );
  await checkConformanceRunnerInventory(matrix.implementations, failures);
  checkInteropRunnerInventory(matrix.interop, failures);

  const liveInteropEntries = await readLiveInteropRunners();

  for (const result of matrix.interop) {
    const liveEntry = liveInteropEntries.find(
      (entry) => entry.runner.pairId === result.pairId
    );

    if (liveEntry === undefined) {
      failures.push(
        `compatibility matrix interop pair ${result.pairId} is not present in live runner topology`
      );
      continue;
    }

    matrixEvidencePaths.add(result.evidencePath);
    compareLiveInteropResult(liveEntry.liveRunner, result, failures);

    if (result.status === "fail" || result.reportStatus === "unexpected_fail") {
      failures.push(
        `${result.pairId} ${result.suiteId} records ${result.reportStatus}`
      );
    }

    await checkInteropEvidenceFile(
      result.evidencePath,
      result,
      liveEntry.liveRunner,
      failures
    );
  }

  const evidenceEntries = await readdir(EVIDENCE_DIRECTORY);

  for (const entry of evidenceEntries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const evidencePath = relative(
      REPO_ROOT,
      resolve(EVIDENCE_DIRECTORY, entry)
    );

    if (!matrixEvidencePaths.has(evidencePath)) {
      failures.push(
        `${evidencePath} is not referenced by the compatibility matrix`
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "compatibility evidence check failed:",
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n")
    );
  }

  console.log("compatibility evidence check passed");
}

async function checkLiveSuiteTopology(
  matrixSuites: readonly CompatibilitySuite[],
  failures: string[]
): Promise<void> {
  const liveSuites = await readLiveCompatibilitySuites();
  const liveSuiteKeys = new Set(
    liveSuites.map((suite) =>
      createSuiteKey(suite.boundary, suite.suiteId, suite.suiteVersion)
    )
  );
  const matrixSuiteKeys = new Set(
    matrixSuites.map((suite) =>
      createSuiteKey(suite.boundary, suite.suiteId, suite.suiteVersion)
    )
  );

  for (const liveSuite of liveSuites) {
    if (
      !matrixSuiteKeys.has(
        createSuiteKey(
          liveSuite.boundary,
          liveSuite.suiteId,
          liveSuite.suiteVersion
        )
      )
    ) {
      failures.push(
        `compatibility matrix is missing live suite ${liveSuite.suiteId}@${liveSuite.suiteVersion}`
      );
    }
  }

  for (const matrixSuite of matrixSuites) {
    if (
      !liveSuiteKeys.has(
        createSuiteKey(
          matrixSuite.boundary,
          matrixSuite.suiteId,
          matrixSuite.suiteVersion
        )
      )
    ) {
      failures.push(
        `compatibility matrix suite ${matrixSuite.suiteId}@${matrixSuite.suiteVersion} is not present in live runner topology`
      );
    }
  }
}

async function checkConformanceRunnerInventory(
  implementations: readonly CompatibilityImplementation[],
  failures: string[]
): Promise<void> {
  const matrixRunnerKeys = new Set(
    implementations.flatMap((implementation) =>
      implementation.results.map((result) =>
        createCompatibilityRunnerKey(
          implementation.implementationId,
          result.suiteId,
          result.suiteVersion
        )
      )
    )
  );

  for (const runner of CONFORMANCE_RUNNERS) {
    const liveRunner = await readLiveConformanceRunner(runner);
    const runnerKey = createCompatibilityRunnerKey(
      runner.implementationId,
      liveRunner.suite.suiteId,
      liveRunner.suite.suiteVersion
    );

    if (!matrixRunnerKeys.has(runnerKey)) {
      failures.push(
        `compatibility matrix is missing live implementation ${runner.implementationId} for ${liveRunner.suite.suiteId}@${liveRunner.suite.suiteVersion}`
      );
    }
  }
}

function checkInteropRunnerInventory(
  interopResults: readonly CompatibilityInteropResult[],
  failures: string[]
): void {
  const matrixPairIds = new Set(interopResults.map((result) => result.pairId));

  for (const runner of INTEROP_RUNNERS) {
    if (!matrixPairIds.has(runner.pairId)) {
      failures.push(
        `compatibility matrix is missing live interop pair ${runner.pairId}`
      );
    }
  }
}

async function checkImplementationEvidence(
  implementations: readonly CompatibilityImplementation[],
  matrixEvidencePaths: Set<string>,
  failures: string[]
): Promise<void> {
  const liveEntries = await Promise.all(
    CONFORMANCE_RUNNERS.map(async (runner) => ({
      liveRunner: await readLiveConformanceRunner(runner),
      runner,
    }))
  );

  for (const implementation of implementations) {
    for (const result of implementation.results) {
      const liveEntry = liveEntries.find(
        (entry) =>
          entry.runner.implementationId === implementation.implementationId &&
          entry.liveRunner.suite.suiteId === result.suiteId &&
          entry.liveRunner.suite.suiteVersion === result.suiteVersion
      );

      if (liveEntry === undefined) {
        failures.push(
          `compatibility matrix implementation ${implementation.implementationId} ${result.suiteId}@${result.suiteVersion} is not present in live runner topology`
        );
        continue;
      }

      matrixEvidencePaths.add(result.evidencePath);
      compareLiveConformanceResult(
        implementation.implementationId,
        liveEntry.liveRunner,
        result,
        failures
      );

      if (
        result.status === "fail" ||
        result.reportStatus === "unexpected_fail"
      ) {
        failures.push(
          `${implementation.implementationId} ${result.suiteId} records ${result.reportStatus}`
        );
      }

      await checkImplementationEvidenceFile(
        result.evidencePath,
        implementation,
        result,
        liveEntry.liveRunner,
        failures
      );
    }
  }
}

async function checkImplementationEvidenceFile(
  evidencePath: string,
  implementation: CompatibilityImplementation,
  result: CompatibilityImplementationResult,
  liveRunner: LiveConformanceRunner,
  failures: string[]
): Promise<void> {
  const absolutePath = resolve(REPO_ROOT, evidencePath);
  const evidence = JSON.parse(await readFile(absolutePath, "utf8"));

  if (!isRecord(evidence)) {
    failures.push(`${evidencePath} must contain a JSON object`);
    return;
  }

  if (
    evidence.status === "fail" ||
    evidence.reportStatus === "unexpected_fail"
  ) {
    failures.push(
      `${evidencePath} records ${String(evidence.reportStatus ?? evidence.status)}`
    );
  }

  compareEvidenceField(
    evidencePath,
    "implementationId",
    evidence.implementationId,
    implementation.implementationId,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "boundary",
    evidence.boundary,
    liveRunner.suite.boundary,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "suiteId",
    evidence.suiteId,
    result.suiteId,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "suiteVersion",
    evidence.suiteVersion,
    result.suiteVersion,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "status",
    evidence.status,
    result.status,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "reportStatus",
    evidence.reportStatus,
    result.reportStatus,
    failures
  );
  compareCheckIds(
    evidencePath,
    evidence.checkResults,
    result.checkIds,
    failures
  );
  compareCheckSummary(
    evidencePath,
    evidence.summary,
    result.checkSummary,
    failures
  );
  compareNonApplicableCheckIds(
    evidencePath,
    evidence.nonApplicableCheckIds,
    liveRunner.nonApplicableCheckIds,
    failures
  );
  compareStringSet(
    evidencePath,
    "capabilities",
    evidence.capabilities,
    result.declaredCapabilities ?? [],
    failures
  );
  compareStringSet(
    `compatibility matrix ${implementation.implementationId}`,
    "declaredCapabilities",
    result.declaredCapabilities ?? [],
    liveRunner.capabilities,
    failures
  );
}

async function readLiveCompatibilitySuites(): Promise<CompatibilitySuite[]> {
  const suitesByKey = new Map<string, CompatibilitySuite>();

  for (const runner of CONFORMANCE_RUNNERS) {
    const manifest = await readAdapterManifest(runner.adapterManifestPath);
    const suite = readAdapterSuite(manifest, runner.adapterManifestPath);
    suitesByKey.set(
      createSuiteKey(suite.boundary, suite.suiteId, suite.suiteVersion),
      suite
    );
  }

  for (const runner of INTEROP_RUNNERS) {
    const suiteManifest = await readSuiteManifest(runner.manifestPath);
    const suite = {
      boundary: suiteManifest.boundary,
      suiteId: suiteManifest.suiteId,
      suiteVersion: suiteManifest.suiteVersion,
    };
    suitesByKey.set(
      createSuiteKey(suite.boundary, suite.suiteId, suite.suiteVersion),
      suite
    );
  }

  return [...suitesByKey.values()];
}

interface LiveConformanceRunner {
  applicableCheckIds: readonly string[];
  capabilities: readonly string[];
  nonApplicableCheckIds: readonly string[];
  suite: CompatibilitySuite;
}

async function readLiveConformanceRunner(
  runner: ConformanceRunner
): Promise<LiveConformanceRunner> {
  const manifest = await readAdapterManifest(runner.adapterManifestPath);
  const suite = readAdapterSuite(manifest, runner.adapterManifestPath);
  const capabilities = new Set(readStringArray(manifest.capabilities));
  const packetPaths = readStringArray(manifest.authorityPackets);
  const applicableCheckIds: string[] = [];
  const allCheckIds: string[] = [];
  const seenPlanPaths = new Set<string>();

  for (const packetPath of packetPaths) {
    const packetManifest = JSON.parse(
      await readFile(resolve(REPO_ROOT, packetPath), "utf8")
    ) as {
      conformancePlans?: Array<{ path?: unknown }>;
    };

    for (const plan of packetManifest.conformancePlans ?? []) {
      if (typeof plan.path !== "string") {
        continue;
      }

      const planPath = resolve(REPO_ROOT, plan.path);

      if (seenPlanPaths.has(planPath)) {
        continue;
      }

      seenPlanPaths.add(planPath);

      const planJson = await readFile(planPath, "utf8");
      const planChecks = readLivePlanChecks(planJson, capabilities);
      applicableCheckIds.push(...planChecks.applicableCheckIds);
      allCheckIds.push(...planChecks.allCheckIds);
    }
  }

  const applicableCheckIdSet = new Set(applicableCheckIds);

  return {
    applicableCheckIds,
    capabilities: [...capabilities],
    nonApplicableCheckIds: allCheckIds.filter(
      (checkId) => !applicableCheckIdSet.has(checkId)
    ),
    suite,
  };
}

interface LiveInteropRunner {
  checkIds: readonly string[];
  suite: CompatibilitySuite;
}

async function readLiveInteropRunners(): Promise<
  Array<{ liveRunner: LiveInteropRunner; runner: InteropRunner }>
> {
  return await Promise.all(
    INTEROP_RUNNERS.map(async (runner) => ({
      liveRunner: await readLiveInteropRunner(runner),
      runner,
    }))
  );
}

async function readLiveInteropRunner(
  runner: InteropRunner
): Promise<LiveInteropRunner> {
  const suiteManifest = await readSuiteManifest(runner.manifestPath);

  return {
    checkIds: suiteManifest.checks
      .filter((check) => check.interopPairs?.includes(runner.pairId))
      .map((check) => check.checkId),
    suite: {
      boundary: suiteManifest.boundary,
      suiteId: suiteManifest.suiteId,
      suiteVersion: suiteManifest.suiteVersion,
    },
  };
}

async function readAdapterManifest(
  adapterManifestPath: string
): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    await readFile(resolve(REPO_ROOT, adapterManifestPath), "utf8")
  );

  if (!isRecord(manifest)) {
    throw new Error(`${adapterManifestPath} must contain a JSON object`);
  }

  return manifest;
}

function readAdapterSuite(
  manifest: Record<string, unknown>,
  adapterManifestPath: string
): CompatibilitySuite {
  if (
    typeof manifest.boundary !== "string" ||
    typeof manifest.suiteId !== "string" ||
    typeof manifest.suiteVersion !== "string"
  ) {
    throw new Error(
      `${adapterManifestPath} must declare boundary, suiteId, and suiteVersion`
    );
  }

  return {
    boundary: manifest.boundary,
    suiteId: manifest.suiteId,
    suiteVersion: manifest.suiteVersion,
  };
}

function readLivePlanChecks(
  planJson: string,
  capabilities: ReadonlySet<string>
): { allCheckIds: string[]; applicableCheckIds: string[] } {
  const plan = JSON.parse(planJson) as {
    applicability?: { capabilities?: unknown };
    checks?: Array<{ capabilities?: unknown; checkId?: unknown }>;
  };
  const allCheckIds = (plan.checks ?? [])
    .map((check) => check.checkId)
    .filter((checkId): checkId is string => typeof checkId === "string");

  if (
    !hasRequiredCapabilities(plan.applicability?.capabilities, capabilities)
  ) {
    return { allCheckIds, applicableCheckIds: [] };
  }

  const applicableCheckIds: string[] = [];

  for (const check of plan.checks ?? []) {
    if (typeof check.checkId !== "string") {
      continue;
    }

    if (hasRequiredCapabilities(check.capabilities, capabilities)) {
      applicableCheckIds.push(check.checkId);
    }
  }

  return {
    allCheckIds,
    applicableCheckIds,
  };
}

function hasRequiredCapabilities(
  requiredCapabilities: unknown,
  capabilities: ReadonlySet<string>
): boolean {
  return readStringArray(requiredCapabilities).every((capability) =>
    capabilities.has(capability)
  );
}

function compareLiveConformanceResult(
  implementationId: string,
  liveRunner: LiveConformanceRunner,
  result: CompatibilityImplementationResult,
  failures: string[]
): void {
  compareEvidenceField(
    `compatibility matrix ${implementationId}`,
    "suiteId",
    result.suiteId,
    liveRunner.suite.suiteId,
    failures
  );
  compareEvidenceField(
    `compatibility matrix ${implementationId}`,
    "suiteVersion",
    result.suiteVersion,
    liveRunner.suite.suiteVersion,
    failures
  );

  if (!hasSameStringSet(result.checkIds, liveRunner.applicableCheckIds)) {
    failures.push(
      `compatibility matrix ${implementationId} checkIds do not match live conformance plan topology`
    );
  }
}

function compareLiveInteropResult(
  liveRunner: LiveInteropRunner,
  result: CompatibilityInteropResult,
  failures: string[]
): void {
  compareEvidenceField(
    `compatibility matrix ${result.pairId}`,
    "suiteId",
    result.suiteId,
    liveRunner.suite.suiteId,
    failures
  );
  compareEvidenceField(
    `compatibility matrix ${result.pairId}`,
    "suiteVersion",
    result.suiteVersion,
    liveRunner.suite.suiteVersion,
    failures
  );

  if (!hasSameStringSet(result.checkIds, liveRunner.checkIds)) {
    failures.push(
      `compatibility matrix ${result.pairId} checkIds do not match live interop suite topology`
    );
  }
}

function createSuiteKey(
  boundary: string,
  suiteId: string,
  suiteVersion: string
): string {
  return `${boundary}:${suiteId}@${suiteVersion}`;
}

function createConformanceRunnerKey(runner: ConformanceRunner): string {
  return `${runner.project}:${runner.implementationId}`;
}

function createCompatibilityRunnerKey(
  implementationId: string,
  suiteId: string,
  suiteVersion: string
): string {
  return `${implementationId}:${suiteId}@${suiteVersion}`;
}

function hasSameStringSet(
  actualValues: readonly string[],
  expectedValues: readonly string[]
): boolean {
  if (actualValues.length !== expectedValues.length) {
    return false;
  }

  const actual = new Set(actualValues);

  return expectedValues.every((expectedValue) => actual.has(expectedValue));
}

async function checkInteropEvidenceFile(
  evidencePath: string,
  result: CompatibilityInteropResult,
  liveRunner: LiveInteropRunner,
  failures: string[]
): Promise<void> {
  const absolutePath = resolve(REPO_ROOT, evidencePath);
  const evidence = JSON.parse(await readFile(absolutePath, "utf8"));

  if (!isRecord(evidence)) {
    failures.push(`${evidencePath} must contain a JSON object`);
    return;
  }

  if (
    evidence.status === "fail" ||
    evidence.reportStatus === "unexpected_fail"
  ) {
    failures.push(
      `${evidencePath} records ${String(evidence.reportStatus ?? evidence.status)}`
    );
  }

  compareEvidenceField(
    evidencePath,
    "pairId",
    evidence.pairId,
    result.pairId,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "boundary",
    evidence.boundary,
    liveRunner.suite.boundary,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "suiteId",
    evidence.suiteId,
    result.suiteId,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "suiteVersion",
    evidence.suiteVersion,
    result.suiteVersion,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "status",
    evidence.status,
    result.status,
    failures
  );
  compareEvidenceField(
    evidencePath,
    "reportStatus",
    evidence.reportStatus,
    result.reportStatus,
    failures
  );
  compareCheckIds(
    evidencePath,
    evidence.checkResults,
    result.checkIds,
    failures
  );
  compareCheckSummary(
    evidencePath,
    evidence.summary,
    result.checkSummary,
    failures
  );
  compareStringSet(
    evidencePath,
    "checkResults",
    Array.isArray(evidence.checkResults)
      ? evidence.checkResults
          .map((checkResult) =>
            isRecord(checkResult) ? checkResult.checkId : undefined
          )
          .filter((checkId): checkId is string => typeof checkId === "string")
      : [],
    liveRunner.checkIds,
    failures
  );
}

function compareEvidenceField(
  evidencePath: string,
  fieldName: string,
  actual: unknown,
  expected: string,
  failures: string[]
): void {
  if (actual !== expected) {
    failures.push(
      `${evidencePath} ${fieldName} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    );
  }
}

function compareCheckIds(
  evidencePath: string,
  checkResults: unknown,
  expectedCheckIds: readonly string[],
  failures: string[]
): void {
  if (!Array.isArray(checkResults)) {
    failures.push(`${evidencePath} checkResults must be an array`);
    return;
  }

  const actualCheckIds = checkResults.map((checkResult) =>
    isRecord(checkResult) ? checkResult.checkId : undefined
  );

  if (JSON.stringify(actualCheckIds) !== JSON.stringify(expectedCheckIds)) {
    failures.push(`${evidencePath} checkResults do not match matrix checkIds`);
  }
}

function compareCheckSummary(
  evidencePath: string,
  summary: unknown,
  expectedSummary: CompatibilityCheckSummary,
  failures: string[]
): void {
  if (!isRecord(summary)) {
    failures.push(`${evidencePath} summary must be an object`);
    return;
  }

  for (const fieldName of [
    "applicableChecks",
    "failedChecks",
    "nonApplicableChecks",
    "passedChecks",
    "totalChecks",
  ] as const) {
    if (summary[fieldName] !== expectedSummary[fieldName]) {
      failures.push(
        `${evidencePath} summary.${fieldName} is ${JSON.stringify(summary[fieldName])}, expected ${JSON.stringify(expectedSummary[fieldName])}`
      );
    }
  }
}

function compareNonApplicableCheckIds(
  evidencePath: string,
  actualValue: unknown,
  expectedCheckIds: readonly string[],
  failures: string[]
): void {
  const actualCheckIds =
    actualValue === undefined ? [] : readStringArray(actualValue);

  if (!hasSameStringSet(actualCheckIds, expectedCheckIds)) {
    failures.push(
      `${evidencePath} nonApplicableCheckIds do not match live conformance plan topology`
    );
  }
}

function compareStringSet(
  evidencePath: string,
  fieldName: string,
  actualValue: unknown,
  expectedValues: readonly string[],
  failures: string[]
): void {
  const actualValues = readStringArray(actualValue);

  if (!hasSameStringSet(actualValues, expectedValues)) {
    failures.push(
      `${evidencePath} ${fieldName} does not match expected values`
    );
  }
}

async function resetHermeticBuildBoundary(): Promise<void> {
  await Promise.all(
    HERMETIC_BUILD_OUTPUT_DIRECTORIES.map(async (directoryPath) =>
      rm(resolve(REPO_ROOT, directoryPath), {
        force: true,
        recursive: true,
      })
    )
  );
}

async function readSuiteManifest(
  manifestPath: string
): Promise<ConformanceSuiteManifest> {
  return await readConformanceSuiteManifest(resolve(REPO_ROOT, manifestPath));
}

async function runConformanceTarget(
  runner: ConformanceRunner,
  suiteManifest: ConformanceSuiteManifest | undefined,
  expectedCapabilities: ReadonlySet<string>
): Promise<{
  matrixResult: CompatibilityImplementationResult;
  suite: CompatibilitySuite;
}> {
  // The compatibility matrix is meant to be measured evidence, not replayed
  // cached console output, so each conformance lane is forced to execute.
  for (const prerequisiteCommand of runner.prerequisiteCommands ?? []) {
    const prerequisiteResult = await runCommand(prerequisiteCommand, {
      captureOutput: true,
      cwd: REPO_ROOT,
    });

    if (prerequisiteResult.code !== 0) {
      throw new Error(
        `compatibility prerequisite failed for ${runner.implementationId}: ${prerequisiteCommand.join(" ")}`
      );
    }
  }

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
    `shared-conformance-runner.${runner.project}.json`
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
  const parsedEvidence =
    readConformanceEvidence(commandResult.stdout) ??
    readConformanceEvidence(commandResult.stderr) ??
    readConformanceEvidence(
      `${commandResult.stdout}\n${commandResult.stderr}`.trim()
    ) ??
    readConformanceEvidence(
      `${commandResult.stderr}\n${commandResult.stdout}`.trim()
    );
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
  const status: CompatibilityResultStatus = computeCompatibilityResultStatus(
    commandResult.code,
    evidencePayload
  );
  const reportStatus = classifyConformanceReportStatus(
    runner,
    evidencePayload,
    status,
    expectedCapabilities
  );
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
    reportLabel: runner.reportLabel,
    reportStatus,
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
      declaredCapabilities: evidencePayload.capabilities,
      evidencePath: relativeEvidencePath,
      reportLabel: runner.reportLabel,
      reportStatus,
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

function classifyConformanceReportStatus(
  runner: ConformanceRunner,
  evidence: ConformanceEvidence,
  rawStatus: CompatibilityResultStatus,
  expectedCapabilities: ReadonlySet<string>
): CompatibilityReportStatus {
  if (rawStatus === "fail") {
    return runner.expectedFailure === true
      ? "expected_fail"
      : "unexpected_fail";
  }

  if (rawStatus === "unsupported" || rawStatus === "not_applicable") {
    return rawStatus;
  }

  const applicableChecks =
    evidence.summary.applicableChecks ??
    evidence.summary.failedChecks + evidence.summary.passedChecks;
  const nonApplicableChecks = evidence.summary.nonApplicableChecks ?? 0;

  if (applicableChecks === 0) {
    return nonApplicableChecks > 0 ? "unsupported" : "not_applicable";
  }

  // The expected set is derived from the topology rooted at this lane's
  // adapter manifest, so adding or removing a plan/capability anywhere
  // under that topology automatically reshapes what `full_pass` means
  // without a parallel manual list in this file. See
  // `computeExpectedCapabilitiesFromTopology` for the derivation.
  const declaredCapabilities = new Set(evidence.capabilities ?? []);
  const hasFullCapabilitySet = [...expectedCapabilities].every((capability) =>
    declaredCapabilities.has(capability)
  );

  return hasFullCapabilitySet ? "full_pass" : "capability_subset_pass";
}

async function computeExpectedCapabilitiesFromTopology(
  adapterManifestPathRelative: string
): Promise<ReadonlySet<string>> {
  const adapterManifestPath = resolve(REPO_ROOT, adapterManifestPathRelative);
  const adapterManifest = JSON.parse(
    await readFile(adapterManifestPath, "utf8")
  ) as { authorityPackets?: unknown };

  const packetPaths = readStringArray(adapterManifest.authorityPackets);
  const capabilities = new Set<string>();

  // The expected set is derived exclusively from the discovered plan
  // topology — any capability that is not exercised by at least one plan
  // check is NOT part of the lane's "full coverage" surface. Wave 5
  // experimented with also unioning adapter-advertised capabilities here so
  // adapter-only surfaces (like an unmeasured `trace.lifecycle` claim)
  // would still count toward `full_pass`; wave 6 reverted that because it
  // weakened the meaning of `full_pass` — a lane could be reported as
  // fully covered while a chunk of its claimed surface had zero asserting
  // checks. Adapter-advertised capabilities without plan coverage are now
  // caught structurally by `portability-gate.ts`'s
  // `adapter-capability-covered-by-plan` rule, which forces either the
  // capability to be removed from the adapter manifest or a plan check to
  // exercise it.
  for (const packetPath of packetPaths) {
    const packetManifest = JSON.parse(
      await readFile(resolve(REPO_ROOT, packetPath), "utf8")
    ) as {
      conformancePlans?: Array<{ path?: unknown }>;
    };

    for (const plan of packetManifest.conformancePlans ?? []) {
      if (typeof plan.path !== "string") {
        continue;
      }

      collectPlanCapabilities(
        await readFile(resolve(REPO_ROOT, plan.path), "utf8"),
        capabilities
      );
    }
  }

  return capabilities;
}

function collectPlanCapabilities(planJson: string, sink: Set<string>): void {
  const plan = JSON.parse(planJson) as {
    applicability?: { capabilities?: unknown };
    checks?: Array<{ capabilities?: unknown }>;
  };

  for (const capability of readStringArray(plan.applicability?.capabilities)) {
    sink.add(capability);
  }

  for (const check of plan.checks ?? []) {
    for (const capability of readStringArray(check.capabilities)) {
      sink.add(capability);
    }
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function computeCompatibilityResultStatus(
  commandExitCode: number,
  evidence: ConformanceEvidence
): CompatibilityResultStatus {
  if (commandExitCode !== 0 || evidence.status !== "pass") {
    return "fail";
  }

  const applicableChecks =
    evidence.summary.applicableChecks ??
    evidence.summary.failedChecks + evidence.summary.passedChecks;
  const nonApplicableChecks = evidence.summary.nonApplicableChecks ?? 0;

  if (applicableChecks === 0) {
    return nonApplicableChecks > 0 ? "unsupported" : "not_applicable";
  }

  return "pass";
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
  let reportStatus: CompatibilityReportStatus =
    status === "pass" ? "full_pass" : "unexpected_fail";
  const evidence: {
    boundary: string;
    checkResults: ConformanceCheckResult[];
    command: string[];
    exitCode: number;
    pairId: string;
    project: string;
    reportLabel: string;
    reportStatus: CompatibilityReportStatus;
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
    reportLabel: runner.reportLabel,
    reportStatus,
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
      reportStatus = "unexpected_fail";
      evidence.status = status;
      evidence.reportStatus = reportStatus;
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
        reportStatus = "unexpected_fail";
        evidence.status = status;
        evidence.reportStatus = reportStatus;
      } else {
        reportStatus = "full_pass";
        evidence.reportStatus = reportStatus;
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
      reportLabel: runner.reportLabel,
      reportStatus,
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
  for (const candidate of extractJsonObjectCandidates(stdout).reverse()) {
    const report = parseInteropScenarioReportCandidate(candidate);

    if (report !== undefined) {
      return report;
    }
  }

  return undefined;
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

  // Locate the last top-level JSON object in the stdout by scanning lines for
  // a column-zero `{` followed by a column-zero `}` after a balanced run of
  // nested braces. This avoids treating an inner brace as the top-level start
  // and avoids returning trailing Nx framing (e.g. " NX  Successfully ran...")
  // that would otherwise break JSON.parse on otherwise-clean runner output.
  const lines = stdout.split("\n");
  let openIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (line?.startsWith("}")) {
      // Walk backward looking for the matching column-zero `{` that opened
      // this trailing object. Use indentation as a proxy for nesting depth
      // since the runners emit pretty-printed JSON.
      for (let inner = index - 1; inner >= 0; inner -= 1) {
        const innerLine = lines[inner];

        if (innerLine?.startsWith("{")) {
          openIndex = inner;
          break;
        }
      }

      if (openIndex !== -1) {
        return lines
          .slice(openIndex, index + 1)
          .join("\n")
          .trim();
      }

      break;
    }
  }

  const trimmed = stdout.trim();
  const objectStart = trimmed.lastIndexOf("\n{");

  if (objectStart === -1) {
    return trimmed;
  }

  return trimmed.slice(objectStart + 1);
}

function extractJsonObjectCandidates(stdout: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < stdout.length; index += 1) {
    const character = stdout[index];

    if (character === undefined) {
      continue;
    }

    const stringState = advanceJsonStringState({
      character,
      escaped,
      inString,
    });
    escaped = stringState.escaped;
    inString = stringState.inString;

    if (stringState.handled) {
      continue;
    }

    const braceState = advanceJsonBraceState({
      candidates,
      character,
      depth,
      index,
      startIndex,
      stdout,
    });
    depth = braceState.depth;
    startIndex = braceState.startIndex;
  }

  return candidates;
}

function advanceJsonStringState(input: {
  character: string;
  escaped: boolean;
  inString: boolean;
}): { escaped: boolean; handled: boolean; inString: boolean } {
  if (input.escaped) {
    return {
      escaped: false,
      handled: true,
      inString: input.inString,
    };
  }

  if (input.character === "\\") {
    return {
      escaped: true,
      handled: true,
      inString: input.inString,
    };
  }

  if (input.character === '"') {
    return {
      escaped: false,
      handled: true,
      inString: !input.inString,
    };
  }

  if (input.inString) {
    return {
      escaped: false,
      handled: true,
      inString: true,
    };
  }

  return {
    escaped: false,
    handled: false,
    inString: false,
  };
}

function advanceJsonBraceState(input: {
  candidates: string[];
  character: string;
  depth: number;
  index: number;
  startIndex: number;
  stdout: string;
}): { depth: number; startIndex: number } {
  if (input.character === "{") {
    if (input.depth === 0) {
      return {
        depth: 1,
        startIndex: input.index,
      };
    }

    return {
      depth: input.depth + 1,
      startIndex: input.startIndex,
    };
  }

  if (input.character !== "}" || input.depth === 0) {
    return {
      depth: input.depth,
      startIndex: input.startIndex,
    };
  }

  const nextDepth = input.depth - 1;

  if (nextDepth === 0 && input.startIndex !== -1) {
    input.candidates.push(
      input.stdout.slice(input.startIndex, input.index + 1)
    );
    return {
      depth: 0,
      startIndex: -1,
    };
  }

  return {
    depth: nextDepth,
    startIndex: input.startIndex,
  };
}

function parseInteropScenarioReportCandidate(
  candidate: string
): InteropScenarioReport | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate);
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
        result.reportLabel.length === 0 ||
        result.suiteId.length === 0 ||
        result.suiteVersion.length === 0
      ) {
        throw new Error(
          "compatibility matrix implementation results must contain non-empty fields"
        );
      }

      assertCompatibilityReportStatus(result.reportStatus);
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
      interopResult.reportLabel.length === 0 ||
      interopResult.suiteId.length === 0 ||
      interopResult.suiteVersion.length === 0
    ) {
      throw new Error(
        "compatibility matrix interop results must contain non-empty fields"
      );
    }

    assertCompatibilityReportStatus(interopResult.reportStatus);
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
      `compatibility matrix check summaries must be internally consistent: ${JSON.stringify(value)}`
    );
  }
}

function assertCompatibilityReportStatus(
  value: string
): asserts value is CompatibilityReportStatus {
  if (
    value !== "full_pass" &&
    value !== "capability_subset_pass" &&
    value !== "unsupported" &&
    value !== "not_applicable" &&
    value !== "expected_fail" &&
    value !== "unexpected_fail"
  ) {
    throw new Error(`unknown compatibility report status: ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
