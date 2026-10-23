import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";
import { assertConformanceEvidence } from "../../../../tools/scripts/lib/conformance-contract.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const planPath =
  "spec/conformance/kernel/plans/kernel-restart-recovery-syscall.json";

test("recovery traces prove both atomic outcomes with token-matched activation", async () => {
  const { plan } = await loadConformancePlan(planPath);
  const directory = await mkdtemp(path.join(tmpdir(), "dc004-recovery-"));
  try {
    const evidence = path.join(directory, "evidence.json");
    const child = Bun.spawn(
      [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        "typescript/kernel/conformance-adapter/adapter.json",
        "--packet",
        "spec/kernel/authority-packet.json",
        "--plan",
        planPath,
        "--check",
        "kernel.syscall.crash-recovery.before_commit",
        "--check",
        "kernel.syscall.crash-recovery.after_commit_before_ack",
        "--evidence-out",
        evidence,
      ],
      { cwd: root, stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr + stdout).toBe(0);
    const result: unknown = JSON.parse(await readFile(evidence, "utf-8"));
    assertConformanceEvidence(result, "recovery evidence");
    expect(result.status).toBe("pass");
    expect(result.checkResults).toHaveLength(2);
    for (const check of result.checkResults.filter(
      (entry) => entry.status === "pass"
    )) {
      expect(check.details?.fault).toMatchObject({
        activations: ["fault-1"],
        armed: [{ token: "fault-1" }],
      });
      const branches = check.assertionResults.filter(
        (assertion) => assertion.when !== undefined
      );
      expect(branches.some((assertion) => assertion.when === "applied")).toBe(
        true
      );
      expect(
        branches.some((assertion) => assertion.when === "not_applied")
      ).toBe(true);
      const planned = plan.checks.find(
        (entry) => entry.checkId === check.checkId
      );
      if (planned === undefined) {
        throw new Error("unexpected recovery check");
      }
      const expectedStep = check.checkId.endsWith("before_commit")
        ? "baseline"
        : "pending";
      for (const [index, assertion] of planned.assertions.entries()) {
        if (assertion.when === undefined) {
          continue;
        }
        const observed = check.assertionResults.find(
          (entry) =>
            entry.assertionId ===
            `${check.checkId}.${index + 1}.${assertion.kind}`
        );
        expect(observed?.when).toBe(
          assertion.when.equals === expectedStep ? "applied" : "not_applied"
        );
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test.each([
  "after-turn-node-write-before-head",
  "after-head-move-before-staging-clear",
  "commit-outcome-unknown",
  "never-fires",
])(
  "recovery trace reports unsupported points or missing activation: %s",
  async (point) => {
    const { plan } = await loadConformancePlan(planPath);
    const [check] = plan.checks;
    if (check === undefined) {
      throw new Error("missing recovery check");
    }
    const arm = check.steps?.find((step) => step.action === "armFault");
    if (arm?.arguments === undefined) {
      throw new Error("missing arming arguments");
    }
    check.checkId = "dc004-recovery-probe";
    if (point !== "never-fires") {
      arm.arguments.point = point;
    }
    const directory = await mkdtemp(path.join(tmpdir(), "dc004-point-"));
    try {
      const file = path.join(directory, "plan.json");
      const evidence = path.join(directory, "evidence.json");
      await writeFile(file, JSON.stringify({ ...plan, checks: [check] }));
      const child = Bun.spawn(
        [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          `typescript/kernel/conformance-adapter/adapter${point === "never-fires" ? "-mutant" : ""}.json`,
          "--packet",
          "spec/kernel/authority-packet.json",
          "--plan",
          file,
          "--check",
          check.checkId,
          "--evidence-out",
          evidence,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ...(point === "never-fires"
              ? { TUVREN_KERNEL_MUTANT: "kernel.fault-seam-never-fires" }
              : {}),
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr + stdout).toBe(point === "never-fires" ? 1 : 0);
      const result: unknown = JSON.parse(await readFile(evidence, "utf-8"));
      assertConformanceEvidence(result, "recovery probe evidence");
      expect(result.checkResults).toHaveLength(1);
      if (point === "never-fires") {
        expect(result.checkResults[0]).toMatchObject({
          details: {
            fault: { activations: [] },
            rejection: { code: "missing_fault_activation" },
          },
          failure: { classification: "verification" },
          status: "fail",
        });
      } else {
        expect(result.status).toBe("unsupported");
        expect(result.summary.failedChecks).toBe(0);
        expect(result.checkResults[0]).toMatchObject({
          details: { unsupported: { code: "kernel_fault_point_unsupported" } },
          status: "unsupported",
        });
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
  30_000
);

test("recovery mutants activate and are detected by the promoted recovery claims", async () => {
  const { NEGATIVE_CONTROL_PORTS, runNegativeControls } =
    await import("../../../../tools/conformance/meta-conformance/negative-controls.ts");
  const config = NEGATIVE_CONTROL_PORTS.find((port) => port.port === "kernel");
  if (config === undefined) {
    throw new Error("missing kernel negative-control configuration");
  }
  const report = await runNegativeControls(config, {
    mutants: [
      "kernel.drop-uncommitted-staged-result-on-recovery",
      "kernel.promote-staged-before-checkpoint",
      "kernel.fault-seam-never-fires",
    ],
  });
  expect(report.control.status).toBe("pass");
  expect(report.mutants).toHaveLength(3);
  for (const mutant of report.mutants) {
    expect(mutant, mutant.reason).toMatchObject({
      activated: true,
      outcome: "killed",
    });
    expect(mutant.activationCount).toBeGreaterThan(0);
    if (mutant.kind === "instrumentation") {
      expect(mutant.expectedRejection).toBe("missing_fault_activation");
    } else {
      expect(
        mutant.designatedFailures.some((id) =>
          id.startsWith("kernel.syscall.crash-recovery.")
        )
      ).toBe(true);
    }
  }
}, 60_000);
