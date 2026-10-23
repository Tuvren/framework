import type {
  OperationCatalog,
  CertificationViolation,
} from "./certification-rules.js";
import type { ConformancePlanCheck, ConformancePlanStep } from "./index.js";

export const checkBarrierSchedule = (
  check: ConformancePlanCheck,
  catalog: OperationCatalog | undefined
): CertificationViolation[] => {
  const violations: CertificationViolation[] = [];
  const barriers = new Map<string, readonly string[]>();
  const steps = check.steps ?? [];
  for (const [index, step] of steps.entries()) {
    let problem: string | undefined;
    if (step.action === "barrier") {
      const participants = step.participants ?? [];
      const operations = catalog?.seams?.get(step.seam ?? "");
      if (
        catalog?.operations.get(step.operation)?.kind !== "control" ||
        step.barrierId === undefined ||
        barriers.has(step.barrierId) ||
        participants.length < 2 ||
        new Set(participants).size !== participants.length ||
        operations === undefined ||
        participants.some(
          (id) =>
            !steps
              .slice(index + 1)
              .some(
                (candidate) =>
                  candidate.stepId === id &&
                  candidate.action === "start" &&
                  operations.includes(candidate.operation)
              )
        )
      ) {
        problem =
          "barrier requires a catalogued seam and distinct later start participants on its native path";
      } else {
        barriers.set(step.barrierId, participants);
      }
    }
    if (step.action === "release") {
      const participants = barriers.get(step.barrierId ?? "");
      if (
        catalog?.operations.get(step.operation)?.kind !== "control" ||
        participants === undefined ||
        (step.participants ?? []).some((id) => !participants.includes(id)) ||
        participants.some(
          (id) =>
            !steps
              .slice(0, index)
              .some(
                (candidate) =>
                  candidate.stepId === id && candidate.action === "start"
              )
        )
      ) {
        problem =
          "release requires an armed barrier whose participants have started";
      }
    }
    if (problem !== undefined) {
      violations.push({
        checkId: check.checkId,
        stepId: step.stepId,
        rule: "barrier-schedule",
        message: problem,
      });
    }
  }
  return violations;
};

export const barrierControlArguments = (
  step: ConformancePlanStep
): Record<string, unknown> | undefined => {
  if (step.action === "barrier") {
    return {
      barrierId: step.barrierId,
      seam: step.seam,
      participants: step.participants,
    };
  }
  if (step.action === "release") {
    return {
      barrierId: step.barrierId,
      operationHandles: (step.participants ?? ["all"]).map(
        (participant) => `runner-${participant}`
      ),
    };
  }
  return step.arguments;
};
