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
import path from "node:path";
import process from "node:process";

import { runCommand } from "./lib/command-runner.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
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

const runRequiredCommand = async (
  command: readonly string[]
): Promise<void> => {
  const result = await runCommand(command, { cwd: REPO_ROOT });

  if (result.code !== 0) {
    throw new Error(`command failed: ${command.join(" ")}`);
  }
};

const listFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath = path.resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return await listFiles(entryPath);
      }
      return entry.isFile() ? [path.relative(REPO_ROOT, entryPath)] : [];
    })
  );

  return files.flat().toSorted();
};

const branchExists = async (branch: string): Promise<boolean> => {
  const result = await runCommand(["git", "rev-parse", "--verify", branch], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  return result.code === 0;
};

const refreshRemoteBreakingBaseline = async (): Promise<void> => {
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
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "/bin/false",
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
};

const inspectAgainstBranchCandidate = async (
  index: number,
  inspectedBranchCount: number
): Promise<AgainstBranchSearch> => {
  const branch = AGAINST_BRANCH_CANDIDATES[index];
  if (branch === undefined) {
    return { branch: undefined, inspectedBranchCount };
  }

  const result = await runCommand(
    ["git", "ls-tree", "-r", "--name-only", branch, "--", PROTO_ROOT],
    { captureOutput: true, cwd: REPO_ROOT }
  );
  if (result.code !== 0) {
    return await inspectAgainstBranchCandidate(index + 1, inspectedBranchCount);
  }

  const nextInspectedBranchCount = inspectedBranchCount + 1;
  const hasProtoFile = result.stdout
    .split("\n")
    .some((line) => line.endsWith(".proto"));
  if (hasProtoFile) {
    return { branch, inspectedBranchCount: nextInspectedBranchCount };
  }

  return await inspectAgainstBranchCandidate(
    index + 1,
    nextInspectedBranchCount
  );
};

const findAgainstBranchWithProtoBaseline =
  async (): Promise<AgainstBranchSearch> =>
    await inspectAgainstBranchCandidate(0, 0);

const assertGeneratedBindings = async (): Promise<void> => {
  await Promise.all(
    REQUIRED_GENERATED_FILES.map(async (generatedFile) => {
      await access(path.resolve(REPO_ROOT, generatedFile));
    })
  );

  const generatedFiles = await listFiles(
    path.resolve(REPO_ROOT, GENERATED_ROOT)
  );

  // Keep generation exact: extra files usually mean a plugin option changed or
  // a new proto authority was added without updating the consumer placement.
  if (generatedFiles.length !== REQUIRED_GENERATED_FILES.length) {
    throw new Error(
      `kernel interop codegen produced ${generatedFiles.length} files; expected ${REQUIRED_GENERATED_FILES.length}`
    );
  }
};

const assertNoCheckedInGeneratedBindings = async (): Promise<void> => {
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
};

const runGeneratedBindingsTypecheck = async (): Promise<void> => {
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
};

const runBufLint = async (): Promise<void> => {
  await runRequiredCommand(["buf", "lint"]);
};

const runCodegen = async (): Promise<void> => {
  await runRequiredCommand(["buf", "generate"]);
  await assertGeneratedBindings();
  await runGeneratedBindingsTypecheck();
};

const runBreakingCheck = async (): Promise<void> => {
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
};

const runInteropSmoke = async (): Promise<void> => {
  await runBufLint();
  await runBreakingCheck();
  await runCodegen();
  await assertNoCheckedInGeneratedBindings();
  console.log("kernel interop governance smoke passed");
};

const mode = process.argv[2] ?? "interop-smoke";

switch (mode) {
  case "breaking": {
    await runBreakingCheck();
    break;
  }
  case "codegen": {
    await runCodegen();
    break;
  }
  case "interop-smoke": {
    await runInteropSmoke();
    break;
  }
  case "lint": {
    await runBufLint();
    break;
  }
  default: {
    throw new Error(`unknown kernel interop governance mode "${mode}"`);
  }
}

interface AgainstBranchSearch {
  branch: string | undefined;
  inspectedBranchCount: number;
}
