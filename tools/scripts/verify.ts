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
import { runCommand } from "./lib/command-runner.js";
import { loadNxProjectFiles } from "./lib/nx-projects.js";
import {
  assertWorktreeUnchanged,
  readWorktreeSnapshot,
} from "./lib/worktree-guard.js";

// The codegen freshness phase must regenerate exactly the projects the root
// `codegen` lane regenerates. That list drifted when duplicated at 87-M4.2c
// (the dead `provider-api` entry made Nx silently regenerate nothing for the
// providers port — run-many exits 0 for projects without the target). This
// constant is now the single source of truth: verify's codegen-freshness
// phase and the root `codegen` script (tools/scripts/codegen.ts, KRT-BM002)
// both consume it, so the two lanes cannot drift apart.
export const CODEGEN_PROJECTS =
  "core-spec,host-spec,streaming-spec,runners-spec,tools-spec,providers-spec,telemetry-spec,compatibility-reporting,kernel-interop-grpc";
// Validate every name against the real project index, and require each to
// still DECLARE a codegen target, because run-many exits 0 for projects
// without the target (the exact 87-M4.2c silent-no-op this guard exists to
// prevent: existing-but-targetless is just as silent as nonexistent).
{
  const projectsByName = new Map(
    loadNxProjectFiles(process.cwd()).map((file) => [file.name, file])
  );
  const names = CODEGEN_PROJECTS.split(",");
  const unknown = names.filter((name) => !projectsByName.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `verify: CODEGEN_PROJECTS contains unknown Nx projects (${unknown.join(", ")}) — update tools/scripts/verify.ts`
    );
  }
  const targetless = names.filter(
    (name) => projectsByName.get(name)?.project.targets?.codegen === undefined
  );
  if (targetless.length > 0) {
    throw new Error(
      `verify: codegen project(s) ${targetless.join(", ")} no longer declare a codegen target — run-many would silently regenerate nothing for them (87-M4.2c class); update CODEGEN_PROJECTS in tools/scripts/verify.ts`
    );
  }
}

export interface VerificationStep {
  command: readonly string[];
  id: string;
}

export interface VerificationResult {
  code: number;
  durationMs: number;
  id: string;
}

// A phase is a group of steps that may run concurrently. The worktree-purity
// guard is applied once per phase (snapshot before, assert after), so any step
// that mutates checked-in files is still caught — we trade per-step attribution
// for parallelism. Steps with real ordering or shared-resource constraints
// (Rust builds, codegen-before-typecheck, services) live in serial phases.
export interface VerificationPhase {
  /** Max steps to run at once. Defaults to the phase size (capped). 1 = serial. */
  concurrency?: number;
  id: string;
  /**
   * Opt out of the worktree-purity guard for phases that are SUPPOSED to
   * mutate checked-in files (e.g. the codegen lane's artifact regeneration,
   * KRT-BM002). Every verification phase must leave this unset: the guard
   * is what catches a read-only step silently mutating the tree.
   */
  mutatesWorktree?: boolean;
  steps: readonly VerificationStep[];
}

// Cap parallel fan-out so a phase with many cheap steps does not oversubscribe a
// small machine. Set VERIFY_SERIAL=1 to force every phase fully serial, which is
// useful when bisecting which step mutated the worktree.
const DEFAULT_MAX_CONCURRENCY = 8;

export const WORKSPACE_TEST_PROJECTS: readonly string[] = [
  // M3.1: full test-target coverage — every Nx project declaring a `test`
  // target belongs here or in validate-workspace-test-coverage.ts's
  // documented exclusions (currently only the cargo-covered Rust projects).
  // That gate enforces exact parity in both directions.
  "shared-core",
  "sdk",
  "kernel-contract-protocol",
  "kernel-runtime",
  // @tuvren/kernel-grpc-client leaf (ADR-059 / KRT-BJ002): owns the relocated
  // gRPC transport codec, whose round-trip tests run only in this lane.
  "kernel-grpc-client",
  // backend-shared (@tuvren/backend-shared, KRT-BK001): the shared
  // kernel-backend invariant core the memory, SQLite, and PostgreSQL
  // backends delegate to for reclamation, record-utils, and
  // run-transition-legality logic.
  "backend-shared",
  "backend-memory",
  "backend-sqlite",
  "mcp-client",
  "provider-api",
  // framework-runtime-api (@tuvren/runtime-api) is gone entirely (deprecated
  // shim retired at M9.2, successor @tuvren/core/{execution,events,messages,
  // provider,tools}). Its dead test-lane entry had already been caught by
  // the M3.1 coverage gate before the retirement.
  // Keep the kernel testkit in the repo-global test lane so boundary-owned
  // fixture drift cannot hide behind the narrower certification coverage.
  "kernel-testkit",
  "backend-postgres",
  "kernel-typescript-certification",
  "framework-typescript-certification",
  "providers-typescript-certification",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "framework-telemetry-otel",
  "telemetry-semconv",
  // framework-runtime-core is gone entirely (deprecated shim retired at
  // M3.2c, successor @tuvren/runtime). Its dead test-lane entry had already
  // been caught by the M3.1 coverage gate before the retirement.
  "framework-runtime",
  "runner-react",
  "host-repl",
  // Go and Python kernel-port projects run their language-native test
  // runners (go test / pytest) through these Nx targets; certification
  // wrappers join the conformance lanes separately once registered.
  "kernel-go-kernel",
  "kernel-go-certification",
  "kernel-python-kernel",
  "kernel-python-certification",
];

export const WORKSPACE_BUILD_PROJECTS: readonly string[] = [
  "kernel-contract-protocol",
  "kernel-testkit",
  "backend-shared",
  "backend-memory",
  "backend-sqlite",
  "backend-postgres",
  "provider-api",
  "providers-testkit",
  "providers-bridge-ai-sdk",
  "framework-testkit",
  "framework-runtime",
  "runner-react",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "framework-telemetry-otel",
  "telemetry-semconv",
  "host-repl",
];

export const WORKSPACE_EXPORT_SMOKE_PROJECTS: readonly string[] = [
  "kernel-testkit",
  // framework-event-stream (@tuvren/event-stream) is gone entirely
  // (deprecated shim retired at M8.1c, successor @tuvren/core/events).
  // framework-runtime-api (@tuvren/runtime-api) is gone entirely (deprecated
  // shim retired at M9.2, successor @tuvren/core/{execution,events,messages,
  // provider,tools}).
  "framework-runtime",
  "provider-api",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "mcp-client",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "framework-telemetry-otel",
  "telemetry-semconv",
  "host-repl",
];

// The read-only constitutional gate: authority/conformance validators that must
// stay green regardless of which files changed. This is the single source of
// truth for the gate — the fast `check` inner loop selects a cheap subset of
// these by ID (see tools/scripts/check.ts), so the two lanes cannot drift
// apart silently: renaming or removing a step here makes `check`'s subset
// selection fail loudly instead of quietly dropping a class of drift coverage.
export const AUTHORITY_GATE_STEPS: readonly VerificationStep[] = [
  {
    command: ["bun", "run", "docs:authority-freeze:check"],
    id: "docs-to-authority freeze gate",
  },
  {
    command: ["bun", "run", "portability:check"],
    id: "Epic AL portability gate",
  },
  {
    command: ["bun", "run", "host-boundary:check"],
    id: "ADR-057 host import boundary gate",
  },
  {
    // Routed through the cached Nx target (inputs: workspace sources +
    // manifests, gate scripts, snapshot, core authority packet) so unchanged
    // surfaces replay from cache; `bun run api-freeze:check` is the same gate
    // uncached for manual runs.
    command: ["bunx", "nx", "run", "shared-core:api-freeze-check"],
    id: "ADR-054/056 API-surface freeze gate",
  },
  {
    command: ["bun", "run", "docs:af-gap-plan:check"],
    id: "Epic AF conformance gap plan freshness",
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
  {
    command: [
      "bun",
      "tools/conformance/adapter-protocol/validate-adapter-protocol.ts",
    ],
    id: "adapter protocol validation",
  },
  {
    command: [
      "bun",
      "tools/conformance/certification/validate-certification-discovery.ts",
    ],
    id: "certification discovery parity",
  },
  {
    command: ["bun", "tools/scripts/validate-workspace-test-coverage.ts"],
    id: "workspace test-lane coverage",
  },
  {
    command: ["bun", "tools/conformance/meta-conformance/run.ts"],
    id: "certification harness meta-conformance",
  },
  {
    command: ["bun", "tools/conformance/vocabulary/validate-vocabulary.ts"],
    id: "vocabulary-check verification",
  },
  {
    command: [
      "bun",
      "tools/scripts/authority-guardrails/authority-guardrails.ts",
    ],
    id: "machine authority guardrails",
  },
];

/**
 * Selects steps from AUTHORITY_GATE_STEPS by ID for a derived lane (check's
 * inner loop, the codegen lane). Throws if an ID no longer matches a verify
 * gate step, so a derived lane can never silently diverge from this file.
 */
export function selectAuthorityGateSteps(
  ids: readonly string[],
  lane: string
): VerificationStep[] {
  return ids.map((id) => {
    const step = AUTHORITY_GATE_STEPS.find((candidate) => candidate.id === id);

    if (step === undefined) {
      throw new Error(
        `${lane}: authority gate id "${id}" no longer matches a verify gate step. ` +
          "Update the lane's ID list to track tools/scripts/verify.ts."
      );
    }

    return step;
  });
}

export const DEFAULT_VERIFICATION_PHASES: readonly VerificationPhase[] = [
  {
    // Read-only static analysis + the constitutional authority/conformance
    // validators. All independent, so run them concurrently. Note: parallel
    // phases do NOT fail-fast — every step runs to completion even after one
    // fails, so a single `verify` surfaces all static/authority failures at
    // once instead of stopping at the first (a deliberate change from the old
    // strictly-serial loop). VERIFY_SERIAL=1 restores first-failure-stops.
    id: "static analysis and authority gates",
    steps: [
      { command: ["bun", "run", "lint"], id: "workspace lint" },
      {
        command: ["cargo", "fmt", "--all", "--", "--check"],
        id: "Rust workspace formatting",
      },
      ...AUTHORITY_GATE_STEPS,
    ],
  },
  {
    // The Rust Nx wrappers shell out to Cargo-native commands, so keep this
    // phase serial to avoid interleaving large Rust builds. `cargo clippy
    // --all-targets` and `cargo test --workspace` already compile and test
    // every workspace crate, which is why the previous redundant
    // `nx run-many build/test` Rust steps were dropped — they re-ran a subset
    // of what these two commands already cover.
    concurrency: 1,
    id: "Rust workspace build, lint, test, and conformance",
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
        id: "Rust workspace lint",
      },
      { command: ["cargo", "test", "--workspace"], id: "Rust workspace tests" },
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-rust-certification:conformance",
          "--skipNxCache",
        ],
        id: "Rust kernel certification",
      },
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-rust-grpc-service:interop-smoke",
          "--skipNxCache",
        ],
        id: "Rust kernel gRPC interop smoke",
      },
    ],
  },
  {
    // Evidence-freshness codegen must run before typecheck because telemetry
    // codegen writes a checked-in TypeScript consumer that the transition line
    // imports. `--skipNxCache` is intentional: these are freshness checks that
    // must inspect the current checkout, not replay a cache from another state.
    concurrency: 1,
    id: "codegen freshness and typecheck",
    steps: [
      {
        command: [
          "bun",
          "run",
          "nx",
          "run-many",
          "-t",
          "codegen",
          "-p",
          CODEGEN_PROJECTS,
          "--skipNxCache",
        ],
        id: "telemetry, compatibility, and interop code generation",
      },
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-interop-grpc:interop-smoke",
          "--skipNxCache",
        ],
        id: "kernel interop governance smoke",
      },
      { command: ["bun", "run", "typecheck"], id: "workspace typecheck" },
    ],
  },
  {
    // Build before test before conformance; each Nx run-many already
    // parallelizes within itself.
    concurrency: 1,
    id: "transition-line builds, tests, and conformance",
    steps: [
      {
        command: [
          "bun",
          "run",
          "nx",
          "run-many",
          "-t",
          "build",
          "-p",
          WORKSPACE_BUILD_PROJECTS.join(","),
        ],
        id: "transition-line targeted builds",
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
          WORKSPACE_TEST_PROJECTS.join(","),
        ],
        id: "transition-line targeted tests",
      },
      {
        command: ["bun", "run", "conformance"],
        id: "boundary-owned conformance suites",
      },
    ],
  },
  {
    // Proving-host scenarios drive real services (PostgreSQL, SQLite, the REPL),
    // so keep this phase serial to avoid contending on shared state and ports.
    concurrency: 1,
    id: "proving-host scenarios and package smokes",
    steps: [
      {
        command: ["bun", "run", "proving-host:interop-smoke"],
        id: "cross-language proving-host interactive/headless interop smoke",
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
          WORKSPACE_EXPORT_SMOKE_PROJECTS.join(","),
          // The prior build step is the release gate for dist output; export
          // smoke should only validate those artifacts, not rebuild the graph.
          "--excludeTaskDependencies",
        ],
        id: "package export smoke tests",
      },
      {
        command: ["bun", "tools/scripts/portability-check.ts"],
        id: "Bun and Node portability import checks",
      },
      {
        command: ["bun", "run", "proving-host:scenario-sqlite"],
        id: "Node-backed proving-host SQLite interactive/headless scenario",
      },
      {
        command: ["bun", "run", "proving-host:scenario-postgres"],
        id: "PostgreSQL-backed proving-host interactive/headless scenario",
      },
    ],
  },
];

/**
 * Runs the full phased verification pipeline (release-check and the `verify`
 * entry point). The other lanes (verify-kernel, check, codegen) build their
 * own phase lists and call runVerificationPhases directly — it is the single
 * phase-engine entry point for all four lanes (KRT-BM002).
 */
export function runVerification(): Promise<VerificationResult[]> {
  return runVerificationPhases(DEFAULT_VERIFICATION_PHASES);
}

export async function runVerificationPhases(
  phases: readonly VerificationPhase[]
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const phase of phases) {
    const before = phase.mutatesWorktree
      ? undefined
      : await readWorktreeSnapshot(process.cwd());
    const phaseResults = await runPhase(phase);
    results.push(...phaseResults);

    if (before !== undefined) {
      await assertWorktreeUnchanged(before, {
        cwd: process.cwd(),
        label: `verification phase "${phase.id}"`,
      });
    }

    if (phaseResults.some((result) => result.code !== 0)) {
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
  console.log("Transition verification summary");

  for (const result of results) {
    const status = result.code === 0 ? "pass" : `fail (${result.code})`;
    console.log(`- ${result.id}: ${status} in ${result.durationMs}ms`);
  }
}

interface StepRun extends VerificationResult {
  output: string | null;
}

async function runPhase(
  phase: VerificationPhase
): Promise<VerificationResult[]> {
  const forceSerial = process.env.VERIFY_SERIAL === "1";
  const limit = forceSerial
    ? 1
    : (phase.concurrency ??
      Math.min(phase.steps.length, DEFAULT_MAX_CONCURRENCY));

  if (limit <= 1) {
    return runPhaseSerially(phase.steps);
  }

  // Capture each step's output so concurrent logs do not interleave; flush them
  // in phase order once the phase completes. Captured output is held in memory
  // until the phase finishes — fine for the only parallel phase today (phase 1
  // is low-volume static analysis + authority validators). A side effect is that
  // nothing prints mid-phase, so a hung parallel step shows no output until the
  // phase ends; run VERIFY_SERIAL=1 for live streaming when diagnosing one. If a
  // chatty step (e.g. a full build) ever moves into a parallel phase, stream it.
  const runs = await mapWithConcurrency(phase.steps, limit, (step) =>
    runVerificationStep(step, true)
  );

  for (const run of runs) {
    if (run.output !== null) {
      process.stdout.write(run.output);
    }
  }

  return runs.map(toResult);
}

async function runPhaseSerially(
  steps: readonly VerificationStep[]
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const step of steps) {
    const run = await runVerificationStep(step, false);
    results.push(toResult(run));

    if (run.code !== 0) {
      break;
    }
  }

  return results;
}

async function runVerificationStep(
  step: VerificationStep,
  capture: boolean
): Promise<StepRun> {
  const [executable, ...args] = step.command;

  if (executable === undefined) {
    throw new Error(`verification step "${step.id}" has no executable`);
  }

  const startedAt = Date.now();
  const header = `\n==> ${step.id}\n$ ${step.command.join(" ")}\n`;

  if (!capture) {
    process.stdout.write(header);
    const code = await spawnCommand(executable, args);

    return {
      code,
      durationMs: Date.now() - startedAt,
      id: step.id,
      output: null,
    };
  }

  const result = await runCommand(step.command, { captureOutput: true });

  return {
    code: result.code,
    durationMs: Date.now() - startedAt,
    id: step.id,
    output: header + result.stdout + result.stderr,
  };
}

function toResult(run: StepRun): VerificationResult {
  return { code: run.code, durationMs: run.durationMs, id: run.id };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await fn(items[index] as T);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);

  return results;
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
