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

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import { readAdapterManifest } from "../harness/run-plans.ts";
import {
  NEGATIVE_CONTROL_PORTS,
  runNegativeControls,
} from "./negative-controls.ts";

const exploratoryAdapter = async (directory: string): Promise<string> => {
  const path = nodePath.join(directory, "rust-exploratory.json");
  const manifest = await readAdapterManifest(
    "rust/kernel-conformance-adapter/adapter.json"
  );
  await writeFile(path, JSON.stringify({ ...manifest, profiles: [] }));
  return path;
};

test("Rust memory controls are diagnostic when its claimed profile is incomplete", async () => {
  const config = NEGATIVE_CONTROL_PORTS.find(
    ({ controlAdapter }) =>
      controlAdapter === "rust/kernel-conformance-adapter/adapter.json"
  );
  if (config === undefined) {
    throw new Error("missing Rust memory negative-control configuration");
  }
  const claimed = await runNegativeControls(config);
  expect(claimed.counted).toBe(false);
  expect(claimed.control.status).toBe("fail");
  expect(claimed.control.failedChecks?.length).toBe(7);
  expect(claimed.mutants).toHaveLength(13);
  expect(claimed.totals.killed).toBe(3);
  expect(claimed.totals.unsupported).toBe(10);
  expect(claimed.findings.join(" ")).toContain("diagnostic");
  const report = claimed;
  const manifest: unknown = JSON.parse(
    await readFile("spec/conformance/kernel/negative-controls.json", "utf-8")
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("controls" in manifest) ||
    !Array.isArray(manifest.controls)
  ) {
    throw new TypeError("invalid control manifest");
  }
  expect(report.mutants).toHaveLength(manifest.controls.length);
  expect(report.totals.killed).toBe(3);
  expect(report.totals.unsupported).toBe(manifest.controls.length - 3);
  for (const mutant of report.mutants) {
    if (mutant.outcome === "unsupported") {
      expect(mutant.reason).toContain(
        mutant.mutantId === "kernel.resolve-object-across-scopes"
          ? "no shared-substrate construction seam in the Rust kernel"
          : "no Rust reproduction yet"
      );
      expect(mutant.activated).toBe(false);
      continue;
    }
    expect(mutant.outcome).toBe("killed");
    expect(mutant.activationCount).toBeGreaterThan(0);
    expect(mutant.designatedFailures.length).toBeGreaterThan(0);
  }
}, 60_000);

test("exploratory Rust syscall evidence covers every check in all four memory families", async () => {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "tuvren-rust-memory-")
  );
  try {
    const evidencePath = nodePath.join(directory, "evidence.json");
    const child = spawn(
      [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        await exploratoryAdapter(directory),
        "--capability",
        "kernel.syscall",
        "--summary-only",
        "--evidence-out",
        evidencePath,
      ],
      { stdout: "ignore", stderr: "inherit" }
    );
    expect(await child.exited).toBe(0);
    const evidence: unknown = JSON.parse(await readFile(evidencePath, "utf-8"));
    assertConformanceEvidence(evidence, "Rust memory family evidence");
    expect(evidence.selection).toHaveLength(
      evidence.summary.totalChecks +
        (evidence.selection ?? []).filter(({ reason }) =>
          reason?.startsWith("not run:")
        ).length
    );
    expect(evidence.nonApplicableCheckIds).toEqual(
      (evidence.selection ?? [])
        .filter(
          ({ selected, reason }) =>
            !(selected || reason?.startsWith("not run:"))
        )
        .map(({ checkId }) => checkId)
    );
    for (const entry of evidence.selection ?? []) {
      if (!entry.selected) {
        expect(entry.reason).toBeTruthy();
      }
    }
    for (const checkId of [
      "kernel.scope-isolation.store_has_is_scope_confined",
      "kernel.scope-isolation.store_get_is_scope_confined",
      "kernel.scope-isolation.enumeration_is_scope_confined",
      "kernel.crash-recovery.in_process_fault_points",
      "kernel.crash-recovery.concurrent_writer",
    ]) {
      expect(
        evidence.selection?.find((entry) => entry.checkId === checkId)
      ).toMatchObject({
        selected: false,
        reason: expect.stringContaining("missing capabilities:"),
      });
    }
    for (const family of [
      "scope-isolation",
      "reclamation",
      "run-liveness",
      "restart-recovery",
    ]) {
      const plan: unknown = JSON.parse(
        await readFile(
          `spec/conformance/kernel/plans/kernel-${family}-syscall.json`,
          "utf-8"
        )
      );
      if (
        typeof plan !== "object" ||
        plan === null ||
        !("checks" in plan) ||
        !Array.isArray(plan.checks)
      ) {
        throw new Error("invalid memory plan");
      }
      expect(plan.checks.length).toBeGreaterThan(0);
      for (const check of plan.checks) {
        if (
          typeof check !== "object" ||
          check === null ||
          !("checkId" in check) ||
          typeof check.checkId !== "string"
        ) {
          throw new Error("invalid memory check");
        }
        const result = evidence.checkResults.find(
          ({ checkId }) => checkId === check.checkId
        );
        expect(result?.status).toBe("pass");
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
