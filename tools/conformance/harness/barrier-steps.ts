import type { OperationOutcome } from "../adapter-protocol/index.js";
import type { ConformancePlanStep } from "../plan-compiler/index.js";
import { ArgumentResolutionError } from "./step-arguments.js";

interface Barrier {
  seam: string;
  participants: readonly string[];
}

export const createBarrierSteps = () => {
  const barriers = new Map<string, Barrier>();
  const handles = new Map<string, string>();
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
  return {
    input: (step: ConformancePlanStep, input: unknown): unknown => {
      if (step.action === "barrier") {
        return armInput(step);
      }
      if (step.action !== "release") {
        return input;
      }
      const barrier =
        step.barrierId === undefined ? undefined : barriers.get(step.barrierId);
      if (barrier === undefined) {
        throw new ArgumentResolutionError("release requires an armed barrier");
      }
      const participantHandles = new Map<string, string>();
      for (const participant of barrier.participants) {
        const operationHandle = handles.get(participant);
        if (operationHandle === undefined) {
          throw new ArgumentResolutionError(
            "release before all participants started"
          );
        }
        const receipt = receipts.get(operationHandle);
        if (
          receipt?.barrierId !== step.barrierId ||
          receipt.seam !== barrier.seam
        ) {
          throw new ArgumentResolutionError(
            "release requires every implementation entry receipt"
          );
        }
        participantHandles.set(participant, operationHandle);
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
    observe: (step: ConformancePlanStep, outcome: OperationOutcome): void => {
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
        typeof receipt === "object" &&
        receipt !== null &&
        "operationHandle" in receipt &&
        typeof receipt.operationHandle === "string" &&
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
    started: (stepId: string, handle: string): void => {
      handles.set(stepId, handle);
    },
  };
};
