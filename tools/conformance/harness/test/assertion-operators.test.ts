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

import type { ConformancePlanAssertion } from "../../plan-compiler/index.ts";
import { evaluateAssertions } from "../assertion-engine/index.ts";
import type {
  AssertionContext,
  AssertionEvaluation,
} from "../assertion-engine/index.ts";

const evaluate = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): AssertionEvaluation => {
  const [evaluation] = evaluateAssertions(
    { assertions: [assertion], checkId: "ck.operators", operation: "op" },
    context
  );

  if (evaluation === undefined) {
    throw new Error("expected one evaluation");
  }

  return evaluation;
};

const field = (
  path: string,
  operators: Omit<ConformancePlanAssertion, "field" | "kind">
): ConformancePlanAssertion => ({
  field: path,
  kind: "resultField",
  ...operators,
});

describe("unresolved operands fail", () => {
  test("two unresolved operands never compare equal", () => {
    const evaluation = evaluate(
      field("$.missing", { equalsPath: "$.fixture.missing" }),
      { fixture: {}, result: {} }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("an unresolved expected path fails even when the actual resolves", () => {
    expect(
      evaluate(field("$.value", { equalsPath: "$.fixture.missing" }), {
        fixture: {},
        result: { value: 1 },
      }).status
    ).toBe("fail");
  });

  test("an unresolved containsPath fails", () => {
    expect(
      evaluate(field("$.values", { containsPath: "$.fixture.missing" }), {
        fixture: {},
        result: { values: [1] },
      }).status
    ).toBe("fail");
  });

  test("a resolved equalsPath still passes", () => {
    expect(
      evaluate(field("$.value", { equalsPath: "$.fixture.value" }), {
        fixture: { value: 1 },
        result: { value: 1 },
      }).status
    ).toBe("pass");
  });
});

describe("null is distinct from absence", () => {
  test("equals null passes on an explicit null", () => {
    expect(
      evaluate(field("$.value", { equals: null }), { result: { value: null } })
        .status
    ).toBe("pass");
  });

  test("equals null fails on an absent field", () => {
    expect(
      evaluate(field("$.value", { equals: null }), { result: {} }).status
    ).toBe("fail");
  });

  test("equalsPath to an explicit null fails against an absent actual", () => {
    expect(
      evaluate(field("$.value", { equalsPath: "$.fixture.value" }), {
        fixture: { value: null },
        result: {},
      }).status
    ).toBe("fail");
  });
});

describe("present", () => {
  test("a bare field assertion without an operator fails", () => {
    const evaluation = evaluate(field("$.value", {}), {
      result: { value: 1 },
    });
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("present");
  });

  test("present true passes on a defined value and on null", () => {
    expect(
      evaluate(field("$.value", { present: true }), { result: { value: 0 } })
        .status
    ).toBe("pass");
    expect(
      evaluate(field("$.value", { present: true }), {
        result: { value: null },
      }).status
    ).toBe("pass");
  });

  test("present true fails on absence", () => {
    expect(
      evaluate(field("$.value", { present: true }), { result: {} }).status
    ).toBe("fail");
  });

  test("present false passes only on absence", () => {
    expect(
      evaluate(field("$.value", { present: false }), { result: {} }).status
    ).toBe("pass");
    expect(
      evaluate(field("$.value", { present: false }), {
        result: { value: null },
      }).status
    ).toBe("fail");
    expect(
      evaluate(field("$.value", { present: false }), {
        result: { value: 1 },
      }).status
    ).toBe("fail");
  });
});

describe("notEquals and notEqualsPath", () => {
  test("notEquals passes on a different value and fails on an equal one", () => {
    expect(
      evaluate(field("$.value", { notEquals: "a" }), {
        result: { value: "b" },
      }).status
    ).toBe("pass");
    expect(
      evaluate(field("$.value", { notEquals: { k: [1] } }), {
        result: { value: { k: [1] } },
      }).status
    ).toBe("fail");
  });

  test("notEquals fails when the actual is absent", () => {
    expect(
      evaluate(field("$.value", { notEquals: "a" }), { result: {} }).status
    ).toBe("fail");
  });

  test("notEqualsPath passes on a different value and fails on an equal one", () => {
    expect(
      evaluate(field("$.value", { notEqualsPath: "$.fixture.other" }), {
        fixture: { other: 2 },
        result: { value: 1 },
      }).status
    ).toBe("pass");
    expect(
      evaluate(field("$.value", { notEqualsPath: "$.fixture.other" }), {
        fixture: { other: 1 },
        result: { value: 1 },
      }).status
    ).toBe("fail");
  });

  test("notEqualsPath fails when either operand is unresolved", () => {
    expect(
      evaluate(field("$.value", { notEqualsPath: "$.fixture.missing" }), {
        fixture: {},
        result: { value: 1 },
      }).status
    ).toBe("fail");
    expect(
      evaluate(field("$.missing", { notEqualsPath: "$.fixture.other" }), {
        fixture: { other: 1 },
        result: {},
      }).status
    ).toBe("fail");
  });
});

describe("numeric comparisons", () => {
  const cases: {
    actual: number;
    expected: "fail" | "pass";
    operator:
      | "greaterThan"
      | "greaterThanOrEqual"
      | "lessThan"
      | "lessThanOrEqual";
    operand: number;
  }[] = [
    { actual: 1, expected: "pass", operand: 2, operator: "lessThan" },
    { actual: 2, expected: "fail", operand: 2, operator: "lessThan" },
    { actual: 2, expected: "pass", operand: 2, operator: "lessThanOrEqual" },
    { actual: 3, expected: "fail", operand: 2, operator: "lessThanOrEqual" },
    { actual: 3, expected: "pass", operand: 2, operator: "greaterThan" },
    { actual: 2, expected: "fail", operand: 2, operator: "greaterThan" },
    { actual: 2, expected: "pass", operand: 2, operator: "greaterThanOrEqual" },
    { actual: 1, expected: "fail", operand: 2, operator: "greaterThanOrEqual" },
  ];

  test.each(cases)(
    "$operator $operand against $actual is $expected with a literal",
    ({ actual, expected, operand, operator }) => {
      expect(
        evaluate(field("$.value", { [operator]: operand }), {
          result: { value: actual },
        }).status
      ).toBe(expected);
    }
  );

  test.each(cases)(
    "$operator $operand against $actual is $expected with a path",
    ({ actual, expected, operand, operator }) => {
      expect(
        evaluate(field("$.value", { [operator]: "$.fixture.bound" }), {
          fixture: { bound: operand },
          result: { value: actual },
        }).status
      ).toBe(expected);
    }
  );

  test("a comparison fails when its path operand is unresolved", () => {
    expect(
      evaluate(field("$.value", { greaterThan: "$.fixture.missing" }), {
        fixture: {},
        result: { value: 1 },
      }).status
    ).toBe("fail");
  });

  test("a comparison fails on a non-numeric actual", () => {
    expect(
      evaluate(field("$.value", { greaterThan: 0 }), {
        result: { value: "1" },
      }).status
    ).toBe("fail");
  });

  test("a comparison fails on an absent actual", () => {
    expect(
      evaluate(field("$.value", { lessThan: 10 }), { result: {} }).status
    ).toBe("fail");
  });
});

describe("length", () => {
  test("length matches the array cardinality", () => {
    expect(
      evaluate(field("$.items", { length: 2 }), { result: { items: [1, 2] } })
        .status
    ).toBe("pass");
    expect(
      evaluate(field("$.items", { length: 3 }), { result: { items: [1, 2] } })
        .status
    ).toBe("fail");
  });

  test("length accepts a path operand and fails when it is unresolved", () => {
    expect(
      evaluate(field("$.items", { length: "$.fixture.count" }), {
        fixture: { count: 2 },
        result: { items: [1, 2] },
      }).status
    ).toBe("pass");
    expect(
      evaluate(field("$.items", { length: "$.fixture.missing" }), {
        fixture: {},
        result: { items: [1, 2] },
      }).status
    ).toBe("fail");
  });

  test("length fails on a non-array actual", () => {
    expect(
      evaluate(field("$.items", { length: 2 }), { result: { items: "ab" } })
        .status
    ).toBe("fail");
  });
});

describe("every and some", () => {
  const items = [
    { id: "a", status: "ok" },
    { id: "b", status: "ok" },
  ];

  test("every passes when each element satisfies the nested assertion", () => {
    expect(
      evaluate(
        field("$.items", {
          every: { equals: "ok", field: "$.status" },
          length: 2,
        }),
        { result: { items } }
      ).status
    ).toBe("pass");
  });

  test("every fails when one element violates the nested assertion", () => {
    expect(
      evaluate(
        field("$.items", {
          every: { equals: "ok", field: "$.status" },
          length: 2,
        }),
        { result: { items: [...items, { id: "c", status: "bad" }] } }
      ).status
    ).toBe("fail");
  });

  test("every fails when the explicit length disagrees, even on an empty array", () => {
    expect(
      evaluate(
        field("$.items", {
          every: { equals: "ok", field: "$.status" },
          length: 1,
        }),
        { result: { items: [] } }
      ).status
    ).toBe("fail");
  });

  test("every without length is rejected", () => {
    const evaluation = evaluate(
      field("$.items", { every: { equals: "ok", field: "$.status" } }),
      { result: { items } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("length");
  });

  test("some passes when one element satisfies the nested assertion", () => {
    expect(
      evaluate(
        field("$.items", { length: 2, some: { equals: "b", field: "$.id" } }),
        { result: { items } }
      ).status
    ).toBe("pass");
  });

  test("some fails when no element satisfies the nested assertion", () => {
    expect(
      evaluate(
        field("$.items", { length: 2, some: { equals: "z", field: "$.id" } }),
        { result: { items } }
      ).status
    ).toBe("fail");
  });

  test("some without length is rejected", () => {
    const evaluation = evaluate(
      field("$.items", { some: { equals: "b", field: "$.id" } }),
      { result: { items } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("length");
  });

  test("a nested element assertion treats an absent subject as unresolved", () => {
    expect(
      evaluate(
        field("$.items", {
          every: { field: "$.missing", notEquals: "x" },
          length: 2,
        }),
        { result: { items } }
      ).status
    ).toBe("fail");
  });

  test("some fails when an element field is unresolved even if another element matches", () => {
    const evaluation = evaluate(
      field("$.items", {
        length: 2,
        some: { equals: "ok", field: "$.status" },
      }),
      { result: { items: [{}, { status: "ok" }] } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("some fails on a later unresolved element even when the first matches", () => {
    const evaluation = evaluate(
      field("$.items", {
        length: 2,
        some: { equals: "ok", field: "$.status" },
      }),
      { result: { items: [{ status: "ok" }, {}] } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("every reports a later unresolved element after an earlier violation", () => {
    const evaluation = evaluate(
      field("$.items", {
        every: { equals: "ok", field: "$.status" },
        length: 2,
      }),
      { result: { items: [{ status: "bad" }, {}] } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("every reports an unresolved element field as unresolved", () => {
    const evaluation = evaluate(
      field("$.items", {
        every: { field: "$.status", notEquals: "bad" },
        length: 2,
      }),
      { result: { items: [{ status: "ok" }, {}] } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("an unresolved nested operand path inside some fails", () => {
    const evaluation = evaluate(
      field("$.items", {
        length: 2,
        some: { equalsPath: "$.fixture.missing", field: "$.status" },
      }),
      { fixture: {}, result: { items } }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("every fails on a non-array actual", () => {
    expect(
      evaluate(field("$.items", { every: { present: true }, length: 0 }), {
        result: { items: {} },
      }).status
    ).toBe("fail");
  });
});

describe("unresolved event projections fail", () => {
  const events = [{ type: "ready" }];

  test("eventSequence fails when the projected path is unresolved", () => {
    const evaluation = evaluate(
      { kind: "eventSequence", notEquals: ["ready"], path: "$.missing" },
      { events }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("eventSequence fails when any event leaves the projection unresolved", () => {
    expect(
      evaluate(
        { contains: "ready", kind: "eventSequence" },
        { events: [{ type: "ready" }, { kind: "untyped" }] }
      ).status
    ).toBe("fail");
  });

  test("eventSequence over a resolved projection still passes", () => {
    expect(
      evaluate({ equals: ["ready"], kind: "eventSequence" }, { events }).status
    ).toBe("pass");
  });

  test("noEvent fails when the projected path is unresolved", () => {
    const evaluation = evaluate(
      { eventType: "error", kind: "noEvent", path: "$.missing" },
      { events }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });

  test("ordering fails when an event leaves the projection unresolved", () => {
    const evaluation = evaluate(
      { contains: ["start", "end"], kind: "ordering" },
      { events: [{ type: "start" }, { kind: "untyped" }, { type: "end" }] }
    );
    expect(evaluation.status).toBe("fail");
    expect(evaluation.message).toContain("unresolved");
  });
});

describe("when", () => {
  const assertion = field("$.hash", {
    present: true,
    when: { equals: true, path: "$.result.committed" },
  });

  test("an applied branch evaluates its assertion and reports it applied", () => {
    const passing = evaluate(assertion, {
      result: { committed: true, hash: "abc" },
    });
    expect(passing).toMatchObject({ status: "pass", when: "applied" });
    const failing = evaluate(assertion, { result: { committed: true } });
    expect(failing).toMatchObject({ status: "fail", when: "applied" });
  });

  test("a branch that does not apply is reported as not applied", () => {
    const evaluation = evaluate(assertion, { result: { committed: false } });
    expect(evaluation).toMatchObject({ status: "pass", when: "not_applied" });
    expect(evaluation.message).toContain("$.result.committed");
  });

  test("an unresolved when path fails without claiming the branch applied", () => {
    const evaluation = evaluate(assertion, { result: {} });
    expect(evaluation.status).toBe("fail");
    expect(evaluation).not.toHaveProperty("when");
  });

  test("assertions without when carry no branch report", () => {
    expect(
      evaluate(field("$.value", { equals: 1 }), { result: { value: 1 } })
    ).not.toHaveProperty("when");
  });
});

describe("errorEnvelope", () => {
  test("a bare errorEnvelope remains a shape check", () => {
    expect(
      evaluate(
        { kind: "errorEnvelope" },
        { result: { error: { code: "stable", message: "boom" } } }
      ).status
    ).toBe("pass");
    expect(
      evaluate({ kind: "errorEnvelope" }, { result: { error: { code: "x" } } })
        .status
    ).toBe("fail");
  });
});

describe("contains", () => {
  test("object containment reads own keys only", () => {
    expect(
      evaluate(field("$.value", { contains: "constructor" }), {
        result: { value: {} },
      }).status
    ).toBe("fail");
  });
});

describe("operators compose conjunctively", () => {
  test("every declared operator must hold", () => {
    expect(
      evaluate(field("$.value", { greaterThan: 0, lessThan: 10 }), {
        result: { value: 5 },
      }).status
    ).toBe("pass");
    expect(
      evaluate(field("$.value", { greaterThan: 0, lessThan: 10 }), {
        result: { value: 11 },
      }).status
    ).toBe("fail");
  });

  test("present false cannot be combined with a value operator", () => {
    expect(
      evaluate(field("$.value", { equals: 1, present: false }), {
        result: {},
      }).status
    ).toBe("fail");
  });
});
