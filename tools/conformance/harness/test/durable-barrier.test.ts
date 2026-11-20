import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";

const planPath =
  "spec/conformance/kernel/plans/kernel-concurrent-writer-syscall.json";

test("sqlite records both writer-entry receipts before release in both orderings", async () => {
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
    expect(result.checkResults).toHaveLength(2);
    for (const check of result.checkResults) {
      expect(check.status).toBe("pass");
      const trace = check.details?.traceStepIds;
      if (!Array.isArray(trace)) {
        throw new TypeError("missing trace step order");
      }
      expect(trace.indexOf("firstReceipt")).toBeGreaterThanOrEqual(0);
      expect(trace.indexOf("secondReceipt")).toBeGreaterThan(
        trace.indexOf("firstReceipt")
      );
      expect(trace.indexOf("release")).toBeGreaterThan(
        trace.indexOf("secondReceipt")
      );
      expect(
        check.assertionResults.find((assertion) =>
          assertion.assertionId.endsWith(".6.schemaValid")
        )
      ).toMatchObject({ status: "pass" });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 60_000);
