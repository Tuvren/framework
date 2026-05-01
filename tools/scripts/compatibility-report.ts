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
import { fileURLToPath } from "node:url";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { runCommand } from "./lib/command-runner.js";

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
  evidencePath: string;
  status: "fail" | "pass";
  suiteId: string;
  suiteVersion: string;
}

interface CompatibilityInteropResult {
  evidencePath: string;
  pairId: string;
  status: "fail" | "pass";
  suiteId: string;
  suiteVersion: string;
}

interface InteropTelemetrySummary {
  observedKeys: string[];
  scenarios: Array<{
    attributes: Record<string, string | string[] | null>;
    observedKeys: string[];
    scenario: string;
  }>;
  schemaUrl: string;
}

interface CompatibilitySuite {
  boundary: string;
  suiteId: string;
  suiteVersion: string;
}

interface ConformanceRunner {
  implementationId: string;
  language: string;
  manifestPath: string;
  project: string;
}

interface InteropRunner {
  command?: string[];
  manifestPath: string;
  pairId: string;
  project: string;
}

interface SuiteManifest {
  boundary: string;
  suiteId: string;
  suiteVersion: string;
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

const CONFORMANCE_RUNNERS: readonly ConformanceRunner[] = [
  {
    implementationId: "typescript-framework",
    language: "typescript",
    manifestPath:
      "boundaries/framework/conformance/scenarios/suite-manifest.json",
    project: "framework-typescript-conformance-runner",
  },
  {
    implementationId: "typescript-kernel",
    language: "typescript",
    manifestPath: "boundaries/kernel/conformance/scenarios/suite-manifest.json",
    project: "kernel-typescript-conformance-runner",
  },
  {
    implementationId: "typescript-providers",
    language: "typescript",
    manifestPath:
      "boundaries/providers/conformance/scenarios/suite-manifest.json",
    project: "providers-typescript-conformance-runner",
  },
  {
    implementationId: "rust-kernel",
    language: "rust",
    manifestPath: "boundaries/kernel/conformance/scenarios/suite-manifest.json",
    project: "kernel-rust-conformance-runner",
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
    const suiteManifest = await readSuiteManifest(runner.manifestPath);
    const result = await runConformanceTarget(runner, suiteManifest);

    if (!seenSuiteIds.has(suiteManifest.suiteId)) {
      suites.push({
        boundary: suiteManifest.boundary,
        suiteId: suiteManifest.suiteId,
        suiteVersion: suiteManifest.suiteVersion,
      });
      seenSuiteIds.add(suiteManifest.suiteId);
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
    generatedAtMs: Date.now(),
    implementations,
    interop,
    sourceRevision: await readSourceRevision(),
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

  if (hasFailure) {
    throw new Error("one or more conformance targets failed");
  }
}

async function readSuiteManifest(manifestPath: string): Promise<SuiteManifest> {
  const manifestText = await readFile(resolve(REPO_ROOT, manifestPath), "utf8");
  const manifest = JSON.parse(manifestText);

  if (
    !isRecord(manifest) ||
    typeof manifest.boundary !== "string" ||
    typeof manifest.suiteId !== "string" ||
    typeof manifest.suiteVersion !== "string"
  ) {
    throw new Error(`invalid suite manifest at ${manifestPath}`);
  }

  return {
    boundary: manifest.boundary,
    suiteId: manifest.suiteId,
    suiteVersion: manifest.suiteVersion,
  };
}

async function runConformanceTarget(
  runner: ConformanceRunner,
  suiteManifest: SuiteManifest
): Promise<{
  matrixResult: CompatibilityImplementationResult;
}> {
  // The compatibility matrix is meant to be measured evidence, not replayed
  // cached console output, so each conformance lane is forced to execute.
  const command = [
    "bun",
    "run",
    "nx",
    "run",
    `${runner.project}:conformance`,
    "--skipNxCache",
  ];
  const commandResult = await runCommand(command, {
    captureOutput: true,
    cwd: REPO_ROOT,
  });
  const evidenceFilePath = resolve(
    EVIDENCE_DIRECTORY,
    `${suiteManifest.suiteId}.${runner.implementationId}.json`
  );
  const relativeEvidencePath = relative(REPO_ROOT, evidenceFilePath);
  const status: "fail" | "pass" = commandResult.code === 0 ? "pass" : "fail";
  const evidence: {
    boundary: string;
    command: string[];
    exitCode: number;
    implementationId: string;
    project: string;
    status: "fail" | "pass";
    stderr?: string;
    stdout?: string;
    suiteId: string;
    suiteVersion: string;
  } = {
    boundary: suiteManifest.boundary,
    command,
    exitCode: commandResult.code,
    implementationId: runner.implementationId,
    project: runner.project,
    status,
    suiteId: suiteManifest.suiteId,
    suiteVersion: suiteManifest.suiteVersion,
  };

  if (status === "fail") {
    evidence.stderr = commandResult.stderr;
    evidence.stdout = commandResult.stdout;
  }

  await writeFile(evidenceFilePath, `${JSON.stringify(evidence, null, 2)}\n`);

  return {
    matrixResult: {
      evidencePath: relativeEvidencePath,
      status,
      suiteId: suiteManifest.suiteId,
      suiteVersion: suiteManifest.suiteVersion,
    },
  };
}

async function runInteropTarget(
  runner: InteropRunner,
  suiteManifest: SuiteManifest
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
  let status: "fail" | "pass" = commandResult.code === 0 ? "pass" : "fail";
  const evidence: {
    boundary: string;
    command: string[];
    exitCode: number;
    pairId: string;
    project: string;
    status: "fail" | "pass";
    stderr?: string;
    stdout?: string;
    telemetry?: InteropTelemetrySummary;
    suiteId: string;
    suiteVersion: string;
  } = {
    boundary: suiteManifest.boundary,
    command,
    exitCode: commandResult.code,
    pairId: runner.pairId,
    project: runner.project,
    status,
    suiteId: suiteManifest.suiteId,
    suiteVersion: suiteManifest.suiteVersion,
  };

  if (status === "fail") {
    evidence.stderr = commandResult.stderr;
    evidence.stdout = commandResult.stdout;
  } else {
    const telemetry = readInteropTelemetrySummary(commandResult.stdout);

    if (telemetry === undefined) {
      // Epic V treats telemetry as part of the measured interop evidence, so a
      // smoke target that exits 0 but stops emitting the report payload must
      // fail here instead of silently downgrading the checked-in artifact.
      evidence.stderr =
        "interop smoke completed without a parseable telemetry summary";
      evidence.stdout = commandResult.stdout;
      status = "fail";
      evidence.status = status;
    } else {
      evidence.telemetry = telemetry;
    }
  }

  await writeFile(evidenceFilePath, `${JSON.stringify(evidence, null, 2)}\n`);

  return {
    matrixResult: {
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
  const parsed = JSON.parse(extractTrailingJsonObject(stdout));

  if (!(isRecord(parsed) && Array.isArray(parsed.reports))) {
    return undefined;
  }

  const scenarios: InteropTelemetrySummary["scenarios"] = [];
  const observedKeys = new Set<string>();
  let schemaUrl: string | undefined;

  for (const report of parsed.reports) {
    if (!isRecord(report) || typeof report.scenario !== "string") {
      continue;
    }

    const telemetry = report.telemetry;

    if (!isRecord(telemetry) || typeof telemetry.schemaUrl !== "string") {
      continue;
    }

    if (!Array.isArray(telemetry.observedKeys)) {
      continue;
    }

    if (!isRecord(telemetry.attributes)) {
      continue;
    }

    schemaUrl ??= telemetry.schemaUrl;

    const scenarioObservedKeys = telemetry.observedKeys.filter(
      (value): value is string => typeof value === "string"
    );

    for (const key of scenarioObservedKeys) {
      observedKeys.add(key);
    }

    scenarios.push({
      attributes: telemetry.attributes as Record<
        string,
        string | string[] | null
      >,
      observedKeys: scenarioObservedKeys,
      scenario: report.scenario,
    });
  }

  if (schemaUrl === undefined || scenarios.length === 0) {
    return undefined;
  }

  return {
    observedKeys: [...observedKeys].sort(),
    scenarios,
    schemaUrl,
  };
}

function extractTrailingJsonObject(stdout: string): string {
  const prefixedJsonLines = stdout
    .split("\n")
    .filter((line) => line.startsWith("host-playground: "))
    .map((line) => line.slice("host-playground: ".length));

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
  }
}

async function readSourceRevision(): Promise<string> {
  const revisionResult = await runCommand(["git", "rev-parse", "HEAD"], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  if (revisionResult.code !== 0) {
    throw new Error(
      revisionResult.stderr ||
        revisionResult.stdout ||
        "unable to read the current git revision"
    );
  }

  const statusResult = await runCommand(["git", "status", "--short"], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  if (statusResult.code !== 0) {
    throw new Error(
      statusResult.stderr ||
        statusResult.stdout ||
        "unable to determine whether the working tree is dirty"
    );
  }

  const revision = revisionResult.stdout.trim();
  return statusResult.stdout.trim().length === 0
    ? revision
    : `${revision}-dirty`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
