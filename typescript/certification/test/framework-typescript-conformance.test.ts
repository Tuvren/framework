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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadConformancePlan } from "../../../tools/conformance/plan-compiler/index.js";
import type { CompiledConformancePlan } from "../../../tools/conformance/plan-compiler/index.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const FRAMEWORK_PACKET_PATHS: readonly string[] = [
  "spec/core/authority-packet.json",
  "spec/streaming/sse/authority-packet.json",
  "spec/runners/react/authority-packet.json",
  "spec/host/session/authority-packet.json",
];

interface AuthorityPacketManifest {
  conformancePlans: readonly AuthorityPacketPlanReference[];
}

interface AuthorityPacketPlanReference {
  path: string;
  planId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPlanReference = (
  value: unknown,
  label: string
): AuthorityPacketPlanReference => {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.planId !== "string"
  ) {
    throw new Error(`${label} must contain planId and path strings`);
  }

  return {
    path: value.path,
    planId: value.planId,
  };
};

const readPlanReferences = (
  value: unknown,
  label: string
): readonly AuthorityPacketPlanReference[] => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError(
      `${label}.conformancePlans must be an array when present`
    );
  }

  return value.map((entry, index) =>
    readPlanReference(entry, `${label}.conformancePlans[${index}]`)
  );
};

const readAuthorityPacket = (
  authorityPath: string
): AuthorityPacketManifest => {
  const value: unknown = JSON.parse(
    readFileSync(path.resolve(REPO_ROOT, authorityPath), "utf-8")
  );

  if (!isRecord(value)) {
    throw new Error(`${authorityPath} must contain an authority packet object`);
  }

  return {
    conformancePlans: readPlanReferences(value.conformancePlans, authorityPath),
  };
};

describe("framework TypeScript certification", () => {
  test("loads every framework authority-packet conformance plan", async () => {
    const planPaths = new Set<string>();

    for (const packetPath of FRAMEWORK_PACKET_PATHS) {
      const packet = readAuthorityPacket(packetPath);

      for (const plan of packet.conformancePlans ?? []) {
        planPaths.add(plan.path);
      }
    }

    const compiledPlans: CompiledConformancePlan[] = [];

    for (const planPath of [...planPaths].toSorted()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Compile plans sequentially to preserve deterministic validation and first-failure order.
      compiledPlans.push(await loadConformancePlan(planPath));
    }

    // This test intentionally checks runner coverage mechanics only. Product
    // expectations are asserted by the boundary-owned plans loaded above.
    expect(compiledPlans.length).toBe(planPaths.size);
    expect(compiledPlans.every((plan) => plan.plan.checks.length > 0)).toBe(
      true
    );
  });
});
