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

// biome-ignore-all lint/suspicious/useAwait: Mock async runtime/provider interfaces intentionally preserve promise-based signatures in these integration tests.

import { describe, expect, test } from "bun:test";
import type { TuvrenProvider, TuvrenStreamEvent } from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "@tuvren/runtime-core";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { createFakeKernelHarness } from "../../../runtime-core/test/fake-kernel.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";
import {
  collectEvents,
  createSearchTool,
  textSignal,
} from "./react-driver-test-helpers.ts";

describe("driver-react integration streamed runtime", () => {
  test("executes end to end through runtime-core for streamed tool calls with host-selected sequential mode", async () => {
    const harness = createFakeKernelHarness();
    let iteration = 0;
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        if (iteration === 0) {
          iteration += 1;
          yield {
            providerCallId: "provider-call-1",
            name: "search",
            type: "tool_call_start",
          } as const;
          yield {
            delta: '{"query":"docs"}',
            providerCallId: "provider-call-1",
            type: "tool_call_args_delta",
          } as const;
          yield {
            input: { query: "docs" },
            name: "search",
            providerMetadata: {
              google: {
                thoughtSignature: "tool-thought-1",
              },
            },
            providerCallId: "provider-call-1",
            type: "tool_call_done",
          } as const;
          yield {
            finishReason: "tool_call",
            type: "finish",
          } as const;
          return;
        }

        yield {
          text: "Tool run complete",
          type: "text_delta",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
          toolExecutionMode: "sequential",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Use the search tool"),
      threadId: thread.threadId,
      tools: [createSearchTool()],
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(
      events.some(
        (event) => event.type === "tool_call.done" && event.name === "search"
      )
    ).toBe(true);
    expect(
      events.find(
        (
          event
        ): event is Extract<TuvrenStreamEvent, { type: "tool_call.done" }> =>
          event.type === "tool_call.done" && event.name === "search"
      )
    ).toMatchObject({
      providerMetadata: {
        google: {
          thoughtSignature: "tool-thought-1",
        },
      },
    });
    expect(
      events.some(
        (event) => event.type === "tool.result" && event.name === "search"
      )
    ).toBe(true);
    expect(handle.status().phase).toBe("completed");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              callId: expect.any(String),
              input: { query: "docs" },
              name: "search",
              providerMetadata: {
                google: {
                  thoughtSignature: "tool-thought-1",
                },
                providerCallId: "provider-call-1",
              },
              type: "tool_call",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Tool run complete", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("executes end to end through runtime-core for streamed tool calls without provider args deltas", async () => {
    const harness = createFakeKernelHarness();
    let iteration = 0;
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        if (iteration === 0) {
          iteration += 1;
          yield {
            providerCallId: "provider-call-1",
            name: "search",
            type: "tool_call_start",
          } as const;
          yield {
            input: { query: "docs" },
            name: "search",
            providerCallId: "provider-call-1",
            type: "tool_call_done",
          } as const;
          yield {
            finishReason: "tool_call",
            type: "finish",
          } as const;
          return;
        }

        yield {
          text: "Tool run complete",
          type: "text_delta",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
          toolExecutionMode: "sequential",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Use the search tool"),
      threadId: thread.threadId,
      tools: [createSearchTool()],
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "tool_call.args_delta")).toBe(
      true
    );
    expect(
      events.some(
        (event) => event.type === "tool.result" && event.name === "search"
      )
    ).toBe(true);
  });

  test("surfaces provider stream failures through runtime-core without invalid assistant stream errors", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "partial output",
          type: "text_delta",
        } as const;
        yield {
          error: new Error("provider transport failed"),
          type: "error",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Trigger provider failure"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("failed");
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "react_driver_provider_failure"
      )
    ).toBe(true);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "error" && event.error.code === "invalid_stream_event"
      )
    ).toBe(false);
    expect(messages).toEqual([
      {
        parts: [{ text: "Trigger provider failure", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("projects provider-backed streamed completions through tee fanout adapters", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "Provider-backed streamed completion.",
          type: "text_delta",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Complete through provider stream"),
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

    expect(handle.status().phase).toBe("completed");
    expect(canonicalEvents.some((event) => event.type === "text.delta")).toBe(
      true
    );
    expect(sseFrames.some((frame) => frame.event === "text.delta")).toBe(true);
    expect(
      aguiEvents.some((event) => event.type === "TEXT_MESSAGE_START")
    ).toBe(true);
    expect(
      aguiEvents.some((event) => event.type === "TEXT_MESSAGE_CONTENT")
    ).toBe(true);
    expect(aguiEvents.some((event) => event.type === "TEXT_MESSAGE_END")).toBe(
      true
    );
    expect(aguiEvents.some((event) => event.type === "RUN_FINISHED")).toBe(
      true
    );
  });

  test("flushes provider-backed failed text streams before adapter RUN_ERROR", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "Partial provider output",
          type: "text_delta",
        } as const;
        yield {
          error: new Error("provider transport failed"),
          type: "error",
        } as const;
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "stream",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Fail through provider stream"),
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
    const textEndIndex = aguiEvents.findIndex(
      (event) => event.type === "TEXT_MESSAGE_END"
    );
    const runErrorIndex = aguiEvents.findIndex(
      (event) => event.type === "RUN_ERROR"
    );

    expect(handle.status().phase).toBe("failed");
    expect(
      canonicalEvents.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "react_driver_provider_failure"
      )
    ).toBe(true);
    expect(sseFrames.some((frame) => frame.event === "error")).toBe(true);
    expect(textEndIndex).toBeGreaterThanOrEqual(0);
    expect(runErrorIndex).toBeGreaterThan(textEndIndex);
  });
});
