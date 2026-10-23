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
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";
import {
  errorStateAdapterScript,
  statePrecedenceAdapterScript,
} from "./run-adapters-fixture.ts";

const runCommand = async (
  command: readonly string[]
): Promise<CommandResult> => {
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

  const closed: unknown[] = await once(child, "close");
  const [code] = closed;
  return { code: typeof code === "number" ? code : -1, stderr, stdout };
};

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);

  const visit = async (index: number): Promise<void> => {
    const dir = dirs[index];
    if (dir === undefined) {
      return;
    }
    await rm(dir, { force: true, recursive: true });
    await visit(index + 1);
  };
  await visit(0);
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
    const tempDir = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-runner-test-")
    );
    tempDirs.push(tempDir);
    const adapterPath = nodePath.join(tempDir, "adapter.json");
    const packetPath = nodePath.join(tempDir, "packet.json");
    const planPath = nodePath.join(tempDir, "plan.json");
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
      ["1/2", "2/2"].map(
        async (shard) => await runCommand([...command, "--shard", shard])
      )
    );

    expect(shards.map((result) => result.code)).toEqual([0, 0]);
    expect(shards.map((result) => result.stderr)).toEqual(["", ""]);
    const evidence = shards.map((result) => {
      const value: unknown = JSON.parse(result.stdout);
      assertConformanceEvidence(value, "runner output");
      return value;
    });
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
    const tempDir = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-runner-test-")
    );
    tempDirs.push(tempDir);

    const adapterPath = nodePath.join(tempDir, "adapter.json");
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
    const tempDir = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-runner-test-")
    );
    tempDirs.push(tempDir);

    const adapterPath = nodePath.join(tempDir, "adapter.json");
    const packetPath = nodePath.join(tempDir, "packet.json");
    const planPath = nodePath.join(tempDir, "plan.json");

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

    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, "runner output");

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

    const summary: unknown = JSON.parse(summaryResult.stdout);

    expect(summary).toMatchObject({
      status: "pass",
      summary: {
        failedChecks: 0,
        passedChecks: 1,
      },
    });
    expect(summary).not.toHaveProperty("checkResults");

    const manifestText = await readFile(adapterPath, "utf-8");
    const invalidContextScript = statePrecedenceAdapterScript.replace(
      'state: { source: "dispatch" }',
      "evidence: [], events: {}"
    );
    await writeFile(
      adapterPath,
      manifestText.replace(
        JSON.stringify(statePrecedenceAdapterScript),
        JSON.stringify(invalidContextScript)
      )
    );
    const invalidContext = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
    ]);
    expect(invalidContext.code).toBe(1);
    const invalidEvidence: unknown = JSON.parse(invalidContext.stdout);
    assertConformanceEvidence(invalidEvidence, "invalid context evidence");
    expect(invalidEvidence.checkResults[0]?.assertionResults[0]?.message).toBe(
      "operation context field must be an object when present"
    );
  });

  test("merges inspected state with adapter error state", async () => {
    const tempDir = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-runner-test-")
    );
    tempDirs.push(tempDir);

    const adapterPath = nodePath.join(tempDir, "adapter.json");
    const packetPath = nodePath.join(tempDir, "packet.json");
    const planPath = nodePath.join(tempDir, "plan.json");

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

    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, "runner output");

    expect(evidence.summary).toMatchObject({
      failedChecks: 0,
      passedChecks: 1,
    });
  });
});

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

describe("certification harness zero-applicable status", () => {
  const writeZeroApplicableFixture = async (
    planCapability: string | undefined
  ): Promise<{ adapterPath: string; tempDir: string }> => {
    const tempDir = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-runner-test-")
    );
    tempDirs.push(tempDir);
    const adapterPath = nodePath.join(tempDir, "adapter.json");
    const packetPath = nodePath.join(tempDir, "packet.json");
    const planPath = nodePath.join(tempDir, "plan.json");
    await writeFile(
      packetPath,
      JSON.stringify({
        conformancePlans:
          planCapability === undefined
            ? []
            : [
                {
                  path: planPath,
                  planId: "runner.state",
                  planVersion: "0.1.0",
                },
              ],
        packetId: "runner.state",
      })
    );
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
      planPath,
      JSON.stringify({
        applicability: { capabilities: [planCapability ?? "runner.state"] },
        checks: [
          {
            assertions: [
              { equals: "dispatch", field: "$.source", kind: "stateField" },
            ],
            checkId: "runner.state.unreachable",
            operation: "runner.state",
          },
        ],
        packetId: "runner.state",
        planId: "runner.state",
        planVersion: "0.1.0",
      })
    );
    return { adapterPath, tempDir };
  };

  const writeCertificationManifest = async (
    tempDir: string,
    adapterPath: string,
    certified: boolean
  ): Promise<string> => {
    const manifestPath = nodePath.join(tempDir, "certified-projects.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        certified: certified
          ? [{ profile: "runner.state", project: "zero-applicable-runner" }]
          : [],
        inventory: [
          {
            adapter: adapterPath,
            project: "zero-applicable-runner",
            state: certified ? "pass" : "unsupported",
          },
        ],
        projects: ["zero-applicable-runner"],
      })
    );
    return manifestPath;
  };

  test("reports unsupported, never pass, when every check needs a missing capability", async () => {
    const { adapterPath } =
      await writeZeroApplicableFixture("runner.unavailable");
    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, "runner output");
    expect(evidence.status).toBe("unsupported");
    expect(evidence.summary).toMatchObject({
      applicableChecks: 0,
      nonApplicableChecks: 1,
    });
  });

  test("reports not_applicable when the adapter's packets select no checks", async () => {
    const { adapterPath } = await writeZeroApplicableFixture(undefined);
    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
    ]);

    expect(result.code).toBe(0);
    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, "runner output");
    expect(evidence.status).toBe("not_applicable");
  });

  test("fails the run when a certified project selects zero applicable checks", async () => {
    const { adapterPath, tempDir } =
      await writeZeroApplicableFixture("runner.unavailable");
    const uncertifiedManifest = await writeCertificationManifest(
      tempDir,
      adapterPath,
      false
    );
    const uncertified = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--certification-manifest",
      uncertifiedManifest,
    ]);
    expect(uncertified.code).toBe(0);

    const certifiedManifest = await writeCertificationManifest(
      tempDir,
      adapterPath,
      true
    );
    const certified = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--certification-manifest",
      certifiedManifest,
      "--summary-only",
    ]);

    expect(certified.code).toBe(1);
    expect(certified.stderr).toContain(
      "zero-applicable-runner (profile runner.state) selected zero applicable checks"
    );
    expect(JSON.parse(certified.stdout)).toMatchObject({
      status: "unsupported",
    });
  });
});

describe("certification harness trace lifecycle", () => {
  test.each([false, true])(
    "preserves trace ordering and cleanup with protocol failure=%s",
    async (failEvents) => {
      const directory = await mkdtemp(
        nodePath.join(tmpdir(), "tuvren-trace-test-")
      );
      tempDirs.push(directory);
      const adapterPath = nodePath.join(directory, "adapter.json");
      const planPath = nodePath.join(directory, "plan.json");
      const packetPath = nodePath.join(directory, "packet.json");
      await writeFile(packetPath, JSON.stringify({ packetId: "trace" }));
      const logPath = nodePath.join(directory, "calls.jsonl");
      const evidencePath = nodePath.join(directory, "evidence.json");
      const script = `
      import { appendFile } from "node:fs/promises";
      for await (const line of console) {
        const request = JSON.parse(line);
        const params = request.params ?? {};
        await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ method: request.method, operation: params.operation, input: params.input, controls: params.controls }) + "\\n");
        let result = null;
        if (request.method === "initialize") result = { adapterId: "trace", capabilities: ["trace"], packetId: params.packetId, planVersion: params.planVersion };
        if (request.method === "createInstance") result = "instance";
        if (request.method === "dispatch") result = { kind: "result", value: { result: params.input.checkInput } };
        if (request.method === "events") result = [{ type: params.operation }];
        if (request.method === "inspectState") result = { phase: "inspected" };
        const error = ${failEvents} && request.method === "events" && params.operation === "second";
        process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", ...(error ? { error: { code: "native_transport", message: "events failed" } } : { result }) }) + "\\n");
      }
    `;
      await writeFile(
        adapterPath,
        JSON.stringify({
          adapterId: "trace",
          authorityPackets: [packetPath],
          boundary: "framework",
          capabilities: ["trace"],
          command: ["bun", "--eval", script],
          implementationId: "trace",
          language: "typescript",
          protocol: {
            name: "tuvren.conformance-adapter",
            transport: "json-rpc-2.0-stdio",
            version: "0.1.0",
          },
          suiteId: "trace",
          suiteVersion: "0.1.0",
        })
      );
      await writeFile(
        planPath,
        JSON.stringify({
          applicability: { capabilities: ["trace"] },
          checks: [
            {
              assertions: [
                {
                  equals: "seed",
                  field: "$.trace.second.result.value",
                  kind: "stateField",
                },
              ],
              checkId: "trace",
              controls: { deadlineMs: 500 },
              operation: "trace",
              steps: [
                {
                  assertions: [
                    {
                      equals: "inspected",
                      field: "$.phase",
                      kind: "stateField",
                    },
                  ],
                  input: { value: "seed" },
                  inspectState: {},
                  operation: "first",
                  stepId: "first",
                },
                {
                  controls: { cancelAfterEvent: "turn.end", deadlineMs: 1000 },
                  input: { value: "$.trace.first.result.value" },
                  inspectState: {},
                  operation: "second",
                  stepId: "second",
                },
              ],
            },
          ],
          packetId: "trace",
          planId: "trace",
          planVersion: "0.1.0",
        })
      );
      const result = await runCommand([
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapterPath,
        "--plan",
        planPath,
        "--evidence-out",
        evidencePath,
      ]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(failEvents ? 1 : 0);
      const evidence: unknown = JSON.parse(result.stdout);
      assertConformanceEvidence(evidence, "trace evidence");
      const persisted: unknown = JSON.parse(
        await readFile(evidencePath, "utf-8")
      );
      expect(persisted).toEqual(evidence);
      expect(evidence.summary.failedChecks).toBe(failEvents ? 1 : 0);
      const callLog = await readFile(logPath, "utf-8");
      const calls: unknown[] = callLog
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      expect(calls).toEqual([
        { method: "initialize" },
        { input: {}, method: "createInstance" },
        {
          controls: { deadlineMs: 500 },
          input: { checkInput: { value: "seed" } },
          method: "dispatch",
          operation: "first",
        },
        {
          controls: { deadlineMs: 500 },
          input: { checkInput: { value: "seed" } },
          method: "events",
          operation: "first",
        },
        { method: "inspectState" },
        {
          controls: { cancelAfterEvent: "turn.end", deadlineMs: 1000 },
          input: { checkInput: { value: "seed" } },
          method: "dispatch",
          operation: "second",
        },
        {
          controls: { cancelAfterEvent: "turn.end", deadlineMs: 1000 },
          input: { checkInput: { value: "seed" } },
          method: "events",
          operation: "second",
        },
        ...(failEvents ? [] : [{ method: "inspectState" }]),
        { method: "destroyInstance" },
        { method: "shutdown" },
      ]);
      if (failEvents) {
        expect(evidence.checkResults[0]?.details).toMatchObject({
          adapterError: { code: "native_transport", message: "events failed" },
        });
      }
    }
  );
});
