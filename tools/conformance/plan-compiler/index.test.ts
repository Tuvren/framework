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
import { dirname, join } from "node:path";
import { loadConformancePlan } from "./index.ts";

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
    await expect(
      loadMutatedPlan(
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
      )
    ).rejects.toThrow("must have required property 'field'");
  });
});

async function loadMutatedPlan(
  planPath: string,
  mutate: (plan: Record<string, unknown>) => void
) {
  const sourcePlanPath = join(process.cwd(), planPath);
  const source = readRecord(
    JSON.parse(await readFile(sourcePlanPath, "utf8")),
    planPath
  );
  mutate(source);

  const tempDir = await mkdtemp(join(tmpdir(), "tuvren-plan-"));
  const tempPath = join(tempDir, "plan.json");

  await writeFile(tempPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  await copyPlanReferences(sourcePlanPath, tempDir, source.fixtures);
  await copyPlanReferences(sourcePlanPath, tempDir, source.scenarios);
  return await loadConformancePlan(tempPath);
}

async function copyPlanReferences(
  sourcePlanPath: string,
  tempDir: string,
  references: unknown
): Promise<void> {
  if (!isRecord(references)) {
    return;
  }

  for (const relativePath of Object.values(references)) {
    if (typeof relativePath !== "string") {
      continue;
    }

    const sourcePath = join(dirname(sourcePlanPath), relativePath);
    const tempPath = join(tempDir, relativePath);

    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, await readFile(sourcePath, "utf8"), "utf8");
  }
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function readRecordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
