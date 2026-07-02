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
} from "@tuvren/core/driver";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  extractTurnId,
  overwriteBranchSinglePath,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("implicitly links follow-up turns to the previous branch turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Turn complete.")],
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
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const firstHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("First turn"),
      threadId: thread.threadId,
    });
    const firstEvents = await collectEvents(firstHandle.events());
    const secondHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Second turn"),
      threadId: thread.threadId,
    });
    const secondEvents = await collectEvents(secondHandle.events());
    const firstTurnId = extractTurnId(firstEvents);
    const secondTurnId = extractTurnId(secondEvents);
    const secondTurn = await harness.kernel.turn.get(secondTurnId);

    expect(firstTurnId).not.toBeNull();
    expect(secondTurn?.parentTurnId).toBe(firstTurnId);
  });

  test("implicitly links the first turn on a forked branch to the source branch head turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Turn complete.")],
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
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const firstHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("First turn"),
      threadId: thread.threadId,
    });
    const firstEvents = await collectEvents(firstHandle.events());
    const firstTurnId = extractTurnId(firstEvents);
    const firstTurn = await harness.kernel.turn.get(firstTurnId);

    if (firstTurn === null) {
      throw new Error(`missing turn "${firstTurnId}"`);
    }

    const fork = await runtime.createBranch({
      fromTurnNodeHash: firstTurn.headTurnNodeHash,
      threadId: thread.threadId,
    });
    const forkHandle = runtime.executeTurn({
      branchId: fork.branchId,
      config: { name: "primary" },
      signal: textSignal("Fork turn"),
      threadId: thread.threadId,
    });
    const forkEvents = await collectEvents(forkHandle.events());
    const forkTurn = await harness.kernel.turn.get(extractTurnId(forkEvents));

    expect(forkHandle.status().phase).toBe("completed");
    expect(forkTurn?.parentTurnId).toBe(firstTurnId);
  });

  test("does not require runtime status turnId for implicit parent inference", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Turn complete.")],
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
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const firstHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("First turn"),
      threadId: thread.threadId,
    });
    const firstEvents = await collectEvents(firstHandle.events());

    await overwriteBranchSinglePath(
      harness.kernel,
      thread.branchId,
      extractTurnId(firstEvents),
      "runtime.status",
      {
        activeAgent: "primary",
        state: "completed",
      }
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Second turn"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const secondTurnId = extractTurnId(events);

    if (secondTurnId === null) {
      throw new Error("expected a second turn id");
    }

    const secondTurn = await harness.kernel.turn.get(secondTurnId);

    expect(handle.status().phase).toBe("completed");
    expect(secondTurn?.parentTurnId).toBe(extractTurnId(firstEvents));
  });

  test("rejects explicit parent turns that do not match the active branch parent", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Turn complete.")],
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
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const threadA = await runtime.createThread({});
    const threadB = await runtime.createThread({});
    const foreignHandle = runtime.executeTurn({
      branchId: threadB.branchId,
      config: { name: "primary" },
      signal: textSignal("Foreign turn"),
      threadId: threadB.threadId,
    });
    const foreignEvents = await collectEvents(foreignHandle.events());
    const foreignTurnId = extractTurnId(foreignEvents);

    if (foreignTurnId === null) {
      throw new Error("expected a foreign turn id");
    }

    const handle = runtime.executeTurn({
      branchId: threadA.branchId,
      config: { name: "primary" },
      parentTurnId: foreignTurnId,
      signal: textSignal("Invalid parent"),
      threadId: threadA.threadId,
    });
    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "turn.end")).toBe(true);
    expect(await harness.readBranchMessages(threadA.branchId)).toEqual([]);
  });

  test("rejects branch and thread mismatches before creating a turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("This turn should not start.")],
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
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const threadA = await runtime.createThread({});
    const threadB = await runtime.createThread({});
    const originalBranchHead = (
      await harness.kernel.branch.get(threadA.branchId)
    )?.headTurnNodeHash;
    const handle = runtime.executeTurn({
      branchId: threadA.branchId,
      config: { name: "primary" },
      signal: textSignal("Cross the streams"),
      threadId: threadB.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "turn.start")).toBe(false);
    expect(errorEvent?.error.code).toBe("branch_thread_mismatch");
    expect(await harness.readBranchMessages(threadA.branchId)).toEqual([]);
    expect(await harness.readBranchRuntimeStatus(threadA.branchId)).toBeNull();
    expect(
      (await harness.kernel.branch.get(threadA.branchId))?.headTurnNodeHash
    ).toBe(originalBranchHead);
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
