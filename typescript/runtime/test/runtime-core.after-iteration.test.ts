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
import type { TuvrenModelResponse } from "@tuvren/core/provider";
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
  readQueryInput,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("passes synthesized assistant response data into afterIteration hooks", async () => {
    const harness = createFakeKernelHarness();
    let capturedFinishReason: string | undefined;
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Truncated assistant output.")],
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
            afterIteration(context) {
              capturedFinishReason = context.response.finishReason;
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture the full driver response"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedFinishReason).toBe("stop");
  });

  test("marks synthesized partial assistant failures as error responses in afterIteration", async () => {
    const harness = createFakeKernelHarness();
    let capturedFinishReason: string | undefined;
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Interrupted assistant output.")],
          partial: true,
          resolution: {
            error: new Error("execution interrupted"),
            fatality: "hard",
            type: "fail",
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
            afterIteration(context) {
              capturedFinishReason = context.response.finishReason;
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture partial failure response"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(capturedFinishReason).toBe("error");
  });

  test("checkpoints failed partial tool-call messages without executing tools", async () => {
    const harness = createFakeKernelHarness();
    const partialToolCall = assistantToolCalls([
      {
        callId: "call-search",
        input: { query: "interrupted" },
        name: "search",
      },
    ]);
    const driver = {
      async execute(_context) {
        return {
          messages: [partialToolCall],
          partial: true,
          resolution: {
            error: new Error("execution interrupted"),
            fatality: "hard",
            type: "fail",
          },
          toolExecutionMode: "sequential",
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
      signal: textSignal("Cancel during tool call"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).not.toBe("invalid_driver_resolution");
    expect(events.some((event) => event.type === "tool.start")).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel during tool call", type: "text" }],
        role: "user",
      },
      partialToolCall,
    ]);
  });

  test("preserves emitted finish reason, usage, and provider metadata in synthesized afterIteration responses", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse: TuvrenModelResponse | undefined;
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "message-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Visible output",
          messageId: "message-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "message-1",
          text: "Visible output",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "length",
          messageId: "message-1",
          timestamp: context.runtime.now(),
          type: "message.done",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
          },
        });

        return {
          messages: [
            {
              parts: [{ text: "Visible output", type: "text" }],
              providerMetadata: {
                provider: "test-provider",
              },
              role: "assistant",
            },
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
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = context.response;
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture synthesized response metadata"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedResponse).toEqual({
      finishReason: "length",
      parts: [{ text: "Visible output", type: "text" }],
      providerMetadata: {
        provider: "test-provider",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });
  });

  test("rejects driver results with more than one assistant message before afterIteration hooks run", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse:
      | {
          finishReason: string;
          parts: TuvrenModelResponse["parts"];
        }
      | undefined;
    const driver = {
      async execute() {
        return {
          messages: [
            assistantText("First assistant message."),
            {
              parts: [
                {
                  data: { ok: true },
                  name: "summary",
                  type: "structured",
                },
              ],
              role: "assistant",
            },
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
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = {
                finishReason: context.response.finishReason,
                parts: context.response.parts,
              };
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture every assistant message"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(capturedResponse).toEqual({
      finishReason: "error",
      parts: [],
    });
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
  });

  test("clones afterIteration resolution, response, and toolResults per hook invocation", async () => {
    const harness = createFakeKernelHarness();
    const capturedSnapshots: Array<{
      resolutionType: string;
      responsePartName?: string;
      toolOutput: unknown;
    }> = [];
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "clone hook context" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Search complete.")],
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
            afterIteration(context) {
              if (context.resolution.type !== "continue_iteration") {
                return undefined;
              }

              const firstPart = context.response.parts[0];
              const firstToolResult = context.toolResults?.[0];
              capturedSnapshots.push({
                resolutionType: context.resolution.type,
                responsePartName:
                  firstPart?.type === "tool_call" ? firstPart.name : undefined,
                toolOutput: firstToolResult?.output,
              });
              return undefined;
            },
            name: "capture",
          },
          {
            afterIteration(context) {
              const firstToolResult = context.toolResults?.[0];

              if (firstToolResult !== undefined) {
                firstToolResult.output = { mutated: true };
              }

              const firstPart = context.response.parts[0];

              if (firstPart?.type === "tool_call") {
                firstPart.name = "mutated";
              }

              if (context.resolution.type === "continue_iteration") {
                Object.assign(context.resolution, {
                  reason: "mutated",
                  type: "end_turn",
                });
              }
              return undefined;
            },
            name: "mutate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                result: "ok",
              };
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
      signal: textSignal("Clone afterIteration hook context"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedSnapshots).toHaveLength(1);
    expect(capturedSnapshots[0]?.resolutionType).toBe("continue_iteration");
    expect(capturedSnapshots[0]?.toolOutput).toEqual({
      query: "clone hook context",
      result: "ok",
    });
    expect(capturedSnapshots[0]?.responsePartName).toBe("search");
    expect(handle.status().phase).toBe("completed");
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
