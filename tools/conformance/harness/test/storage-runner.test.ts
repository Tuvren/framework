import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

test("the runner isolates checks and removes storage after a failed assertion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-resource-test-"));
  const log = path.join(directory, "references.txt");
  const packet = path.join(directory, "packet.json");
  const plan = path.join(directory, "plan.json");
  const adapter = path.join(directory, "adapter.json");
  const script = `
    import { appendFileSync } from "node:fs";
    for await (const line of console) {
      const request = JSON.parse(line);
      const params = request.params ?? {};
      if (request.method === "createInstance") appendFileSync(${JSON.stringify(log)}, params.storageRef + "\\n");
      const result = request.method === "initialize" ? {
        adapterId: "storage-probe", capabilities: ["probe"], packetId: params.packetId,
        planVersion: params.planVersion, protocolVersion: "0.2.0", storageKinds: ["sqlite-directory"]
      } : request.method === "createInstance" ? "instance"
        : request.method === "dispatch" ? { kind: "result", value: { result: { value: "ok" } } }
        : request.method === "events" ? [] : null;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    }
  `;
  const manifest = {
    adapterId: "storage-probe",
    implementationId: "storage-probe",
    language: "typescript",
    boundary: "shared",
    command: ["bun", "--eval", script],
    capabilities: ["probe"],
    authorityPackets: [packet],
    protocol: {
      name: "tuvren.conformance-adapter",
      version: "0.2.0",
      transport: "json-rpc-2.0-stdio",
    },
    storage: "sqlite-directory",
    suiteId: "storage.probe",
    suiteVersion: "0.1.0",
  };
  try {
    await writeFile(packet, JSON.stringify({ packetId: "storage.probe" }));
    await writeFile(
      plan,
      JSON.stringify({
        planId: "storage.probe",
        packetId: "storage.probe",
        planVersion: "0.1.0",
        applicability: { capabilities: ["probe"] },
        checks: ["ok", "wrong"].map((expected, index) => ({
          checkId: `storage.probe.${index}`,
          operation: "probe.read",
          assertions: [
            { kind: "resultField", field: "$.value", equals: expected },
          ],
        })),
      })
    );
    await writeFile(adapter, JSON.stringify(manifest));
    const child = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapter,
        "--plan",
        plan,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(1);
    const evidence: unknown = JSON.parse(stdout);
    expect(evidence).toMatchObject({
      status: "fail",
      summary: { passedChecks: 1, failedChecks: 1 },
    });
    const references = (await readFile(log, "utf8")).trim().split("\n");
    expect(references).toHaveLength(2);
    expect(references[0]).not.toBe(references[1]);
    for (const ref of references) {
      await expect(access(ref)).rejects.toThrow();
    }
    await writeFile(
      adapter,
      JSON.stringify({
        ...manifest,
        storage: "postgres-database",
        command: [
          "bun",
          "--eval",
          script.replaceAll("sqlite-directory", "postgres-database"),
        ],
      })
    );
    const unavailable = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapter,
        "--plan",
        plan,
      ],
      env: {
        ...process.env,
        PGHOST: path.join(directory, "missing-socket"),
        PGCONNECT_TIMEOUT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [failedOutput, failedError, failedExit] = await Promise.all([
      new Response(unavailable.stdout).text(),
      new Response(unavailable.stderr).text(),
      unavailable.exited,
    ]);
    expect(failedExit, failedError).toBe(1);
    const failure: unknown = JSON.parse(failedOutput);
    expect(failure).toMatchObject({
      status: "fail",
      checkResults: [
        { failure: { classification: "environment" } },
        { failure: { classification: "environment" } },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
