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
 * KRT-BG003 — side-effect-once idempotency envelope (ADR-0052 as amended by
 * ADR-0065).
 *
 * These tests assert the *contract* ADR-0052 §1 states — that every dispatch of
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
import { createToolExecutionContext } from "../src/lib/tool-execution-helpers.ts";
import type { ToolBatchEnvironment } from "../src/lib/tool-execution.ts";
import { createToolRegistry } from "../src/lib/tool-registry.ts";
import { fromSynchronousVariadicAwaited } from "./runtime-core-test-helpers.ts";

const makeToolCall = (callId: string): ToolCallPart => ({
  callId,
  input: {},
  name: "side.effect",
  type: "tool_call",
});

const TOOL: TuvrenToolDefinition = {
  description: "a side-effecting capability",
  execute() {
    // Identity construction does not execute the tool body.
  },
  inputSchema: { type: "object" },
  name: "side.effect",
};

/**
 * Builds a batch environment for one *execution attempt*. `runId` varies per
 * attempt in reality — a fresh Run is minted per ReAct iteration, per approval
 * resume, and per recovery — which is exactly why the identity must not depend
 * on it; `turnId` is the identifier that survives.
 */
const makeEnvironment = (
  turnId: string,
  runId: string
): ToolBatchEnvironment => ({
  activeAgent: "primary",
  branchId: "branch-idempotency",
  extensions: [],
  iterationCount: 0,
  manifest: {
    byRole: { assistant: 0, system: 0, tool: 0, user: 0 },
    extensions: {},
    lastAssistantMessageIndex: -1,
    lastUserMessageIndex: -1,
    messageCount: 0,
    tokenEstimate: 0,
    toolCalls: { byName: {}, total: 0 },
    toolResults: { byName: {}, total: 0 },
    turnBoundaries: [],
  },
  maxParallelToolCalls: 1,
  now: () => 0,
  publishCustom() {
    // Context construction does not publish custom events.
  },
  publishEvent() {
    // Context construction does not publish stream events.
  },
  reportSoftError() {
    // Context construction does not report soft errors.
  },
  runId,
  stageResult: fromSynchronousVariadicAwaited(() => "0".repeat(64)),
  threadId: "thread-idempotency",
  toolRegistry: createToolRegistry([TOOL]),
  turnId,
});

const makeContext = (
  toolCall: ToolCallPart,
  environment: ToolBatchEnvironment
) =>
  createToolExecutionContext(toolCall, TOOL, environment, environment.signal);

describe("deriveIdempotencyKey (ADR-0052/ADR-0065 / KRT-BG003)", () => {
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
    const context = makeContext(
      makeToolCall("call-alpha"),
      makeEnvironment("turn-alpha", "run-alpha")
    );

    expect(context.idempotencyKey).toBe(
      deriveIdempotencyKey("turn-alpha", "call-alpha")
    );
  });

  test("is stable across a new Run serving the same Turn", () => {
    // This is ADR-0052 §1's actual promise. A Turn is served by many Runs
    // (kernel §5.3): the framework mints a fresh runId per ReAct iteration,
    // per approval resume, and per recovery, and the fencing token rotates on
    // every lease renewal. A re-dispatch of the same logical call therefore
    // arrives with different run and authority identity every time — and must
    // still present the same idempotency key, or an external system cannot
    // deduplicate the effect.
    const firstAttempt = makeContext(
      makeToolCall("call-beta"),
      makeEnvironment("turn-beta", "run-1")
    );
    const reDispatchAfterResume = makeContext(
      makeToolCall("call-beta"),
      makeEnvironment("turn-beta", "run-2")
    );

    expect(reDispatchAfterResume.idempotencyKey).toBe(
      firstAttempt.idempotencyKey
    );
  });

  test("distinguishes two different calls within the same turn", () => {
    const environment = makeEnvironment("turn-delta", "run-delta");
    const first = makeContext(makeToolCall("call-one"), environment);
    const second = makeContext(makeToolCall("call-two"), environment);

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
