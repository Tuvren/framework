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

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";
import type { ConformanceFailure } from "../../../scripts/lib/conformance-contract.ts";
import type { ConformancePlanStep } from "../../plan-compiler/index.ts";
import { readAdapterManifest, readPlans } from "../run-plans.ts";
import {
  createProjectionProbeAdapterScript,
  errorStateAdapterScript,
  failureProbeAdapterScript,
  statePrecedenceAdapterScript,
} from "./run-adapters-fixture.ts";

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../../..");
const FAILURE_ARTIFACT_NOTICE = "conformance failure artifacts retained at ";
let verifyLogRoot = "";

beforeAll(async () => {
  verifyLogRoot = await mkdtemp(nodePath.join(tmpdir(), "tuvren-runner-logs-"));
});

afterAll(async () => {
  if (verifyLogRoot.length > 0) {
    await rm(verifyLogRoot, { force: true, recursive: true });
  }
});

const runCommand = async (
  command: readonly string[]
): Promise<CommandResult> => {
  const [executable, ...args] = command;

  if (executable === undefined) {
    throw new Error("command must not be empty");
  }

  const child = spawn(executable, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, VERIFY_LOG_DIR: verifyLogRoot },
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

  test.each([false, true])(
    "keeps dispatch state when inspectState also returns state (trace=%s)",
    async (trace) => {
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
                ...(trace
                  ? {
                      steps: [
                        {
                          stepId: "read",
                          operation: "runner.state",
                          inspectState: {},
                          assertions: [
                            {
                              kind: "stateField",
                              field: "$.source",
                              equals: "dispatch",
                            },
                          ],
                        },
                      ],
                      assertions: [
                        {
                          kind: "stateField",
                          field: "$.trace.read.state.source",
                          equals: "dispatch",
                        },
                      ],
                    }
                  : {}),
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
      expect(
        invalidEvidence.checkResults[0]?.assertionResults[0]?.message
      ).toBe("operation context field must be an object when present");
    }
  );

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
      if (failEvents) {
        expect(result.stderr).toContain(FAILURE_ARTIFACT_NOTICE);
      } else {
        expect(result.stderr).toBe("");
      }
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
        expect(evidence.checkResults[0]?.failure).toMatchObject({
          arguments: [
            { input: { checkInput: { value: "seed" } }, operation: "first" },
            { input: { checkInput: { value: "seed" } }, operation: "second" },
          ],
          classification: "adapter_protocol",
        });
      }
    }
  );
});

describe("certification harness explicit arguments and captures", () => {
  const EXPECTED_SENTINEL = "EXPECTED-ONLY-SENTINEL";
  const DEFAULT_PROJECTION_FIXTURE = {
    expected: { requestId: "req-1", secret: EXPECTED_SENTINEL },
    input: { request: { id: "req-1", nested: [10, 20] } },
  };

  const writeProjectionFixture = async (
    checks: readonly unknown[],
    fixture: unknown = DEFAULT_PROJECTION_FIXTURE
  ): Promise<{ adapterPath: string; logPath: string; planPath: string }> => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-projection-test-")
    );
    tempDirs.push(directory);
    const adapterPath = nodePath.join(directory, "adapter.json");
    const packetPath = nodePath.join(directory, "packet.json");
    const planPath = nodePath.join(directory, "plan.json");
    const fixturePath = nodePath.join(directory, "fixture.json");
    const logPath = nodePath.join(directory, "frames.jsonl");
    await writeFile(packetPath, JSON.stringify({ packetId: "projection" }));
    await writeFile(fixturePath, JSON.stringify(fixture));
    await writeFile(
      adapterPath,
      JSON.stringify({
        adapterId: "projection-probe",
        authorityPackets: [packetPath],
        boundary: "framework",
        capabilities: ["projection"],
        command: ["bun", "--eval", createProjectionProbeAdapterScript(logPath)],
        implementationId: "projection-probe",
        language: "typescript",
        protocol: {
          name: "tuvren.conformance-adapter",
          transport: "json-rpc-2.0-stdio",
          version: "0.1.0",
        },
        suiteId: "projection",
        suiteVersion: "0.1.0",
      })
    );
    await writeFile(
      planPath,
      JSON.stringify({
        applicability: { capabilities: ["projection"] },
        checks,
        fixtures: { case: "./fixture.json" },
        packetId: "projection",
        planId: "projection",
        planVersion: "0.1.0",
      })
    );
    return { adapterPath, logPath, planPath };
  };

  const runProjection = async (
    adapterPath: string,
    planPath: string
  ): Promise<CommandResult> =>
    await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
    ]);

  const readFrames = async (
    logPath: string
  ): Promise<{ method: string; params: Record<string, unknown> }[]> => {
    const text = await readFile(logPath, "utf-8");
    return text
      .trim()
      .split("\n")
      .map((line) => {
        const frame = JSON.parse(line) as {
          method: string;
          params?: Record<string, unknown>;
        };
        return { method: frame.method, params: frame.params ?? {} };
      });
  };

  const projectedCheck = {
    assertions: [
      {
        equalsPath: "$.capture.token",
        field: "$.trace.second.result.received.token",
        kind: "stateField",
      },
      {
        equals: "token-open",
        field: "$.trace.second.result.received.token",
        kind: "stateField",
      },
      {
        equalsPath: "$.fixture.expected.requestId",
        field: "$.trace.first.result.received.request.id",
        kind: "stateField",
      },
    ],
    checkId: "projection.capture",
    fixture: "case",
    input: { mode: "strict" },
    operation: "projection",
    steps: [
      {
        arguments: {
          constant: 7,
          escaped: { $literal: { $ref: "input.mode" } },
          list: [{ $ref: "fixture.input.request.nested.1" }, "x"],
          mode: { $ref: "input.mode" },
          request: { $ref: "fixture.input.request" },
        },
        capture: [{ name: "token", path: "result.token" }],
        operation: "open",
        stepId: "first",
      },
      {
        arguments: { token: { $ref: "capture.token" } },
        assertions: [
          {
            equalsPath: "$.capture.token",
            field: "$.received.token",
            kind: "resultField",
          },
        ],
        operation: "use",
        stepId: "second",
      },
    ],
  };

  test.each<{ steps: ConformancePlanStep[] | undefined }>([
    { steps: undefined },
    { steps: [] },
  ])(
    "rejects stepless fault arming in report mode before dispatch: %j",
    async ({ steps }) => {
      const { adapterPath, logPath, planPath } = await writeProjectionFixture([
        {
          assertions: [
            {
              equals: "token-projection.arm",
              field: "$.token",
              kind: "resultField",
            },
          ],
          checkId: "projection.stepless-fault",
          operation: "projection.arm",
          steps,
        },
      ]);
      const directory = nodePath.dirname(planPath);
      const catalogPath = nodePath.join(directory, "operations.json");
      await writeFile(
        catalogPath,
        JSON.stringify({
          catalogId: "projection.operations",
          catalogVersion: "0.1.0",
          operations: [
            {
              capability: "projection",
              errors: ["unsupported"],
              faultOutcome: {
                code: "interrupted",
                unsupportedCode: "unsupported",
              },
              input: true,
              kind: "control",
              observation: {
                events: { type: "array", items: { type: "null" } },
                result: {
                  additionalProperties: false,
                  properties: {
                    received: {
                      additionalProperties: false,
                      type: "object",
                    },
                    token: { type: "string" },
                  },
                  type: "object",
                },
                state: { type: "null" },
              },
              operationId: "projection.arm",
            },
          ],
          packetId: "projection",
        })
      );
      await writeFile(
        nodePath.join(directory, "packet.json"),
        JSON.stringify({
          operationCatalog: catalogPath,
          packetId: "projection",
        })
      );

      const result = await runProjection(adapterPath, planPath);

      expect(result.stdout, result.stderr).not.toBe("");
      expect(result.code).toBe(1);
      const evidence: unknown = JSON.parse(result.stdout);
      assertConformanceEvidence(evidence, "stepless fault evidence");
      const [checkResult] = evidence.checkResults;
      expect(checkResult?.status).toBe("fail");
      expect(checkResult?.details).toMatchObject({
        verificationError: "fault arming requires an armFault trace step",
      });
      expect(checkResult?.failure?.classification).toBe("verification");
      expect(checkResult?.details).not.toHaveProperty("adapterError");
      const frames = await readFrames(logPath);
      expect(frames.map((frame) => frame.method)).toEqual([
        "initialize",
        "shutdown",
      ]);
    }
  );

  test("sends only the resolved projection and threads captures into later steps and final assertions", async () => {
    const { adapterPath, logPath, planPath } = await writeProjectionFixture([
      projectedCheck,
    ]);
    const result = await runProjection(adapterPath, planPath);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, "projection evidence");
    expect(evidence.status).toBe("pass");
    expect(
      evidence.checkResults[0]?.assertionResults
        .map((entry) => entry.assertionId)
        .filter((id) => !id.includes(".requiredEvidence."))
    ).toEqual([
      "projection.capture.second.1.resultField",
      "projection.capture.1.stateField",
      "projection.capture.2.stateField",
      "projection.capture.3.stateField",
    ]);

    const frames = await readFrames(logPath);
    const firstProjection = {
      constant: 7,
      escaped: { $ref: "input.mode" },
      list: [20, "x"],
      mode: "strict",
      request: { id: "req-1", nested: [10, 20] },
    };
    expect(
      frames
        .filter(
          (frame) => frame.method === "dispatch" || frame.method === "events"
        )
        .map((frame) => [
          frame.method,
          frame.params.operation,
          frame.params.input,
        ])
    ).toEqual([
      ["dispatch", "open", firstProjection],
      ["events", "open", firstProjection],
      ["dispatch", "use", { token: "token-open" }],
      ["events", "use", { token: "token-open" }],
    ]);
  });

  test("never lets the adapter observe expected values or whole fixtures", async () => {
    const { adapterPath, logPath, planPath } = await writeProjectionFixture([
      projectedCheck,
    ]);
    const result = await runProjection(adapterPath, planPath);

    expect(result.code).toBe(0);
    const rawFrames = await readFile(logPath, "utf-8");
    expect(rawFrames).not.toContain(EXPECTED_SENTINEL);
    expect(rawFrames).not.toContain('"expected"');
    const frames = await readFrames(logPath);
    expect(frames.map((frame) => frame.method)).toEqual([
      "initialize",
      "createInstance",
      "dispatch",
      "events",
      "dispatch",
      "events",
      "destroyInstance",
      "shutdown",
    ]);
    for (const frame of frames) {
      expect(JSON.stringify(frame.params)).not.toContain('"fixture"');
    }
  });

  test.each([
    { reference: "fixture.input.absent", label: "missing fixture input" },
    { reference: "capture.never", label: "undefined capture" },
    { reference: "input.mode.deeper", label: "path through a scalar" },
    { reference: "input.constructor", label: "inherited property" },
  ])(
    "fails the check when a reference does not resolve ($label)",
    async ({ reference }) => {
      const { adapterPath, logPath, planPath } = await writeProjectionFixture([
        {
          assertions: [
            {
              equals: "token-open",
              field: "$.trace.first.result.token",
              kind: "stateField",
            },
          ],
          checkId: "projection.unresolved",
          fixture: "case",
          input: { mode: "strict" },
          operation: "projection",
          steps: [
            {
              arguments: { value: { $ref: reference } },
              operation: "open",
              stepId: "first",
            },
          ],
        },
      ]);
      const result = await runProjection(adapterPath, planPath);

      expect(result.code).toBe(1);
      const evidence: unknown = JSON.parse(result.stdout);
      assertConformanceEvidence(evidence, "unresolved evidence");
      const [checkResult] = evidence.checkResults;
      expect(checkResult?.status).toBe("fail");
      expect(checkResult?.assertionResults[0]?.message).toContain(
        `$ref ${reference} did not resolve`
      );
      expect(checkResult?.details).toMatchObject({
        verificationError: expect.stringContaining(reference),
      });
      expect(checkResult?.failure?.classification).toBe("verification");
      expect(checkResult?.details).not.toHaveProperty("adapterError");
      const frames = await readFrames(logPath);
      expect(frames.map((frame) => frame.method)).not.toContain("dispatch");
      expect(frames.map((frame) => frame.method)).toContain("destroyInstance");
    }
  );

  test("rejects a $ref into fixture.expected at compile time", async () => {
    const { adapterPath, planPath } = await writeProjectionFixture([
      {
        assertions: [{ field: "$.trace", kind: "stateField", present: true }],
        checkId: "projection.expected-ref",
        fixture: "case",
        operation: "projection",
        steps: [
          {
            arguments: { value: { $ref: "fixture.expected.secret" } },
            operation: "open",
            stepId: "first",
          },
        ],
      },
    ]);
    const result = await runProjection(adapterPath, planPath);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed JSON Schema validation");
  });

  test.each([
    { input: { fixturePath: "$.expected" }, selector: "fixturePath" },
    { input: { scenarioPath: "$.expected" }, selector: "scenarioPath" },
  ])(
    "rejects the legacy $selector selector for checks with step arguments",
    async ({ input, selector }) => {
      const { adapterPath, logPath, planPath } = await writeProjectionFixture(
        [
          {
            assertions: [
              { field: "$.trace", kind: "stateField", present: true },
            ],
            checkId: "projection.selector",
            fixture: "case",
            input,
            operation: "projection",
            steps: [
              {
                arguments: { value: { $ref: "fixture.input.value" } },
                operation: "open",
                stepId: "first",
              },
            ],
          },
        ],
        { expected: { input: { value: EXPECTED_SENTINEL } }, input: {} }
      );
      const result = await runProjection(adapterPath, planPath);

      expect(result.code).toBe(1);
      const evidence: unknown = JSON.parse(result.stdout);
      assertConformanceEvidence(evidence, "selector evidence");
      const [checkResult] = evidence.checkResults;
      expect(checkResult?.status).toBe("fail");
      expect(checkResult?.details).toMatchObject({
        verificationError: expect.stringContaining(selector),
      });
      expect(checkResult?.details).not.toHaveProperty("adapterError");
      const rawFrames = await readFile(logPath, "utf-8");
      expect(rawFrames).not.toContain(EXPECTED_SENTINEL);
      const frames = await readFrames(logPath);
      expect(frames.map((frame) => frame.method)).not.toContain("dispatch");
    }
  );

  test("captures an empty events array from a step observation", async () => {
    const { adapterPath, logPath, planPath } = await writeProjectionFixture([
      {
        assertions: [{ field: "$.trace", kind: "stateField", present: true }],
        checkId: "projection.empty-events",
        fixture: "case",
        input: { mode: "strict" },
        operation: "projection",
        steps: [
          {
            arguments: { mode: { $ref: "input.mode" } },
            capture: [{ name: "seen", path: "events" }],
            operation: "open",
            stepId: "first",
          },
          {
            arguments: { seen: { $ref: "capture.seen" } },
            operation: "use",
            stepId: "second",
          },
        ],
      },
    ]);
    const result = await runProjection(adapterPath, planPath);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const frames = await readFrames(logPath);
    expect(
      frames
        .filter((frame) => frame.method === "dispatch")
        .map((frame) => frame.params.input)
    ).toEqual([{ mode: "strict" }, { seen: [] }]);
  });

  test("keeps whole-fixture forwarding for legacy steps without arguments", async () => {
    const { adapterPath, logPath, planPath } = await writeProjectionFixture([
      {
        assertions: [
          {
            equalsPath: "$.fixture.expected.requestId",
            field: "$.trace.first.result.received.fixture.input.request.id",
            kind: "stateField",
          },
        ],
        checkId: "projection.legacy",
        fixture: "case",
        input: { mode: "strict" },
        operation: "projection",
        steps: [{ operation: "open", stepId: "first" }],
      },
    ]);
    const result = await runProjection(adapterPath, planPath);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const frames = await readFrames(logPath);
    const legacyInput = {
      checkInput: { mode: "strict" },
      fixture: {
        expected: { requestId: "req-1", secret: EXPECTED_SENTINEL },
        input: { request: { id: "req-1", nested: [10, 20] } },
      },
    };
    expect(
      frames
        .filter((frame) =>
          ["createInstance", "dispatch", "events"].includes(frame.method)
        )
        .map((frame) => frame.params.input)
    ).toEqual([legacyInput, legacyInput, legacyInput]);
  });
});

describe("certification harness failure artifacts", () => {
  const writeFailureProbe = async (): Promise<{
    adapterPath: string;
    planPath: string;
  }> => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-failure-test-")
    );
    tempDirs.push(directory);
    const adapterPath = nodePath.join(directory, "adapter.json");
    const packetPath = nodePath.join(directory, "packet.json");
    const planPath = nodePath.join(directory, "plan.json");
    await writeFile(packetPath, JSON.stringify({ packetId: "failure" }));
    await writeFile(
      adapterPath,
      JSON.stringify({
        adapterId: "failure-probe",
        authorityPackets: [packetPath],
        boundary: "framework",
        capabilities: ["failure"],
        command: ["bun", "--eval", failureProbeAdapterScript],
        implementationId: "failure-probe",
        language: "typescript",
        protocol: {
          name: "tuvren.conformance-adapter",
          transport: "json-rpc-2.0-stdio",
          version: "0.1.0",
        },
        suiteId: "failure",
        suiteVersion: "0.1.0",
      })
    );
    await writeFile(
      planPath,
      JSON.stringify({
        applicability: { capabilities: ["failure"] },
        checks: [
          {
            assertions: [
              { equals: "observed", field: "$.status", kind: "resultField" },
            ],
            checkId: "failure.malformed-frame",
            input: { request: "malformed" },
            operation: "malformed",
          },
          {
            assertions: [
              {
                equalsPath: "$.input.expectedStatus",
                field: "$.status",
                kind: "resultField",
              },
            ],
            checkId: "failure.unresolved-operand",
            input: { request: "observe" },
            operation: "observe",
          },
          {
            assertions: [
              {
                equals: "expected-status",
                field: "$.status",
                kind: "resultField",
              },
            ],
            checkId: "failure.assertion",
            input: { request: "observe" },
            operation: "observe",
          },
          {
            assertions: [
              {
                equals: "expected-status",
                field: "$.status",
                kind: "resultField",
              },
            ],
            checkId: "failure.transcript",
            input: { request: "transcript" },
            operation: "transcript",
          },
          {
            assertions: [
              { equals: "observed", field: "$.status", kind: "resultField" },
            ],
            checkId: "failure.provisioning",
            input: { request: "provision" },
            operation: "provision",
          },
        ],
        packetId: "failure",
        planId: "failure",
        planVersion: "0.1.0",
      })
    );
    return { adapterPath, planPath };
  };

  type FailureView = ConformanceFailure;

  const readSingleFailure = (
    result: CommandResult,
    label: string
  ): { checkId: string; failure: FailureView } => {
    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, label);
    expect(evidence.checkResults).toHaveLength(1);
    const [checkResult] = evidence.checkResults;
    expect(checkResult?.status).toBe("fail");
    const failure = checkResult?.failure;
    if (failure === undefined) {
      throw new Error(`${label} carries no failure artifact`);
    }
    return { checkId: checkResult?.checkId ?? "", failure };
  };

  test.each([
    {
      checkId: "failure.malformed-frame",
      classification: "adapter_protocol",
      inspect: (failure: FailureView): void => {
        expect(JSON.stringify(failure.frameLog)).toContain(
          "{not a json-rpc frame"
        );
        expect(failure.frameLog?.[0]).toMatchObject({
          direction: "send",
        });
      },
    },
    {
      checkId: "failure.unresolved-operand",
      classification: "verification",
      inspect: (failure: FailureView): void => {
        expect(failure.operands).toContainEqual({
          actual: "observed",
          expectedSource: "equalsPath: plan input $.input.expectedStatus",
          path: "$.result.status",
        });
      },
    },
    {
      checkId: "failure.assertion",
      classification: "implementation",
      inspect: (failure: FailureView): void => {
        expect(failure.operands).toEqual([
          {
            actual: "observed",
            expected: "expected-status",
            expectedSource: "equals: plan literal",
            path: "$.result.status",
          },
        ]);
        expect(failure.arguments).toEqual([
          {
            input: { checkInput: { request: "observe" } },
            operation: "observe",
          },
        ]);
        expect(failure.observation).toMatchObject([
          {
            operation: "observe",
            outcome: {
              kind: "result",
              value: { result: { status: "observed" } },
            },
          },
        ]);
        expect(failure.exit).toBeUndefined();
      },
    },
    {
      checkId: "failure.provisioning",
      classification: "environment",
      inspect: (failure: FailureView): void => {
        expect(failure.exit).toEqual({ code: 3, signal: null });
        expect(failure.stderrTail).toContain("ECONNREFUSED 127.0.0.1:5432");
      },
    },
  ])(
    "classifies $checkId as $classification with a replay that reproduces it",
    async ({ checkId, classification, inspect }) => {
      const { adapterPath, planPath } = await writeFailureProbe();
      const result = await runCommand([
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapterPath,
        "--plan",
        planPath,
        "--check",
        checkId,
      ]);

      expect(result.code).toBe(1);
      const first = readSingleFailure(result, "failure evidence");
      expect(first.checkId).toBe(checkId);
      expect(first.failure.classification).toBe(classification);
      inspect(first.failure);
      const { replay } = first.failure;
      expect(replay).toContain(
        "bun tools/conformance/harness/run.ts --adapter"
      );
      expect(replay).toContain(`--check ${checkId}`);

      const replayed = await runCommand(["sh", "-c", replay ?? "false"]);
      expect(replayed.code).toBe(1);
      const second = readSingleFailure(replayed, "replayed evidence");
      expect(second.checkId).toBe(checkId);
      expect(second.failure.classification).toBe(classification);
      expect(second.failure.replay).toBe(replay);
    }
  );

  test("retains the full failing evidence in the run log directory", async () => {
    const { adapterPath, planPath } = await writeFailureProbe();
    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
      "--check",
      "failure.assertion",
      "--summary-only",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('"classification"');
    const notice = result.stderr
      .split("\n")
      .find((line) => line.startsWith(FAILURE_ARTIFACT_NOTICE));
    expect(notice).toBeDefined();
    const artifactPath = (notice ?? "").slice(FAILURE_ARTIFACT_NOTICE.length);
    expect(artifactPath.startsWith(`${verifyLogRoot}${nodePath.sep}`)).toBe(
      true
    );
    const retained: unknown = JSON.parse(await readFile(artifactPath, "utf-8"));
    assertConformanceEvidence(retained, "retained evidence");
    expect(retained.checkResults[0]?.failure).toMatchObject({
      classification: "implementation",
      observation: [{ outcome: { kind: "result" } }],
    });
  });

  test("retains the complete frame transcript and bounds only the in-band preview", async () => {
    const { adapterPath, planPath } = await writeFailureProbe();
    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
      "--check",
      "failure.transcript",
    ]);

    expect(result.code).toBe(1);
    const noise = "n".repeat(5000);
    const inBand = readSingleFailure(result, "in-band evidence").failure;
    expect(inBand.frameLog?.length).toBeLessThanOrEqual(257);
    expect(JSON.stringify(inBand.frameLog)).not.toContain(noise);

    const notice = result.stderr
      .split("\n")
      .find((line) => line.startsWith(FAILURE_ARTIFACT_NOTICE));
    const artifactPath = (notice ?? "").slice(FAILURE_ARTIFACT_NOTICE.length);
    const retained: unknown = JSON.parse(await readFile(artifactPath, "utf-8"));
    assertConformanceEvidence(retained, "retained evidence");
    const frameLog = retained.checkResults[0]?.failure?.frameLog ?? [];
    const noiseFrames = frameLog.filter((entry) =>
      JSON.stringify(entry).includes(noise)
    );
    expect(noiseFrames).toHaveLength(300);
    expect(JSON.stringify(frameLog)).not.toContain("more chars]");
    expect(frameLog.at(-1)).toMatchObject({ direction: "receive" });
  });

  test("passing runs write no failure artifacts", async () => {
    const { adapterPath, planPath } = await writeFailureProbe();
    const planText = await readFile(planPath, "utf-8");
    await writeFile(
      planPath,
      planText.replace('"expected-status"', '"observed"')
    );
    const result = await runCommand([
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapterPath,
      "--plan",
      planPath,
      "--check",
      "failure.assertion",
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const evidence: unknown = JSON.parse(result.stdout);
    assertConformanceEvidence(evidence, "passing evidence");
    expect(evidence.checkResults[0]).not.toHaveProperty("failure");
  });
});

describe("native operation errors", () => {
  test.each([
    ["native_expected", "step", true],
    ["native_expected", "final", true],
    ["native_expected", "none", false],
    ["native_expected", "envelope", true],
    ["native_expected", "final-envelope", true],
    ["native_expected", "capture", true],
    ["native_expected", "single", true],
    ["native_expected", "single-none", false],
    ["native_expected", "uncatalogued", true],
    ["native_expected", "evidence", false],
    ["native_unlisted", "step", false],
    ["native_unlisted", "single", false],
  ] as const)(
    "grades %s with %s assertions",
    async (code, assertionLocation, accepted) => {
      const dir = await mkdtemp(
        nodePath.join(tmpdir(), "tuvren-native-error-")
      );
      tempDirs.push(dir);
      const catalogPath = nodePath.join(dir, "operations.json");
      const packetPath = nodePath.join(dir, "packet.json");
      const planPath = nodePath.join(dir, "plan.json");
      const adapterPath = nodePath.join(dir, "adapter.json");
      const errorAssertion = {
        kind: "stateField",
        field: "$.adapterError.code",
        equals: code,
      };
      const catalog = {
        catalogId: "probe.errors",
        catalogVersion: "0.1.0",
        packetId: "probe.native-errors",
        operations: [
          {
            operationId: "probe.read",
            binding: "probe.read",
            kind: "syscall",
            capability: "probe",
            input: {},
            errors: ["native_expected"],
            observation: {
              result:
                assertionLocation === "capture"
                  ? { type: "string" }
                  : { type: "null" },
              state: {
                type: "object",
                properties: { source: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        ],
      };
      await writeFile(catalogPath, JSON.stringify(catalog));
      await writeFile(
        packetPath,
        JSON.stringify({
          packetId: "probe.native-errors",
          ...(assertionLocation === "uncatalogued"
            ? {}
            : { operationCatalog: catalogPath }),
          conformancePlans: [
            { path: planPath, planId: "native-errors", planVersion: "0.1.0" },
          ],
        })
      );
      const traceCheck = {
        checkId: "probe.errors",
        operation: "probe.read",
        assertions: [
          {
            kind: "resultField",
            field: "$.trace.success.result",
            equals: assertionLocation === "capture" ? code : null,
          },
          ...(["final", "final-envelope", "capture"].includes(assertionLocation)
            ? [
                {
                  ...(assertionLocation === "final-envelope"
                    ? {
                        kind: "errorEnvelope",
                        path: "$.result.trace.reject.state.adapterError",
                        equals: { code, message: "native failure" },
                      }
                    : {
                        ...errorAssertion,
                        field: "$.trace.reject.state.adapterError.code",
                      }),
                  ...(assertionLocation === "capture"
                    ? {
                        field: "$.trace.success.result",
                        equals: undefined,
                        equalsPath: "$.capture.errorCode",
                      }
                    : {}),
                },
              ]
            : []),
        ],
        steps: [
          {
            stepId: "reject",
            operation: "probe.read",
            arguments: { reject: true },
            ...(assertionLocation === "capture"
              ? {
                  capture: [
                    { name: "errorCode", path: "state.adapterError.code" },
                  ],
                }
              : {}),
            ...(["step", "envelope"].includes(assertionLocation)
              ? {
                  assertions: [
                    assertionLocation === "envelope"
                      ? {
                          kind: "errorEnvelope",
                          path: "$.state.adapterError",
                          equals: { code, message: "native failure" },
                        }
                      : errorAssertion,
                  ],
                }
              : {}),
          },
          { stepId: "success", operation: "probe.read", arguments: {} },
        ],
      };
      await writeFile(
        planPath,
        JSON.stringify({
          applicability: { capabilities: ["probe"] },
          planId: "native-errors",
          packetId: "probe.native-errors",
          planVersion: "0.1.0",
          checks: [
            assertionLocation.startsWith("single")
              ? {
                  checkId: "probe.errors",
                  operation: "probe.read",
                  input: { reject: true },
                  assertions:
                    assertionLocation === "single-none"
                      ? [
                          {
                            kind: "stateField",
                            field: "$.source",
                            equals: "inspect",
                          },
                        ]
                      : [errorAssertion],
                }
              : traceCheck,
          ],
        })
      );
      const host = `for await (const line of console) {
      const request = JSON.parse(line);
      const params = request.params ?? {};
      const input = params.input?.checkInput ?? params.input;
      const result = request.method === "initialize" ? { adapterId: "probe", capabilities: ["probe"], packetId: params.packetId, planVersion: params.planVersion }
        : request.method === "dispatch" ? (${JSON.stringify(assertionLocation === "evidence")} ? { kind: "result", value: { result: null, evidence: { unchecked: "claim" } } } : input?.reject ? { kind: "error", error: { code: ${JSON.stringify(code)}, message: "native failure" } } : { kind: "result", value: { result: ${JSON.stringify(assertionLocation === "capture" ? code : null)} } })
        : request.method === "events" ? [] : request.method === "createInstance" ? "instance" : request.method === "inspectState" ? { source: "inspect" } : null;
      process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", result }) + "\\n");
    }`;
      await writeFile(
        adapterPath,
        JSON.stringify({
          adapterId: "probe",
          authorityPackets: [packetPath],
          boundary: "shared",
          capabilities: ["probe"],
          command: ["bun", "--eval", host],
          implementationId: "probe",
          language: "typescript",
          protocol: {
            name: "tuvren.conformance-adapter",
            transport: "json-rpc-2.0-stdio",
            version: "0.2.0",
          },
          suiteId: "probe",
          suiteVersion: "0.1.0",
        })
      );
      const result = await runCommand([
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapterPath,
      ]);
      expect(result.stdout, result.stderr).not.toBe("");
      const evidence: unknown = JSON.parse(result.stdout);
      assertConformanceEvidence(evidence, "native error evidence");
      expect(result.code).toBe(accepted ? 0 : 1);
      expect(evidence.checkResults[0]).toMatchObject(
        accepted
          ? { status: "pass" }
          : {
              status: "fail",
              failure: {
                classification:
                  assertionLocation === "evidence"
                    ? "adapter_protocol"
                    : "implementation",
              },
            }
      );
    }
  );
});

test.each(["explicit", "syscall", "arguments"])(
  "rejects a %s enforcing plan without its packet catalog",
  async (mode) => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "tuvren-missing-catalog-")
    );
    tempDirs.push(directory);
    const planPath = nodePath.join(directory, "plan.json");
    await writeFile(
      planPath,
      JSON.stringify({
        planId: "missing-catalog",
        packetId:
          mode === "arguments" ? "tuvren.kernel.protocol" : "missing.packet",
        planVersion: "0.1.0",
        ...(mode === "explicit" ? { certificationRules: "enforcing" } : {}),
        applicability: {
          capabilities: [mode === "syscall" ? "kernel.syscall" : "probe"],
        },
        checks: [
          {
            checkId: "missing.catalog",
            operation: mode === "arguments" ? "kernel.store.has" : "probe",
            ...(mode === "arguments"
              ? {
                  steps: [
                    {
                      stepId: "read",
                      operation: "kernel.store.has",
                      arguments: { hash: "0".repeat(64) },
                    },
                  ],
                }
              : {}),
            assertions: [{ kind: "resultField", field: "$", equals: "ok" }],
          },
        ],
      })
    );
    const manifest = await readAdapterManifest(
      "typescript/kernel/conformance-adapter/adapter.json"
    );
    const [failure] = await Promise.allSettled([
      readPlans(
        { ...manifest, authorityPackets: [] },
        { packets: [], plans: [planPath] }
      ),
    ]);
    expect(failure?.status).toBe("rejected");
    if (failure?.status === "rejected") {
      expect(failure.reason).toBeInstanceOf(Error);
      if (failure.reason instanceof Error) {
        expect(failure.reason.message).toContain(
          `verification: enforcing plan missing-catalog requires the operation catalog for packet ${mode === "arguments" ? "tuvren.kernel.protocol" : "missing.packet"}`
        );
      }
    }
  }
);
