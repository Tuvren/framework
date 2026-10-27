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

import { mkdir, writeFile } from "node:fs/promises";
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
import {
  beginCertificate,
  finishCertificate,
} from "../certification/bundle.js";
import {
  CERTIFICATION_MANIFEST_PATH,
  findCertifiedEntriesForAdapter,
  readCertificationManifest,
} from "../certification/certification-manifest.js";
import {
  assertKernelMemoryClaimInventory,
  findProfileSelectionFailures,
  readClaimedProfiles,
} from "../certification/profile.js";
import type { CertificationProfile } from "../certification/profile.js";
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
import { selectCheck } from "./check-selection.js";
import {
  createFaultActivationTracker,
  MissingFaultActivationError,
} from "./fault-activation.js";
import {
  ObservationEncodingError,
  validateObservation,
} from "./observation-encoding.js";
import {
  isOperationHandleStep,
  recordHandleCapture,
  runOperationHandleStep,
} from "./operation-steps.js";
import { readAdapterManifest, readPlans } from "./run-plans.js";
import {
  ArgumentResolutionError,
  createCaptureStore,
  recordStepCaptures,
  resolveStepArguments,
} from "./step-arguments.js";
import type { ArgumentRoots } from "./step-arguments.js";

interface CliOptions {
  adapter: string;
  allowFailingEvidence: boolean;
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

interface StepObservationRecord {
  events?: readonly unknown[];
  inspectedState?: unknown;
  operation: string;
  outcome?: unknown;
  stepId?: string;
}

/** What one check sent and observed, kept for its failure artifact. */
interface CheckRecorder {
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
    stepId: string;
  }[];
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
  check: ConformancePlanCheck
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
    recorder.faults.arm(input, outcome, faultOutcome.code);
  }
  const activated = recorder.faults.observe(outcome);
  if (outcome.kind === "error" && !activated) {
    if (
      recorder.faults.isFaultOutcome(outcome.error.code) &&
      recorder.faults.armed.length > 0
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
  const outcome = handleStep
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
      check
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
  input: unknown
): void => {
  if (!recorder.recordCertification) {
    return;
  }
  recorder.schedule.push({
    action: step.action ?? "dispatch",
    arrivalSequence,
    ...(step.action === "release" ? { input } : {}),
    operation: step.operation,
    stepId: step.stepId,
  });
};

const runTraceCheck = async (
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  recorder: CheckRecorder
): Promise<ConformanceCheckResult> => {
  const { check } = compiledCheck;
  const steps = check.steps ?? [];
  const projected = steps.some((step) => step.arguments !== undefined);
  if (projected) {
    rejectLegacySelectors(check.input);
  }
  const baseInput = createAdapterInput(plan, compiledCheck);
  const instance = await client.createInstance(
    projected ? { checkInput: check.input } : baseInput
  );
  if (recorder.recordCertification) {
    recorder.storageIdentity = { kind: manifest.storage ?? "none", instance };
  }
  const trace: Record<
    string,
    AssertionContext & { outcome: OperationOutcome }
  > = {};
  const traceAdapterErrors: Record<string, unknown> = {};
  const startedOperations = new Map<string, string>();
  const arrivals: Record<string, number> = {};
  const captureStore = createCaptureStore();
  const captures = captureStore.values;
  const handleCaptures: Record<string, string> = Object.create(null);
  const barriers = createBarrierSteps(handleCaptures);
  const argumentRoots: ArgumentRoots = {
    capture: captures,
    fixture:
      check.fixture === undefined
        ? undefined
        : plan.fixtures.get(check.fixture),
    input: check.input,
  };

  try {
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
      validateStartedInput(step, catalogOperation, input);
      if (step.action === "start" || step.action === "cancel") {
        client.setLosslessObservations(catalogOperation !== undefined);
        const receipt = await runOperationHandleStep(
          client,
          step,
          input,
          instance,
          startedOperations,
          controls.deadlineMs
        );
        const arrivalSequence = client.latestArrivalSequence();
        arrivals[step.stepId] = arrivalSequence;
        recordSchedule(recorder, step, arrivalSequence, input);
        if (receipt.kind === "started") {
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
        recorder,
        startedOperations,
        step,
      });
      barriers.observe(step, input, outcome);
      const arrivalSequence = client.latestArrivalSequence();
      arrivals[step.stepId] = arrivalSequence;
      recordSchedule(recorder, step, arrivalSequence, input);
      if (outcome.kind === "error") {
        traceAdapterErrors[step.stepId] = outcome.error;
      }

      trace[step.stepId] = { ...context, outcome };
      recordStepCaptures(
        step.capture,
        { ...context, events: context.events ?? extraEvents },
        captureStore
      );

      if (step.assertions !== undefined) {
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
      }
      await visit(index + 1);
    };
    await visit(0);
  } finally {
    await client.destroyInstance(instance);
  }

  const finalContext: RunnerContext = {
    arrivals,
    capture: captures,
    evidence: { trace },
    faultActivations: recorder.faults.activations,
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
};

const executeCheck = async (
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  recorder: CheckRecorder
): Promise<ConformanceCheckResult> => {
  const { check } = compiledCheck;

  try {
    client.setLosslessObservations(false);
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
      return await runTraceCheck(
        client,
        manifest,
        plan,
        compiledCheck,
        recorder
      );
    }

    const input = createAdapterInput(plan, compiledCheck);
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
      undefined,
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
      undefined,
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
      undefined,
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
  const { thrown } = recorder;

  if (
    thrown instanceof ArgumentResolutionError ||
    thrown instanceof MissingFaultActivationError
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
  replay: string
): Promise<ConformanceFailure> => {
  const exit = await client.exitStatus();
  const operands = recorder.diagnoses
    .filter(({ evaluation }) => evaluation.status === "fail")
    .flatMap(({ operands: entries }) => entries);
  const stderrTail = client.stderrTail(STDERR_TAIL_CHARS);

  return {
    ...(recorder.arguments.length > 0 ? { arguments: recorder.arguments } : {}),
    classification: classifyFailure(recorder, client.stderrSince(mark)),
    ...(recorder.faults.armed.length === 0
      ? {}
      : {
          fault: {
            activations: recorder.faults.activations,
            armed: recorder.faults.armed,
          },
        }),
    ...(exit === undefined ? {} : { exit }),
    frameLog: client.framesSince(mark),
    ...(recorder.observation.length > 0
      ? { observation: recorder.observation }
      : {}),
    ...(operands.length > 0 ? { operands } : {}),
    replay,
    ...(stderrTail.length > 0 ? { stderrTail } : {}),
  };
};

const runCheck = async (
  client: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  replay: string,
  recordCertification: boolean
): Promise<ConformanceCheckResult> => {
  const mark = client.markTranscript();
  const recorder: CheckRecorder = {
    arguments: [],
    diagnoses: [],
    faults: createFaultActivationTracker(),
    observation: [],
    operationErrors: [],
    recordCertification,
    schedule: [],
  };
  let checkResult = await executeCheck(
    client,
    manifest,
    plan,
    compiledCheck,
    recorder
  );

  const missing = recorder.faults.missing();
  if (
    missing.length > 0 &&
    (recorder.thrown === undefined ||
      recorder.thrown instanceof MissingFaultActivationError)
  ) {
    const rejection = new MissingFaultActivationError(
      `armed faults never activated: ${missing.join(", ")}`
    );
    recorder.thrown = rejection;
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
  if (recorder.faults.armed.length > 0) {
    checkResult = {
      ...checkResult,
      details: {
        ...checkResult.details,
        fault: {
          activations: recorder.faults.activations,
          armed: recorder.faults.armed,
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
        stepId: "dispatch",
      });
    }
    checkResult = {
      ...checkResult,
      details: {
        ...checkResult.details,
        schedule: recorder.schedule,
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
    failure: await createFailure(client, mark, recorder, replay),
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

const runScheduledChecks = async (
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
    try {
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

        const result = {
          checkResult: await runCheck(
            client,
            manifest,
            scheduledCheck.plan,
            scheduledCheck.compiledCheck,
            replayFor(scheduledCheck.compiledCheck.check.checkId),
            recordCertification
          ),
          index: scheduledCheck.index,
        };
        results.push(result);
        owned.push(result);
        await visit();
      };
      await visit();
    } finally {
      await client.shutdown();
      if (recordCertification) {
        const exit = await client.terminationStatus();
        for (const result of owned) {
          result.checkResult = {
            ...result.checkResult,
            details: {
              ...result.checkResult.details,
              process: {
                pid: client.processId(),
                exit: exit ?? null,
                supervisorTerminated: client.wasTerminatedBySupervisor(),
              },
            },
          };
        }
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
    profiles
  );
  const recordCertification = digestsBefore !== undefined;
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
  const bundle = await finishCertificate(
    options,
    adapterManifest,
    profiles[0],
    plans,
    checkResults,
    evidence.status,
    digestsBefore
  );
  const certificate = bundle.certificate;
  if (summary.failedChecks > 0) {
    process.stderr.write(
      `conformance failure artifacts retained at ${await retainFailureArtifacts(
        `${JSON.stringify(evidence, null, 2)}\n`
      )}\n`
    );
  }

  const text = `${JSON.stringify(
    {
      ...evidence,
      ...bundle,
      checkResults: checkResults.map(previewFailure),
    },
    null,
    2
  )}\n`;

  if (options.evidenceOut !== undefined) {
    const evidencePath = nodePath.resolve(REPO_ROOT, options.evidenceOut);
    await mkdir(nodePath.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, text);
  }

  if (options.summaryOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          adapterId: evidence.adapterId,
          implementationId: evidence.implementationId,
          ...(certificate === undefined ? {} : { certificate }),
          status: evidence.status,
          suiteId: evidence.suiteId,
          suiteVersion: evidence.suiteVersion,
          summary: evidence.summary,
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

  if (options.requireCertified && certificate?.status !== "certified") {
    process.stderr.write(
      "the requested certificate is incomplete or lacks a matching passing control run\n"
    );
    process.exitCode = 1;
  }

  if (certifiedEntries.length > 0 && selected.applicable.length === 0) {
    for (const entry of certifiedEntries) {
      process.stderr.write(
        `certified project ${entry.project} (profile ${entry.profile}) selected zero applicable checks; a certified run must exercise its profile\n`
      );
    }
    process.exitCode = 1;
  }
};

await main();
