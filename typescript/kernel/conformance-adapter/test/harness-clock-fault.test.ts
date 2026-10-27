import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";
import { assertConformanceEvidence } from "../../../../tools/scripts/lib/conformance-contract.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const planPath =
  "spec/conformance/kernel/plans/kernel-protocol-core-syscall.json";

const faultScenarios = [
  1,
  99,
  "unsupported",
  "block",
  "dispatch-bypass",
  "implicit-bypass",
] as const;

const prepareCheck = async (occurrence: (typeof faultScenarios)[number]) => {
  const compiled = await loadConformancePlan(planPath);
  const check = compiled.plan.checks.find(
    (entry) => entry.checkId === "kernel.syscall.controls.before_commit"
  );
  if (check === undefined) {
    throw new Error("missing clock/fault control plan");
  }
  const arm = check.steps?.find((step) => step.action === "armFault");
  if (arm?.arguments === undefined) {
    throw new Error("missing arming arguments");
  }
  arm.arguments.occurrence = typeof occurrence === "number" ? occurrence : 1;
  if (occurrence === "block") {
    arm.arguments.mode = "block";
  }
  if (occurrence === "dispatch-bypass" || occurrence === "implicit-bypass") {
    arm.arguments.occurrence = 99;
    if (occurrence === "dispatch-bypass") {
      arm.action = "dispatch";
    } else {
      delete arm.action;
    }
    check.assertions = [
      {
        field: "$.trace.arm.result.token",
        kind: "resultField",
        present: true,
      },
    ];
    for (const step of check.steps ?? []) {
      step.assertions = step.assertions?.filter(
        ({ kind }) => kind !== "faultActivated"
      );
    }
  }
  if (occurrence === "unsupported") {
    arm.arguments.point = "after-turn-node-write-before-head";
  }
  check.checkId = "clock-fault-test";
  return { check, compiled };
};

for (const occurrence of faultScenarios) {
  test(`runner records activation or rejects an unreached arming (occurrence ${occurrence})`, async () => {
    const { compiled, check } = await prepareCheck(occurrence);
    const directory = await mkdtemp(path.join(tmpdir(), "dc001-runner-"));
    try {
      const file = path.join(directory, "plan.json");
      const evidence = path.join(directory, "evidence.json");
      await writeFile(
        file,
        JSON.stringify({ ...compiled.plan, checks: [check], fixtures: {} })
      );
      const child = spawn(
        [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          "typescript/kernel/conformance-adapter/adapter.json",
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
          env: { ...process.env, VERIFY_LOG_DIR: directory },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr + stdout).toBe(
        occurrence === 99 ||
          occurrence === "dispatch-bypass" ||
          occurrence === "implicit-bypass"
          ? 1
          : 0
      );
      if (
        occurrence === "dispatch-bypass" ||
        occurrence === "implicit-bypass"
      ) {
        expect(stderr).toContain("fault-action");
        expect(await Bun.file(evidence).exists()).toBe(false);
        return;
      }
      const result: unknown = JSON.parse(await readFile(evidence, "utf-8"));
      assertConformanceEvidence(result, "clock/fault evidence");
      const [first] = result.checkResults;
      if (first === undefined) {
        throw new Error("missing check evidence");
      }
      if (occurrence === "unsupported" || occurrence === "block") {
        expect(first.status).toBe("unsupported");
        expect(first.failure).toBeUndefined();
        expect(result.status).toBe("unsupported");
        expect(result.summary.failedChecks).toBe(0);
        return;
      }
      const fault = first.details?.fault;
      if (
        typeof fault !== "object" ||
        fault === null ||
        !("armed" in fault) ||
        !Array.isArray(fault.armed) ||
        !("activations" in fault) ||
        !Array.isArray(fault.activations)
      ) {
        throw new Error("missing fault arming and activation evidence");
      }
      expect(fault.armed).toHaveLength(1);
      if (occurrence === 1) {
        expect(fault.activations).toHaveLength(1);
        expect(typeof fault.activations[0]).toBe("string");
        expect(result.status).toBe("pass");
      } else {
        expect(first).toMatchObject({
          details: { rejection: { code: "missing_fault_activation" } },
          failure: { classification: "verification" },
          status: "fail",
        });
        expect(fault.activations).toEqual([]);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
}
