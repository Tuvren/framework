import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";

const planPath =
  "spec/conformance/kernel/plans/kernel-concurrent-writer-syscall.json";

test("sqlite passes both concurrent-writer orderings with the head held until release", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sqlite-barrier-"));
  try {
    const evidence = path.join(directory, "evidence.json");
    const child = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        "typescript/kernel/conformance-adapter/adapter-sqlite.json",
        "--packet",
        "spec/kernel/authority-packet.json",
        "--plan",
        planPath,
        "--check",
        "kernel.syscall.concurrent_writer.a_first",
        "--check",
        "kernel.syscall.concurrent_writer.b_first",
        "--evidence-out",
        evidence,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr + stdout).toBe(0);
    const result: unknown = JSON.parse(await readFile(evidence, "utf-8"));
    assertConformanceEvidence(result, "sqlite writer race evidence");
    expect(result.status).toBe("pass");
    expect(result.checkResults).toHaveLength(2);
    for (const check of result.checkResults) {
      expect(check.status).toBe("pass");
      expect(check.details?.adapterId).toBe("typescript-kernel-sqlite");
      expect(check.assertionResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assertionId: `${check.checkId}.5.resultField`,
            status: "pass",
          }),
          expect.objectContaining({
            assertionId: `${check.checkId}.6.schemaValid`,
            status: "pass",
          }),
        ])
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 60_000);
