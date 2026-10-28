import {
  createConformanceEvidenceSummary,
  deriveConformanceRunStatus,
} from "../../scripts/lib/conformance-contract.js";
import type { ConformanceEvidence } from "../../scripts/lib/conformance-contract.js";
import type { AdapterManifest } from "../harness/adapter-client.js";
import type { CompiledConformancePlan } from "../plan-compiler/index.js";
import { finishCertificate } from "./bundle.js";
import type { BundleFields } from "./bundle.js";
import type { CertificationProfile } from "./profile.js";
import { computeCertificateDigests } from "./provenance.js";
import type { CertificateDigests } from "./provenance.js";

interface RunOptions {
  adapter: string;
  controlReport?: string;
  capabilities: readonly string[];
  checks: readonly string[];
  packets: readonly string[];
  plans: readonly string[];
  shard?: unknown;
}

export interface ProfileBundle {
  fields: BundleFields;
  evidence: ConformanceEvidence;
  profileId: string;
}

const scopedEvidence = (
  profile: CertificationProfile,
  plans: readonly CompiledConformancePlan[],
  evidence: ConformanceEvidence
): ConformanceEvidence => {
  const claims = new Set(profile.claimIds);
  const checks = new Set(
    plans.flatMap(({ checks }) =>
      checks.flatMap(({ check }) =>
        [
          ...(check.claimIds ?? []),
          ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
        ].some((claim) => claims.has(claim))
          ? [check.checkId]
          : []
      )
    )
  );
  const belongs = (id: string): boolean =>
    checks.has(id) || id.startsWith(`profile.${profile.profileId}.`);
  const selection = (evidence.selection ?? []).map((entry) =>
    belongs(entry.checkId)
      ? entry
      : { checkId: entry.checkId, selected: false, reason: "outside-profile" }
  );
  const checkResults = evidence.checkResults.filter(({ checkId }) =>
    belongs(checkId)
  );
  const nonApplicableCheckIds = selection
    .filter(
      (entry) =>
        !(
          entry.selected ||
          entry.reason === "outside-profile" ||
          entry.reason?.startsWith("not run:")
        )
    )
    .map((entry) => entry.checkId);
  const outsideProfileChecks = selection.filter(
    (entry) => entry.reason === "outside-profile"
  ).length;
  const summary = {
    ...createConformanceEvidenceSummary(checkResults),
    applicableChecks: checkResults.length,
    nonApplicableChecks: nonApplicableCheckIds.length,
    outsideProfileChecks,
    totalChecks:
      checkResults.length + nonApplicableCheckIds.length + outsideProfileChecks,
  };
  return {
    ...evidence,
    checkResults,
    nonApplicableCheckIds,
    selection,
    status: deriveConformanceRunStatus(summary),
    summary,
  };
};

export const finalizeProfileBundles = async (
  options: RunOptions,
  manifest: AdapterManifest,
  profiles: readonly CertificationProfile[],
  plans: readonly CompiledConformancePlan[],
  evidence: ConformanceEvidence,
  before: CertificateDigests | undefined
): Promise<ProfileBundle[]> => {
  const after =
    before === undefined
      ? undefined
      : await computeCertificateDigests(manifest, options.adapter);
  const bundles: ProfileBundle[] = [];
  for (const profile of profiles) {
    const scoped = scopedEvidence(profile, plans, evidence);
    const fields = await finishCertificate(
      options,
      manifest,
      profile,
      plans,
      scoped.checkResults,
      scoped.status,
      before,
      after
    );
    bundles.push({ fields, evidence: scoped, profileId: profile.profileId });
  }
  return bundles;
};
