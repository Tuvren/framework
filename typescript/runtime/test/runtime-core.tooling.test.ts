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
  extractToolMessages,
  readBranchContextManifest,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("gives drivers frozen execution snapshots instead of live framework state", async () => {
    const harness = createFakeKernelHarness();
    let configMutationError: unknown;
    let manifestMutationError: unknown;
    let messageMutationError: unknown;
    let toolMutationError: unknown;
    let registryMutationError: unknown;
    let configToolExecutionError: unknown;
    let observedToolTimeout: number | undefined;
    const driver = {
      async execute(context) {
        try {
          Object.defineProperty(context.config, "name", {
            value: "mutated",
          });
        } catch (error: unknown) {
          configMutationError = error;
        }

        try {
          Object.defineProperty(context.manifest, "messageCount", {
            value: 999,
          });
        } catch (error: unknown) {
          manifestMutationError = error;
        }

        try {
          Array.prototype.push.call(context.messages, assistantText("mutated"));
        } catch (error: unknown) {
          messageMutationError = error;
        }

        try {
          const tool = context.toolRegistry.get("safe");

          if (tool !== undefined) {
            observedToolTimeout = tool.timeout;
            Object.defineProperty(tool, "description", {
              value: "mutated description",
            });
          }
        } catch (error: unknown) {
          toolMutationError = error;
        }

        try {
          const configTool = context.config.tools?.[0];

          if (configTool !== undefined) {
            configTool.execute({}, { callId: "driver-bypass", name: "safe" });
          }
        } catch (error: unknown) {
          configToolExecutionError = error;
        }

        try {
          context.toolRegistry.register({
            description: "rogue",
            execute() {
              return {
                rogue: true,
              };
            },
            inputSchema: {
              type: "object",
            },
            name: "rogue",
          });
        } catch (error: unknown) {
          registryMutationError = error;
        }

        return {
          messages: [
            assistantText(
              `rogue:${String(context.toolRegistry.has("rogue"))};timeout:${String(observedToolTimeout)};configBlocked:${String(configToolExecutionError instanceof Error)}`
            ),
          ],
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
            description: "safe tool",
            execute() {
              return {
                safe: true,
              };
            },
            inputSchema: {
              type: "object",
            },
            name: "safe",
            timeout: 1000,
          },
        ],
      },
      signal: textSignal("Immutable driver context"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(configMutationError).toBeInstanceOf(TypeError);
    expect(manifestMutationError).toBeInstanceOf(TypeError);
    expect(messageMutationError).toBeInstanceOf(TypeError);
    expect(toolMutationError).toBeInstanceOf(TypeError);
    expect(registryMutationError).toBeInstanceOf(Error);
    expect(configToolExecutionError).toBeInstanceOf(Error);
    expect(handle.status().phase).toBe("completed");
    expect(handle.status().activeAgent).toBe("primary");
    expect(manifest.messageCount).toBe(2);
    expect(manifest.lastAssistantMessageIndex).toBe(1);
    expect(messages).toEqual([
      {
        parts: [{ text: "Immutable driver context", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            text: "rogue:false;timeout:1000;configBlocked:true",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("snapshots explicit request tools at executeTurn time", async () => {
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
                  callId: "call-request-tool",
                  input: { query: "snapshot" },
                  name: "request-tool",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Request tool complete.")],
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
    const requestTool = {
      description: "Original request-scoped tool",
      execute() {
        return { status: "original" };
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      metadata: {
        version: "original",
      },
      name: "request-tool",
    };
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
      },
      signal: textSignal("Use the request-scoped tool"),
      threadId: thread.threadId,
      tools: [requestTool],
    });

    requestTool.description = "mutated";
    requestTool.execute = () => ({ status: "mutated" });
    requestTool.metadata = {
      version: "mutated",
    };

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(toolMessages).toEqual([
      {
        parts: [
          {
            callId: "call-request-tool",
            name: "request-tool",
            output: { status: "original" },
            type: "tool_result",
          },
        ],
        role: "tool",
      },
    ]);
  });

  test("rejects non-cloneable stream events before they reach the handle fanout", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            bad() {
              return "not cloneable";
            },
          },
          name: "bad.custom.event",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [assistantText("This should not persist.")],
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
      config: { name: "primary" },
      signal: textSignal("Reject bad custom event"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject bad custom event", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects driver-emitted shared-core lifecycle events", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          callId: "forged-call",
          name: "search",
          output: { forged: true },
          timestamp: context.runtime.now(),
          type: "tool.result",
        });

        return {
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
      config: { name: "primary" },
      signal: textSignal("Reject forged lifecycle event"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) =>
          event.type === "tool.result" && event.callId === "forged-call"
      )
    ).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject forged lifecycle event", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("overrides forged driver event source attribution", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: { ok: true },
          name: "driver.custom",
          source: {
            agent: "forged-agent",
            driver: "forged-driver",
            threadId: "forged-thread",
            workerId: "forged-worker",
          },
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
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
      config: { name: "primary" },
      signal: textSignal("Stamp the real source"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const customEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "driver.custom"
    );

    expect(customEvent?.source).toEqual({
      agent: "primary",
      driver: "fake",
      threadId: thread.threadId,
    });
  });

  test("rejects final tool-call divergence even when aroundModel is active", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-streamed",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          delta: '{"query":"docs"}',
          timestamp: context.runtime.now(),
          type: "tool_call.args_delta",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { query: "docs" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable text")],
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
        extensions: [
          {
            async aroundModel(_context, next) {
              return await next();
            },
            name: "rewriter",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Reject tool-call divergence"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject tool-call divergence", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("allows multiple assistant message sequences when only the final retry response becomes durable", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-attempt-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "First attempt",
          messageId: "assistant-attempt-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-attempt-1",
          text: "First attempt",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-attempt-1",
          timestamp: context.runtime.now(),
          type: "message.done",
        });
        context.runtime.emit({
          messageId: "assistant-attempt-2",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Final attempt",
          messageId: "assistant-attempt-2",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-attempt-2",
          text: "Final attempt",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-attempt-2",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("Final attempt")],
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
      config: { name: "primary" },
      signal: textSignal("Allow retry-shaped assistant streams"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(events.filter((event) => event.type === "message.done").length).toBe(
      2
    );
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Allow retry-shaped assistant streams", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Final attempt", type: "text" }],
        role: "assistant",
      },
    ]);
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
