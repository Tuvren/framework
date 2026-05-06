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
import type { RuntimeDriver as KrakenDriver } from "@tuvren/driver-api";
import type { TuvrenRuntime } from "@tuvren/runtime-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
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
  assistantToolCalls,
  collectEvents,
  createStubExecutionHandle,
  delay,
  detachTestPromise,
  startEventCapture,
  textSignal,
  toKrakenMessages,
} from "./runtime-core-test-helpers.ts";

describe("orchestration-runtime child lifecycle", () => {
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
});
