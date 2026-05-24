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
} from "@tuvren/core/driver";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  delay,
  extractToolMessages,
  readQueryInput,
  startEventCapture,
  textSignal,
  waitForAbort,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("stages and emits immediate invalid tool results before slower executable siblings finish", async () => {
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
                  callId: "call-missing",
                  input: { query: "missing" },
                  name: "missing",
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
    const runtime = createTuvrenRuntime({
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
      signal: textSignal("Run mixed immediate and slow tools"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await waitForAsync(async () => {
      const stagedMessages = await harness.readRunningStagedMessages(
        thread.branchId
      );
      return extractToolMessages(stagedMessages).some(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-missing"
      );
    });

    expect(
      capture.events.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-missing"
      )
    ).toBe(true);

    releaseSlowTool?.();
    await capture.done;

    expect(
      capture.events.filter(
        (event) =>
          event.type === "tool.result" && event.callId === "call-missing"
      )
    ).toHaveLength(1);
    expect(
      extractToolMessages(
        await harness.readBranchMessages(thread.branchId)
      ).filter(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-missing"
      )
    ).toHaveLength(1);
  });

  test("passes through direct tool result parts returned by a tool", async () => {
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
                  callId: "call-direct-result",
                  input: { query: "direct" },
                  name: "direct-result",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Tool result accepted.")],
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
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});

    await runtime
      .executeTurn({
        branchId: thread.branchId,
        config: {
          name: "primary",
          tools: [
            {
              description: "Return a complete result part",
              execute() {
                return {
                  callId: "call-direct-result",
                  isError: true,
                  name: "direct-result",
                  output: {
                    error: {
                      code: "mcp_transport_failure",
                      name: "TuvrenProviderError",
                    },
                  },
                  type: "tool_result",
                };
              },
              inputSchema: {
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
                type: "object",
              },
              name: "direct-result",
            },
          ],
        },
        signal: textSignal("Run direct result tool"),
        threadId: thread.threadId,
      })
      .awaitResult();

    const [toolMessage] = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );
    expect(toolMessage?.parts[0]).toEqual({
      callId: "call-direct-result",
      isError: true,
      name: "direct-result",
      output: {
        error: {
          code: "mcp_transport_failure",
          name: "TuvrenProviderError",
        },
      },
      type: "tool_result",
    });
  });

  test("persists tool messages in call order even when parallel completion order differs", async () => {
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
                  input: { query: "slow-first" },
                  name: "slow",
                },
                {
                  callId: "call-fast",
                  input: { query: "fast-second" },
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
          messages: [assistantText("Persisted in call order.")],
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
    const runtime = createTuvrenRuntime({
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
      signal: textSignal("Persist ordered tools"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(
      toolMessages.map((message) =>
        message.parts[0]?.type === "tool_result" ? message.parts[0].callId : ""
      )
    ).toEqual(["call-slow", "call-fast"]);
  });

  test("times out long-running tools into tool_result errors", async () => {
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
                  input: { query: "timeout" },
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
          messages: [assistantText("Timed out tool was handled.")],
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
    const runtime = createTuvrenRuntime({
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
            description: "Time out",
            async execute() {
              await delay(30);
              return {
                status: "late",
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
            timeout: 5,
          },
        ],
      },
      signal: textSignal("Timeout tool"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts[0]).toEqual({
      callId: "call-slow",
      isError: true,
      name: "slow",
      output: {
        error: 'tool "slow" timed out after 5ms',
      },
      type: "tool_result",
    });
  });

  test("aborts timed-out tool contexts and suppresses late tool events", async () => {
    const harness = createFakeKernelHarness();
    let observedAbort = false;
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
                  input: { query: "timeout" },
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
          messages: [assistantText("Timed out tool was handled.")],
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
    const runtime = createTuvrenRuntime({
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
            description: "Time out cooperatively",
            async execute(_input, context) {
              await waitForAbort(context.signal);
              observedAbort = context.signal?.aborted === true;
              context.emit?.({
                data: { late: true },
                name: "late-tool-event",
              });
              return {
                status: "late",
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
            timeout: 5,
          },
        ],
      },
      signal: textSignal("Timeout tool cooperatively"),
      threadId: thread.threadId,
    });

    const capture = startEventCapture(handle.events());
    await capture.done;
    await delay(30);

    expect(observedAbort).toBe(true);
    expect(
      capture.events.some(
        (event) => event.type === "custom" && event.name === "late-tool-event"
      )
    ).toBe(false);
  });

  test("treats thrown CustomSchema validators as tool input validation errors", async () => {
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
                  callId: "call-custom",
                  input: { query: "boom" },
                  name: "custom",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Recovered from validator error.")],
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
    const runtime = createTuvrenRuntime({
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
            description: "Throwing schema",
            execute() {
              return {
                ok: true,
              };
            },
            inputSchema: {
              toJSONSchema() {
                return {
                  properties: {
                    query: { type: "string" },
                  },
                  required: ["query"],
                  type: "object",
                };
              },
              validate() {
                throw new Error("validator exploded");
              },
            },
            name: "custom",
          },
        ],
      },
      signal: textSignal("Throw in validator"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(handle.status().phase).toBe("completed");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts[0]).toEqual({
      callId: "call-custom",
      isError: true,
      name: "custom",
      output: {
        details: {
          error: "validator exploded",
        },
        error: "Tool input failed validation.",
      },
      type: "tool_result",
    });
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
