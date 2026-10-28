import type { OperationOutcome } from "../adapter-protocol/index.js";
import { ArgumentResolutionError } from "./step-arguments.js";

export interface CollectedAwait {
  arguments: unknown;
  outcome: OperationOutcome;
  process: string;
}

interface CollectedBase {
  arguments: unknown;
  process: string;
  stepId: string;
}

type CollectedOutcome =
  | (CollectedBase & { kind: "result"; result: unknown })
  | (CollectedBase & { kind: "error"; error: unknown });

export const collectOutcomes = (
  participants: readonly string[],
  awaited: ReadonlyMap<string, CollectedAwait>,
  eligible: (stepId: string) => boolean
): {
  outcomes: CollectedOutcome[];
  byKind: { result: CollectedOutcome[]; error: CollectedOutcome[] };
} => {
  if (
    participants.length === 0 ||
    new Set(participants).size !== participants.length
  ) {
    throw new ArgumentResolutionError(
      "collect requires distinct await participants"
    );
  }
  const outcomes: CollectedOutcome[] = [];
  const byKind: { result: CollectedOutcome[]; error: CollectedOutcome[] } = {
    result: [],
    error: [],
  };
  for (const stepId of participants) {
    const entry = awaited.get(stepId);
    if (entry === undefined || !eligible(stepId)) {
      throw new ArgumentResolutionError(
        "collect requires awaited barrier participants with entry receipts before release"
      );
    }
    const base = { stepId, process: entry.process, arguments: entry.arguments };
    const outcome = entry.outcome;
    let record: CollectedOutcome;
    if (outcome.kind === "error") {
      record = { ...base, kind: "error", error: outcome.error };
    } else {
      const value = outcome.value;
      if (typeof value !== "object" || value === null || !("result" in value)) {
        throw new ArgumentResolutionError(
          "collect requires a result observation"
        );
      }
      record = { ...base, kind: "result", result: value.result };
    }
    outcomes.push(record);
    byKind[record.kind].push(record);
  }
  return { outcomes, byKind };
};
