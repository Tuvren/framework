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
import type { AgentConfig, TuvrenRuntime } from "@tuvren/runtime-api";
import {
  createOrchestrationRuntime,
  createTuvrenRuntimeCore,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  createDriverRegistry,
  createStaticDriver,
} from "./orchestration-runtime-driver-helpers.ts";
import {
  assistantText,
  collectEvents,
  createStaticExecutionHandle,
  createStubExecutionHandle,
  delay,
  detachTestPromise,
  startEventCapture,
  textSignal,
  toKrakenMessages,
  waitFor,
} from "./runtime-core-test-helpers.ts";

describe("orchestration-runtime", () => {
  test("supports recursive child spawning", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await delay(20);
            return {
              messages: [assistantText("Child complete.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          if (context.config.name === "worker-2") {
            return {
              messages: [assistantText("Grandchild complete.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await delay(20);
          return {
            messages: [assistantText("Root complete.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
        "worker-2": { name: "worker-2" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });
    const allEventsPromise = collectEvents(handle.allEvents());

    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    const childEventsPromise = collectEvents(childHandle.allEvents());
    await delay(0);
    const grandchildHandle = childHandle.spawn({
      agent: "worker-2",
      signal: textSignal("grandchild"),
    });
    const grandchildResult = await grandchildHandle.awaitResult();
    const [allEvents, childEvents] = await Promise.all([
      allEventsPromise,
      childEventsPromise,
    ]);

    expect(grandchildResult.status).toBe("completed");
    if (grandchildResult.status !== "completed") {
      throw new Error("unreachable");
    }
    expect(grandchildResult.finalAssistantMessage).toEqual({
      parts: [{ text: "Grandchild complete.", type: "text" }],
      providerMetadata: undefined,
      role: "assistant",
    });
    expect(
      new Set(
        allEvents
          .map((event) => event.source?.workerId)
          .filter((workerId): workerId is string => workerId !== undefined)
      ).size
    ).toBeGreaterThanOrEqual(2);
    expect(
      childEvents.some(
        (event) =>
          event.type === "text.done" && event.text === "Grandchild complete."
      )
    ).toBe(true);
  });

  test("resolves awaitResult with status=failed when child execution fails", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            throw new Error("worker exploded");
          }

          await delay(20);
          return {
            messages: [assistantText("Parent finished.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });

    detachTestPromise(collectEvents(handle.allEvents()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("failure"),
    });

    const childResult = await childHandle.awaitResult();
    expect(childResult.status).toBe("failed");
    if (childResult.status !== "failed") {
      throw new Error("unreachable");
    }
    expect(childResult.error.message).toBe("worker exploded");
  });

  test("inherits the caller driverId and explicit tools when spawning a child", async () => {
    const harness = createFakeKernelHarness();
    const defaultDriver = createStaticDriver(async (context) => {
      if (context.config.name === "worker") {
        return {
          messages: [assistantText("Default worker driver.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      }

      await delay(20);
      return {
        messages: [assistantText("Default parent driver.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      };
    }, "default");
    const specialDriver = createStaticDriver(async (context) => {
      if (context.config.name === "worker") {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              {
                parts: [
                  {
                    callId: "call-research",
                    input: { query: "inherit" },
                    name: "research",
                    type: "tool_call",
                  },
                ],
                role: "assistant",
              },
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      }

      await delay(20);
      return {
        messages: [assistantText("Special parent driver.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      };
    }, "special");
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "default",
      driverRegistry: createDriverRegistry([defaultDriver, specialDriver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      driverId: "special",
      signal: textSignal("Start root"),
      threadId: thread.threadId,
      tools: [
        {
          description: "Inherited research tool",
          execute() {
            return { status: "inherited" };
          },
          inputSchema: {
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            type: "object",
          },
          name: "research",
        },
      ],
    });

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("research"),
    });
    const childEvents = await collectEvents(childHandle.events());
    const childResult = await childHandle.awaitResult();

    expect(
      childEvents.some(
        (event) =>
          event.type === "tool.result" &&
          event.source?.driver === "special" &&
          event.name === "research"
      )
    ).toBe(true);
    expect(childResult.status).toBe("completed");
  });

  test("inherits an explicit parent execution schema when spawning a child", async () => {
    const rootHandle = createStubExecutionHandle("running");
    const childHandle = createStaticExecutionHandle([], {
      activeAgent: "worker",
      iterationCount: 0,
      phase: "completed",
    });
    const createThreadInputs: Array<{ schemaId?: string }> = [];
    const executeTurnInputs: Array<{
      agentName: string;
      schemaId?: string;
      threadId: string;
    }> = [];
    let executeCalls = 0;
    const framework = {
      async createBranch() {
        throw new Error("createBranch was not expected");
      },
      async createThread(input) {
        createThreadInputs.push(input);

        return {
          branchId: `branch-${createThreadInputs.length}`,
          rootTurnNodeHash: "0".repeat(64),
          rootTurnTreeHash: "1".repeat(64),
          threadId: `thread-${createThreadInputs.length}`,
        };
      },
      executeTurn(input) {
        executeCalls += 1;
        executeTurnInputs.push({
          agentName: input.config.name,
          schemaId: input.schemaId,
          threadId: input.threadId,
        });

        if (executeCalls === 1) {
          return rootHandle;
        }

        return childHandle;
      },
      async getThread(threadId) {
        if (threadId === "thread-root") {
          return {
            rootTurnNodeHash: "2".repeat(64),
            schemaId: "tuvren.agent.v1",
            threadId,
          };
        }

        return null;
      },
      async setBranchHead() {
        throw new Error("setBranchHead was not expected");
      },
      async listThreads() {
        return { threads: [] };
      },
      async listBranches() {
        return [];
      },
      async getTurnState() {
        throw new Error("getTurnState was not expected");
      },
      async *getTurnHistory() {},
      async readBranchMessages() {
        return { messages: [] };
      },
    } satisfies TuvrenRuntime;
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: "branch-root",
      schemaId: "custom.agent.v1",
      signal: textSignal("root"),
      threadId: "thread-root",
    });

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const spawnedChild = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    await spawnedChild.awaitResult();

    expect(createThreadInputs).toEqual([{ schemaId: "custom.agent.v1" }]);
    expect(executeTurnInputs).toEqual([
      {
        agentName: "primary",
        schemaId: "custom.agent.v1",
        threadId: "thread-root",
      },
      {
        agentName: "worker",
        schemaId: "custom.agent.v1",
        threadId: "thread-1",
      },
    ]);

    rootHandle.cancel();
    await expect(handle.awaitResult()).rejects.toMatchObject({
      code: "execution_cancelled",
    });
  });

  test("keeps live extension receiver state mutable during orchestrated execution", async () => {
    interface ReceiverExtension {
      beforeIteration(): undefined;
      beforeTurn(): undefined;
      beforeTurnCalls: number;
      name: string;
    }

    const harness = createFakeKernelHarness();
    const extension: ReceiverExtension = {
      beforeIteration() {
        if (this.beforeTurnCalls !== 1) {
          throw new Error(
            `expected beforeTurnCalls to be 1, received ${this.beforeTurnCalls}`
          );
        }

        return undefined;
      },
      beforeTurn() {
        this.beforeTurnCalls += 1;
        return undefined;
      },
      beforeTurnCalls: 0,
      name: "orchestration-mutable-receiver",
    };
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async () => ({
          messages: [assistantText("Hook receiver stayed mutable.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: {
          extensions: [extension],
          name: "primary",
        },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      toKrakenMessages(await harness.readBranchMessages(thread.branchId))
    ).toEqual([
      {
        parts: [{ text: "Start root", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Hook receiver stayed mutable.", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("preserves handed-off child agent attribution on orchestration streams", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
      worker: { name: "worker" },
    };
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            return {
              messages: [assistantText("Passing this to reviewer.")],
              resolution: {
                contextPlan: context.handoff.createContextPlan({
                  mode: "last_output_only",
                  reason: "review_handoff",
                  targetAgent: "reviewer",
                }),
                targetAgent: "reviewer",
                type: "handoff",
              },
            };
          }

          if (context.config.name === "reviewer") {
            return {
              messages: [assistantText("Reviewer done.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await delay(20);
          return {
            messages: [assistantText("Parent complete.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
      resolveAgentConfig(agentName) {
        return agents[agentName];
      },
    });
    const orchestration = createOrchestrationRuntime({
      agents,
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });
    const rootCapture = startEventCapture(handle.allEvents());

    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("handoff child"),
    });
    const childEvents = await collectEvents(childHandle.events());
    const childResult = await childHandle.awaitResult();
    await rootCapture.done;

    const childReviewerEvent = childEvents.find(
      (event) => event.type === "text.done" && event.text === "Reviewer done."
    );
    const rootReviewerEvent = rootCapture.events.find(
      (event) =>
        event.type === "text.done" &&
        event.text === "Reviewer done." &&
        event.source?.workerId !== undefined
    );

    expect(childResult.status).toBe("completed");
    if (childResult.status !== "completed") {
      throw new Error("unreachable");
    }
    expect(childResult.finalAssistantMessage).toEqual({
      parts: [{ text: "Reviewer done.", type: "text" }],
      providerMetadata: undefined,
      role: "assistant",
    });
    expect(childReviewerEvent?.source?.agent).toBe("reviewer");
    expect(rootReviewerEvent?.source?.agent).toBe("reviewer");
  });

  test("preserves descendant thread and worker attribution when forwarding child streams", async () => {
    const rootHandle = createStubExecutionHandle("running");
    let executeCalls = 0;
    let nextThreadNumber = 0;
    const framework = {
      async createBranch() {
        throw new Error("createBranch was not expected");
      },
      async createThread() {
        nextThreadNumber += 1;
        return {
          branchId: `branch-${nextThreadNumber}`,
          rootTurnNodeHash: "0".repeat(64),
          rootTurnTreeHash: "1".repeat(64),
          threadId: `thread-${nextThreadNumber}`,
        };
      },
      executeTurn() {
        executeCalls += 1;

        if (executeCalls === 1) {
          return rootHandle;
        }

        return createStaticExecutionHandle(
          [
            {
              messageId: "nested-message",
              role: "assistant",
              source: {
                agent: "nested-worker",
                threadId: "thread-grandchild",
                workerId: "worker-grandchild",
              },
              timestamp: Date.now(),
              type: "message.start",
            },
            {
              messageId: "nested-message",
              source: {
                agent: "nested-worker",
                threadId: "thread-grandchild",
                workerId: "worker-grandchild",
              },
              text: "Nested worker done.",
              timestamp: Date.now(),
              type: "text.done",
            },
            {
              finishReason: "stop",
              messageId: "nested-message",
              source: {
                agent: "nested-worker",
                threadId: "thread-grandchild",
                workerId: "worker-grandchild",
              },
              timestamp: Date.now(),
              type: "message.done",
            },
          ],
          {
            activeAgent: "worker",
            iterationCount: 0,
            phase: "completed",
          }
        );
      },
      async getThread(threadId) {
        if (threadId === "thread-root") {
          return {
            rootTurnNodeHash: "2".repeat(64),
            schemaId: "tuvren.agent.v1",
            threadId,
          };
        }

        return null;
      },
      async setBranchHead() {
        throw new Error("setBranchHead was not expected");
      },
      async listThreads() {
        return { threads: [] };
      },
      async listBranches() {
        return [];
      },
      async getTurnState() {
        throw new Error("getTurnState was not expected");
      },
      async *getTurnHistory() {},
      async readBranchMessages() {
        return { messages: [] };
      },
    } satisfies TuvrenRuntime;
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: "branch-root",
      signal: textSignal("root"),
      threadId: "thread-root",
    });
    const subtreeCapture = startEventCapture(handle.allEvents());

    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("child"),
    });
    const childEvents = await collectEvents(childHandle.events());
    await waitFor(() =>
      subtreeCapture.events.some(
        (event) =>
          event.type === "text.done" && event.text === "Nested worker done."
      )
    );

    const childTextEvent = childEvents.find(
      (event) =>
        event.type === "text.done" && event.text === "Nested worker done."
    );
    const subtreeTextEvent = subtreeCapture.events.find(
      (event) =>
        event.type === "text.done" && event.text === "Nested worker done."
    );

    expect(childTextEvent?.source).toEqual({
      agent: "nested-worker",
      threadId: "thread-grandchild",
      workerId: "worker-grandchild",
    });
    expect(subtreeTextEvent?.source).toEqual({
      agent: "nested-worker",
      threadId: "thread-grandchild",
      workerId: "worker-grandchild",
    });

    rootHandle.cancel();
    await expect(handle.awaitResult()).rejects.toMatchObject({
      code: "execution_cancelled",
    });
    await subtreeCapture.done;
  });

  test("snapshots orchestration agent configs at runtime creation", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            const toolMessages = context.messages.filter(
              (message) => message.role === "tool"
            );

            if (toolMessages.length > 0) {
              return {
                messages: [assistantText("Worker complete.")],
                resolution: {
                  reason: "done",
                  type: "end_turn",
                },
              };
            }

            return {
              messages: [
                {
                  parts: [
                    {
                      callId: "call-research",
                      input: { query: "snapshot" },
                      name: "research",
                      type: "tool_call",
                    },
                  ],
                  role: "assistant",
                },
              ],
              resolution: {
                type: "continue_iteration",
              },
            };
          }

          await delay(20);
          return {
            messages: [assistantText("Parent complete.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const agents = {
      primary: { name: "primary" },
      worker: {
        name: "worker",
        tools: [
          {
            description: "Snapshot-sensitive research tool",
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
            name: "research",
          },
        ],
      },
    };
    const orchestration = createOrchestrationRuntime({
      agents,
      framework,
    });
    const originalTool = agents.worker.tools?.[0];

    if (originalTool === undefined) {
      throw new Error("expected a worker research tool");
    }

    originalTool.description = "mutated";
    originalTool.execute = () => ({ status: "mutated" });

    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("research"),
    });
    const childEvents = await collectEvents(childHandle.events());

    expect(
      childEvents.some(
        (event) =>
          event.type === "tool.result" &&
          event.name === "research" &&
          typeof event.output === "object" &&
          event.output !== null &&
          "status" in event.output &&
          event.output.status === "original"
      )
    ).toBe(true);
    const childResult = await childHandle.awaitResult();
    expect(childResult.status).toBe("completed");
    if (childResult.status !== "completed") {
      throw new Error("unreachable");
    }
    expect(childResult.finalAssistantMessage).toEqual({
      parts: [{ text: "Worker complete.", type: "text" }],
      providerMetadata: undefined,
      role: "assistant",
    });
  });

  test("awaitResult aggregates childResults for parent-plus-two-children orchestration", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker-alpha") {
            await delay(5);
            return {
              messages: [assistantText("Alpha complete.")],
              resolution: { reason: "done", type: "end_turn" },
            };
          }

          if (context.config.name === "worker-beta") {
            await delay(10);
            return {
              messages: [assistantText("Beta complete.")],
              resolution: { reason: "done", type: "end_turn" },
            };
          }

          await delay(20);
          return {
            messages: [assistantText("Parent complete.")],
            resolution: { reason: "done", type: "end_turn" },
          };
        }),
      ]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        "worker-alpha": { name: "worker-alpha" },
        "worker-beta": { name: "worker-beta" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Start root"),
      threadId: thread.threadId,
    });

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const alphaHandle = handle.spawn({
      agent: "worker-alpha",
      signal: textSignal("alpha"),
    });
    const betaHandle = handle.spawn({
      agent: "worker-beta",
      signal: textSignal("beta"),
    });

    const parentResult = await handle.awaitResult();

    expect(parentResult.status).toBe("completed");
    if (parentResult.status !== "completed") {
      throw new Error("unreachable");
    }
    expect(parentResult.finalAssistantMessage).toEqual({
      parts: [{ text: "Parent complete.", type: "text" }],
      providerMetadata: undefined,
      role: "assistant",
    });
    expect(Object.keys(parentResult.childResults)).toHaveLength(2);

    const childTexts = Object.values(parentResult.childResults)
      .map((r) => {
        if (r.status !== "completed") {
          return undefined;
        }
        const msg = r.finalAssistantMessage;
        if (msg?.role !== "assistant") {
          return undefined;
        }
        const part = msg.parts[0];
        return part.type === "text" ? part.text : undefined;
      })
      .filter((t): t is string => t !== undefined)
      .sort();

    expect(childTexts).toEqual(["Alpha complete.", "Beta complete."]);

    detachTestPromise(alphaHandle.awaitResult());
    detachTestPromise(betaHandle.awaitResult());
  });
});
