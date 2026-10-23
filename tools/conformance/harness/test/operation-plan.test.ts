import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

const host = new URL("../../adapter-protocol/stdio-host.ts", import.meta.url)
  .pathname;

test("plan start captures handles, await reads the native outcome, and cancel sends its reason", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "operation-plan-"));
  const planPath = path.join(directory, "plan.json");
  const packetPath = path.join(directory, "packet.json");
  const adapterPath = path.join(directory, "adapter.json");
  const evidencePath = path.join(directory, "evidence.json");
  const callsPath = path.join(directory, "calls.jsonl");
  const script = `
    import { appendFileSync } from "node:fs";
    import { serveStdioAdapter } from ${JSON.stringify(host)};
    const calls = ${JSON.stringify(callsPath)};
    const handles = new Map();
    await serveStdioAdapter({
      initialize: (packetId, planVersion) => ({ adapterId: "handles", capabilities: ["runner.handles"], packetId, planVersion }),
      createInstance: async () => "instance",
      dispatch: async () => { throw new Error("unexpected blocking dispatch"); },
      startOperation: async (operation, args, instance) => {
        appendFileSync(calls, JSON.stringify({ method: "start", operation, args, instance }) + "\\n");
        const operationHandle = "handle-" + handles.size;
        handles.set(operationHandle, { kind: "result", value: { result: args } });
        return { operationHandle };
      },
      awaitOperation: async operationHandle => {
        appendFileSync(calls, JSON.stringify({ method: "await", operationHandle }) + "\\n");
        return handles.get(operationHandle);
      },
      cancelOperation: async (operationHandle, reason) => {
        appendFileSync(calls, JSON.stringify({ method: "cancel", operationHandle, reason }) + "\\n");
      },
      events: async () => { throw new Error("unexpected batch events call"); }
    });`;
  try {
    await writeFile(
      packetPath,
      JSON.stringify({
        conformancePlans: [
          { path: planPath, planId: "runner.handles", planVersion: "0.1.0" },
        ],
        packetId: "runner.handles",
      })
    );
    await writeFile(
      adapterPath,
      JSON.stringify({
        adapterId: "handles",
        authorityPackets: [packetPath],
        boundary: "framework",
        capabilities: ["runner.handles"],
        command: ["bun", "--eval", script],
        implementationId: "handles",
        language: "typescript",
        protocol: {
          name: "tuvren.conformance-adapter",
          transport: "json-rpc-2.0-stdio",
          version: "0.2.0",
        },
        suiteId: "runner.handles",
        suiteVersion: "0.1.0",
      })
    );
    await writeFile(
      planPath,
      JSON.stringify({
        applicability: { capabilities: ["runner.handles"] },
        checks: [
          {
            assertions: [
              {
                kind: "resultField",
                field: "$.trace.done.result.value",
                equals: 42,
              },
            ],
            checkId: "handles",
            evidence: ["result"],
            operation: "probe",
            steps: [
              {
                stepId: "first",
                action: "start",
                operation: "probe",
                arguments: { value: 42 },
                capture: [{ name: "first", path: "result" }],
              },
              {
                stepId: "second",
                action: "start",
                operation: "probe",
                arguments: { value: 99 },
                capture: [{ name: "second", path: "result.operationHandle" }],
              },
              {
                stepId: "cancel",
                action: "cancel",
                operation: "probe",
                arguments: {
                  operationHandle: { $ref: "capture.second" },
                  reason: "requested",
                },
              },
              {
                stepId: "done",
                action: "await",
                operation: "probe",
                arguments: {
                  operationHandle: { $ref: "capture.first.operationHandle" },
                },
              },
              {
                stepId: "other",
                action: "await",
                operation: "probe",
                arguments: { operationHandle: { $ref: "capture.second" } },
              },
            ],
          },
        ],
        fixtures: {},
        packetId: "runner.handles",
        planId: "runner.handles",
        planVersion: "0.1.0",
      })
    );
    const child = spawn(
      [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapterPath,
        "--summary-only",
        "--evidence-out",
        evidencePath,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr, stdout }).toMatchObject({ exit: 0 });
    const evidence: unknown = JSON.parse(await readFile(evidencePath, "utf-8"));
    expect(evidence).toMatchObject({
      status: "pass",
      summary: { passedChecks: 1 },
    });
    const callsText = await readFile(callsPath, "utf-8");
    const calls = callsText
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(calls).toEqual([
      {
        args: { value: 42 },
        instance: "instance",
        method: "start",
        operation: "probe",
      },
      {
        args: { value: 99 },
        instance: "instance",
        method: "start",
        operation: "probe",
      },
      { method: "cancel", operationHandle: "handle-1", reason: "requested" },
      { method: "await", operationHandle: "handle-0" },
      { method: "await", operationHandle: "handle-1" },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
