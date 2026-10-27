import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../scripts/conformance/certification-schemas.js";
import type { AdapterManifest } from "../harness/adapter-client.js";
import type { CompiledConformancePlan } from "../plan-compiler/index.js";

export interface CertificationProfile {
  claimIds: string[];
  faultPoints: string[];
  negativeControls: string[];
  profileId: string;
  requiredCapabilities: string[];
  requiredEvidence: string[];
}

const ROOT = nodePath.resolve(import.meta.dirname, "../../..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(nodePath.resolve(ROOT, path), "utf-8"));

export const readClaimedProfiles = async (
  manifest: AdapterManifest,
  packetPaths: readonly string[]
): Promise<CertificationProfile[]> => {
  if ((manifest.profiles ?? []).length === 0) {
    return [];
  }
  const profiles = new Map<string, CertificationProfile>();
  for (const path of packetPaths) {
    const packet = await readJson(path);
    if (!isRecord(packet) || typeof packet.certificationProfiles !== "string") {
      continue;
    }
    const document = await readJson(packet.certificationProfiles);
    const errors = [
      ...validateCertificationDocument("certificationProfile", document),
      ...collectCertificationIntegrityFailures(
        "certificationProfile",
        document
      ),
    ];
    if (
      errors.length > 0 ||
      !isRecord(document) ||
      !Array.isArray(document.profiles)
    ) {
      throw new Error(
        `${packet.certificationProfiles}: invalid profiles: ${errors.join("; ")}`
      );
    }
    for (const value of document.profiles) {
      if (!isRecord(value) || typeof value.profileId !== "string") {
        throw new Error(`${packet.certificationProfiles}: invalid profile`);
      }
      if (profiles.has(value.profileId)) {
        throw new Error(`duplicate claimed profile ${value.profileId}`);
      }
      profiles.set(value.profileId, {
        claimIds: strings(value.claimIds),
        faultPoints: strings(value.faultPoints),
        negativeControls: strings(value.negativeControls),
        profileId: value.profileId,
        requiredCapabilities: strings(value.requiredCapabilities),
        requiredEvidence: strings(value.requiredEvidence),
      });
    }
  }
  return (manifest.profiles ?? []).map((id) => {
    const profile = profiles.get(id);
    if (profile === undefined) {
      throw new Error(
        `claimed profile ${id} is not declared by the loaded authority packets`
      );
    }
    return profile;
  });
};

export interface ProfileSelectionFailure {
  profileId: string;
  requiredCheckId: string;
  reason: string;
}

export const findProfileSelectionFailures = (
  profiles: readonly CertificationProfile[],
  plans: readonly CompiledConformancePlan[],
  selection: readonly { checkId: string; selected: boolean; reason?: string }[]
): ProfileSelectionFailure[] => {
  const byId = new Map(selection.map((entry) => [entry.checkId, entry]));
  const violations: ProfileSelectionFailure[] = [];
  for (const profile of profiles) {
    const claims = new Set(profile.claimIds);
    for (const plan of plans) {
      for (const { check } of plan.checks) {
        const required = [
          ...(check.claimIds ?? []),
          ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
        ].some((id) => claims.has(id));
        const entry = byId.get(check.checkId);
        if (
          required &&
          entry !== undefined &&
          !entry.selected &&
          !entry.reason?.startsWith("not run:") &&
          !entry.reason?.startsWith("outside requested capabilities:")
        ) {
          violations.push({
            profileId: profile.profileId,
            requiredCheckId: check.checkId,
            reason: entry.reason ?? "unknown reason",
          });
        }
      }
    }
  }
  return violations;
};

export const assertProfileCapabilities = (
  profiles: readonly CertificationProfile[],
  capabilities: readonly string[],
  complete: boolean
): void => {
  if (!complete) {
    return;
  }
  const available = new Set(capabilities);
  for (const profile of profiles) {
    const missing = profile.requiredCapabilities.filter(
      (capability) => !available.has(capability)
    );
    if (missing.length > 0) {
      throw new Error(
        `claimed profile ${profile.profileId} requires capabilities: ${missing.join(", ")}`
      );
    }
  }
};

export const assertKernelMemoryClaimInventory = (
  profile: CertificationProfile,
  plans: readonly CompiledConformancePlan[]
): void => {
  const expected = new Set(
    plans
      .filter((plan) =>
        plan.plan.applicability.capabilities.includes("kernel.syscall")
      )
      .flatMap((plan) =>
        plan.checks.flatMap(({ check }) => [
          ...(check.claimIds ?? []),
          ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
        ])
      )
  );
  const declared = new Set(profile.claimIds);
  const missing = [...expected].filter((claim) => !declared.has(claim));
  const unknown = [...declared].filter((claim) => !expected.has(claim));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${profile.profileId} claim inventory mismatch: missing ${missing.join(", ") || "none"}; unknown ${unknown.join(", ") || "none"}`
    );
  }
};
