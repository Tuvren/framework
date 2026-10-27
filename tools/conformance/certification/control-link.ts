import { createHash } from "node:crypto";

import type { VerifierDigests } from "./provenance.js";

export interface ControlAdapterDigest {
  adapter: string;
  adapterManifest: string;
  implementation: string;
}

export interface ControlRunIdentity {
  profile: string;
  status: "pass" | "fail";
  verifierDigests: VerifierDigests;
  adapters: readonly ControlAdapterDigest[];
  outcomes: readonly unknown[];
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

export const controlOutcomes = (reports: readonly unknown[]): unknown[] =>
  reports.map((value) => {
    const report = object(value);
    const control = object(report?.control);
    return {
      adapter: control?.adapter,
      baseline: control?.status,
      conditionalAssertions: control?.conditionalAssertions ?? [],
      counted: report?.counted,
      findings: report?.findings,
      mode: report?.mode,
      mutants: Array.isArray(report?.mutants)
        ? report.mutants.map((value: unknown) => {
            const mutant = object(value);
            return {
              activated: mutant?.activated,
              designatedFailures: mutant?.designatedFailures,
              expectedRejection: mutant?.expectedRejection,
              kind: mutant?.kind,
              mutantId: mutant?.mutantId,
              outcome: mutant?.outcome,
              reason: mutant?.reason,
            };
          })
        : [],
      notRun: report?.notRun,
      profile: report?.profile,
    };
  });

export const controlRunId = (identity: ControlRunIdentity): string =>
  createHash("sha256").update(JSON.stringify(identity)).digest("hex");

interface ControlExpectation {
  adapter: string;
  adapterManifest: string;
  implementation: string;
  negativeControls: readonly string[];
  conditionalAssertions: readonly string[];
  profile: string;
  verifierDigests: VerifierDigests;
}

const parseAdapters = (
  values: readonly unknown[]
): ControlAdapterDigest[] | undefined => {
  const adapters: ControlAdapterDigest[] = [];
  for (const value of values) {
    const adapter = object(value);
    if (
      typeof adapter?.adapter !== "string" ||
      typeof adapter.adapterManifest !== "string" ||
      typeof adapter.implementation !== "string"
    ) {
      return undefined;
    }
    adapters.push({
      adapter: adapter.adapter,
      adapterManifest: adapter.adapterManifest,
      implementation: adapter.implementation,
    });
  }
  return adapters;
};

const validMutants = (
  values: readonly unknown[],
  expected: ControlExpectation,
  killed: Set<string>
): boolean => {
  const seen = new Set<string>();
  for (const value of values) {
    const mutant = object(value);
    if (typeof mutant?.mutantId !== "string" || seen.has(mutant.mutantId)) {
      return false;
    }
    seen.add(mutant.mutantId);
    if (!expected.negativeControls.includes(mutant.mutantId)) {
      continue;
    }
    if (mutant.outcome === "unsupported") {
      if (typeof mutant.reason !== "string" || mutant.reason.length === 0) {
        return false;
      }
      continue;
    }
    const detected =
      mutant.kind === "implementation"
        ? Array.isArray(mutant.designatedFailures) &&
          mutant.designatedFailures.length > 0
        : (mutant.kind === "observation" ||
            mutant.kind === "instrumentation") &&
          typeof mutant.expectedRejection === "string";
    if (
      !(mutant.outcome === "killed" && mutant.activated === true && detected)
    ) {
      return false;
    }
    killed.add(mutant.mutantId);
  }
  return expected.negativeControls.every((id) => seen.has(id));
};

const validReport = (
  value: unknown,
  expected: ControlExpectation,
  killed: Set<string>,
  branches: Set<string>
): boolean => {
  const report = object(value);
  const control = object(report?.control);
  if (
    report?.counted !== true ||
    report.mode !== "enforcing" ||
    report.profile !== expected.profile ||
    control?.status !== "pass" ||
    !Array.isArray(report.findings) ||
    report.findings.length > 0 ||
    !Array.isArray(report.notRun) ||
    report.notRun.length > 0 ||
    !Array.isArray(report.mutants)
  ) {
    return false;
  }
  if (Array.isArray(control.conditionalAssertions)) {
    for (const value of control.conditionalAssertions) {
      const assertion = object(value);
      if (
        typeof assertion?.assertionId === "string" &&
        assertion.status === "pass" &&
        assertion.when === "applied"
      ) {
        branches.add(assertion.assertionId);
      }
    }
  }
  return validMutants(report.mutants, expected, killed);
};

const validFleet = (
  reports: readonly unknown[],
  expected: ControlExpectation
): boolean => {
  const own = reports
    .map(object)
    .find((report) => object(report?.control)?.adapter === expected.adapter);
  if (own === undefined) {
    return false;
  }
  const killed = new Set<string>();
  const branches = new Set<string>();
  return (
    reports.every((report) =>
      validReport(report, expected, killed, branches)
    ) &&
    expected.negativeControls.every((id) => killed.has(id)) &&
    expected.conditionalAssertions.every((id) => branches.has(id))
  );
};

export const matchesControlRun = (
  value: unknown,
  expected: ControlExpectation
): string | undefined => {
  const document = object(value);
  const run = object(document?.controlRun);
  const actualDigests = object(run?.verifierDigests);
  if (
    run === undefined ||
    run.status !== "pass" ||
    run.profile !== expected.profile ||
    typeof run.id !== "string" ||
    !Array.isArray(run.adapters) ||
    !Array.isArray(document?.reports) ||
    actualDigests === undefined ||
    Object.entries(expected.verifierDigests).some(
      ([key, digest]) => actualDigests[key] !== digest
    )
  ) {
    return undefined;
  }
  const adapters = parseAdapters(run.adapters);
  if (
    adapters === undefined ||
    !adapters.some(
      (adapter) =>
        adapter.adapter === expected.adapter &&
        adapter.adapterManifest === expected.adapterManifest &&
        adapter.implementation === expected.implementation
    )
  ) {
    return undefined;
  }
  const identity = {
    profile: expected.profile,
    status: "pass" as const,
    verifierDigests: expected.verifierDigests,
    adapters,
    outcomes: controlOutcomes(document.reports),
  };
  return JSON.stringify(run.outcomes) === JSON.stringify(identity.outcomes) &&
    controlRunId(identity) === run.id &&
    validFleet(document.reports, expected)
    ? run.id
    : undefined;
};
