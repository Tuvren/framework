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

import type {
  CompiledConformancePlanCheck,
  ConformancePlanCheck,
} from "../plan-compiler/index.js";
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
