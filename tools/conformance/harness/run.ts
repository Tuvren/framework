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

import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import process from "node:process";

import {
  createCheckResult,
  createConformanceEvidenceSummary,
  deriveConformanceRunStatus,
} from "../../scripts/lib/conformance-contract.js";
import type {
  ConformanceCheckResult,
  ConformanceEvidence,
  ConformanceFailure,
  ConformanceFailureClassification,
} from "../../scripts/lib/conformance-contract.js";
import { createVerificationLogs } from "../../scripts/lib/verification-logs.js";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../adapter-protocol/index.js";
import { beginCertificate } from "../certification/bundle.js";
import {
  CERTIFICATION_MANIFEST_PATH,
  findCertifiedEntriesForAdapter,
  readCertificationManifest,
} from "../certification/certification-manifest.js";
import { finalizeProfileBundles } from "../certification/profile-bundles.js";
import {
  assertKernelMemoryClaimInventory,
  assertProfileClaimInventory,
  findProfileSelectionFailures,
  readClaimedProfiles,
} from "../certification/profile.js";
import type { CertificationProfile } from "../certification/profile.js";
import {
  certifiedSelectionPassed,
  requiredCertificatesPassed,
  writeRunOutput,
} from "../certification/run-output.js";
import { nativeErrorAsserted } from "../plan-compiler/certification-rules.js";
import type { CatalogOperation } from "../plan-compiler/certification-rules.js";
import {
  controlConsumesInstance,
  controlInputProblem,
  operationInputProblem,
} from "../plan-compiler/control-input.js";
import type {
  CompiledConformancePlan,
  CompiledConformancePlanCheck,
  ConformancePlanCheck,
  ConformancePlanStep,
} from "../plan-compiler/index.js";
import {
  adapterCommand,
  JsonRpcAdapterClient,
  previewFrames,
} from "./adapter-client.js";
import type {
  AdapterManifest,
  AdapterTranscriptMark,
} from "./adapter-client.js";
import { AdapterRequestTimeoutError } from "./adapter-client.js";
import { JsonRpcAdapterError } from "./adapter-error.js";
import {
  diagnoseAssertions,
  diagnoseRequiredEvidence,
} from "./assertion-engine/index.js";
import type {
  AssertionContext,
  AssertionDiagnosis,
} from "./assertion-engine/index.js";
import { readPath } from "./assertion-engine/path.js";
import { assertionId } from "./assertion-id.js";
import { createBarrierSteps } from "./barrier-steps.js";
import { needsServerClock, selectCheck } from "./check-selection.js";
import {
  createFaultActivationTracker,
  MissingFaultActivationError,
  SeamDidNotHoldError,
} from "./fault-activation.js";
import { runMultiTraceCheck } from "./multi-trace.js";
import {
  ObservationEncodingError,
  validateObservation,
} from "./observation-encoding.js";
import {
  isOperationHandleStep,
  recordHandleCapture,
  runOperationHandleStep,
} from "./operation-steps.js";
import { ProcessStartError, ProcessSupervisor } from "./process-supervisor.js";
import { readAdapterManifest, readPlans } from "./run-plans.js";
import {
  ArgumentResolutionError,
  createCaptureStore,
  recordStepCaptures,
  resolveStepArguments,
} from "./step-arguments.js";
import type { ArgumentRoots } from "./step-arguments.js";
import {
  CleanupError,
  StorageResourceError,
  withCheckStorage,
  postgresServerVersion,
  withCleanup,
} from "./storage-resource.js";

interface CliOptions {
  adapter: string;
  allowFailingEvidence: boolean;
  captureObservations: boolean;
  capabilities: string[];
  certificationManifest: string;
  checks: string[];
  concurrency: number;
  controlReport?: string;
  evidenceOut?: string;
  packets: string[];
  plans: string[];
  requireCertified: boolean;
  shard?: {
    count: number;
    index: number;
  };
  summaryOnly: boolean;
}

interface ScheduledCheck {
  compiledCheck: CompiledConformancePlanCheck;
  index: number;
  plan: CompiledConformancePlan;
}

type RunnerContext = AssertionContext & {
  capture?: Readonly<Record<string, unknown>>;
};

interface RunResult {
  checkResult: ConformanceCheckResult;
  index: number;
}

export interface StepObservationRecord {
  events?: readonly unknown[];
  inspectedState?: unknown;
  operation: string;
  outcome?: unknown;
  process?: string;
  stepId?: string;
}

/** What one check sent and observed, kept for its failure artifact. */
export interface CheckRecorder {
  faults: ReturnType<typeof createFaultActivationTracker>;
  arguments: {
    input: unknown;
    inspectQuery?: unknown;
    operation: string;
    stepId?: string;
  }[];
  diagnoses: AssertionDiagnosis[];
  observation: StepObservationRecord[];
  operationErrors: unknown[];
  recordCertification: boolean;
  schedule: {
    action: string;
    arrivalSequence: number;
    input?: unknown;
    operation: string;
    participants?: readonly string[];
    process: string;
    receipt?: unknown;
    stepId: string;
  }[];
  processes?: Map<string, ProcessSupervisor>;
  storageIdentity?: unknown;
  thrown?: unknown;
}

const STDERR_TAIL_CHARS = 4096;
const ENVIRONMENT_FAILURE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|ENOSPC|connection refused|could not connect|too many clients|failed to provision|provisioning failed/iu;
const SHELL_SAFE = /^[\w@%+=:,./-]+$/u;

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireValue = (value: string | undefined, flag: string): string => {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
};

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`expected positive integer, received ${value}`);
  }

  return parsed;
};

const parseShard = (value: string): { count: number; index: number } => {
  const [indexText, countText] = value.split("/");
  const index = parsePositiveInteger(indexText ?? "") - 1;
  const count = parsePositiveInteger(countText ?? "");

  if (index >= count) {
    throw new Error("--shard index must be less than count");
  }

  return { count, index };
};

const parseArgs = (args: readonly string[]): CliOptions => {
  const options: CliOptions = {
    adapter: "",
    allowFailingEvidence: false,
    captureObservations: false,
    capabilities: [],
    certificationManifest: CERTIFICATION_MANIFEST_PATH,
    checks: [],
    concurrency: 1,
    packets: [],
    plans: [],
    requireCertified: false,
    summaryOnly: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--adapter": {
        options.adapter = requireValue(next, arg);
        index += 1;
        break;
      }
      case "--packet": {
        options.packets.push(requireValue(next, arg));
        index += 1;
        break;
      }
      case "--plan": {
        options.plans.push(requireValue(next, arg));
        index += 1;
        break;
      }
      case "--check": {
        options.checks.push(requireValue(next, arg));
        index += 1;
        break;
      }
      case "--capability": {
        options.capabilities.push(requireValue(next, arg));
        index += 1;
        break;
      }
      case "--shard": {
        options.shard = parseShard(requireValue(next, arg));
        index += 1;
        break;
      }
      case "--concurrency": {
        options.concurrency = parsePositiveInteger(requireValue(next, arg));
        index += 1;
        break;
      }
      case "--certification-manifest": {
        options.certificationManifest = requireValue(next, arg);
        index += 1;
        break;
      }
      case "--control-report": {
        options.controlReport = requireValue(next, arg);
        index += 1;
        break;
      }
      case "--evidence-out": {
        options.evidenceOut = requireValue(next, arg);
        index += 1;
        break;
      }
      case "--allow-failing-evidence": {
        options.allowFailingEvidence = true;
        break;
      }
      case "--capture-observations": {
        options.captureObservations = true;
        break;
      }
      case "--require-certified": {
        options.requireCertified = true;
        break;
      }
      case "--summary-only": {
        options.summaryOnly = true;
        break;
      }
      default: {
        throw new Error(`unknown runner argument ${arg}`);
      }
    }
  }

  if (options.adapter.length === 0) {
    throw new Error("--adapter is required");
  }

  return options;
};

const readInputStringOptional = (
  input: unknown,
  key: string
): string | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  const value = input[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError(`check input ${key} must be a string when present`);
  }

  return value;
};

const readOptionalRecord = (
  value: unknown
): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("operation context field must be an object when present");
  }

  return value;
};

const readOptionalArray = (value: unknown): readonly unknown[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new TypeError(
      "operation context events must be an array when present"
    );
  }

  const events: unknown[] = value;
  return events;
};

const resolveStepRefs = (
  value: unknown,
  context: Record<string, unknown>
): unknown => {
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
};

const createAdapterInput = (
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck
): Record<string, unknown> => {
  const { check } = compiledCheck;
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
};

const createAdapterControls = (
  compiledCheck: CompiledConformancePlanCheck
): AdapterControls => {
  const { controls } = compiledCheck.check;

  if (controls === undefined) {
    return {};
  }

  return {
    cancelAfterEvent: controls.cancelAfterEvent,
    deadlineMs: controls.deadlineMs,
  };
};

const createAssertionContext = (
  outcome: Awaited<ReturnType<JsonRpcAdapterClient["dispatch"]>>,
  input: Record<string, unknown>,
  catalogued = false
): AssertionContext => {
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

  if (
    catalogued &&
    Object.keys(outcome.value).some(
      (key) => !["result", "events", "state"].includes(key)
    )
  ) {
    throw new ObservationEncodingError(
      "catalogued operation returned undeclared observation domains"
    );
  }
  const evidence = readOptionalRecord(outcome.value.evidence);
  return {
    events: readOptionalArray(outcome.value.events),
    evidence,
    fixture: input.fixture,
    input: input.checkInput,
    result: outcome.value.result,
    scenario: input.scenario,
    state: readOptionalRecord(outcome.value.state),
  };
};

const mergeInspectedState = (
  context: AssertionContext,
  inspectedState: unknown,
  outcome: Awaited<ReturnType<JsonRpcAdapterClient["dispatch"]>>
): void => {
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
};

const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const primaryError = (error: unknown): unknown =>
  error instanceof CleanupError && !error.hasResult
    ? primaryError(error.primaryError)
    : error;

const withCheckCleanup = async (
  operation: () => Promise<ConformanceCheckResult>,
  cleanup: () => Promise<void>,
  onCleanupFailure: (
    result: ConformanceCheckResult,
    error: CleanupError
  ) => ConformanceCheckResult
): Promise<ConformanceCheckResult> => {
  let result: ConformanceCheckResult | undefined;
  try {
    return await withCleanup(async () => {
      result = await operation();
      return result;
    }, cleanup);
  } catch (error: unknown) {
    if (error instanceof CleanupError && result !== undefined) {
      return onCleanupFailure(result, error);
    }
    throw error;
  }
};

const appendCleanupFailure = (
  result: ConformanceCheckResult,
  error: CleanupError,
  replay?: string
): ConformanceCheckResult => {
  const failure =
    result.failure ??
    (replay === undefined
      ? undefined
      : { classification: "environment" as const, replay });
  return {
    ...result,
    status: "fail",
    assertionResults: [
      ...result.assertionResults,
      {
        assertionId: `${result.checkId}.cleanup`,
        message: readErrorMessage(error.cleanupError),
        status: "fail",
      },
    ],
    details: {
      ...result.details,
      cleanupError: readErrorMessage(error.cleanupError),
    },
    ...(failure === undefined ? {} : { failure }),
  };
};

const readAdapterFailure = (error: unknown): unknown => {
  if (error instanceof JsonRpcAdapterError) {
    return error.envelope;
  }

  return readErrorMessage(error);
};

const readEvaluations = (recorder: CheckRecorder) =>
  recorder.diagnoses.map(({ evaluation }) => evaluation);

const validateAdapterHandshake = (
  capabilities: AdapterCapabilities,
  manifest: AdapterManifest,
  packetId: string,
  planVersion: string
): void => {
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

  if (!Array.isArray(capabilities.capabilities)) {
    throw new TypeError("adapter initialize must report capabilities");
  }

  const expected = [...manifest.capabilities].toSorted();
  const actual = [...reportedCapabilities].toSorted();

  if (
    expected.length !== actual.length ||
    expected.some((capability, index) => capability !== actual[index])
  ) {
    throw new Error(
      `adapter initialize capabilities ${actual.join(", ")} do not match manifest ${expected.join(", ")}`
    );
  }

  const missingProfiles = (manifest.profiles ?? []).filter(
    (profile) => !capabilities.profiles?.includes(profile)
  );
  if (missingProfiles.length > 0) {
    throw new Error(
      `adapter initialize profiles do not include manifest claims: ${missingProfiles.join(", ")}`
    );
  }
  if (
    manifest.storage !== undefined &&
    !capabilities.storageKinds?.includes(manifest.storage)
  ) {
    throw new Error(
      `adapter initialize storageKinds do not include manifest storage ${manifest.storage}`
    );
  }
};

interface TraceStepRequest {
  contextInput: Record<string, unknown>;
  input: unknown;
  inspectQuery: unknown;
}

const createTraceStepRequest = (
  step: ConformancePlanStep,
  check: ConformancePlanCheck,
  baseInput: Record<string, unknown>,
  trace: Record<string, AssertionContext>,
  argumentRoots: ArgumentRoots
): TraceStepRequest => {
  if (step.arguments === undefined) {
    const legacyContext = { ...baseInput, trace };
    const input = {
      ...baseInput,
      checkInput: resolveStepRefs(step.input ?? check.input, legacyContext),
    };
    return {
      contextInput: input,
      input,
      inspectQuery:
        step.inspectState === undefined
          ? undefined
          : resolveStepRefs(step.inspectState, legacyContext),
    };
  }

  return {
    contextInput: baseInput,
    input: resolveStepArguments(step.arguments, argumentRoots),
    inspectQuery:
      step.inspectState === undefined
        ? undefined
        : resolveStepArguments(step.inspectState, argumentRoots),
  };
};

const LEGACY_INPUT_SELECTORS = ["fixturePath", "scenarioPath"] as const;

const rejectLegacySelectors = (input: unknown): void => {
  if (!isRecord(input)) {
    return;
  }

  const selector = LEGACY_INPUT_SELECTORS.find((key) =>
    Object.hasOwn(input, key)
  );

  if (selector !== undefined) {
    throw new ArgumentResolutionError(
      `check input ${selector} cannot be combined with step arguments`
    );
  }
};

class NativeOperationError extends Error {}
class UnsupportedFaultPointError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const validateNativeError = (
  error: { code: string },
  operation: CatalogOperation | undefined,
  asserted: boolean
): void => {
  if (operation === undefined) {
    return;
  }
  if (!(operation.errors ?? []).includes(error.code)) {
    throw new NativeOperationError(
      `${operation.operationId} emitted undeclared native error ${error.code}`
    );
  }
  if (!asserted) {
    throw new NativeOperationError(
      `unexpected native error ${error.code} has no adapterError assertion`
    );
  }
};

const bindControlInstance = (
  operation: CatalogOperation | undefined,
  input: unknown,
  instance: unknown
): unknown => {
  if (!controlConsumesInstance(operation)) {
    return input;
  }
  if (!isRecord(input)) {
    throw new ArgumentResolutionError(
      "instance control arguments must be an object"
    );
  }
  return { ...input, instance };
};

const validateTraceFaultOutcome = (
  recorder: CheckRecorder,
  step: ConformancePlanStep,
  input: unknown,
  outcome: Awaited<ReturnType<JsonRpcAdapterClient["dispatch"]>>,
  operation: CatalogOperation | undefined,
  check: ConformancePlanCheck,
  processName = "primary",
  processEpoch = 1
): void => {
  const faultOutcome = operation?.faultOutcome;
  if (step.action === "armFault" && faultOutcome === undefined) {
    throw new ArgumentResolutionError(
      "armFault requires catalogued fault outcome metadata"
    );
  }
  if (faultOutcome !== undefined) {
    if (operation?.kind !== "control") {
      throw new ArgumentResolutionError(
        "fault outcome metadata is only valid on control operations"
      );
    }
    if (
      outcome.kind === "error" &&
      outcome.error.code === faultOutcome.unsupportedCode &&
      operation.errors?.includes(outcome.error.code)
    ) {
      throw new UnsupportedFaultPointError(
        outcome.error.code,
        outcome.error.message
      );
    }
    recorder.faults.arm(
      input,
      outcome,
      faultOutcome.code,
      processName,
      processEpoch
    );
  }
  const activated = recorder.faults.observe(outcome, processName, processEpoch);
  if (outcome.kind === "error" && !activated) {
    if (
      recorder.faults.isFaultOutcome(
        outcome.error.code,
        processName,
        processEpoch
      ) &&
      recorder.faults.armed.some((entry) => entry.process === processName)
    ) {
      throw new MissingFaultActivationError(
        "typed fault has no matching armed token and storage boundary"
      );
    }
    validateNativeError(
      outcome.error,
      operation,
      nativeErrorAsserted(check, step)
    );
  }
};

interface TraceStepExecution {
  catalogOperation: CatalogOperation | undefined;
  check: ConformancePlanCheck;
  client: JsonRpcAdapterClient;
  contextInput: Record<string, unknown>;
  controls: AdapterControls;
  input: unknown;
  inspectQuery: unknown;
  instance: unknown;
  observed: StepObservationRecord;
  processName?: string;
  processEpoch?: number;
  recorder: CheckRecorder;
  startedOperations: Map<string, string>;
  step: ConformancePlanStep;
}

const validateStartedInput = (
  step: ConformancePlanStep,
  operation: CatalogOperation | undefined,
  input: unknown
): void => {
  if (step.action !== "start") {
    return;
  }
  const problem = operationInputProblem(operation, input);
  if (problem !== undefined) {
    throw new ArgumentResolutionError(problem);
  }
};

const isBlockingFault = (
  step: ConformancePlanStep,
  input: unknown
): input is Record<string, unknown> =>
  step.action === "armFault" && isRecord(input) && input.mode === "block";

const armBlockingFault = async (
  client: JsonRpcAdapterClient,
  instance: unknown,
  input: Record<string, unknown>
): Promise<OperationOutcome> => {
  if (typeof input.point !== "string" || typeof input.occurrence !== "number") {
    throw new ArgumentResolutionError("invalid blocking fault arguments");
  }
  try {
    const value = await client.armFault(
      instance,
      input.point,
      input.selector,
      input.occurrence,
      "block"
    );
    return { kind: "result", value: { result: value } };
  } catch (error: unknown) {
    if (!(error instanceof JsonRpcAdapterError)) {
      throw error;
    }
    return { kind: "error", error: error.envelope };
  }
};

const observeTraceStep = async ({
  catalogOperation,
  check,
  client,
  contextInput,
  controls,
  input,
  inspectQuery,
  instance,
  observed,
  processName,
  processEpoch,
  recorder,
  startedOperations,
  step,
}: TraceStepExecution) => {
  const timeoutMs = controls.deadlineMs;
  const handleStep = isOperationHandleStep(step);
  const nativeOutcome = !handleStep || step.action === "await";
  const inputProblem = handleStep
    ? undefined
    : controlInputProblem(catalogOperation, input);
  if (inputProblem !== undefined) {
    throw new ArgumentResolutionError(inputProblem);
  }
  client.setLosslessObservations(catalogOperation !== undefined);
  let outcome:
    | OperationOutcome
    | { kind: "started"; operationHandle: string }
    | { kind: "cancelled" };
  if (isBlockingFault(step, input)) {
    outcome = await armBlockingFault(client, instance, input);
  } else {
    outcome = handleStep
      ? await runOperationHandleStep(
          client,
          step,
          input,
          instance,
          startedOperations,
          timeoutMs
        )
      : await client.dispatch(
          step.operation,
          input,
          controls,
          instance,
          timeoutMs
        );
  }
  if (outcome.kind === "started" || outcome.kind === "cancelled") {
    throw new Error("orchestration receipt cannot become an observation");
  }
  observed.outcome = outcome;
  if (nativeOutcome) {
    validateTraceFaultOutcome(
      recorder,
      step,
      input,
      outcome,
      catalogOperation,
      check,
      processName,
      processEpoch
    );
  }
  const context = createAssertionContext(
    outcome,
    contextInput,
    catalogOperation !== undefined
  );
  if (nativeOutcome) {
    validateObservation(
      catalogOperation,
      outcome.kind === "result" ? context : {},
      outcome.kind === "result"
    );
  }
  if (outcome.kind === "error") {
    recorder.operationErrors.push(outcome.error);
  }

  const extraEvents = handleStep
    ? []
    : await client.events(step.operation, input, controls, instance, timeoutMs);
  observed.events = extraEvents;
  if (!handleStep) {
    validateObservation(catalogOperation, { events: extraEvents });
  }

  if (context.events === undefined && extraEvents.length > 0) {
    context.events = extraEvents;
  }

  const inspectedState =
    step.inspectState === undefined
      ? undefined
      : await client.inspectState(inspectQuery, instance, timeoutMs);
  if (step.inspectState !== undefined) {
    observed.inspectedState = inspectedState;
    validateObservation(catalogOperation, { state: inspectedState });
  }

  mergeInspectedState(context, inspectedState, outcome);

  return { context, extraEvents, outcome };
};

const recordSchedule = (
  recorder: CheckRecorder,
  step: ConformancePlanStep,
  arrivalSequence: number,
  input: unknown,
  process = "primary",
  receipt?: unknown
): void => {
  if (!recorder.recordCertification) {
    return;
  }
  recorder.schedule.push({
    action: step.action ?? "dispatch",
    arrivalSequence,
    ...(step.action === "release" ? { input } : {}),
    ...(step.action === "release" && step.participants !== undefined
      ? { participants: step.participants }
      : {}),
    operation: step.operation,
    process,
    ...(receipt === undefined ? {} : { receipt }),
    stepId: step.stepId,
  });
};

const barrierReceipt = (
  step: ConformancePlanStep,
  outcome: OperationOutcome,
  context: AssertionContext
): unknown =>
  step.operation === "kernel.barrier.wait" && outcome.kind === "result"
    ? context.result
    : undefined;

const diagnoseTraceStep = (
  check: ConformancePlanCheck,
  step: ConformancePlanStep,
  context: AssertionContext,
  arrivals: Record<string, number>,
  captures: Record<string, unknown>,
  recorder: CheckRecorder
): void => {
  if (step.assertions === undefined) {
    return;
  }
  const stepContext: RunnerContext = {
    ...context,
    arrivals: { ...arrivals },
    capture: { ...captures },
    faultActivations: recorder.faults.activations,
  };
  recorder.diagnoses.push(
    ...diagnoseAssertions(
      {
        ...check,
        assertions: step.assertions,
        checkId: `${check.checkId}.${step.stepId}`,
        operation: step.operation,
      },
      stepContext
    )
  );
};

type LifecycleAction = "restart" | "kill" | "respawn" | "openInstance";

const LIFECYCLE_OPERATIONS: Readonly<Record<LifecycleAction, string>> = {
  restart: "kernel.process.restart",
  kill: "kernel.process.kill",
  respawn: "kernel.process.respawn",
  openInstance: "kernel.instance.open",
};

const isLifecycleAction = (
  action: ConformancePlanStep["action"]
): action is LifecycleAction =>
  action !== undefined && Object.hasOwn(LIFECYCLE_OPERATIONS, action);

const arrivalIncrement = (
  previous: JsonRpcAdapterClient,
  current: JsonRpcAdapterClient
): number => (previous === current ? 0 : previous.latestArrivalSequence());

export interface FaultAttempt {
  afterSequence: number;
  operationHandle?: string;
}

interface LifecycleState {
  client: JsonRpcAdapterClient;
  instance: unknown;
  processRunning: boolean;
}

interface LifecycleStepRequest {
  action: LifecycleAction;
  catalogOperation: CatalogOperation | undefined;
  clocks: ReadonlyMap<
    string,
    { domain: string; source?: string; nowMs?: number }
  >;
  faultAttempts: ReadonlyMap<string, FaultAttempt>;
  processName?: string;
  input: unknown;
  recorder: CheckRecorder;
  timeoutMs: number;
  state: LifecycleState;
  step: ConformancePlanStep;
  storageRef: string | undefined;
  supervisor: ProcessSupervisor | undefined;
}

const killAfterFaultReceipts = async (
  client: JsonRpcAdapterClient,
  supervisor: ProcessSupervisor,
  recorder: CheckRecorder,
  timeoutMs: number,
  faultAttempts: ReadonlyMap<string, FaultAttempt>,
  processName = "primary"
): Promise<void> => {
  const epoch = supervisor.current.epoch;
  for (const arming of recorder.faults.armed.filter(
    (entry) =>
      entry.process === processName &&
      entry.epoch === epoch &&
      entry.mode === "block" &&
      !recorder.faults.isActivated(entry.token, processName, epoch)
  )) {
    const attempt = faultAttempts.get(arming.token);
    if (attempt?.operationHandle === undefined) {
      throw new MissingFaultActivationError(
        `no attempted operation for ${arming.token}`
      );
    }
    let receipt: unknown;
    try {
      receipt = await client.waitForFaultReached(
        arming.token,
        timeoutMs,
        attempt.afterSequence
      );
    } catch (error: unknown) {
      throw new MissingFaultActivationError(
        `missing faultReached for ${arming.token}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!recorder.faults.receipt(receipt, epoch, processName)) {
      throw new MissingFaultActivationError(
        `faultReached does not match arming and process epoch for ${arming.token}`
      );
    }
    try {
      await client.awaitOperation(attempt.operationHandle, 150);
    } catch (error: unknown) {
      if (error instanceof AdapterRequestTimeoutError) {
        continue;
      }
      throw error;
    }
    throw new SeamDidNotHoldError(`seam did not hold for ${arming.token}`);
  }
  await supervisor.kill();
  const exit = supervisor.current.exit;
  if (exit === undefined) {
    throw new Error("supervisor did not record the process exit");
  }
  recorder.faults.death(epoch, exit, processName);
};

const recordFaultAttempts = (
  step: ConformancePlanStep,
  client: JsonRpcAdapterClient,
  recorder: CheckRecorder,
  faultAttempts: Map<string, FaultAttempt>,
  processName = "primary",
  processEpoch = 1
): void => {
  if (step.action !== "start") {
    return;
  }
  for (const arming of recorder.faults.armed) {
    if (
      arming.process === processName &&
      arming.epoch === processEpoch &&
      arming.mode === "block" &&
      !faultAttempts.has(arming.token)
    ) {
      faultAttempts.set(arming.token, {
        afterSequence: client.nextFrameSequence(),
      });
    }
  }
};

const recordFaultAttemptHandles = (
  faultAttempts: Map<string, FaultAttempt>,
  operationHandle: string
): void => {
  for (const attempt of faultAttempts.values()) {
    if (attempt.operationHandle === undefined) {
      attempt.operationHandle = operationHandle;
    }
  }
};

const runLifecycleStep = async ({
  action,
  catalogOperation,
  clocks,
  faultAttempts,
  processName,
  input,
  recorder,
  state,
  step,
  storageRef,
  supervisor,
  timeoutMs,
}: LifecycleStepRequest): Promise<LifecycleState> => {
  if (supervisor === undefined || storageRef === undefined) {
    throw new ArgumentResolutionError(
      "lifecycle steps require supervised durable storage"
    );
  }
  const expected = LIFECYCLE_OPERATIONS[action];
  if (step.operation !== expected) {
    throw new ArgumentResolutionError(
      `lifecycle action ${action} requires ${expected}`
    );
  }
  const problem = controlInputProblem(catalogOperation, input);
  if (problem !== undefined) {
    throw new ArgumentResolutionError(problem);
  }
  let { client, instance, processRunning } = state;
  switch (action) {
    case "restart":
      await supervisor.restart();
      client = supervisor.client;
      instance = undefined;
      processRunning = true;
      break;
    case "kill": {
      await killAfterFaultReceipts(
        client,
        supervisor,
        recorder,
        timeoutMs,
        faultAttempts,
        processName
      );
      instance = undefined;
      processRunning = false;
      break;
    }
    case "respawn":
      await supervisor.respawn();
      client = supervisor.client;
      processRunning = true;
      break;
    case "openInstance":
      if (instance !== undefined) {
        throw new ArgumentResolutionError("process already owns an instance");
      }
      instance = await client.openInstance(storageRef);
      for (const [domain, clock] of clocks) {
        const outcome = await client.dispatch(
          "kernel.clock.set",
          clock,
          {},
          instance
        );
        if (outcome.kind !== "result") {
          throw new Error(`failed to restore ${domain} clock`);
        }
      }
      break;
    default:
      throw new ArgumentResolutionError(
        `unknown lifecycle action ${String(action)}`
      );
  }
  return { client, instance, processRunning };
};

const clearEpochHandles = (
  action: ConformancePlanStep["action"],
  started: Map<string, string>,
  faultAttempts: Map<string, FaultAttempt>
): void => {
  if (action === "kill" || action === "restart" || action === "respawn") {
    started.clear();
    faultAttempts.clear();
  }
};

const rememberClock = (
  step: ConformancePlanStep,
  outcome: OperationOutcome,
  input: unknown,
  clocks: Map<string, { domain: string; source?: string; nowMs?: number }>
): void => {
  if (
    step.action !== "setClock" ||
    outcome.kind !== "result" ||
    !isRecord(input) ||
    typeof input.domain !== "string" ||
    (typeof input.nowMs !== "number" && input.source !== "server")
  ) {
    return;
  }
  clocks.set(input.domain, {
    domain: input.domain,
    ...(typeof input.nowMs === "number" ? { nowMs: input.nowMs } : {}),
    ...(typeof input.source === "string" ? { source: input.source } : {}),
  });
};

export interface MultiTraceDependencies {
  appendCleanupFailure: typeof appendCleanupFailure;
  barrierReceipt: typeof barrierReceipt;
  bindControlInstance: typeof bindControlInstance;
  clearEpochHandles: typeof clearEpochHandles;
  createAdapterControls: typeof createAdapterControls;
  createAdapterInput: typeof createAdapterInput;
  createTraceStepRequest: typeof createTraceStepRequest;
  diagnoseTraceStep: typeof diagnoseTraceStep;
  isLifecycleAction: typeof isLifecycleAction;
  observeTraceStep: typeof observeTraceStep;
  readEvaluations: typeof readEvaluations;
  recordFaultAttemptHandles: typeof recordFaultAttemptHandles;
  recordFaultAttempts: typeof recordFaultAttempts;
  recordSchedule: typeof recordSchedule;
  rejectLegacySelectors: typeof rejectLegacySelectors;
  rememberClock: typeof rememberClock;
  runLifecycleStep: typeof runLifecycleStep;
  validateStartedInput: typeof validateStartedInput;
  withCheckCleanup: typeof withCheckCleanup;
}

const runTraceCheck = async (
  initialClient: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  recorder: CheckRecorder,
  storageRef?: string,
  supervisor?: ProcessSupervisor
): Promise<ConformanceCheckResult> => {
  const { check } = compiledCheck;
  const steps = check.steps ?? [];
  if (
    steps.some((step) => step.action === "spawn" || step.action === "collect")
  ) {
    return await runMultiTraceCheck(
      {
        appendCleanupFailure,
        barrierReceipt,
        bindControlInstance,
        clearEpochHandles,
        createAdapterControls,
        createAdapterInput,
        createTraceStepRequest,
        diagnoseTraceStep,
        isLifecycleAction,
        observeTraceStep,
        readEvaluations,
        recordFaultAttemptHandles,
        recordFaultAttempts,
        recordSchedule,
        rejectLegacySelectors,
        rememberClock,
        runLifecycleStep,
        validateStartedInput,
        withCheckCleanup,
      },
      initialClient,
      manifest,
      plan,
      compiledCheck,
      recorder,
      storageRef,
      supervisor
    );
  }
  const projected = steps.some((step) => step.arguments !== undefined);
  if (projected) {
    rejectLegacySelectors(check.input);
  }
  const baseInput = createAdapterInput(plan, compiledCheck);
  let client = initialClient;
  let instance = await client.createInstance(
    projected ? { checkInput: check.input } : baseInput,
    storageRef === undefined ? {} : { storageRef }
  );
  if (recorder.recordCertification) {
    recorder.storageIdentity = {
      kind: manifest.storage ?? "none",
      instance,
      ...(storageRef === undefined ? {} : { storageRef }),
    };
  }
  const trace: Record<
    string,
    AssertionContext & { outcome: OperationOutcome }
  > = {};
  const traceAdapterErrors: Record<string, unknown> = {};
  const startedOperations = new Map<string, string>();
  const faultAttempts = new Map<string, FaultAttempt>();
  const arrivals: Record<string, number> = {};
  const captureStore = createCaptureStore();
  const captures = captureStore.values;
  const handleCaptures: Record<string, string> = Object.create(null);
  const barriers = createBarrierSteps(handleCaptures);
  const clocks = new Map<
    string,
    { domain: string; source?: string; nowMs?: number }
  >();
  let processRunning = true;
  let arrivalOffset = 0;
  const latestArrival = (): number =>
    arrivalOffset + client.latestArrivalSequence();
  const argumentRoots: ArgumentRoots = {
    capture: captures,
    fixture:
      check.fixture === undefined
        ? undefined
        : plan.fixtures.get(check.fixture),
    input: check.input,
  };

  const visit = async (index: number): Promise<void> => {
    const step = steps[index];
    if (step === undefined) {
      return;
    }
    argumentRoots.capture = { ...captures, ...handleCaptures };
    const {
      contextInput,
      input: projectedInput,
      inspectQuery,
    } = createTraceStepRequest(step, check, baseInput, trace, argumentRoots);
    const catalogOperation = plan.catalog?.operations.get(step.operation);
    const controls = {
      ...createAdapterControls(compiledCheck),
      ...step.controls,
    };
    const input = bindControlInstance(
      catalogOperation,
      barriers.input(step, projectedInput),
      instance
    );
    recorder.arguments.push({
      input,
      ...(inspectQuery === undefined ? {} : { inspectQuery }),
      operation: step.operation,
      stepId: step.stepId,
    });
    if (isLifecycleAction(step.action)) {
      const previousClient = client;
      ({ client, instance, processRunning } = await runLifecycleStep({
        action: step.action,
        catalogOperation,
        clocks,
        faultAttempts,
        input,
        recorder,
        timeoutMs: Math.min(controls.deadlineMs ?? 10_000, 10_000),
        state: { client, instance, processRunning },
        step,
        storageRef,
        supervisor,
      }));
      arrivalOffset += arrivalIncrement(previousClient, client);
      clearEpochHandles(step.action, startedOperations, faultAttempts);
      const outcome: OperationOutcome = {
        kind: "result",
        value: { result: {} },
      };
      validateObservation(catalogOperation, { result: {} });
      const context = {
        input: contextInput,
        result: {},
        processExits: Object.fromEntries(
          (supervisor?.history ?? []).flatMap((entry) =>
            entry.exit === undefined ? [] : [[entry.epoch, entry.exit]]
          )
        ),
      };
      trace[step.stepId] = { ...context, outcome };
      recorder.observation.push({
        operation: step.operation,
        stepId: step.stepId,
        outcome,
      });
      const arrivalSequence = latestArrival();
      arrivals[step.stepId] = arrivalSequence;
      recordSchedule(recorder, step, arrivalSequence, input);
      recordStepCaptures(step.capture, context, captureStore);
      diagnoseTraceStep(check, step, context, arrivals, captures, recorder);
      await visit(index + 1);
      return;
    }
    validateStartedInput(step, catalogOperation, input);
    if (step.action === "start" || step.action === "cancel") {
      client.setLosslessObservations(catalogOperation !== undefined);
      recordFaultAttempts(
        step,
        client,
        recorder,
        faultAttempts,
        "primary",
        supervisor?.current.epoch ?? 1
      );
      const receipt = await runOperationHandleStep(
        client,
        step,
        input,
        instance,
        startedOperations,
        controls.deadlineMs
      );
      const arrivalSequence = latestArrival();
      arrivals[step.stepId] = arrivalSequence;
      recordSchedule(recorder, step, arrivalSequence, input);
      if (receipt.kind === "started") {
        recordFaultAttemptHandles(faultAttempts, receipt.operationHandle);
        recordHandleCapture(
          step.handleCapture,
          receipt.operationHandle,
          captureStore,
          handleCaptures
        );
        barriers.started(step.stepId, step.handleCapture);
      }
      await visit(index + 1);
      return;
    }
    const observed: StepObservationRecord = {
      operation: step.operation,
      stepId: step.stepId,
    };
    recorder.observation.push(observed);
    const { context, extraEvents, outcome } = await observeTraceStep({
      catalogOperation,
      check,
      client,
      contextInput,
      controls,
      input,
      inspectQuery,
      instance,
      observed,
      processEpoch: supervisor?.current.epoch ?? 1,
      recorder,
      startedOperations,
      step,
    });
    rememberClock(step, outcome, input, clocks);
    barriers.observe(step, input, outcome);
    const arrivalSequence = latestArrival();
    arrivals[step.stepId] = arrivalSequence;
    recordSchedule(
      recorder,
      step,
      arrivalSequence,
      input,
      "primary",
      barrierReceipt(step, outcome, context)
    );
    if (outcome.kind === "error") {
      traceAdapterErrors[step.stepId] = outcome.error;
    }

    trace[step.stepId] = { ...context, outcome };
    recordStepCaptures(
      step.capture,
      { ...context, events: context.events ?? extraEvents },
      captureStore
    );

    diagnoseTraceStep(check, step, context, arrivals, captures, recorder);
    await visit(index + 1);
  };
  return await withCheckCleanup(
    async () => {
      await visit(0);
      const finalContext: RunnerContext = {
        arrivals,
        capture: captures,
        evidence: { trace },
        faultActivations: recorder.faults.activations,
        processExits: Object.fromEntries(
          (supervisor?.history ?? []).flatMap((entry) =>
            entry.exit === undefined ? [] : [[entry.epoch, entry.exit]]
          )
        ),
        fixture: baseInput.fixture,
        input: baseInput.checkInput,
        result: { trace },
        scenario: baseInput.scenario,
        state: { trace },
      };
      recorder.diagnoses.push(
        ...diagnoseAssertions(check, finalContext),
        ...diagnoseRequiredEvidence(
          compiledCheck,
          finalContext,
          plan.catalog?.operations.has(check.operation) === true
        )
      );

      return createCheckResult(check.checkId, readEvaluations(recorder), {
        adapterId: manifest.adapterId,
        planId: plan.plan.planId,
        ...(Object.keys(traceAdapterErrors).length > 0
          ? { adapterErrors: traceAdapterErrors }
          : {}),
        traceStepIds: Object.keys(trace),
      });
    },
    async () => {
      if (processRunning && instance !== undefined) {
        await client.destroyInstance(instance);
      }
    },
    (result, error) => {
      if (result.status !== "fail") {
        recorder.thrown = error;
      }
      return appendCleanupFailure(result, error);
    }
  );
};

const executeCheck = async (
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  recorder: CheckRecorder,
  storageRef?: string,
  supervisor?: ProcessSupervisor
): Promise<ConformanceCheckResult> => {
  const { check } = compiledCheck;

  try {
    client.setLosslessObservations(false);
    if (supervisor === undefined) {
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
    }

    if (Array.isArray(check.steps) && check.steps.length > 0) {
      return await runTraceCheck(
        client,
        manifest,
        plan,
        compiledCheck,
        recorder,
        storageRef,
        supervisor
      );
    }

    const input = createAdapterInput(plan, compiledCheck);
    const instance =
      storageRef === undefined
        ? undefined
        : await client.createInstance(input, { storageRef });
    return await withCheckCleanup(
      async () => {
        const controls = createAdapterControls(compiledCheck);
        const timeoutMs = controls.deadlineMs;
        recorder.arguments.push({ input, operation: check.operation });
        const observed: StepObservationRecord = { operation: check.operation };
        recorder.observation.push(observed);
        const catalogOperation = plan.catalog?.operations.get(check.operation);
        if (catalogOperation?.faultOutcome !== undefined) {
          throw new ArgumentResolutionError(
            "fault arming requires an armFault trace step"
          );
        }
        client.setLosslessObservations(catalogOperation !== undefined);
        const outcome = await client.dispatch(
          check.operation,
          input,
          controls,
          instance,
          timeoutMs
        );
        observed.outcome = outcome;
        if (outcome.kind === "error") {
          recorder.operationErrors.push(outcome.error);
          validateNativeError(
            outcome.error,
            catalogOperation,
            nativeErrorAsserted(check)
          );
        }
        const context = createAssertionContext(
          outcome,
          input,
          catalogOperation !== undefined
        );
        validateObservation(
          catalogOperation,
          outcome.kind === "result" ? context : {},
          outcome.kind === "result"
        );
        const extraEvents = await client.events(
          check.operation,
          input,
          controls,
          instance,
          timeoutMs
        );
        observed.events = extraEvents;
        validateObservation(catalogOperation, { events: extraEvents });

        if (context.events === undefined && extraEvents.length > 0) {
          context.events = extraEvents;
        }

        const inspectedState = await client.inspectState(
          {
            operation: check.operation,
          },
          instance,
          timeoutMs
        );
        observed.inspectedState = inspectedState;
        validateObservation(catalogOperation, { state: inspectedState });

        mergeInspectedState(context, inspectedState, outcome);

        recorder.diagnoses.push(
          ...diagnoseAssertions(check, context),
          ...diagnoseRequiredEvidence(
            compiledCheck,
            context,
            catalogOperation !== undefined
          )
        );

        return createCheckResult(check.checkId, readEvaluations(recorder), {
          // Adapter-declared operation errors stay isolated from $.result.error,
          // but persisted evidence still records the native error for diagnosis.
          ...(outcome.kind === "error" ? { adapterError: outcome.error } : {}),
          adapterId: manifest.adapterId,
          planId: plan.plan.planId,
        });
      },
      async () => {
        if (instance !== undefined) {
          await client.destroyInstance(instance);
        }
      },
      (result, error) => {
        if (result.status !== "fail") {
          recorder.thrown = error;
        }
        return appendCleanupFailure(result, error);
      }
    );
  } catch (error: unknown) {
    recorder.thrown = error;
    const message = readErrorMessage(error);
    if (error instanceof UnsupportedFaultPointError) {
      return createCheckResult(
        check.checkId,
        [
          ...readEvaluations(recorder),
          {
            assertionId: `${check.checkId}.faultSupport`,
            message,
            status: "unsupported",
          },
        ],
        {
          adapterId: manifest.adapterId,
          planId: plan.plan.planId,
          unsupported: { code: error.code, message },
        }
      );
    }
    const assertionResults = [
      ...(error instanceof NativeOperationError
        ? [
            {
              assertionId: `${check.checkId}.nativeError`,
              message,
              status: "fail" as const,
            },
          ]
        : []),
      ...check.assertions.map((assertion, index) => ({
        assertionId: assertionId(check.checkId, index, assertion.kind),
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
      ...(error instanceof ArgumentResolutionError
        ? { verificationError: message }
        : { adapterError: readAdapterFailure(error) }),
      adapterId: manifest.adapterId,
      planId: plan.plan.planId,
    });
  }
};

const classifyFailure = (
  recorder: CheckRecorder,
  checkStderr: string
): ConformanceFailureClassification => {
  const thrown = primaryError(recorder.thrown);

  if (
    thrown instanceof ProcessStartError ||
    thrown instanceof StorageResourceError
  ) {
    return "environment";
  }

  if (
    thrown instanceof ArgumentResolutionError ||
    thrown instanceof MissingFaultActivationError ||
    thrown instanceof SeamDidNotHoldError
  ) {
    return "verification";
  }

  if (thrown instanceof ObservationEncodingError) {
    return "adapter_protocol";
  }
  if (thrown instanceof NativeOperationError) {
    return "implementation";
  }

  const signals = [
    checkStderr,
    ...recorder.operationErrors.map((error) => JSON.stringify(error)),
    ...(thrown === undefined
      ? []
      : [readErrorMessage(thrown), JSON.stringify(readAdapterFailure(thrown))]),
  ];

  if (signals.some((signal) => ENVIRONMENT_FAILURE.test(signal))) {
    return "environment";
  }

  if (thrown !== undefined) {
    return "adapter_protocol";
  }

  return recorder.diagnoses.some(
    ({ evaluation, unresolved }) => evaluation.status === "fail" && unresolved
  )
    ? "verification"
    : "implementation";
};

const createFailure = async (
  client: JsonRpcAdapterClient,
  mark: AdapterTranscriptMark,
  recorder: CheckRecorder,
  replay: string,
  storageRef?: string,
  supervisor?: ProcessSupervisor
): Promise<ConformanceFailure> => {
  const exit = await (supervisor?.latestClient() ?? client).exitStatus();
  const operands = recorder.diagnoses
    .filter(({ evaluation }) => evaluation.status === "fail")
    .flatMap(({ operands: entries }) => entries);
  const stderr =
    recorder.processes === undefined
      ? (supervisor?.stderr() ?? client.stderrSince(mark))
      : [...recorder.processes]
          .map(([name, process]) => `${name}: ${process.stderr()}`)
          .join("\n");
  const stderrTail = stderr.slice(-STDERR_TAIL_CHARS);

  return {
    ...(recorder.arguments.length > 0 ? { arguments: recorder.arguments } : {}),
    classification: classifyFailure(recorder, stderr),
    ...(recorder.faults.armed.length === 0
      ? {}
      : {
          fault: {
            activations: recorder.faults.activations,
            armed: recorder.faults.armed,
            receipts: recorder.faults.receipts,
          },
        }),
    ...(exit === undefined ? {} : { exit }),
    frameLog:
      recorder.processes === undefined
        ? (supervisor?.frames() ?? client.framesSince(mark))
        : [...recorder.processes].flatMap(([name, process]) =>
            process.frames().map((frame) => ({ ...frame, process: name }))
          ),
    ...(recorder.observation.length > 0
      ? { observation: recorder.observation }
      : {}),
    ...(operands.length > 0 ? { operands } : {}),
    replay,
    ...(storageRef === undefined ? {} : { storageRef }),
    ...(stderrTail.length > 0 ? { stderrTail } : {}),
  };
};

const runCheck = async (
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  replay: string,
  recordCertification: boolean,
  storageRef?: string,
  supervisor?: ProcessSupervisor
): Promise<ConformanceCheckResult> => {
  const mark = client.markTranscript();
  const recorder: CheckRecorder = {
    arguments: [],
    diagnoses: [],
    faults: createFaultActivationTracker(),
    observation: [],
    operationErrors: [],
    recordCertification,
    ...(!recordCertification || storageRef === undefined
      ? {}
      : { storageIdentity: { kind: manifest.storage, storageRef } }),
    schedule: [],
  };
  let checkResult = await executeCheck(
    client,
    manifest,
    plan,
    compiledCheck,
    recorder,
    storageRef,
    supervisor
  );

  const missing = recorder.faults.missing();
  const missingBlockedFault = recorder.faults.armed.some(
    (arming) =>
      arming.mode === "block" &&
      !recorder.faults.isActivated(arming.token, arming.process, arming.epoch)
  );
  if (
    missing.length > 0 &&
    !(primaryError(recorder.thrown) instanceof SeamDidNotHoldError) &&
    (missingBlockedFault ||
      recorder.thrown === undefined ||
      primaryError(recorder.thrown) instanceof MissingFaultActivationError)
  ) {
    const rejection = new MissingFaultActivationError(
      `armed faults never activated: ${missing.join(", ")}`
    );
    if (
      recorder.thrown === undefined ||
      primaryError(recorder.thrown) instanceof MissingFaultActivationError
    ) {
      recorder.thrown = rejection;
    }
    checkResult = createCheckResult(
      checkResult.checkId,
      [
        ...checkResult.assertionResults,
        {
          assertionId: `${checkResult.checkId}.faultActivation`,
          message: rejection.message,
          status: "fail",
        },
      ],
      {
        ...checkResult.details,
        experimentStatus: "invalid",
        rejection: { code: rejection.code, tokens: missing },
      }
    );
  }
  const failure = primaryError(recorder.thrown);
  if (failure instanceof SeamDidNotHoldError) {
    checkResult = createCheckResult(
      checkResult.checkId,
      checkResult.assertionResults,
      {
        ...checkResult.details,
        experimentStatus: "invalid",
        rejection: { code: failure.code, message: failure.message },
      }
    );
  }
  if (recorder.faults.armed.length > 0) {
    checkResult = {
      ...checkResult,
      details: {
        ...checkResult.details,
        fault: {
          activations: recorder.faults.activations,
          armed: recorder.faults.armed,
          receipts: recorder.faults.receipts,
        },
      },
    };
  }
  if (recordCertification) {
    if (
      recorder.schedule.length === 0 &&
      (compiledCheck.check.steps?.length ?? 0) === 0 &&
      checkResult.status === "pass"
    ) {
      recorder.schedule.push({
        action: "dispatch",
        arrivalSequence: client.latestArrivalSequence(),
        operation: compiledCheck.check.operation,
        process: "primary",
        stepId: "dispatch",
      });
    }
    checkResult = {
      ...checkResult,
      details: {
        ...checkResult.details,
        schedule: recorder.schedule,
        traceObservations: recorder.observation,
        ...(recorder.processes === undefined
          ? {}
          : {
              processes: [...recorder.processes].map(([name, process]) => ({
                name,
                pid: process.current.pid,
                epochs: process.history,
                ...(process.current.exit === undefined
                  ? {}
                  : { exit: process.current.exit }),
                stderrTail: process.stderr().slice(-STDERR_TAIL_CHARS),
              })),
            }),
        storageIdentity: recorder.storageIdentity ?? {
          kind: manifest.storage ?? "none",
        },
      },
    };
  }
  if (checkResult.status !== "fail") {
    return checkResult;
  }

  return {
    ...checkResult,
    failure: await createFailure(
      client,
      mark,
      recorder,
      replay,
      storageRef,
      supervisor
    ),
  };
};

const shellQuote = (part: string): string =>
  SHELL_SAFE.test(part) ? part : `'${part.replaceAll("'", `'"'"'`)}'`;

/** A repository-root command that reruns exactly one check. */
const createReplayCommand = (options: CliOptions, checkId: string): string =>
  [
    "bun",
    "tools/conformance/harness/run.ts",
    "--adapter",
    options.adapter,
    ...options.packets.flatMap((packet) => ["--packet", packet]),
    ...options.plans.flatMap((plan) => ["--plan", plan]),
    "--check",
    checkId,
  ]
    .map(shellQuote)
    .join(" ");

const retainFailureArtifacts = async (text: string): Promise<string> => {
  const logs = await createVerificationLogs(
    nodePath.resolve(
      REPO_ROOT,
      process.env.VERIFY_LOG_DIR ?? ".cache/verification"
    )
  );
  const file = await logs.create(text);
  await logs.finish(false);
  return file;
};

/** In-band failure blocks carry a bounded frame preview. */
const previewFailure = (
  checkResult: ConformanceCheckResult
): ConformanceCheckResult =>
  checkResult.failure?.frameLog === undefined
    ? checkResult
    : {
        ...checkResult,
        failure: {
          ...checkResult.failure,
          frameLog: previewFrames(checkResult.failure.frameLog),
        },
      };

const executeScheduledCheck = async (
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  scheduledCheck: ScheduledCheck,
  replayFor: (checkId: string) => string,
  recordCertification: boolean
): Promise<ConformanceCheckResult> => {
  let checkStorageRef: string | undefined;
  let supervision: ProcessSupervisor | undefined;
  const execute = async (
    storageRef?: string
  ): Promise<ConformanceCheckResult> => {
    checkStorageRef = storageRef;
    const lifecycle =
      scheduledCheck.compiledCheck.check.steps?.some(
        (step) => isLifecycleAction(step.action) || step.action === "spawn"
      ) === true;
    if (!lifecycle) {
      return await runCheck(
        client,
        manifest,
        scheduledCheck.plan,
        scheduledCheck.compiledCheck,
        replayFor(scheduledCheck.compiledCheck.check.checkId),
        recordCertification,
        storageRef
      );
    }
    if (manifest.executable === undefined || storageRef === undefined) {
      throw new Error(
        "lifecycle checks require a directly executable adapter and durable storage"
      );
    }
    const supervisor = await ProcessSupervisor.start({
      executable: manifest.executable,
      args: adapterCommand(manifest).slice(1),
      cwd: REPO_ROOT,
      packetId: scheduledCheck.plan.plan.packetId,
      planVersion: scheduledCheck.plan.plan.planVersion,
      validateHandshake: (capabilities) =>
        validateAdapterHandshake(
          capabilities,
          manifest,
          scheduledCheck.plan.plan.packetId,
          scheduledCheck.plan.plan.planVersion
        ),
    });
    supervision = supervisor;
    const checkResult = await withCheckCleanup(
      async () =>
        await runCheck(
          supervisor.client,
          manifest,
          scheduledCheck.plan,
          scheduledCheck.compiledCheck,
          replayFor(scheduledCheck.compiledCheck.check.checkId),
          recordCertification,
          storageRef,
          supervisor
        ),
      async () => await supervisor.close(),
      (result, error) =>
        appendCleanupFailure(result, error, replayFor(result.checkId))
    );
    const processCrash =
      scheduledCheck.compiledCheck.check.steps?.some(
        (step) => step.action === "armFault" && step.arguments?.mode === "block"
      ) === true;
    const processDetails = checkResult.details?.processes;
    const completedProcesses = Array.isArray(processDetails)
      ? processDetails.map((entry: unknown) =>
          isRecord(entry) && entry.name === "primary"
            ? {
                ...entry,
                pid: supervisor.current.pid,
                epochs: supervisor.history,
                exit: supervisor.current.exit,
                stderrTail: supervisor.stderr().slice(-STDERR_TAIL_CHARS),
              }
            : entry
        )
      : [
          {
            name: "primary",
            pid: supervisor.current.pid,
            epochs: supervisor.history,
            exit: supervisor.current.exit,
            stderrTail: supervisor.stderr().slice(-STDERR_TAIL_CHARS),
          },
        ];
    return recordCertification || processCrash
      ? {
          ...checkResult,
          details: {
            ...checkResult.details,
            ...(completedProcesses === undefined
              ? {}
              : { processes: completedProcesses }),
            ...(recordCertification
              ? { storageIdentity: { kind: manifest.storage, storageRef } }
              : {}),
            process: { epochs: supervisor.history },
          },
        }
      : checkResult;
  };
  let checkResult: ConformanceCheckResult;
  try {
    let resultBeforeStorageCleanup: ConformanceCheckResult | undefined;
    const trackedExecute = async (
      ref?: string
    ): Promise<ConformanceCheckResult> => {
      const serverVersion =
        recordCertification &&
        manifest.storage === "postgres-database" &&
        ref !== undefined
          ? await postgresServerVersion(ref)
          : undefined;
      const result = await execute(ref);
      resultBeforeStorageCleanup =
        serverVersion === undefined
          ? result
          : {
              ...result,
              details: {
                ...result.details,
                storageIdentity: {
                  kind: manifest.storage,
                  storageRef: ref,
                  serverVersion,
                },
              },
            };
      return resultBeforeStorageCleanup;
    };
    checkResult =
      manifest.storage === "sqlite-directory" ||
      manifest.storage === "postgres-database"
        ? await withCheckStorage(manifest.storage, trackedExecute).catch(
            (error: unknown) => {
              if (
                error instanceof CleanupError &&
                resultBeforeStorageCleanup !== undefined
              ) {
                return appendCleanupFailure(
                  resultBeforeStorageCleanup,
                  error,
                  replayFor(resultBeforeStorageCleanup.checkId)
                );
              }
              throw error;
            }
          )
        : await trackedExecute();
  } catch (error: unknown) {
    const checkId = scheduledCheck.compiledCheck.check.checkId;
    const message = readErrorMessage(error);
    const cause = primaryError(error);
    checkResult = {
      ...createCheckResult(
        checkId,
        [{ assertionId: `${checkId}.setup`, message, status: "fail" }],
        {
          adapterId: manifest.adapterId,
          planId: scheduledCheck.plan.plan.planId,
          ...(!recordCertification || supervision === undefined
            ? {}
            : { process: { epochs: supervision.history } }),
        }
      ),
      failure: {
        classification:
          cause instanceof StorageResourceError ||
          cause instanceof ProcessStartError
            ? "environment"
            : "adapter_protocol",
        replay: replayFor(checkId),
        ...(checkStorageRef === undefined
          ? {}
          : { storageRef: checkStorageRef }),
      },
    };
  }

  return checkResult;
};

export const runScheduledChecks = async (
  manifest: AdapterManifest,
  scheduled: readonly ScheduledCheck[],
  concurrency: number,
  replayFor: (checkId: string) => string,
  recordCertification: boolean
): Promise<RunResult[]> => {
  const results: RunResult[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, scheduled.length);
  const workers = Array.from({ length: workerCount }, async () => {
    const client = new JsonRpcAdapterClient({
      command: adapterCommand(manifest),
      cwd: REPO_ROOT,
    });

    const owned: RunResult[] = [];
    const visit = async (): Promise<void> => {
      if (nextIndex >= scheduled.length) {
        return;
      }
      // Each worker owns one adapter process and runs checks serially inside
      // that process, preventing stateful adapters from racing inspectState.
      const scheduledCheck = scheduled[nextIndex];
      nextIndex += 1;

      if (scheduledCheck === undefined) {
        return;
      }

      const checkResult = await executeScheduledCheck(
        client,
        manifest,
        scheduledCheck,
        replayFor,
        recordCertification
      );
      const result = {
        checkResult,
        index: scheduledCheck.index,
      };
      results.push(result);
      owned.push(result);
      await visit();
    };
    try {
      await withCleanup(visit, async () => await client.shutdown());
    } catch (error: unknown) {
      if (
        !(error instanceof CleanupError && error.hasResult) ||
        owned.length === 0
      ) {
        throw error;
      }
      for (const result of owned) {
        result.checkResult = appendCleanupFailure(
          result.checkResult,
          error,
          replayFor(result.checkResult.checkId)
        );
      }
    }
    if (recordCertification) {
      const exit = await client.terminationStatus();
      for (const result of owned) {
        result.checkResult = {
          ...result.checkResult,
          details: {
            ...result.checkResult.details,
            process: result.checkResult.details?.process ?? {
              pid: client.processId(),
              exit: exit ?? null,
              supervisorTerminated: client.wasTerminatedBySupervisor(),
            },
          },
        };
      }
    }
  });

  await Promise.all(workers);
  return results;
};

const validateHandshakeForSelectedPlans = async (
  manifest: AdapterManifest,
  plans: readonly CompiledConformancePlan[],
  required: boolean
): Promise<void> => {
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
    command: adapterCommand(manifest),
    cwd: REPO_ROOT,
  });

  try {
    const packets = [...uniquePackets.values()];
    const visit = async (index: number): Promise<void> => {
      const packet = packets[index];
      if (packet === undefined) {
        return;
      }
      client.setLosslessObservations(false);
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
      await visit(index + 1);
    };
    await visit(0);
  } finally {
    await client.shutdown();
  }
};

const selectChecks = (
  plans: readonly CompiledConformancePlan[],
  manifest: AdapterManifest,
  options: CliOptions
): {
  applicable: ScheduledCheck[];
  selection: NonNullable<ConformanceEvidence["selection"]>;
} => {
  const adapterCapabilities = new Set(manifest.capabilities);
  const requestedCapabilities = new Set(options.capabilities);
  const requestedChecks = new Set(options.checks);
  const availableCapabilities = new Set<string>();
  const availableCheckIds = new Set<string>();
  const applicable: ScheduledCheck[] = [];
  const selection: { checkId: string; selected: boolean; reason?: string }[] =
    [];
  let index = 0;

  for (const plan of [...plans].toSorted((left, right) =>
    left.plan.planId.localeCompare(right.plan.planId)
  )) {
    for (const compiledCheck of [...plan.checks].toSorted((left, right) =>
      left.check.checkId.localeCompare(right.check.checkId)
    )) {
      const { check } = compiledCheck;
      availableCheckIds.add(check.checkId);

      if (requestedChecks.size > 0 && !requestedChecks.has(check.checkId)) {
        selection.push({
          checkId: check.checkId,
          reason: "not run: outside requested checks",
          selected: false,
        });
        continue;
      }

      const requiredCapabilities = [
        ...plan.plan.applicability.capabilities,
        ...(check.capabilities ?? []),
        ...(needsServerClock(check.steps) ? ["clock.backend-server"] : []),
      ];

      for (const capability of requiredCapabilities) {
        availableCapabilities.add(capability);
      }

      const entry = selectCheck({
        adapter: adapterCapabilities,
        checkId: check.checkId,
        protocolVersion: manifest.protocol.version,
        requested: requestedCapabilities,
        required: requiredCapabilities,
        steps: check.steps,
      });
      selection.push(entry);
      if (!entry.selected) {
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
      `unknown --check value(s): ${unknownRequestedChecks.toSorted().join(", ")}`
    );
  }

  const unknownRequestedCapabilities = [...requestedCapabilities].filter(
    (capability) => !availableCapabilities.has(capability)
  );

  if (unknownRequestedCapabilities.length > 0) {
    throw new Error(
      `unknown --capability value(s): ${unknownRequestedCapabilities.toSorted().join(", ")}`
    );
  }

  return {
    applicable,
    selection,
  };
};

const applyShard = (
  scheduled: readonly ScheduledCheck[],
  options: CliOptions
): ScheduledCheck[] => {
  const { shard } = options;

  if (shard === undefined) {
    return [...scheduled];
  }

  return scheduled.filter(
    (_entry, index) => index % shard.count === shard.index
  );
};

interface ProfileFinding {
  checkId: string;
  details: Record<string, string>;
  message: string;
  replay: string;
}

const profileReplay = (
  options: CliOptions,
  project: string | undefined,
  checkId?: string
): string => {
  if (project === undefined) {
    return checkId === undefined
      ? `bun tools/conformance/harness/run.ts --adapter ${shellQuote(options.adapter)}`
      : createReplayCommand(options, checkId);
  }
  return [
    "bun",
    "tools/conformance/certification/replay.ts",
    "--project",
    project,
    ...options.packets.flatMap((packet) => ["--packet", packet]),
    ...options.plans.flatMap((plan) => ["--plan", plan]),
    ...(checkId === undefined ? [] : ["--check", checkId]),
  ]
    .map(shellQuote)
    .join(" ");
};

const collectProfileFindings = (
  profiles: readonly CertificationProfile[],
  plans: readonly CompiledConformancePlan[],
  selection: NonNullable<ConformanceEvidence["selection"]>,
  manifest: AdapterManifest,
  options: CliOptions,
  project: string | undefined
): ProfileFinding[] => {
  const complete =
    options.checks.length === 0 &&
    options.capabilities.length === 0 &&
    options.packets.length === 0 &&
    options.plans.length === 0 &&
    options.shard === undefined;
  const findings: ProfileFinding[] = findProfileSelectionFailures(
    profiles,
    plans,
    selection
  ).map((failure) => ({
    checkId: `profile.${failure.profileId}.required.${failure.requiredCheckId}`,
    details: {
      profileId: failure.profileId,
      requiredCheckId: failure.requiredCheckId,
      reason: failure.reason,
    },
    message: `claimed profile ${failure.profileId} requires check ${failure.requiredCheckId}, which is not applicable: ${failure.reason}`,
    replay: profileReplay(options, project, failure.requiredCheckId),
  }));
  if (!complete) {
    return findings;
  }
  for (const profile of profiles) {
    assertProfileClaimInventory(profile, plans);
    if (profile.profileId === "kernel.memory") {
      assertKernelMemoryClaimInventory(profile, plans);
    }
    for (const capability of profile.requiredCapabilities) {
      if (!manifest.capabilities.includes(capability)) {
        findings.push({
          checkId: `profile.${profile.profileId}.capability.${capability}`,
          details: {
            profileId: profile.profileId,
            missingCapability: capability,
            reason: `missing capability: ${capability}`,
          },
          message: `claimed profile ${profile.profileId} requires capability ${capability}`,
          replay: profileReplay(options, project),
        });
      }
    }
  }
  return findings;
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  if (
    options.controlReport !== undefined &&
    options.evidenceOut === undefined
  ) {
    throw new Error(
      "--control-report requires --evidence-out for certificate bundles"
    );
  }
  const adapterManifest = await readAdapterManifest(options.adapter);
  const certificationManifest = await readCertificationManifest(
    nodePath.resolve(REPO_ROOT, options.certificationManifest)
  );
  const certifiedEntries = findCertifiedEntriesForAdapter(
    certificationManifest,
    options.adapter,
    REPO_ROOT
  );
  const plans = await readPlans(adapterManifest, options);
  const selected = selectChecks(plans, adapterManifest, options);
  const profiles = await readClaimedProfiles(
    adapterManifest,
    options.packets.length > 0
      ? options.packets
      : adapterManifest.authorityPackets
  );
  const certifiedProfiles = profiles.filter((profile) =>
    certifiedEntries.some((entry) => entry.profile === profile.profileId)
  );
  const missingCertifiedProfiles = certifiedEntries.filter(
    (entry) =>
      entry.profile !== adapterManifest.suiteId &&
      !certifiedProfiles.some((profile) => profile.profileId === entry.profile)
  );
  const profileFindings = collectProfileFindings(
    profiles,
    plans,
    selected.selection,
    adapterManifest,
    options,
    options.certificationManifest === CERTIFICATION_MANIFEST_PATH
      ? certificationManifest.inventory.find(
          (entry) =>
            nodePath.resolve(REPO_ROOT, entry.adapter) ===
            nodePath.resolve(REPO_ROOT, options.adapter)
        )?.project
      : undefined
  );
  for (const finding of profileFindings) {
    process.stderr.write(`${finding.message}\n`);
  }
  await validateHandshakeForSelectedPlans(
    adapterManifest,
    plans,
    selected.applicable.length === 0
  );

  const scheduled = applyShard(selected.applicable, options);
  const scheduledIds = new Set(
    scheduled.map(({ compiledCheck }) => compiledCheck.check.checkId)
  );
  const selection = selected.selection.map((entry) =>
    entry.selected && !scheduledIds.has(entry.checkId)
      ? {
          checkId: entry.checkId,
          reason: "not run: assigned to another shard",
          selected: false,
        }
      : entry
  );
  selection.push(
    ...profileFindings.map((finding) => ({
      checkId: finding.checkId,
      selected: true,
    }))
  );
  const digestsBefore = await beginCertificate(
    options,
    adapterManifest,
    certifiedProfiles
  );
  const recordCertification =
    digestsBefore !== undefined || options.captureObservations;
  const results = await runScheduledChecks(
    adapterManifest,
    scheduled,
    options.concurrency,
    (checkId) => createReplayCommand(options, checkId),
    recordCertification
  );

  const checkResults = results
    .toSorted((left, right) => left.index - right.index)
    .map((result) => result.checkResult);
  checkResults.push(
    ...profileFindings.map((finding) => ({
      ...createCheckResult(
        finding.checkId,
        [
          {
            assertionId: `${finding.checkId}.applicability`,
            status: "fail",
            message: finding.message,
          },
        ],
        finding.details
      ),
      failure: {
        classification: "verification" as const,
        replay: finding.replay,
      },
    }))
  );
  const baseSummary = createConformanceEvidenceSummary(checkResults);
  const nonApplicableCheckIds = selection
    .filter(
      (entry) => !(entry.selected || entry.reason?.startsWith("not run:"))
    )
    .map((entry) => entry.checkId);
  const summary = {
    ...baseSummary,
    applicableChecks: checkResults.length,
    nonApplicableChecks: nonApplicableCheckIds.length,
    totalChecks: checkResults.length + nonApplicableCheckIds.length,
  };
  const evidence: ConformanceEvidence = {
    adapterId: adapterManifest.adapterId,
    ...(certifiedProfiles.length === 0 ? {} : { runId: randomUUID() }),
    boundary: adapterManifest.boundary,
    capabilities: [...adapterManifest.capabilities].toSorted(),
    checkResults,
    implementationId: adapterManifest.implementationId,
    language: adapterManifest.language,
    nonApplicableCheckIds,
    selection,
    status: deriveConformanceRunStatus(summary),
    suiteId: adapterManifest.suiteId,
    suiteVersion: adapterManifest.suiteVersion,
    summary,
  };
  const bundles = await finalizeProfileBundles(
    options,
    adapterManifest,
    certifiedProfiles,
    plans,
    evidence,
    digestsBefore
  );
  if (summary.failedChecks > 0) {
    process.stderr.write(
      `conformance failure artifacts retained at ${await retainFailureArtifacts(
        `${JSON.stringify(evidence, null, 2)}\n`
      )}\n`
    );
  }

  await writeRunOutput(options, evidence, bundles, previewFailure);

  if (evidence.status === "fail" && !options.allowFailingEvidence) {
    process.exitCode = 1;
  }
  if (
    !requiredCertificatesPassed(
      options.requireCertified,
      bundles,
      missingCertifiedProfiles
    )
  ) {
    process.exitCode = 1;
  }
  if (!certifiedSelectionPassed(certifiedEntries, selected.applicable.length)) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
