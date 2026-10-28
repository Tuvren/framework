import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { parseOperationCatalog } from "../../plan-compiler/certification-rules.ts";
import { collectOutcomes } from "../collect-steps.ts";
import type { CollectedAwait } from "../collect-steps.ts";
import { validateObservation } from "../observation-encoding.ts";

test("collect pairs each awaited result with its resolved start arguments in participant order", () => {
  const first = { branchId: "branch", turnNodeHash: "a" };
  const second = { branchId: "branch", turnNodeHash: "b" };
  const outcomes = new Map<string, CollectedAwait>([
    [
      "a",
      {
        process: "primary",
        arguments: first,
        outcome: {
          kind: "error" as const,
          error: { code: "lateral", message: "lateral" },
        },
      },
    ],
    [
      "b",
      {
        process: "second",
        arguments: second,
        outcome: { kind: "result" as const, value: { result: { head: "b" } } },
      },
    ],
  ]);
  const result = collectOutcomes(["b", "a"], outcomes, () => true);
  expect(result).toEqual({
    outcomes: [
      {
        stepId: "b",
        process: "second",
        arguments: second,
        kind: "result",
        result: { head: "b" },
      },
      {
        stepId: "a",
        process: "primary",
        arguments: first,
        kind: "error",
        error: { code: "lateral", message: "lateral" },
      },
    ],
    byKind: {
      result: [
        {
          stepId: "b",
          process: "second",
          arguments: second,
          kind: "result",
          result: { head: "b" },
        },
      ],
      error: [
        {
          stepId: "a",
          process: "primary",
          arguments: first,
          kind: "error",
          error: { code: "lateral", message: "lateral" },
        },
      ],
    },
  });
});

test("collect refuses a missing await or a participant without a held-entry receipt before release", () => {
  const outcomes = new Map<string, CollectedAwait>([
    [
      "a",
      {
        process: "primary",
        arguments: {},
        outcome: { kind: "result" as const, value: { result: {} } },
      },
    ],
  ]);
  expect(() => collectOutcomes(["a", "b"], outcomes, () => true)).toThrow();
  expect(() => collectOutcomes(["a"], outcomes, () => false)).toThrow();
  expect(() => collectOutcomes(["a", "a"], outcomes, () => true)).toThrow();
});

test("the catalog validates the collected rows with closed outer and row shapes", async () => {
  const catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel"
  );
  const operation = catalog.operations.get("kernel.harness.collect");
  if (operation === undefined) {
    throw new Error("missing collect catalog operation");
  }
  const hash = "a".repeat(64);
  const row = {
    stepId: "await",
    process: "primary",
    arguments: { branchId: "b", turnNodeHash: hash },
    kind: "result",
    result: {
      branch: { branchId: "b", threadId: "t", headTurnNodeHash: hash },
    },
  };
  const result = { outcomes: [row], byKind: { result: [row], error: [] } };
  expect(() => validateObservation(operation, { result }, true)).not.toThrow();
  const fault = {
    stepId: "fault",
    process: "primary",
    arguments: row.arguments,
    kind: "error",
    error: {
      code: "kernel_persistence_fault_injected",
      message: "fault",
      details: { point: "before-commit", token: "fault-1" },
    },
  };
  expect(() =>
    validateObservation(
      operation,
      { result: { outcomes: [fault], byKind: { result: [], error: [fault] } } },
      true
    )
  ).not.toThrow();
  expect(() =>
    validateObservation(operation, { result: { ...result, extra: true } }, true)
  ).toThrow();
  expect(() =>
    validateObservation(
      operation,
      { result: { ...result, outcomes: [{ ...row, extra: true }] } },
      true
    )
  ).toThrow();
});
