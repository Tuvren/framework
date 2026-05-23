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
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createDriverRegistry } from "../../../runtime/src/lib/driver-registry.ts";
import { createTuvrenRuntime as createTuvrenRuntimeCore } from "../../../runtime/src/lib/runtime-core.ts";
import { createFakeKernelHarness } from "../../../runtime/test/fake-kernel.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";
import {
  collectEvents,
  collectRemaining,
  collectUntil,
  createDriverExecutionContext,
  createSearchTool,
  textSignal,
  wait,
} from "./react-driver-test-helpers.ts";

describe("driver-react integration", () => {
  test("runtime-core cancellation stops a pending provider stream and checkpoints partial output", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "partial",
          type: "text_delta",
        };
        await wait(1000);
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
      signal: textSignal("Cancel this stream"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const firstEvents = await collectUntil(
      iterator,
      (event) => event.type === "text.delta"
    );

    handle.cancel();
    const remainingEvents = await Promise.race([
      collectRemaining(iterator),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof remainingEvents === "string") {
      throw new Error("runtime did not stop waiting after cancellation");
    }

    const events = [...firstEvents, ...remainingEvents];
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("runtime_execution_cancelled");
    expect(
      events.some(
        (event) => event.type === "turn.end" && event.status === "failed"
      )
    ).toBe(true);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      partial: true,
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel this stream", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "partial", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("runtime-core cancellation after tool_call.start keeps the cancellation error", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const startChunk = {
          providerCallId: "native-call-1",
          name: "search",
          type: "tool_call_start",
        } satisfies ProviderStreamChunk;

        yield startChunk;
        await wait(1000);
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
      signal: textSignal("Cancel this tool call"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const firstEvents = await collectUntil(
      iterator,
      (event) => event.type === "tool_call.start"
    );

    handle.cancel();
    const remainingEvents = await Promise.race([
      collectRemaining(iterator),
      wait(100).then(() => "timed_out"),
    ]);

    if (typeof remainingEvents === "string") {
      throw new Error("runtime did not stop waiting after cancellation");
    }

    const events = [...firstEvents, ...remainingEvents];
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("runtime_execution_cancelled");
    expect(errorEvent?.error.message).toBe("execution cancelled");
    expect(events.some((event) => event.type === "message.done")).toBe(false);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel this tool call", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("runtime-core accepts final-only streamed structured output", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          data: { answer: "ok" },
          name: "answer",
          type: "structured_done",
        } satisfies ProviderStreamChunk;
        yield {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;
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
      signal: textSignal("Return structured output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(events.map((event) => event.type)).toContain("structured.delta");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              data: { answer: "ok" },
              name: "answer",
              type: "structured",
            },
          ],
          role: "assistant",
        },
      ])
    );
  });

  test("runtime-core executes another iteration when ReAct loopPolicy requests continuation after plain assistant output", async () => {
    const harness = createFakeKernelHarness();
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [
            {
              text:
                generateCalls === 1
                  ? "Continue once more."
                  : "Now we can stop.",
              type: "text",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
        }),
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        loopPolicy: {
          evaluate(response, _manifest, iterationCount) {
            return {
              continue:
                iterationCount === 1 &&
                response.parts.some(
                  (part) =>
                    part.type === "text" && part.text === "Continue once more."
                ),
              executeTools: false,
              reason: "done",
            };
          },
        },
        model: provider,
        name: "primary",
      },
      signal: textSignal("Follow the loop policy"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(generateCalls).toBe(2);
    expect(
      events.filter((event) => event.type === "iteration.start")
    ).toHaveLength(2);
    expect(handle.status().phase).toBe("completed");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Follow the loop policy", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Continue once more.", type: "text" }],
        role: "assistant",
      },
      {
        parts: [{ text: "Now we can stop.", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("fails hard when streamed structured output cannot be parsed", async () => {
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          delta: '{"answer":',
          type: "structured_delta",
        } as const;
        yield {
          finishReason: "stop",
          type: "finish",
        } as const;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_invalid_provider_stream");
  });

  test("executes end to end through runtime-core with a generated terminal response", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
        }),
      ]),
      kernel: harness.kernel,
    });
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "Hello from ReAct.", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("Say hello"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(events.some((event) => event.type === "message.done")).toBe(true);
    expect(handle.status().phase).toBe("completed");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "Hello from ReAct.", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("executes end to end through runtime-core with a generated response that preserves canonical metadata fields", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse: TuvrenModelResponse | undefined;
    const fileData = new Uint8Array([1, 2, 3]);
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
        }),
      ]),
      kernel: harness.kernel,
    });
    const provider = {
      async generate() {
        return {
          finishReason: "length",
          parts: [
            {
              providerMetadata: {
                source: "openai-output-text",
              },
              text: "Generated answer",
              type: "text",
            },
            {
              providerMetadata: {
                signature: "sig-1",
              },
              redacted: false,
              text: "internal reasoning",
              type: "reasoning",
            },
            {
              data: { answer: "ok" },
              name: "answer",
              providerMetadata: {
                enforcement: "strict",
              },
              type: "structured",
            },
            {
              data: fileData,
              filename: "report.csv",
              mediaType: "text/csv",
              providerMetadata: {
                uploadId: "file-1",
              },
              type: "file",
            },
          ],
          providerMetadata: {
            encrypted_content: "enc-123",
            responseId: "resp-123",
          },
          usage: {
            inputTokens: 10,
            outputTokens: 7,
          },
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = context.response;
              return undefined;
            },
            name: "capture",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Return the full generated payload"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const messageDoneEvent = events.find(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "message.done" }> =>
        event.type === "message.done"
    );

    expect(handle.status().phase).toBe("completed");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "message.start",
        "text.delta",
        "text.done",
        "reasoning.delta",
        "reasoning.done",
        "structured.delta",
        "structured.done",
        "file.done",
        "message.done",
      ])
    );
    expect(messageDoneEvent).toMatchObject({
      finishReason: "length",
      usage: {
        inputTokens: 10,
        outputTokens: 7,
      },
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              providerMetadata: {
                source: "openai-output-text",
              },
              text: "Generated answer",
              type: "text",
            },
            {
              providerMetadata: {
                signature: "sig-1",
              },
              redacted: false,
              text: "internal reasoning",
              type: "reasoning",
            },
            {
              data: { answer: "ok" },
              name: "answer",
              providerMetadata: {
                enforcement: "strict",
              },
              type: "structured",
            },
            {
              data: fileData,
              filename: "report.csv",
              mediaType: "text/csv",
              providerMetadata: {
                uploadId: "file-1",
              },
              type: "file",
            },
          ],
          providerMetadata: {
            encrypted_content: "enc-123",
            responseId: "resp-123",
          },
          role: "assistant",
        },
      ])
    );
    expect(capturedResponse).toEqual({
      finishReason: "length",
      parts: [
        {
          providerMetadata: {
            source: "openai-output-text",
          },
          text: "Generated answer",
          type: "text",
        },
        {
          providerMetadata: {
            signature: "sig-1",
          },
          redacted: false,
          text: "internal reasoning",
          type: "reasoning",
        },
        {
          data: { answer: "ok" },
          name: "answer",
          providerMetadata: {
            enforcement: "strict",
          },
          type: "structured",
        },
        {
          data: fileData,
          filename: "report.csv",
          mediaType: "text/csv",
          providerMetadata: {
            uploadId: "file-1",
          },
          type: "file",
        },
      ],
      providerMetadata: {
        encrypted_content: "enc-123",
        responseId: "resp-123",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 7,
      },
    });
  });

  test("executes end to end through runtime-core for generated tool calls with host-selected sequential mode", async () => {
    const harness = createFakeKernelHarness();
    let iteration = 0;
    const provider = {
      async generate() {
        if (iteration === 0) {
          iteration += 1;
          return {
            finishReason: "tool_call",
            parts: [
              {
                callId: "call-search",
                input: { query: "docs" },
                name: "search",
                providerMetadata: {
                  providerCallId: "provider-call-1",
                },
                type: "tool_call",
              },
            ],
            providerMetadata: {
              responseId: "resp-tool-1",
            },
            usage: {
              inputTokens: 8,
              outputTokens: 3,
            },
          } satisfies TuvrenModelResponse;
        }

        return {
          finishReason: "stop",
          parts: [{ text: "Tool run complete", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
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

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "tool_call.args_delta")).toBe(
      true
    );
    expect(
      events.some(
        (event) => event.type === "tool_call.done" && event.name === "search"
      )
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "tool.result" && event.name === "search"
      )
    ).toBe(true);
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [
            {
              callId: "call-search",
              input: { query: "docs" },
              name: "search",
              providerMetadata: {
                providerCallId: "provider-call-1",
              },
              type: "tool_call",
            },
          ],
          providerMetadata: {
            responseId: "resp-tool-1",
          },
          role: "assistant",
        },
        {
          parts: [{ text: "Tool run complete", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("does not publish generated assistant events before validation succeeds", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "plain text fallback", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: REACT_DRIVER_ID,
      driverRegistry: createDriverRegistry([
        createReActDriver({
          providerCallMode: "generate",
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
        responseFormat: {
          name: "answer",
          schema: {
            properties: {
              answer: { type: "string" },
            },
            required: ["answer"],
            type: "object",
          },
        },
      },
      signal: textSignal("Require structured output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "message.start")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "structured_output_validation"
      )
    ).toBe(true);
    expect(messages).toEqual([
      {
        parts: [{ text: "Require structured output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("streams assistant events through runtime-core before the provider finishes", async () => {
    const harness = createFakeKernelHarness();
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "live output",
          type: "text_delta",
        } as const;
        await streamGate;
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
      signal: textSignal("Stream live"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const streamedEvents = await collectUntil(
      iterator,
      (event) => event.type === "text.delta"
    );

    expect(streamedEvents.some((event) => event.type === "message.start")).toBe(
      true
    );
    expect(streamedEvents.some((event) => event.type === "text.delta")).toBe(
      true
    );
    expect(handle.status().phase).toBe("running");

    releaseStream?.();

    const remainingEvents = await collectRemaining(iterator);

    expect(
      [...streamedEvents, ...remainingEvents].some(
        (event) => event.type === "message.done"
      )
    ).toBe(true);
    expect(handle.status().phase).toBe("completed");
  });
});
