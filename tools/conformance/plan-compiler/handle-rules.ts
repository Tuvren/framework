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

export const validateHandleSchedule = (check: ConformancePlanCheck): void => {
  const steps = check.steps ?? [];
  const captures = new Set<string>();
  for (const [index, step] of steps.entries()) {
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
    const reference = handleReference(step);
    const prior = steps.slice(0, index);
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
  }
};
