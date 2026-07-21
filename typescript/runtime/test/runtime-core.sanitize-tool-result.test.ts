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

// biome-ignore-all lint/suspicious/useAwait: Test runners intentionally match the async framework runner contract.

/**
 * Integration tests for the ADR-064 host sanitization seam
 * (`AgentConfig.sanitizeToolResult`).
 *
 * These drive a real in-memory runtime and assert against externally
 * observable, durable state — persisted kernel messages read back via
 * `readBranchMessages` and captured `tool.result` stream events — never
 * against the hook's return value directly. A test that only asserted the
 * hook was invoked would pass against an implementation that applied the
 * hook after staging, which is exactly the bug ADR-064 §4 requires
 * conformance to rule out.
 */

import { describe, expect, test } from "bun:test";
import { TOOL_RESULT_SANITIZATION_FAILED } from "@tuvren/core/errors";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { SanitizeToolResultContext } from "@tuvren/core/execution";
import type { ToolResultPart } from "@tuvren/core/messages";
import type { RunnerExecutionResult, RuntimeRunner } from "@tuvren/core/runner";
import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  extractToolMessages,
  textSignal,
} from "./runtime-core-test-helpers.ts";

const MARKER = "SECRET-token-abc123";
const SCRUBBED = "[redacted]";

/** Builds a one-shot runner requesting the given tool calls, then ending the turn. */
function makeRunner(
  calls: [
    { callId: string; input: unknown; name: string },
    ...Array<{ callId: string; input: unknown; name: string }>,
  ]
): RuntimeRunner {
  return {
    id: "fake",
    execute(context): Promise<RunnerExecutionResult> {
      const hasToolResult = context.messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return Promise.resolve({
          messages: [assistantToolCalls(calls)],
          resolution: { type: "continue_iteration" as const },
          toolExecutionMode: "parallel" as const,
        });
      }
      return Promise.resolve({
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" as const },
      });
    },
  };
}

function toolResultEvents(events: unknown[]): (TuvrenStreamEvent & {
  type: "tool.result";
  callId: string;
  isError?: boolean;
  output?: unknown;
})[] {
  return events.filter(
    (e) => (e as TuvrenStreamEvent).type === "tool.result"
  ) as (TuvrenStreamEvent & {
    type: "tool.result";
    callId: string;
    isError?: boolean;
    output?: unknown;
  })[];
}

async function stagedToolResultParts(
  harness: ReturnType<typeof createFakeKernelHarness>,
  branchId: string
): Promise<ToolResultPart[]> {
  const messages = await harness.readBranchMessages(branchId);
  return extractToolMessages(messages).flatMap(
    (message) => message.parts as ToolResultPart[]
  );
}

describe("host sanitization seam (ADR-064): stageAndEmitResult chokepoint", () => {
  test("the scrubbed form — not the original — lands in durable kernel history", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createBaseRunnerRegistry([
        makeRunner([{ callId: "call-1", input: {}, name: "echo" }]),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        sanitizeToolResult(result) {
          return {
            ...result,
            output: { text: SCRUBBED },
          };
        },
        tools: [
          {
            description: "echo a secret-bearing marker",
            execute: () => Promise.resolve({ text: MARKER }),
            inputSchema: { type: "object" },
            name: "echo",
          },
        ],
      },
      signal: textSignal("run sanitize test"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    await handle.awaitResult();

    const staged = await stagedToolResultParts(harness, thread.branchId);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.output).toEqual({ text: SCRUBBED });
    // The original marker must be nowhere in durable lineage — content-addressed
    // kernel history is immutable, so this is the permanence ADR-064 addresses.
    expect(JSON.stringify(staged)).not.toContain(MARKER);
  });

  test("the scrubbed form is what the canonical tool.result event carries", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createBaseRunnerRegistry([
        makeRunner([{ callId: "call-1", input: {}, name: "echo" }]),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        sanitizeToolResult(result) {
          return { ...result, output: { text: SCRUBBED } };
        },
        tools: [
          {
            description: "echo a secret-bearing marker",
            execute: () => Promise.resolve({ text: MARKER }),
            inputSchema: { type: "object" },
            name: "echo",
          },
        ],
      },
      signal: textSignal("run sanitize test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    await handle.awaitResult();

    const results = toolResultEvents(events);
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ text: SCRUBBED });
    expect(JSON.stringify(results)).not.toContain(MARKER);
  });

  test("ctx carries callId/toolName always, and executionClass only for a bound call — absent for an immediate (unknown-tool) result", async () => {
    const harness = createFakeKernelHarness();
    const recordedContexts: SanitizeToolResultContext[] = [];
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createBaseRunnerRegistry([
        makeRunner([
          { callId: "call-known", input: {}, name: "echo" },
          { callId: "call-unknown", input: {}, name: "does-not-exist" },
        ]),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        sanitizeToolResult(result, ctx) {
          recordedContexts.push(ctx);
          return result;
        },
        tools: [
          {
            description: "echo",
            execute: () => Promise.resolve({ ok: true }),
            inputSchema: { type: "object" },
            name: "echo",
          },
        ],
      },
      signal: textSignal("run ctx test"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());
    await handle.awaitResult();

    expect(recordedContexts).toHaveLength(2);

    const knownCtx = recordedContexts.find((c) => c.callId === "call-known");
    expect(knownCtx).toBeDefined();
    expect(knownCtx?.toolName).toBe("echo");
    expect(knownCtx?.executionClass).toBe("tuvren-server");

    const unknownCtx = recordedContexts.find(
      (c) => c.callId === "call-unknown"
    );
    expect(unknownCtx).toBeDefined();
    expect(unknownCtx?.toolName).toBe("does-not-exist");
    expect(unknownCtx?.executionClass).toBeUndefined();
  });

  test("an error-path result (tool threw) also passes through the hook before staging", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createBaseRunnerRegistry([
        makeRunner([{ callId: "call-1", input: {}, name: "boom" }]),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        sanitizeToolResult(result) {
          if (!result.isError) {
            return result;
          }
          return {
            ...result,
            output: { error: SCRUBBED },
          };
        },
        tools: [
          {
            description: "always throws, message carries the marker",
            execute: () => {
              throw new Error(`request failed: ${MARKER}`);
            },
            inputSchema: { type: "object" },
            name: "boom",
          },
        ],
      },
      signal: textSignal("run error-path sanitize test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    await handle.awaitResult();

    const staged = await stagedToolResultParts(harness, thread.branchId);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.isError).toBe(true);
    expect(staged[0]?.output).toEqual({ error: SCRUBBED });
    expect(JSON.stringify(staged)).not.toContain(MARKER);

    const results = toolResultEvents(events);
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ error: SCRUBBED });
  });

  test("a hook that throws fails only the tool call — isError result with the stable code, and the turn continues", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createBaseRunnerRegistry([
        makeRunner([{ callId: "call-1", input: {}, name: "echo" }]),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        sanitizeToolResult(): never {
          throw new Error("host policy exploded");
        },
        tools: [
          {
            description: "echo",
            execute: () => Promise.resolve({ ok: true }),
            inputSchema: { type: "object" },
            name: "echo",
          },
        ],
      },
      signal: textSignal("run hook-throw test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const result = await handle.awaitResult();

    // The turn itself completes normally — only the individual call failed.
    expect(result.status).toBe("completed");

    const results = toolResultEvents(events);
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    const output = results[0]?.output as
      | { code?: string; error?: string }
      | undefined;
    expect(output?.code).toBe(TOOL_RESULT_SANITIZATION_FAILED);

    const staged = await stagedToolResultParts(harness, thread.branchId);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.isError).toBe(true);
    expect((staged[0]?.output as { code?: string } | undefined)?.code).toBe(
      TOOL_RESULT_SANITIZATION_FAILED
    );
  });

  test("no hook configured: behavior is byte-identical to today (regression guard)", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createBaseRunnerRegistry([
        makeRunner([{ callId: "call-1", input: {}, name: "echo" }]),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "echo a secret-bearing marker",
            execute: () => Promise.resolve({ text: MARKER }),
            inputSchema: { type: "object" },
            name: "echo",
          },
        ],
      },
      signal: textSignal("run no-hook test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    await handle.awaitResult();

    const staged = await stagedToolResultParts(harness, thread.branchId);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.output).toEqual({ text: MARKER });

    const results = toolResultEvents(events);
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ text: MARKER });
  });
});
