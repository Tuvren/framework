import { createCheckResult } from "../../scripts/lib/conformance-contract.js";
import type { ConformanceCheckResult } from "../../scripts/lib/conformance-contract.js";
import type { OperationOutcome } from "../adapter-protocol/index.js";
import { controlInputProblem } from "../plan-compiler/control-input.js";
import type {
  CompiledConformancePlan,
  CompiledConformancePlanCheck,
  ConformancePlanStep,
} from "../plan-compiler/index.js";
import type {
  AdapterManifest,
  JsonRpcAdapterClient,
} from "./adapter-client.js";
import {
  diagnoseAssertions,
  diagnoseRequiredEvidence,
} from "./assertion-engine/index.js";
import type { AssertionContext } from "./assertion-engine/index.js";
import { createBarrierSteps } from "./barrier-steps.js";
import { collectOutcomes } from "./collect-steps.js";
import type { CollectedAwait } from "./collect-steps.js";
import { validateObservation } from "./observation-encoding.js";
import {
  recordHandleCapture,
  runOperationHandleStep,
} from "./operation-steps.js";
import type { ProcessSupervisor } from "./process-supervisor.js";
import type {
  CheckRecorder,
  FaultAttempt,
  MultiTraceDependencies,
  StepObservationRecord,
} from "./run.js";
import {
  ArgumentResolutionError,
  createCaptureStore,
  recordStepCaptures,
} from "./step-arguments.js";
import type { ArgumentRoots } from "./step-arguments.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type RunnerContext = AssertionContext & {
  capture?: Readonly<Record<string, unknown>>;
};

interface TraceProcess {
  client: JsonRpcAdapterClient;
  instance: unknown;
  running: boolean;
  supervisor?: ProcessSupervisor;
  clocks: Map<string, { domain: string; source?: string; nowMs?: number }>;
  started: Map<string, string>;
  faultAttempts: Map<string, FaultAttempt>;
}

interface StartedTraceOperation {
  arguments: unknown;
  process: string;
  stepId: string;
}

const handleCaptureReference = (
  step: ConformancePlanStep
): string | undefined => {
  const handle = step.arguments?.operationHandle;
  if (
    !isRecord(handle) ||
    typeof handle.$ref !== "string" ||
    !handle.$ref.startsWith("capture.")
  ) {
    return undefined;
  }
  return handle.$ref.slice("capture.".length);
};

const routeHandleOwner = (
  step: ConformancePlanStep,
  starts: ReadonlyMap<string, StartedTraceOperation>
): { owner: StartedTraceOperation | undefined; processName: string } => {
  const captureName = handleCaptureReference(step);
  const owner = captureName === undefined ? undefined : starts.get(captureName);
  const routed =
    step.action === "await" ||
    step.action === "cancel" ||
    step.operation === "kernel.barrier.wait";
  if (!routed) {
    return { owner, processName: step.process ?? "primary" };
  }
  if (owner === undefined) {
    throw new ArgumentResolutionError("handle has no owning process");
  }
  if (step.process !== undefined && step.process !== owner.process) {
    throw new ArgumentResolutionError("handle belongs to another process");
  }
  return { owner, processName: owner.process };
};

const barrierProcessName = (
  step: ConformancePlanStep,
  steps: readonly ConformancePlanStep[],
  starts: ReadonlyMap<string, StartedTraceOperation>
): string | undefined => {
  if (step.action === "barrier") {
    const first = step.participants?.[0];
    const start = steps.find(
      (candidate) => candidate.action === "start" && candidate.stepId === first
    );
    if (start === undefined) {
      throw new ArgumentResolutionError("barrier names an unknown start");
    }
    return start.process ?? "primary";
  }
  if (step.action === "release") {
    const arm = steps.find(
      (candidate) =>
        candidate.action === "barrier" && candidate.barrierId === step.barrierId
    );
    const first = (step.participants ?? arm?.participants)?.[0];
    const start = first === undefined ? undefined : starts.get(first);
    if (start === undefined) {
      throw new ArgumentResolutionError("release has no owning process");
    }
    return start.process;
  }
  return undefined;
};

export const runMultiTraceCheck = async (
  dependencies: MultiTraceDependencies,
  initialClient: JsonRpcAdapterClient,
  manifest: AdapterManifest,
  plan: CompiledConformancePlan,
  compiledCheck: CompiledConformancePlanCheck,
  recorder: CheckRecorder,
  storageRef?: string,
  supervisor?: ProcessSupervisor
): Promise<ConformanceCheckResult> => {
  const {
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
  } = dependencies;
  const { check } = compiledCheck;
  const steps = check.steps ?? [];
  if (steps.some((step) => step.arguments !== undefined)) {
    rejectLegacySelectors(check.input);
  }
  const baseInput = createAdapterInput(plan, compiledCheck);
  const initialInstance = await initialClient.createInstance(
    { checkInput: check.input },
    storageRef === undefined ? {} : { storageRef }
  );
  const processes = new Map<string, TraceProcess>([
    [
      "primary",
      {
        client: initialClient,
        instance: initialInstance,
        running: true,
        supervisor,
        clocks: new Map(),
        started: new Map(),
        faultAttempts: new Map(),
      },
    ],
  ]);
  if (supervisor !== undefined) {
    recorder.processes = new Map([["primary", supervisor]]);
  }
  if (recorder.recordCertification) {
    recorder.storageIdentity = {
      kind: manifest.storage ?? "none",
      instance: initialInstance,
      ...(storageRef === undefined ? {} : { storageRef }),
    };
  }
  const trace: Record<
    string,
    AssertionContext & { outcome: OperationOutcome }
  > = {};
  const traceAdapterErrors: Record<string, unknown> = {};
  const arrivals: Record<string, number> = {};
  const captureStore = createCaptureStore();
  const captures = captureStore.values;
  const handleCaptures: Record<string, string> = Object.create(null);
  const starts = new Map<string, StartedTraceOperation>();
  const startsByStep = new Map<string, StartedTraceOperation>();
  const awaited = new Map<string, CollectedAwait>();
  const awaitStarts = new Map<string, string>();
  const barriers = createBarrierSteps(handleCaptures);
  const argumentRoots: ArgumentRoots = {
    capture: captures,
    fixture:
      check.fixture === undefined
        ? undefined
        : plan.fixtures.get(check.fixture),
    input: check.input,
  };
  let arrival = 0;
  const getProcess = (name: string): TraceProcess => {
    const value = processes.get(name);
    if (value === undefined || !value.running) {
      throw new ArgumentResolutionError(`process ${name} is not running`);
    }
    return value;
  };
  const exits = () =>
    Object.fromEntries(
      [...processes].map(([name, process]) => [
        name,
        Object.fromEntries(
          (process.supervisor?.history ?? []).flatMap((entry) =>
            entry.exit === undefined ? [] : [[entry.epoch, entry.exit]]
          )
        ),
      ])
    );
  const record = (
    step: ConformancePlanStep,
    context: AssertionContext,
    outcome: OperationOutcome,
    process: string,
    input: unknown
  ): void => {
    arrival += 1;
    arrivals[step.stepId] = arrival;
    recordSchedule(
      recorder,
      step,
      arrival,
      input,
      process,
      barrierReceipt(step, outcome, context)
    );
    trace[step.stepId] = { ...context, outcome };
    if (outcome.kind === "error") {
      traceAdapterErrors[step.stepId] = outcome.error;
    }
    recordStepCaptures(step.capture, context, captureStore);
    diagnoseTraceStep(check, step, context, arrivals, captures, recorder);
  };
  const visitStep = async (step: ConformancePlanStep): Promise<void> => {
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
    const spawnProcess = async (): Promise<boolean> => {
      if (step.action === "spawn") {
        if (
          step.process === undefined ||
          processes.has(step.process) ||
          supervisor === undefined ||
          storageRef === undefined ||
          step.operation !== "kernel.process.spawn"
        ) {
          throw new ArgumentResolutionError(
            "spawn requires a new named process and supervised durable storage"
          );
        }
        const spawned = await supervisor.fork();
        recorder.processes?.set(step.process, spawned);
        processes.set(step.process, {
          client: spawned.client,
          instance: undefined,
          running: true,
          supervisor: spawned,
          clocks: new Map(),
          started: new Map(),
          faultAttempts: new Map(),
        });
        const outcome: OperationOutcome = {
          kind: "result",
          value: { result: {} },
        };
        validateObservation(catalogOperation, { result: {} }, true);
        recorder.observation.push({
          operation: step.operation,
          stepId: step.stepId,
          outcome,
        });
        record(
          step,
          { result: {}, processExitsByProcess: exits() },
          outcome,
          step.process,
          {}
        );
        return true;
      }
      return false;
    };
    if (await spawnProcess()) {
      return;
    }
    const route = () => {
      const { owner, processName: defaultProcess } = routeHandleOwner(
        step,
        starts
      );
      const processName =
        barrierProcessName(step, steps, startsByStep) ?? defaultProcess;
      const process =
        step.action === "respawn" || step.action === "collect"
          ? processes.get(processName)
          : getProcess(processName);
      if (process === undefined) {
        throw new ArgumentResolutionError(`unknown process ${processName}`);
      }
      return { owner, processName, process };
    };
    const { owner, processName, process } = route();
    const rawInput = barriers.input(step, projectedInput);
    const input = bindControlInstance(
      catalogOperation,
      rawInput,
      process.instance
    );
    recorder.arguments.push({
      input,
      ...(inspectQuery === undefined ? {} : { inspectQuery }),
      operation: step.operation,
      stepId: step.stepId,
    });
    const runControl = async (): Promise<boolean> => {
      if (step.action === "createInstance") {
        if (
          step.operation !== "kernel.instance.create" ||
          process.instance !== undefined
        ) {
          throw new ArgumentResolutionError(
            "createInstance requires a process without an instance"
          );
        }
        const problem = controlInputProblem(catalogOperation, input);
        if (problem !== undefined) {
          throw new ArgumentResolutionError(problem);
        }
        process.instance = await process.client.createInstance(
          input,
          storageRef === undefined ? {} : { storageRef }
        );
        const outcome: OperationOutcome = {
          kind: "result",
          value: { result: {} },
        };
        validateObservation(catalogOperation, { result: {} }, true);
        recorder.observation.push({
          operation: step.operation,
          stepId: step.stepId,
          outcome,
        });
        record(
          step,
          { result: {}, processExitsByProcess: exits() },
          outcome,
          processName,
          input
        );
        return true;
      }
      if (isLifecycleAction(step.action)) {
        const state = await runLifecycleStep({
          action: step.action,
          catalogOperation,
          clocks: process.clocks,
          faultAttempts: process.faultAttempts,
          processName,
          input,
          recorder,
          timeoutMs: Math.min(controls.deadlineMs ?? 10_000, 10_000),
          state: {
            client: process.client,
            instance: process.instance,
            processRunning: process.running,
          },
          step,
          storageRef,
          supervisor: process.supervisor,
        });
        process.client = state.client;
        process.instance = state.instance;
        process.running = state.processRunning;
        clearEpochHandles(step.action, process.started, process.faultAttempts);
        const outcome: OperationOutcome = {
          kind: "result",
          value: { result: {} },
        };
        validateObservation(catalogOperation, { result: {} }, true);
        recorder.observation.push({
          operation: step.operation,
          stepId: step.stepId,
          outcome,
        });
        record(
          step,
          { result: {}, processExitsByProcess: exits() },
          outcome,
          processName,
          input
        );
        return true;
      }
      return false;
    };
    if (await runControl()) {
      return;
    }
    const runCollect = (): boolean => {
      if (step.action === "collect") {
        const result = collectOutcomes(
          step.participants ?? [],
          awaited,
          (id) => {
            const start = awaitStarts.get(id);
            return start !== undefined && barriers.eligible(start);
          }
        );
        validateObservation(catalogOperation, { result }, true);
        const outcome: OperationOutcome = {
          kind: "result",
          value: { result },
        };
        recorder.observation.push({
          operation: step.operation,
          stepId: step.stepId,
          outcome,
        });
        record(
          step,
          { input: baseInput.checkInput, fixture: baseInput.fixture, result },
          outcome,
          "primary",
          input
        );
        return true;
      }
      return false;
    };
    if (runCollect()) {
      return;
    }
    validateStartedInput(step, catalogOperation, input);
    const runHandle = async (): Promise<boolean> => {
      if (step.action === "start" || step.action === "cancel") {
        process.client.setLosslessObservations(catalogOperation !== undefined);
        recordFaultAttempts(
          step,
          process.client,
          recorder,
          process.faultAttempts,
          processName,
          process.supervisor?.current.epoch ?? 1
        );
        const receipt = await runOperationHandleStep(
          process.client,
          step,
          input,
          process.instance,
          process.started,
          controls.deadlineMs
        );
        arrival += 1;
        arrivals[step.stepId] = arrival;
        recordSchedule(recorder, step, arrival, input, processName);
        if (receipt.kind === "started") {
          recordFaultAttemptHandles(
            process.faultAttempts,
            receipt.operationHandle
          );
          recordHandleCapture(
            step.handleCapture,
            receipt.operationHandle,
            captureStore,
            handleCaptures
          );
          barriers.started(step.stepId, step.handleCapture, processName);
          if (step.handleCapture !== undefined) {
            const started = {
              arguments: projectedInput,
              process: processName,
              stepId: step.stepId,
            };
            starts.set(step.handleCapture, started);
            startsByStep.set(step.stepId, started);
          }
        }
        return true;
      }
      return false;
    };
    if (await runHandle()) {
      return;
    }
    const observed: StepObservationRecord = {
      operation: step.operation,
      stepId: step.stepId,
    };
    recorder.observation.push(observed);
    const observe = async (name: string, value: unknown) => {
      const target = getProcess(name);
      return await observeTraceStep({
        catalogOperation,
        check,
        client: target.client,
        contextInput,
        controls,
        input: bindControlInstance(catalogOperation, value, target.instance),
        inspectQuery,
        instance: target.instance,
        observed,
        processName: name,
        processEpoch: target.supervisor?.current.epoch ?? 1,
        recorder,
        startedOperations: target.started,
        step,
      });
    };
    const armBarrier = async (): Promise<
      Awaited<ReturnType<typeof observe>>
    > => {
      const participants = step.participants ?? [];
      const grouped = new Map<string, string[]>();
      for (const id of participants) {
        const target = steps.find(
          (candidate) => candidate.stepId === id && candidate.action === "start"
        );
        if (target === undefined) {
          throw new ArgumentResolutionError("barrier names an unknown start");
        }
        const name = target.process ?? "primary";
        const group = grouped.get(name) ?? [];
        group.push(id);
        grouped.set(name, group);
      }
      let first: Awaited<ReturnType<typeof observe>> | undefined;
      for (const [name, group] of grouped) {
        const value = {
          barrierId: step.barrierId,
          seam: step.seam,
          participants: group,
        };
        const current = await observe(name, value);
        if (current.outcome.kind !== "result") {
          throw new ArgumentResolutionError("barrier arming failed");
        }
        barriers.observe(step, value, current.outcome, name);
        first ??= current;
      }
      if (first === undefined) {
        throw new ArgumentResolutionError("barrier has no participants");
      }
      return first;
    };
    const retainRelease = (
      first: Awaited<ReturnType<typeof observe>> | undefined,
      current: Awaited<ReturnType<typeof observe>>,
      processName: string
    ): Awaited<ReturnType<typeof observe>> => {
      if (first === undefined) {
        observed.process = processName;
        return current;
      }
      recorder.observation.push({
        operation: step.operation,
        stepId: step.stepId,
        process: processName,
        outcome: current.outcome,
        events: current.extraEvents,
      });
      return first;
    };
    const releaseBarrier = async (): Promise<
      Awaited<ReturnType<typeof observe>>
    > => {
      if (!(isRecord(rawInput) && Array.isArray(rawInput.operationHandles))) {
        throw new ArgumentResolutionError("invalid release input");
      }
      const operationHandles = rawInput.operationHandles;
      const participants =
        step.participants ??
        steps.find(
          (candidate) =>
            candidate.action === "barrier" &&
            candidate.barrierId === step.barrierId
        )?.participants ??
        [];
      const releases = participants.map((id, index) => {
        const start = startsByStep.get(id);
        const handle = operationHandles[index];
        if (start === undefined || typeof handle !== "string") {
          throw new ArgumentResolutionError("release has no owning process");
        }
        return { process: start.process, handle };
      });
      if (releases.length === 0) {
        throw new ArgumentResolutionError(
          "barrier release has no participants"
        );
      }
      const responses = await Promise.all(
        releases.map(async ({ process, handle }) => ({
          process,
          current: await observe(process, {
            barrierId: step.barrierId,
            operationHandles: [handle],
          }),
        }))
      );
      let first: Awaited<ReturnType<typeof observe>> | undefined;
      for (const { process, current } of responses) {
        if (current.outcome.kind !== "result") {
          throw new ArgumentResolutionError("barrier release failed");
        }
        first = retainRelease(first, current, process);
      }
      if (first === undefined) {
        throw new ArgumentResolutionError(
          "barrier release has no participants"
        );
      }
      barriers.released(step);
      observed.outcome = first.outcome;
      observed.events = first.extraEvents;
      return first;
    };
    let response: Awaited<ReturnType<typeof observe>>;
    switch (step.action) {
      case "barrier":
        response = await armBarrier();
        break;
      case "release":
        response = await releaseBarrier();
        break;
      default:
        response = await observe(processName, rawInput);
        barriers.observe(step, input, response.outcome, processName);
    }
    const recordOutcomeState = (): void => {
      rememberClock(step, response.outcome, projectedInput, process.clocks);
      if (step.action === "await" && owner !== undefined) {
        awaited.set(step.stepId, {
          arguments: owner.arguments,
          process: owner.process,
          outcome: response.outcome,
        });
        awaitStarts.set(step.stepId, owner.stepId);
      }
    };
    recordOutcomeState();
    record(
      step,
      {
        ...response.context,
        events: response.context.events ?? response.extraEvents,
      },
      response.outcome,
      processName,
      rawInput
    );
  };
  return await withCheckCleanup(
    async () => {
      for (const step of steps) {
        await visitStep(step);
      }
      const processExitsByProcess = exits();
      const context: RunnerContext = {
        arrivals,
        capture: captures,
        evidence: { trace },
        faultActivations: recorder.faults.activations,
        processExits: processExitsByProcess.primary,
        processExitsByProcess,
        fixture: baseInput.fixture,
        input: baseInput.checkInput,
        result: { trace },
        scenario: baseInput.scenario,
        state: { trace },
      };
      recorder.diagnoses.push(
        ...diagnoseAssertions(check, context),
        ...diagnoseRequiredEvidence(
          compiledCheck,
          context,
          plan.catalog?.operations.has(check.operation) === true
        )
      );
      return createCheckResult(check.checkId, readEvaluations(recorder), {
        adapterId: manifest.adapterId,
        planId: plan.plan.planId,
        ...(recorder.recordCertification &&
        Object.keys(traceAdapterErrors).length > 0
          ? { adapterErrors: traceAdapterErrors }
          : {}),
        traceStepIds: Object.keys(trace),
      });
    },
    async () => {
      const failures: unknown[] = [];
      for (const [name, process] of [...processes].reverse()) {
        try {
          if (process.running && process.instance !== undefined) {
            await process.client.destroyInstance(process.instance);
          }
        } catch (error: unknown) {
          failures.push(error);
        }
        try {
          if (name !== "primary") {
            await process.supervisor?.close();
          }
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "process cleanup failed");
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
