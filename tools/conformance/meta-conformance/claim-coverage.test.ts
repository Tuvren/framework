import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { readClaimedProfiles } from "../certification/profile.ts";
import { readAdapterManifest, readPlans } from "../harness/run-plans.ts";
import {
  assertClaimCoverage,
  assertNegativeControlGate,
} from "./claim-coverage.ts";
import type { CoverageControl } from "./claim-coverage.ts";

test("requires each profile claim to have a designated detector or a recorded reason", () => {
  const controls = [
    {
      claimIds: ["claim.detected"],
      designatedAssertions: ["check.1.resultField"],
      kind: "implementation",
      mutantId: "mutant.a",
      profiles: ["example.profile"],
    },
  ];
  const claims = ["claim.detected", "claim.undetected"];
  const checks = [
    { checkId: "check", claimIds: ["claim.detected"] },
    { checkId: "uncovered", claimIds: ["claim.undetected"] },
  ];
  expect(() =>
    assertClaimCoverage("example.profile", claims, controls, {}, checks)
  ).toThrow("claim.undetected");
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      claims,
      controls,
      {
        "claim.undetected": "No mutant exercises this behavior.",
      },
      checks
    )
  ).not.toThrow();
  expect(() =>
    assertClaimCoverage(
      "other.profile",
      claims,
      controls,
      {
        "claim.undetected": "No mutant exercises this behavior.",
      },
      checks
    )
  ).toThrow("claim.detected");
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.detected"],
      [
        {
          claimIds: ["claim.detected"],
          designatedAssertions: ["different.1.resultField"],
          kind: "implementation",
          mutantId: "mutant.a",
          profiles: ["example.profile"],
        },
      ],
      {},
      checks
    )
  ).toThrow("claim.detected");
});

test("the fleet gate requires a real kill and rejects invalid runs", () => {
  const passing = {
    counted: true,
    mutants: [{ mutantId: "mutant.a", outcome: "killed" }],
  };
  const unsupported = {
    counted: true,
    mutants: [{ mutantId: "mutant.a", outcome: "unsupported" }],
  };
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [passing, unsupported]
    )
  ).not.toThrow();
  expect(() =>
    assertNegativeControlGate("example.profile", ["mutant.a"], [unsupported])
  ).toThrow("mutant.a");
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [
        passing,
        {
          counted: true,
          mutants: [{ mutantId: "mutant.a", outcome: "invalid" }],
        },
      ]
    )
  ).toThrow("invalid");
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [{ ...passing, counted: false }]
    )
  ).toThrow("baseline");
});

test("the kernel profile accounts for its actual controls and recorded gaps", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const [profile] = await readClaimedProfiles(
    adapter,
    adapter.authorityPackets
  );
  if (profile === undefined) {
    throw new Error("memory profile was not loaded");
  }
  const manifest = JSON.parse(
    await readFile("spec/conformance/kernel/negative-controls.json", "utf-8")
  ) as { controls: CoverageControl[] };
  const reasons = JSON.parse(
    await readFile(
      "tools/conformance/meta-conformance/kernel-memory-undetected.json",
      "utf-8"
    )
  ) as Record<string, string>;
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const checks = plans.flatMap((plan) =>
    plan.checks.map(({ check }) => ({
      checkId: check.checkId,
      claimIds: [
        ...(check.claimIds ?? []),
        ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
      ],
    }))
  );
  expect(() =>
    assertClaimCoverage(
      profile.profileId,
      profile.claimIds,
      manifest.controls,
      reasons,
      checks
    )
  ).not.toThrow();
  const firstGap = Object.keys(reasons)[0];
  if (firstGap === undefined) {
    throw new Error("expected the recorded undetected claims");
  }
  const incomplete = { ...reasons };
  delete incomplete[firstGap];
  expect(() =>
    assertClaimCoverage(
      profile.profileId,
      profile.claimIds,
      manifest.controls,
      incomplete,
      checks
    )
  ).toThrow(firstGap);
});
