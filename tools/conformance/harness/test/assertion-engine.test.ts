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
  evaluateAssertions,
  evaluateRequiredEvidence,
  getCompiledSchemaValidator,
} from "../assertion-engine/index.ts";

function buildCheck(
  assertions: ConformancePlanCheck["assertions"]
): ConformancePlanCheck {
  return {
    assertions,
    checkId: "ck.terminal-event",
    operation: "test.operation",
  };
}

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
  test("the same schema content compiles once regardless of key order", () => {
    const first = getCompiledSchemaValidator(
      JSON.parse('{"type":"object","properties":{"a":{"type":"number"}}}')
    );
    const second = getCompiledSchemaValidator(
      JSON.parse('{"properties":{"a":{"type":"number"}},"type":"object"}')
    );

    expect(second).toBe(first);
    expect(first({ a: 1 })).toBe(true);
    expect(first({ a: "not a number" })).toBe(false);
  });

  test("distinct schemas get distinct validators", () => {
    const permissive = getCompiledSchemaValidator(
      JSON.parse('{"type":"object"}')
    );
    const strict = getCompiledSchemaValidator(
      JSON.parse('{"type":"object","additionalProperties":false}')
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
    const withProtoSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"number"}},"additionalProperties":false}'
    );
    const withoutProtoSchema = JSON.parse(
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
