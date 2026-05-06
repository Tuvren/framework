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
  assistantToolCalls,
  collectEvents,
  delay,
  startEventCapture,
  textSignal,
  waitFor,
} from "./runtime-core-test-helpers.ts";

describe("orchestration-runtime approval", () => {
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
});
