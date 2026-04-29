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

export interface RunCommandOptions {
  captureOutput?: boolean;
  cwd?: string;
}

export interface RunCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export function runCommand(
  command: readonly string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  const [executable, ...args] = command;

  if (executable === undefined) {
    throw new Error("runCommand requires an executable");
  }

  return new Promise<RunCommandResult>((resolve, reject) => {
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.captureOutput ? "pipe" : "inherit",
    });

    if (options.captureOutput) {
      child.stdout?.on("data", (chunk: Uint8Array) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Uint8Array) => {
        stderrChunks.push(chunk);
      });
    }

    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    });
  });
}
