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

// KRT-BT004. Exercise the pinned Nx executor itself so classifier acceptance
// is backed by measured child argv and serial checker failure behavior.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const NX_CLI = path.join(REPO_ROOT, "node_modules/nx/dist/bin/nx.js");

interface NxChildCapture {
  argv: string[];
  label: string;
}

interface NxFixtureResult {
  captures: NxChildCapture[];
  exitCode: number;
}

const parseNxChildCapture = (line: string): NxChildCapture => {
  const value: unknown = JSON.parse(line);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("argv" in value) ||
    !Array.isArray(value.argv) ||
    !value.argv.every((entry: unknown) => typeof entry === "string") ||
    !("label" in value) ||
    typeof value.label !== "string"
  ) {
    throw new TypeError(`invalid Nx child capture: ${line}`);
  }
  return { argv: value.argv, label: value.label };
};

const installedNxVersion = (): string => {
  const value: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "node_modules/nx/package.json"), "utf-8")
  );
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new TypeError("installed Nx package has no string version");
  }
  return value.version;
};

const writeNxArgvFixture = (root: string): void => {
  const nodeModules = path.join(root, "node_modules");
  mkdirSync(nodeModules);
  symlinkSync(
    path.join(REPO_ROOT, "node_modules/nx"),
    path.join(nodeModules, "nx")
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "nx-forwarding-fixture", private: true })
  );
  writeFileSync(path.join(root, "nx.json"), "{}");
  writeFileSync(
    path.join(root, "argv-recorder.ts"),
    `import { appendFileSync } from "node:fs";
const [label = "missing", exitCode = "0", ...argv] = process.argv.slice(2);
const captureFile = process.env.NX_ARGV_CAPTURE_FILE;
if (captureFile === undefined) throw new Error("missing capture file");
appendFileSync(captureFile, JSON.stringify({ argv, label }) + "\\n");
process.exit(Number(exitCode));
`
  );
};

const runNxFixtureTarget = (
  root: string,
  caseName: string,
  options: Record<string, unknown>,
  args: readonly string[]
): NxFixtureResult => {
  writeFileSync(
    path.join(root, "project.json"),
    JSON.stringify({
      name: "fixture",
      targets: { lint: { executor: "nx:run-commands", options } },
    })
  );
  const captureFile = path.join(root, `${caseName}-capture.jsonl`);
  const cacheDirectory = path.join(root, ".nx-cache", caseName);
  const workspaceDataDirectory = path.join(root, ".nx-data", caseName);
  mkdirSync(cacheDirectory, { recursive: true });
  mkdirSync(workspaceDataDirectory, { recursive: true });
  const child = spawnSync(
    process.execPath,
    [NX_CLI, "run", "fixture:lint", ...args],
    {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        NX_ARGV_CAPTURE_FILE: captureFile,
        NX_CACHE_DIRECTORY: cacheDirectory,
        NX_DAEMON: "false",
        NX_TASKS_RUNNER_DYNAMIC_OUTPUT: "false",
        NX_WORKSPACE_DATA_DIRECTORY: workspaceDataDirectory,
      },
    }
  );
  const captureText = existsSync(captureFile)
    ? readFileSync(captureFile, "utf-8")
    : "";
  return {
    captures: captureText
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseNxChildCapture),
    exitCode: child.status ?? -1,
  };
};

describe("native lint routing argument isolation", () => {
  test("pins forwarding and checker failures against Nx 22.7.12", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nx-forwarding-fixture-"));
    try {
      expect(installedNxVersion()).toBe("22.7.12");
      writeNxArgvFixture(root);
      const command = "bun ./argv-recorder.ts argv 0";
      const isolated = { command, cwd: ".", forwardAllArgs: false };
      const isolatedCases = [
        ["configured-args", ["--args=--ordinary=forwarded"]],
        ["after-dash", ["--", "--after-dash=forwarded"]],
        ["unknown-scalar", ["--unknown-scalar=forwarded"]],
      ] as const;
      for (const [caseName, args] of isolatedCases) {
        const result = runNxFixtureTarget(root, caseName, isolated, args);
        expect(result.exitCode).toBe(0);
        expect(result.captures).toEqual([{ argv: [], label: "argv" }]);
      }

      for (const [caseName, options] of [
        ["omitted", { command, cwd: "." }],
        [
          "nested-true",
          {
            commands: [{ command, forwardAllArgs: true }],
            cwd: ".",
            forwardAllArgs: false,
          },
        ],
      ] as const) {
        const result = runNxFixtureTarget(root, caseName, options, [
          "--args=--ordinary=forwarded",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.captures).toEqual([
          { argv: ["--ordinary=forwarded"], label: "argv" },
        ]);
      }

      const serial = { cwd: ".", forwardAllArgs: false, parallel: false };
      const oxlintFailure = runNxFixtureTarget(
        root,
        "oxlint-failure",
        {
          ...serial,
          commands: [
            "bun ./argv-recorder.ts oxlint 23",
            "bun ./argv-recorder.ts json 0",
          ],
        },
        []
      );
      expect(oxlintFailure.exitCode).not.toBe(0);
      expect(oxlintFailure.captures).toEqual([{ argv: [], label: "oxlint" }]);

      const jsonFailure = runNxFixtureTarget(
        root,
        "json-failure",
        {
          ...serial,
          commands: [
            "bun ./argv-recorder.ts oxlint 0",
            "bun ./argv-recorder.ts json 29",
          ],
        },
        []
      );
      expect(jsonFailure.exitCode).not.toBe(0);
      expect(jsonFailure.captures).toEqual([
        { argv: [], label: "oxlint" },
        { argv: [], label: "json" },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 30_000);
});
