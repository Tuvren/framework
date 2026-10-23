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
import nodePath from "node:path";

import { collectPlanEvidenceOracleShapeFailures } from "../../scripts/authority-guardrails/authority-guardrails.ts";
import {
  assertConformanceEvidence,
  createCheckResult,
} from "../../scripts/lib/conformance-contract.js";
import {
  evaluateAssertions,
  evaluateRequiredEvidence,
} from "../harness/assertion-engine/index.js";
import type { AssertionContext } from "../harness/assertion-engine/index.js";
import type {
  CompiledConformancePlanCheck,
  ConformancePlanAssertion,
  ConformancePlanCheck,
} from "../plan-compiler/index.js";
import { loadConformancePlan } from "../plan-compiler/index.js";

interface MetaCase {
  check: ConformancePlanCheck;
  context: AssertionContext;
  expected: "fail" | "pass";
  id: string;
  requiredEvidence?: readonly string[];
}

const check = (
  checkId: string,
  assertions: ConformancePlanCheck["assertions"]
): ConformancePlanCheck => ({
  assertions,
  checkId,
  operation: "meta.operation",
});

const runPlanCompilerCases = async (failures: string[]): Promise<void> => {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "tuvren-meta-plan-"));
  const duplicateStepPlanPath = nodePath.join(directory, "duplicate-step.json");
  const evidenceOnlyPlanPath = nodePath.join(directory, "evidence-only.json");
  const stepEvidencePlanPath = nodePath.join(directory, "step-evidence.json");

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
              equals: "ready",
              field: "$.answer",
              kind: "evidenceField",
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

    const quantifierPlanPath = nodePath.join(directory, "quantifier.json");
    await writeFile(
      quantifierPlanPath,
      `${JSON.stringify(
        {
          applicability: { capabilities: ["meta"] },
          checks: [
            {
              assertions: [
                {
                  every: { present: true },
                  field: "$.items",
                  kind: "resultField",
                },
              ],
              checkId: "meta.quantifier-without-length",
              operation: "meta.operation",
            },
          ],
          packetId: "tuvren.meta",
          planId: "tuvren.meta.quantifier",
          planVersion: "0.1.0",
        },
        null,
        2
      )}\n`
    );

    try {
      await loadConformancePlan(quantifierPlanPath);
      failures.push("every without length unexpectedly passed compilation");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      if (!message.includes("length")) {
        failures.push(`every without length produced wrong error: ${message}`);
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const runEvidenceContractCases = (failures: string[]): void => {
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

  const zeroApplicable = {
    ...evidence,
    checkResults: [],
    summary: {
      applicableChecks: 0,
      failedChecks: 0,
      nonApplicableChecks: 1,
      passedChecks: 0,
      totalChecks: 1,
    },
  };
  const zeroTotal = {
    ...zeroApplicable,
    nonApplicableCheckIds: [],
    summary: {
      ...zeroApplicable.summary,
      nonApplicableChecks: 0,
      totalChecks: 0,
    },
  };
  const statusCases: readonly {
    evidence: Record<string, unknown>;
    expected: "accept" | "reject";
    id: string;
  }[] = [
    {
      evidence: { ...zeroApplicable, status: "pass" },
      expected: "reject",
      id: "zero applicable reported as pass",
    },
    {
      evidence: { ...zeroApplicable, status: "unsupported" },
      expected: "accept",
      id: "zero applicable reported as unsupported",
    },
    {
      evidence: { ...zeroApplicable, status: "not_applicable" },
      expected: "reject",
      id: "capability exclusions reported as not_applicable",
    },
    {
      evidence: { ...zeroTotal, status: "pass" },
      expected: "reject",
      id: "zero total reported as pass",
    },
    {
      evidence: { ...zeroTotal, status: "not_applicable" },
      expected: "accept",
      id: "zero total reported as not_applicable",
    },
    {
      evidence: { ...evidence, status: "unsupported" },
      expected: "reject",
      id: "applicable checks reported as unsupported",
    },
  ];

  for (const statusCase of statusCases) {
    let accepted = true;
    try {
      assertConformanceEvidence(statusCase.evidence, statusCase.id);
    } catch {
      accepted = false;
    }

    if (accepted !== (statusCase.expected === "accept")) {
      failures.push(
        `evidence contract ${statusCase.id}: expected ${statusCase.expected}`
      );
    }
  }
};

const runWhenReportingCases = (failures: string[]): void => {
  const conditional = check("when-reporting", [
    {
      field: "$.hash",
      kind: "resultField",
      present: true,
      when: { equals: true, path: "$.result.committed" },
    },
  ]);
  const [notApplied] = evaluateAssertions(conditional, {
    result: { committed: false },
  });
  const [applied] = evaluateAssertions(conditional, {
    result: { committed: true, hash: "abc" },
  });

  if (notApplied?.when !== "not_applied" || notApplied.status !== "pass") {
    failures.push("when branch that never applies was not reported");
  }

  if (applied?.when !== "applied" || applied.status !== "pass") {
    failures.push("applied when branch was not reported as applied");
  }
};

const cases: readonly MetaCase[] = [
  {
    check: check("evidence-equals", [
      { equals: "ready", field: "$.answer", kind: "evidenceField" },
    ]),
    context: { evidence: { answer: "ready" } },
    expected: "pass",
    id: "evidenceField equality",
  },
  {
    check: check("state-equals", [
      { equals: "completed", field: "$.phase", kind: "stateField" },
    ]),
    context: { state: { phase: "completed" } },
    expected: "pass",
    id: "stateField equality",
  },
  {
    check: check("error-envelope", [
      {
        equals: { code: "stable_error", message: "boom" },
        kind: "errorEnvelope",
        path: "$.result.error",
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
      { contains: "turn.end", field: "$.types", kind: "evidenceField" },
    ]),
    context: { evidence: { types: ["turn.start", "turn.end"] } },
    expected: "pass",
    id: "contains over arrays",
  },
  {
    check: check("contains-string", [
      { contains: "ready", field: "$.message", kind: "evidenceField" },
    ]),
    context: { evidence: { message: "system ready" } },
    expected: "pass",
    id: "contains over strings",
  },
  {
    check: check("contains-object-key", [
      { contains: "requestId", field: "$.metadata", kind: "evidenceField" },
    ]),
    context: { evidence: { metadata: { requestId: "req-1" } } },
    expected: "pass",
    id: "contains over object keys",
  },
  {
    check: check("equals-path", [
      {
        equalsPath: "$.fixture.expected",
        field: "$.actual",
        kind: "evidenceField",
      },
    ]),
    context: { evidence: { actual: "ready" }, fixture: { expected: "ready" } },
    expected: "pass",
    id: "equalsPath resolution",
  },
  {
    check: check("object-equals-order-independent", [
      {
        equals: { alpha: 1, nested: { left: true, right: false } },
        field: "$.actual",
        kind: "evidenceField",
      },
    ]),
    context: {
      evidence: {
        actual: Object.fromEntries([
          [
            "nested",
            Object.fromEntries([
              ["right", false],
              ["left", true],
            ]),
          ],
          ["alpha", 1],
        ]),
      },
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
    check: check("event-sequence-unresolved", [
      { kind: "eventSequence", notEquals: ["ready"], path: "$.missing" },
    ]),
    context: { events: [{ type: "ready" }] },
    expected: "fail",
    id: "eventSequence unresolved projection",
  },
  {
    check: check("no-event-unresolved", [
      { eventType: "error", kind: "noEvent", path: "$.missing" },
    ]),
    context: { events: [{ type: "ready" }] },
    expected: "fail",
    id: "noEvent unresolved projection",
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
      { equals: true, field: "$.missing", kind: "evidenceField" },
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
      { equals: true, field: "$.present", kind: "evidenceField" },
    ]),
    context: { evidence: { present: true } },
    expected: "fail",
    id: "required evidence failure",
    requiredEvidence: ["missing"],
  },
  {
    check: check("root-required-evidence", [
      {
        equalsPath: "$.state.trace.step.result.error",
        field: "$.trace.step.result.error",
        kind: "stateField",
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

const operatorCase = (
  id: string,
  operators: Omit<ConformancePlanAssertion, "field" | "kind">,
  context: AssertionContext,
  expected: "fail" | "pass"
): MetaCase => ({
  check: check(id.replaceAll(" ", "-"), [
    { field: "$.value", kind: "resultField", ...operators },
  ]),
  context,
  expected,
  id,
});

const items = { value: [{ status: "ok" }, { status: "ok" }] };

const operatorCases: readonly MetaCase[] = [
  operatorCase(
    "unresolved operands",
    { equalsPath: "$.fixture.missing" },
    { fixture: {}, result: {} },
    "fail"
  ),
  operatorCase(
    "unresolved expected operand",
    { equalsPath: "$.fixture.missing" },
    { fixture: {}, result: { value: 1 } },
    "fail"
  ),
  operatorCase(
    "null equals null",
    { equals: null },
    { result: { value: null } },
    "pass"
  ),
  operatorCase(
    "null does not equal absence",
    { equals: null },
    { result: {} },
    "fail"
  ),
  operatorCase("bare assertion", {}, { result: { value: 1 } }, "fail"),
  operatorCase(
    "present true",
    { present: true },
    { result: { value: null } },
    "pass"
  ),
  operatorCase(
    "present true on absence",
    { present: true },
    { result: {} },
    "fail"
  ),
  operatorCase("present false", { present: false }, { result: {} }, "pass"),
  operatorCase(
    "present false on null",
    { present: false },
    { result: { value: null } },
    "fail"
  ),
  operatorCase(
    "notEquals",
    { notEquals: "a" },
    { result: { value: "b" } },
    "pass"
  ),
  operatorCase(
    "notEquals negative control",
    { notEquals: "a" },
    { result: { value: "a" } },
    "fail"
  ),
  operatorCase(
    "notEqualsPath",
    { notEqualsPath: "$.fixture.other" },
    { fixture: { other: 2 }, result: { value: 1 } },
    "pass"
  ),
  operatorCase(
    "notEqualsPath negative control",
    { notEqualsPath: "$.fixture.other" },
    { fixture: { other: 1 }, result: { value: 1 } },
    "fail"
  ),
  operatorCase(
    "notEqualsPath unresolved",
    { notEqualsPath: "$.fixture.missing" },
    { fixture: {}, result: { value: 1 } },
    "fail"
  ),
  operatorCase(
    "lessThan literal",
    { lessThan: 2 },
    { result: { value: 1 } },
    "pass"
  ),
  operatorCase(
    "lessThan negative control",
    { lessThan: 2 },
    { result: { value: 2 } },
    "fail"
  ),
  operatorCase(
    "lessThanOrEqual path",
    { lessThanOrEqual: "$.fixture.bound" },
    { fixture: { bound: 2 }, result: { value: 2 } },
    "pass"
  ),
  operatorCase(
    "lessThanOrEqual negative control",
    { lessThanOrEqual: "$.fixture.bound" },
    { fixture: { bound: 2 }, result: { value: 3 } },
    "fail"
  ),
  operatorCase(
    "greaterThan literal",
    { greaterThan: 2 },
    { result: { value: 3 } },
    "pass"
  ),
  operatorCase(
    "greaterThan negative control",
    { greaterThan: 2 },
    { result: { value: 2 } },
    "fail"
  ),
  operatorCase(
    "greaterThanOrEqual path",
    { greaterThanOrEqual: "$.fixture.bound" },
    { fixture: { bound: 2 }, result: { value: 2 } },
    "pass"
  ),
  operatorCase(
    "greaterThanOrEqual negative control",
    { greaterThanOrEqual: "$.fixture.bound" },
    { fixture: { bound: 2 }, result: { value: 1 } },
    "fail"
  ),
  operatorCase(
    "comparison unresolved path",
    { greaterThan: "$.fixture.missing" },
    { fixture: {}, result: { value: 1 } },
    "fail"
  ),
  operatorCase("length", { length: 2 }, { result: items }, "pass"),
  operatorCase(
    "length negative control",
    { length: 3 },
    { result: items },
    "fail"
  ),
  operatorCase(
    "every",
    { every: { equals: "ok", field: "$.status" }, length: 2 },
    { result: items },
    "pass"
  ),
  operatorCase(
    "every negative control",
    { every: { equals: "bad", field: "$.status" }, length: 2 },
    { result: items },
    "fail"
  ),
  operatorCase(
    "every without length",
    { every: { equals: "ok", field: "$.status" } },
    { result: items },
    "fail"
  ),
  operatorCase(
    "some",
    { length: 2, some: { equals: "ok", field: "$.status" } },
    { result: items },
    "pass"
  ),
  operatorCase(
    "some negative control",
    { length: 2, some: { equals: "bad", field: "$.status" } },
    { result: items },
    "fail"
  ),
  operatorCase(
    "some with unresolved element field",
    { length: 2, some: { equals: "ok", field: "$.status" } },
    { result: { value: [{}, { status: "ok" }] } },
    "fail"
  ),
  operatorCase(
    "some without length",
    { some: { equals: "ok", field: "$.status" } },
    { result: items },
    "fail"
  ),
  operatorCase(
    "when applied",
    { equals: 1, when: { equals: true, path: "$.result.flag" } },
    { result: { flag: true, value: 1 } },
    "pass"
  ),
  operatorCase(
    "when applied negative control",
    { equals: 1, when: { equals: true, path: "$.result.flag" } },
    { result: { flag: true, value: 2 } },
    "fail"
  ),
  operatorCase(
    "when unresolved",
    { equals: 1, when: { equals: true, path: "$.result.flag" } },
    { result: { value: 1 } },
    "fail"
  ),
];

const failures: string[] = [];

for (const testCase of [...cases, ...operatorCases]) {
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
runWhenReportingCases(failures);

for (let index = 0; index < 1000; index += 1) {
  const syntheticCheck = check(`scale-${index}`, [
    { equals: index, field: "$.index", kind: "evidenceField" },
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
    `meta-conformance passed ${cases.length + operatorCases.length} cases plus 1000 scale checks`
  );
}
