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
  extractToolMessages,
  hasAssistantText,
  readBranchContextManifest,
  textSignal,
  waitFor,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("fails the resumed turn instead of rewriting approval into rejection when the fresh resumed handle is canceled before start", async () => {
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
                  input: { subject: "Cancel", to: "ops@example.com" },
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
            description: "Pause for cancellation",
            execute() {
              emailCalls += 1;
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
      signal: textSignal("Pause then cancel"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    pausedHandle.cancel();

    expect(pausedHandle.status().phase).toBe("paused");
    expect(pausedHandle.status().pauseReason).toBe("approval_required");
    expect(pausedHandle.status().approval?.toolCalls[0]?.callId).toBe(
      "call-email"
    );

    await waitForAsync(async () => {
      const runtimeStatus = await harness.readBranchRuntimeStatus(
        thread.branchId
      );

      return (
        runtimeStatus !== null &&
        typeof runtimeStatus === "object" &&
        "state" in runtimeStatus &&
        runtimeStatus.state === "completed"
      );
    });

    const messages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(emailCalls).toBe(0);
    expect(pausedHandle.status().phase).toBe("completed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "completed",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]?.type).toBe("tool_result");
    if (messages[0]?.parts[0]?.type === "tool_result") {
      expect(messages[0].parts[0].isError).toBe(true);
      expect(JSON.stringify(messages[0].parts[0].output)).toContain("rejected");
    }
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "This should not resume."
      )
    ).toBe(false);
  });

  test("preserves carried afterIteration state updates when a paused approval is canceled", async () => {
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
                  input: { subject: "Cancel", to: "ops@example.com" },
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
        extensions: [
          {
            afterIteration(context) {
              if (context.resolution.type !== "pause") {
                return undefined;
              }

              return {
                state: {
                  preservedAcrossCancel: true,
                },
              };
            },
            name: "approval-state",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Pause for cancellation",
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
      signal: textSignal("Pause then cancel with carried state"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    pausedHandle.cancel();

    await waitForAsync(async () => {
      const runtimeStatus = await harness.readBranchRuntimeStatus(
        thread.branchId
      );

      return (
        runtimeStatus !== null &&
        typeof runtimeStatus === "object" &&
        "state" in runtimeStatus &&
        runtimeStatus.state === "completed"
      );
    });

    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(manifest.extensions["approval-state"]).toEqual({
      preservedAcrossCancel: true,
    });
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "This should not resume."
      )
    ).toBe(false);
  });

  test("keeps the old paused handle inert after resolveApproval returns a fresh handle", async () => {
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Pause for cancellation",
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
      signal: textSignal("Pause then cancel after approval"),
      threadId: thread.threadId,
    });
    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    expect(() => pausedHandle.cancel()).toThrow(
      "cancel() is not valid once approval has been resolved"
    );
    const resumedEvents = await collectEvents(resumedHandle.events());

    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "completed",
    });
    expect(pausedHandle.status().phase).toBe("paused");
    expect(resumedHandle.status().phase).toBe("completed");
    expect(resumedEvents.some((event) => event.type === "turn.end")).toBe(true);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "This should not be reached."
      )
    ).toBe(true);
  });

  test("does not revive a cancelled resumed handle when events start later", async () => {
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
              emailCalls += 1;
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
      signal: textSignal("Pause, approve, then cancel before start"),
      threadId: thread.threadId,
    });
    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    resumedHandle.cancel();

    const resumedEvents = await collectEvents(resumedHandle.events());
    const errorEvent = resumedEvents.find(
      (
        event
      ): event is Extract<(typeof resumedEvents)[number], { type: "error" }> =>
        event.type === "error"
    );
    const turnEndEvent = resumedEvents.findLast(
      (
        event
      ): event is Extract<
        (typeof resumedEvents)[number],
        { type: "turn.end" }
      > => event.type === "turn.end"
    );
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(emailCalls).toBe(0);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(true);
    expect(errorEvent?.fatal).toBe(true);
    expect(turnEndEvent?.status).toBe("failed");
    expect(extractToolMessages(messages)).toEqual([]);
    expect(messages).toEqual([
      {
        parts: [
          { text: "Pause, approve, then cancel before start", type: "text" },
        ],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-email",
            input: { subject: "Approval needed", to: "ops@example.com" },
            name: "email",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
    expect(hasAssistantText(messages, "This should not resume.")).toBe(false);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("canceling a resumed handle before stream consumption still closes the paused run", async () => {
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
              emailCalls += 1;
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
      signal: textSignal("Pause, approve, then cancel lazily"),
      threadId: thread.threadId,
    });
    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    resumedHandle.cancel();

    await waitForAsync(async () => {
      const runtimeStatus = await harness.readBranchRuntimeStatus(
        thread.branchId
      );

      return (
        runtimeStatus !== null &&
        typeof runtimeStatus === "object" &&
        "state" in runtimeStatus &&
        runtimeStatus.state === "failed"
      );
    });

    expect(emailCalls).toBe(0);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Pause, approve, then cancel lazily", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-email",
            input: { subject: "Approval needed", to: "ops@example.com" },
            name: "email",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("preserves queued steering across approval resume", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );
        const steeringSeen = context.messages.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "Late steering"
            )
        );

        if (toolMessages.length === 0) {
          await delay(20);
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
          messages: [
            assistantText(
              steeringSeen ? "Saw transferred steering." : "Missed steering."
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
            approval: true,
            description: "Pause for steering transfer",
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
      signal: textSignal("Pause after queued steering"),
      threadId: thread.threadId,
    });
    const pausedEventsPromise = collectEvents(handle.events());

    await delay(0);
    handle.steer(textSignal("Late steering"));
    await waitFor(() => handle.status().phase === "paused");

    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    await collectEvents(resumedHandle.events());

    await pausedEventsPromise;

    expect(await harness.readBranchMessages(thread.branchId)).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "Late steering", type: "text" }],
          role: "user",
        },
      ])
    );
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Saw transferred steering."
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
