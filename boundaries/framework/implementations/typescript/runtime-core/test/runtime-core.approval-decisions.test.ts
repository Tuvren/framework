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
import type { TuvrenMessage } from "@tuvren/runtime-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntimeCore,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  extractToolMessages,
  hasAssistantText,
  startEventCapture,
  textSignal,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("continues the same turn after explicit rejected approval decisions without executing the tool", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
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
                  callId: "call-email",
                  input: { subject: "Status update", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Acknowledged rejected tool.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send a status email",
            execute() {
              emailCalls += 1;
              return { sent: true };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Reject this tool"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "reject" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const rejectedToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool"
    );

    expect(emailCalls).toBe(0);
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "tool.result" &&
          event.callId === "call-email" &&
          event.isError === true
      )
    ).toBe(true);
    expect(rejectedToolMessage?.parts[0]?.type).toBe("tool_result");
    if (rejectedToolMessage?.parts[0]?.type === "tool_result") {
      expect(rejectedToolMessage.parts[0].isError).toBe(true);
      expect(JSON.stringify(rejectedToolMessage.parts[0].output)).toContain(
        "rejected"
      );
    }
    expect(hasAssistantText(messages, "Acknowledged rejected tool.")).toBe(
      true
    );
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("preserves approval commentary on invalid edited approval inputs", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
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
                  callId: "call-email",
                  input: { subject: "Status update", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Acknowledged invalid edit.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send a status email",
            execute() {
              emailCalls += 1;
              return { sent: true };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Edit this tool incorrectly"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        {
          callId: "call-email",
          editedInput: { to: "ops@example.com" },
          message: "human note",
          type: "edit",
        },
      ],
    });
    await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const editedToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool"
    );

    expect(emailCalls).toBe(0);
    expect(editedToolMessage?.parts[0]?.type).toBe("tool_result");
    if (editedToolMessage?.parts[0]?.type === "tool_result") {
      expect(editedToolMessage.parts[0].isError).toBe(true);
      expect(editedToolMessage.parts[0].output).toEqual({
        approval: {
          editedInput: { to: "ops@example.com" },
          message: "human note",
          originalInput: {
            subject: "Status update",
            to: "ops@example.com",
          },
          type: "edit",
        },
        details: {
          decisionType: "edit",
          validation: expect.anything(),
        },
        error: "Approved tool input failed validation.",
      });
    }
    expect(hasAssistantText(messages, "Acknowledged invalid edit.")).toBe(true);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("executes edited approvals with the edited input and a durable audit trace", async () => {
    const harness = createFakeKernelHarness();
    const executedInputs: unknown[] = [];
    const originalInput = {
      subject: "Status update",
      to: "ops@example.com",
    };
    const editedInput = {
      subject: "Reviewed status update",
      to: "review@example.com",
    };
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
                  callId: "call-email",
                  input: originalInput,
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Acknowledged edited tool.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send a status email",
            execute(input) {
              executedInputs.push(input);
              return {
                sent: true,
                to:
                  input !== null &&
                  typeof input === "object" &&
                  "to" in input &&
                  typeof input.to === "string"
                    ? input.to
                    : "unknown",
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Edit this tool correctly"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        {
          callId: "call-email",
          editedInput,
          message: "Use the reviewed recipient instead.",
          type: "edit",
        },
      ],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const assistantToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant" &&
        "parts" in message &&
        Array.isArray(message.parts) &&
        message.parts.some(
          (part) =>
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "tool_call"
        )
    );
    const editedToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool"
    );

    expect(executedInputs).toEqual([editedInput]);
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "tool.start" &&
          event.callId === "call-email" &&
          JSON.stringify(event.input) === JSON.stringify(editedInput)
      )
    ).toBe(true);
    expect(assistantToolMessage?.parts[0]?.type).toBe("tool_call");
    if (assistantToolMessage?.parts[0]?.type === "tool_call") {
      expect(assistantToolMessage.parts[0].input).toEqual(originalInput);
    }
    expect(editedToolMessage?.parts[0]?.type).toBe("tool_result");
    if (editedToolMessage?.parts[0]?.type === "tool_result") {
      expect(editedToolMessage.parts[0].output).toEqual({
        approval: {
          editedInput,
          message: "Use the reviewed recipient instead.",
          originalInput,
          type: "edit",
        },
        result: {
          sent: true,
          to: "review@example.com",
        },
      });
    }
    expect(hasAssistantText(messages, "Acknowledged edited tool.")).toBe(true);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("stages and emits immediate resumed decisions before slower approved siblings finish", async () => {
    const harness = createFakeKernelHarness();
    let releaseSlowTool: (() => void) | undefined;
    const slowTool = new Promise<void>((resolve) => {
      releaseSlowTool = resolve;
    });
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-reject",
                  input: { query: "reject" },
                  name: "rejectable",
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
          messages: [assistantText("Resume finished.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Reject immediately on resume",
            execute() {
              return {
                status: "unexpected",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "rejectable",
          },
          {
            approval: true,
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
      signal: textSignal("Pause for resume staging"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-reject", type: "reject" },
        { callId: "call-slow", type: "approve" },
      ],
    });
    const capture = startEventCapture(resumedHandle.events());

    await waitForAsync(async () => {
      const stagedMessages = await harness.readRunningStagedMessages(
        thread.branchId
      );
      return extractToolMessages(stagedMessages).some(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-reject"
      );
    });

    expect(
      capture.events.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-reject"
      )
    ).toBe(true);

    releaseSlowTool?.();
    await capture.done;

    expect(
      capture.events.filter(
        (event) =>
          event.type === "tool.result" && event.callId === "call-reject"
      )
    ).toHaveLength(1);
    expect(
      extractToolMessages(
        await harness.readBranchMessages(thread.branchId)
      ).filter(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-reject"
      )
    ).toHaveLength(1);
  });

  test("resumes aroundTool approval gates through the shared executor", async () => {
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
                  callId: "call-search",
                  input: { query: "gated search" },
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
          messages: [assistantText("Search completed after approval.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool: async (context, next) => {
              if (context.approvalDecision === undefined) {
                return {
                  approval: {
                    completedResults: [],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "Approve the wrapped search?",
                        name: context.tool.name,
                      },
                    ],
                  },
                  state: { gated: true },
                  verdict: "pause",
                };
              }

              return {
                result: await next(),
                state: { approved: true },
              };
            },
            name: "approval-wrapper",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search the latest status",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: (input as { query: string }).query,
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
      signal: textSignal("Gate this search"),
      threadId: thread.threadId,
    });

    const pausedEvents = await collectEvents(pausedHandle.events());
    expect(pausedHandle.status().phase).toBe("paused");
    expect(searchCalls).toBe(0);
    expect(
      pausedHandle
        .status()
        .approval?.toolCalls.map((toolCall) => toolCall.callId)
    ).toEqual(["call-search"]);
    expect(
      pausedEvents.some(
        (event) => event.type === "tool.start" && event.callId === "call-search"
      )
    ).toBe(false);

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-search", type: "approve" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const manifest = resumedHandle.status().manifest;

    expect(searchCalls).toBe(1);
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-search"
      )
    ).toBe(true);
    expect(
      manifest?.extensions["approval-wrapper"] as Record<string, unknown>
    ).toEqual({
      approved: true,
      gated: true,
    });
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("status() returns deep-cloned manifest and approval snapshots", async () => {
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
                  callId: "call-email",
                  input: { subject: "Hello", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Email sent.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            name: "stateful",
            state: {
              seeded: true,
            },
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send email",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause and clone"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const firstStatus = pausedHandle.status();

    if (
      firstStatus.approval === undefined ||
      firstStatus.manifest === undefined
    ) {
      throw new Error("expected paused approval state");
    }

    firstStatus.approval.toolCalls[0].callId = "mutated";
    firstStatus.manifest.extensions.stateful = {
      seeded: false,
    };
    firstStatus.manifest.byRole.user = 999;

    const secondStatus = pausedHandle.status();

    expect(secondStatus.approval?.toolCalls[0]?.callId).toBe("call-email");
    expect(secondStatus.manifest?.extensions.stateful).toEqual({
      seeded: true,
    });
    expect(secondStatus.manifest?.byRole.user).toBe(1);
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
