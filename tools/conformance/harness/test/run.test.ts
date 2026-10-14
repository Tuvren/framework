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

const runCommand = (command: readonly string[]): Promise<CommandResult> => {
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
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
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
};

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);

  for (const dir of dirs) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("certification harness arguments and readers", () => {
  test.each([
    { args: [], error: "--adapter is required" },
    { args: ["--unknown"], error: "unknown runner argument --unknown" },
    { args: ["--adapter"], error: "--adapter requires a value" },
    {
      args: ["--adapter", "--summary-only"],
      error: "--adapter requires a value",
    },
    { args: ["--plan"], error: "--plan requires a value" },
    {
      args: ["--concurrency", "0"],
      error: "expected positive integer, received 0",
    },
    {
      args: ["--concurrency", "1.5"],
      error: "expected positive integer, received 1.5",
    },
    {
      args: ["--shard", "0/2"],
      error: "expected positive integer, received 0",
    },
    {
      args: ["--shard", "3/2"],
      error: "--shard index must be less than count",
    },
    {
      args: ["--shard", "1/0"],
      error: "expected positive integer, received 0",
    },
  ])("reports $error before reading adapter files", async ({ args, error }) => {
    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      ...args,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`error: ${error}`);
    expect(result.stderr).not.toContain("ReferenceError");
  });

  test("deduplicates packet plans and preserves selection and shard ordering", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tuvren-runner-test-"));
    tempDirs.push(tempDir);
    const adapterPath = join(tempDir, "adapter.json");
    const packetPath = join(tempDir, "packet.json");
    const planPath = join(tempDir, "plan.json");
    await writeFile(
      adapterPath,
      JSON.stringify({
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
      })
    );
    await writeFile(
      packetPath,
      JSON.stringify({
        conformancePlans: [
          { path: planPath, planId: "runner.state", planVersion: "0.1.0" },
          { path: planPath, planId: "runner.state", planVersion: "0.1.0" },
        ],
        packetId: "runner.state",
      })
    );
    await writeFile(
      planPath,
      JSON.stringify({
        applicability: { capabilities: ["runner.state"] },
        checks: ["z", "a", "m", "unavailable"].map((id) => ({
          assertions: [
            { equals: "dispatch", field: "$.source", kind: "stateField" },
          ],
          capabilities: id === "unavailable" ? ["runner.unavailable"] : [],
          checkId: `runner.state.${id}`,
          operation: "runner.state",
        })),
        packetId: "runner.state",
        planId: "runner.state",
        planVersion: "0.1.0",
      })
    );
    const command = [
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
    ];
    const shards = await Promise.all(
      ["1/2", "2/2"].map((shard) => runCommand([...command, "--shard", shard]))
    );

    expect(shards.map((result) => result.code)).toEqual([0, 0]);
    expect(shards.map((result) => result.stderr)).toEqual(["", ""]);
    const evidence = shards.map(
      (result) =>
        JSON.parse(result.stdout) as {
          checkResults: { checkId: string }[];
          nonApplicableCheckIds: string[];
          status: string;
        }
    );
    expect(
      evidence.map((entry) => entry.checkResults.map((check) => check.checkId))
    ).toEqual([["runner.state.a", "runner.state.z"], ["runner.state.m"]]);
    expect(evidence.map((entry) => entry.nonApplicableCheckIds)).toEqual([
      ["runner.state.unavailable"],
      ["runner.state.unavailable"],
    ]);
    expect(evidence.map((entry) => entry.status)).toEqual(["pass", "pass"]);

    const unknownChecks = await runCommand([
      ...command,
      "--check",
      "z-unknown",
      "--check",
      "a-unknown",
    ]);
    expect(unknownChecks.code).toBe(1);
    expect(unknownChecks.stderr).toContain(
      "unknown --check value(s): a-unknown, z-unknown"
    );
    const unknownCapabilities = await runCommand([
      ...command,
      "--capability",
      "z-unknown",
      "--capability",
      "a-unknown",
    ]);
    expect(unknownCapabilities.code).toBe(1);
    expect(unknownCapabilities.stderr).toContain(
      "unknown --capability value(s): a-unknown, z-unknown"
    );
    await writeFile(packetPath, "[]");
    const invalidPacket = await runCommand(command);
    expect(invalidPacket.code).toBe(1);
    expect(invalidPacket.stderr).toContain(
      `${packetPath} must contain an authority packet manifest`
    );
  });
});

describe("certification harness state handling", () => {
  test("rejects an invalid adapter manifest through its JSON Schema", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tuvren-runner-test-"));
    tempDirs.push(tempDir);

    const adapterPath = join(tempDir, "adapter.json");
    await writeFile(adapterPath, "[]\n");

    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("failed adapter manifest validation");
  });

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
      "tools/conformance/harness/run.ts",
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
      checkResults: {
        assertionResults: Array<{ assertionId: string; status: string }>;
      }[];
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

    const summaryResult = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
      "--check",
      "runner.state.dispatch-precedes-inspect",
      "--summary-only",
    ]);

    expect(summaryResult.stderr).toBe("");
    expect(summaryResult.code).toBe(0);

    const summary = JSON.parse(summaryResult.stdout) as {
      checkResults?: unknown;
      status: string;
      summary: { failedChecks: number; passedChecks: number };
    };

    expect(summary).toMatchObject({
      status: "pass",
      summary: {
        failedChecks: 0,
        passedChecks: 1,
      },
    });
    expect(summary.checkResults).toBeUndefined();
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
      "tools/conformance/harness/run.ts",
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
