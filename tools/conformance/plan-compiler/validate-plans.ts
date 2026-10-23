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

import { assertCertificationSchemaContracts } from "../../scripts/conformance/certification-schema-examples.js";
import {
  assertCertificationEnforcement,
  assessConformancePlans,
  collectEnforcedViolations,
  formatCertificationInventory,
  loadCertificationAuthority,
} from "./certification-assessment.js";
import type { CertificationAuthority } from "./certification-assessment.js";
import type { CompiledConformancePlanCheck } from "./index.js";
import { findConformancePlans, loadConformancePlan } from "./index.js";

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const ENFORCEMENT_FIXTURE_DIR =
  "tools/conformance/plan-compiler/__fixtures__/certification";
const ENFORCEMENT_FIXTURE_VIOLATING = `${ENFORCEMENT_FIXTURE_DIR}/migrated-violating-plan.json`;
const OPERATION_SOURCE_BY_PACKET = new Map<string, readonly string[]>([
  ["tuvren.framework.react-runner", ["spec/runners/typespec/main.tsp"]],
  [
    "tuvren.kernel.protocol",
    [
      "spec/conformance/kernel/plans/kernel-protocol-core.json",
      "spec/conformance/kernel/plans/kernel-protocol-extended.json",
      "spec/conformance/kernel/plans/kernel-run-liveness.json",
      "spec/conformance/kernel/plans/kernel-restart-recovery.json",
      "spec/conformance/kernel/plans/kernel-scope-isolation.json",
      "spec/conformance/kernel/plans/kernel-reclamation.json",
    ],
  ],
  [
    "tuvren.providers.provider-api",
    [
      "spec/conformance/providers/plans/provider-api-bridge.json",
      "spec/conformance/providers/plans/provider-native-execution-class.json",
      "spec/conformance/providers/plans/provider-mediated-execution-class.json",
      "spec/conformance/providers/plans/provider-api-conversation-state.json",
    ],
  ],
]);
const OPERATION_LITERAL_PATTERN =
  /"(?:runtime|runner|event-stream|kernel|providers)\.[a-z0-9_.-]+"/gu;

const readDeclaredOperations = async (
  packetId: string,
  authority: CertificationAuthority
): Promise<ReadonlySet<string>> => {
  const operations = new Set(
    authority.packets.get(packetId)?.catalog?.operations.keys()
  );
  const sourcePaths = OPERATION_SOURCE_BY_PACKET.get(packetId) ?? [];

  const visit = async (index: number): Promise<void> => {
    const sourcePath = sourcePaths[index];
    if (sourcePath === undefined) {
      return;
    }
    const source = await readFile(
      nodePath.resolve(REPO_ROOT, sourcePath),
      "utf-8"
    );

    for (const match of source.matchAll(OPERATION_LITERAL_PATTERN)) {
      const [literal] = match;
      operations.add(literal.slice(1, -1));
    }
    await visit(index + 1);
  };
  await visit(0);

  return operations;
};

const validateChecks = async (
  planPath: string,
  checks: readonly CompiledConformancePlanCheck[],
  declaredOperations: Promise<ReadonlySet<string>>,
  index: number
): Promise<void> => {
  const check = checks[index];
  if (check === undefined) {
    return;
  }
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
  await validateChecks(planPath, checks, declaredOperations, index + 1);
};

const validatePlans = async (
  planPaths: readonly string[],
  operationCache: Map<string, Promise<ReadonlySet<string>>>,
  authority: CertificationAuthority,
  index: number
): Promise<void> => {
  const planPath = planPaths[index];
  if (planPath === undefined) {
    return;
  }
  const compiledPlan = await loadConformancePlan(planPath);
  const declaredOperations =
    operationCache.get(compiledPlan.plan.packetId) ??
    readDeclaredOperations(compiledPlan.plan.packetId, authority);
  operationCache.set(compiledPlan.plan.packetId, declaredOperations);
  await validateChecks(planPath, compiledPlan.checks, declaredOperations, 0);
  await validatePlans(planPaths, operationCache, authority, index + 1);
};

const planPaths = await findConformancePlans();
const authority = await loadCertificationAuthority();
await validatePlans(planPaths, new Map(), authority, 0);

console.log(
  `conformance plan validation passed (${planPaths.length} plan${
    planPaths.length === 1 ? "" : "s"
  })`
);

const certificationAssessments = await assessConformancePlans(
  planPaths,
  authority
);
console.log(formatCertificationInventory(certificationAssessments));
assertCertificationEnforcement(certificationAssessments);

const enforcementFixtureAssessments = await assessConformancePlans(
  [
    ENFORCEMENT_FIXTURE_VIOLATING,
    `${ENFORCEMENT_FIXTURE_DIR}/migrated-compliant-plan.json`,
    `${ENFORCEMENT_FIXTURE_DIR}/unmigrated-violating-plan.json`,
  ],
  await loadCertificationAuthority([`${ENFORCEMENT_FIXTURE_DIR}/packet.json`])
);
const enforcedFixturePlans = new Set(
  collectEnforcedViolations(enforcementFixtureAssessments).map(
    (entry) => entry.planPath
  )
);

if (
  enforcedFixturePlans.size !== 1 ||
  !enforcedFixturePlans.has(ENFORCEMENT_FIXTURE_VIOLATING)
) {
  throw new Error(
    `certification enforcement fixture expected failures only in ${ENFORCEMENT_FIXTURE_VIOLATING}, got [${[...enforcedFixturePlans].join(", ")}]`
  );
}

console.log("certification rule enforcement fixture passed");

assertCertificationSchemaContracts();
console.log("certification schema contracts passed");
