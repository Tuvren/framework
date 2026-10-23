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
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  assertCertificationEnforcement,
  assessConformancePlans,
  collectEnforcedViolations,
  formatCertificationInventory,
  loadCertificationAuthority,
} from "./certification-assessment.ts";
import type { CertificationRuleId } from "./certification-rules.ts";
import {
  evaluateCertificationRules,
  parseOperationCatalog,
} from "./certification-rules.ts";
import type {
  ConformancePlan,
  ConformancePlanAssertion,
  ConformancePlanCheck,
} from "./index.ts";
import { findConformancePlans } from "./index.ts";

const FIXTURE_DIR =
  "tools/conformance/plan-compiler/__fixtures__/certification";
const FIXTURE_PACKET = `${FIXTURE_DIR}/packet.json`;
const MIGRATED_VIOLATING_PATTERN = /migrated-violating-plan\.json/u;
const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");

const CATALOG_JSON = JSON.parse(
  await readFile(
    nodePath.resolve(REPO_ROOT, FIXTURE_DIR, "operations.json"),
    "utf-8"
  )
) as { operations: unknown[] };

const catalog = parseOperationCatalog(CATALOG_JSON, "fixture catalog");

const planWith = (...checks: ConformancePlanCheck[]): ConformancePlan => ({
  applicability: { capabilities: ["fixture.store"] },
  checks,
  fixtures: { store: "store.json" },
  packetId: "tuvren.fixture.certification",
  planId: "tuvren.fixture.rules",
  planVersion: "0.1.0",
});

const hasCheck = (
  assertions: ConformancePlanAssertion[],
  overrides: Partial<ConformancePlanCheck> = {}
): ConformancePlanCheck => ({
  assertions,
  checkId: "fixture.check",
  operation: "fixture.store.has",
  ...overrides,
});

const rulesFired = (
  plan: ConformancePlan,
  withCatalog = true
): CertificationRuleId[] =>
  evaluateCertificationRules(plan, withCatalog ? catalog : undefined).map(
    (violation) => violation.rule
  );

const PRESENT_IS_TRUE: ConformancePlanAssertion = {
  equals: true,
  field: "$.present",
  kind: "resultField",
};

describe("operation-catalogued", () => {
  test("fires on an uncatalogued check or step operation", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([PRESENT_IS_TRUE], { operation: "fixture.store.gone" })
        )
      )
    ).toContain("operation-catalogued");
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            steps: [
              {
                arguments: { key: "a" },
                assertions: [PRESENT_IS_TRUE],
                operation: "fixture.store.gone",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("operation-catalogued");
  });

  test("stays silent on catalogued operations", () => {
    expect(rulesFired(planWith(hasCheck([PRESENT_IS_TRUE])))).toEqual([]);
  });
});

describe("observation-path", () => {
  test.each([
    [
      "result field outside the schema",
      { equals: "x", field: "$.verdict", kind: "resultField" },
    ],
    [
      "state field outside the schema",
      { equals: 1, field: "$.missing", kind: "stateField" },
    ],
    [
      "evidence is not an observation domain",
      { equals: "x", field: "$.anything", kind: "evidenceField" },
    ],
    [
      "operand path outside the schema",
      { equalsPath: "$.result.nope", field: "$.hash", kind: "resultField" },
    ],
    [
      "event projection outside the item schema",
      { equals: ["a"], kind: "eventSequence", path: "$.name" },
    ],
    [
      "quantified element field outside the item schema",
      {
        every: { equals: "a", field: "$.label" },
        field: "$.entries",
        kind: "resultField",
        length: 1,
      },
    ],
  ] as const)("fires on %s", (_label, assertion) => {
    expect(
      rulesFired(planWith(hasCheck([assertion as ConformancePlanAssertion])))
    ).toContain("observation-path");
  });

  test("fires on a capture path outside the schema", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            steps: [
              {
                arguments: { key: "a" },
                assertions: [PRESENT_IS_TRUE],
                capture: [{ name: "token", path: "result.token" }],
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("observation-path");
  });

  test("fires on a trace check assertion naming an unknown step", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck(
            [
              {
                field: "$.trace.ghost.result.hash",
                kind: "resultField",
                present: true,
              },
            ],
            {
              steps: [
                {
                  arguments: { key: "a" },
                  operation: "fixture.store.has",
                  stepId: "lookup",
                },
              ],
            }
          )
        )
      )
    ).toContain("observation-path");
  });

  test("stays silent on paths declared by the observation schemas", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([
            { field: "$.hash", kind: "resultField", present: true },
            { equals: 1, field: "$.count", kind: "stateField" },
            { equals: ["stored"], kind: "eventSequence", path: "$.type" },
            { eventType: "stored", kind: "terminalEvent" },
            {
              every: { equals: "a", field: "$.key" },
              field: "$.entries",
              kind: "resultField",
              length: 1,
            },
          ])
        )
      )
    ).toEqual([]);
  });

  test("stays silent on trace paths declared by each step's operation", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck(
            [
              {
                field: "$.trace.lookup.result.hash",
                kind: "resultField",
                notEqualsPath: "$.result.trace.put.result.hash",
              },
            ],
            {
              steps: [
                {
                  arguments: { key: "a" },
                  capture: [{ name: "hash", path: "result.hash" }],
                  operation: "fixture.store.put",
                  stepId: "put",
                },
                {
                  arguments: { hash: { $ref: "capture.hash" } },
                  assertions: [PRESENT_IS_TRUE],
                  operation: "fixture.store.has",
                  stepId: "lookup",
                },
              ],
            }
          )
        )
      )
    ).toEqual([]);
  });
});

describe("literal-boolean", () => {
  test.each([
    [
      "a string field",
      hasCheck([{ equals: false, field: "$.hash", kind: "resultField" }]),
    ],
    [
      "a boolean of a control operation",
      hasCheck([{ equals: true, field: "$.ok", kind: "resultField" }], {
        operation: "fixture.control.verdict",
      }),
    ],
    [
      "a notEquals literal on a non-boolean field",
      hasCheck([{ field: "$.count", kind: "stateField", notEquals: true }]),
    ],
    [
      "a quantified element literal on a non-boolean field",
      hasCheck([
        {
          every: { equals: true, field: "$.key" },
          field: "$.entries",
          kind: "resultField",
          length: 1,
        },
      ]),
    ],
  ] as const)("fires on %s", (_label, check) => {
    expect(rulesFired(planWith(check))).toContain("literal-boolean");
  });

  test("fires on every literal boolean of an uncatalogued plan", () => {
    expect(rulesFired(planWith(hasCheck([PRESENT_IS_TRUE])), false)).toEqual([
      "literal-boolean",
    ]);
  });

  test("stays silent on native booleans of a syscall", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([
            PRESENT_IS_TRUE,
            { field: "$.present", kind: "resultField", notEquals: false },
            {
              every: { equals: true, field: "$.live" },
              field: "$.entries",
              kind: "resultField",
              length: 1,
            },
          ])
        )
      )
    ).toEqual([]);
  });
});

describe("observation-local references", () => {
  const localCatalog = parseOperationCatalog(
    {
      ...CATALOG_JSON,
      operations: [
        ...CATALOG_JSON.operations,
        {
          binding: "fixture.store",
          capability: "fixture.store",
          input: { type: "object" },
          kind: "syscall",
          observation: {
            result: {
              $defs: {
                entry: {
                  additionalProperties: false,
                  properties: { done: { $ref: "#/$defs/flag" } },
                  type: "object",
                },
                flag: { type: "boolean" },
              },
              additionalProperties: false,
              properties: { entry: { $ref: "#/$defs/entry" } },
              type: "object",
            },
          },
          operationId: "fixture.store.local",
        },
      ],
    },
    "local $defs catalog"
  );

  test("resolve against the observation schema like the integrity validator", () => {
    expect(
      evaluateCertificationRules(
        planWith(
          hasCheck(
            [{ equals: true, field: "$.entry.done", kind: "resultField" }],
            { operation: "fixture.store.local" }
          )
        ),
        localCatalog
      )
    ).toEqual([]);
  });
});

describe("no-echo", () => {
  test("fires when an argument reference reaches the expected fixture node", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            steps: [
              {
                arguments: { hash: { $ref: "fixture.input.hash" } },
                assertions: [
                  {
                    equalsPath: "$.fixture.input.hash",
                    field: "$.hash",
                    kind: "resultField",
                  },
                ],
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("no-echo");
  });

  test("fires when an argument forwards an ancestor of the expected node", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            input: { record: { hash: "a" } },
            steps: [
              {
                arguments: { record: { $ref: "input.record" } },
                assertions: [
                  {
                    equalsPath: "$.input.record.hash",
                    field: "$.hash",
                    kind: "resultField",
                  },
                ],
                operation: "fixture.store.put",
                stepId: "put",
              },
            ],
          })
        )
      )
    ).toContain("no-echo");
  });

  test("fires on a legacy dispatch that forwards the whole fixture", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck(
            [
              {
                equalsPath: "$.fixture.expected.hash",
                field: "$.hash",
                kind: "resultField",
              },
            ],
            { fixture: "store" }
          )
        )
      )
    ).toContain("no-echo");
  });

  test("fires when an inspection query forwards the expected node", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            steps: [
              {
                arguments: { key: "a" },
                assertions: [
                  {
                    equalsPath: "$.fixture.input.expectedCount",
                    field: "$.count",
                    kind: "stateField",
                  },
                ],
                inspectState: {
                  count: { $ref: "fixture.input.expectedCount" },
                },
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("no-echo");
  });

  test("fires when a projected check expects a node of its instance input", () => {
    const steps = [
      {
        arguments: { key: { $literal: "a" } },
        assertions: [
          {
            equalsPath: "$.input.expectedCount",
            field: "$.count",
            kind: "stateField" as const,
          },
        ],
        operation: "fixture.store.has",
        stepId: "lookup",
      },
    ];

    expect(
      rulesFired(planWith(hasCheck([], { input: { expectedCount: 1 }, steps })))
    ).toContain("no-echo");
    expect(
      rulesFired(
        planWith(
          hasCheck(
            [
              {
                equalsPath: "$.input.expectedCount",
                field: "$.trace.lookup.state.count",
                kind: "stateField",
              },
            ],
            {
              input: { expectedCount: 1 },
              steps: [{ ...steps[0], assertions: [] }],
            }
          )
        )
      )
    ).toContain("no-echo");
  });

  test("stays silent when the expected node is not forwarded", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            steps: [
              {
                arguments: { key: { $ref: "fixture.input.key" } },
                assertions: [
                  {
                    equalsPath: "$.fixture.expected.hash",
                    field: "$.hash",
                    kind: "resultField",
                  },
                ],
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toEqual([]);
  });
});

describe("expected-root-reference", () => {
  test("fires on an argument reference into fixture.expected", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            steps: [
              {
                arguments: { hash: { $ref: "fixture.expected.hash" } },
                assertions: [PRESENT_IS_TRUE],
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("expected-root-reference");
  });

  test("fires on an inspection query reference into fixture.expected", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            steps: [
              {
                arguments: { key: "a" },
                assertions: [PRESENT_IS_TRUE],
                inspectState: { count: { $ref: "fixture.expected.count" } },
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("expected-root-reference");
  });

  test.each([
    ["a $ref", { hash: { $ref: "fixture.expected.hash" } }],
    ["a legacy path", { hash: "$.fixture.expected.hash" }],
  ])(
    "fires on %s into fixture.expected in a projected check's instance input",
    (_label, input) => {
      expect(
        rulesFired(
          planWith(
            hasCheck([], {
              fixture: "store",
              input,
              steps: [
                {
                  arguments: { key: "a" },
                  assertions: [PRESENT_IS_TRUE],
                  operation: "fixture.store.has",
                  stepId: "lookup",
                },
              ],
            })
          )
        )
      ).toContain("expected-root-reference");
    }
  );

  test("fires on a legacy step input reference into fixture.expected", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            steps: [
              {
                assertions: [PRESENT_IS_TRUE],
                input: { hash: "$.fixture.expected.hash" },
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toContain("expected-root-reference");
  });

  test("stays silent on input, fixture.input, capture, and $literal", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([], {
            fixture: "store",
            input: { key: "a" },
            steps: [
              {
                arguments: { key: { $ref: "input.key" } },
                capture: [{ name: "hash", path: "result.hash" }],
                operation: "fixture.store.put",
                stepId: "put",
              },
              {
                arguments: {
                  hash: { $ref: "capture.hash" },
                  note: { $literal: { $ref: "fixture.expected.hash" } },
                  other: { $ref: "fixture.input.key" },
                },
                assertions: [PRESENT_IS_TRUE],
                operation: "fixture.store.has",
                stepId: "lookup",
              },
            ],
          })
        )
      )
    ).toEqual([]);
  });
});

describe("evidence-only-proof", () => {
  test("fires on a check proven only by adapter evidence", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([{ equals: "a", field: "$.answer", kind: "evidenceField" }])
        ),
        false
      )
    ).toContain("evidence-only-proof");
  });

  test("stays silent when an observation assertion decides the check", () => {
    expect(
      rulesFired(
        planWith(
          hasCheck([{ field: "$.hash", kind: "resultField", present: true }])
        ),
        false
      )
    ).toEqual([]);
  });
});

describe("certification modes", () => {
  test("report mode does not fail the current plans", async () => {
    const planPaths = await findConformancePlans();
    const assessments = await assessConformancePlans(
      planPaths,
      await loadCertificationAuthority()
    );

    expect(assessments.map((assessment) => assessment.planPath)).toEqual(
      planPaths
    );
    expect(
      assessments
        .filter((assessment) => assessment.catalogStatus === "uncatalogued")
        .every((assessment) => assessment.mode === "report")
    ).toBe(true);
    expect(collectEnforcedViolations(assessments)).toEqual([]);
    expect(() => assertCertificationEnforcement(assessments)).not.toThrow();
  });

  test("enforcing mode fails a migrated plan with a violation", async () => {
    const assessments = await assessConformancePlans(
      [
        `${FIXTURE_DIR}/migrated-violating-plan.json`,
        `${FIXTURE_DIR}/migrated-compliant-plan.json`,
        `${FIXTURE_DIR}/unmigrated-violating-plan.json`,
      ],
      await loadCertificationAuthority([FIXTURE_PACKET])
    );
    const [violating, compliant, unmigrated] = assessments;

    expect(violating?.mode).toBe("enforcing");
    expect(violating?.profileIds).toEqual(["fixture.memory"]);
    expect(compliant?.mode).toBe("enforcing");
    expect(compliant?.violations).toEqual([]);
    expect(unmigrated?.mode).toBe("report");
    expect(unmigrated?.violations.length).toBeGreaterThan(0);

    const enforced = collectEnforcedViolations(assessments);
    expect(new Set(enforced.map((entry) => entry.planPath))).toEqual(
      new Set([`${FIXTURE_DIR}/migrated-violating-plan.json`])
    );
    expect(enforced.map((entry) => entry.violation.rule).toSorted()).toEqual([
      "literal-boolean",
      "observation-path",
    ]);
    expect(() => assertCertificationEnforcement(assessments)).toThrow(
      MIGRATED_VIOLATING_PATTERN
    );
  });

  test("the inventory counts violations by port, plan, and rule", async () => {
    const assessments = await assessConformancePlans(
      [`${FIXTURE_DIR}/unmigrated-violating-plan.json`],
      await loadCertificationAuthority([FIXTURE_PACKET])
    );
    const inventory = formatCertificationInventory(assessments);

    expect(inventory).toContain("unmigrated-violating-plan.json");
    expect(inventory).toContain("observation-path=1");
    expect(inventory).toContain("literal-boolean=1");
  });
});
