import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { readClaimedProfiles } from "../../certification/profile.ts";
import {
  assertClaimCoverage,
  claimAssertions,
} from "../../meta-conformance/claim-coverage.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { readAdapterManifest } from "../run-plans.ts";

test("every durable reopen claim has an explicit detection gap and is outside the memory profile", async () => {
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-close-reopen-syscall.json"
  );
  const value: unknown = JSON.parse(
    await readFile(
      "spec/conformance/kernel/kernel-persistent-reopen-undetected.json",
      "utf8"
    )
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid undetected claim register");
  }
  const reasons: Record<string, string> = {};
  for (const [claim, reason] of Object.entries(value)) {
    if (typeof reason !== "string") {
      throw new Error(`invalid reason for ${claim}`);
    }
    reasons[claim] = reason;
  }
  for (const claim of ["pending_state", "pending_count"]) {
    const reason = reasons[`kernel.syscall.reopen.${claim}`];
    expect(reason).toContain(
      "kernel.drop-uncommitted-staged-result-on-recovery"
    );
    expect(reason).toContain("kernel.promote-staged-before-checkpoint");
    expect(reason).toContain("no durable mutant manifest");
    expect(reason).toContain("KRT-DF005");
  }
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const profiles = await readClaimedProfiles(adapter, adapter.authorityPackets);
  const memory = profiles.find(
    (profile) => profile.profileId === "kernel.memory"
  );
  if (memory === undefined) {
    throw new Error("missing memory profile");
  }
  const claims = [
    ...new Set(plan.checks.flatMap(({ check }) => check.claimIds ?? [])),
  ];
  const checks = plan.checks.map(({ check }) => ({
    assertions: claimAssertions(check),
  }));
  expect(claims.length).toBeGreaterThan(0);
  expect(plan.plan.applicability.capabilities).toContain(
    "kernel.persistence.durable"
  );
  expect(claims.every((claim) => claim.startsWith("kernel.syscall."))).toBe(
    true
  );
  expect(claims.every((claim) => !memory.claimIds.includes(claim))).toBe(true);
  expect(() =>
    assertClaimCoverage("kernel.persistent-reopen", claims, [], reasons, checks)
  ).not.toThrow();
  const missing = { ...reasons };
  const claim = claims[0];
  if (claim === undefined) {
    throw new Error("missing reopen claim");
  }
  delete missing[claim];
  expect(() =>
    assertClaimCoverage("kernel.persistent-reopen", claims, [], missing, checks)
  ).toThrow(claim);
});
