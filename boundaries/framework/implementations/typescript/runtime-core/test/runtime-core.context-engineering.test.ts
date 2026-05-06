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
import type { TuvrenStreamEvent } from "@tuvren/runtime-api";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createContextManifest,
  createTuvrenRuntimeCore,
  type RuntimeWarning,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  extractTurnId,
  hasCountData,
  readBranchCheckpointEventTypes,
  textSignal,
  toKrakenMessages,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("emits context-engineering observability before the driver runs with rewritten context", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            messageCount: context.messages.length,
          },
          name: "driver.executed",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [],
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
        contextPolicy: {
          evaluate(_manifest, iterationCount) {
            if (iterationCount !== 1) {
              return {
                action: "none",
              };
            }

            return {
              action: "append_ce_summary",
              execute(context) {
                return [
                  ...context.messageHashes,
                  context.helpers.storeMessage(
                    assistantText("Context engineering summary.")
                  ),
                ];
              },
            };
          },
        },
        name: "primary",
      },
      signal: textSignal("Rewrite the context"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const rewrittenSnapshotIndex = events.findIndex(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { manifest: { messageCount: number }; type: "state.snapshot" }
      > => event.type === "state.snapshot" && event.manifest.messageCount === 2
    );
    const driverExecutedIndex = events.findIndex(
      (event) => event.type === "custom" && event.name === "driver.executed"
    );

    expect(rewrittenSnapshotIndex).toBeGreaterThanOrEqual(0);
    expect(driverExecutedIndex).toBeGreaterThan(rewrittenSnapshotIndex);
  });

  test("emits state snapshots only for checkpoints that change the manifest", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Finished.")],
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
      config: { name: "primary" },
      signal: textSignal("Snapshot boundaries"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const checkpointEvents = events.filter(
      (event) => event.type === "state.checkpoint"
    );
    const snapshotEvents = events.filter(
      (event) => event.type === "state.snapshot"
    );

    expect(checkpointEvents).toHaveLength(3);
    expect(snapshotEvents).toHaveLength(2);
  });

  test("rejects invalid context-engineering helper messages with a validation error", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("This should not run.")],
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
        contextPolicy: {
          evaluate() {
            return {
              action: "store_invalid_message",
              execute(context) {
                return [
                  ...context.messageHashes,
                  context.helpers.storeMessage(JSON.parse('{"role":"banana"}')),
                ];
              },
            };
          },
        },
        name: "primary",
      },
      signal: textSignal("Reject invalid context helper message"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_tuvren_message");
  });

  test("does not let context-engineering plans mutate loaded messages in place", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(_context) {
            return {
              messages: [assistantText("Context engineering completed.")],
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
        } satisfies KrakenDriver,
      ]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        contextPolicy: {
          evaluate() {
            return {
              action: "mutate_loaded_message",
              execute(context) {
                const firstMessage = context.helpers.loadMessage(
                  context.messageHashes[0]
                );

                if (
                  firstMessage?.role === "user" &&
                  firstMessage.parts[0]?.type === "text"
                ) {
                  firstMessage.parts[0].text =
                    "This mutated text should never persist.";
                }

                return [...context.messageHashes];
              },
            };
          },
        },
        name: "primary",
      },
      signal: textSignal("Original short text"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    const branchMessages = await harness.readBranchMessages(thread.branchId);
    const expectedManifest = createContextManifest(
      toKrakenMessages(branchMessages)
    );

    expect(branchMessages).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "Original short text", type: "text" }],
          role: "user",
        },
      ])
    );
    expect(handle.status().manifest).toEqual(expectedManifest);
    expect(
      await readBranchCheckpointEventTypes(harness.kernel, thread.branchId)
    ).toEqual(expect.arrayContaining(["context_engineering_applied"]));
  });

  test("fails invalid context-engineering plans before corrupting the branch head", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("This should not run.")],
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
        contextPolicy: {
          evaluate() {
            return {
              action: "introduce_missing_hash",
              execute(context) {
                return [...context.messageHashes, "missing-message-hash"];
              },
            };
          },
        },
        name: "primary",
      },
      signal: textSignal("Break context engineering"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("missing_message");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Break context engineering", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("warns without blocking when extension manifest state exceeds the host budget", async () => {
    const harness = createFakeKernelHarness();
    const warnings: RuntimeWarning[] = [];
    const driver = {
      async execute() {
        return {
          messages: [assistantText("Oversized state persisted.")],
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
      manifestExtensionStateWarningBudgetBytes: 32,
      onWarning(warning) {
        warnings.push(warning);
        throw new Error("warning callbacks must not fail execution");
      },
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            name: "large-state",
            state: {
              payload: "x".repeat(128),
            },
          },
        ],
        name: "primary",
      },
      signal: textSignal("Persist large state"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      activeAgent: "primary",
      budgetBytes: 32,
      code: "manifest_extension_state_budget_exceeded",
      extensionName: "large-state",
      threadId: thread.threadId,
      turnId: extractTurnId(events),
    });
    expect(warnings[0]?.observedBytes).toBeGreaterThan(32);
    expect(handle.status().manifest?.extensions["large-state"]).toEqual({
      payload: "x".repeat(128),
    });
  });

  test("rejects a second event stream consumer for one execution handle", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            count: 1,
          },
          name: "shared.payload",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [assistantText("Payload emitted.")],
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
      config: { name: "primary" },
      signal: textSignal("Clone event payloads"),
      threadId: thread.threadId,
    });

    const eventStream = handle.events();
    const firstIterator = eventStream[Symbol.asyncIterator]();
    const firstEvent = await firstIterator.next();

    expect(firstEvent.done).toBe(false);

    try {
      eventStream[Symbol.asyncIterator]();
      throw new Error("expected the shared iterable consumer to be rejected");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe(
        "event_stream_already_consumed"
      );
    }

    try {
      await collectEvents(handle.events());
      throw new Error("expected the second consumer to be rejected");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe(
        "event_stream_already_consumed"
      );
    }

    const remainingEvents: TuvrenStreamEvent[] = [];

    for (;;) {
      const nextEvent = await firstIterator.next();

      if (nextEvent.done) {
        break;
      }

      remainingEvents.push(nextEvent.value);
    }

    const customEvent = remainingEvents.find(
      (
        event
      ): event is Extract<
        (typeof remainingEvents)[number],
        { type: "custom" }
      > => event.type === "custom" && event.name === "shared.payload"
    );

    if (customEvent === undefined || !hasCountData(customEvent.data)) {
      throw new Error(
        "expected the canonical stream to emit the payload event"
      );
    }

    customEvent.data.count = 99;
    expect(handle.status().phase).toBe("completed");
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
