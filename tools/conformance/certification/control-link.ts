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

export const profileControlReport = (
  value: unknown,
  profile: string,
  adapter?: string
): { controlRun: unknown; reports: unknown[] } | undefined => {
  const document = object(value);
  if (!Array.isArray(document?.reports)) {
    return undefined;
  }
  if (Array.isArray(document.controlRuns)) {
    const runs = document.controlRuns.filter((value: unknown) => {
      const run = object(value);
      return (
        run?.profile === profile &&
        (adapter === undefined ||
          (Array.isArray(run.adapters) &&
            run.adapters.some(
              (entry: unknown) => object(entry)?.adapter === adapter
            )))
      );
    });
    if (runs.length !== 1) {
      return undefined;
    }
    const run = object(runs[0]);
    const names = new Set(
      Array.isArray(run?.adapters)
        ? run.adapters.map((entry: unknown) => object(entry)?.adapter)
        : []
    );
    return {
      controlRun: runs[0],
      reports: document.reports.filter((value: unknown) => {
        const report = object(value);
        return (
          report?.profile === profile &&
          names.has(object(report.control)?.adapter)
        );
      }),
    };
  }
  return { controlRun: document.controlRun, reports: document.reports };
};

export const controlOutcomes = (reports: readonly unknown[]): unknown[] =>
  reports.map((value) => {
    const report = object(value);
    const control = object(report?.control);
    return {
      adapter: control?.adapter,
      baseline: control?.status,
      postBaseline: control?.postBaseline,
      execution: control?.execution,
      conditionalAssertions: control?.conditionalAssertions ?? [],
      ...(control?.branchControls === undefined
        ? {}
        : { branchControls: control.branchControls }),
      counted: report?.counted,
      findings: report?.findings,
      mode: report?.mode,
      mutants: Array.isArray(report?.mutants)
        ? report.mutants.map((value: unknown) => {
            const mutant = object(value);
            return {
              activated: mutant?.activated,
              designatedFailures: mutant?.designatedFailures,
              designatedAssertionsEvaluated:
                mutant?.designatedAssertionsEvaluated,
              detectionChecks: mutant?.detectionChecks,
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
  semanticAssertions: readonly string[];
  scopedControls: readonly string[];
  profile: string;
  verifierDigests: VerifierDigests;
  publishedTestkit?: boolean;
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
    const mutantId = mutant.mutantId;
    const evaluated = mutant.designatedAssertionsEvaluated;
    const detected =
      mutant.kind === "implementation"
        ? Array.isArray(mutant.designatedFailures) &&
          Array.isArray(evaluated) &&
          mutant.designatedFailures.some(
            (id: unknown) =>
              typeof id === "string" &&
              evaluated.includes(id) &&
              (!expected.scopedControls.includes(mutantId) ||
                expected.semanticAssertions.includes(id))
          )
        : (mutant.kind === "observation" ||
            mutant.kind === "instrumentation") &&
          typeof mutant.expectedRejection === "string" &&
          mutant.expectedRejection.trim().length > 0 &&
          Array.isArray(mutant.detectionChecks) &&
          mutant.detectionChecks.some(
            (id: unknown) => typeof id === "string" && id.length > 0
          );
    if (
      !(mutant.outcome === "killed" && mutant.activated === true && detected)
    ) {
      return false;
    }
    killed.add(mutant.mutantId);
  }
  return expected.negativeControls.every((id) => seen.has(id));
};

const collectBranches = (
  assertions: readonly unknown[],
  branches: Set<string>
): void => {
  for (const value of assertions) {
    const assertion = object(value);
    if (
      typeof assertion?.assertionId === "string" &&
      assertion.status === "pass" &&
      assertion.when === "applied"
    ) {
      branches.add(assertion.assertionId);
    }
  }
};

const validReport = (
  value: unknown,
  expected: ControlExpectation,
  killed: Set<string>
): boolean => {
  const report = object(value);
  const control = object(report?.control);
  if (
    report?.counted !== true ||
    report.mode !== "enforcing" ||
    report.profile !== expected.profile ||
    control?.status !== "pass" ||
    object(control.postBaseline)?.status !== "pass" ||
    (expected.publishedTestkit === true &&
      control.execution !== "in-process") ||
    !Array.isArray(report.findings) ||
    report.findings.length > 0 ||
    !Array.isArray(report.notRun) ||
    report.notRun.length > 0 ||
    !Array.isArray(report.mutants)
  ) {
    return false;
  }
  const before = new Set<string>();
  const after = new Set<string>();
  if (Array.isArray(control.conditionalAssertions)) {
    collectBranches(control.conditionalAssertions, before);
  }
  const postBaseline = object(control.postBaseline);
  if (Array.isArray(postBaseline?.conditionalAssertions)) {
    collectBranches(postBaseline.conditionalAssertions, after);
  }
  return (
    expected.conditionalAssertions.every(
      (id) => before.has(id) && after.has(id)
    ) && validMutants(report.mutants, expected, killed)
  );
};

const validOwnReport = (
  reports: readonly unknown[],
  expected: ControlExpectation
): boolean => {
  const own = reports.filter(
    (report) => object(object(report)?.control)?.adapter === expected.adapter
  );
  if (own.length !== 1) return false;
  const killed = new Set<string>();
  return (
    validReport(own[0], expected, killed) &&
    expected.negativeControls.every((id) => killed.has(id))
  );
};

export const matchesControlRun = (
  value: unknown,
  expected: ControlExpectation
): string | undefined => {
  const document = profileControlReport(
    value,
    expected.profile,
    expected.adapter
  );
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
    adapters.filter((adapter) => adapter.adapter === expected.adapter)
      .length !== 1 ||
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
    validOwnReport(document.reports, expected)
    ? run.id
    : undefined;
};
