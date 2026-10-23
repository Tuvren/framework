import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertCertificationEnforcement,
  assessConformancePlans,
  loadCertificationAuthority,
} from "../../../../tools/conformance/plan-compiler/certification-assessment.ts";
import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";

const plans = ["core", "extended"].map(
  (name) => `spec/conformance/kernel/plans/kernel-protocol-${name}-syscall.json`
);

test("syscall protocol plans enforce certification with explicit trace projections", async () => {
  const assessments = await assessConformancePlans(
    plans,
    await loadCertificationAuthority(["spec/kernel/authority-packet.json"])
  );
  expect(assessments.map((assessment) => assessment.mode)).toEqual([
    "enforcing",
    "enforcing",
  ]);
  expect(assessments.flatMap((assessment) => assessment.violations)).toEqual(
    []
  );
  const compiledPlans = await Promise.all(plans.map(loadConformancePlan));
  for (const { plan } of compiledPlans) {
    expect(plan.applicability.capabilities).toContain("kernel.syscall");
    for (const check of plan.checks) {
      expect(check.steps?.length).toBeGreaterThan(0);
      for (const step of check.steps ?? []) {
        expect(step.arguments).toBeDefined();
        expect(step.capture).toBeDefined();
        expect(step.claimIds?.length).toBeGreaterThan(0);
      }
    }
  }
});

test("syscall bindings preserve native bytes, null, error codes, and instance isolation", async () => {
  const { createSyscallBindings } = await import("../src/host-syscalls.ts");
  const bridge = createSyscallBindings({
    adapterId: "syscall-test",
    backend: "memory",
    capabilities: ["kernel.syscall"],
  });
  const first = await bridge.createInstance();
  const second = await bridge.createInstance();
  try {
    const bytes = { $bytes: "00ff80" };
    const put = await bridge.dispatch(
      "kernel.store.put",
      { blob: bytes },
      first
    );
    expect(put.kind).toBe("result");
    if (
      put.kind !== "result" ||
      typeof put.value !== "object" ||
      put.value === null ||
      !("result" in put.value)
    ) {
      throw new Error("missing store result");
    }
    const hash = put.value.result;
    expect(await bridge.dispatch("kernel.store.get", { hash }, first)).toEqual({
      kind: "result",
      value: { result: bytes },
    });
    expect(await bridge.dispatch("kernel.store.get", { hash }, second)).toEqual(
      { kind: "result", value: { result: null } }
    );
    const malformed = await Promise.allSettled([
      bridge.dispatch(
        "kernel.store.put",
        { blob: { $bytes: "00", extra: true } },
        first
      ),
      bridge.dispatch(
        "kernel.store.put",
        {
          blob: {
            $map: [
              ["x", 1],
              ["x", 2],
            ],
          },
        },
        first
      ),
    ]);
    expect(malformed.map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const entry of malformed) {
      if (entry.status === "rejected") {
        const reason: unknown = entry.reason;
        expect(reason).toBeInstanceOf(TypeError);
      }
    }
    const rejected = await bridge.dispatch(
      "kernel.schema.register",
      {
        schema: {
          incorporationRules: [],
          paths: [
            { collection: "single", path: "a" },
            { collection: "single", path: "a" },
          ],
          schemaId: "duplicate",
        },
      },
      first
    );
    expect(rejected.kind).toBe("error");
    if (rejected.kind === "error") {
      expect(rejected.error.code).toBe("duplicate_schema_path");
      expect(rejected.error.details).toEqual({ path: "a" });
    }
  } finally {
    await bridge.destroyInstance(first);
    await bridge.destroyInstance(second);
  }
});

test("per-plan enforcement rejects a violating syscall trace without a certification profile", async () => {
  const authority = await loadCertificationAuthority([
    "spec/kernel/authority-packet.json",
  ]);
  const compiled = await loadConformancePlan(plans[0] ?? "");
  const check = compiled.plan.checks.find(
    (entry) => entry.checkId === "kernel.syscall.protocol.modify_composition"
  );
  if (check === undefined) {
    throw new Error("missing composition check");
  }
  const changed = structuredClone(check);
  changed.assertions = [
    {
      equals: true,
      field: "$.trace.compose.result.undeclared",
      kind: "resultField",
    },
  ];
  const directory = await mkdtemp(path.join(tmpdir(), "db004-enforcement-"));
  const file = path.join(directory, "plan.json");
  try {
    const plan = { ...compiled.plan, checks: [changed], fixtures: {} };
    await writeFile(file, JSON.stringify(plan));
    const assessments = await assessConformancePlans([file], authority);
    expect(assessments[0]?.mode).toBe("enforcing");
    expect(
      assessments[0]?.violations.map((violation) => violation.rule)
    ).toContain("observation-path");
    expect(
      assessments[0]?.violations.map((violation) => violation.rule)
    ).toContain("literal-boolean");
    expect(() => {
      assertCertificationEnforcement(assessments);
    }).toThrow();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
