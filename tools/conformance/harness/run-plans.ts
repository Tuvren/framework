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

import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assessConformancePlan,
  assertCertificationEnforcement,
  loadCertificationAuthority,
} from "../plan-compiler/certification-assessment.js";
import { loadConformancePlan } from "../plan-compiler/index.js";
import type { CompiledConformancePlan } from "../plan-compiler/index.js";
import type { AdapterManifest } from "./adapter-client.js";

interface AuthorityPacketManifest {
  conformancePlans?: {
    path: string;
    planId: string;
    planVersion: string;
  }[];
  operationCatalog?: string;
  packetId: string;
}

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const ADAPTER_MANIFEST_SCHEMA_PATH = nodePath.resolve(
  REPO_ROOT,
  "tools/conformance/adapter-protocol/adapter-manifest.schema.json"
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonSchema = (value: unknown, label: string): AnySchema => {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
};

const createAdapterManifestValidator = async (): Promise<
  ValidateFunction<AdapterManifest>
> => {
  const schema = readJsonSchema(
    JSON.parse(
      await readFile(ADAPTER_MANIFEST_SCHEMA_PATH, "utf-8")
    ) as unknown,
    ADAPTER_MANIFEST_SCHEMA_PATH
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile<AdapterManifest>(schema);
};

export const readAdapterManifest = async (
  path: string
): Promise<AdapterManifest> => {
  const absolutePath = nodePath.resolve(REPO_ROOT, path);
  const value = JSON.parse(await readFile(absolutePath, "utf-8")) as unknown;
  const validate = await createAdapterManifestValidator();

  if (!validate(value)) {
    throw new Error(
      `${path} failed adapter manifest validation: ${validate.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
        .join("; ")}`
    );
  }

  return value;
};

const isAuthorityPacketManifest = (
  value: unknown
): value is AuthorityPacketManifest =>
  isRecord(value) &&
  typeof value.packetId === "string" &&
  (value.conformancePlans === undefined ||
    (Array.isArray(value.conformancePlans) &&
      value.conformancePlans.every(
        (entry: unknown) =>
          isRecord(entry) &&
          typeof entry.path === "string" &&
          typeof entry.planId === "string" &&
          typeof entry.planVersion === "string"
      )));

const readAuthorityPacket = async (
  path: string
): Promise<AuthorityPacketManifest> => {
  const value: unknown = JSON.parse(
    await readFile(nodePath.resolve(REPO_ROOT, path), "utf-8")
  );
  if (!isAuthorityPacketManifest(value)) {
    throw new Error(`${path} must contain an authority packet manifest`);
  }
  return value;
};

export const readPlans = async (
  adapterManifest: AdapterManifest,
  options: { packets: readonly string[]; plans: readonly string[] }
): Promise<CompiledConformancePlan[]> => {
  const planPaths = new Set(options.plans);
  const packetPaths =
    options.packets.length > 0
      ? options.packets
      : adapterManifest.authorityPackets;

  const visitPacket = async (index: number): Promise<void> => {
    const packetPath = packetPaths[index];
    if (packetPath === undefined) {
      return;
    }
    const packet = await readAuthorityPacket(packetPath);

    for (const plan of packet.conformancePlans ?? []) {
      planPaths.add(plan.path);
    }
    await visitPacket(index + 1);
  };
  await visitPacket(0);
  const authority = await loadCertificationAuthority(packetPaths);

  const plans: CompiledConformancePlan[] = [];

  const sortedPaths = [...planPaths].toSorted();
  const visitPlan = async (index: number): Promise<void> => {
    const planPath = sortedPaths[index];
    if (planPath === undefined) {
      return;
    }
    const compiled = await loadConformancePlan(planPath);
    const catalog = authority.packets.get(compiled.plan.packetId)?.catalog;
    if (catalog === undefined) {
      const enforcementAuthority = authority.packets.has(compiled.plan.packetId)
        ? authority
        : await loadCertificationAuthority();
      if (
        assessConformancePlan(compiled.plan, planPath, enforcementAuthority)
          .mode === "enforcing"
      ) {
        throw new Error(
          `verification: enforcing plan ${compiled.plan.planId} requires the operation catalog for packet ${compiled.plan.packetId}; load its authority packet`
        );
      }
    }
    const assessment = assessConformancePlan(
      compiled.plan,
      planPath,
      authority
    );
    assertCertificationEnforcement([
      {
        ...assessment,
        violations: assessment.violations.filter(
          (violation) => violation.rule === "control-input"
        ),
      },
    ]);
    plans.push({ ...compiled, catalog });
    await visitPlan(index + 1);
  };
  await visitPlan(0);

  return plans;
};
