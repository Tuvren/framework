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
  KrakenDriver,
} from "@kraken/framework-driver-api";
import {
  createDriverRegistry,
  createKrakenRuntimeCore,
  createOrchestrationRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
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
    const framework = createKrakenRuntimeCore({
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

  test("bridges descendant events through allEvents and does not inject worker_result into parent history", async () => {
    const harness = createFakeKernelHarness();
    const framework = createKrakenRuntimeCore({
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

  test("awaitResult preserves structured part metadata in the final visible result surface", async () => {
    const harness = createFakeKernelHarness();
    const framework = createKrakenRuntimeCore({
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

  test("awaitResult preserves file parts in the final visible result surface", async () => {
    const harness = createFakeKernelHarness();
    const framework = createKrakenRuntimeCore({
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

  test("keeps subtree events flowing while the parent is paused", async () => {
    const harness = createFakeKernelHarness();
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
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

    await waitFor(() => handle.status().phase === "paused");

    const childHandle = handle.spawn({
      agent: "worker",
      signal: textSignal("background"),
    });
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

  test("resolveApproval returns a fresh child handle and awaitResult resolves through the resumed child", async () => {
    const harness = createFakeKernelHarness();
    const framework = createKrakenRuntimeCore({
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        createStaticDriver(async (context) => {
          if (context.config.name === "worker") {
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
    detachTestPromise(collectEvents(childHandle.allEvents()));
    await delay(0);
    const grandchildHandle = childHandle.spawn({
      agent: "worker-2",
      signal: textSignal("grandchild"),
    });
    const grandchildResult = await grandchildHandle.awaitResult();
    const allEvents = await allEventsPromise;

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
  });

  test("rejects awaitResult when child execution fails", async () => {
    const harness = createFakeKernelHarness();
    const framework = createKrakenRuntimeCore({
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
});

function createStaticDriver(
  execute: (
    context: DriverExecutionContext
  ) => DriverExecutionResult | Promise<DriverExecutionResult>
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
                data: part.data,
                messageId,
                name: part.name,
                timestamp: context.runtime.now(),
                type: "structured.done",
              });
              break;
            case "text":
              context.runtime.emit({
                messageId,
                text: part.text,
                timestamp: context.runtime.now(),
                type: "text.done",
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
    id: "fake",
    async resume() {
      throw new Error("resume was not expected");
    },
  };
}
