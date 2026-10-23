/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../scripts/conformance/certification-schemas.js";
import type {
  CertificationRuleId,
  CertificationViolation,
  OperationCatalog,
} from "./certification-rules.js";
import {
  CERTIFICATION_RULE_IDS,
  evaluateCertificationRules,
  parseOperationCatalog,
} from "./certification-rules.js";
import type { ConformancePlan } from "./index.js";
import { loadConformancePlan } from "./index.js";

export interface PacketCertificationAuthority {
  catalog?: OperationCatalog;
  /** claimId to the profiles that list it; a listed claim marks its plan migrated. */
  migratedClaims: ReadonlyMap<string, readonly string[]>;
  packetId: string;
  packetPath: string;
}

export interface CertificationAuthority {
  packets: ReadonlyMap<string, PacketCertificationAuthority>;
}

export type CertificationMode = "enforcing" | "report";

export interface PlanCertificationAssessment {
  catalogStatus: "catalogued" | "uncatalogued";
  mode: CertificationMode;
  packetId: string;
  planPath: string;
  port: string;
  profileIds: readonly string[];
  violations: readonly CertificationViolation[];
}

export interface EnforcedViolation {
  planPath: string;
  violation: CertificationViolation;
}

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const SPEC_ROOT = nodePath.resolve(REPO_ROOT, "spec");
const PACKET_FILE_NAME = "authority-packet.json";
const PORT_PATTERN = /(?:^|\/)spec\/conformance\/(?<port>.+)\/plans\/[^/]+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (relativePath: string): Promise<unknown> =>
  JSON.parse(
    await readFile(nodePath.resolve(REPO_ROOT, relativePath), "utf-8")
  ) as unknown;

const findAuthorityPackets = async (): Promise<string[]> => {
  const entries = await readdir(SPEC_ROOT, { recursive: true });

  return entries
    .filter((entry) => nodePath.basename(entry) === PACKET_FILE_NAME)
    .map((entry) =>
      nodePath.relative(REPO_ROOT, nodePath.resolve(SPEC_ROOT, entry))
    )
    .toSorted();
};

const loadMigratedClaims = async (
  profilesPath: string
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const value = await readJson(profilesPath);
  const failures = [
    ...validateCertificationDocument("certificationProfile", value),
    ...collectCertificationIntegrityFailures("certificationProfile", value),
  ];

  if (
    failures.length > 0 ||
    !isRecord(value) ||
    !Array.isArray(value.profiles)
  ) {
    throw new Error(
      `${profilesPath} is not a valid certification profile file: ${failures.join("; ")}`
    );
  }

  const claims = new Map<string, string[]>();

  for (const profile of value.profiles) {
    if (!(isRecord(profile) && Array.isArray(profile.claimIds))) {
      continue;
    }

    for (const claimId of profile.claimIds) {
      const profileIds = claims.get(String(claimId)) ?? [];
      profileIds.push(String(profile.profileId));
      claims.set(String(claimId), profileIds);
    }
  }

  return claims;
};

const loadPacket = async (
  packetPath: string
): Promise<PacketCertificationAuthority> => {
  const packet = await readJson(packetPath);

  if (!(isRecord(packet) && typeof packet.packetId === "string")) {
    throw new Error(`${packetPath} has no packetId`);
  }

  const { packetId } = packet;
  const catalog =
    typeof packet.operationCatalog === "string"
      ? parseOperationCatalog(
          await readJson(packet.operationCatalog),
          packet.operationCatalog
        )
      : undefined;

  if (catalog !== undefined && catalog.packetId !== packetId) {
    throw new Error(
      `${packetPath} references catalog ${catalog.catalogId} for packet ${catalog.packetId}`
    );
  }

  return {
    ...(catalog === undefined ? {} : { catalog }),
    migratedClaims:
      typeof packet.certificationProfiles === "string"
        ? await loadMigratedClaims(packet.certificationProfiles)
        : new Map(),
    packetId,
    packetPath,
  };
};

/** Reads catalogs and profiles through each packet's references; defaults to every packet under spec/. */
export const loadCertificationAuthority = async (
  packetPaths?: readonly string[]
): Promise<CertificationAuthority> => {
  const packets = await Promise.all(
    (packetPaths ?? (await findAuthorityPackets())).map(loadPacket)
  );
  const byId = new Map<string, PacketCertificationAuthority>();

  for (const packet of packets) {
    const existing = byId.get(packet.packetId);

    if (existing !== undefined) {
      throw new Error(
        `${packet.packetPath} repeats packetId ${packet.packetId} from ${existing.packetPath}`
      );
    }

    byId.set(packet.packetId, packet);
  }

  return { packets: byId };
};

const collectPlanClaimIds = (plan: ConformancePlan): Set<string> =>
  new Set(
    plan.checks.flatMap((check) => [
      ...(check.claimIds ?? []),
      ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
    ])
  );

const assessPlan = (
  plan: ConformancePlan,
  planPath: string,
  authority: CertificationAuthority
): PlanCertificationAssessment => {
  const packet = authority.packets.get(plan.packetId);
  const catalog = packet?.catalog;
  const profileIds = new Set<string>();

  for (const claimId of collectPlanClaimIds(plan)) {
    for (const profileId of packet?.migratedClaims.get(claimId) ?? []) {
      profileIds.add(profileId);
    }
  }

  const mode: CertificationMode =
    profileIds.size > 0 || plan.certificationRules === "enforcing"
      ? "enforcing"
      : "report";
  const violations = evaluateCertificationRules(plan, catalog);

  if (mode === "enforcing" && catalog === undefined) {
    violations.unshift({
      message: `packet ${plan.packetId} declares no operationCatalog for a migrated plan`,
      rule: "operation-catalogued",
    });
  }

  return {
    catalogStatus: catalog === undefined ? "uncatalogued" : "catalogued",
    mode,
    packetId: plan.packetId,
    planPath,
    port: PORT_PATTERN.exec(planPath)?.groups?.port ?? plan.packetId,
    profileIds: [...profileIds].toSorted(),
    violations,
  };
};

export const assessConformancePlans = async (
  planPaths: readonly string[],
  authority: CertificationAuthority
): Promise<PlanCertificationAssessment[]> =>
  await Promise.all(
    planPaths.map(async (planPath) => {
      const compiled = await loadConformancePlan(planPath);
      return assessPlan(compiled.plan, planPath, authority);
    })
  );

export const collectEnforcedViolations = (
  assessments: readonly PlanCertificationAssessment[]
): EnforcedViolation[] =>
  assessments
    .filter((assessment) => assessment.mode === "enforcing")
    .flatMap((assessment) =>
      assessment.violations.map((violation) => ({
        planPath: assessment.planPath,
        violation,
      }))
    );

/** Throws only for violations in plans a certification profile marks migrated. */
export const assertCertificationEnforcement = (
  assessments: readonly PlanCertificationAssessment[]
): void => {
  const enforced = collectEnforcedViolations(assessments);

  if (enforced.length > 0) {
    throw new Error(
      `certification rules failed for migrated plans:\n${enforced
        .map(
          ({ planPath, violation }) =>
            `  ${planPath} ${violation.rule}: ${violation.message}`
        )
        .join("\n")}`
    );
  }
};

const countRules = (
  violations: readonly CertificationViolation[]
): Map<CertificationRuleId, number> => {
  const counts = new Map<CertificationRuleId, number>();

  for (const violation of violations) {
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  }

  return counts;
};

const formatRuleCounts = (
  violations: readonly CertificationViolation[]
): string => {
  const counts = countRules(violations);
  const parts = CERTIFICATION_RULE_IDS.filter((rule) => counts.has(rule)).map(
    (rule) => `${rule}=${counts.get(rule) ?? 0}`
  );

  return parts.length === 0 ? "" : ` (${parts.join(" ")})`;
};

const formatPortLine = (
  port: string,
  assessments: readonly PlanCertificationAssessment[]
): string => {
  const violations = assessments.flatMap((assessment) => assessment.violations);
  const uncatalogued = assessments.filter(
    (assessment) => assessment.catalogStatus === "uncatalogued"
  ).length;
  const enforcing = assessments.filter(
    (assessment) => assessment.mode === "enforcing"
  ).length;

  return `  ${port}: plans=${assessments.length} uncatalogued=${uncatalogued} enforcing=${enforcing} violations=${violations.length}${formatRuleCounts(violations)}`;
};

const formatViolation = (violation: CertificationViolation): string =>
  `      ${violation.rule}: ${violation.message}`;

export interface CertificationInventoryOptions {
  /** List each violation under its plan. */
  violations?: boolean;
}

/** Violation counts by port, rule, and plan; a run artifact, never checked in. */
export const formatCertificationInventory = (
  assessments: readonly PlanCertificationAssessment[],
  options: CertificationInventoryOptions = {}
): string => {
  const violations = assessments.flatMap((assessment) => assessment.violations);
  const ports = new Map<string, PlanCertificationAssessment[]>();

  for (const assessment of assessments) {
    ports.set(assessment.port, [
      ...(ports.get(assessment.port) ?? []),
      assessment,
    ]);
  }

  const ruleCounts = countRules(violations);
  const lines = [
    `certification rule inventory: plans=${assessments.length} enforcing=${
      assessments.filter((assessment) => assessment.mode === "enforcing").length
    } uncatalogued=${
      assessments.filter(
        (assessment) => assessment.catalogStatus === "uncatalogued"
      ).length
    } violations=${violations.length}`,
    "by port:",
    ...[...ports.keys()]
      .toSorted()
      .map((port) => formatPortLine(port, ports.get(port) ?? [])),
    "by rule:",
    ...CERTIFICATION_RULE_IDS.map(
      (rule) => `  ${rule}=${ruleCounts.get(rule) ?? 0}`
    ),
    "by plan:",
    ...assessments.flatMap((assessment) => [
      `  ${assessment.planPath} [${assessment.port} ${assessment.catalogStatus} ${assessment.mode}] violations=${assessment.violations.length}${formatRuleCounts(assessment.violations)}`,
      ...(options.violations === true
        ? assessment.violations.map(formatViolation)
        : []),
    ]),
  ];

  return lines.join("\n");
};
