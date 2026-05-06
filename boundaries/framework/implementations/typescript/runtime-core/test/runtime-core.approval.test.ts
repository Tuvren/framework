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
  readQueryInput,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects driver-provided pause resolutions that are not rooted in tool approvals", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Pause for external review.")],
          resolution: {
            approval: {
              completedResults: [],
              toolCalls: [
                {
                  callId: "driver-review",
                  decisions: ["approve", "reject"],
                  input: { review: true },
                  message: "Resume after external review.",
                  name: "driver_review",
                },
              ],
            },
            reason: "driver_review_required",
            type: "pause",
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Pause for driver review"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(pausedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(pausedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("fails invalid driver resolutions even when earlier custom events were published live", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            leaked: true,
          },
          name: "ghost.output",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid resolution" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Reject ghost output"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(
      events.some(
        (event) => event.type === "custom" && event.name === "ghost.output"
      )
    ).toBe(true);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject ghost output", type: "text" }],
        role: "user",
      },
    ]);
    expect(
      (await harness.readBranchRuns(thread.branchId)).some(
        (run) =>
          run.status === "failed" &&
          run.stepSequence.some((step) => step.id === "iterate")
      )
    ).toBe(true);
    expect(
      (await harness.readBranchRuns(thread.branchId)).some(
        (run) =>
          run.status === "completed" &&
          run.stepSequence.some((step) => step.id === "iterate")
      )
    ).toBe(false);
  });

  test("finalizes failed runtime status when afterIteration upgrades a renewed approval pause to hard fail", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
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
                  callId: "call-review",
                  input: { item: "proposal" },
                  name: "review",
                },
                {
                  callId: "call-search",
                  input: { query: "follow-up" },
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
          messages: [assistantText("This should not be reached.")],
          resolution: {
            type: "continue_iteration",
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            afterIteration(context) {
              if (
                context.resolution.type !== "pause" ||
                (context.toolResults?.length ?? 0) === 0
              ) {
                return undefined;
              }

              return {
                error: new Error(
                  "afterIteration rejected the renewed approval"
                ),
                verdict: "hardFail",
              };
            },
            name: "pause-hard-fail",
          },
          {
            aroundTool(context, next) {
              if (
                context.tool.name === "review" &&
                context.approvalDecision?.type === "approve"
              ) {
                return {
                  approval: {
                    completedResults: [],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "Need a second approval for review.",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Review a proposal",
            execute() {
              return {
                reviewed: true,
              };
            },
            inputSchema: {
              properties: {
                item: { type: "string" },
              },
              required: ["item"],
              type: "object",
            },
            name: "review",
          },
          {
            approval: true,
            description: "Run a follow-up search",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: readQueryInput(input),
                status: "ok",
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
      signal: textSignal("Resume both tools then hard fail"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-review", type: "approve" },
        { callId: "call-search", type: "approve" },
      ],
    });
    const events = await collectEvents(resumedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const turnEndEvent = events.findLast(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "turn.end" }> =>
        event.type === "turn.end"
    );

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(errorEvent?.error.message).toBe(
      "afterIteration rejected the renewed approval"
    );
    expect(turnEndEvent?.status).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("does not checkpoint sibling tool progress when a parallel batch fails on invalid approval", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "parallel batch" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "proposal" },
                name: "review",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
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
            aroundTool(context, next) {
              if (context.tool.name === "review") {
                return {
                  approval: {
                    completedResults: [
                      {
                        callId: context.callId,
                        name: context.tool.name,
                        output: { duplicate: true },
                        type: "tool_result",
                      },
                    ],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "broken approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs",
            execute(input: unknown) {
              searchCalls += 1;
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
          {
            description: "Review docs",
            execute() {
              return {
                reviewed: true,
              };
            },
            inputSchema: {
              properties: {
                item: { type: "string" },
              },
              required: ["item"],
              type: "object",
            },
            name: "review",
          },
        ],
      },
      signal: textSignal("Break the parallel approval batch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(searchCalls).toBe(1);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Break the parallel approval batch", type: "text" }],
        role: "user",
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
