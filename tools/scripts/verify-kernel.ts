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
import { loadNxProjectFiles } from "./lib/nx-projects.js";
import {
  hasVerificationFailure,
  printVerificationSummary,
  runVerificationPhases,
  type VerificationPhase,
} from "./verify.js";

const KERNEL_TYPECHECK_PROJECTS = [
  "kernel-contract-protocol",
  "kernel-runtime",
  "kernel-testkit",
  "backend-memory",
  "backend-sqlite",
  "backend-postgres",
  "kernel-typescript-certification",
] as const;

const KERNEL_CONFORMANCE_PROJECTS = [
  "kernel-testkit",
  "kernel-typescript-certification",
  "kernel-typescript-sqlite-certification",
  "kernel-typescript-postgres-certification",
] as const;

// Validate both literal lists against the live Nx project graph before any
// step runs (KRT-BM003). This is the same stale-list bug class that hit the
// codegen project list at incident 87-M4.2c: `nx run-many` exits 0 for
// projects that don't exist or no longer declare the requested target, so a
// renamed kernel project would silently drop out of this gate. Mirrors the
// CODEGEN_PROJECTS guard in verify.ts.
{
  const projectsByName = new Map(
    loadNxProjectFiles(process.cwd()).map((file) => [file.name, file])
  );

  const lists: readonly [string, readonly string[]][] = [
    ["typecheck", KERNEL_TYPECHECK_PROJECTS],
    ["conformance", KERNEL_CONFORMANCE_PROJECTS],
  ];

  for (const [target, names] of lists) {
    const unknown = names.filter((name) => !projectsByName.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `verify-kernel: KERNEL_${target.toUpperCase()}_PROJECTS contains unknown Nx projects (${unknown.join(", ")}) — update tools/scripts/verify-kernel.ts`
      );
    }

    const targetless = names.filter(
      (name) =>
        projectsByName.get(name)?.project.targets?.[target] === undefined
    );
    if (targetless.length > 0) {
      throw new Error(
        `verify-kernel: project(s) ${targetless.join(", ")} no longer declare a ${target} target — run-many would silently skip them (87-M4.2c class); update tools/scripts/verify-kernel.ts`
      );
    }
  }
}

const FRESH_FLAG = "--fresh";
const args = process.argv.slice(2);

if (args.some((arg) => arg !== FRESH_FLAG)) {
  throw new Error(`usage: bun tools/scripts/verify-kernel.ts [${FRESH_FLAG}]`);
}

const fresh = args.includes(FRESH_FLAG);
const results = await runVerificationPhases(
  createKernelVerificationPhases({ fresh })
);
printVerificationSummary(results);

if (hasVerificationFailure(results)) {
  process.exitCode = 1;
}

// Independent steps share a concurrent phase instead of one-step serial
// phases (KRT-BM002). The groupings below are dependency-honest:
// - The two authority validators are read-only and independent.
// - Typecheck (source-only targets), the testkit test run, and the
//   compatibility evidence check touch disjoint targets and read-only
//   evidence, so they run concurrently; Nx serializes its own cache access.
// - The conformance run-many stays in its own serial phase: it drives real
//   services (PostgreSQL) and already parallelizes internally.
function createKernelVerificationPhases(options: {
  fresh: boolean;
}): readonly VerificationPhase[] {
  const cacheModeArgs = options.fresh ? ["--skipNxCache"] : [];

  return [
    {
      id: "kernel authority and conformance-plan validation",
      steps: [
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
      ],
    },
    {
      id: "kernel typecheck, testkit tests, and compatibility evidence",
      steps: [
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
          command: ["bun", "run", "compatibility:check"],
          id: "workspace compatibility evidence check",
        },
      ],
    },
    {
      concurrency: 1,
      id: "kernel conformance",
      steps: [
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
      ],
    },
  ];
}
