import type { OperationOutcome } from "../adapter-protocol/index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Arming {
  epoch: number;
  process: string;
  token: string;
  point: string;
  selector: unknown;
  occurrence: number;
  mode: "throw" | "block";
  outcomeCode: string;
}

const describeArming = (entry: Arming): string => {
  if (entry.process === "primary") {
    return entry.token;
  }
  if (entry.epoch === 1) {
    return `${entry.process}:${entry.token}`;
  }
  return `${entry.process}:${entry.epoch}:${entry.token}`;
};

export class MissingFaultActivationError extends Error {
  readonly code = "missing_fault_activation";
}

export class SeamDidNotHoldError extends Error {
  readonly code = "seam_did_not_hold";
}

export const createFaultActivationTracker = () => {
  const armed: Arming[] = [];
  const activations: string[] = [];
  const receipts: {
    token: string;
    phase: string;
    processEpoch: number;
    process: string;
  }[] = [];
  const activated = new Map<string, Map<number, Set<string>>>();
  const isActivated = (
    token: string,
    process = "primary",
    epoch = 1
  ): boolean => activated.get(process)?.get(epoch)?.has(token) === true;
  const activate = (token: string, process: string, epoch: number): void => {
    const epochs = activated.get(process) ?? new Map<number, Set<string>>();
    const tokens = epochs.get(epoch) ?? new Set<string>();
    if (!tokens.has(token)) {
      tokens.add(token);
      epochs.set(epoch, tokens);
      activated.set(process, epochs);
      activations.push(token);
    }
  };
  return {
    armed,
    activations,
    receipts,
    arm: (
      input: unknown,
      outcome: OperationOutcome,
      outcomeCode: string,
      process = "primary",
      epoch = 1
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
        armed.some(
          (entry) =>
            entry.process === process &&
            entry.epoch === epoch &&
            entry.token === value.token
        )
      ) {
        throw new TypeError(
          "invalid fault arming or duplicate activation token"
        );
      }
      armed.push({
        epoch,
        process,
        outcomeCode,
        token: value.token,
        point: input.point,
        occurrence: input.occurrence,
        mode: input.mode,
        selector: input.selector,
      });
    },
    isActivated,
    isFaultOutcome: (code: string, process = "primary", epoch = 1): boolean =>
      armed.some(
        (entry) =>
          entry.process === process &&
          entry.epoch === epoch &&
          entry.mode === "throw" &&
          entry.outcomeCode === code
      ),
    observe: (
      outcome: OperationOutcome,
      process = "primary",
      epoch = 1
    ): boolean => {
      if (outcome.kind !== "error") {
        return false;
      }
      const { details } = outcome.error;
      if (
        !isRecord(details) ||
        typeof details.token !== "string" ||
        !armed.some(
          (entry) =>
            entry.process === process &&
            entry.epoch === epoch &&
            entry.outcomeCode === outcome.error.code &&
            entry.mode === "throw" &&
            entry.token === details.token &&
            entry.point === details.point
        )
      ) {
        return false;
      }
      activate(details.token, process, epoch);
      return true;
    },
    receipt: (value: unknown, epoch: number, process = "primary"): boolean => {
      if (
        !isRecord(value) ||
        typeof value.token !== "string" ||
        typeof value.phase !== "string" ||
        value.processEpoch !== epoch ||
        !armed.some(
          (entry) =>
            entry.process === process &&
            entry.epoch === epoch &&
            entry.mode === "block" &&
            entry.token === value.token &&
            entry.point === value.phase
        ) ||
        receipts.some(
          (entry) =>
            entry.process === process &&
            entry.processEpoch === epoch &&
            entry.token === value.token
        )
      ) {
        return false;
      }
      receipts.push({
        token: value.token,
        phase: value.phase,
        processEpoch: epoch,
        process,
      });
      return true;
    },
    death: (
      epoch: number,
      exit: { code: number | null; signal: string | null },
      process = "primary"
    ): void => {
      if (exit.signal !== "SIGKILL") {
        return;
      }
      for (const receipt of receipts) {
        if (
          receipt.processEpoch === epoch &&
          receipt.process === process &&
          !isActivated(receipt.token, process, epoch)
        ) {
          activate(receipt.token, process, epoch);
        }
      }
    },
    missing: (): string[] =>
      armed
        .filter(
          (entry) => !isActivated(entry.token, entry.process, entry.epoch)
        )
        .map(describeArming),
  };
};
