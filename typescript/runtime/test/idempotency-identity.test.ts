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

/**
 * KRT-BG003 — side-effect-once idempotency envelope (ADR-052 as amended by
 * ADR-065).
 *
 * These tests assert the *contract* ADR-052 §1 states — that every dispatch of
 * one logical call presents an identical identity — rather than the weaker
 * property that the helper is a pure function of its arguments. The distinction
 * is what the previous version of this file got wrong: it asserted that a
 * changed fencing token yields a changed key, which is true of the function and
 * irrelevant to the promise, and it left cross-recovery stability untested.
 *
 * The identity is `(turnId, callId)` — the logical call identity. The `runId`
 * and the fencing token are deliberately excluded because neither is stable for
 * one logical call: a Run is one execution attempt (freshly minted per ReAct
 * iteration, per approval resume, and per recovery) and the fencing token
 * rotates on every lease renewal. The fencing token is no longer carried on
 * `ToolBatchEnvironment` at all, so only `runId` variance is representable
 * here; that it cannot influence the key is the property these tests pin.
 *
 * Carriage on the Client Endpoint Boundary dispatch envelope is covered in
 * client-endpoint-boundary.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { ToolCallPart } from "@tuvren/core/messages";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import { deriveIdempotencyKey } from "../src/lib/idempotency-identity.ts";
import type { ToolBatchEnvironment } from "../src/lib/tool-execution.ts";
import { createToolExecutionContext } from "../src/lib/tool-execution-helpers.ts";

function makeToolCall(callId: string): ToolCallPart {
  return { callId, input: {}, name: "side.effect", type: "tool_call" };
}

const TOOL: TuvrenToolDefinition = {
  description: "a side-effecting capability",
  execute: () => Promise.resolve(undefined),
  inputSchema: { type: "object" },
  name: "side.effect",
};

/**
 * Builds a batch environment for one *execution attempt*. `runId` varies per
 * attempt in reality — a fresh Run is minted per ReAct iteration, per approval
 * resume, and per recovery — which is exactly why the identity must not depend
 * on it; `turnId` is the identifier that survives.
 */
function makeEnvironment(turnId: string, runId: string): ToolBatchEnvironment {
  return {
    publishCustom: () => undefined,
    publishEvent: () => undefined,
    runId,
    turnId,
    signal: undefined,
  } as unknown as ToolBatchEnvironment;
}

describe("deriveIdempotencyKey (ADR-052/ADR-065 / KRT-BG003)", () => {
  test("is a deterministic function of the logical call identity", () => {
    expect(deriveIdempotencyKey("turn-1", "call-1")).toBe(
      deriveIdempotencyKey("turn-1", "call-1")
    );
  });

  test("distinct logical calls produce distinct identities", () => {
    const base = deriveIdempotencyKey("turn-1", "call-1");
    expect(deriveIdempotencyKey("turn-2", "call-1")).not.toBe(base);
    expect(deriveIdempotencyKey("turn-1", "call-2")).not.toBe(base);
  });

  test("the canonical encoding is injective across field boundaries", () => {
    // A naive join on ':' would fold ("a:b","c") and ("a","b:c") together.
    expect(deriveIdempotencyKey("a:b", "c")).not.toBe(
      deriveIdempotencyKey("a", "b:c")
    );
  });
});

describe("createToolExecutionContext idempotency identity (KRT-BG003)", () => {
  test("carries the identity derived from turnId and callId", () => {
    const context = createToolExecutionContext(
      makeToolCall("call-alpha"),
      TOOL,
      makeEnvironment("turn-alpha", "run-alpha"),
      undefined
    );

    expect(context.idempotencyKey).toBe(
      deriveIdempotencyKey("turn-alpha", "call-alpha")
    );
  });

  test("is stable across a new Run serving the same Turn", () => {
    // This is ADR-052 §1's actual promise. A Turn is served by many Runs
    // (kernel §5.3): the framework mints a fresh runId per ReAct iteration,
    // per approval resume, and per recovery, and the fencing token rotates on
    // every lease renewal. A re-dispatch of the same logical call therefore
    // arrives with different run and authority identity every time — and must
    // still present the same idempotency key, or an external system cannot
    // deduplicate the effect.
    const firstAttempt = createToolExecutionContext(
      makeToolCall("call-beta"),
      TOOL,
      makeEnvironment("turn-beta", "run-1"),
      undefined
    );
    const reDispatchAfterResume = createToolExecutionContext(
      makeToolCall("call-beta"),
      TOOL,
      makeEnvironment("turn-beta", "run-2"),
      undefined
    );

    expect(reDispatchAfterResume.idempotencyKey).toBe(
      firstAttempt.idempotencyKey
    );
  });

  test("distinguishes two different calls within the same turn", () => {
    const environment = makeEnvironment("turn-delta", "run-delta");
    const first = createToolExecutionContext(
      makeToolCall("call-one"),
      TOOL,
      environment,
      undefined
    );
    const second = createToolExecutionContext(
      makeToolCall("call-two"),
      TOOL,
      environment,
      undefined
    );

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
