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

import process from "node:process";
import {
  hasVerificationFailure,
  printVerificationSummary,
  runVerification,
  type VerificationStep,
} from "./verify.js";

const KERNEL_TYPECHECK_PROJECTS = [
  "kernel-contract-protocol",
  "kernel-runtime",
  "kernel-testkit",
  "backend-memory",
  "backend-sqlite",
  "backend-postgres",
  "kernel-typescript-conformance-runner",
] as const;

const KERNEL_CONFORMANCE_PROJECTS = [
  "kernel-testkit",
  "kernel-typescript-conformance-runner",
  "kernel-typescript-sqlite-conformance-runner",
  "kernel-typescript-postgres-conformance-runner",
] as const;

const FRESH_FLAG = "--fresh";
const args = process.argv.slice(2);

if (args.some((arg) => arg !== FRESH_FLAG)) {
  throw new Error(`usage: bun tools/scripts/verify-kernel.ts [${FRESH_FLAG}]`);
}

const fresh = args.includes(FRESH_FLAG);
const results = await runVerification(createKernelVerificationSteps({ fresh }));
printVerificationSummary(results);

if (hasVerificationFailure(results)) {
  process.exitCode = 1;
}

function createKernelVerificationSteps(options: {
  fresh: boolean;
}): readonly VerificationStep[] {
  const cacheModeArgs = options.fresh ? ["--skipNxCache"] : [];

  return [
    {
      command: [
        "bun",
        "tools/scripts/authority-packet/validate-authority-packets.ts",
      ],
      id: "kernel authority packet validation",
    },
    {
      command: ["bun", "tools/conformance/plan-compiler/validate-plans.ts"],
      id: "kernel conformance plan validation",
    },
    {
      command: [
        "bun",
        "run",
        "nx",
        "run-many",
        "-t",
        "typecheck",
        "-p",
        KERNEL_TYPECHECK_PROJECTS.join(","),
        "--parallel=4",
        ...cacheModeArgs,
      ],
      id: "kernel TypeScript typecheck",
    },
    {
      command: [
        "bun",
        "run",
        "nx",
        "run",
        "kernel-testkit:test",
        ...cacheModeArgs,
      ],
      id: "kernel testkit tests",
    },
    {
      command: [
        "bun",
        "run",
        "nx",
        "run-many",
        "-t",
        "conformance",
        "-p",
        KERNEL_CONFORMANCE_PROJECTS.join(","),
        "--parallel=3",
        ...cacheModeArgs,
      ],
      id: "kernel memory, SQLite, and PostgreSQL conformance",
    },
    {
      command: ["bun", "run", "compatibility:check"],
      id: "workspace compatibility evidence check",
    },
  ];
}
