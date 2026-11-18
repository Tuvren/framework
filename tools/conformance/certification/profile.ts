import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../scripts/conformance/certification-schemas.js";
import { parseObservationJson } from "../../scripts/conformance/observation-encoding.js";
import type { UndetectedClaim } from "../../scripts/lib/conformance-contract.js";
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
const DRIVE_LETTER = /^[A-Za-z]:/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(nodePath.resolve(ROOT, path), "utf-8"));

const readPacketProfiles = async (
  packet: Record<string, unknown>
): Promise<CertificationProfile[]> => {
  if (typeof packet.certificationProfiles !== "string") {
    return [];
  }
  const document = await readJson(packet.certificationProfiles);
  const errors = [
    ...validateCertificationDocument("certificationProfile", document),
    ...collectCertificationIntegrityFailures("certificationProfile", document),
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
  return document.profiles.map((value: unknown) => {
    if (!isRecord(value) || typeof value.profileId !== "string") {
      throw new Error(`${packet.certificationProfiles}: invalid profile`);
    }
    return {
      claimIds: strings(value.claimIds),
      faultPoints: strings(value.faultPoints),
      negativeControls: strings(value.negativeControls),
      profileId: value.profileId,
      requiredCapabilities: strings(value.requiredCapabilities),
      requiredEvidence: strings(value.requiredEvidence),
    };
  });
};

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
    if (!isRecord(packet)) {
      continue;
    }
    for (const profile of await readPacketProfiles(packet)) {
      if (profiles.has(profile.profileId)) {
        throw new Error(`duplicate claimed profile ${profile.profileId}`);
      }
      profiles.set(profile.profileId, profile);
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
    byPacket.set(packet.packetId, await readPacketProfiles(packet));
  }
  return byPacket;
};

export const readUndetectedRegisterReferences = async (
  packetPath: string
): Promise<ReadonlyMap<string, string>> => {
  const packet = await readJson(packetPath);
  if (!isRecord(packet)) {
    throw new Error(`${packetPath}: invalid packet`);
  }
  const profiles = await readPacketProfiles(packet);
  if (profiles.length === 0 && packet.undetectedRegisters === undefined) {
    return new Map();
  }
  const references = packet.undetectedRegisters;
  if (!isRecord(references)) {
    throw new Error(`${packetPath}: missing undetectedRegisters`);
  }
  const ids = new Set(profiles.map((profile) => profile.profileId));
  const missing = [...ids].filter((id) => !Object.hasOwn(references, id));
  const unknown = Object.keys(references).filter((id) => !ids.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${packetPath}: undetectedRegisters mismatch: missing ${missing.join(", ") || "none"}; unknown ${unknown.join(", ") || "none"}`
    );
  }
  const result = new Map<string, string>();
  for (const [id, value] of Object.entries(references)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      nodePath.isAbsolute(value) ||
      value.includes("\\") ||
      DRIVE_LETTER.test(value) ||
      value.split("/").includes("..")
    ) {
      throw new Error(
        `${packetPath}: ${id} register path must be repository-relative`
      );
    }
    result.set(id, value);
  }
  return result;
};

export const readUndetectedRegister = async (
  packetPath: string,
  profileId: string
): Promise<Record<string, string>> => {
  const references = await readUndetectedRegisterReferences(packetPath);
  const registerPath = references.get(profileId);
  if (registerPath === undefined) {
    throw new Error(`${packetPath}: no undetected register for ${profileId}`);
  }
  const value = parseObservationJson(
    await readFile(nodePath.resolve(ROOT, registerPath), "utf-8")
  );
  const errors = validateCertificationDocument("undetectedRegister", value);
  if (errors.length > 0 || !isRecord(value)) {
    throw new Error(
      `${registerPath}: invalid undetected register: ${errors.join("; ")}`
    );
  }
  const reasons: Record<string, string> = {};
  for (const [claim, reason] of Object.entries(value)) {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(`${registerPath}: invalid reason for ${claim}`);
    }
    Object.defineProperty(reasons, claim, {
      value: reason,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return reasons;
};

/** Resolve a profile's one packet-owned register and preserve each reason verbatim. */
export const readProfileUndetectedClaims = async (
  packetPaths: readonly string[],
  profile: Pick<CertificationProfile, "profileId" | "claimIds">
): Promise<UndetectedClaim[]> => {
  const owners: string[] = [];
  for (const packetPath of packetPaths) {
    if (
      (await readUndetectedRegisterReferences(packetPath)).has(
        profile.profileId
      )
    ) {
      owners.push(packetPath);
    }
  }
  const owner = owners[0];
  if (owners.length !== 1 || owner === undefined) {
    throw new Error(
      `${profile.profileId} has no unique undetected register authority`
    );
  }
  const register = await readUndetectedRegister(owner, profile.profileId);
  const known = new Set(profile.claimIds);
  const unknown = Object.keys(register).filter((claim) => !known.has(claim));
  if (unknown.length > 0) {
    throw new Error(
      `${profile.profileId} undetected register has unknown claims: ${unknown.join(", ")}`
    );
  }
  return Object.entries(register)
    .toSorted(([left], [right]) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    })
    .map(([claimId, reason]) => ({ claimId, reason }));
};

/** Compare as a claim-to-reason mapping, rejecting duplicates and extra fields. */
export const assertUndetectedClaimsMatch = (
  value: unknown,
  expected: readonly UndetectedClaim[],
  label: string
): void => {
  if (!Array.isArray(value)) {
    throw new Error(
      `${label} undetectedClaims must be an array matching the register`
    );
  }
  const expectedByClaim = new Map(
    expected.map(({ claimId, reason }) => [claimId, reason])
  );
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.claimId !== "string" ||
      typeof entry.reason !== "string" ||
      seen.has(entry.claimId) ||
      expectedByClaim.get(entry.claimId) !== entry.reason
    ) {
      throw new Error(
        `${label} undetectedClaims do not match the profile register`
      );
    }
    seen.add(entry.claimId);
  }
  if (seen.size !== expectedByClaim.size) {
    throw new Error(
      `${label} undetectedClaims do not match the profile register`
    );
  }
};

/** Validate a certificate against the unique register selected by its packets. */
export const assertCertificateUndetectedClaims = async (
  value: unknown,
  packetPaths: readonly string[],
  profile: Pick<CertificationProfile, "profileId" | "claimIds">
): Promise<UndetectedClaim[]> => {
  if (
    !(isRecord(value) && isRecord(value.certificate)) ||
    value.certificate.profile !== profile.profileId
  ) {
    throw new Error(
      `certificate does not identify profile ${profile.profileId}`
    );
  }
  const expected = await readProfileUndetectedClaims(packetPaths, profile);
  assertUndetectedClaimsMatch(
    value.undetectedClaims,
    expected,
    profile.profileId
  );
  return expected;
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

const checkClaims = (
  check: ConformancePlanCheck,
  codecPlan: boolean
): string[] => {
  const claims = [
    ...(check.claimIds ?? []),
    ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
  ];
  if (claims.length === 0 && codecPlan) {
    throw new Error(`${check.checkId} requires codec claimIds`);
  }
  return claims;
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
      const codecPlan =
        plan.plan.applicability.capabilities.includes("kernel.codec");
      const claims = checkClaims(check, codecPlan);
      if (claims.length === 0) {
        continue;
      }
      const owner = checkOwner(
        check,
        plan.plan.applicability.capabilities,
        profiles
      );
      if (owner === undefined && codecPlan) {
        throw new Error(
          `${check.checkId} has no profile owner; kernel.memory requires kernel.codec`
        );
      }
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
