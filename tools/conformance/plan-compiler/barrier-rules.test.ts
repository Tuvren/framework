import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

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

test("start arguments must satisfy the catalogued syscall input", async () => {
  const { plan } = await loadConformancePlan(planPath);
  const start = plan.checks[0]?.steps?.find((step) => step.action === "start");
  if (start?.arguments === undefined) {
    throw new Error("missing start arguments");
  }
  start.arguments.barrierParticipant = "firstStart";
  expect(
    evaluateCertificationRules(plan, catalog).some((violation) =>
      violation.message.includes("additional properties")
    )
  ).toBe(true);
});

test("writer barriers require later start participants on the catalogued native seam", async () => {
  const { plan } = await loadConformancePlan(planPath);
  expect(evaluateCertificationRules(plan, catalog)).toEqual([]);
  for (const change of [
    "late-arm",
    "wrong-seam",
    "missing-participant",
    "missing-handle-capture",
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
      case "missing-handle-capture": {
        const start = steps.find((step) => step.stepId === "firstStart");
        if (start === undefined) {
          throw new Error("missing start");
        }
        start.handleCapture = undefined;
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

test("barriers reject extra starts until every participant is released", async () => {
  const { plan } = await loadConformancePlan(planPath);
  for (const extra of ["outsider", "firstStart"]) {
    const altered = structuredClone(plan);
    const steps = altered.checks[0]?.steps;
    const start = steps?.find((step) => step.stepId === "firstStart");
    const release = steps?.find((step) => step.action === "release");
    if (steps === undefined || start === undefined || release === undefined) {
      throw new Error("missing barrier trace");
    }
    steps.splice(steps.indexOf(release), 0, {
      ...structuredClone(start),
      stepId: extra,
      handleCapture: `extra_${extra}`,
    });
    expect(
      evaluateCertificationRules(altered, catalog).some(
        (violation) => violation.rule === "barrier-schedule"
      ),
      extra
    ).toBe(true);
  }
  const partial = structuredClone(plan);
  const steps = partial.checks[0]?.steps;
  const start = steps?.find((step) => step.stepId === "firstStart");
  const release = steps?.find((step) => step.action === "release");
  if (steps === undefined || start === undefined || release === undefined) {
    throw new Error("missing barrier trace");
  }
  release.participants = ["firstStart"];
  steps.splice(steps.indexOf(release) + 1, 0, {
    ...structuredClone(start),
    stepId: "outsider",
    handleCapture: "outsider",
  });
  expect(
    evaluateCertificationRules(partial, catalog).some(
      (violation) =>
        violation.rule === "barrier-schedule" && violation.stepId === "outsider"
    )
  ).toBe(true);
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

test("processExit requires an epoch and an exit expectation on a supervised trace", async () => {
  const schema = JSON.parse(
    await readFile("tools/schemas/conformance-plan.schema.json", "utf8")
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const { plan } = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-close-reopen-syscall.json"
  );
  const check = plan.checks[0];
  if (check === undefined) {
    throw new Error("missing reopen check");
  }
  check.assertions.push({ kind: "processExit", epoch: 1, code: 0 });
  expect(validate(plan), JSON.stringify(validate.errors)).toBe(true);
  expect(
    evaluateCertificationRules(plan, catalog).filter((v) =>
      v.message.includes("processExit")
    )
  ).toEqual([]);
  for (const invalid of [
    { kind: "processExit", signal: "SIGKILL" },
    { kind: "processExit", epoch: 0, signal: "SIGKILL" },
    { kind: "processExit", epoch: 1 },
    { kind: "processExit", epoch: 1, signal: 2 },
  ]) {
    const altered = structuredClone(plan);
    const target = altered.checks[0];
    if (target === undefined) {
      throw new Error("missing reopen check");
    }
    target.assertions[target.assertions.length - 1] = invalid as never;
    expect(validate(altered), JSON.stringify(invalid)).toBe(false);
  }
  const { plan: unsupervised } = await loadConformancePlan(planPath);
  const ordinary = unsupervised.checks[0];
  if (ordinary === undefined) {
    throw new Error("missing race check");
  }
  ordinary.assertions.push({
    kind: "processExit",
    epoch: 1,
    signal: "SIGKILL",
  });
  expect(
    evaluateCertificationRules(unsupervised, catalog).some((v) =>
      v.message.includes("processExit")
    )
  ).toBe(true);
});

test("processExit on a lifecycle step selects the epoch that step terminates", async () => {
  const { plan } = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-close-reopen-syscall.json"
  );
  const steps = plan.checks[0]?.steps;
  const restart = steps?.find((step) => step.action === "restart");
  if (restart === undefined) {
    throw new Error("missing restart");
  }
  restart.assertions = [{ kind: "processExit", epoch: 1, code: 0 }];
  expect(
    evaluateCertificationRules(plan, catalog).filter((v) =>
      v.message.includes("processExit")
    )
  ).toEqual([]);
  restart.assertions = [{ kind: "processExit", epoch: 2, code: 0 }];
  expect(
    evaluateCertificationRules(plan, catalog).some((v) =>
      v.message.includes("processExit")
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
