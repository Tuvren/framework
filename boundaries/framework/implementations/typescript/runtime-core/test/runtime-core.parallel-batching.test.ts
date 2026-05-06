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
  collectToolResultTimeline,
  delay,
  extractToolMessages,
  readQueryInput,
  textSignal,
  toOptionalRecord,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("emits tool.result when each parallel tool finishes instead of after the slowest call", async () => {
    const harness = createFakeKernelHarness();
    const timeline: string[] = [];
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
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
                {
                  callId: "call-slow",
                  input: { query: "slow" },
                  name: "slow",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Tools finished.")],
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
            description: "Finish immediately",
            execute(input: unknown) {
              timeline.push(`fast-complete:${readQueryInput(input)}`);
              return {
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
          {
            description: "Finish after a delay",
            async execute(input: unknown) {
              await delay(20);
              timeline.push(`slow-complete:${readQueryInput(input)}`);
              return {
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
        ],
      },
      signal: textSignal("Run parallel tools"),
      threadId: thread.threadId,
    });

    await collectToolResultTimeline(handle.events(), timeline);

    expect(timeline).toEqual([
      "fast-complete:fast",
      "event:call-fast",
      "slow-complete:slow",
      "event:call-slow",
    ]);
  });

  test("caps parallel tool execution with wave-ordered tool events", async () => {
    const harness = createFakeKernelHarness();
    const activeCalls = new Set<string>();
    let maxActiveCalls = 0;
    const completions: string[] = [];
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
                  callId: "call-a",
                  input: { delay: 20, id: "a" },
                  name: "work",
                },
                {
                  callId: "call-b",
                  input: { delay: 5, id: "b" },
                  name: "work",
                },
                {
                  callId: "call-c",
                  input: { delay: 1, id: "c" },
                  name: "work",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Capped tools finished.")],
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
      defaultMaxParallelToolCalls: 1,
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        maxParallelToolCalls: 2,
        name: "primary",
        tools: [
          {
            description: "Track bounded work",
            async execute(input: unknown) {
              const record = toOptionalRecord(input);

              if (
                record === undefined ||
                typeof record.id !== "string" ||
                typeof record.delay !== "number"
              ) {
                throw new Error("invalid work input");
              }

              activeCalls.add(record.id);
              maxActiveCalls = Math.max(maxActiveCalls, activeCalls.size);
              await delay(record.delay);
              activeCalls.delete(record.id);
              completions.push(record.id);
              return {
                id: record.id,
              };
            },
            inputSchema: {
              properties: {
                delay: { type: "number" },
                id: { type: "string" },
              },
              required: ["id", "delay"],
              type: "object",
            },
            name: "work",
          },
        ],
      },
      signal: textSignal("Run capped tools"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const toolTimeline = events
      .filter(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
      .map((event) => `${event.type}:${event.callId}`);

    expect(maxActiveCalls).toBe(2);
    expect(completions).toEqual(["b", "a", "c"]);
    expect(toolTimeline).toEqual([
      "tool.start:call-a",
      "tool.start:call-b",
      "tool.result:call-b",
      "tool.result:call-a",
      "tool.start:call-c",
      "tool.result:call-c",
    ]);
  });

  test("emits all parallel tool.start events before any tool.result when aroundTool preflights are delayed", async () => {
    const harness = createFakeKernelHarness();
    const completedCalls: string[] = [];
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
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
                {
                  callId: "call-delayed",
                  input: { query: "delayed" },
                  name: "delayed",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Tools finished.")],
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
        extensions: [
          {
            async aroundTool(context, next) {
              if (context.callId === "call-delayed") {
                await delay(20);
              }

              const result = await next();
              completedCalls.push(context.callId);
              return result;
            },
            name: "delay-around-tool",
          },
        ],
        name: "primary",
        tools: [
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
          {
            description: "Also complete immediately",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                status: "delayed",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "delayed",
          },
        ],
      },
      signal: textSignal("Delay aroundTool preflights"),
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

    expect(completedCalls).toEqual(["call-fast", "call-delayed"]);
    expect(toolEvents.map((event) => `${event.type}:${event.callId}`)).toEqual([
      "tool.start:call-fast",
      "tool.start:call-delayed",
      "tool.result:call-fast",
      "tool.result:call-delayed",
    ]);
  });

  test("preserves original parallel tool.start order when the first call has the slower preflight", async () => {
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
                  callId: "call-slow-preflight",
                  input: { query: "slow" },
                  name: "slow",
                },
                {
                  callId: "call-fast-preflight",
                  input: { query: "fast" },
                  name: "fast",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Tools finished.")],
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
        extensions: [
          {
            async aroundTool(context, next) {
              if (context.callId === "call-slow-preflight") {
                await delay(20);
              }

              return await next();
            },
            name: "delay-first-preflight",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Slow preflight",
            execute(input: unknown) {
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
            description: "Fast preflight",
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
      signal: textSignal("Keep start order stable"),
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
      "tool.start:call-slow-preflight",
      "tool.start:call-fast-preflight",
      "tool.result:call-fast-preflight",
      "tool.result:call-slow-preflight",
    ]);
  });

  test("incrementally stages completed tool results before slower siblings finish", async () => {
    const harness = createFakeKernelHarness();
    let releaseSlowTool: (() => void) | undefined;
    const slowTool = new Promise<void>((resolve) => {
      releaseSlowTool = resolve;
    });
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
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
                {
                  callId: "call-slow",
                  input: { query: "slow" },
                  name: "slow",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Tools finished.")],
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
            description: "Finish immediately",
            execute() {
              return {
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
          {
            description: "Wait for release",
            async execute() {
              await slowTool;
              return {
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
        ],
      },
      signal: textSignal("Stage partial tool progress"),
      threadId: thread.threadId,
    });

    const eventsPromise = collectEvents(handle.events());

    await waitForAsync(async () => {
      const stagedMessages = await harness.readRunningStagedMessages(
        thread.branchId
      );
      return stagedMessages.some(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "tool"
      );
    });

    const stagedMessages = await harness.readRunningStagedMessages(
      thread.branchId
    );

    expect(extractToolMessages(stagedMessages)).toHaveLength(1);

    releaseSlowTool?.();
    await eventsPromise;
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
