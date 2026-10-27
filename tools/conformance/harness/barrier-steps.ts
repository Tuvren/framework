import type { OperationOutcome } from "../adapter-protocol/index.js";
import type { ConformancePlanStep } from "../plan-compiler/index.js";
import { ArgumentResolutionError } from "./step-arguments.js";

interface Barrier {
  seam: string;
  participants: readonly string[];
}

export const createBarrierSteps = (
  captures: Readonly<Record<string, string>>
) => {
  const barriers = new Map<string, Barrier>();
  const participantCaptures = new Map<string, string>();
  const receipts = new Map<string, { barrierId: string; seam: string }>();
  const armInput = (step: ConformancePlanStep): unknown => {
    if (
      step.barrierId === undefined ||
      step.seam === undefined ||
      step.participants === undefined ||
      barriers.has(step.barrierId)
    ) {
      throw new ArgumentResolutionError("invalid barrier arming step");
    }
    barriers.set(step.barrierId, {
      seam: step.seam,
      participants: step.participants,
    });
    return {
      barrierId: step.barrierId,
      seam: step.seam,
      participants: step.participants,
    };
  };
  const participantHandle = (
    participant: string,
    barrier: Barrier,
    barrierId: string
  ): string => {
    const capture = participantCaptures.get(participant);
    const handle = capture === undefined ? undefined : captures[capture];
    if (handle === undefined) {
      throw new ArgumentResolutionError(
        "release before all participants started"
      );
    }
    const receipt = receipts.get(handle);
    if (receipt?.barrierId !== barrierId || receipt.seam !== barrier.seam) {
      throw new ArgumentResolutionError(
        "release requires every implementation entry receipt"
      );
    }
    return handle;
  };
  return {
    input: (step: ConformancePlanStep, input: unknown): unknown => {
      if (step.action === "barrier") {
        return armInput(step);
      }
      if (step.action !== "release") {
        return input;
      }
      if (step.barrierId === undefined) {
        throw new ArgumentResolutionError("release requires an armed barrier");
      }
      const barrier = barriers.get(step.barrierId);
      if (barrier === undefined) {
        throw new ArgumentResolutionError("release requires an armed barrier");
      }
      const participantHandles = new Map<string, string>();
      for (const participant of barrier.participants) {
        participantHandles.set(
          participant,
          participantHandle(participant, barrier, step.barrierId)
        );
      }
      const operationHandles = (step.participants ?? barrier.participants).map(
        (participant) => {
          const handle = participantHandles.get(participant);
          if (handle === undefined) {
            throw new ArgumentResolutionError("release names a nonparticipant");
          }
          return handle;
        }
      );
      return { barrierId: step.barrierId, operationHandles };
    },
    observe: (
      step: ConformancePlanStep,
      input: unknown,
      outcome: OperationOutcome
    ): void => {
      if (
        outcome.kind !== "result" ||
        typeof outcome.value !== "object" ||
        outcome.value === null ||
        !("result" in outcome.value)
      ) {
        return;
      }
      const receipt = outcome.value.result;
      if (
        step.action === "barrier" &&
        (typeof receipt !== "object" ||
          receipt === null ||
          !("barrierId" in receipt) ||
          receipt.barrierId !== step.barrierId ||
          !("seam" in receipt) ||
          receipt.seam !== step.seam)
      ) {
        throw new ArgumentResolutionError(
          "invalid barrier arming acknowledgement"
        );
      }
      if (
        step.operation === "kernel.barrier.wait" &&
        typeof input === "object" &&
        input !== null &&
        "operationHandle" in input &&
        typeof receipt === "object" &&
        receipt !== null &&
        "operationHandle" in receipt &&
        typeof receipt.operationHandle === "string" &&
        receipt.operationHandle === input.operationHandle &&
        "barrierId" in receipt &&
        typeof receipt.barrierId === "string" &&
        "seam" in receipt &&
        typeof receipt.seam === "string"
      ) {
        receipts.set(receipt.operationHandle, {
          barrierId: receipt.barrierId,
          seam: receipt.seam,
        });
      }
    },
    started: (stepId: string, capture: string | undefined): void => {
      if (capture !== undefined) {
        participantCaptures.set(stepId, capture);
      }
    },
  };
};
