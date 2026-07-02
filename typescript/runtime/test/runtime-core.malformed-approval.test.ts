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
  settleWithin,
  TIMEOUT_TOKEN,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("rejects malformed aroundTool approval requests before pause state is published", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid approval" },
                name: "search",
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
            aroundTool(context) {
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
                      decisions: ["approve"],
                      input: context.input,
                      message: "Duplicate call id should be rejected.",
                      name: context.tool.name,
                    },
                  ],
                },
                verdict: "pause",
              };
            },
            name: "broken-approval",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search once",
            execute() {
              return {
                ok: true,
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
      signal: textSignal("Reject invalid approval request"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
  });

  test("does not hang mixed batches when malformed approvals race immediate tool errors", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-missing",
                input: { query: "missing" },
                name: "missing",
              },
              {
                callId: "call-review",
                input: { item: "mixed" },
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
            aroundTool(context) {
              if (context.tool.name !== "review") {
                throw new Error("unexpected tool");
              }

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
                      decisions: ["approve"],
                      input: context.input,
                      message: "broken mixed approval",
                      name: context.tool.name,
                    },
                  ],
                },
                verdict: "pause",
              };
            },
            name: "broken-mixed-approval",
          },
        ],
        name: "primary",
        tools: [
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
      signal: textSignal("Break the mixed approval batch"),
      threadId: thread.threadId,
    });

    const events = await settleWithin(collectEvents(handle.events()), 100);

    expect(events).not.toBe(TIMEOUT_TOKEN);

    if (events === TIMEOUT_TOKEN) {
      throw new Error("expected malformed mixed approval batch to terminate");
    }

    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
  });

  test("aborts cooperative sibling tools without checkpointing malformed initial approval batches", async () => {
    const harness = createFakeKernelHarness();
    let searchSideEffectCount = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "abort me" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "abort me" },
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
                        decisions: ["approve"],
                        input: context.input,
                        message: "broken initial approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-initial-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs slowly",
            async execute(_input, context) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  resolve();
                }, 40);
                context.signal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timer);
                    reject(new Error("search aborted"));
                  },
                  { once: true }
                );
              });
              searchSideEffectCount += 1;
              return {
                ok: true,
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
      signal: textSignal("Continue sibling tools on malformed approval"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    await delay(60);

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(searchSideEffectCount).toBe(0);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("waits for non-cooperative sibling tools to settle before surfacing malformed initial approval failures", async () => {
    const harness = createFakeKernelHarness();
    let slowSideEffectCount = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "slow side effect" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "broken approval" },
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
                        decisions: ["approve"],
                        input: context.input,
                        message: "broken initial approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-initial-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Ignore abort and finish later",
            async execute() {
              await delay(40);
              slowSideEffectCount += 1;
              return {
                ok: true,
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
      signal: textSignal("Wait for the slow sibling"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(slowSideEffectCount).toBe(1);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("does not checkpoint resumed sibling tool progress when resume approval is malformed", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "resume batch" },
                  name: "search",
                },
                {
                  callId: "call-review",
                  input: { item: "resume batch" },
                  name: "review",
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool(context, next) {
              if (
                context.tool.name === "review" &&
                context.approvalDecision?.type === "approve"
              ) {
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
                        message: "broken resume approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-resume-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
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
            approval: true,
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
      signal: textSignal("Break the resumed approval batch"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-search", type: "approve" },
        { callId: "call-review", type: "approve" },
      ],
    });
    const events = await collectEvents(resumedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Break the resumed approval batch", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-search",
            input: { query: "resume batch" },
            name: "search",
            type: "tool_call",
          },
          {
            callId: "call-review",
            input: { item: "resume batch" },
            name: "review",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("aborts cooperative resumed sibling tools without checkpointing malformed approvals", async () => {
    const harness = createFakeKernelHarness();
    let searchSideEffectCount = 0;
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "resume abort" },
                  name: "search",
                },
                {
                  callId: "call-review",
                  input: { item: "resume abort" },
                  name: "review",
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool(context, next) {
              if (
                context.tool.name === "review" &&
                context.approvalDecision?.type === "approve"
              ) {
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
                        message: "broken resume approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-resume-review-abort-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Search docs slowly",
            async execute(_input, context) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  resolve();
                }, 40);
                context.signal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timer);
                    reject(new Error("search aborted"));
                  },
                  { once: true }
                );
              });
              searchSideEffectCount += 1;
              return {
                ok: true,
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
            approval: true,
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
      signal: textSignal(
        "Continue resumed sibling tools on malformed approval"
      ),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-search", type: "approve" },
        { callId: "call-review", type: "approve" },
      ],
    });
    await collectEvents(resumedHandle.events());

    await delay(60);

    expect(resumedHandle.status().phase).toBe("failed");
    expect(searchSideEffectCount).toBe(0);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
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
