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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPlanEvidenceOracleShapeFailures } from "../../scripts/authority-guardrails/authority-guardrails.ts";
import {
  assertConformanceEvidence,
  createCheckResult,
} from "../../scripts/lib/conformance-contract.js";
import type {
  CompiledConformancePlanCheck,
  ConformancePlanCheck,
} from "../plan-compiler/index.js";
import { loadConformancePlan } from "../plan-compiler/index.js";
import {
  type AssertionContext,
  evaluateAssertions,
  evaluateRequiredEvidence,
} from "../runner/assertion-engine/index.js";

interface MetaCase {
  check: ConformancePlanCheck;
  context: AssertionContext;
  expected: "fail" | "pass";
  id: string;
  requiredEvidence?: readonly string[];
}

const cases: readonly MetaCase[] = [
  {
    check: check("evidence-equals", [
      { field: "$.answer", kind: "evidenceField", equals: "ready" },
    ]),
    context: { evidence: { answer: "ready" } },
    expected: "pass",
    id: "evidenceField equality",
  },
  {
    check: check("state-equals", [
      { field: "$.phase", kind: "stateField", equals: "completed" },
    ]),
    context: { state: { phase: "completed" } },
    expected: "pass",
    id: "stateField equality",
  },
  {
    check: check("error-envelope", [
      {
        kind: "errorEnvelope",
        path: "$.result.error",
        equals: { code: "stable_error", message: "boom" },
      },
    ]),
    context: { result: { error: { code: "stable_error", message: "boom" } } },
    expected: "pass",
    id: "errorEnvelope exact matching",
  },
  {
    check: check("error-envelope-message", [{ kind: "errorEnvelope" }]),
    context: { result: { error: { code: "stable_error" } } },
    expected: "fail",
    id: "errorEnvelope requires message",
  },
  {
    check: check("contains-array", [
      { field: "$.types", kind: "evidenceField", contains: "turn.end" },
    ]),
    context: { evidence: { types: ["turn.start", "turn.end"] } },
    expected: "pass",
    id: "contains over arrays",
  },
  {
    check: check("contains-string", [
      { field: "$.message", kind: "evidenceField", contains: "ready" },
    ]),
    context: { evidence: { message: "system ready" } },
    expected: "pass",
    id: "contains over strings",
  },
  {
    check: check("contains-object-key", [
      { field: "$.metadata", kind: "evidenceField", contains: "requestId" },
    ]),
    context: { evidence: { metadata: { requestId: "req-1" } } },
    expected: "pass",
    id: "contains over object keys",
  },
  {
    check: check("equals-path", [
      {
        field: "$.actual",
        kind: "evidenceField",
        equalsPath: "$.fixture.expected",
      },
    ]),
    context: { evidence: { actual: "ready" }, fixture: { expected: "ready" } },
    expected: "pass",
    id: "equalsPath resolution",
  },
  {
    check: check("object-equals-order-independent", [
      {
        field: "$.actual",
        kind: "evidenceField",
        equals: { alpha: 1, nested: { left: true, right: false } },
      },
    ]),
    context: {
      evidence: { actual: { nested: { right: false, left: true }, alpha: 1 } },
    },
    expected: "pass",
    id: "object equality ignores key insertion order",
  },
  {
    check: check("contains-path", [
      {
        containsPath: "$.fixture.requiredType",
        field: "$.types",
        kind: "evidenceField",
      },
    ]),
    context: {
      evidence: { types: ["turn.start", "turn.end"] },
      fixture: { requiredType: "turn.end" },
    },
    expected: "pass",
    id: "containsPath resolution",
  },
  {
    check: check("regex", [
      { field: "$.code", kind: "evidenceField", matches: "^[a-z_]+$" },
    ]),
    context: { evidence: { code: "stable_error" } },
    expected: "pass",
    id: "regex matching",
  },
  {
    check: check("ordering", [
      { contains: ["turn.start", "turn.end"], kind: "ordering" },
    ]),
    context: { events: [{ type: "turn.start" }, { type: "turn.end" }] },
    expected: "pass",
    id: "ordering",
  },
  {
    check: check("no-event", [{ eventType: "error", kind: "noEvent" }]),
    context: { events: [{ type: "turn.start" }, { type: "turn.end" }] },
    expected: "pass",
    id: "noEvent",
  },
  {
    check: check("terminal", [
      { eventType: "turn.end", kind: "terminalEvent", path: "$.type" },
    ]),
    context: { events: [{ type: "turn.start" }, { type: "turn.end" }] },
    expected: "pass",
    id: "terminalEvent",
  },
  {
    check: check("schema-valid", [
      {
        kind: "schemaValid",
        path: "$.result",
        schema: "$.evidence.schema",
      },
    ]),
    context: {
      evidence: {
        schema: {
          additionalProperties: false,
          properties: { answer: { type: "string" } },
          required: ["answer"],
          type: "object",
        },
      },
      result: { answer: "ready" },
    },
    expected: "pass",
    id: "schemaValid",
  },
  {
    check: check("missing-path", [
      { field: "$.missing", kind: "evidenceField", equals: true },
    ]),
    context: { evidence: {} },
    expected: "fail",
    id: "missing path failure",
  },
  {
    check: check("adapter-error", [{ kind: "errorEnvelope" }]),
    context: { state: { adapterError: { code: "adapter_failed" } } },
    expected: "fail",
    id: "adapter error isolation",
  },
  {
    check: check("required-evidence", [
      { field: "$.present", kind: "evidenceField", equals: true },
    ]),
    context: { evidence: { present: true } },
    expected: "fail",
    id: "required evidence failure",
    requiredEvidence: ["missing"],
  },
  {
    check: check("root-required-evidence", [
      {
        field: "$.trace.step.result.error",
        kind: "stateField",
        equalsPath: "$.state.trace.step.result.error",
      },
    ]),
    context: {
      state: {
        trace: {
          step: {
            result: {
              error: "native-error",
            },
          },
        },
      },
    },
    expected: "pass",
    id: "rooted required evidence",
    requiredEvidence: ["state.trace.step.result.error"],
  },
];

const failures: string[] = [];

for (const testCase of cases) {
  const compiled: CompiledConformancePlanCheck = {
    check: testCase.check,
    requiredEvidence: testCase.requiredEvidence ?? [],
  };
  const results = [
    ...evaluateAssertions(testCase.check, testCase.context),
    ...evaluateRequiredEvidence(compiled, testCase.context),
  ];
  const status = results.every((result) => result.status === "pass")
    ? "pass"
    : "fail";

  if (status !== testCase.expected) {
    failures.push(
      `${testCase.id}: expected ${testCase.expected}, got ${status}`
    );
  }
}

await runPlanCompilerCases(failures);
runEvidenceContractCases(failures);

for (let index = 0; index < 1000; index += 1) {
  const syntheticCheck = check(`scale-${index}`, [
    { field: "$.index", kind: "evidenceField", equals: index },
  ]);
  const compiled: CompiledConformancePlanCheck = {
    check: syntheticCheck,
    requiredEvidence: ["index"],
  };
  const results = [
    ...evaluateAssertions(syntheticCheck, { evidence: { index } }),
    ...evaluateRequiredEvidence(compiled, { evidence: { index } }),
  ];

  if (results.some((result) => result.status === "fail")) {
    failures.push(`scale check ${index} failed`);
    break;
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.log(
    `meta-conformance passed ${cases.length} cases plus 1000 scale checks`
  );
}

function check(
  checkId: string,
  assertions: ConformancePlanCheck["assertions"]
): ConformancePlanCheck {
  return {
    assertions,
    checkId,
    operation: "meta.operation",
  };
}

async function runPlanCompilerCases(failures: string[]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tuvren-meta-plan-"));
  const duplicateStepPlanPath = join(directory, "duplicate-step.json");
  const evidenceOnlyPlanPath = join(directory, "evidence-only.json");
  const stepEvidencePlanPath = join(directory, "step-evidence.json");

  try {
    await writeFile(
      duplicateStepPlanPath,
      `${JSON.stringify(
        {
          applicability: { capabilities: ["meta"] },
          checks: [
            {
              assertions: [{ field: "$.trace", kind: "stateField" }],
              checkId: "meta.duplicate-step",
              evidence: ["trace"],
              operation: "meta.operation",
              steps: [
                { operation: "meta.operation", stepId: "repeat" },
                { operation: "meta.operation", stepId: "repeat" },
              ],
            },
          ],
          packetId: "tuvren.meta",
          planId: "tuvren.meta.duplicate-step",
          planVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    try {
      await loadConformancePlan(duplicateStepPlanPath);
      failures.push("duplicate trace step ids unexpectedly passed validation");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      if (!message.includes("repeats stepId repeat")) {
        failures.push(
          `duplicate trace step id produced wrong error: ${message}`
        );
      }
    }

    const evidenceOnlyPlan = {
      applicability: { capabilities: ["meta"] },
      checks: [
        {
          assertions: [
            {
              field: "$.answer",
              kind: "evidenceField",
              equals: "ready",
            },
          ],
          checkId: "meta.evidence-only",
          evidence: ["answer"],
          operation: "meta.operation",
        },
      ],
      packetId: "tuvren.meta",
      planId: "tuvren.meta.evidence-only",
      planVersion: "0.1.0",
    };
    await writeFile(
      evidenceOnlyPlanPath,
      `${JSON.stringify(evidenceOnlyPlan, null, 2)}\n`
    );
    const compiledEvidenceOnlyPlan =
      await loadConformancePlan(evidenceOnlyPlanPath);
    const evidenceOnlyFailures = collectPlanEvidenceOracleShapeFailures(
      compiledEvidenceOnlyPlan.plan,
      evidenceOnlyPlanPath
    );

    if (
      !evidenceOnlyFailures.some((failure) =>
        failure.message.includes("meta.evidence-only")
      )
    ) {
      failures.push(
        "evidence-only plan unexpectedly passed the decisive-assertion guardrail"
      );
    }

    await writeFile(
      stepEvidencePlanPath,
      `${JSON.stringify(
        {
          applicability: { capabilities: ["meta"] },
          checks: [
            {
              assertions: [
                {
                  field: "$.trace.observe.evidence.value",
                  kind: "evidenceField",
                },
              ],
              checkId: "meta.step-evidence",
              operation: "meta.operation",
              steps: [
                {
                  assertions: [
                    { field: "$.value", kind: "evidenceField" },
                    { field: "$.phase", kind: "stateField" },
                    { kind: "errorEnvelope", path: "$.result.error" },
                  ],
                  operation: "meta.operation",
                  stepId: "observe",
                },
              ],
            },
          ],
          packetId: "tuvren.meta",
          planId: "tuvren.meta.step-evidence",
          planVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    const stepPlan = await loadConformancePlan(stepEvidencePlanPath);
    const requiredEvidence = stepPlan.checks[0]?.requiredEvidence ?? [];
    const stepPlanFailures = collectPlanEvidenceOracleShapeFailures(
      stepPlan.plan,
      stepEvidencePlanPath
    );

    for (const expectedPath of [
      "trace.observe.evidence.value",
      "trace.observe.result.error",
      "trace.observe.state.phase",
    ]) {
      if (!requiredEvidence.includes(expectedPath)) {
        failures.push(
          `step assertion required evidence omitted ${expectedPath}`
        );
      }
    }

    if (
      !stepPlanFailures.some((failure) =>
        failure.message.includes("meta.step-evidence")
      )
    ) {
      failures.push(
        "step evidence-only plan unexpectedly passed the decisive-assertion guardrail"
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function runEvidenceContractCases(failures: string[]): void {
  const checkResult = createCheckResult("meta.evidence", [
    {
      assertionId: "meta.evidence.1",
      status: "pass",
    },
  ]);
  const evidence = {
    boundary: "meta",
    checkResults: [checkResult],
    implementationId: "meta-implementation",
    language: "typescript",
    nonApplicableCheckIds: ["meta.skipped"],
    status: "pass",
    suiteId: "tuvren.meta",
    suiteVersion: "0.1.0",
    summary: {
      applicableChecks: 1,
      failedChecks: 0,
      nonApplicableChecks: 1,
      passedChecks: 1,
      totalChecks: 2,
    },
  };

  try {
    assertConformanceEvidence(evidence, "meta evidence");
  } catch (error: unknown) {
    failures.push(
      `valid explicit applicability evidence failed validation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    assertConformanceEvidence(
      {
        ...evidence,
        summary: {
          ...evidence.summary,
          nonApplicableChecks: 2,
          totalChecks: 3,
        },
      },
      "malformed meta evidence"
    );
    failures.push("malformed applicability counts unexpectedly validated");
  } catch {
    // Expected: nonApplicableChecks must match nonApplicableCheckIds exactly.
  }
}
