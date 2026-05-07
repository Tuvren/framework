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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findConformancePlans, loadConformancePlan } from "./index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OPERATION_SOURCE_BY_PACKET = new Map<string, readonly string[]>([
  [
    "tuvren.framework.runtime-api",
    ["boundaries/framework/contracts/runtime-api/spec/typespec/main.tsp"],
  ],
  [
    "tuvren.framework.driver-api",
    ["boundaries/framework/contracts/driver-api/spec/typespec/main.tsp"],
  ],
  [
    "tuvren.framework.event-stream",
    ["boundaries/framework/conformance/plans/event-stream-core.json"],
  ],
  [
    "tuvren.framework.react-driver",
    ["boundaries/framework/contracts/driver-api/spec/typespec/main.tsp"],
  ],
  [
    "tuvren.kernel.protocol",
    [
      "boundaries/kernel/conformance/plans/kernel-protocol-core.json",
      "boundaries/kernel/conformance/plans/kernel-protocol-extended.json",
      "boundaries/kernel/conformance/plans/kernel-run-liveness.json",
      "boundaries/kernel/conformance/plans/kernel-restart-recovery.json",
    ],
  ],
  [
    "tuvren.providers.provider-api",
    ["boundaries/providers/conformance/plans/provider-api-bridge.json"],
  ],
]);
const OPERATION_LITERAL_PATTERN =
  /"(?:runtime|driver|event-stream|kernel|providers)\.[a-z0-9_.-]+"/gu;

const planPaths = await findConformancePlans();
const operationCache = new Map<string, Promise<ReadonlySet<string>>>();

for (const planPath of planPaths) {
  const compiledPlan = await loadConformancePlan(planPath);
  const declaredOperations =
    operationCache.get(compiledPlan.plan.packetId) ??
    readDeclaredOperations(compiledPlan.plan.packetId);
  operationCache.set(compiledPlan.plan.packetId, declaredOperations);

  for (const check of compiledPlan.checks) {
    if (check.requiredEvidence.length === 0) {
      throw new Error(
        `${planPath} check ${check.check.checkId} has no required evidence`
      );
    }

    const operations = await declaredOperations;

    if (operations.size > 0 && !operations.has(check.check.operation)) {
      throw new Error(
        `${planPath} check ${check.check.checkId} uses undeclared operation ${check.check.operation}`
      );
    }

    for (const step of check.check.steps ?? []) {
      if (operations.size > 0 && !operations.has(step.operation)) {
        throw new Error(
          `${planPath} check ${check.check.checkId} step ${step.stepId} uses undeclared operation ${step.operation}`
        );
      }
    }
  }
}

console.log(
  `conformance plan validation passed (${planPaths.length} plan${
    planPaths.length === 1 ? "" : "s"
  })`
);

async function readDeclaredOperations(
  packetId: string
): Promise<ReadonlySet<string>> {
  const sourcePaths = OPERATION_SOURCE_BY_PACKET.get(packetId);

  if (sourcePaths === undefined) {
    return new Set<string>();
  }

  const operations = new Set<string>();

  for (const sourcePath of sourcePaths) {
    const source = await readFile(resolve(REPO_ROOT, sourcePath), "utf8");

    for (const match of source.matchAll(OPERATION_LITERAL_PATTERN)) {
      const [literal] = match;
      operations.add(literal.slice(1, -1));
    }
  }

  return operations;
}
