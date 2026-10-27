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
    assertions: readonly { assertionId: string; claimIds: readonly string[] }[];
  }[]
): void => {
  const missing = claims.filter(
    (claim) =>
      !(
        undetected[claim]?.trim() ||
        controls.some(
          (control) =>
            control.profiles.includes(profile) &&
            control.claimIds.includes(claim) &&
            (control.kind === "implementation"
              ? (control.designatedAssertions ?? []).some((assertion) =>
                  checks.some((check) =>
                    check.assertions.some(
                      (candidate) =>
                        candidate.assertionId === assertion &&
                        candidate.claimIds.includes(claim)
                    )
                  )
                )
              : (control.expectedRejection?.length ?? 0) > 0)
        )
      )
  );
  if (missing.length > 0) {
    throw new Error(
      `${profile} has claims without a designated detecting control or recorded reason: ${missing.join(", ")}`
    );
  }
};

interface GateReport {
  counted: boolean;
  mutants: readonly { mutantId: string; outcome: string }[];
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
  if (reports.length === 0 || reports.some((report) => !report.counted)) {
    throw new Error(`${profile} negative-control baseline did not pass`);
  }
  for (const id of required) {
    const outcomes = reports.flatMap((report) =>
      report.mutants
        .filter((mutant) => mutant.mutantId === id)
        .map((mutant) => mutant.outcome)
    );
    const bad = outcomes.filter(
      (outcome) => outcome !== "killed" && outcome !== "unsupported"
    );
    if (bad.length > 0 || !outcomes.includes("killed")) {
      throw new Error(
        `${profile} negative control ${id} was not killed across the fleet: ${outcomes.join(", ") || "not run"}`
      );
    }
  }
};
