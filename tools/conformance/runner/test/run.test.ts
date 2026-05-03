/**
 * Copyright 2026 Oscar Yanez Cisterna (@SkrOYC)
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

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);

  for (const dir of dirs) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("conformance runner state handling", () => {
  test("keeps dispatch state when inspectState also returns state", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tuvren-runner-test-"));
    tempDirs.push(tempDir);

    const adapterPath = join(tempDir, "adapter.json");
    const packetPath = join(tempDir, "packet.json");
    const planPath = join(tempDir, "plan.json");

    await writeFile(
      packetPath,
      `${JSON.stringify({ packetId: "runner.state" }, null, 2)}\n`
    );

    await writeFile(
      adapterPath,
      `${JSON.stringify(
        {
          adapterId: "state-precedence-adapter",
          authorityPackets: [packetPath],
          boundary: "framework",
          capabilities: ["runner.state"],
          command: ["bun", "--eval", statePrecedenceAdapterScript],
          implementationId: "state-precedence-adapter",
          language: "typescript",
          protocol: {
            name: "tuvren.conformance-adapter",
            transport: "json-rpc-2.0-stdio",
            version: "0.1.0",
          },
          suiteId: "runner.state",
          suiteVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    await writeFile(
      planPath,
      `${JSON.stringify(
        {
          applicability: {
            capabilities: ["runner.state"],
          },
          checks: [
            {
              assertions: [
                {
                  equals: "dispatch",
                  field: "$.source",
                  kind: "stateField",
                },
              ],
              checkId: "runner.state.dispatch-precedes-inspect",
              operation: "runner.state",
            },
          ],
          packetId: "runner.state",
          planId: "runner.state",
          planVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    const result = await runCommand([
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
      "--check",
      "runner.state.dispatch-precedes-inspect",
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const evidence = JSON.parse(result.stdout) as {
      checkResults: Array<{
        assertionResults: Array<{ assertionId: string; status: string }>;
      }>;
      summary: { failedChecks: number; passedChecks: number };
    };

    expect(evidence.summary).toMatchObject({
      failedChecks: 0,
      passedChecks: 1,
    });
    expect(evidence.checkResults[0]?.assertionResults).toContainEqual({
      assertionId: "runner.state.dispatch-precedes-inspect.1.stateField",
      status: "pass",
    });
  });

  test("merges inspected state with adapter error state", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tuvren-runner-test-"));
    tempDirs.push(tempDir);

    const adapterPath = join(tempDir, "adapter.json");
    const packetPath = join(tempDir, "packet.json");
    const planPath = join(tempDir, "plan.json");

    await writeFile(
      packetPath,
      `${JSON.stringify({ packetId: "runner.state" }, null, 2)}\n`
    );

    await writeFile(
      adapterPath,
      `${JSON.stringify(
        {
          adapterId: "error-state-adapter",
          authorityPackets: [packetPath],
          boundary: "framework",
          capabilities: ["runner.state"],
          command: ["bun", "--eval", errorStateAdapterScript],
          implementationId: "error-state-adapter",
          language: "typescript",
          protocol: {
            name: "tuvren.conformance-adapter",
            transport: "json-rpc-2.0-stdio",
            version: "0.1.0",
          },
          suiteId: "runner.state",
          suiteVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    await writeFile(
      planPath,
      `${JSON.stringify(
        {
          applicability: {
            capabilities: ["runner.state"],
          },
          checks: [
            {
              assertions: [
                {
                  equals: "inspect",
                  field: "$.source",
                  kind: "stateField",
                },
                {
                  equals: "adapter_failed",
                  field: "$.adapterError.code",
                  kind: "stateField",
                },
              ],
              checkId: "runner.state.error-merges-inspect",
              evidence: ["source", "adapterError.code"],
              operation: "runner.state",
            },
          ],
          packetId: "runner.state",
          planId: "runner.state",
          planVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    const result = await runCommand([
      "bun",
      "tools/conformance/runner/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
      "--check",
      "runner.state.error-merges-inspect",
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const evidence = JSON.parse(result.stdout) as {
      summary: { failedChecks: number; passedChecks: number };
    };

    expect(evidence.summary).toMatchObject({
      failedChecks: 0,
      passedChecks: 1,
    });
  });
});

const statePrecedenceAdapterScript = `
  for await (const line of console) {
    const request = JSON.parse(line);
    const respond = (result) => {
      process.stdout.write(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result
      }) + "\\n");
    };

    if (request.method === "initialize") {
      respond({
        adapterId: "state-precedence-adapter",
        capabilities: ["runner.state"],
        packetId: request.params.packetId,
        planVersion: request.params.planVersion
      });
      continue;
    }

    if (request.method === "dispatch") {
      respond({
        kind: "result",
        value: {
          state: { source: "dispatch" }
        }
      });
      continue;
    }

    if (request.method === "events") {
      respond([]);
      continue;
    }

    if (request.method === "inspectState") {
      respond({ source: "inspect" });
      continue;
    }

    if (request.method === "shutdown") {
      respond(null);
    }
  }
`;

const errorStateAdapterScript = `
  for await (const line of console) {
    const request = JSON.parse(line);
    const respond = (result) => {
      process.stdout.write(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result
      }) + "\\n");
    };

    if (request.method === "initialize") {
      respond({
        adapterId: "error-state-adapter",
        capabilities: ["runner.state"],
        packetId: request.params.packetId,
        planVersion: request.params.planVersion
      });
      continue;
    }

    if (request.method === "dispatch") {
      respond({
        error: {
          code: "adapter_failed",
          message: "operation failed"
        },
        kind: "error"
      });
      continue;
    }

    if (request.method === "events") {
      respond([]);
      continue;
    }

    if (request.method === "inspectState") {
      respond({ source: "inspect" });
      continue;
    }

    if (request.method === "shutdown") {
      respond(null);
    }
  }
`;

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

function runCommand(command: readonly string[]): Promise<CommandResult> {
  const [executable, ...args] = command;

  if (executable === undefined) {
    throw new Error("command must not be empty");
  }

  const child = spawn(executable, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stderr,
        stdout,
      });
    });
  });
}
