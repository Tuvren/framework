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
import type { ConformancePlanCheck } from "../../plan-compiler/index.ts";
import { evaluateAssertions } from "../assertion-engine/index.ts";

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

describe("noEvent evidence field", () => {
  test("passes when the configured evidence array omits the event type", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([
        { eventType: "error", field: "$.frameEvents", kind: "noEvent" },
      ]),
      { evidence: { frameEvents: ["turn.start", "turn.end"] } }
    );
    expect(evaluation?.status).toBe("pass");
  });

  test("fails when the configured evidence array contains the event type", () => {
    const [evaluation] = evaluateAssertions(
      buildCheck([
        { eventType: "error", field: "$.frameEvents", kind: "noEvent" },
      ]),
      { evidence: { frameEvents: ["turn.start", "error", "turn.end"] } }
    );
    expect(evaluation?.status).toBe("fail");
  });
});
