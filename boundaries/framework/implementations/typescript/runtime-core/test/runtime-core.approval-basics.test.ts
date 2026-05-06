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
import type { CustomSchema, TuvrenToolDefinition } from "@tuvren/runtime-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntimeCore,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("pauses for mixed approval batches and resumes only unfinished tool calls", async () => {
    const harness = createFakeKernelHarness();
    let afterIterationCount = 0;
    let searchCalls = 0;
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessageCount = context.messages.filter(
          (message) => message.role === "tool"
        ).length;

        if (toolMessageCount === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "latest status" },
                  name: "search",
                },
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
          messages: [
            assistantText(`Handled ${toolMessageCount} tool results.`),
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const tools: TuvrenToolDefinition[] = [
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
      {
        approval: true,
        description: "Send a status email",
        execute(input: unknown) {
          emailCalls += 1;
          return {
            sent: true,
            to: (input as { to: string }).to,
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
    ];
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            afterIteration() {
              afterIterationCount += 1;
              return undefined;
            },
            name: "after-iteration-observer",
          },
        ],
        name: "primary",
        tools,
      },
      signal: textSignal("Need approval"),
      threadId: thread.threadId,
    });

    const pausedEvents = await collectEvents(pausedHandle.events());
    expect(pausedHandle.status().phase).toBe("paused");
    expect(afterIterationCount).toBe(1);
    expect(searchCalls).toBe(1);
    expect(emailCalls).toBe(0);
    expect(pausedHandle.status().approval?.completedResults).toHaveLength(1);
    expect(pausedEvents.map((event) => event.type)).toContain(
      "approval.requested"
    );
    expect(
      pausedEvents.some(
        (event) => event.type === "tool.start" && event.callId === "call-search"
      )
    ).toBe(true);
    expect(
      pausedEvents.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-search"
      )
    ).toBe(true);

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const resumedTurnStartIndex = resumedEvents.findIndex(
      (event) => event.type === "turn.start"
    );
    const approvalResolvedIndex = resumedEvents.findIndex(
      (event) => event.type === "approval.resolved"
    );

    expect(resumedEvents.slice(0, 2).map((event) => event.type)).toEqual([
      "turn.start",
      "approval.resolved",
    ]);
    expect(resumedTurnStartIndex).toBeGreaterThan(-1);
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(true);
    expect(approvalResolvedIndex).toBeGreaterThan(resumedTurnStartIndex);
    expect(
      resumedEvents.some(
        (event) => event.type === "tool.start" && event.callId === "call-email"
      )
    ).toBe(true);
    expect(
      resumedEvents.some(
        (event) => event.type === "tool.result" && event.callId === "call-email"
      )
    ).toBe(true);
    expect(searchCalls).toBe(1);
    expect(emailCalls).toBe(1);
    expect(afterIterationCount).toBe(3);
    expect(messages).toHaveLength(5);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("does not publish resumed turn.start when closing the paused run fails", async () => {
    const harness = createFakeKernelHarness();
    let failPausedRunClose = false;
    const originalComplete = harness.kernel.run.complete;
    harness.kernel.run.complete = async (runId, status, eventHash) => {
      if (failPausedRunClose && status === "failed") {
        failPausedRunClose = false;
        throw new Error("paused run close failed");
      }

      return await originalComplete(runId, status, eventHash);
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
                  input: { subject: "Approval needed", to: "ops@example.com" },
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
          messages: [assistantText("This should not resume.")],
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
            description: "Pause for approval",
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
      signal: textSignal("Pause before failed resume prelude"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    failPausedRunClose = true;

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const errorEvent = resumedEvents.find(
      (
        event
      ): event is Extract<(typeof resumedEvents)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(resumedEvents.some((event) => event.type === "turn.start")).toBe(
      false
    );
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(false);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.message).toBe("paused run close failed");
  });

  test("surfaces normalized approval inputs and executes the same normalized payload after resume", async () => {
    const harness = createFakeKernelHarness();
    const executedInputs: unknown[] = [];
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
                  callId: "call-normalize",
                  input: { raw: true },
                  name: "normalize",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Normalization completed.")],
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
    const normalizedSchema = {
      toJSONSchema() {
        return {
          properties: {
            raw: { type: "boolean" },
          },
          required: ["raw"],
          type: "object",
        };
      },
      validate(input) {
        return {
          valid: true,
          value: {
            normalized: true,
            original: input,
          },
        };
      },
    } satisfies CustomSchema;
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
            description: "Normalize input before approval",
            execute(input) {
              executedInputs.push(input);
              return input;
            },
            inputSchema: normalizedSchema,
            name: "normalize",
          },
        ],
      },
      signal: textSignal("Normalize approval"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    expect(pausedHandle.status().approval?.toolCalls[0]?.input).toEqual({
      normalized: true,
      original: { raw: true },
    });

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-normalize", type: "approve" }],
    });

    await collectEvents(resumedHandle.events());

    expect(executedInputs).toEqual([
      {
        normalized: true,
        original: { raw: true },
      },
    ]);
  });

  test("keeps a valid paused snapshot on the exhausted handle after approval resume", async () => {
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
                  input: { subject: "Resume", to: "ops@example.com" },
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
          messages: [assistantText("Approval resolved once.")],
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
            description: "Send email once",
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
      signal: textSignal("Pause once"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const approval = {
      decisions: [{ callId: "call-email", type: "approve" }],
    };
    const resumedHandle = pausedHandle.resolveApproval(approval);

    expect(pausedHandle.status().phase).toBe("paused");
    expect(pausedHandle.status().pauseReason).toBe("approval_required");
    expect(pausedHandle.status().approval?.toolCalls[0]?.callId).toBe(
      "call-email"
    );
    expect(() => pausedHandle.resolveApproval(approval)).toThrow(
      "resolveApproval() is only valid while execution is paused"
    );

    await collectEvents(resumedHandle.events());
    expect(resumedHandle.status().phase).toBe("completed");
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
