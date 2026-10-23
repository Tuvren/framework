import type { OperationOutcome } from "../adapter-protocol/index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Arming {
  token: string;
  point: string;
  selector: unknown;
  occurrence: number;
  mode: "throw";
  outcomeCode: string;
}

export class MissingFaultActivationError extends Error {
  readonly code = "missing_fault_activation";
}

export const createFaultActivationTracker = () => {
  const armed: Arming[] = [];
  const activations: string[] = [];
  return {
    armed,
    activations,
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
        input.mode !== "throw" ||
        typeof input.occurrence !== "number" ||
        !Number.isSafeInteger(input.occurrence) ||
        input.occurrence < 1 ||
        !isRecord(value) ||
        typeof value.token !== "string" ||
        value.token.length === 0 ||
        armed.some((entry) => entry.token === value.token)
      ) {
        throw new TypeError(
          "invalid throw fault arming or duplicate activation token"
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
      armed.some((entry) => entry.outcomeCode === code),
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
            entry.token === details.token &&
            entry.point === details.point
        )
      ) {
        return false;
      }
      activations.push(details.token);
      return true;
    },
    missing: (): string[] =>
      armed
        .filter((entry) => !activations.includes(entry.token))
        .map((entry) => entry.token),
  };
};
