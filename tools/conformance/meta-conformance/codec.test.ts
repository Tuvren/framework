import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import { NEGATIVE_CONTROL_PORTS } from "./negative-control-config.ts";
import { runNegativeControls } from "./negative-controls.ts";

for (const adapter of [
  "typescript/kernel/conformance-adapter/adapter.json",
  "rust/kernel-conformance-adapter/adapter.json",
]) {
  test(`${adapter} passes every canonical codec obligation`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dq001-codec-"));
    try {
      const evidencePath = path.join(directory, "evidence.json");
      const child = spawn(
        [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          adapter,
          "--capability",
          "kernel.codec",
          "--summary-only",
          "--evidence-out",
          evidencePath,
        ],
        { stdout: "ignore", stderr: "inherit" }
      );
      expect(await child.exited).toBe(0);
      const evidence: unknown = JSON.parse(
        await readFile(evidencePath, "utf8")
      );
      assertConformanceEvidence(evidence, adapter);
      const checks = evidence.checkResults.filter(({ checkId }) =>
        checkId.startsWith("kernel.codec.")
      );
      expect(checks).toHaveLength(69);
      expect(checks.every(({ status }) => status === "pass")).toBe(true);
      expect(evidence.status).toBe("pass");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
}

test("legacy-only controls activate and die through canonical designations with passing baselines", async () => {
  const config = NEGATIVE_CONTROL_PORTS.find(
    ({ controlAdapter }) =>
      controlAdapter === "typescript/kernel/conformance-adapter/adapter.json"
  );
  if (config === undefined) {
    throw new Error("missing TypeScript memory controls");
  }
  const report = await runNegativeControls(
    { ...config, branchAdapters: [] },
    {
      mutants: [
        "kernel.accept-noncanonical-cbor",
        "kernel.resolve-object-across-scopes",
      ],
    }
  );
  expect(report.control.status).toBe("pass");
  expect(report.control.postBaseline?.status).toBe("pass");
  expect(report.findings).toEqual([]);
  const mutant = report.mutants.find(
    ({ mutantId }) => mutantId === "kernel.accept-noncanonical-cbor"
  );
  expect(mutant?.activated).toBe(true);
  expect(mutant?.activationCount).toBeGreaterThan(0);
  expect(mutant?.outcome).toBe("killed");
  expect(mutant?.designatedFailures).toContain(
    "kernel.codec.decode.non-minimal-uint-head.1.resultField"
  );
  const scope = report.mutants.find(
    ({ mutantId }) => mutantId === "kernel.resolve-object-across-scopes"
  );
  expect(scope?.activated).toBe(true);
  expect(scope?.activationCount).toBeGreaterThan(0);
  expect(scope?.outcome).toBe("killed");
  expect(scope?.designatedFailures).toEqual(
    expect.arrayContaining([
      "kernel.syscall.scope-isolation.own_content.otherHas.1.resultField",
      "kernel.syscall.scope-isolation.own_content.otherGet.1.resultField",
    ])
  );
}, 60_000);
