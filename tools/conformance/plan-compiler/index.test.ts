/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { loadConformancePlan } from "./index.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
};

const copyPlanReferences = async (
  sourcePlanPath: string,
  tempDir: string,
  references: unknown
): Promise<void> => {
  if (!isRecord(references)) {
    return;
  }

  const paths = Object.values(references).filter(
    (value): value is string => typeof value === "string"
  );
  const visit = async (index: number): Promise<void> => {
    const relativePath = paths[index];
    if (typeof relativePath !== "string") {
      return;
    }

    const sourcePath = nodePath.join(
      nodePath.dirname(sourcePlanPath),
      relativePath
    );
    const tempPath = nodePath.join(tempDir, relativePath);

    await mkdir(nodePath.dirname(tempPath), { recursive: true });
    const source = await readFile(sourcePath, "utf-8");
    await writeFile(tempPath, source, "utf-8");
    await visit(index + 1);
  };
  await visit(0);
};

const loadMutatedPlan = async (
  planPath: string,
  mutate: (plan: Record<string, unknown>) => void
) => {
  const sourcePlanPath = nodePath.join(process.cwd(), planPath);
  const source = readRecord(
    JSON.parse(await readFile(sourcePlanPath, "utf-8")),
    planPath
  );
  const tempDir = await mkdtemp(nodePath.join(tmpdir(), "tuvren-plan-"));
  const tempPath = nodePath.join(tempDir, "plan.json");

  await copyPlanReferences(sourcePlanPath, tempDir, source.fixtures);
  await copyPlanReferences(sourcePlanPath, tempDir, source.scenarios);
  mutate(source);
  await writeFile(tempPath, `${JSON.stringify(source, null, 2)}\n`, "utf-8");
  return await loadConformancePlan(tempPath);
};

const readArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  return value;
};

const readRecordString = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

describe("resultField required evidence", () => {
  test("adds a result-rooted evidence requirement for resultField assertions", async () => {
    const compiledPlan = await loadConformancePlan(
      "spec/conformance/runners/plans/runner-api-core.json"
    );
    const check = compiledPlan.checks.find(
      (entry) => entry.check.checkId === "runner-api.execute.resolution"
    );

    expect(check?.requiredEvidence).toContain("result.runner.phase");
  });

  test("roots whole-result assertions at result", async () => {
    const compiledPlan = await loadMutatedPlan(
      "spec/conformance/runners/plans/runner-api-core.json",
      (plan) => {
        const checks = readArray(plan.checks, "checks");
        const targetCheck = readRecord(
          checks.find(
            (entry) =>
              readRecordString(entry, "checkId") ===
              "runner-api.execute.resolution"
          ),
          "runner-api.execute.resolution check"
        );
        const assertions = readArray(targetCheck.assertions, "assertions");
        const targetAssertion = readRecord(
          assertions.find(
            (entry) => readRecordString(entry, "kind") === "resultField"
          ),
          "runner-api.execute.resolution resultField assertion"
        );

        targetAssertion.field = "$";
      }
    );
    const check = compiledPlan.checks.find(
      (entry) => entry.check.checkId === "runner-api.execute.resolution"
    );

    expect(check?.requiredEvidence).toContain("result");
  });

  test("roots step resultField assertions under trace.step.result", async () => {
    const compiledPlan = await loadMutatedPlan(
      "spec/conformance/runners/plans/react-runner-callables.json",
      (plan) => {
        const checks = readArray(plan.checks, "checks");
        const targetCheck = readRecord(
          checks.find(
            (entry) =>
              readRecordString(entry, "checkId") ===
              "react-runner-callable.checkpoint"
          ),
          "react-runner-callable.checkpoint check"
        );
        const steps = readArray(targetCheck.steps, "steps");
        const checkpointStep = readRecord(steps[0], "checkpoint step");

        checkpointStep.assertions = [
          {
            equals: "ok",
            field: "$.answer",
            kind: "resultField",
          },
        ];
      }
    );
    const check = compiledPlan.checks.find(
      (entry) => entry.check.checkId === "react-runner-callable.checkpoint"
    );

    expect(check?.requiredEvidence).toContain(
      "result.trace.checkpoint.result.answer"
    );
  });

  test("rejects resultField assertions without a field", async () => {
    const pending = loadMutatedPlan(
      "spec/conformance/runners/plans/runner-api-core.json",
      (plan) => {
        const checks = readArray(plan.checks, "checks");
        const targetCheck = readRecord(
          checks.find(
            (entry) =>
              readRecordString(entry, "checkId") ===
              "runner-api.execute.resolution"
          ),
          "runner-api.execute.resolution check"
        );
        const assertions = readArray(targetCheck.assertions, "assertions");
        const targetAssertion = readRecord(
          assertions.find(
            (entry) => readRecordString(entry, "kind") === "resultField"
          ),
          "runner-api.execute.resolution resultField assertion"
        );

        targetAssertion.field = undefined;
      }
    );
    // Bun's rejection matcher returns void; explicitly settle the operation.
    const result = await Promise.allSettled([pending]);
    expect(result[0]?.status).toBe("rejected");
    expect(pending).rejects.toThrow("must have required property 'field'");
  });
});

describe("plan schema boundary", () => {
  test.each([
    ["planId", 1],
    ["applicability", { capabilities: [1] }],
    ["fixtures", { fixture: 1 }],
    ["scenarios", []],
    [
      "checks",
      [
        {
          assertions: [{ kind: "unknown" }],
          checkId: "check",
          operation: "op",
        },
      ],
    ],
    [
      "checks",
      [
        {
          assertions: [{ field: 1, kind: "resultField" }],
          checkId: "check",
          operation: "op",
        },
      ],
    ],
    [
      "checks",
      [
        {
          assertions: [{ kind: "noEvent" }],
          checkId: "check",
          evidence: [1],
          operation: "op",
        },
      ],
    ],
    [
      "checks",
      [
        {
          assertions: [{ kind: "noEvent" }],
          checkId: "check",
          controls: { deadlineMs: "1" },
          operation: "op",
        },
      ],
    ],
    [
      "checks",
      [
        {
          assertions: [{ kind: "noEvent" }],
          checkId: "check",
          operation: "op",
          steps: [{ operation: "op", stepId: 1 }],
        },
      ],
    ],
  ])("rejects malformed %s before reading references", async (field, value) => {
    const [outcome] = await Promise.allSettled([
      loadMutatedPlan(
        "spec/conformance/runners/plans/runner-api-core.json",
        (plan) => {
          if (typeof field !== "string") {
            throw new TypeError("test field must be a string");
          }
          plan[field] = value;
          if (field !== "fixtures") {
            plan.fixtures = { unread: "missing-fixture.json" };
          }
        }
      ),
    ]);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status === "rejected") {
      const reason: unknown = outcome.reason;
      expect(reason).toBeInstanceOf(Error);
      if (reason instanceof Error) {
        expect(reason.message).toContain("failed JSON Schema validation:");
      }
    }
  });

  test("reports the first missing fixture before later fixtures or scenarios", async () => {
    const [outcome] = await Promise.allSettled([
      loadMutatedPlan(
        "spec/conformance/runners/plans/runner-api-core.json",
        (plan) => {
          const fixtures = readRecord(plan.fixtures ?? {}, "fixtures");
          fixtures["first-missing"] = "first-missing.json";
          fixtures["later-missing"] = "later-missing.json";
          plan.fixtures = fixtures;
          const scenarios = readRecord(plan.scenarios ?? {}, "scenarios");
          scenarios.missing = "missing-scenario.json";
          plan.scenarios = scenarios;
        }
      ),
    ]);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status === "rejected") {
      const reason: unknown = outcome.reason;
      expect(reason).toBeInstanceOf(Error);
      if (reason instanceof Error) {
        expect(reason.message).toContain("first-missing.json");
      }
    }
  });
});
