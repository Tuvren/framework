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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type ConformanceCheckResult,
  type ConformanceEvidence,
  createCheckResult,
  createConformanceEvidenceSummary,
} from "../../scripts/lib/conformance-contract.js";
import type {
  AdapterCapabilities,
  AdapterControls,
} from "../adapter-protocol/index.js";
import {
  type CompiledConformancePlan,
  type CompiledConformancePlanCheck,
  loadConformancePlan,
} from "../plan-compiler/index.js";
import {
  type AdapterManifest,
  JsonRpcAdapterClient,
  JsonRpcAdapterError,
} from "./adapter-client.js";
import {
  type AssertionContext,
  type AssertionEvaluation,
  evaluateAssertions,
  evaluateRequiredEvidence,
  readPath,
} from "./assertion-engine/index.js";

interface CliOptions {
  adapter: string;
  allowFailingEvidence: boolean;
  capabilities: string[];
  checks: string[];
  concurrency: number;
  evidenceOut?: string;
  packets: string[];
  plans: string[];
  shard?: {
    count: number;
    index: number;
  };
  summaryOnly: boolean;
}

interface AuthorityPacketManifest {
  conformancePlans?: Array<{
    path: string;
    planId: string;
    planVersion: string;
  }>;
  packetId: string;
}

interface ScheduledCheck {
  compiledCheck: CompiledConformancePlanCheck;
  index: number;
  plan: CompiledConformancePlan;
}

interface RunResult {
  checkResult: ConformanceCheckResult;
  index: number;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADAPTER_MANIFEST_SCHEMA_PATH = resolve(
  REPO_ROOT,
  "tools/conformance/adapter-protocol/adapter-manifest.schema.json"
);

await main();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const adapterManifest = await readAdapterManifest(options.adapter);
  const plans = await readPlans(adapterManifest, options);
  const selected = selectChecks(plans, adapterManifest, options);
  await validateHandshakeForSelectedPlans(
    adapterManifest,
    plans,
    selected.applicable.length === 0
  );

  const scheduled = applyShard(selected.applicable, options);
  const results = await runScheduledChecks(
    adapterManifest,
    scheduled,
    options.concurrency
  );

  const checkResults = results
    .sort((left, right) => left.index - right.index)
    .map((result) => result.checkResult);
  const baseSummary = createConformanceEvidenceSummary(checkResults);
  const nonApplicableCheckIds = selected.nonApplicable.map(
    (entry) => entry.checkId
  );
  const summary = {
    ...baseSummary,
    // Sharded evidence reports the applicable checks emitted by this shard,
    // while retaining global non-applicability because capability exclusions are
    // not scheduled work and do not belong to any shard.
    applicableChecks: checkResults.length,
    nonApplicableChecks: nonApplicableCheckIds.length,
    totalChecks: checkResults.length + nonApplicableCheckIds.length,
  };
  const evidence: ConformanceEvidence = {
    adapterId: adapterManifest.adapterId,
    boundary: adapterManifest.boundary,
    capabilities: [...adapterManifest.capabilities].sort(),
    checkResults,
    implementationId: adapterManifest.implementationId,
    language: adapterManifest.language,
    nonApplicableCheckIds,
    status: summary.failedChecks === 0 ? "pass" : "fail",
    suiteId: adapterManifest.suiteId,
    suiteVersion: adapterManifest.suiteVersion,
    summary,
  };
  const text = `${JSON.stringify(evidence, null, 2)}\n`;

  if (options.evidenceOut !== undefined) {
    const evidencePath = resolve(REPO_ROOT, options.evidenceOut);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, text);
  }

  if (options.summaryOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          adapterId: evidence.adapterId,
          implementationId: evidence.implementationId,
          status: evidence.status,
          summary: evidence.summary,
          suiteId: evidence.suiteId,
          suiteVersion: evidence.suiteVersion,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(text);
  }

  if (evidence.status === "fail" && !options.allowFailingEvidence) {
    process.exitCode = 1;
  }
}

async function validateHandshakeForSelectedPlans(
  manifest: AdapterManifest,
  plans: readonly CompiledConformancePlan[],
  required: boolean
): Promise<void> {
  if (!required) {
    return;
  }

  const uniquePackets = new Map<
    string,
    { packetId: string; planVersion: string }
  >();

  for (const plan of plans) {
    const key = `${plan.plan.packetId}@@${plan.plan.planVersion}`;

    if (!uniquePackets.has(key)) {
      uniquePackets.set(key, {
        packetId: plan.plan.packetId,
        planVersion: plan.plan.planVersion,
      });
    }
  }

  const client = new JsonRpcAdapterClient({
    command: manifest.command,
    cwd: REPO_ROOT,
  });

  try {
    for (const packet of uniquePackets.values()) {
      const capabilities = await client.initialize(
        packet.packetId,
        packet.planVersion
      );
      validateAdapterHandshake(
        capabilities,
        manifest,
        packet.packetId,
        packet.planVersion
      );
    }
  } finally {
    await client.shutdown();
  }
}

async function runScheduledChecks(
  manifest: AdapterManifest,
  scheduled: readonly ScheduledCheck[],
  concurrency: number
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, scheduled.length);
  const workers = Array.from({ length: workerCount }, async () => {
    const client = new JsonRpcAdapterClient({
      command: manifest.command,
      cwd: REPO_ROOT,
    });

    try {
      while (nextIndex < scheduled.length) {
        // Each worker owns one adapter process and runs checks serially inside
        // that process, preventing stateful adapters from racing inspectState.
        const scheduledCheck = scheduled[nextIndex];
        nextIndex += 1;

        if (scheduledCheck === undefined) {
          break;
        }

        results.push({
          checkResult: await runCheck(
            client,
            manifest,
            scheduledCheck.plan,
            scheduledCheck.compiledCheck
          ),
          index: scheduledCheck.index,
        });
      }
    } finally {
      await client.shutdown();
    }
  });

  await Promise.all(workers);
  return results;
}

async function runCheck(
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck
): Promise<ConformanceCheckResult> {
  const check = compiledCheck.check;

  try {
    const capabilities = await client.initialize(
      plan.plan.packetId,
      plan.plan.planVersion
    );
    validateAdapterHandshake(
      capabilities,
      manifest,
      plan.plan.packetId,
      plan.plan.planVersion
    );

    if (Array.isArray(check.steps) && check.steps.length > 0) {
      return await runTraceCheck(client, manifest, plan, compiledCheck);
    }

    const input = createAdapterInput(plan, compiledCheck);
    const controls = createAdapterControls(compiledCheck);
    const timeoutMs = controls.deadlineMs;
    const outcome = await client.dispatch(
      check.operation,
      input,
      controls,
      undefined,
      timeoutMs
    );
    const context = createAssertionContext(outcome, input);
    const extraEvents = await client.events(
      check.operation,
      input,
      controls,
      undefined,
      timeoutMs
    );

    if (context.events === undefined && extraEvents.length > 0) {
      context.events = extraEvents;
    }

    const inspectedState = await client.inspectState(
      {
        operation: check.operation,
      },
      undefined,
      timeoutMs
    );

    mergeInspectedState(context, inspectedState, outcome);

    const assertionResults = [
      ...evaluateAssertions(check, context),
      ...evaluateRequiredEvidence(compiledCheck, context),
    ];

    return createCheckResult(check.checkId, assertionResults, {
      // Adapter-declared operation errors stay isolated from $.result.error,
      // but persisted evidence still records the native error for diagnosis.
      ...(outcome.kind === "error" ? { adapterError: outcome.error } : {}),
      adapterId: manifest.adapterId,
      planId: plan.plan.planId,
    });
  } catch (error: unknown) {
    const message = readErrorMessage(error);
    const adapterError = readAdapterFailure(error);
    const assertionResults = [
      ...check.assertions.map((assertion, index) => ({
        assertionId: `${check.checkId}.${index + 1}.${assertion.kind}`,
        message,
        status: "fail" as const,
      })),
      ...compiledCheck.requiredEvidence.map((path) => ({
        assertionId: `${check.checkId}.requiredEvidence.${path}`,
        message,
        status: "fail" as const,
      })),
    ];

    return createCheckResult(check.checkId, assertionResults, {
      adapterError,
      adapterId: manifest.adapterId,
      planId: plan.plan.planId,
    });
  }
}

async function runTraceCheck(
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck
): Promise<ConformanceCheckResult> {
  const check = compiledCheck.check;
  const baseInput = createAdapterInput(plan, compiledCheck);
  const instance = await client.createInstance(baseInput);
  const trace: Record<string, AssertionContext> = {};
  const traceAdapterErrors: Record<string, unknown> = {};
  const assertionResults: AssertionEvaluation[] = [];

  try {
    for (const step of check.steps ?? []) {
      const input = {
        ...baseInput,
        checkInput: resolveStepRefs(step.input ?? check.input, {
          ...baseInput,
          trace,
        }),
      };
      const controls = {
        ...createAdapterControls(compiledCheck),
        ...(step.controls ?? {}),
      };
      const timeoutMs = controls.deadlineMs;
      const outcome = await client.dispatch(
        step.operation,
        input,
        controls,
        instance,
        timeoutMs
      );
      const context = createAssertionContext(outcome, input);
      if (outcome.kind === "error") {
        // Trace-step adapter errors are diagnostic evidence only; plan
        // assertions still decide pass/fail through runner-owned context.
        traceAdapterErrors[step.stepId] = outcome.error;
      }

      const extraEvents = await client.events(
        step.operation,
        input,
        controls,
        instance,
        timeoutMs
      );

      if (context.events === undefined && extraEvents.length > 0) {
        context.events = extraEvents;
      }

      const inspectedState =
        step.inspectState === undefined
          ? undefined
          : await client.inspectState(
              resolveStepRefs(step.inspectState, { ...baseInput, trace }),
              instance,
              timeoutMs
            );

      if (inspectedState !== undefined && inspectedState !== null) {
        context.state = inspectedState;
      }

      trace[step.stepId] = context;

      if (step.assertions !== undefined) {
        assertionResults.push(
          ...evaluateAssertions(
            {
              ...check,
              assertions: step.assertions,
              checkId: `${check.checkId}.${step.stepId}`,
              operation: step.operation,
            },
            context
          )
        );
      }
    }
  } finally {
    await client.destroyInstance(instance);
  }

  const finalContext: AssertionContext = {
    evidence: { trace },
    fixture: baseInput.fixture,
    input: baseInput.checkInput,
    result: { trace },
    scenario: baseInput.scenario,
    state: { trace },
  };
  assertionResults.push(
    ...evaluateAssertions(check, finalContext),
    ...evaluateRequiredEvidence(compiledCheck, finalContext)
  );

  return createCheckResult(check.checkId, assertionResults, {
    adapterId: manifest.adapterId,
    planId: plan.plan.planId,
    ...(Object.keys(traceAdapterErrors).length > 0
      ? { adapterErrors: traceAdapterErrors }
      : {}),
    traceStepIds: Object.keys(trace),
  });
}

function createAssertionContext(
  outcome: Awaited<ReturnType<JsonRpcAdapterClient["dispatch"]>>,
  input: Record<string, unknown>
): AssertionContext {
  if (outcome.kind === "error") {
    return {
      fixture: input.fixture,
      input: input.checkInput,
      scenario: input.scenario,
      state: {
        adapterError: outcome.error,
      },
    };
  }

  if (!isRecord(outcome.value)) {
    return {
      fixture: input.fixture,
      input: input.checkInput,
      result: outcome.value,
      scenario: input.scenario,
    };
  }

  return {
    evidence: readOptionalRecord(outcome.value.evidence),
    events: readOptionalArray(outcome.value.events),
    fixture: input.fixture,
    input: input.checkInput,
    result: outcome.value.result,
    scenario: input.scenario,
    state: readOptionalRecord(outcome.value.state),
  };
}

function mergeInspectedState(
  context: AssertionContext,
  inspectedState: unknown,
  outcome: Awaited<ReturnType<JsonRpcAdapterClient["dispatch"]>>
): void {
  if (inspectedState === null || inspectedState === undefined) {
    return;
  }

  if (outcome.kind === "error") {
    context.state = isRecord(inspectedState)
      ? { ...inspectedState, adapterError: outcome.error }
      : { adapterError: outcome.error, inspectedState };
    return;
  }

  // Adapter-supplied state from a successful dispatch already populates
  // context.state; only fall back to the inspectState query when dispatch did
  // not pack value.state. Mirrors the events handling above.
  if (context.state === undefined) {
    context.state = inspectedState;
  }
}

function readAdapterFailure(error: unknown): unknown {
  if (error instanceof JsonRpcAdapterError) {
    return error.envelope;
  }

  return readErrorMessage(error);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAdapterInput(
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck
): Record<string, unknown> {
  const check = compiledCheck.check;
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

function createAdapterControls(
  compiledCheck: CompiledConformancePlanCheck
): AdapterControls {
  const controls = compiledCheck.check.controls;

  if (controls === undefined) {
    return {};
  }

  return {
    cancelAfterEvent: controls.cancelAfterEvent,
    deadlineMs: controls.deadlineMs,
  };
}

function validateAdapterHandshake(
  capabilities: AdapterCapabilities,
  manifest: AdapterManifest,
  packetId: string,
  planVersion: string
): void {
  if (capabilities.adapterId !== manifest.adapterId) {
    throw new Error(
      `adapter initialize returned adapterId ${capabilities.adapterId}, expected ${manifest.adapterId}`
    );
  }

  if (
    capabilities.packetId !== packetId ||
    capabilities.planVersion !== planVersion
  ) {
    throw new Error(
      `adapter initialize echoed ${capabilities.packetId}@${capabilities.planVersion}, expected ${packetId}@${planVersion}`
    );
  }

  const reportedCapabilities = capabilities.capabilities;

  if (!Array.isArray(reportedCapabilities)) {
    throw new Error("adapter initialize must report capabilities");
  }

  const expected = [...manifest.capabilities].sort();
  const actual = [...reportedCapabilities].sort();

  if (
    expected.length !== actual.length ||
    expected.some((capability, index) => capability !== actual[index])
  ) {
    throw new Error(
      `adapter initialize capabilities ${actual.join(", ")} do not match manifest ${expected.join(", ")}`
    );
  }
}

async function readPlans(
  adapterManifest: AdapterManifest,
  options: CliOptions
): Promise<CompiledConformancePlan[]> {
  const planPaths = new Set(options.plans);
  const packetPaths =
    options.packets.length > 0
      ? options.packets
      : adapterManifest.authorityPackets;

  for (const packetPath of packetPaths) {
    const packet = await readAuthorityPacket(packetPath);

    for (const plan of packet.conformancePlans ?? []) {
      planPaths.add(plan.path);
    }
  }

  const plans: CompiledConformancePlan[] = [];

  for (const planPath of [...planPaths].sort()) {
    plans.push(await loadConformancePlan(planPath));
  }

  return plans;
}

function selectChecks(
  plans: readonly CompiledConformancePlan[],
  manifest: AdapterManifest,
  options: CliOptions
): {
  applicable: ScheduledCheck[];
  nonApplicable: Array<{ checkId: string; planId: string }>;
} {
  const adapterCapabilities = new Set(manifest.capabilities);
  const requestedCapabilities = new Set(options.capabilities);
  const requestedChecks = new Set(options.checks);
  const availableCapabilities = new Set<string>();
  const availableCheckIds = new Set<string>();
  const applicable: ScheduledCheck[] = [];
  const nonApplicable: Array<{ checkId: string; planId: string }> = [];
  let index = 0;

  for (const plan of [...plans].sort((left, right) =>
    left.plan.planId.localeCompare(right.plan.planId)
  )) {
    for (const compiledCheck of [...plan.checks].sort((left, right) =>
      left.check.checkId.localeCompare(right.check.checkId)
    )) {
      const check = compiledCheck.check;
      availableCheckIds.add(check.checkId);

      if (requestedChecks.size > 0 && !requestedChecks.has(check.checkId)) {
        continue;
      }

      const requiredCapabilities = [
        ...plan.plan.applicability.capabilities,
        ...(check.capabilities ?? []),
      ];

      for (const capability of requiredCapabilities) {
        availableCapabilities.add(capability);
      }

      const hasCapabilities = requiredCapabilities.every((capability) =>
        adapterCapabilities.has(capability)
      );
      const matchesRequestedCapabilities =
        requestedCapabilities.size === 0 ||
        requiredCapabilities.some((capability) =>
          requestedCapabilities.has(capability)
        );

      if (!(hasCapabilities && matchesRequestedCapabilities)) {
        nonApplicable.push({
          checkId: check.checkId,
          planId: plan.plan.planId,
        });
        continue;
      }

      applicable.push({
        compiledCheck,
        index,
        plan,
      });
      index += 1;
    }
  }

  const unknownRequestedChecks = [...requestedChecks].filter(
    (checkId) => !availableCheckIds.has(checkId)
  );

  if (unknownRequestedChecks.length > 0) {
    throw new Error(
      `unknown --check value(s): ${unknownRequestedChecks.sort().join(", ")}`
    );
  }

  const unknownRequestedCapabilities = [...requestedCapabilities].filter(
    (capability) => !availableCapabilities.has(capability)
  );

  if (unknownRequestedCapabilities.length > 0) {
    throw new Error(
      `unknown --capability value(s): ${unknownRequestedCapabilities.sort().join(", ")}`
    );
  }

  return {
    applicable,
    nonApplicable,
  };
}

function applyShard(
  scheduled: readonly ScheduledCheck[],
  options: CliOptions
): ScheduledCheck[] {
  const shard = options.shard;

  if (shard === undefined) {
    return [...scheduled];
  }

  return scheduled.filter(
    (_entry, index) => index % shard.count === shard.index
  );
}

async function readAdapterManifest(path: string): Promise<AdapterManifest> {
  const absolutePath = resolve(REPO_ROOT, path);
  const value = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  const validate = await createAdapterManifestValidator();

  if (!validate(value)) {
    throw new Error(
      `${path} failed adapter manifest validation: ${validate.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
        .join("; ")}`
    );
  }

  return value as AdapterManifest;
}

async function readAuthorityPacket(
  path: string
): Promise<AuthorityPacketManifest> {
  const value = JSON.parse(
    await readFile(resolve(REPO_ROOT, path), "utf8")
  ) as unknown;

  if (!isRecord(value) || typeof value.packetId !== "string") {
    throw new Error(`${path} must contain an authority packet manifest`);
  }

  return value as unknown as AuthorityPacketManifest;
}

async function createAdapterManifestValidator(): Promise<
  ValidateFunction<unknown>
> {
  const schema = JSON.parse(
    await readFile(ADAPTER_MANIFEST_SCHEMA_PATH, "utf8")
  ) as unknown;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    adapter: "",
    allowFailingEvidence: false,
    capabilities: [],
    checks: [],
    concurrency: 1,
    packets: [],
    plans: [],
    summaryOnly: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--adapter":
        options.adapter = requireValue(next, arg);
        index += 1;
        break;
      case "--packet":
        options.packets.push(requireValue(next, arg));
        index += 1;
        break;
      case "--plan":
        options.plans.push(requireValue(next, arg));
        index += 1;
        break;
      case "--check":
        options.checks.push(requireValue(next, arg));
        index += 1;
        break;
      case "--capability":
        options.capabilities.push(requireValue(next, arg));
        index += 1;
        break;
      case "--shard":
        options.shard = parseShard(requireValue(next, arg));
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(requireValue(next, arg));
        index += 1;
        break;
      case "--evidence-out":
        options.evidenceOut = requireValue(next, arg);
        index += 1;
        break;
      case "--allow-failing-evidence":
        options.allowFailingEvidence = true;
        break;
      case "--summary-only":
        options.summaryOnly = true;
        break;
      default:
        throw new Error(`unknown runner argument ${String(arg)}`);
    }
  }

  if (options.adapter.length === 0) {
    throw new Error("--adapter is required");
  }

  return options;
}

function parseShard(value: string): { count: number; index: number } {
  const [indexText, countText] = value.split("/");
  const index = parsePositiveInteger(indexText ?? "") - 1;
  const count = parsePositiveInteger(countText ?? "");

  if (index >= count) {
    throw new Error("--shard index must be less than count");
  }

  return { count, index };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`expected positive integer, received ${value}`);
  }

  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
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

function resolveStepRefs(
  value: unknown,
  context: Record<string, unknown>
): unknown {
  if (typeof value === "string" && value.startsWith("$.")) {
    return readPath(context, value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveStepRefs(entry, context));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveStepRefs(entry, context),
      ])
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
