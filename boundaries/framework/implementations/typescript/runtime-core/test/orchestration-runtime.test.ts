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
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver as KrakenDriver,
  RuntimeDriverFactory as KrakenDriverFactory,
} from "@tuvren/driver-api";
import type { AgentConfig, TuvrenRuntime } from "@tuvren/runtime-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createOrchestrationRuntime,
  createTuvrenRuntimeCore,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
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
  test("requires the parent handle to start execution before spawning children", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver((context) => ({
          messages: [assistantText(`Finished ${context.config.name}.`)],
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
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Stay lazy"),
      threadId: thread.threadId,
    });

    expect(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("too-early"),
      })
    ).toThrow(
      "spawn() requires the orchestration handle to start execution first"
    );
  });

  test("does not start orchestration execution when events() is obtained but never consumed", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver((context) => {
          executeCalls += 1;
          return {
            messages: [assistantText(`Finished ${context.config.name}.`)],
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
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Stay idle"),
      threadId: thread.threadId,
    });

    handle.events();
    await delay(40);

    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
  });

  test("does not start orchestration execution when allEvents() is obtained but never consumed", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver((context) => {
          executeCalls += 1;
          return {
            messages: [assistantText(`Finished ${context.config.name}.`)],
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
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Stay idle"),
      threadId: thread.threadId,
    });

    handle.allEvents();
    await delay(40);

    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
  });

  test("closing orchestration streams before the first pull does not start execution", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver((context) => {
          executeCalls += 1;
          return {
            messages: [assistantText(`Finished ${context.config.name}.`)],
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
      },
      framework,
    });
    const thread = await framework.createThread({});
    const eventsHandle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Do not start events"),
      threadId: thread.threadId,
    });
    const allEventsHandle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Do not start allEvents"),
      threadId: thread.threadId,
    });
    const eventsIterator = eventsHandle.events()[Symbol.asyncIterator]();
    const allEventsIterator = allEventsHandle
      .allEvents()
      [Symbol.asyncIterator]();

    await eventsIterator.return?.();
    await allEventsIterator.return?.();
    await delay(40);

    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
  });

  test("awaitResult does not satisfy the parent stream-start precondition for spawn", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          await delay(20);
          return {
            messages: [assistantText(`Finished ${context.config.name}.`)],
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
      signal: textSignal("Stay lazy"),
      threadId: thread.threadId,
    });

    await expect(handle.awaitResult()).rejects.toThrow(
      "awaitResult() requires the orchestration handle to start execution first"
    );

    expect(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("still-too-early"),
      })
    ).toThrow(
      "spawn() requires the orchestration handle to start execution first"
    );
  });

  test("reports child binding initialization failures only once on subtree streams", async () => {
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

        throw new Error("child start failed");
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
    await expect(childHandle.awaitResult()).rejects.toThrow(
      "child start failed"
    );
    await delay(40);
    const events = subtreeCapture.events;

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  test("bridges descendant events through allEvents and does not inject worker_result into parent history", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await delay(5);
            return {
              messages: [assistantText("Worker complete.")],
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

    const eventsPromise = collectEvents(handle.allEvents());
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("research"),
    });
    const childResult = await childHandle.awaitResult();
    const events = await eventsPromise;
    const parentMessages = toKrakenMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(childResult).toEqual([
      {
        text: "Worker complete.",
        type: "text",
      },
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "text.done" &&
          event.source?.workerId !== undefined &&
          event.text === "Worker complete."
      )
    ).toBe(true);
    expect(
      parentMessages.some((message) => {
        if (message.role !== "user") {
          return false;
        }

        return message.parts.some(
          (part) => part.type === "structured" && part.name === "worker_result"
        );
      })
    ).toBe(false);
  });

  test("keeps child allEvents available when the parent subtree stream is already active", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await delay(5);
            return {
              messages: [assistantText("Worker complete.")],
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

    const parentEventsPromise = collectEvents(handle.allEvents());
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("research"),
    });
    const childEventsPromise = collectEvents(childHandle.allEvents());
    const [parentEvents, childEvents] = await Promise.all([
      parentEventsPromise,
      childEventsPromise,
    ]);

    expect(
      parentEvents.some(
        (event) =>
          event.type === "text.done" &&
          event.source?.workerId !== undefined &&
          event.text === "Worker complete."
      )
    ).toBe(true);
    expect(
      childEvents.some(
        (event) =>
          event.type === "text.done" && event.text === "Worker complete."
      )
    ).toBe(true);
  });

  test("awaitResult preserves structured part metadata in the final visible result surface", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            return {
              messages: [
                {
                  parts: [
                    {
                      data: { ok: true },
                      name: "report",
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

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("report"),
    });

    expect(await childHandle.awaitResult()).toEqual([
      {
        data: { ok: true },
        name: "report",
        type: "structured",
      },
    ]);
  });

  test("awaitResult resolves persisted assistant output even when the child driver does not stream it explicitly", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "raw",
      driverRegistry: createBaseDriverRegistry([
        {
          async execute(context) {
            if (context.config.name === "worker") {
              return {
                messages: [assistantText("Worker without explicit streaming.")],
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
          },
          id: "raw",
        } satisfies KrakenDriver,
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

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("worker"),
    });

    expect(await childHandle.awaitResult()).toEqual([
      {
        text: "Worker without explicit streaming.",
        type: "text",
      },
    ]);
  });

  test("awaitResult preserves file parts in the final visible result surface", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            return {
              messages: [
                {
                  parts: [
                    {
                      data: new Uint8Array([1, 2, 3]),
                      filename: "report.csv",
                      mediaType: "text/csv",
                      type: "file",
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

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("file"),
    });

    expect(await childHandle.awaitResult()).toEqual([
      {
        data: new Uint8Array([1, 2, 3]),
        filename: "report.csv",
        mediaType: "text/csv",
        type: "file",
      },
    ]);
  });

  test("awaitResult preserves tool-only child completions in call order", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            const toolMessages = context.messages.filter(
              (message) => message.role === "tool"
            );

            if (toolMessages.length === 0) {
              return {
                messages: [
                  assistantToolCalls([
                    {
                      callId: "call-first",
                      input: { query: "first" },
                      name: "first",
                    },
                    {
                      callId: "call-second",
                      input: { query: "second" },
                      name: "second",
                    },
                  ]),
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
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: {
          name: "worker",
          tools: [
            {
              description: "First worker tool",
              execute() {
                return { status: "first" };
              },
              inputSchema: {
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
                type: "object",
              },
              name: "first",
            },
            {
              description: "Second worker tool",
              execute() {
                return { status: "second" };
              },
              inputSchema: {
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
                type: "object",
              },
              name: "second",
            },
          ],
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

    detachTestPromise(collectEvents(handle.events()));
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("tool-only"),
    });

    expect(await childHandle.awaitResult()).toEqual([
      {
        callId: "call-first",
        name: "first",
        output: { status: "first" },
        type: "tool_result",
      },
      {
        callId: "call-second",
        name: "second",
        output: { status: "second" },
        type: "tool_result",
      },
    ]);
  });

  test("keeps existing subtree events flowing while the parent is paused", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
            await delay(40);
            return {
              messages: [assistantText("Background worker finished.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-hold",
                    input: { hold: true },
                    name: "hold",
                  },
                ]),
              ],
              resolution: {
                type: "continue_iteration",
              },
            };
          }

          return {
            messages: [assistantText("Parent resumed.")],
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
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause the parent turn",
              execute() {
                return { approved: true };
              },
              inputSchema: {
                properties: {
                  hold: { type: "boolean" },
                },
                required: ["hold"],
                type: "object",
              },
              name: "hold",
            },
          ],
        },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Pause root"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.allEvents());

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("background"),
    });
    await waitFor(() => handle.status().phase === "paused");
    await childHandle.awaitResult();
    await waitFor(() =>
      capture.events.some(
        (event) =>
          event.type === "text.done" &&
          event.source?.workerId !== undefined &&
          event.text === "Background worker finished."
      )
    );

    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "call-hold", type: "approve" }],
    });
    await resumedHandle.awaitResult();
    await capture.done;

    expect(resumedHandle).not.toBe(handle);
  });

  test("rejects spawning fresh children while the parent is paused", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-hold",
                    input: { hold: true },
                    name: "hold",
                  },
                ]),
              ],
              resolution: {
                type: "continue_iteration",
              },
            };
          }

          return {
            messages: [assistantText("Parent resumed.")],
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
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause the parent turn",
              execute() {
                return { approved: true };
              },
              inputSchema: {
                properties: {
                  hold: { type: "boolean" },
                },
                required: ["hold"],
                type: "object",
              },
              name: "hold",
            },
          ],
        },
        worker: { name: "worker" },
      },
      framework,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      agent: "primary",
      branchId: thread.branchId,
      signal: textSignal("Pause root"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("paused");
    expect(() =>
      handle.spawn({
        agent: "worker",
        signal: textSignal("background"),
      })
    ).toThrow("spawn() requires a running orchestration handle");
  });

  test("resolveApproval returns a fresh child handle and awaitResult resolves through the resumed child", async () => {
    const harness = createFakeKernelHarness();
    const framework = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (context.config.name === "worker") {
            if (toolMessages.length === 0) {
              return {
                messages: [
                  assistantToolCalls([
                    {
                      callId: "call-approve-worker",
                      input: { hold: true },
                      name: "hold",
                    },
                  ]),
                ],
                resolution: {
                  type: "continue_iteration",
                },
              };
            }

            return {
              messages: [assistantText("Worker resumed with approval.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
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
        worker: {
          name: "worker",
          tools: [
            {
              approval: true,
              description: "Pause worker review",
              execute() {
                return { approved: true };
              },
              inputSchema: {
                properties: {
                  hold: { type: "boolean" },
                },
                required: ["hold"],
                type: "object",
              },
              name: "hold",
            },
          ],
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

    const rootEventsPromise = collectEvents(handle.allEvents());
    await delay(0);
    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("approval"),
    });

    await collectEvents(childHandle.events());
    expect(childHandle.status().phase).toBe("paused");

    const resumedChildHandle = childHandle.resolveApproval({
      decisions: [{ callId: "call-approve-worker", type: "approve" }],
    });
    await expect(childHandle.awaitResult()).rejects.toThrow(
      "awaitResult() requires the current orchestration handle"
    );
    expect(childHandle.status().phase).toBe("paused");
    const childResult = await resumedChildHandle.awaitResult();

    await rootEventsPromise;

    expect(resumedChildHandle).not.toBe(childHandle);
    expect(childResult).toEqual([
      {
        text: "Worker resumed with approval.",
        type: "text",
      },
    ]);
  });

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

    expect(grandchildResult).toEqual([
      {
        text: "Grandchild complete.",
        type: "text",
      },
    ]);
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

  test("rejects awaitResult when child execution fails", async () => {
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

    await expect(childHandle.awaitResult()).rejects.toThrow("worker exploded");
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
              assistantToolCalls([
                {
                  callId: "call-research",
                  input: { query: "inherit" },
                  name: "research",
                },
              ]),
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
    expect(childResult).toEqual([
      {
        callId: "call-research",
        name: "research",
        output: { status: "inherited" },
        type: "tool_result",
      },
    ]);
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
    await expect(handle.awaitResult()).rejects.toThrow(
      "orchestration execution failed"
    );
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

    expect(childResult).toEqual([
      {
        text: "Reviewer done.",
        type: "text",
      },
    ]);
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
    await expect(handle.awaitResult()).rejects.toThrow(
      "orchestration execution failed"
    );
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
                assistantToolCalls([
                  {
                    callId: "call-research",
                    input: { query: "snapshot" },
                    name: "research",
                  },
                ]),
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
    expect(await childHandle.awaitResult()).toEqual([
      {
        text: "Worker complete.",
        type: "text",
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

function createStaticDriver(
  execute: (
    context: DriverExecutionContext
  ) => DriverExecutionResult | Promise<DriverExecutionResult>,
  id = "fake"
): KrakenDriver {
  let emittedMessageSequence = 0;

  return {
    async execute(context) {
      const result = await execute(context);

      for (const message of result.messages ?? []) {
        if (message.role !== "assistant") {
          continue;
        }

        emittedMessageSequence += 1;
        const messageId = `assistant-${emittedMessageSequence}`;
        context.runtime.emit({
          messageId,
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });

        for (const part of message.parts) {
          switch (part.type) {
            case "file":
              context.runtime.emit({
                data:
                  typeof part.data === "string"
                    ? part.data
                    : new Uint8Array(part.data),
                filename: part.filename,
                mediaType: part.mediaType,
                messageId,
                timestamp: context.runtime.now(),
                type: "file.done",
              });
              break;
            case "structured":
              context.runtime.emit({
                delta: serializeDriverDeltaValue(part.data),
                messageId,
                timestamp: context.runtime.now(),
                type: "structured.delta",
              });
              context.runtime.emit({
                data: part.data,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "structured.done",
              });
              break;
            case "tool_call":
              context.runtime.emit({
                callId: part.callId,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "tool_call.start",
              });
              context.runtime.emit({
                callId: part.callId,
                delta: serializeDriverDeltaValue(part.input),
                timestamp: context.runtime.now(),
                type: "tool_call.args_delta",
              });
              context.runtime.emit({
                callId: part.callId,
                input: part.input,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "tool_call.done",
              });
              break;
            case "text":
              context.runtime.emit({
                delta: part.text,
                messageId,
                timestamp: context.runtime.now(),
                type: "text.delta",
              });
              context.runtime.emit({
                messageId,
                text: part.text,
                timestamp: context.runtime.now(),
                type: "text.done",
              });
              break;
            case "reasoning":
              if (!part.redacted) {
                context.runtime.emit({
                  delta: part.text,
                  messageId,
                  timestamp: context.runtime.now(),
                  type: "reasoning.delta",
                });
              }

              context.runtime.emit({
                messageId,
                timestamp: context.runtime.now(),
                type: "reasoning.done",
              });
              break;
            default:
              break;
          }
        }

        context.runtime.emit({
          finishReason: message.parts.some((part) => part.type === "tool_call")
            ? "tool_call"
            : "stop",
          messageId,
          timestamp: context.runtime.now(),
          type: "message.done",
        });
      }

      return result;
    },
    id,
    async resume() {
      throw new Error("resume was not expected");
    },
  };
}

function serializeDriverDeltaValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value) ?? "null";
}
