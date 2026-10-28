import type { OperationOutcome } from "../adapter-protocol/index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Arming {
  token: string;
  point: string;
  selector: unknown;
  occurrence: number;
  mode: "throw" | "block";
  outcomeCode: string;
}

export class MissingFaultActivationError extends Error {
  readonly code = "missing_fault_activation";
}

export const createFaultActivationTracker = () => {
  const armed: Arming[] = [];
  const activations: string[] = [];
  const receipts: { token: string; phase: string; processEpoch: number }[] = [];
  return {
    armed,
    activations,
    receipts,
    arm: (
      input: unknown,
      outcome: OperationOutcome,
      outcomeCode: string
    ): void => {
      if (outcome.kind !== "result") {
        return;
      }
      const value = isRecord(outcome.value) ? outcome.value.result : undefined;
      if (
        !isRecord(input) ||
        typeof input.point !== "string" ||
        (input.mode !== "throw" && input.mode !== "block") ||
        typeof input.occurrence !== "number" ||
        !Number.isSafeInteger(input.occurrence) ||
        input.occurrence < 1 ||
        !isRecord(value) ||
        typeof value.token !== "string" ||
        value.token.length === 0 ||
        armed.some((entry) => entry.token === value.token)
      ) {
        throw new TypeError(
          "invalid fault arming or duplicate activation token"
        );
      }
      armed.push({
        outcomeCode,
        token: value.token,
        point: input.point,
        occurrence: input.occurrence,
        mode: input.mode,
        selector: input.selector,
      });
    },
    isFaultOutcome: (code: string): boolean =>
      armed.some(
        (entry) => entry.mode === "throw" && entry.outcomeCode === code
      ),
    observe: (outcome: OperationOutcome): boolean => {
      if (outcome.kind !== "error") {
        return false;
      }
      const { details } = outcome.error;
      if (
        !isRecord(details) ||
        typeof details.token !== "string" ||
        !armed.some(
          (entry) =>
            entry.outcomeCode === outcome.error.code &&
            entry.mode === "throw" &&
            entry.token === details.token &&
            entry.point === details.point
        )
      ) {
        return false;
      }
      activations.push(details.token);
      return true;
    },
    receipt: (value: unknown, epoch: number): boolean => {
      if (
        !isRecord(value) ||
        typeof value.token !== "string" ||
        typeof value.phase !== "string" ||
        value.processEpoch !== epoch ||
        !armed.some(
          (entry) =>
            entry.mode === "block" &&
            entry.token === value.token &&
            entry.point === value.phase
        ) ||
        receipts.some((entry) => entry.token === value.token)
      ) {
        return false;
      }
      receipts.push({
        token: value.token,
        phase: value.phase,
        processEpoch: epoch,
      });
      return true;
    },
    death: (
      epoch: number,
      exit: { code: number | null; signal: string | null }
    ): void => {
      if (exit.signal !== "SIGKILL") {
        return;
      }
      for (const receipt of receipts) {
        if (
          receipt.processEpoch === epoch &&
          !activations.includes(receipt.token)
        ) {
          activations.push(receipt.token);
        }
      }
    },
    missing: (): string[] =>
      armed
        .filter((entry) => !activations.includes(entry.token))
        .map((entry) => entry.token),
  };
};
