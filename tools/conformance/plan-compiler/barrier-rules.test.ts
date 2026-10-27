import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  evaluateCertificationRules,
  parseOperationCatalog,
} from "./certification-rules.ts";
import { loadConformancePlan } from "./index.ts";

const catalog = parseOperationCatalog(
  JSON.parse(
    await readFile("spec/conformance/kernel/operations.json", "utf-8")
  ),
  "kernel catalog"
);
const planPath =
  "spec/conformance/kernel/plans/kernel-concurrent-writer-syscall.json";

test("writer barriers require later start participants on the catalogued native seam", async () => {
  const { plan } = await loadConformancePlan(planPath);
  expect(evaluateCertificationRules(plan, catalog)).toEqual([]);
  for (const change of [
    "late-arm",
    "wrong-seam",
    "missing-participant",
    "early-release",
    "wrong-operation",
  ] as const) {
    const altered = structuredClone(plan);
    const check = altered.checks[0];
    const steps = check?.steps;
    const arm = steps?.find((step) => step.action === "barrier");
    const release = steps?.find((step) => step.action === "release");
    if (steps === undefined || arm === undefined || release === undefined) {
      throw new Error("missing barrier trace");
    }
    switch (change) {
      case "late-arm": {
        steps.splice(steps.indexOf(arm), 1);
        steps.push(arm);
        break;
      }
      case "wrong-seam": {
        arm.seam = "unreviewed";
        break;
      }
      case "missing-participant": {
        arm.participants = ["firstStart", "absent"];
        break;
      }
      case "early-release": {
        steps.splice(steps.indexOf(release), 1);
        steps.unshift(release);
        break;
      }
      case "wrong-operation": {
        arm.operation = "kernel.branch.get";
        break;
      }
      default: {
        throw new Error("unknown probe");
      }
    }
    expect(
      evaluateCertificationRules(altered, catalog).some(
        (violation) => violation.rule === "barrier-schedule"
      ),
      change
    ).toBe(true);
  }
});

test("arrival assertions can read only existing runner-recorded step arrivals", async () => {
  const { plan } = await loadConformancePlan(planPath);
  const check = plan.checks[0];
  if (check === undefined) {
    throw new Error("missing race check");
  }
  check.assertions.push({
    kind: "arrival",
    path: "$.arrivals.absent",
    lessThan: "$.arrivals.release",
  });
  expect(
    evaluateCertificationRules(plan, catalog).some(
      (violation) => violation.rule === "observation-path"
    )
  ).toBe(true);
});

test("outcome branches expose only the runner's protocol kind", async () => {
  const { plan } = await loadConformancePlan(planPath);
  const check = plan.checks[0];
  if (check === undefined) {
    throw new Error("missing race check");
  }
  for (const field of ["value", "error", "invented"]) {
    const altered = structuredClone(plan);
    const changed = altered.checks[0];
    if (changed === undefined) {
      throw new Error("missing race check");
    }
    changed.assertions.push({
      kind: "resultField",
      field: `$.trace.firstOutcome.outcome.${field}`,
      equals: "result",
    });
    expect(
      evaluateCertificationRules(altered, catalog).some(
        (violation) => violation.rule === "observation-path"
      )
    ).toBe(true);
  }
});
