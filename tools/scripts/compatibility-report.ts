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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./lib/command-runner.js";

interface CompatibilityMatrix {
  generatedAtMs: number;
  implementations: CompatibilityImplementation[];
  interop: [];
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

interface CompatibilitySuite {
  boundary: string;
  suiteId: string;
  suiteVersion: string;
}

interface ConformanceRunner {
  implementationId: string;
  manifestPath: string;
  packageJsonPath: string;
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
const EVIDENCE_DIRECTORY = resolve(REPO_ROOT, "reports/compatibility/evidence");

const CONFORMANCE_RUNNERS: readonly ConformanceRunner[] = [
  {
    implementationId: "typescript-framework",
    manifestPath:
      "boundaries/framework/conformance/scenarios/suite-manifest.json",
    packageJsonPath: "boundaries/framework/testkit/package.json",
    project: "framework-testkit",
  },
  {
    implementationId: "typescript-kernel",
    manifestPath: "boundaries/kernel/conformance/scenarios/suite-manifest.json",
    packageJsonPath: "boundaries/kernel/testkit/package.json",
    project: "kernel-testkit",
  },
  {
    implementationId: "typescript-providers",
    manifestPath:
      "boundaries/providers/conformance/scenarios/suite-manifest.json",
    packageJsonPath: "boundaries/providers/testkit/package.json",
    project: "providers-testkit",
  },
];

await main();

async function main(): Promise<void> {
  const generatedAtMs = Date.now();
  const sourceRevision = await readSourceRevision();
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });

  const suites: CompatibilitySuite[] = [];
  const implementations: CompatibilityImplementation[] = [];
  let hasFailure = false;

  for (const runner of CONFORMANCE_RUNNERS) {
    const suiteManifest = await readSuiteManifest(runner.manifestPath);
    const implementationVersion = await readPackageVersion(
      runner.packageJsonPath
    );
    const result = await runConformanceTarget(
      runner,
      suiteManifest,
      generatedAtMs
    );

    suites.push({
      boundary: suiteManifest.boundary,
      suiteId: suiteManifest.suiteId,
      suiteVersion: suiteManifest.suiteVersion,
    });
    // Epic R establishes the first measured TypeScript baseline only. Later
    // language lines append peer implementation evidence here rather than
    // treating TypeScript as the semantic root.
    implementations.push({
      implementationId: runner.implementationId,
      language: "typescript",
      results: [result.matrixResult],
      version: implementationVersion,
    });

    if (result.matrixResult.status === "fail") {
      hasFailure = true;
    }
  }

  const matrix: CompatibilityMatrix = {
    generatedAtMs,
    implementations,
    // Real interop evidence does not exist until later epics wire an actual
    // cross-process lane, so Epic R records no placeholder pass claims here.
    interop: [],
    sourceRevision,
    suites,
  };

  assertCompatibilityMatrix(matrix);
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

async function readSourceRevision(): Promise<string> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  if (result.code !== 0) {
    return "unknown";
  }

  return result.stdout.trim();
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

async function readPackageVersion(packageJsonPath: string): Promise<string> {
  const packageJsonText = await readFile(
    resolve(REPO_ROOT, packageJsonPath),
    "utf8"
  );
  const packageJson = JSON.parse(packageJsonText);

  if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
    throw new Error(`invalid package.json version at ${packageJsonPath}`);
  }

  return packageJson.version;
}

async function runConformanceTarget(
  runner: ConformanceRunner,
  suiteManifest: SuiteManifest,
  generatedAtMs: number
): Promise<{
  matrixResult: CompatibilityImplementationResult;
}> {
  const command = ["bun", "run", "nx", "run", `${runner.project}:conformance`];
  const commandResult = await runCommand(command, {
    captureOutput: true,
    cwd: REPO_ROOT,
  });
  const evidenceFilePath = resolve(
    EVIDENCE_DIRECTORY,
    `${suiteManifest.suiteId}.json`
  );
  const relativeEvidencePath = relative(REPO_ROOT, evidenceFilePath);
  const status: "fail" | "pass" = commandResult.code === 0 ? "pass" : "fail";

  await writeFile(
    evidenceFilePath,
    `${JSON.stringify(
      {
        boundary: suiteManifest.boundary,
        command,
        exitCode: commandResult.code,
        generatedAtMs,
        implementationId: runner.implementationId,
        project: runner.project,
        status,
        stderr: commandResult.stderr,
        stdout: commandResult.stdout,
        suiteId: suiteManifest.suiteId,
        suiteVersion: suiteManifest.suiteVersion,
      },
      null,
      2
    )}\n`
  );

  return {
    matrixResult: {
      evidencePath: relativeEvidencePath,
      status,
      suiteId: suiteManifest.suiteId,
      suiteVersion: suiteManifest.suiteVersion,
    },
  };
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

function assertCompatibilityMatrix(
  value: CompatibilityMatrix
): asserts value is CompatibilityMatrix {
  if (!Number.isSafeInteger(value.generatedAtMs)) {
    throw new Error(
      "compatibility matrix generatedAtMs must be a safe integer"
    );
  }

  if (value.sourceRevision.length === 0) {
    throw new Error("compatibility matrix sourceRevision must be non-empty");
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
