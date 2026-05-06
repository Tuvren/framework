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

// biome-ignore-all lint/suspicious/useAwait: Test drivers intentionally match the async framework driver contract.
import { describe, expect, test } from "bun:test";
import type {
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
  RuntimeDriverFactory as KrakenDriverFactory,
} from "@tuvren/driver-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntimeCore,
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
  test("runs tool batches sequentially when the driver selects sequential mode", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
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
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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
    const driver = {
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
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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

function createDriverRegistry(
  drivers: Array<KrakenDriver | KrakenDriverFactory> = []
) {
  return createBaseDriverRegistry(drivers.map(wrapDriverEntry));
}

function wrapDriverEntry(
  entry: KrakenDriver | KrakenDriverFactory
): KrakenDriver | KrakenDriverFactory {
  if (isKrakenDriverFactory(entry)) {
    return {
      create() {
        return wrapDriver(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapDriver(entry);
}

function isKrakenDriverFactory(
  entry: KrakenDriver | KrakenDriverFactory
): entry is KrakenDriverFactory {
  return "create" in entry && typeof entry.create === "function";
}

function wrapDriver(driver: KrakenDriver): KrakenDriver {
  const resume = driver.resume;

  return {
    async execute(context) {
      return normalizeDriverResult(await driver.execute(context));
    },
    id: driver.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeDriverResult(await resume(context));
          },
        }),
  };
}

function normalizeDriverResult(
  result: DriverExecutionResult
): DriverExecutionResult {
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

function requestsToolExecution(result: DriverExecutionResult): boolean {
  return (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );
}
