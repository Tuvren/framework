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

export const RUST_NX_BUILD_PROJECTS: readonly string[] = [
  "framework-rust-conformance-runner",
  "kernel-rust-kernel",
  "kernel-rust-grpc-service",
  "kernel-rust-conformance-runner",
];

export const RUST_NX_TEST_PROJECTS: readonly string[] = [
  "framework-rust-conformance-runner",
  "kernel-rust-kernel",
  "kernel-rust-grpc-service",
];

export const WORKSPACE_TEST_PROJECTS: readonly string[] = [
  "provider-api",
  "framework-event-stream",
  "framework-runtime-api",
  "framework-driver-api",
  "framework-tool-contracts",
  // Keep the kernel testkit in the repo-global test lane so boundary-owned
  // fixture drift cannot hide behind the narrower conformance-runner coverage.
  "kernel-testkit",
  "backend-postgres",
  "kernel-typescript-conformance-runner",
  "framework-typescript-conformance-runner",
  "providers-typescript-conformance-runner",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "framework-runtime-core",
  "framework-runtime",
  "framework-driver-react",
  "host-playground",
  "host-repl",
];

export const WORKSPACE_BUILD_PROJECTS: readonly string[] = [
  "shared-core-types",
  "kernel-contract-protocol",
  "kernel-testkit",
  "backend-memory",
  "backend-sqlite",
  "backend-postgres",
  "provider-api",
  "providers-testkit",
  "providers-bridge-ai-sdk",
  "framework-runtime-api",
  "framework-driver-api",
  "framework-event-stream",
  "framework-tool-contracts",
  "framework-testkit",
  "framework-runtime-core",
  "framework-runtime",
  "framework-driver-react",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "host-playground",
  "host-repl",
];

export const WORKSPACE_EXPORT_SMOKE_PROJECTS: readonly string[] = [
  "kernel-testkit",
  "framework-driver-api",
  "framework-event-stream",
  "framework-runtime-api",
  "framework-runtime-core",
  "framework-runtime",
  "framework-tool-contracts",
  "provider-api",
  "providers-testkit",
  "framework-testkit",
  "providers-bridge-ai-sdk",
  "framework-stream-core",
  "framework-stream-sse",
  "framework-stream-agui",
  "host-playground",
  "host-repl",
];

export const DEFAULT_VERIFICATION_STEPS: readonly VerificationStep[] = [
  {
    command: ["bun", "run", "lint"],
    id: "workspace lint",
  },
  {
    command: ["cargo", "fmt", "--all", "--", "--check"],
    id: "Rust workspace formatting",
  },
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
      "kernel-rust-conformance-runner:conformance",
      "--skipNxCache",
    ],
    id: "Rust kernel conformance runner",
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
  {
    command: [
      "bun",
      "run",
      "nx",
      "run-many",
      "-t",
      "build",
      "-p",
      RUST_NX_BUILD_PROJECTS.join(","),
      // The Rust Nx wrappers shell out to Cargo-native commands, so keep these
      // serialized to avoid interleaving large Rust builds in the repo-global
      // verify lane.
      "--parallel=1",
    ],
    id: "Rust Nx target builds",
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
      RUST_NX_TEST_PROJECTS.join(","),
      // These targets exercise Cargo-backed Rust packages, so run them one at
      // a time for the same reason as the Rust build target smoke above.
      "--parallel=1",
    ],
    id: "Rust Nx target tests",
  },
  {
    command: ["bun", "run", "docs:authority-freeze:check"],
    id: "docs-to-authority freeze gate",
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
    command: ["bun", "tools/conformance/meta-conformance/run.ts"],
    id: "shared conformance runner meta-conformance",
  },
  {
    command: [
      "bun",
      "tools/scripts/authority-guardrails/authority-guardrails.ts",
    ],
    id: "machine authority guardrails",
  },
  {
    command: [
      "bun",
      "run",
      "nx",
      "run-many",
      "-t",
      "codegen",
      "-p",
      "shared-core-types,framework-runtime-api,framework-event-stream,framework-driver-api,framework-tool-contracts,provider-api,telemetry-semconv,compatibility-reporting,kernel-interop-grpc",
      // Compatibility codegen shells out to the conformance runners to produce
      // measured evidence, so verify forces a fresh execution here instead of
      // accepting cached artifacts from another workspace state.
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
  {
    // Telemetry codegen writes a checked-in TypeScript consumer, so verify
    // compiles and exercises the transition line after regeneration rather than
    // trusting the pre-codegen build/test outputs.
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
  {
    command: ["bun", "run", "proving-host:interop-smoke"],
    id: "cross-language proving-host interop smoke",
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
    command: ["bun", "run", "proving-host:scenario-sqlite"],
    id: "Node-backed proving-host SQLite reload scenario",
  },
  {
    command: ["bun", "run", "proving-host:scenario-postgres"],
    id: "PostgreSQL-backed proving-host reload scenario",
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
  console.log("Transition verification summary");

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
