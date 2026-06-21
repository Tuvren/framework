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

// Fast inner-loop lane. Sits between `verify:kernel` (focused kernel boundary)
// and `verify` (full release gate): it always runs the cheap authority gate so
// the inner loop can never drift from the constitution, then uses Nx `affected`
// to typecheck/test/lint only the projects touched by the working tree. Rust is
// graph-coarse under Nx (the cargo wrappers carry no source-level edges), so a
// workspace-wide cargo gate runs only when Rust sources actually changed.

import process from "node:process";
import { runCommand } from "./lib/command-runner.js";
import {
  hasVerificationFailure,
  printVerificationSummary,
  runVerification,
  type VerificationStep,
} from "./verify.js";

const BASE_FLAG = "--base=";
const DEFAULT_BASE = "master";
const CARGO_MANIFEST_PATTERN = /(^|\/)Cargo\.(toml|lock)$/;

// The constitutional gate: fast, read-only validators that keep authority,
// portability, and conformance plans aligned. Always run, regardless of which
// files changed — drift here is cheap to detect and expensive to discover late.
const AUTHORITY_GATE_STEPS: readonly VerificationStep[] = [
  {
    command: ["bun", "run", "docs:authority-freeze:check"],
    id: "docs-to-authority freeze gate",
  },
  {
    command: ["bun", "run", "portability:check"],
    id: "portability gate",
  },
  {
    command: [
      "bun",
      "tools/scripts/authority-packet/validate-authority-packets.ts",
    ],
    id: "authority packet validation",
  },
  {
    command: ["bun", "tools/conformance/plan-compiler/validate-plans.ts"],
    id: "conformance plan validation",
  },
];

const args = process.argv.slice(2);
const baseArg = args.find((arg) => arg.startsWith(BASE_FLAG));
const base = baseArg ? baseArg.slice(BASE_FLAG.length) : DEFAULT_BASE;

const steps: VerificationStep[] = [
  ...AUTHORITY_GATE_STEPS,
  {
    command: [
      "bun",
      "run",
      "nx",
      "affected",
      "-t",
      "typecheck,test,lint",
      `--base=${base}`,
    ],
    id: `affected typecheck/test/lint (base ${base})`,
  },
];

if (await rustChangedSince(base)) {
  steps.push(
    {
      command: [
        "cargo",
        "clippy",
        "--workspace",
        "--all-targets",
        "--",
        "-D",
        "warnings",
      ],
      id: "Rust workspace lint (rust files changed)",
    },
    {
      command: ["cargo", "test", "--workspace"],
      id: "Rust workspace tests (rust files changed)",
    }
  );
}

const results = await runVerification(steps);
printVerificationSummary(results);

if (hasVerificationFailure(results)) {
  process.exitCode = 1;
}

async function rustChangedSince(ref: string): Promise<boolean> {
  const tracked = await gitLines(["git", "diff", "--name-only", ref]);
  const untracked = await gitLines([
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  // If the base ref cannot be resolved (e.g. a shallow clone without `master`),
  // fall back to running the Rust gate rather than silently skipping it.
  if (tracked === undefined) {
    console.warn(
      `check: could not diff against "${ref}"; running the Rust gate defensively.`
    );
    return true;
  }

  return [...tracked, ...(untracked ?? [])].some(
    (file) =>
      file.endsWith(".rs") ||
      CARGO_MANIFEST_PATTERN.test(file) ||
      file === "rust-toolchain.toml"
  );
}

async function gitLines(
  command: readonly string[]
): Promise<string[] | undefined> {
  const result = await runCommand(command, {
    captureOutput: true,
    cwd: process.cwd(),
  });

  if (result.code !== 0) {
    return undefined;
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
