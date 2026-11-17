import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../scripts/conformance/certification-schemas.js";
import type { AdapterManifest } from "../harness/adapter-client.js";
import { needsServerClock } from "../harness/check-selection.js";
import type {
  CompiledConformancePlan,
  ConformancePlanCheck,
} from "../plan-compiler/index.js";

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

export const readProfileAuthority = async (
  manifest: AdapterManifest,
  packetPaths: readonly string[]
): Promise<ReadonlyMap<string, readonly CertificationProfile[]>> => {
  const byPacket = new Map<string, readonly CertificationProfile[]>();
  for (const path of packetPaths) {
    const packet = await readJson(path);
    if (!isRecord(packet) || typeof packet.certificationProfiles !== "string") {
      continue;
    }
    if (typeof packet.packetId !== "string" || byPacket.has(packet.packetId)) {
      throw new Error(`${path}: missing or duplicate packetId`);
    }
    const document = await readJson(packet.certificationProfiles);
    if (
      !(isRecord(document) && Array.isArray(document.profiles)) ||
      document.profiles.length === 0
    ) {
      throw new Error(`${packet.certificationProfiles}: invalid profiles`);
    }
    const ids = document.profiles.map((profile: unknown) => {
      if (!isRecord(profile) || typeof profile.profileId !== "string") {
        throw new Error(`${packet.certificationProfiles}: invalid profile`);
      }
      return profile.profileId;
    });
    const profiles = await readClaimedProfiles({ ...manifest, profiles: ids }, [
      path,
    ]);
    byPacket.set(packet.packetId, profiles);
  }
  return byPacket;
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

const profilePacket = (
  profile: CertificationProfile,
  authority: ReadonlyMap<string, readonly CertificationProfile[]>
): readonly [string, readonly CertificationProfile[]] => {
  const packets = [...authority].filter(([, profiles]) =>
    profiles.some((entry) => entry.profileId === profile.profileId)
  );
  const packet = packets[0];
  if (packets.length !== 1 || packet === undefined) {
    throw new Error(`${profile.profileId} has no unique profile authority`);
  }
  return [
    packet[0],
    packet[1].map((entry) =>
      entry.profileId === profile.profileId ? profile : entry
    ),
  ];
};

const checkOwner = (
  check: ConformancePlanCheck,
  planCapabilities: readonly string[],
  profiles: readonly CertificationProfile[]
): CertificationProfile | undefined => {
  const required = [
    ...planCapabilities,
    ...(check.capabilities ?? []),
    ...(needsServerClock(check.steps) ? ["clock.backend-server"] : []),
  ];
  const applicable = profiles.filter((entry) =>
    required.every((capability) =>
      entry.requiredCapabilities.includes(capability)
    )
  );
  if (applicable.length === 0) {
    return undefined;
  }
  const core = applicable.find((entry) => entry.profileId === "kernel.memory");
  if (core !== undefined) {
    return core;
  }
  const minimal = applicable.filter(
    (entry) =>
      !applicable.some(
        (other) =>
          other !== entry &&
          other.requiredCapabilities.length <
            entry.requiredCapabilities.length &&
          other.requiredCapabilities.every((capability) =>
            entry.requiredCapabilities.includes(capability)
          )
      )
  );
  const owner = minimal[0];
  if (minimal.length !== 1 || owner === undefined) {
    throw new Error(
      `${check.checkId} has ambiguous profile ownership: ${minimal.map((entry) => entry.profileId).join(", ")}`
    );
  }
  return owner;
};

const addOwnedClaims = (
  claims: readonly string[],
  owner: CertificationProfile,
  profileId: string,
  claimOwners: Map<string, string>,
  expected: Set<string>
): void => {
  for (const claim of claims) {
    const previous = claimOwners.get(claim);
    if (previous !== undefined && previous !== owner.profileId) {
      throw new Error(
        `${claim} has conflicting profile ownership: ${previous}, ${owner.profileId}`
      );
    }
    claimOwners.set(claim, owner.profileId);
    if (owner.profileId === profileId) {
      expected.add(claim);
    }
  }
};

const expectedProfileClaims = (
  profile: CertificationProfile,
  plans: readonly CompiledConformancePlan[],
  authority: ReadonlyMap<string, readonly CertificationProfile[]>
): Set<string> => {
  const [packetId, profiles] = profilePacket(profile, authority);
  const expected = new Set<string>();
  const claimOwners = new Map<string, string>();
  for (const plan of plans) {
    if (plan.plan.packetId !== packetId) {
      continue;
    }
    for (const { check } of plan.checks) {
      const claims = [
        ...(check.claimIds ?? []),
        ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
      ];
      if (claims.length === 0) {
        continue;
      }
      const owner = checkOwner(
        check,
        plan.plan.applicability.capabilities,
        profiles
      );
      if (owner === undefined) {
        continue;
      }
      addOwnedClaims(claims, owner, profile.profileId, claimOwners, expected);
    }
  }
  return expected;
};

export const assertProfileClaimInventory = (
  profile: CertificationProfile,
  plans: readonly CompiledConformancePlan[],
  authority: ReadonlyMap<string, readonly CertificationProfile[]>
): void => {
  const expected = expectedProfileClaims(profile, plans, authority);
  const declared = new Set(profile.claimIds);
  const missing = [...expected].filter((claim) => !declared.has(claim));
  const unknown = [...declared].filter((claim) => !expected.has(claim));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${profile.profileId} claim inventory mismatch: missing ${missing.join(", ") || "none"}; unknown ${unknown.join(", ") || "none"}`
    );
  }
};

export const readProfileScopedControls = async (
  manifest: AdapterManifest,
  profile: Pick<CertificationProfile, "profileId" | "claimIds">
): Promise<string[]> => {
  const scoped = new Set<string>();
  for (const packetPath of manifest.authorityPackets) {
    const packet = await readJson(packetPath);
    if (
      !isRecord(packet) ||
      typeof packet.negativeControlManifest !== "string"
    ) {
      continue;
    }
    const document = await readJson(packet.negativeControlManifest);
    const errors = [
      ...validateCertificationDocument("negativeControlManifest", document),
      ...collectCertificationIntegrityFailures(
        "negativeControlManifest",
        document
      ),
    ];
    if (
      errors.length > 0 ||
      !isRecord(document) ||
      !Array.isArray(document.controls)
    ) {
      throw new Error("invalid negative-control manifest");
    }
    for (const control of document.controls) {
      if (
        isRecord(control) &&
        typeof control.mutantId === "string" &&
        strings(control.profiles).includes(profile.profileId) &&
        strings(control.claimIds).some((claim) =>
          profile.claimIds.includes(claim)
        )
      ) {
        scoped.add(control.mutantId);
      }
    }
  }
  return [...scoped];
};
