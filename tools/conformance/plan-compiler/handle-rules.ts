import { collectProblem } from "./barrier-rules.js";
import type { ConformancePlanCheck, ConformancePlanStep } from "./index.js";

const handleReference = (step: ConformancePlanStep): string | undefined => {
  const value = step.arguments?.operationHandle;
  if (
    typeof value !== "object" ||
    value === null ||
    !("$ref" in value) ||
    typeof value.$ref !== "string"
  ) {
    return undefined;
  }
  return value.$ref;
};

const validateCancellation = (
  check: ConformancePlanCheck,
  step: ConformancePlanStep,
  prior: readonly ConformancePlanStep[]
): void => {
  const reference = handleReference(step);
  const start = prior.find(
    (candidate) =>
      candidate.action === "start" &&
      candidate.operation === step.operation &&
      candidate.handleCapture !== undefined &&
      `capture.${candidate.handleCapture}` === reference
  );
  const receipt = prior.findLast(
    (candidate) =>
      candidate.operation === "kernel.barrier.wait" &&
      (candidate.action === undefined || candidate.action === "dispatch") &&
      handleReference(candidate) === reference
  );
  const arm = prior.find(
    (candidate) =>
      candidate.action === "barrier" &&
      candidate.barrierId === receipt?.arguments?.barrierId &&
      candidate.participants?.includes(start?.stepId ?? "")
  );
  const released = prior.some(
    (candidate) =>
      candidate.action === "release" &&
      candidate.barrierId === arm?.barrierId &&
      (candidate.participants === undefined ||
        candidate.participants.includes(start?.stepId ?? ""))
  );
  if (
    start === undefined ||
    receipt === undefined ||
    arm === undefined ||
    prior.indexOf(arm) >= prior.indexOf(start) ||
    prior.indexOf(start) >= prior.indexOf(receipt) ||
    released
  ) {
    throw new Error(
      `check ${check.checkId} cancel ${step.stepId} requires a prior matching entry receipt while its barrier is held`
    );
  }
};

const validateProcessSelection = (
  check: ConformancePlanCheck,
  step: ConformancePlanStep,
  processes: Set<string>
): void => {
  if (step.action === "spawn") {
    if (
      step.process === undefined ||
      processes.has(step.process) ||
      step.operation !== "kernel.process.spawn"
    ) {
      throw new Error(
        `check ${check.checkId} spawn requires a new named process`
      );
    }
    processes.add(step.process);
  } else if (step.process !== undefined && !processes.has(step.process)) {
    throw new Error(`check ${check.checkId} selects a process before spawn`);
  }
};

const instanceProcess = (
  step: ConformancePlanStep,
  prior: readonly ConformancePlanStep[]
): string => {
  const routed =
    step.action === "await" ||
    step.action === "cancel" ||
    step.operation === "kernel.barrier.wait";
  const reference = handleReference(step);
  const owner = routed
    ? prior.find(
        (candidate) =>
          candidate.action === "start" &&
          candidate.handleCapture !== undefined &&
          `capture.${candidate.handleCapture}` === reference
      )
    : undefined;
  return step.process ?? owner?.process ?? "primary";
};

const validateInstanceSelection = (
  check: ConformancePlanCheck,
  step: ConformancePlanStep,
  instances: Map<string, Set<string>>,
  prior: readonly ConformancePlanStep[]
): void => {
  const process = instanceProcess(step, prior);
  const names = instances.get(process) ?? new Set<string>();
  instances.set(process, names);
  const name = step.instance ?? "primary";
  if (step.action === "createInstance" || step.action === "openInstance") {
    if (names.has(name)) {
      throw new Error(
        `check ${check.checkId} duplicate instance ${name} in ${process}`
      );
    }
    if (
      step.instance !== undefined &&
      (step.action !== "createInstance" || step.arguments?.scope === undefined)
    ) {
      throw new Error(
        `check ${check.checkId} named instance requires an explicit scope`
      );
    }
    names.add(name);
  } else if (step.instance !== undefined && !names.has(name)) {
    throw new Error(
      `check ${check.checkId} unknown instance ${name} in ${process}`
    );
  }
  if (
    step.action === "restart" ||
    step.action === "kill" ||
    step.action === "respawn"
  ) {
    names.clear();
  }
};

export const validateHandleSchedule = (check: ConformancePlanCheck): void => {
  const steps = check.steps ?? [];
  const captures = new Set<string>();
  const processes = new Set(["primary"]);
  const instances = new Map<string, Set<string>>([
    ["primary", new Set(["primary"])],
  ]);
  for (const [index, step] of steps.entries()) {
    validateProcessSelection(check, step, processes);
    validateInstanceSelection(check, step, instances, steps.slice(0, index));
    if (step.action === "collect") {
      const problem = collectProblem(step, steps.slice(0, index));
      if (problem !== undefined) {
        throw new Error(`check ${check.checkId} ${problem}`);
      }
    }
    for (const name of [
      ...(step.capture ?? []).map((capture) => capture.name),
      ...(step.handleCapture === undefined ? [] : [step.handleCapture]),
    ]) {
      if (captures.has(name)) {
        throw new Error(`capture ${name} is already defined`);
      }
      captures.add(name);
    }
    if (step.action !== "cancel") {
      continue;
    }
    validateCancellation(check, step, steps.slice(0, index));
  }
};
