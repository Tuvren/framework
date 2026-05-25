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

import { runCommand } from "./command-runner.js";

export interface WorktreeGuardOptions {
  cwd: string;
  label: string;
}

export interface WorktreeSnapshot {
  stagedDiff: string;
  status: string;
  unstagedDiff: string;
}

export async function readWorktreeSnapshot(
  cwd: string
): Promise<WorktreeSnapshot> {
  const [status, unstagedDiff, stagedDiff] = await Promise.all([
    readGitOutput(
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
      cwd
    ),
    readGitOutput(["git", "diff", "--binary"], cwd),
    readGitOutput(["git", "diff", "--cached", "--binary"], cwd),
  ]);

  return {
    stagedDiff,
    status,
    unstagedDiff,
  };
}

export async function assertWorktreeUnchanged(
  before: WorktreeSnapshot,
  options: WorktreeGuardOptions
): Promise<void> {
  const after = await readWorktreeSnapshot(options.cwd);

  if (
    before.status === after.status &&
    before.unstagedDiff === after.unstagedDiff &&
    before.stagedDiff === after.stagedDiff
  ) {
    return;
  }

  const changes = after.status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  throw new Error(
    [
      `${options.label} mutated the worktree while running a read-only verification step.`,
      "Changed files:",
      ...changes.map((change) => `- ${change}`),
    ].join("\n")
  );
}

async function readGitOutput(
  command: readonly string[],
  cwd: string
): Promise<string> {
  const result = await runCommand(command, { captureOutput: true, cwd });

  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || `${command.join(" ")} failed`
    );
  }

  return result.stdout;
}
