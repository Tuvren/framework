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
import { describe, expect, test } from "bun:test";
import type {
  RuntimeRunner as KrakenRunner,
  RuntimeRunnerFactory as KrakenRunnerFactory,
  RunnerExecutionResult,
} from "@tuvren/core/runner";
import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  readQueryInput,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("runs tool batches sequentially when the runner selects sequential mode", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-slow",
                  input: { query: "slow" },
                  name: "slow",
                },
                {
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "sequential",
          };
        }

        return {
          messages: [assistantText("Sequential tools finished.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Complete after a delay",
            async execute(input: unknown) {
              await delay(20);
              return {
                query: readQueryInput(input),
                status: "slow",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "slow",
          },
          {
            description: "Complete immediately",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                status: "fast",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "fast",
          },
        ],
      },
      signal: textSignal("Run sequential tools"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const toolEvents = events.filter(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { callId: string; type: "tool.start" | "tool.result" }
      > => event.type === "tool.start" || event.type === "tool.result"
    );

    expect(toolEvents.map((event) => `${event.type}:${event.callId}`)).toEqual([
      "tool.start:call-slow",
      "tool.result:call-slow",
      "tool.start:call-fast",
      "tool.result:call-fast",
    ]);
  });

  test("stops resolving later sequential tool calls after the first approval gate", async () => {
    const harness = createFakeKernelHarness();
    const approvalChecks: string[] = [];
    const runner = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-first",
                  input: { query: "first" },
                  name: "first",
                },
                {
                  callId: "call-second",
                  input: { query: "second" },
                  name: "second",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "sequential",
          };
        }

        return {
          messages: [assistantText("This should not be reached.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      runnerRegistry: createRunnerRegistry([runner]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval() {
              approvalChecks.push("first");
              return true;
            },
            description: "Pause first",
            execute() {
              return { ok: false };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "first",
          },
          {
            approval() {
              approvalChecks.push("second");
              return false;
            },
            description: "Should not be inspected yet",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "second",
          },
        ],
      },
      signal: textSignal("Pause sequentially at the first approval gate"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const approvalEvent = events.find(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { type: "approval.requested" }
      > => event.type === "approval.requested"
    );

    expect(handle.status().phase).toBe("paused");
    expect(approvalChecks).toEqual(["first"]);
    expect(
      approvalEvent?.request.toolCalls.map((toolCall) => toolCall.callId)
    ).toEqual(["call-first"]);
  });
});

function createRunnerRegistry(
  runners: Array<KrakenRunner | KrakenRunnerFactory> = []
) {
  return createBaseRunnerRegistry(runners.map(wrapRunnerEntry));
}

function wrapRunnerEntry(
  entry: KrakenRunner | KrakenRunnerFactory
): KrakenRunner | KrakenRunnerFactory {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
}

function isKrakenRunnerFactory(
  entry: KrakenRunner | KrakenRunnerFactory
): entry is KrakenRunnerFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapRunner(runner: KrakenRunner): KrakenRunner {
  const resume = runner.resume;

  return {
    async execute(context) {
      return normalizeRunnerResult(await runner.execute(context));
    },
    id: runner.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeRunnerResult(await resume(context));
          },
        }),
  };
}

function normalizeRunnerResult(
  result: RunnerExecutionResult
): RunnerExecutionResult {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
}

function requestsToolExecution(result: RunnerExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
