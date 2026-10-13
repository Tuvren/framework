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

import { describe, expect, test } from "bun:test";

import { runCommand } from "./command-runner.js";

describe("runCommand", () => {
  test("rejects empty argv with the executable precondition message", async () => {
    let failure: unknown;
    try {
      await runCommand([]);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected the empty command to reject");
    }
    expect(failure.message).toBe("runCommand requires an executable");
  });

  test("merges explicit environment overrides", async () => {
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        "process.stdout.write(JSON.stringify([process.env.TEST_VALUE, process.env.PATH]))",
      ],
      {
        captureOutput: true,
        env: {
          TEST_VALUE: "interop-fast-path",
        },
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify(["interop-fast-path", process.env.PATH])
    );
  });

  test("preserves output and the exit code for a failed command", async () => {
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        "process.stdout.write('before failure'); process.stderr.write('failure detail'); process.exitCode = 7",
      ],
      { captureOutput: true }
    );

    expect(result).toEqual({
      code: 7,
      stderr: "failure detail",
      stdout: "before failure",
    });
  });

  test("returns the fallback exit code when the child dies from a signal", async () => {
    const result = await runCommand(
      [process.execPath, "--eval", "process.kill(process.pid, 'SIGTERM')"],
      { captureOutput: true }
    );

    expect(result).toEqual({ code: 1, stderr: "", stdout: "" });
  });

  test("returns a timeout exit code when the command exceeds the deadline", async () => {
    const result = await runCommand(
      [process.execPath, "--eval", "setTimeout(() => {}, 1000)"],
      {
        captureOutput: true,
        timeoutMs: 25,
      }
    );

    expect(result.code).toBe(124);
    expect(result.stderr).toContain("command timed out after 25ms");
  });
});
