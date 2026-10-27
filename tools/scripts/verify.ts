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

import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  abortExitCode,
  CANCELLATION_SIGNALS,
  cancellationExitCode,
  runCommand,
} from "./lib/command-runner.js";
import type { CancellationSignal } from "./lib/command-runner.js";
import {
  GENERATED_PREREQUISITE_PROJECT,
  prependGeneratedPrerequisitePhase,
} from "./lib/generated-prerequisites.js";
import { loadNxProjectFiles } from "./lib/nx-projects.js";
import {
  createVerificationLogs,
  replayVerificationLog,
} from "./lib/verification-logs.js";
import type { VerificationLogs } from "./lib/verification-logs.js";
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
export const CODEGEN_PROJECTS = `core-spec,host-spec,streaming-spec,runners-spec,tools-spec,providers-spec,telemetry-spec,compatibility-reporting,${GENERATED_PREREQUISITE_PROJECT}`;
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

export interface VerificationRunOptions {
  /** Executes the assembled plan without rewriting its phases in regression tests. */
  executeStep?: (step: VerificationStep) => number | Promise<number>;
  logDirectory?: string;
  /** Called when a hang-up or repeated signal abandoned log replay. */
  onReplayAbandoned?: () => void;
  signal?: AbortSignal;
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
  // @tuvren/kernel-grpc-client leaf (ADR-0059 / KRT-BJ002): owns the relocated
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
  "kernel-typescript-conformance-adapter",
  "framework-typescript-certification",
  "framework-typescript-conformance-adapter",
  "providers-typescript-certification",
  "providers-typescript-conformance-adapter",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-ws",
  "framework-stream-agui",
  "framework-telemetry-otel",
  "telemetry-semconv",
  // framework-runtime-core is gone entirely (deprecated shim retired at
  // M3.2c, successor @tuvren/runtime). Its dead test-lane entry had already
  // been caught by the M3.1 coverage gate before the retirement.
  "framework-runtime",
  "runner-react",
  "host-repl",
  // @tuvren/host-session (issue #99 / ADR-0060): the duplex session frame
  // binding's routing tests run only in this lane.
  "host-session",
  // @tuvren/remote-session (ADR-0063): the reattach/redelivery/grace/dispatch-
  // timeout session-lifecycle seam's tests run only in this lane.
  "remote-session",
  // @tuvren/session-client (M5): the thin, zero-dependency reference remote
  // peer for the duplex session protocol over WebSocket. Its handshake,
  // dispatch-dedup, redelivery, reconnect/backoff, heartbeat, and inbound
  // frame-shape tests run only in this lane.
  "session-client",
  // Go, Python, and Dart kernel-port projects run their language-native
  // test runners (go test / pytest / dart test) through these Nx targets;
  // certification wrappers join the conformance lanes separately once
  // registered.
  "kernel-dart-kernel",
  "kernel-dart-certification",
  "kernel-dart-conformance-adapter",
  "kernel-go-kernel",
  "kernel-go-certification",
  "kernel-go-conformance-adapter",
  "kernel-python-kernel",
  "kernel-python-certification",
  "kernel-python-conformance-adapter",
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
  "framework-stream-ws",
  "framework-stream-agui",
  "framework-telemetry-otel",
  "telemetry-semconv",
  "host-repl",
  "host-session",
  // @tuvren/remote-session (ADR-0063): builds above host-session and
  // stream-core, so its lane must run alongside them.
  "remote-session",
  // @tuvren/session-client (M5): zero-dependency remote-peer package; builds
  // standalone (no workspace dependency edges) but still needs its own
  // lane entry so the build graph covers it.
  "session-client",
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
  "framework-stream-ws",
  "framework-stream-agui",
  "framework-telemetry-otel",
  "telemetry-semconv",
  "host-repl",
  "host-session",
  // @tuvren/remote-session (ADR-0063): package-exports smoke for the
  // reattachable session-lifecycle seam.
  "remote-session",
  // @tuvren/session-client (M5): package-exports smoke for the
  // zero-dependency reference WebSocket remote peer.
  "session-client",
];

// The constitutional gate: authority/conformance validators that must stay
// green regardless of which files changed. This is the single source of truth
// for the gate — the fast `check` inner loop selects a cheap subset of these by
// ID (see tools/scripts/check.ts), so the two lanes cannot drift apart silently:
// renaming or removing a step here makes `check`'s subset selection fail loudly
// instead of quietly dropping a class of drift coverage.
//
// Most steps are read-only. The machine authority guardrail is the exception:
// its freshness proof runs declared code generators and compares the resulting
// artifacts with snapshots. Keep that step available to derived lanes here,
// but execute it in a singleton phase wherever a lane includes it so readers
// never observe a generator's intermediate, not-yet-formatted output.
export const MACHINE_AUTHORITY_GUARDRAILS_STEP: VerificationStep = {
  command: [
    "bun",
    "tools/scripts/authority-guardrails/authority-guardrails.ts",
  ],
  id: "machine authority guardrails",
};

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
    id: "ADR-0057 host import boundary gate",
  },
  {
    // Routed through the cached Nx target (inputs: workspace sources +
    // manifests, gate scripts, snapshot, core authority packet) so unchanged
    // surfaces replay from cache; `bun run api-freeze:check` is the same gate
    // uncached for manual runs.
    command: ["bunx", "nx", "run", "shared-core:api-freeze-check"],
    id: "ADR-0054/0056 API-surface freeze gate",
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
  MACHINE_AUTHORITY_GUARDRAILS_STEP,
];

// ADR-0070 disabled Biome's formatter in the same commit that moved the writer
// to Oxfmt, so a read-only native formatter check is the only thing that keeps
// the tree Oxfmt-clean. The declared `format:check` script is the single
// command shared by the `check` inner loop and `verify`/CI lanes; it never
// writes, never runs Biome, and never invokes the Oxfmt writer.
export const FORMAT_CHECK_STEP: VerificationStep = {
  command: ["bun", "run", "format:check"],
  id: "Oxfmt formatting check (read-only)",
};

// KRT-BP003/B004/B005/B007/B008 acceptance suites: the immutable baseline is
// the seven original BP suites plus the two round-1 suites. Follow-up suites
// are registered separately so additions cannot weaken the exact-nine baseline
// proof. Both lists feed one durable verify/CI command.
export const ORIGINAL_BP_TOOLING_ACCEPTANCE_TESTS: readonly string[] = [
  "tools/scripts/biome-alias.test.ts",
  "tools/scripts/lib/biome-inventory.test.ts",
  "tools/scripts/lib/biome-lint-partition.test.ts",
  "tools/scripts/lib/biome-oxc-discovery.test.ts",
  "tools/scripts/biome-lint.test.ts",
  "tools/scripts/generator-oxfmt.test.ts",
  "tools/scripts/oxc-preparation.test.ts",
  "tools/scripts/oxc-project-discovery.test.ts",
  "tools/scripts/typecheck-source-aliases.test.ts",
];

export const FOLLOWUP_TOOLING_ACCEPTANCE_TESTS: readonly string[] = [
  "tools/conformance/harness/test/run.test.ts",
  "tools/scripts/api-freeze-gate.test.ts",
  "tools/scripts/generated-prerequisites.test.ts",
  "tools/scripts/json-check.test.ts",
  "tools/scripts/json-source-integrity.test.ts",
  "tools/scripts/lib/native-lint-routing-argv.test.ts",
  "tools/scripts/telemetry-codegen.test.ts",
  "tools/scripts/lib/command-runner.test.ts",
  "tools/scripts/lib/verification-logs.test.ts",
  "tools/scripts/verification-lifecycle.test.ts",
];

export const CERTIFICATION_TOOLING_ACCEPTANCE_TESTS: readonly string[] = [
  "tools/conformance/adapter-protocol/protocol-contract.test.ts",
  "tools/conformance/certification/certification-manifest.test.ts",
  "tools/conformance/certification/conformance-gate.test.ts",
  "tools/conformance/harness/test/adapter-client.test.ts",
  "tools/conformance/harness/test/assertion-engine.test.ts",
  "tools/conformance/harness/test/assertion-operators.test.ts",
  "tools/conformance/harness/test/barrier-steps.test.ts",
  "tools/conformance/harness/test/fault-activation.test.ts",
  "tools/conformance/harness/test/step-arguments.test.ts",
  "tools/conformance/harness/test/kernel-integrity.test.ts",
  "tools/conformance/harness/test/integrity-plan-contract.test.ts",
  "tools/conformance/harness/test/observation-encoding.test.ts",
  "tools/conformance/harness/test/operation-handles.test.ts",
  "tools/conformance/harness/test/operation-plan.test.ts",
  "tools/conformance/meta-conformance/negative-controls.test.ts",
  "tools/conformance/meta-conformance/claim-coverage.test.ts",
  "tools/conformance/plan-compiler/barrier-rules.test.ts",
  "tools/conformance/plan-compiler/certification-rules.test.ts",
  "tools/conformance/plan-compiler/index.test.ts",
  "tools/conformance/plan-compiler/handle-steps.test.ts",
  "tools/scripts/conformance/certification-schemas.test.ts",
  "tools/scripts/lib/conformance-contract.test.ts",
];

// This remains an explicit inventory rather than a glob. A new follow-up suite
// must be registered above to join the durable lane, and the existence check
// below fails loudly if any registered file is renamed or removed.
export const TOOLING_ACCEPTANCE_TESTS: readonly string[] = [
  ...ORIGINAL_BP_TOOLING_ACCEPTANCE_TESTS,
  ...FOLLOWUP_TOOLING_ACCEPTANCE_TESTS,
  ...CERTIFICATION_TOOLING_ACCEPTANCE_TESTS,
];

export const TOOLING_ACCEPTANCE_STEP: VerificationStep = {
  command: ["bun", "test", ...TOOLING_ACCEPTANCE_TESTS],
  id: "BP tooling acceptance suites",
};

// The exported arrays above are module-level constants, but the acceptance
// inventory can drift from the checkout. Fail loud at load time (like the
// CODEGEN_PROJECTS guard) instead of letting `bun test` skip a missing path.
{
  const missing = TOOLING_ACCEPTANCE_TESTS.filter(
    (relative) => !existsSync(path.join(process.cwd(), relative))
  );
  if (missing.length > 0) {
    throw new Error(
      `verify: TOOLING_ACCEPTANCE_TESTS references missing files (${missing.join(
        ", "
      )}) — update tools/scripts/verify.ts`
    );
  }
}

/**
 * Selects steps from AUTHORITY_GATE_STEPS by ID for a derived lane (check's
 * inner loop, the codegen lane). Throws if an ID no longer matches a verify
 * gate step, so a derived lane can never silently diverge from this file.
 */
export const selectAuthorityGateSteps = (
  ids: readonly string[],
  lane: string
): VerificationStep[] =>
  ids.map((id) => {
    const step = AUTHORITY_GATE_STEPS.find((candidate) => candidate.id === id);

    if (step === undefined) {
      throw new Error(
        `${lane}: authority gate id "${id}" no longer matches a verify gate step. ` +
          "Update the lane's ID list to track tools/scripts/verify.ts."
      );
    }

    return step;
  });

const CORE_VERIFICATION_PHASES: readonly VerificationPhase[] = [
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
      FORMAT_CHECK_STEP,
      {
        command: ["cargo", "fmt", "--all", "--", "--check"],
        id: "Rust workspace formatting",
      },
      ...AUTHORITY_GATE_STEPS.filter(
        (step) => step !== MACHINE_AUTHORITY_GUARDRAILS_STEP
      ),
    ],
  },
  {
    // Freshness validation invokes each authority packet's declared codegen
    // command. Generators write raw artifacts before their final formatter
    // pass, so overlapping this step with lint or format checks creates a
    // false failure against those transient bytes. A singleton phase preserves
    // the drift/worktree guards while making the write/read dependency explicit.
    concurrency: 1,
    id: "generated-artifact freshness guardrails",
    steps: [MACHINE_AUTHORITY_GUARDRAILS_STEP],
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
      {
        command: ["cargo", "test", "--workspace"],
        id: "Rust workspace tests",
      },
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
    // Go, Python, and Dart kernel certifications drive the shared stdio
    // harness against their native-toolchain adapters (`go run` / `uv run` /
    // `dart run`); the lanes are independent processes, so they may run in
    // parallel with each other but stay in their own phase to avoid
    // competing with the large serial Rust builds above.
    id: "Go, Python, and Dart kernel certification",
    steps: [
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-go-certification:conformance",
          "--skipNxCache",
        ],
        id: "Go kernel certification",
      },
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-python-certification:conformance",
          "--skipNxCache",
        ],
        id: "Python kernel certification",
      },
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-dart-certification:conformance",
          "--skipNxCache",
        ],
        id: "Dart kernel certification",
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
    // The BP acceptance suites are read-only static contracts. They run after
    // codegen freshness so generated prerequisites exist, and in a dedicated
    // serial phase so the worktree-purity guard observes the generator suites'
    // idempotent rewrites in isolation (they must leave the tree clean).
    concurrency: 1,
    id: "tooling acceptance suites",
    steps: [TOOLING_ACCEPTANCE_STEP],
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

export const createVerificationPhases = (): VerificationPhase[] =>
  prependGeneratedPrerequisitePhase(CORE_VERIFICATION_PHASES, {
    fresh: false,
  });

export const DEFAULT_VERIFICATION_PHASES: readonly VerificationPhase[] =
  createVerificationPhases();

interface StepRun extends VerificationResult {
  logFile?: string;
}

interface StepRunOptions extends VerificationRunOptions {
  logs?: VerificationLogs;
  /** Aborted by a repeated cancellation signal to abandon log replay. */
  replaySignal: AbortSignal;
  signal: AbortSignal;
}

const isVanishedConsumer = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "EPIPE" || error.code === "EIO");

/** Replays a step log; a repeated cancellation abandons it without failing. */
const replayStepLog = async (
  logFile: string,
  options: StepRunOptions
): Promise<void> => {
  if (options.replaySignal.aborted) {
    return;
  }
  try {
    await replayVerificationLog(logFile, process.stdout, options.replaySignal);
  } catch (error: unknown) {
    // Once cancelled, a vanished consumer (closed pipe, hung-up terminal) is
    // expected and must not replace the cancellation status.
    if (
      !(
        options.replaySignal.aborted ||
        (options.signal.aborted && isVanishedConsumer(error))
      )
    ) {
      throw error;
    }
  }
};

const runVerificationStep = async (
  step: VerificationStep,
  options: StepRunOptions
): Promise<StepRun> => {
  const [executable] = step.command;

  if (executable === undefined) {
    throw new Error(`verification step "${step.id}" has no executable`);
  }

  const startedAt = Date.now();
  const header = `\n==> ${step.id}\n$ ${step.command.join(" ")}\n`;

  if (options.signal.aborted) {
    return {
      code: abortExitCode(options.signal),
      durationMs: 0,
      id: step.id,
    };
  }
  if (options.executeStep !== undefined) {
    const code = await options.executeStep(step);
    return {
      code,
      durationMs: Date.now() - startedAt,
      id: step.id,
    };
  }

  if (options.logs === undefined) {
    throw new Error("verification requires a log session");
  }
  const logFile = await options.logs.create(header);
  process.stdout.write(`${header}Log: ${logFile}\n`);
  let code: number;
  try {
    const result = await runCommand(step.command, {
      outputFile: logFile,
      signal: options.signal,
    });
    code = result.code;
    if (result.stderr.length > 0) {
      await appendFile(logFile, `\n${result.stderr}\n`);
    }
  } catch (error: unknown) {
    code = 1;
    await appendFile(
      logFile,
      `\n${error instanceof Error ? error.message : String(error)}\n`
    );
  }

  return {
    code,
    durationMs: Date.now() - startedAt,
    id: step.id,
    logFile,
  };
};

const toResult = (run: StepRun): VerificationResult => ({
  code: run.code,
  durationMs: run.durationMs,
  id: run.id,
});

const runPhaseSerially = async (
  steps: readonly VerificationStep[],
  options: StepRunOptions
): Promise<VerificationResult[]> => {
  const results: VerificationResult[] = [];
  const runStep = async (index: number): Promise<void> => {
    const step = steps[index];
    if (step === undefined) {
      return;
    }
    const run = await runVerificationStep(step, options);
    if (run.logFile !== undefined) {
      await replayStepLog(run.logFile, options);
    }
    results.push(toResult(run));

    if (run.code === 0 && !options.signal.aborted) {
      await runStep(index + 1);
    }
  };

  await runStep(0);
  return results;
};

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    if (item === undefined) {
      return;
    }

    results[index] = await fn(item);
    await worker();
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  const settled = await Promise.allSettled(workers);
  // A failing log sink or callback must not let sibling commands outlive the
  // log session or lose their cancellation handlers.
  for (const result of settled) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  return results;
};

const runPhase = async (
  phase: VerificationPhase,
  options: StepRunOptions
): Promise<VerificationResult[]> => {
  const forceSerial = process.env.VERIFY_SERIAL === "1";
  const limit = forceSerial
    ? 1
    : (phase.concurrency ??
      Math.min(phase.steps.length, DEFAULT_MAX_CONCURRENCY));

  if (limit <= 1) {
    return await runPhaseSerially(phase.steps, options);
  }

  // Children write directly to unique log files. Once the whole phase has
  // finished, replay them in plan order so concurrent output stays readable
  // without accumulating in memory.
  const runs = await mapWithConcurrency(
    phase.steps,
    limit,
    async (step) => await runVerificationStep(step, options)
  );

  for (const run of runs) {
    if (run.logFile !== undefined) {
      await replayStepLog(run.logFile, options);
    }
  }

  return runs.map(toResult);
};

/** Reports retained logs; once cancelled, a vanished terminal is not an error. */
const reportRetainedLogs = (directory: string, cancelled: boolean): void => {
  try {
    process.stderr.write(`Verification logs retained: ${directory}\n`);
  } catch (error: unknown) {
    if (!(cancelled && isVanishedConsumer(error))) {
      throw error;
    }
  }
};

export const runVerificationPhases = async (
  phases: readonly VerificationPhase[],
  options: VerificationRunOptions = {}
): Promise<VerificationResult[]> => {
  const results: VerificationResult[] = [];
  const controller = new AbortController();
  const replayController = new AbortController();
  const abort = (reason?: unknown): void => controller.abort(reason);
  // Output the consumer can no longer receive is dropped once cancelled.
  const dropVanishedConsumer = (error: Error): void => {
    if (!isVanishedConsumer(error)) {
      throw error;
    }
  };
  // The first cancellation still replays completed and stopped step logs; a
  // repeated one, or a hang-up that already lost the terminal, abandons replay
  // so a stalled or vanished consumer cannot block exit.
  let signalsReceived = 0;
  let outputGuarded = false;
  const guardOutput = (): void => {
    if (!outputGuarded) {
      outputGuarded = true;
      process.stdout.on("error", dropVanishedConsumer);
      process.stderr.on("error", dropVanishedConsumer);
    }
  };
  controller.signal.addEventListener("abort", guardOutput, { once: true });
  const interrupt = (signal: CancellationSignal): void => {
    process.exitCode = cancellationExitCode(signal);
    signalsReceived += 1;
    if (signalsReceived > 1 || signal === "SIGHUP") {
      if (!replayController.signal.aborted) {
        options.onReplayAbandoned?.();
      }
      replayController.abort();
    }
    abort(signal);
  };
  const handlers = CANCELLATION_SIGNALS.map(
    (signal) => [signal, () => interrupt(signal)] as const
  );
  const abortFromOption = (): void => abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromOption, { once: true });
  if (options.signal?.aborted === true) {
    abort(options.signal.reason);
  }
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  let logs: VerificationLogs | undefined;
  let success = false;
  const runPhaseAt = async (index: number): Promise<boolean> => {
    const phase = phases[index];
    if (phase === undefined || controller.signal.aborted) {
      return true;
    }
    const before =
      phase.mutatesWorktree === true
        ? undefined
        : await readWorktreeSnapshot(process.cwd());
    const phaseResults = await runPhase(phase, {
      ...options,
      logs,
      replaySignal: replayController.signal,
      signal: controller.signal,
    });
    results.push(...phaseResults);

    if (before !== undefined) {
      await assertWorktreeUnchanged(before, {
        cwd: process.cwd(),
        label: `verification phase "${phase.id}"`,
      });
    }

    if (
      phaseResults.some((result) => result.code !== 0) ||
      controller.signal.aborted
    ) {
      return false;
    }

    return await runPhaseAt(index + 1);
  };

  try {
    if (options.executeStep === undefined) {
      logs = await createVerificationLogs(options.logDirectory);
    }
    await runPhaseAt(0);
    // Cancellation between phases must still produce a failing result.
    if (
      controller.signal.aborted &&
      !results.some((result) => result.code !== 0)
    ) {
      results.push({
        code: abortExitCode(controller.signal),
        durationMs: 0,
        id: "verification cancelled",
      });
    }
    success = !results.some((result) => result.code !== 0);
    return results;
  } finally {
    options.signal?.removeEventListener("abort", abortFromOption);
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
    try {
      if (logs !== undefined) {
        await logs.finish(success);
        if (!success) {
          reportRetainedLogs(logs.directory, controller.signal.aborted);
        }
      }
    } finally {
      if (outputGuarded) {
        // Late asynchronous write failures can still be emitted after return.
        setImmediate(() => {
          process.stdout.removeListener("error", dropVanishedConsumer);
          process.stderr.removeListener("error", dropVanishedConsumer);
        });
      }
    }
  }
};

export const hasVerificationFailure = (
  results: readonly VerificationResult[]
): boolean => results.some((result) => result.code !== 0);

export const printVerificationSummary = (
  results: readonly VerificationResult[]
): void => {
  console.log("");
  console.log("Transition verification summary");

  for (const result of results) {
    const status = result.code === 0 ? "pass" : `fail (${result.code})`;
    console.log(`- ${result.id}: ${status} in ${result.durationMs}ms`);
  }
};

/**
 * Runs the pipeline as a process entry point shared by every verification
 * lane (verify, release-check, verify-kernel, check, codegen), so each gets
 * the same summary, exit code, and abandoned-replay handling. When a signal abandoned log
 * replay, stdout writes may stay pending on an unread pipe and keep the
 * runtime alive, so exit explicitly once logs are finalized.
 */
export const runVerificationMain = async (
  phases: readonly VerificationPhase[] = DEFAULT_VERIFICATION_PHASES,
  options: VerificationRunOptions = {}
): Promise<VerificationResult[]> => {
  let replayAbandoned = false;
  const results = await runVerificationPhases(phases, {
    ...options,
    onReplayAbandoned: () => {
      replayAbandoned = true;
      options.onReplayAbandoned?.();
    },
  });
  if (!replayAbandoned) {
    printVerificationSummary(results);
  }
  if (hasVerificationFailure(results)) {
    process.exitCode ??= 1;
  }
  if (replayAbandoned) {
    process.exit(process.exitCode);
  }
  return results;
};

if (import.meta.main) {
  await runVerificationMain();
}
