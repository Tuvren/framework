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
import {
  type AssertionContext,
  type AssertionEvaluation,
  type CompiledConformancePlan,
  type CompiledConformancePlanCheck,
  type ConformancePlanCheck,
  evaluateAssertions,
  loadConformancePlan,
} from "../../../../../../tools/conformance/plan-compiler/index.js";
import {
  type ConformanceCheckResult,
  type ConformanceEvidence,
  createCheckResult,
  createConformanceEvidenceSummary,
} from "../../../../../../tools/scripts/lib/conformance-contract.js";
import { emitConformanceEvidence } from "../../../../../../tools/scripts/lib/conformance-runner.js";
import {
  type AdapterControls,
  type ImplementationAdapter,
  type OperationOutcome,
  TypeScriptFrameworkAdapter,
} from "./adapter-scaffold.ts";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../.."
);
const FRAMEWORK_AUTHORITY_PACKET_PATHS: readonly string[] = [
  "boundaries/framework/contracts/event-stream/spec/authority-packet.json",
  "boundaries/framework/contracts/runtime-api/spec/authority-packet.json",
  "boundaries/framework/contracts/driver-api/spec/authority-packet.json",
  "boundaries/framework/contracts/react-driver/spec/authority-packet.json",
];
const IMPLEMENTATION_ID = "typescript-framework";
const LANGUAGE = "typescript";
const SUITE_ID = "tuvren.framework.promoted-authority";
const SUITE_VERSION = "0.1.0";

interface AuthorityPacketManifest {
  conformancePlans: readonly AuthorityPacketPlanReference[];
  packetId: string;
}

interface AuthorityPacketPlanReference {
  path: string;
  planId: string;
}

interface CheckRunContext {
  adapter: ImplementationAdapter;
  check: CompiledConformancePlanCheck;
  plan: CompiledConformancePlan;
}

interface CheckRunResult {
  assertionContext: AssertionContext;
  details: Record<string, unknown>;
}

await main();

async function main(): Promise<void> {
  const plans = await readFrameworkPlans();
  const checkResults: ConformanceCheckResult[] = [];
  const adapter = new TypeScriptFrameworkAdapter();

  try {
    for (const plan of plans) {
      await adapter.initialize(plan.plan.packetId, plan.plan.planVersion);

      for (const check of plan.checks) {
        checkResults.push(await runPlanCheck(adapter, plan, check));
      }
    }
  } finally {
    await adapter.shutdown();
  }

  const summary = createConformanceEvidenceSummary(checkResults);
  const evidence: ConformanceEvidence = {
    boundary: "framework",
    checkResults,
    implementationId: IMPLEMENTATION_ID,
    language: LANGUAGE,
    status: summary.failedChecks === 0 ? "pass" : "fail",
    suiteId: SUITE_ID,
    suiteVersion: SUITE_VERSION,
    summary,
  };

  emitConformanceEvidence(evidence);
}

async function readFrameworkPlans(): Promise<CompiledConformancePlan[]> {
  const planPaths = new Set<string>();

  for (const manifestPath of FRAMEWORK_AUTHORITY_PACKET_PATHS) {
    const manifest = await readAuthorityPacketManifest(manifestPath);

    for (const plan of manifest.conformancePlans ?? []) {
      planPaths.add(plan.path);
    }
  }

  const plans: CompiledConformancePlan[] = [];

  for (const planPath of [...planPaths].sort()) {
    plans.push(await loadConformancePlan(planPath));
  }

  return plans;
}

async function readAuthorityPacketManifest(
  manifestPath: string
): Promise<AuthorityPacketManifest> {
  const manifest: unknown = JSON.parse(
    await readFile(resolve(REPO_ROOT, manifestPath), "utf8")
  );

  if (!isRecord(manifest) || typeof manifest.packetId !== "string") {
    throw new Error(
      `${manifestPath} must contain an authority packet manifest`
    );
  }

  return readAuthorityPacketManifestValue(manifest, manifestPath);
}

function readAuthorityPacketManifestValue(
  value: unknown,
  label: string
): AuthorityPacketManifest {
  if (!isRecord(value) || typeof value.packetId !== "string") {
    throw new Error(`${label} must contain an authority packet manifest`);
  }

  const conformancePlans = readPlanReferences(
    value.conformancePlans,
    `${label}.conformancePlans`
  );

  return {
    conformancePlans,
    packetId: value.packetId,
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
    throw new Error(`${label} must be an array when present`);
  }

  return value.map((entry, index) =>
    readPlanReference(entry, `${label}[${index}]`)
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

async function runPlanCheck(
  adapter: ImplementationAdapter,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck
): Promise<ConformanceCheckResult> {
  const result = await createAdapterOperationContext({
    adapter,
    check: compiledCheck,
    plan,
  });
  const assertionResults = [
    ...evaluateAssertions(compiledCheck.check, result.assertionContext),
    ...evaluateRequiredEvidence(compiledCheck, result.assertionContext),
  ];

  return createCheckResult(
    compiledCheck.check.checkId,
    assertionResults,
    result.details
  );
}

async function createAdapterOperationContext({
  adapter,
  check,
  plan,
}: CheckRunContext): Promise<CheckRunResult> {
  const input = createAdapterInput(plan, check.check);
  const controls = createAdapterControls(check.check);
  const outcome = await adapter.dispatch(
    check.check.operation,
    input,
    controls
  );
  const adapterEvents = await collectStreamValues(
    adapter.events(check.check.operation, input, controls)
  );
  const inspectedState =
    adapter.inspectState === undefined
      ? undefined
      : await adapter.inspectState({
          checkId: check.check.checkId,
          operation: check.check.operation,
        });

  await adapter.emitEvidence(check.check.checkId, "adapter.events", {
    count: adapterEvents.length,
  });

  const assertionContext = createAdapterAssertionContext(
    outcome,
    inspectedState
  );

  return {
    assertionContext,
    details: createDetails(assertionContext, outcome),
  };
}

function evaluateRequiredEvidence(
  compiledCheck: CompiledConformancePlanCheck,
  context: AssertionContext
): AssertionEvaluation[] {
  return compiledCheck.requiredEvidence.map((path) => {
    const present = hasRequiredEvidence(context, path);

    return {
      assertionId: `${compiledCheck.check.checkId}.requiredEvidence.${path}`,
      ...(present ? {} : { message: `missing required evidence ${path}` }),
      status: present ? "pass" : "fail",
    };
  });
}

function hasRequiredEvidence(context: AssertionContext, path: string): boolean {
  const jsonPath = `$.${path}`;

  if (readPath(context.evidence, jsonPath) !== undefined) {
    return true;
  }

  if (readPath(context.state, jsonPath) !== undefined) {
    return true;
  }

  if (
    context.events !== undefined &&
    readPath({ events: context.events }, jsonPath) !== undefined
  ) {
    return true;
  }

  return (
    context.result !== undefined &&
    readPath({ result: context.result }, jsonPath) !== undefined
  );
}

function createAdapterInput(
  plan: CompiledConformancePlan,
  check: ConformancePlanCheck
): Record<string, unknown> {
  // Scenarios flow into adapter inputs only. Expected evidence, results,
  // and state remain plan assertions so the runner cannot prove itself.
  const input: Record<string, unknown> = {
    checkInput: check.input,
  };

  if (check.scenario !== undefined) {
    const scenarioSource = plan.scenarios.get(check.scenario);
    const scenarioPath = readInputStringOptional(check.input, "scenarioPath");
    input.scenario =
      scenarioPath === undefined
        ? scenarioSource
        : readPath(scenarioSource, scenarioPath);
  }

  if (check.fixture !== undefined) {
    const fixtureSource = plan.fixtures.get(check.fixture);
    const fixturePath = readInputStringOptional(check.input, "fixturePath");
    input.fixture =
      fixturePath === undefined
        ? fixtureSource
        : readPath(fixtureSource, fixturePath);
  }

  return input;
}

function createAdapterControls(check: ConformancePlanCheck): AdapterControls {
  if (check.controls === undefined) {
    return {};
  }

  return {
    cancelAfterEvent: check.controls.cancelAfterEvent,
    deadlineMs: check.controls.deadlineMs,
  };
}

function createAdapterAssertionContext(
  outcome: OperationOutcome,
  inspectedState: unknown
): AssertionContext {
  if (outcome.kind === "error") {
    // Adapter protocol errors mean the implementation path did not produce an
    // observation, so they must stay out of assertion fields such as result.
    return {
      state: inspectedState ?? undefined,
    };
  }

  if (!isRecord(outcome.value)) {
    return {
      result: outcome.value,
      state: inspectedState ?? undefined,
    };
  }

  return {
    evidence: readOptionalRecord(outcome.value.evidence),
    events: readOptionalArray(outcome.value.events),
    result: outcome.value.result,
    state: inspectedState ?? readOptionalRecord(outcome.value.state),
  };
}

function readOptionalRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("operation context field must be an object when present");
  }

  return value;
}

function readOptionalArray(value: unknown): readonly unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error("operation context events must be an array when present");
  }

  return value;
}

function createDetails(
  context: AssertionContext,
  outcome: OperationOutcome
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    adapterOutcome: outcome,
  };

  if (context.events !== undefined) {
    details.eventTypes = context.events.map((event) =>
      isRecord(event) ? event.type : undefined
    );
  }

  if (context.evidence !== undefined) {
    Object.assign(details, context.evidence);
  }

  if (context.result !== undefined) {
    details.result = context.result;
  }

  if (context.state !== undefined) {
    details.state = context.state;
  }

  return details;
}

async function collectStreamValues<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
}

function readInputStringOptional(
  input: unknown,
  key: string
): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const value = input[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`check input ${key} must be a string when present`);
  }

  return value;
}

function readPath(source: unknown, path: string): unknown {
  if (path === "$") {
    return source;
  }

  if (!path.startsWith("$.")) {
    throw new Error(`unsupported path ${path}`);
  }

  let current = source;

  for (const segment of path.slice(2).split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
