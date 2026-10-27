import type {
  OperationCatalog,
  CertificationViolation,
} from "./certification-rules.js";
import type { ConformancePlanCheck, ConformancePlanStep } from "./index.js";

interface BarrierSchedule {
  participants: readonly string[];
  started: Set<string>;
  released: Set<string>;
}

const armBarrier = (
  step: ConformancePlanStep,
  laterSteps: readonly ConformancePlanStep[],
  catalog: OperationCatalog | undefined,
  barriers: Map<string, BarrierSchedule>
): string | undefined => {
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
        !laterSteps.some(
          (candidate) =>
            candidate.stepId === id &&
            candidate.action === "start" &&
            candidate.handleCapture !== undefined &&
            operations.includes(candidate.operation)
        )
    )
  ) {
    return "barrier requires a catalogued seam and distinct later start participants with handle captures on its native path";
  }
  barriers.set(step.barrierId, {
    participants,
    released: new Set(),
    started: new Set(),
  });
  return undefined;
};

const trackStart = (
  step: ConformancePlanStep,
  barriers: Map<string, BarrierSchedule>
): string | undefined => {
  for (const barrier of barriers.values()) {
    if (barrier.released.size === barrier.participants.length) {
      continue;
    }
    if (
      !barrier.participants.includes(step.stepId) ||
      barrier.started.has(step.stepId)
    ) {
      return "only unrepeated barrier participants may start before all participants are released";
    }
    barrier.started.add(step.stepId);
  }
  return undefined;
};

const releaseBarrier = (
  step: ConformancePlanStep,
  earlierSteps: readonly ConformancePlanStep[],
  catalog: OperationCatalog | undefined,
  barriers: Map<string, BarrierSchedule>
): string | undefined => {
  const barrier = barriers.get(step.barrierId ?? "");
  const participants = barrier?.participants;
  if (
    catalog?.operations.get(step.operation)?.kind !== "control" ||
    barrier === undefined ||
    participants === undefined ||
    (step.participants ?? []).some((id) => !participants.includes(id)) ||
    participants.some(
      (id) =>
        !earlierSteps.some(
          (candidate) => candidate.stepId === id && candidate.action === "start"
        )
    )
  ) {
    return "release requires an armed barrier whose participants have started";
  }
  for (const participant of step.participants ?? participants) {
    barrier.released.add(participant);
  }
  return undefined;
};

export const checkBarrierSchedule = (
  check: ConformancePlanCheck,
  catalog: OperationCatalog | undefined
): CertificationViolation[] => {
  const violations: CertificationViolation[] = [];
  const barriers = new Map<string, BarrierSchedule>();
  const steps = check.steps ?? [];
  for (const [index, step] of steps.entries()) {
    let problem: string | undefined;
    if (step.action === "barrier") {
      problem = armBarrier(step, steps.slice(index + 1), catalog, barriers);
    }
    if (step.action === "start") {
      problem = trackStart(step, barriers);
    }
    if (step.action === "release") {
      problem = releaseBarrier(step, steps.slice(0, index), catalog, barriers);
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
