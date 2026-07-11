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
  AUTHORITY_GATE_STEPS,
  hasVerificationFailure,
  printVerificationSummary,
  runVerificationPhases,
  type VerificationPhase,
  type VerificationStep,
} from "./verify.js";

const BASE_FLAG = "--base=";
const DEFAULT_BASE = "master";
const CARGO_MANIFEST_PATTERN = /(^|\/)Cargo\.(toml|lock)$/;

// The constitutional gate for the inner loop: the cheap, read-only authority
// and conformance validators, always run regardless of which files changed —
// drift here is cheap to detect and expensive to discover late. We select these
// by ID from verify's shared AUTHORITY_GATE_STEPS rather than re-declaring the
// commands, so the inner loop cannot silently diverge from `verify`'s gate: if
// one of these IDs stops matching a verify step, buildInnerLoopAuthorityGate
// throws instead of quietly dropping that check.
//
// `machine authority guardrails` is intentionally omitted: it runs ~4s (vs
// <500ms for every other gate step) which is too slow for the inner loop, and
// it is still enforced by `verify` / `verify:kernel`. Every other authority
// validator is cheap enough to keep here.
const INNER_LOOP_AUTHORITY_GATE_IDS: readonly string[] = [
  "docs-to-authority freeze gate",
  "Epic AL portability gate",
  "ADR-057 host import boundary gate",
  // ~1.4s (one in-memory tsc program over the core+sdk source barrels) —
  // above the <500ms of the other gates but well under the ~4s guardrails
  // exclusion threshold, and a stable-surface break is exactly the drift the
  // inner loop must surface before a contributor builds on it (KRT-BL002).
  "ADR-054/056 API-surface freeze gate",
  "Epic AF conformance gap plan freshness",
  "authority packet validation",
  "conformance plan validation",
  "adapter protocol validation",
  "certification discovery parity",
  "workspace test-lane coverage",
  "certification harness meta-conformance",
  "vocabulary-check verification",
];

function buildInnerLoopAuthorityGate(): VerificationStep[] {
  return INNER_LOOP_AUTHORITY_GATE_IDS.map((id) => {
    const step = AUTHORITY_GATE_STEPS.find((candidate) => candidate.id === id);

    if (step === undefined) {
      throw new Error(
        `check: authority gate id "${id}" no longer matches a verify gate step. ` +
          "Update INNER_LOOP_AUTHORITY_GATE_IDS to track tools/scripts/verify.ts."
      );
    }

    return step;
  });
}

const args = process.argv.slice(2);
const baseArg = args.find((arg) => arg.startsWith(BASE_FLAG));
const base = baseArg ? baseArg.slice(BASE_FLAG.length) : DEFAULT_BASE;

// The authority validators are the same independent family verify's first
// phase already runs concurrently, so they share one concurrent phase here
// too (KRT-BM002). The affected lane gets its own phase (Nx parallelizes
// internally), and the Rust gate stays serial — clippy and cargo test share
// the target dir and interleaving two large Rust builds helps nothing.
const phases: VerificationPhase[] = [
  {
    id: "inner-loop authority gate",
    steps: buildInnerLoopAuthorityGate(),
  },
  {
    concurrency: 1,
    id: `affected typecheck/test/lint (base ${base})`,
    steps: [
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
    ],
  },
];

if (await rustChangedSince(base)) {
  phases.push({
    concurrency: 1,
    id: "Rust workspace gate (rust files changed)",
    steps: [
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
      },
    ],
  });
}

const results = await runVerificationPhases(phases);
printVerificationSummary(results);

if (hasVerificationFailure(results)) {
  process.exitCode = 1;
}

async function rustChangedSince(ref: string): Promise<boolean> {
  // Diff the working tree against the base ref directly. This matches how
  // `nx affected --base=<ref>` selects projects by default — its default head is
  // the current file system, not a committed SHA — so the Rust gate and the
  // affected lane react to the same working-tree change set. If a long-diverged
  // branch ever makes the two disagree, this errs toward over-running the gate
  // (a `.rs` file already on the base still counts), which is the safe direction.
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
