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

import Ajv2020 from "ajv/dist/2020.js";

import type {
  CompiledConformancePlanCheck,
  ConformancePlanCheck,
} from "../../plan-compiler/index.ts";
import {
  diagnoseAssertions,
  evaluateAssertions,
  evaluateRequiredEvidence,
} from "../assertion-engine/index.ts";
import { getCompiledSchemaValidator } from "../assertion-engine/schema.ts";

const buildCheck = (
  assertions: ConformancePlanCheck["assertions"]
): ConformancePlanCheck => ({
  assertions,
  checkId: "ck.terminal-event",
  operation: "test.operation",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readSchema = (text: string): boolean | Record<string, unknown> => {
  const schema: unknown = JSON.parse(text);
  if (typeof schema === "boolean" || isRecord(schema)) {
    return schema;
  }
  throw new TypeError("test schema must be an object or boolean");
};

describe("terminalEvent default path", () => {
  test("eventType match passes against the terminal event's type field by default", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ eventType: "end", kind: "terminalEvent" }]),
      { events: [{ type: "start" }, { type: "end" }] }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("eventType mismatch against the terminal event's type field fails", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ eventType: "end", kind: "terminalEvent" }]),
      { events: [{ type: "start" }, { type: "delta" }] }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("eventType match still works when path is explicitly $.type", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ eventType: "end", kind: "terminalEvent", path: "$.type" }]),
      { events: [{ type: "end" }] }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("equals on terminal event with no eventType still defaults path to whole event", () => {
    // Without eventType, path defaults to "$" so the comparison reads the
    // entire terminal event — preserves the pre-existing semantics for plans
    // that compose terminalEvent with equalsPath.
    const terminalEvent = { details: { ok: true }, type: "end" };
    const [evaluation] = evaluateAssertions(
      buildCheck([{ equals: terminalEvent, kind: "terminalEvent" }]),
      { events: [terminalEvent] }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("returns false when there is no terminal event", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ eventType: "end", kind: "terminalEvent" }]),
      { events: [] }
    );
    expect(evaluation?.status).toBe("fail");
  });
});

describe("noEvent event assertions", () => {
  test("passes when the observed event sequence omits the event type", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ eventType: "error", kind: "noEvent" }]),
      { events: [{ type: "turn.start" }, { type: "turn.end" }] }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("fails when the observed event sequence contains the event type", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ eventType: "error", kind: "noEvent" }]),
      {
        events: [
          { type: "turn.start" },
          { type: "error" },
          { type: "turn.end" },
        ],
      }
    );
    expect(evaluation?.status).toBe("fail");
  });
});

describe("resultField assertions", () => {
  test("passes when the configured result field matches the expected value", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ equals: "ready", field: "$.answer", kind: "resultField" }]),
      { result: { answer: "ready" } }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("fails when the configured result field does not match the expected value", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ equals: "ready", field: "$.answer", kind: "resultField" }]),
      { result: { answer: "wait" } }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("fails when the configured result field is missing from the result", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ equals: "ready", field: "$.answer", kind: "resultField" }]),
      { evidence: { answer: "ready" } }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("required evidence only passes from the result surface", () => {
    const compiledCheck: CompiledConformancePlanCheck = {
      check: buildCheck([
        { equals: "ready", field: "$.answer", kind: "resultField" },
      ]),
      requiredEvidence: ["result.answer"],
    };

    const mirroredSurfaces = {
      evidence: { answer: "ready" },
      state: { answer: "ready" },
    };

    expect(
      evaluateRequiredEvidence(compiledCheck, mirroredSurfaces)[0]?.status
    ).toBe("fail");
    expect(
      evaluateRequiredEvidence(compiledCheck, {
        ...mirroredSurfaces,
        result: { answer: "ready" },
      })[0]?.status
    ).toBe("pass");
  });
});

describe("secretAbsence assertion (KRT-BD004)", () => {
  const SECRET = "tuvren-secretiso-mcp-bearer-3a1c5e7b9d2f4a6c";

  test("passes when the result surface is free of the configured secrets", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([
        {
          field: "$.surface",
          kind: "secretAbsence",
          secretsPath: "$.fixture.secretValues",
        },
      ]),
      {
        fixture: { secretValues: [SECRET] },
        result: { surface: { events: [{ type: "tool.start" }] } },
      }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("fails when a configured secret leaks into the surface", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([
        {
          field: "$.surface",
          kind: "secretAbsence",
          secretsPath: "$.fixture.secretValues",
        },
      ]),
      {
        fixture: { secretValues: [SECRET] },
        result: { surface: { records: [{ auth: `Bearer ${SECRET}` }] } },
      }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("fails when the declared surface is missing from the result", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([
        {
          field: "$.missing",
          kind: "secretAbsence",
          secretsPath: "$.fixture.secretValues",
        },
      ]),
      { fixture: { secretValues: [SECRET] }, result: {} }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("fails loud when the declared surface is explicitly null", () => {
    // A null surface must not pass vacuously: absence cannot be proven on a
    // surface that was never scanned, so an explicit null fails like a missing
    // surface rather than silently reporting "secret-free".
    const [evaluation] = evaluateAssertions(
      buildCheck([
        {
          field: "$.surface",
          kind: "secretAbsence",
          secretsPath: "$.fixture.secretValues",
        },
      ]),
      { fixture: { secretValues: [SECRET] }, result: { surface: null } }
    );
    expect(evaluation?.status).toBe("fail");
  });
});

describe("secretPatternAbsence assertion (KRT-BK004)", () => {
  const JWT_SHAPED =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhc3NlcnRpb24tZW5naW5lLXRlc3QifQ.QVzX9k3f7c9a1e2b4d6f8a0c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b";

  test("passes when the result surface carries no pattern-shaped secret residue", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ field: "$.surface", kind: "secretPatternAbsence" }]),
      { result: { surface: { events: [{ type: "tool.start" }] } } }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("fails when a pattern-shaped secret (not equal to any configured value) leaks into the surface", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ field: "$.surface", kind: "secretPatternAbsence" }]),
      { result: { surface: { records: [{ auth: JWT_SHAPED }] } } }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("fails when the declared surface is missing from the result", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ field: "$.missing", kind: "secretPatternAbsence" }]),
      { result: {} }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("fails loud when the declared surface is explicitly null", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ field: "$.surface", kind: "secretPatternAbsence" }]),
      { result: { surface: null } }
    );
    expect(evaluation?.status).toBe("fail");
  });

  test("does not require a secretsPath, unlike secretAbsence", () => {
    const check = buildCheck([
      { field: "$.surface", kind: "secretPatternAbsence" },
    ]);
    expect(check.assertions[0]?.secretsPath).toBeUndefined();
    const [evaluation] = evaluateAssertions(check, {
      result: { surface: { ok: true } },
    });
    expect(evaluation?.status).toBe("pass");
  });
});

describe("schemaValid validator memoization (KRT-BM004)", () => {
  test("retains synchronous schema grading", () => {
    const check = buildCheck([
      { kind: "schemaValid", schema: "$.fixture.schema" },
    ]);
    const fixture = { schema: { type: "number" } };

    expect(evaluateAssertions(check, { fixture, result: 1 })[0]?.status).toBe(
      "pass"
    );
    expect(
      evaluateAssertions(check, { fixture, result: "invalid" })[0]?.status
    ).toBe("fail");
  });

  test("rejects asynchronous schemas before grading valid or invalid data", () => {
    // schemaValid remains synchronous, so async Ajv validators cannot be graded.
    const check = buildCheck([
      { kind: "schemaValid", schema: "$.fixture.schema" },
    ]);
    const schema = { $async: true, type: "number" };

    for (const result of [1, "invalid"]) {
      const [evaluation] = evaluateAssertions(check, {
        fixture: { schema },
        result,
      });
      expect(evaluation?.status).toBe("fail");
      expect(evaluation?.message).toBe(
        "schemaValid assertion does not support asynchronous schemas"
      );
    }

    expect(() => getCompiledSchemaValidator(schema)).toThrow(
      "schemaValid assertion does not support asynchronous schemas"
    );
  });

  test.each([
    "true",
    "false",
    '{"$defs":{"number":{"type":"number"}},"anyOf":[{"$ref":"#/$defs/number"},{"type":"null"}]}',
    '{"type":"array","prefixItems":[{"type":"string"}],"items":false}',
    '{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false,"customAnnotation":{"nested":true}}',
  ])("retains Ajv validation for schema %s", (text) => {
    const schema = readSchema(text);
    const cached = getCompiledSchemaValidator(schema);
    const fresh = new Ajv2020({ allErrors: true, strict: false }).compile(
      schema
    );
    for (const value of [
      null,
      1,
      "text",
      ["text"],
      [1],
      { value: "text" },
      { value: 1 },
    ]) {
      expect(cached(value)).toBe(fresh(value));
      expect(cached.errors).toEqual(fresh.errors);
    }
  });

  test.each([
    { schema: null },
    { schema: [] },
    { schema: 1 },
    { schema: "schema" },
  ])("rejects non-schema fixture %j", ({ schema }) => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ kind: "schemaValid", schema: "$.fixture.schema" }]),
      { fixture: { schema }, result: {} }
    );
    expect(evaluation?.status).toBe("fail");
    expect(evaluation?.message).toBe(
      "$.fixture.schema must contain a JSON Schema object or boolean"
    );
  });

  test("leaves malformed schema keywords to Ajv", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([{ kind: "schemaValid", schema: "$.fixture.schema" }]),
      { fixture: { schema: { type: 1 } }, result: {} }
    );
    expect(evaluation?.status).toBe("fail");
    expect(evaluation?.message).toContain("schema is invalid:");
  });

  test("the same schema content compiles once regardless of key order", () => {
    const first = getCompiledSchemaValidator(
      readSchema('{"type":"object","properties":{"a":{"type":"number"}}}')
    );
    const second = getCompiledSchemaValidator(
      readSchema('{"properties":{"a":{"type":"number"}},"type":"object"}')
    );

    expect(second).toBe(first);
    expect(first({ a: 1 })).toBe(true);
    expect(first({ a: "not a number" })).toBe(false);
  });

  test("distinct schemas get distinct validators", () => {
    const permissive = getCompiledSchemaValidator(
      readSchema('{"type":"object"}')
    );
    const strict = getCompiledSchemaValidator(
      readSchema('{"type":"object","additionalProperties":false}')
    );

    expect(strict).not.toBe(permissive);
    expect(permissive({ extra: true })).toBe(true);
    expect(strict({ extra: true })).toBe(false);
  });

  test('schemas differing only in a literal "__proto__" property never collide', () => {
    // JSON.parse creates an OWN "__proto__" property; a naive sorted-key
    // rebuild through a plain object would drop it via the inherited setter
    // and collapse these two schemas onto one cache entry. The invariant is
    // that each schema gets its own validator whose verdicts match a fresh,
    // uncached compile of that exact schema — whatever Ajv's own semantics
    // for "__proto__"-named properties happen to be.
    const withProtoSchema = readSchema(
      '{"type":"object","properties":{"__proto__":{"type":"number"}},"additionalProperties":false}'
    );
    const withoutProtoSchema = readSchema(
      '{"type":"object","properties":{},"additionalProperties":false}'
    );

    const withProtoProperty = getCompiledSchemaValidator(withProtoSchema);
    const withoutProtoProperty = getCompiledSchemaValidator(withoutProtoSchema);

    expect(withProtoProperty).not.toBe(withoutProtoProperty);

    const freshWithProto = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(withProtoSchema);
    const freshWithoutProto = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(withoutProtoSchema);

    for (const value of [
      JSON.parse('{"__proto__":1}'),
      JSON.parse('{"__proto__":"not a number"}'),
      JSON.parse("{}"),
    ]) {
      expect(withProtoProperty(value)).toBe(freshWithProto(value));
      expect(withoutProtoProperty(value)).toBe(freshWithoutProto(value));
    }
  });
});

describe("assertion sources and failure ordering", () => {
  test("field assertions read only their declared source", () => {
    const assertions: ConformancePlanCheck["assertions"] = [
      { equals: "state", field: "$.answer", kind: "stateField" },
      { equals: "evidence", field: "$.answer", kind: "evidenceField" },
      { equals: "result", field: "$.answer", kind: "resultField" },
    ];
    const context = {
      evidence: { answer: "evidence" },
      result: { answer: "result" },
      state: { answer: "state" },
    };

    expect(
      evaluateAssertions(buildCheck(assertions), context).map(
        (evaluation) => evaluation.status
      )
    ).toEqual(["pass", "pass", "pass"]);
    expect(
      evaluateAssertions(buildCheck(assertions), {
        evidence: context.state,
        result: context.evidence,
        state: context.result,
      }).map((evaluation) => evaluation.status)
    ).toEqual(["fail", "fail", "fail"]);
  });

  test("failing evidence cannot be satisfied by passing state or result", () => {
    expect(
      evaluateAssertions(
        buildCheck([
          { equals: "pass", field: "$.status", kind: "evidenceField" },
        ]),
        {
          evidence: { status: "fail" },
          result: { status: "pass" },
          state: { status: "pass" },
        }
      )
    ).toEqual([
      { assertionId: "ck.terminal-event.1.evidenceField", status: "fail" },
    ]);
  });

  test("required evidence retains declared order and missing-path failures", () => {
    expect(
      evaluateRequiredEvidence(
        {
          check: buildCheck([]),
          requiredEvidence: ["result.missing", "evidence.status", "absent"],
        },
        { evidence: { status: "fail" }, result: {} }
      )
    ).toEqual([
      {
        assertionId: "ck.terminal-event.requiredEvidence.result.missing",
        message: "missing required evidence result.missing",
        status: "fail",
      },
      {
        assertionId: "ck.terminal-event.requiredEvidence.evidence.status",
        status: "pass",
      },
      {
        assertionId: "ck.terminal-event.requiredEvidence.absent",
        message: "missing required evidence absent",
        status: "fail",
      },
    ]);
  });

  test("assertion failures retain their order and do not stop later evaluations", () => {
    expect(
      evaluateAssertions(
        buildCheck([
          { field: "$.answer", kind: "resultField" },
          { kind: "noEvent" },
          { eventType: "end", kind: "terminalEvent" },
        ]),
        { events: [{ type: "end" }] }
      )
    ).toEqual([
      {
        assertionId: "ck.terminal-event.1.resultField",
        message:
          "assertion declares no operator; presence-only assertions must use present",
        status: "fail",
      },
      {
        assertionId: "ck.terminal-event.2.noEvent",
        message: "noEvent assertion requires eventType",
        status: "fail",
      },
      { assertionId: "ck.terminal-event.3.terminalEvent", status: "pass" },
    ]);
  });
});

const diagnoseOne = (
  assertion: ConformancePlanCheck["assertions"][number],
  context: Parameters<typeof diagnoseAssertions>[1]
) => {
  const [diagnosis] = diagnoseAssertions(buildCheck([assertion]), context);
  if (diagnosis === undefined) {
    throw new Error("expected one diagnosis");
  }
  expect(diagnosis.evaluation.status).toBe("fail");
  return diagnosis.operands;
};

describe("quantified assertion operands", () => {
  test("every records the failing element's evaluated operand at its element path", () => {
    const operands = diagnoseOne(
      {
        every: { equalsPath: "$.fixture.expectedId", field: "$.id" },
        field: "$.items",
        kind: "resultField",
        length: 2,
      },
      { fixture: { expectedId: 5 }, result: { items: [{ id: 5 }, { id: 7 }] } }
    );

    expect(operands).toContainEqual({
      actual: 7,
      expected: 5,
      expectedSource: "equalsPath: fixture $.fixture.expectedId",
      path: "$.result.items.1.id",
    });
    expect(operands.map((operand) => operand.path)).not.toContain(
      "$.result.items.0.id"
    );
    expect(
      operands.some((operand) => operand.expectedSource.startsWith("every:"))
    ).toBe(false);
  });

  test("some records every element's operand when no element holds", () => {
    const operands = diagnoseOne(
      {
        field: "$.items",
        kind: "resultField",
        length: 2,
        some: { equals: 9, field: "$.id" },
      },
      { result: { items: [{ id: 5 }, { id: 7 }] } }
    );

    expect(operands).toContainEqual({
      actual: 5,
      expected: 9,
      expectedSource: "equals: plan literal",
      path: "$.result.items.0.id",
    });
    expect(operands).toContainEqual({
      actual: 7,
      expected: 9,
      expectedSource: "equals: plan literal",
      path: "$.result.items.1.id",
    });
  });

  test("some records an unresolved element operand even when another element holds", () => {
    const [diagnosis] = diagnoseAssertions(
      buildCheck([
        {
          field: "$.items",
          kind: "resultField",
          length: 2,
          some: { equals: 1, field: "$.id" },
        },
      ]),
      { result: { items: [{}, { id: 1 }] } }
    );

    expect(diagnosis?.evaluation.status).toBe("fail");
    expect(diagnosis?.unresolved).toBe(true);
    expect(diagnosis?.operands).toContainEqual({
      expected: 1,
      expectedSource: "equals: plan literal",
      path: "$.result.items.0.id",
    });
    expect(diagnosis?.operands.map((operand) => operand.path)).not.toContain(
      "$.result.items.1.id"
    );
  });

  test("nested quantifiers record the innermost failing element path", () => {
    const operands = diagnoseOne(
      {
        every: { every: { equals: "ok" }, field: "$.tags", length: 1 },
        field: "$.items",
        kind: "resultField",
        length: 2,
      },
      { result: { items: [{ tags: ["ok"] }, { tags: ["bad"] }] } }
    );

    expect(operands).toContainEqual({
      actual: "bad",
      expected: "ok",
      expectedSource: "equals: plan literal",
      path: "$.result.items.1.tags.0",
    });
  });

  test("event projections record the failing event's element path", () => {
    const operands = diagnoseOne(
      {
        every: { equals: 1, field: "$.n" },
        kind: "eventSequence",
        length: 2,
        path: "$.payload",
      },
      { events: [{ payload: { n: 1 } }, { payload: { n: 2 } }] }
    );

    expect(operands).toContainEqual({
      actual: 2,
      expected: 1,
      expectedSource: "equals: plan literal",
      path: "$.events.1.payload.n",
    });
  });
});

test("tagged map equality ignores entry order and preserves array value order", () => {
  const assertions: ConformancePlanCheck["assertions"] = [
    {
      kind: "resultField",
      field: "$",
      equals: {
        $map: [
          ["a", [1, 2]],
          [
            "b",
            {
              $map: [
                ["x", 1],
                ["y", 2],
              ],
            },
          ],
        ],
      },
    },
  ];
  const result = {
    $map: [
      [
        "b",
        {
          $map: [
            ["y", 2],
            ["x", 1],
          ],
        },
      ],
      ["a", [1, 2]],
    ],
  };
  expect(
    evaluateAssertions(buildCheck(assertions), { result })[0]?.status
  ).toBe("pass");
  expect(
    evaluateAssertions(buildCheck(assertions), {
      result: {
        $map: [
          [
            "b",
            {
              $map: [
                ["y", 2],
                ["x", 1],
              ],
            },
          ],
          ["a", [2, 1]],
        ],
      },
    })[0]?.status
  ).toBe("fail");
});

test("unprefixed required evidence resolves validated result fields without an adapter mirror", () => {
  const evaluations = evaluateRequiredEvidence(
    { check: buildCheck([]), requiredEvidence: ["status", "result.status"] },
    { result: { status: "observed" } }
  );
  expect(evaluations.map((entry) => entry.status)).toEqual(["pass", "pass"]);
  expect(
    evaluateRequiredEvidence(
      { check: buildCheck([]), requiredEvidence: ["result.status"] },
      { evidence: { status: "observed" } }
    )[0]?.status
  ).toBe("fail");
});
