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
import { EventType } from "@ag-ui/core";
import type { RuntimeDriver } from "@tuvren/driver-api";
import { startAsyncCapture } from "@tuvren/framework-testkit";
import type { TuvrenToolDefinition } from "@tuvren/runtime-api";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { createDriverRegistry, createTuvrenRuntimeCore } from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantStructured,
  assistantText,
  assistantToolCalls,
  collectEvents,
  hasAssistantText,
  textSignal,
  waitFor,
  waitForAbort,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

describe("stream adapter integration", () => {
  test("fans one completed execution stream into canonical, SSE, and AG-UI consumers", async () => {
    const harness = createFakeKernelHarness();
    const driver: RuntimeDriver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            stage: "executed",
          },
          name: "driver.executed",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [assistantText("Hello from stream adapters.")],
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
    };
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Start adapter integration"),
      threadId: thread.threadId,
    });
    const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
      handle.events(),
      3
    );
    const [canonicalEvents, sseFrames, aguiEvents] = await Promise.all([
      collectEvents(canonicalBranch),
      collectEvents(toSseFrames(sseBranch)),
      collectEvents(toAgUiEvents(aguiBranch)),
    ]);

    expect(
      canonicalEvents.some(
        (event) => event.type === "custom" && event.name === "driver.executed"
      )
    ).toBe(true);
    expect(
      sseFrames.some(
        (frame) =>
          frame.event === "turn.start" &&
          JSON.parse(frame.data).threadId === thread.threadId
      )
    ).toBe(true);
    expect(aguiEvents.map((event) => event.type)).toContain(
      EventType.RUN_STARTED
    );
    expect(
      aguiEvents.some(
        (event) =>
          event.type === EventType.CUSTOM && event.name === "driver.executed"
      )
    ).toBe(true);
    expect(
      aguiEvents.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === "tuvren.runtime.message.done"
      )
    ).toBe(true);

    try {
      await collectEvents(handle.events());
      throw new Error("expected the handle stream to remain single-consumer");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect(readStringProperty(error, "code")).toBe(
        "event_stream_already_consumed"
      );
    }
  });

  test("projects paused and resumed approval flows through adapter fanout", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    let searchCalls = 0;
    const driver: RuntimeDriver = {
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
            toolExecutionMode: "parallel",
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
    };
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
            query: readStringProperty(input, "query"),
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
            to: readStringProperty(input, "to"),
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
        name: "primary",
        tools,
      },
      signal: textSignal("Need approval"),
      threadId: thread.threadId,
    });
    const [pausedCanonicalBranch, pausedSseBranch, pausedAguiBranch] =
      teeTuvrenStreamEvents(pausedHandle.events(), 3);
    const [pausedCanonicalEvents, pausedSseFrames, pausedAguiEvents] =
      await Promise.all([
        collectEvents(pausedCanonicalBranch),
        collectEvents(toSseFrames(pausedSseBranch)),
        collectEvents(toAgUiEvents(pausedAguiBranch)),
      ]);

    expect(pausedHandle.status().phase).toBe("paused");
    expect(searchCalls).toBe(1);
    expect(emailCalls).toBe(0);
    expect(
      pausedCanonicalEvents.some((event) => event.type === "approval.requested")
    ).toBe(true);
    expect(
      pausedCanonicalEvents.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-search"
      )
    ).toBe(true);
    expect(
      pausedSseFrames.some((frame) => frame.event === "approval.requested")
    ).toBe(true);
    expect(
      pausedAguiEvents.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === "tuvren.runtime.approval.requested"
      )
    ).toBe(true);
    expect(
      pausedAguiEvents.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === "tuvren.runtime.turn.paused"
      )
    ).toBe(true);

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    const [resumedCanonicalBranch, resumedAguiBranch] = teeTuvrenStreamEvents(
      resumedHandle.events(),
      2
    );
    const [resumedCanonicalEvents, resumedAguiEvents] = await Promise.all([
      collectEvents(resumedCanonicalBranch),
      collectEvents(toAgUiEvents(resumedAguiBranch)),
    ]);

    expect(emailCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("completed");
    expect(
      resumedCanonicalEvents.slice(0, 2).map((event) => event.type)
    ).toEqual(["turn.start", "approval.resolved"]);
    expect(
      resumedCanonicalEvents.some(
        (event) => event.type === "tool.result" && event.callId === "call-email"
      )
    ).toBe(true);
    expect(
      resumedAguiEvents.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === "tuvren.runtime.approval.resolved"
      )
    ).toBe(true);
    expect(
      resumedAguiEvents.some((event) => event.type === EventType.RUN_FINISHED)
    ).toBe(true);
  });

  test("projects structured output turns through SSE and AG-UI fallbacks", async () => {
    const harness = createFakeKernelHarness();
    const driver: RuntimeDriver = {
      async execute() {
        return {
          messages: [assistantStructured("summary", { status: "ready" })],
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
    };
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Emit structured output"),
      threadId: thread.threadId,
    });
    const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
      handle.events(),
      3
    );
    const [canonicalEvents, sseFrames, aguiEvents] = await Promise.all([
      collectEvents(canonicalBranch),
      collectEvents(toSseFrames(sseBranch)),
      collectEvents(toAgUiEvents(aguiBranch)),
    ]);

    expect(
      canonicalEvents.some((event) => event.type === "structured.done")
    ).toBe(true);
    expect(sseFrames.some((frame) => frame.event === "structured.done")).toBe(
      true
    );
    expect(
      aguiEvents.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === "tuvren.runtime.structured.done"
      )
    ).toBe(true);
  });

  test("surfaces steering incorporation through tee branches", async () => {
    const harness = createFakeKernelHarness();
    const driver: RuntimeDriver = {
      async execute(context) {
        const steeringMessage = context.messages.find(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Injected steering"
            )
        );

        if (steeringMessage !== undefined) {
          return {
            messages: [],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        return {
          messages: [assistantText("Waiting for steering.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    };
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Start steering adapter flow"),
      threadId: thread.threadId,
    });
    const [canonicalBranch, aguiBranch] = teeTuvrenStreamEvents(
      handle.events(),
      2
    );
    const canonicalCapture = startAsyncCapture(canonicalBranch);
    const aguiCapture = startAsyncCapture(toAgUiEvents(aguiBranch));

    await waitForAsync(async () =>
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Waiting for steering."
      )
    );

    handle.steer(textSignal("Injected steering"));
    await Promise.all([canonicalCapture.done, aguiCapture.done]);

    expect(
      canonicalCapture.events.some(
        (event) => event.type === "steering.incorporated"
      )
    ).toBe(true);
    expect(
      aguiCapture.events.some(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === "tuvren.runtime.steering.incorporated"
      )
    ).toBe(true);
  });

  test("projects cancelled executions into SSE and AG-UI terminal errors", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver: RuntimeDriver = {
      async execute(context) {
        executeCount += 1;

        if (executeCount === 1) {
          return {
            messages: [assistantText("First pass complete.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        await waitForAbort(context.signal);
        return {
          messages: [assistantText("Interrupted second pass.")],
          partial: true,
          resolution: {
            error: new Error("driver noticed cancellation"),
            fatality: "hard",
            type: "fail",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    };
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Cancel through adapters"),
      threadId: thread.threadId,
    });
    const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
      handle.events(),
      3
    );
    const canonicalCapture = startAsyncCapture(canonicalBranch);
    const sseCapture = startAsyncCapture(toSseFrames(sseBranch));
    const aguiCapture = startAsyncCapture(toAgUiEvents(aguiBranch));

    await waitFor(() => handle.status().phase === "running");
    await waitFor(() => handle.status().iterationCount === 2);

    handle.cancel();
    await Promise.all([
      canonicalCapture.done,
      sseCapture.done,
      aguiCapture.done,
    ]);

    expect(handle.status().phase).toBe("failed");
    expect(
      canonicalCapture.events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "runtime_execution_cancelled"
      )
    ).toBe(true);
    expect(sseCapture.events.some((frame) => frame.event === "error")).toBe(
      true
    );
    expect(
      aguiCapture.events.some((event) => event.type === EventType.RUN_ERROR)
    ).toBe(true);
  });
});

function readStringProperty(value: unknown, propertyName: string): string {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${propertyName} input must be an object`);
  }

  const propertyValue = Reflect.get(value, propertyName);
  if (typeof propertyValue !== "string") {
    throw new Error(`${propertyName} input must be a string`);
  }

  return propertyValue;
}
