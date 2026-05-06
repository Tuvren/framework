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
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createTuvrenRuntimeCore,
} from "@tuvren/runtime-core";
import { createFakeKernelHarness } from "../../../runtime-core/test/fake-kernel.ts";
import { readBranchContextManifest } from "../../../runtime-core/test/runtime-core-test-helpers.ts";
import { createReActDriver, REACT_DRIVER_ID } from "../src/index.ts";
import {
  collectEvents,
  createDriverExecutionContext,
  textSignal,
} from "./react-driver-test-helpers.ts";

describe("driver-react integration aroundModel", () => {
  test("executes end to end through runtime-core for aroundModel short-circuit synthesis", async () => {
    const harness = createFakeKernelHarness();
    let providerCalls = 0;
    const provider = {
      async generate() {
        providerCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: "provider output", type: "text" }],
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
        extensions: [
          {
            async aroundModel() {
              return {
                finishReason: "stop",
                parts: [{ text: "cached answer", type: "text" }],
              };
            },
            name: "cache",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Use cache"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(providerCalls).toBe(0);
    expect(events.some((event) => event.type === "message.done")).toBe(true);
    expect(handle.status().phase).toBe("completed");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "cached answer", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("executes end to end through runtime-core when aroundModel replaces the durable response after one next() call", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        yield {
          text: "provider",
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
        extensions: [
          {
            async aroundModel(_context, next) {
              const response = await next();
              return {
                ...response,
                parts: [{ text: "modified", type: "text" }],
              };
            },
            name: "rewriter",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Rewrite output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(
      events
        .filter(
          (
            event
          ): event is Extract<(typeof events)[number], { type: "text.done" }> =>
            event.type === "text.done"
        )
        .map((event) => event.text)
    ).toEqual(["provider"]);
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "modified", type: "text" }],
          role: "assistant",
        },
      ])
    );
  });

  test("does not request final sequence divergence for metadata-only aroundModel changes", async () => {
    const emittedEvents: TuvrenStreamEvent[] = [];
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const textDelta = {
          text: "provider",
          type: "text_delta",
        } satisfies ProviderStreamChunk;
        const finish = {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;

        yield textDelta;
        yield finish;
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "stream",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          extensions: [
            {
              async aroundModel(_context, next) {
                const response = await next();

                return {
                  ...response,
                  providerMetadata: {
                    cache: "hit",
                  },
                } satisfies TuvrenModelResponse;
              },
              name: "metadata",
            },
          ],
          model: provider,
          name: "primary",
        },
        emittedEvents,
      })
    );

    expect(result.assistantEventReconciliation).toBeUndefined();
    expect(result.messages).toEqual([
      {
        parts: [{ text: "provider", type: "text" }],
        providerMetadata: {
          cache: "hit",
        },
        role: "assistant",
      },
    ]);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      "message.start",
      "text.delta",
      "text.done",
      "message.done",
    ]);
  });

  test("executes end to end when aroundModel only changes response metadata after streamed next", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        const textDelta = {
          text: "provider",
          type: "text_delta",
        } satisfies ProviderStreamChunk;
        const finish = {
          finishReason: "stop",
          type: "finish",
        } satisfies ProviderStreamChunk;

        yield textDelta;
        yield finish;
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
        extensions: [
          {
            async aroundModel(_context, next) {
              const response = await next();

              return {
                ...response,
                providerMetadata: {
                  cache: "hit",
                },
              } satisfies TuvrenModelResponse;
            },
            name: "metadata",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Annotate output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "provider", type: "text" }],
          providerMetadata: {
            cache: "hit",
          },
          role: "assistant",
        },
      ])
    );
  });

  test("fails end to end through runtime-core when aroundModel retry returns a stale streamed response", async () => {
    const harness = createFakeKernelHarness();
    let streamCalls = 0;
    const provider = {
      async generate() {
        throw new Error("generate should not be called");
      },
      id: "provider",
      async *stream() {
        streamCalls += 1;
        yield {
          text: streamCalls === 1 ? "first attempt" : "second attempt",
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
        extensions: [
          {
            async aroundModel(context, next) {
              const firstResponse = await next(context);
              await next(context);
              return firstResponse;
            },
            name: "retry",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Trigger stale retry response"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(streamCalls).toBe(2);
    expect(handle.status().phase).toBe("failed");
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.code === "react_driver_invalid_around_model_retry"
      )
    ).toBe(true);
    expect(
      events
        .filter(
          (
            event
          ): event is Extract<(typeof events)[number], { type: "text.done" }> =>
            event.type === "text.done"
        )
        .map((event) => event.text)
    ).toEqual(["first attempt", "second attempt"]);
    expect(messages).toEqual([
      {
        parts: [{ text: "Trigger stale retry response", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("persists aroundModel state updates through the runtime-core checkpoint path", async () => {
    const harness = createFakeKernelHarness();
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "Stateful response", type: "text" }],
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
        extensions: [
          {
            async aroundModel(_context, next) {
              const response = await next();
              return {
                response,
                state: {
                  remainingBudget: 7,
                },
              };
            },
            name: "budget",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Track budget"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(handle.status().phase).toBe("completed");
    expect(manifest.extensions).toEqual({
      budget: {
        remainingBudget: 7,
      },
    });
  });

  test("persists only the final retry state updates through the runtime-core checkpoint path", async () => {
    const harness = createFakeKernelHarness();
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [{ text: `attempt-${generateCalls}`, type: "text" }],
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
        extensions: [
          {
            async aroundModel(context, next) {
              await next(context);
              return await next(context);
            },
            name: "retry",
          },
          {
            async aroundModel(context, next) {
              const response = await next(context);
              return {
                response,
                state:
                  generateCalls === 1
                    ? { discardedAttempt: true, retainedAttempt: false }
                    : { retainedAttempt: true },
              };
            },
            name: "budget",
          },
        ],
        model: provider,
        name: "primary",
      },
      signal: textSignal("Track retry state"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(handle.status().phase).toBe("completed");
    expect(manifest.extensions).toEqual({
      budget: {
        retainedAttempt: true,
      },
    });
  });
});
