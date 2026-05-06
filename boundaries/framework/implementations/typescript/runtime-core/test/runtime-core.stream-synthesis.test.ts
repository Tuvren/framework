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
  assistantStructured,
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("synthesizes structured delta events when a driver returns durable structured output without streaming it", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantStructured("result", { answer: "ok" })],
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
      config: { name: "primary" },
      signal: textSignal("Return structured output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const structuredDeltaIndex = events.findIndex(
      (event) =>
        event.type === "structured.delta" && event.delta === '{"answer":"ok"}'
    );
    const structuredDoneIndex = events.findIndex(
      (event) =>
        event.type === "structured.done" &&
        event.name === "result" &&
        toOptionalRecord(event.data)?.answer === "ok"
    );

    expect(structuredDeltaIndex).toBeGreaterThan(-1);
    expect(structuredDoneIndex).toBeGreaterThan(structuredDeltaIndex);
  });

  test("synthesizes structured string deltas as serialized JSON strings", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantStructured("result", "hello")],
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
      config: { name: "primary" },
      signal: textSignal("Return structured string output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(
      events.some(
        (event) =>
          event.type === "structured.delta" && event.delta === '"hello"'
      )
    ).toBe(true);
  });

  test("synthesizes tool-call args deltas when a driver returns durable tool calls without streaming them", async () => {
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
                  callId: "call-search",
                  input: { query: "search term" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText("Done.")],
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
            description: "Search",
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
            name: "search",
          },
        ],
      },
      signal: textSignal("Synthesize tool call deltas"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const argsDeltaIndex = events.findIndex(
      (event) =>
        event.type === "tool_call.args_delta" &&
        event.callId === "call-search" &&
        event.delta === '{"query":"search term"}'
    );
    const toolCallDoneIndex = events.findIndex(
      (event) =>
        event.type === "tool_call.done" && event.callId === "call-search"
    );

    expect(argsDeltaIndex).toBeGreaterThan(-1);
    expect(toolCallDoneIndex).toBeGreaterThan(argsDeltaIndex);
  });

  test("synthesizes string tool-call arg deltas as serialized JSON strings", async () => {
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
                  callId: "call-echo",
                  input: "hello",
                  name: "echo",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText("Done.")],
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
            description: "Echo",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              type: "string",
            },
            name: "echo",
          },
        ],
      },
      signal: textSignal("Synthesize string tool call delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(
      events.some(
        (event) =>
          event.type === "tool_call.args_delta" &&
          event.callId === "call-echo" &&
          event.delta === '"hello"'
      )
    ).toBe(true);
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
