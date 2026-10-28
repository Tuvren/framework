import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  evaluateCertificationRules,
  parseOperationCatalog,
} from "./certification-rules.ts";
import { loadConformancePlan } from "./index.ts";

test("whole outcome assertions cannot inspect fields outside the declared error contract", async () => {
  const compiled = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
  );
  const catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  expect(
    evaluateCertificationRules(compiled.plan, catalog, compiled.fixtures)
  ).toEqual([]);
  for (const schema of [
    true,
    { type: "object" },
    {
      type: "object",
      required: ["kind", "error"],
      properties: {
        kind: { const: "error" },
        error: {
          type: "object",
          required: ["code"],
          properties: {
            code: { const: "kernel_runtime_run_lease_not_expired" },
            details: { type: "object" },
          },
        },
      },
    },
    {
      type: "object",
      required: ["kind", "error"],
      properties: {
        kind: { const: "error" },
        error: {
          type: "object",
          required: ["code"],
          properties: { code: { const: "not_in_the_catalog" } },
        },
      },
    },
  ]) {
    const fixtures = new Map([
      ["errors", { expected: { liveLeaseErrorOutcome: schema } }],
    ]);
    expect(
      evaluateCertificationRules(compiled.plan, catalog, fixtures).some(
        ({ rule }) => rule === "observation-path"
      )
    ).toBe(true);
  }
});
