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
  test("merges explicit environment overrides", async () => {
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        "process.stdout.write(process.env.TEST_VALUE ?? '')",
      ],
      {
        captureOutput: true,
        env: {
          TEST_VALUE: "interop-fast-path",
        },
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("interop-fast-path");
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
