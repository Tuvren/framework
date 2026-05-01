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
import { resolve } from "node:path";
import {
  type CompiledConformancePlan,
  loadConformancePlan,
} from "../../../../../../tools/conformance/plan-compiler/index.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../../../..");
const FRAMEWORK_PACKET_PATHS: readonly string[] = [
  "boundaries/framework/contracts/event-stream/spec/authority-packet.json",
  "boundaries/framework/contracts/runtime-api/spec/authority-packet.json",
  "boundaries/framework/contracts/driver-api/spec/authority-packet.json",
  "boundaries/framework/contracts/react-driver/spec/authority-packet.json",
];

interface AuthorityPacketManifest {
  conformancePlans: readonly AuthorityPacketPlanReference[];
}

interface AuthorityPacketPlanReference {
  path: string;
  planId: string;
}

describe("framework TypeScript conformance runner", () => {
  test("loads every framework authority-packet conformance plan", async () => {
    const planPaths = new Set<string>();

    for (const packetPath of FRAMEWORK_PACKET_PATHS) {
      const packet = readAuthorityPacket(packetPath);

      for (const plan of packet.conformancePlans ?? []) {
        planPaths.add(plan.path);
      }
    }

    const compiledPlans: CompiledConformancePlan[] = [];

    for (const planPath of [...planPaths].sort()) {
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

function readAuthorityPacket(path: string): AuthorityPacketManifest {
  const value = JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8"));

  if (!isRecord(value)) {
    throw new Error(`${path} must contain an authority packet object`);
  }

  return {
    conformancePlans: readPlanReferences(value.conformancePlans, path),
  };
}

function readPlanReferences(
  value: unknown,
  label: string
): readonly AuthorityPacketPlanReference[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label}.conformancePlans must be an array when present`);
  }

  return value.map((entry, index) =>
    readPlanReference(entry, `${label}.conformancePlans[${index}]`)
  );
}

function readPlanReference(
  value: unknown,
  label: string
): AuthorityPacketPlanReference {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
