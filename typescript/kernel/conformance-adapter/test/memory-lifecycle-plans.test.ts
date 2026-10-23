import { expect, test } from "bun:test";

import {
  assessConformancePlans,
  loadCertificationAuthority,
} from "../../../../tools/conformance/plan-compiler/certification-assessment.ts";
import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";

const plans = [
  "scope-isolation",
  "reclamation",
  "run-liveness",
  "restart-recovery",
].map((name) => `spec/conformance/kernel/plans/kernel-${name}-syscall.json`);

test("DC syscall checks declare every catalogued operation capability", async () => {
  const catalog: unknown = await Bun.file(
    new URL(
      "../../../../spec/conformance/kernel/operations.json",
      import.meta.url
    )
  ).json();
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    !("operations" in catalog) ||
    !Array.isArray(catalog.operations)
  ) {
    throw new Error("missing kernel operation catalog");
  }
  const capabilities = new Map<string, string>();
  for (const value of catalog.operations) {
    const entry: unknown = value;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("operationId" in entry) ||
      !("capability" in entry) ||
      typeof entry.operationId !== "string" ||
      typeof entry.capability !== "string"
    ) {
      throw new Error("operation must declare an id and capability");
    }
    capabilities.set(entry.operationId, entry.capability);
  }
  const syscallPlans = [
    "protocol-core",
    "protocol-extended",
    "reclamation",
    "scope-isolation",
    "run-liveness",
    "restart-recovery",
  ];
  const compiled = await Promise.all(
    syscallPlans.map(
      async (name) =>
        await loadConformancePlan(
          `spec/conformance/kernel/plans/kernel-${name}-syscall.json`
        )
    )
  );
  for (const { plan } of compiled) {
    for (const check of plan.checks) {
      for (const step of [check, ...(check.steps ?? [])]) {
        const capability = capabilities.get(step.operation);
        expect(capability, step.operation).toBeDefined();
        expect(check.capabilities, check.checkId).toContain(capability);
      }
    }
  }
});

test("memory lifecycle traces enforce certification through catalogued observations", async () => {
  const assessments = await assessConformancePlans(
    plans,
    await loadCertificationAuthority(["spec/kernel/authority-packet.json"])
  );
  expect(assessments.map((assessment) => assessment.mode)).toEqual([
    "enforcing",
    "enforcing",
    "enforcing",
    "enforcing",
  ]);
  expect(assessments.flatMap((assessment) => assessment.violations)).toEqual(
    []
  );
  const compiled = await Promise.all(plans.map(loadConformancePlan));
  for (const { plan } of compiled) {
    expect(plan.applicability.capabilities).toContain("kernel.syscall");
    for (const check of plan.checks) {
      expect(check.steps?.length).toBeGreaterThan(0);
      expect(check.claimIds?.length).toBeGreaterThan(0);
      for (const step of check.steps ?? []) {
        expect(step.arguments).toBeDefined();
        expect(step.claimIds?.length).toBeGreaterThan(0);
        expect(step.operation).not.toMatch(/probe$/u);
      }
    }
  }
});

test("lease controls activate and fail designated run-liveness syscall assertions", async () => {
  const { NEGATIVE_CONTROL_PORTS, runNegativeControls } =
    await import("../../../../tools/conformance/meta-conformance/negative-controls.ts");
  const config = NEGATIVE_CONTROL_PORTS.find((port) => port.port === "kernel");
  if (config === undefined) {
    throw new Error("missing kernel negative-control configuration");
  }
  const report = await runNegativeControls(config, {
    mutants: [
      "kernel.lease-takeover-before-expiry",
      "kernel.accept-stale-owner-after-takeover",
    ],
  });
  expect(report.control.status).toBe("pass");
  expect(report.mutants).toHaveLength(2);
  for (const mutant of report.mutants) {
    expect(mutant, mutant.reason).toMatchObject({
      activated: true,
      outcome: "killed",
    });
    expect(mutant.activationCount).toBeGreaterThan(0);
    expect(mutant.designatedFailures.length).toBeGreaterThan(0);
    expect(
      mutant.designatedFailures.every((id) =>
        id.startsWith("kernel.syscall.run-liveness.")
      )
    ).toBe(true);
  }
}, 60_000);

test("lease error expectations stay outside instance input and operation arguments", async () => {
  const { plan } = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-run-liveness-syscall.json"
  );
  for (const check of plan.checks) {
    expect(check.input).toBeUndefined();
    for (const assertion of [
      ...check.assertions,
      ...(check.steps ?? []).flatMap((step) => step.assertions ?? []),
    ]) {
      if (assertion.kind === "schemaValid") {
        expect(assertion.schema).toStartWith("$.fixture.expected.");
      }
    }
  }
});

test("reclamation controls activate and fail designated syscall assertions", async () => {
  const { NEGATIVE_CONTROL_PORTS, runNegativeControls } =
    await import("../../../../tools/conformance/meta-conformance/negative-controls.ts");
  const config = NEGATIVE_CONTROL_PORTS.find((port) => port.port === "kernel");
  if (config === undefined) {
    throw new Error("missing kernel negative-control configuration");
  }
  const mutants = [
    "kernel.delete-object-reachable-through-live-root",
    "kernel.never-sweep-eligible-objects",
    "kernel.sweep-inside-grace-window",
  ];
  const recoveryMutant = "kernel.drop-uncommitted-staged-result-on-recovery";
  const report = await runNegativeControls(config, {
    mutants: [...mutants, recoveryMutant],
  });
  expect(report.control.status).toBe("pass");
  expect(report.mutants).toHaveLength(mutants.length + 1);
  for (const mutant of report.mutants) {
    expect(mutant, mutant.reason).toMatchObject({
      activated: true,
      outcome: "killed",
    });
    expect(mutant.activationCount).toBeGreaterThan(0);
    expect(mutant.designatedFailures.length).toBeGreaterThan(0);
    if (mutant.mutantId === "kernel.sweep-inside-grace-window") {
      expect(mutant.designatedFailures).toContain(
        "kernel.syscall.reclamation.grace_window_holds_under_active_lease.2.resultField"
      );
      expect(mutant.designatedFailures).toContain(
        "kernel.syscall.reclamation.leaseless_run_within_admin_expiry_still_pins_reclamation.1.resultField"
      );
    }
    if (mutant.mutantId !== recoveryMutant) {
      expect(
        mutant.designatedFailures.every((id) =>
          id.startsWith("kernel.syscall.reclamation.")
        )
      ).toBe(true);
    }
  }
}, 60_000);
