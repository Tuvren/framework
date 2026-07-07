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

import { access, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./lib/command-runner.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROTO_ROOT = "spec/interop/proto";
const GENERATED_ROOT =
  "typescript/kernel/grpc-client/src/lib/generated/kernel-interop";
const GENERATED_TSCONFIG =
  "typescript/kernel/grpc-client/tsconfig.kernel-interop.generated.json";
const REQUIRED_GENERATED_FILES: readonly string[] = [
  `${GENERATED_ROOT}/tuvren/kernel/interop/v1/kernel_services_pb.ts`,
  `${GENERATED_ROOT}/tuvren/kernel/interop/v1/kernel_types_pb.ts`,
];
const AGAINST_BRANCH_CANDIDATES: readonly string[] = [
  "origin/master",
  "master",
];
const BREAKING_BASELINE_FETCH_TIMEOUT_MS = 30_000;

const mode = process.argv[2] ?? "interop-smoke";

switch (mode) {
  case "breaking":
    await runBreakingCheck();
    break;
  case "codegen":
    await runCodegen();
    break;
  case "interop-smoke":
    await runInteropSmoke();
    break;
  case "lint":
    await runBufLint();
    break;
  default:
    throw new Error(`unknown kernel interop governance mode "${mode}"`);
}

async function runInteropSmoke(): Promise<void> {
  await runBufLint();
  await runBreakingCheck();
  await runCodegen();
  await assertNoCheckedInGeneratedBindings();
  console.log("kernel interop governance smoke passed");
}

async function runBufLint(): Promise<void> {
  await runRequiredCommand(["buf", "lint"]);
}

async function runCodegen(): Promise<void> {
  await runRequiredCommand(["buf", "generate"]);
  await assertGeneratedBindings();
  await runGeneratedBindingsTypecheck();
}

async function runBreakingCheck(): Promise<void> {
  await refreshRemoteBreakingBaseline();

  const againstBranchSearch = await findAgainstBranchWithProtoBaseline();

  if (againstBranchSearch.branch === undefined) {
    if (againstBranchSearch.inspectedBranchCount === 0) {
      throw new Error(
        `unable to inspect a kernel interop breaking-check baseline; checked ${AGAINST_BRANCH_CANDIDATES.join(", ")}`
      );
    }

    // Epic T is the first proto merge, so the initial branch has no baseline to
    // compare against. After this lands, this path stops applying because the
    // against branch will contain the proto authority.
    console.log(
      "kernel interop breaking check skipped: no prior proto baseline found"
    );
    return;
  }

  await runRequiredCommand([
    "buf",
    "breaking",
    "--against",
    `.git#branch=${againstBranchSearch.branch}`,
    "--against-config",
    "buf.yaml",
  ]);
}

async function refreshRemoteBreakingBaseline(): Promise<void> {
  const hasOriginMaster = await branchExists("origin/master");

  if (!hasOriginMaster) {
    return;
  }

  const result = await runCommand(
    ["git", "fetch", "--quiet", "origin", "master:refs/remotes/origin/master"],
    {
      captureOutput: true,
      cwd: REPO_ROOT,
      env: {
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "true",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        SSH_ASKPASS: "/bin/false",
        GIT_TERMINAL_PROMPT: "0",
      },
      // Governance smoke must fail fast when the remote baseline cannot be
      // refreshed non-interactively; hanging for credentials would stall the
      // entire Epic V verify lane without adding useful protocol signal.
      timeoutMs: BREAKING_BASELINE_FETCH_TIMEOUT_MS,
    }
  );

  if (result.code !== 0) {
    // Falling back to the already-fetched local ref is intentional: a private
    // SSH remote or offline shell should not turn the governance lane into an
    // auth check when `buf breaking` can still compare against the best local
    // baseline we have. The timeout above keeps the refresh attempt useful
    // without making Epic V verification hang on credentials.
    console.warn(
      [
        "kernel interop breaking baseline refresh skipped; using local origin/master",
        result.stderr.trim(),
      ]
        .filter((value) => value.length > 0)
        .join("\n")
    );
  }
}

async function branchExists(branch: string): Promise<boolean> {
  const result = await runCommand(["git", "rev-parse", "--verify", branch], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  return result.code === 0;
}

interface AgainstBranchSearch {
  branch: string | undefined;
  inspectedBranchCount: number;
}

async function findAgainstBranchWithProtoBaseline(): Promise<AgainstBranchSearch> {
  let inspectedBranchCount = 0;

  for (const branch of AGAINST_BRANCH_CANDIDATES) {
    const result = await runCommand(
      ["git", "ls-tree", "-r", "--name-only", branch, "--", PROTO_ROOT],
      { captureOutput: true, cwd: REPO_ROOT }
    );

    if (result.code !== 0) {
      continue;
    }

    inspectedBranchCount += 1;

    const hasProtoFile = result.stdout
      .split("\n")
      .some((line) => line.endsWith(".proto"));

    if (hasProtoFile) {
      return { branch, inspectedBranchCount };
    }
  }

  return { branch: undefined, inspectedBranchCount };
}

async function assertGeneratedBindings(): Promise<void> {
  for (const generatedFile of REQUIRED_GENERATED_FILES) {
    await access(resolve(REPO_ROOT, generatedFile));
  }

  const generatedFiles = await listFiles(resolve(REPO_ROOT, GENERATED_ROOT));

  // Keep generation exact: extra files usually mean a plugin option changed or
  // a new proto authority was added without updating the consumer placement.
  if (generatedFiles.length !== REQUIRED_GENERATED_FILES.length) {
    throw new Error(
      `kernel interop codegen produced ${generatedFiles.length} files; expected ${REQUIRED_GENERATED_FILES.length}`
    );
  }
}

async function assertNoCheckedInGeneratedBindings(): Promise<void> {
  // The .proto files are the authored authority; language bindings are local
  // consumer output and must stay ignored until a future TechSpec promotes them.
  const result = await runCommand(["git", "ls-files", "--", GENERATED_ROOT], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  if (result.code !== 0) {
    throw new Error("unable to inspect checked-in kernel interop bindings");
  }

  if (result.stdout.trim().length > 0) {
    throw new Error(
      `generated kernel interop bindings must not be checked in:\n${result.stdout.trim()}`
    );
  }
}

async function runGeneratedBindingsTypecheck(): Promise<void> {
  // Runtime-core does not include `.generated` in its normal package
  // typecheck, so the interop governance lane compiles generated bindings
  // explicitly before claiming codegen is healthy.
  await runRequiredCommand([
    "bunx",
    "--bun",
    "tsc",
    "--project",
    GENERATED_TSCONFIG,
  ]);
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(relative(REPO_ROOT, entryPath));
    }
  }

  return files.sort();
}

async function runRequiredCommand(command: readonly string[]): Promise<void> {
  const result = await runCommand(command, { cwd: REPO_ROOT });

  if (result.code !== 0) {
    throw new Error(`command failed: ${command.join(" ")}`);
  }
}
