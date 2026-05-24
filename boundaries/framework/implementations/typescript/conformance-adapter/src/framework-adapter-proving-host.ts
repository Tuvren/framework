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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../../../..", import.meta.url))
);
const REPL_CLI_PATH = resolve(
  REPO_ROOT,
  "boundaries/hosts/implementations/typescript/repl/dist/cli.js"
);

export function createFrameworkAdapterProvingHost(): {
  runHeadlessTranscriptReplay(input: unknown): Promise<AdapterProjection>;
} {
  return {
    async runHeadlessTranscriptReplay(
      input: unknown
    ): Promise<AdapterProjection> {
      const scenario = readProvingHostInput(input);
      const workspace = await mkdtemp(join(tmpdir(), "tuvren-repl-conf-"));
      const transcriptPath = join(workspace, "session.jsonl");

      try {
        const record = await runCli(
          [
            "--backend",
            scenario.backend,
            "--provider",
            scenario.providerMode,
            "--headless",
            "--record",
            transcriptPath,
          ],
          scenario.stdin
        );

        if (record.exitCode !== 0) {
          throw new Error(
            `headless record failed: ${record.stderr || record.stdout}`
          );
        }

        const replay = await runCli(["--replay", transcriptPath], "");

        if (replay.exitCode !== 0) {
          throw new Error(
            `transcript replay failed: ${replay.stderr || replay.stdout}`
          );
        }

        return {
          result: {
            provingHost: {
              headlessRecordKinds: parseJsonlKinds(record.stdout),
              headlessOutputs: parseJsonlOutputs(record.stdout),
              replay: JSON.parse(replay.stdout) as unknown,
              transcriptRecordKinds: parseJsonlKinds(
                await readFile(transcriptPath, "utf8")
              ),
            },
          },
        };
      } finally {
        await rm(workspace, { force: true, recursive: true });
      }
    },
  };
}

interface ProvingHostInput {
  backend: "memory";
  providerMode: "fixture";
  stdin: string;
}

function readProvingHostInput(input: unknown): ProvingHostInput {
  const checkInput =
    isRecord(input) && isRecord(input.checkInput) ? input.checkInput : input;

  if (!isRecord(checkInput)) {
    return {
      backend: "memory",
      providerMode: "fixture",
      stdin: ".status\n",
    };
  }

  return {
    backend: readLiteral(checkInput.backend, "memory", "backend"),
    providerMode: readLiteral(
      checkInput.providerMode,
      "fixture",
      "providerMode"
    ),
    stdin:
      typeof checkInput.stdin === "string" ? checkInput.stdin : ".status\n",
  };
}

function readLiteral<T extends string>(
  value: unknown,
  expected: T,
  label: string
): T {
  if (value === undefined || value === expected) {
    return expected;
  }

  throw new Error(`unsupported proving-host ${label} "${String(value)}"`);
}

async function runCli(
  argv: readonly string[],
  stdin: string
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const child = spawn("node", [REPL_CLI_PATH, ...argv], {
    cwd: REPO_ROOT,
    env: {
      CI: process.env.CI,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      PATH: process.env.PATH,
      TERM: process.env.TERM,
      TMPDIR: process.env.TMPDIR,
      TZ: process.env.TZ,
      USER: process.env.USER,
    },
    stdio: "pipe",
  });
  let stderr = "";
  let stdout = "";

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });
  child.stdin.end(stdin);

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function parseJsonlKinds(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => readRecordKind(JSON.parse(line) as unknown));
}

function parseJsonlOutputs(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(
      (record): record is { output: string } =>
        isRecord(record) && typeof record.output === "string"
    )
    .map((record) => record.output);
}

function readRecordKind(value: unknown): string {
  if (isRecord(value) && typeof value.recordKind === "string") {
    return value.recordKind;
  }

  return "<unknown>";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
