import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectPlanEvidenceOracleShapeFailures } from "../../../scripts/authority-guardrails/authority-guardrails.ts";
import {
  evaluateCertificationRules,
  parseOperationCatalog,
} from "../../plan-compiler/certification-rules.ts";
import type {
  ConformancePlan,
  ConformancePlanAssertion,
} from "../../plan-compiler/index.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";

const catalog = parseOperationCatalog(
  JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../plan-compiler/__fixtures__/certification/operations.json"
      ),
      "utf-8"
    )
  ),
  "fixture"
);
const assertions: ConformancePlanAssertion[] = [
  {
    equalsPath: "$.fixture.expected.hash",
    kind: "digest",
    path: "$.result.hash",
  },
  {
    equalsPath: "$.fixture.expected.bytes",
    kind: "canonicalCbor",
    path: "$.result.hash",
    recordType: "turn-node",
  },
  {
    equalsPath: "$.fixture.expected.hash",
    kind: "identity",
    path: "$.result.hash",
    recordType: "turn-node",
  },
  {
    kind: "referenceWalk",
    path: "$.result",
    references: [
      {
        path: "$.hash",
        recordType: "turn-node",
        targetPath: "$.fixture.expected.records",
      },
    ],
  },
];
const planWith = (assertion: ConformancePlanAssertion): ConformancePlan => ({
  applicability: { capabilities: ["fixture.store"] },
  checks: [
    {
      assertions: [assertion],
      checkId: "integrity",
      operation: "fixture.store.has",
    },
  ],
  packetId: catalog.packetId,
  planId: "integrity",
  planVersion: "0.1.0",
});

for (const assertion of assertions) {
  test(`${assertion.kind} retains observation-path and no-echo compiler rules`, () => {
    const plan = planWith(assertion);
    expect(evaluateCertificationRules(plan, catalog)).toEqual([]);
    expect(collectPlanEvidenceOracleShapeFailures(plan, "integrity")).toEqual(
      []
    );
    expect(
      evaluateCertificationRules(
        planWith({ ...assertion, path: "$.result.undeclared" }),
        catalog
      ).map((finding) => finding.rule)
    ).toContain("observation-path");
    const [check] = plan.checks;
    if (check === undefined) {
      throw new Error("missing check");
    }
    check.fixture = "vector";
    check.steps = [
      {
        assertions: [assertion],
        input: { expected: "$.fixture.expected" },
        operation: check.operation,
        stepId: "invoke",
      },
    ];
    check.assertions = [
      {
        field: "$.trace.invoke.result.hash",
        kind: "resultField",
        present: true,
      },
    ];
    expect(
      evaluateCertificationRules(plan, catalog).map((finding) => finding.rule)
    ).toContain("no-echo");
  });
  test(`${assertion.kind} plan shape requires both operands`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tuvren-integrity-plan-"));
    try {
      const file = path.join(dir, "plan.json");
      await writeFile(file, JSON.stringify(planWith(assertion)));
      const compiled = await loadConformancePlan(file);
      expect(compiled.plan.checks[0]?.assertions[0]).toEqual(assertion);
      expect(compiled.checks[0]?.requiredEvidence).toEqual([]);
      const invalid = { ...assertion };
      if (invalid.kind === "referenceWalk") {
        delete invalid.references;
      } else {
        delete invalid.equalsPath;
      }
      await writeFile(file, JSON.stringify(planWith(invalid)));
      let failure: unknown;
      try {
        await loadConformancePlan(file);
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
}

test("reference targets can be single native read observations", () => {
  const assertion: ConformancePlanAssertion = {
    kind: "referenceWalk",
    path: "$.result",
    references: [
      {
        hashPath: "$.hash",
        path: "$.hash",
        recordType: "turn-node",
        targetPath: "$.result",
      },
    ],
  };
  expect(evaluateCertificationRules(planWith(assertion), catalog)).toEqual([]);
});
