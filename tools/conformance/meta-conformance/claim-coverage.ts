import { assertionId } from "../harness/assertion-id.js";
import type {
  CompiledConformancePlan,
  ConformancePlanCheck,
} from "../plan-compiler/index.js";

export const claimAssertions = (check: ConformancePlanCheck) => [
  ...check.assertions.map((assertion, index) => ({
    assertionId: assertionId(check.checkId, index, assertion.kind),
    claimIds: check.claimIds ?? [],
    conditional: assertion.when !== undefined,
    detecting: assertion.kind !== "processExit",
  })),
  ...(check.steps ?? []).flatMap((step) =>
    (step.assertions ?? []).map((assertion, index) => ({
      assertionId: assertionId(
        check.checkId,
        index,
        assertion.kind,
        step.stepId
      ),
      claimIds: step.claimIds ?? [],
      conditional: assertion.when !== undefined,
      detecting: assertion.kind !== "processExit",
    }))
  ),
];

export const profileSemanticAssertions = (
  claimIds: readonly string[],
  plans: readonly CompiledConformancePlan[]
): string[] => {
  const claims = new Set(claimIds);
  return plans.flatMap(({ checks }) =>
    checks.flatMap(({ check }) =>
      claimAssertions(check)
        .filter(
          (entry) =>
            entry.detecting && entry.claimIds.some((claim) => claims.has(claim))
        )
        .map((entry) => entry.assertionId)
    )
  );
};

export const profileConditionalAssertions = (
  claimIds: readonly string[],
  plans: readonly CompiledConformancePlan[]
): string[] => {
  const claims = new Set(claimIds);
  return plans.flatMap(({ checks }) =>
    checks.flatMap(({ check }) =>
      claimAssertions(check)
        .filter(
          (entry) =>
            entry.conditional &&
            entry.claimIds.some((claim) => claims.has(claim))
        )
        .map((entry) => entry.assertionId)
    )
  );
};

const collectCheckConditionalGroups = (
  check: ConformancePlanCheck,
  claims: ReadonlySet<string>,
  groups: Map<string, string[]>
): void => {
  const sections = [
    {
      claims: check.claimIds ?? [],
      assertions: check.assertions,
      stepId: undefined,
    },
    ...(check.steps ?? []).map((step) => ({
      claims: step.claimIds ?? [],
      assertions: step.assertions ?? [],
      stepId: step.stepId,
    })),
  ];
  for (const section of sections) {
    if (!section.claims.some((claim) => claims.has(claim))) {
      continue;
    }
    for (const [index, assertion] of section.assertions.entries()) {
      if (assertion.when === undefined) {
        continue;
      }
      const key = JSON.stringify([
        check.checkId,
        section.stepId,
        assertion.when.path,
      ]);
      const group = groups.get(key) ?? [];
      group.push(
        assertionId(check.checkId, index, assertion.kind, section.stepId)
      );
      groups.set(key, group);
    }
  }
};

export const profileConditionalGroups = (
  claimIds: readonly string[],
  plans: readonly CompiledConformancePlan[]
): string[][] => {
  const claims = new Set(claimIds);
  const groups = new Map<string, string[]>();
  for (const { checks } of plans) {
    for (const { check } of checks) {
      collectCheckConditionalGroups(check, claims, groups);
    }
  }
  return [...groups.values()];
};

export interface CoverageControl {
  claimIds: readonly string[];
  designatedAssertions?: readonly string[];
  expectedRejection?: string;
  kind: string;
  mutantId: string;
  profiles: readonly string[];
}

export const assertClaimCoverage = (
  profile: string,
  claims: readonly string[],
  controls: readonly CoverageControl[],
  undetected: Readonly<Record<string, string>>,
  checks: readonly {
    assertions: readonly {
      assertionId: string;
      claimIds: readonly string[];
      detecting?: boolean;
    }[];
  }[],
  killed?: ReadonlyMap<string, readonly string[]>
): void => {
  const known = new Set(claims);
  const unknown = Object.keys(undetected).filter((claim) => !known.has(claim));
  if (unknown.length > 0) {
    throw new Error(
      `${profile} undetected register has unknown claims: ${unknown.join(", ")}`
    );
  }
  const detects = (
    control: CoverageControl,
    claim: string,
    failures?: readonly string[]
  ): boolean =>
    control.profiles.includes(profile) &&
    control.claimIds.includes(claim) &&
    (control.kind === "implementation"
      ? (control.designatedAssertions ?? []).some(
          (assertion) =>
            (failures === undefined || failures.includes(assertion)) &&
            checks.some((check) =>
              check.assertions.some(
                (candidate) =>
                  candidate.assertionId === assertion &&
                  candidate.detecting !== false &&
                  candidate.claimIds.includes(claim)
              )
            )
        )
      : (control.expectedRejection?.length ?? 0) > 0);
  const stale =
    killed === undefined
      ? []
      : Object.keys(undetected).filter((claim) =>
          controls.some((control) => {
            const failures = killed.get(control.mutantId);
            return failures !== undefined && detects(control, claim, failures);
          })
        );
  if (stale.length > 0) {
    throw new Error(
      `${profile} undetected register has stale detected claims: ${stale.join(", ")}`
    );
  }
  const missing = claims.filter(
    (claim) =>
      !(
        (Object.hasOwn(undetected, claim) && undetected[claim]?.trim()) ||
        controls.some((control) => detects(control, claim))
      )
  );
  if (missing.length > 0) {
    throw new Error(
      `${profile} has claims without a designated detecting control or recorded reason: ${missing.join(", ")}`
    );
  }
};

interface GateReport {
  control: { status: string; postBaseline?: { status: string } };
  counted: boolean;
  mutants: readonly { mutantId: string; outcome: string; reason?: string }[];
}

export const assertConditionalBranchCoverage = (
  required: readonly string[],
  fleet: readonly (readonly {
    assertionId: string;
    status: string;
    when?: string;
  }[])[]
): void => {
  const exercised = new Set(
    fleet.flatMap((assertions) =>
      assertions
        .filter(
          (assertion) =>
            assertion.when === "applied" && assertion.status === "pass"
        )
        .map((assertion) => assertion.assertionId)
    )
  );
  const missing = required.filter((assertion) => !exercised.has(assertion));
  if (missing.length > 0) {
    throw new Error(
      `conditional assertions not exercised by a passing fleet run: ${missing.join(", ")}`
    );
  }
};

export const assertNegativeControlGate = (
  profile: string,
  required: readonly string[],
  reports: readonly GateReport[]
): void => {
  if (
    reports.length === 0 ||
    reports.some(
      (report) =>
        !report.counted ||
        report.control.status !== "pass" ||
        report.control.postBaseline?.status !== "pass"
    )
  ) {
    throw new Error(`${profile} negative-control baseline did not pass`);
  }
  for (const id of required) {
    const mutants = reports.flatMap((report) =>
      report.mutants.filter((mutant) => mutant.mutantId === id)
    );
    const outcomes = mutants.map((mutant) => mutant.outcome);
    const bad = mutants.filter(
      (mutant) =>
        mutant.outcome !== "killed" &&
        !(mutant.outcome === "unsupported" && mutant.reason?.trim())
    );
    if (bad.length > 0 || !outcomes.includes("killed")) {
      throw new Error(
        `${profile} negative control ${id} was not killed across the fleet: ${outcomes.join(", ") || "not run"}`
      );
    }
  }
};
