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

import { spawn } from "node:child_process";
import process from "node:process";

export interface VerificationStep {
  command: readonly string[];
  id: string;
}

export interface VerificationResult {
  code: number;
  durationMs: number;
  id: string;
}

export const EPIC_Q_TEST_PROJECTS: readonly string[] = [
  "provider-api",
  "framework-event-stream",
  "framework-runtime-api",
  "framework-driver-api",
  "framework-tool-contracts",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "framework-runtime-core",
  "framework-driver-react",
  "host-playground",
];

export const EPIC_Q_BUILD_PROJECTS: readonly string[] = [
  "shared-core-types",
  "kernel-contract-protocol",
  "kernel-testkit",
  "backend-memory",
  "backend-sqlite",
  "provider-api",
  "providers-testkit",
  "providers-bridge-ai-sdk",
  "framework-runtime-api",
  "framework-driver-api",
  "framework-event-stream",
  "framework-tool-contracts",
  "framework-testkit",
  "framework-runtime-core",
  "framework-driver-react",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "host-playground",
];

export const EPIC_Q_EXPORT_SMOKE_PROJECTS: readonly string[] = [
  "framework-driver-api",
  "framework-event-stream",
  "framework-runtime-api",
  "framework-tool-contracts",
  "provider-api",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "host-playground",
];

export const DEFAULT_VERIFICATION_STEPS: readonly VerificationStep[] = [
  {
    command: ["bun", "run", "lint"],
    id: "workspace lint",
  },
  {
    command: ["bun", "run", "typecheck"],
    id: "workspace typecheck",
  },
  {
    command: [
      "bun",
      "run",
      "nx",
      "run-many",
      "-t",
      "build",
      "-p",
      EPIC_Q_BUILD_PROJECTS.join(","),
    ],
    id: "Epic Q targeted builds",
  },
  {
    command: [
      "bun",
      "run",
      "nx",
      "run-many",
      "-t",
      "test",
      "-p",
      EPIC_Q_TEST_PROJECTS.join(","),
    ],
    id: "Epic Q targeted tests",
  },
  {
    command: [
      "bun",
      "run",
      "nx",
      "run-many",
      "-t",
      "exports-smoke",
      "-p",
      EPIC_Q_EXPORT_SMOKE_PROJECTS.join(","),
      // The prior build step is the release gate for dist output; export smoke
      // should only validate those artifacts, not rebuild the graph again.
      "--excludeTaskDependencies",
    ],
    id: "package export smoke tests",
  },
  {
    command: ["bun", "tools/scripts/portability-check.ts"],
    id: "Bun and Node portability import checks",
  },
  {
    command: [
      "bun",
      "run",
      "nx",
      "run",
      "host-playground:scenario-sqlite",
      // The SQLite scenario intentionally consumes the host build produced
      // earlier in verify so repeated release checks avoid a third rebuild.
      "--excludeTaskDependencies",
    ],
    id: "Node-backed playground SQLite reload scenario",
  },
];

export async function runVerification(
  steps: readonly VerificationStep[] = DEFAULT_VERIFICATION_STEPS
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const step of steps) {
    const result = await runVerificationStep(step);
    results.push(result);

    if (result.code !== 0) {
      return results;
    }
  }

  return results;
}

export function hasVerificationFailure(
  results: readonly VerificationResult[]
): boolean {
  return results.some((result) => result.code !== 0);
}

export function printVerificationSummary(
  results: readonly VerificationResult[]
): void {
  console.log("");
  console.log("Epic Q verification summary");

  for (const result of results) {
    const status = result.code === 0 ? "pass" : `fail (${result.code})`;
    console.log(`- ${result.id}: ${status} in ${result.durationMs}ms`);
  }
}

async function runVerificationStep(
  step: VerificationStep
): Promise<VerificationResult> {
  const [executable, ...args] = step.command;

  if (executable === undefined) {
    throw new Error(`verification step "${step.id}" has no executable`);
  }

  const startedAt = Date.now();

  console.log("");
  console.log(`==> ${step.id}`);
  console.log(`$ ${step.command.join(" ")}`);

  const code = await spawnCommand(executable, args);

  return {
    code,
    durationMs: Date.now() - startedAt,
    id: step.id,
  };
}

function spawnCommand(
  executable: string,
  args: readonly string[]
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

if (import.meta.main) {
  const results = await runVerification();
  printVerificationSummary(results);

  if (hasVerificationFailure(results)) {
    process.exitCode = 1;
  }
}
