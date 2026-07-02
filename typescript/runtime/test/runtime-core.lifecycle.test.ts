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
import type {
  RuntimeKernel as KrakenKernel,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  extractToolMessages,
  extractTurnId,
  hasAssistantText,
  overwriteBranchSinglePath,
  textSignal,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

function _hasAssistantTextMessage(
  messages: readonly unknown[],
  expectedText: string
): boolean {
  return messages.some((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "assistant" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  });
}

function _countUserTextMessages(
  messages: readonly unknown[],
  expectedText: string
): number {
  return messages.filter((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "user" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  }).length;
}

describe("framework-runtime-core", () => {
  test("fails the active iteration run before finalizing post-start runtime errors", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return JSON.parse(
          '{"activeAgent":"primary","messages":[{"role":"assistant","parts":[123]}],"resolution":{"reason":"done","type":"end_turn"}}'
        );
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Trigger tracked-run failure handling"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_tuvren_message");
    expect(events.some((event) => event.type === "turn.end")).toBe(true);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("uses per-turn tools instead of agent-configured tools at turn start", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "override" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        const resultPart = toolMessages[0]?.parts[0];
        const source =
          resultPart?.type === "tool_result" &&
          resultPart.output !== null &&
          typeof resultPart.output === "object" &&
          "source" in resultPart.output &&
          typeof resultPart.output.source === "string"
            ? resultPart.output.source
            : "missing";

        return {
          messages: [assistantText(`source:${source}`)],
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
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            description: "Configured search",
            execute() {
              return {
                source: "configured",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Override tools"),
      threadId: thread.threadId,
      tools: [
        {
          description: "Per-turn search override",
          execute() {
            return {
              source: "request",
            };
          },
          inputSchema: {
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            type: "object",
          },
          name: "search",
        },
      ],
    });

    await collectEvents(handle.events());

    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "source:request"
      )
    ).toBe(true);
  });

  test("materializes driver factories once per execution handle instead of once per iteration", async () => {
    const harness = createFakeKernelHarness();
    const callSequence: string[] = [];
    let createdInstances = 0;
    let overallCalls = 0;
    const driverFactory = {
      create() {
        createdInstances += 1;
        const instanceId = createdInstances;
        let instanceCalls = 0;

        return {
          async execute(_context) {
            instanceCalls += 1;
            overallCalls += 1;
            callSequence.push(`instance-${instanceId}-call-${instanceCalls}`);

            return {
              messages: [
                assistantText(overallCalls === 1 ? "Keep going." : "All done."),
              ],
              resolution:
                overallCalls === 1
                  ? {
                      type: "continue_iteration",
                    }
                  : {
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
      },
      id: "fake",
    } satisfies KrakenDriverFactory;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driverFactory]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Run two iterations"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(callSequence).toEqual(["instance-1-call-1", "instance-1-call-2"]);
  });

  test("rejects malformed persisted manifests at the read boundary", async () => {
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
      "context.manifest",
      {
        bogus: true,
      }
    );

    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Second turn"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_context_manifest");
    expect(events.some((event) => event.type === "turn.end")).toBe(false);
  });

  test("preserves custom thread schemas through final turn-status checkpoints", async () => {
    const harness = createFakeKernelHarness();
    const customSchema = {
      incorporationRules: [
        { objectType: "message", targetPath: "messages" },
        { objectType: "context_manifest", targetPath: "context.manifest" },
        { objectType: "turn_lineage", targetPath: "turn.lineage" },
        { objectType: "runtime_status", targetPath: "runtime.status" },
      ],
      paths: [
        { collection: "ordered", path: "messages" },
        { collection: "single", path: "context.manifest" },
        { collection: "single", path: "turn.lineage" },
        { collection: "single", path: "runtime.status" },
      ],
      schemaId: "custom.agent.v1",
    } satisfies TurnTreeSchema;
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Used the custom schema.")],
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

    await harness.kernel.schema.register(customSchema);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({
      schemaId: customSchema.schemaId,
    });
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Stay on custom schema"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    const branch = await harness.kernel.branch.get(thread.branchId);

    if (branch === null) {
      throw new Error("expected the custom-schema branch to exist");
    }

    const headTurnNode = await harness.kernel.node.get(branch.headTurnNodeHash);

    expect(headTurnNode?.schemaId).toBe(customSchema.schemaId);
    expect((await harness.kernel.thread.get(thread.threadId))?.schemaId).toBe(
      customSchema.schemaId
    );
  });

  test("rejects custom schemas that omit the framework turn lineage path", async () => {
    const harness = createFakeKernelHarness();
    await harness.kernel.schema.register({
      incorporationRules: [
        { objectType: "message", targetPath: "messages" },
        { objectType: "context_manifest", targetPath: "context.manifest" },
        { objectType: "runtime_status", targetPath: "runtime.status" },
      ],
      paths: [
        { collection: "ordered", path: "messages" },
        { collection: "single", path: "context.manifest" },
        { collection: "single", path: "runtime.status" },
      ],
      schemaId: "invalid.custom.agent.v1",
    } satisfies TurnTreeSchema);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry(),
      kernel: harness.kernel,
    });

    await expect(
      runtime.createThread({
        schemaId: "invalid.custom.agent.v1",
      })
    ).rejects.toThrow('must define single path "turn.lineage"');
  });

  test("finalizes durable runtime status for post-start fatal failures", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry(),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      driverId: "missing-driver",
      signal: textSignal("Trigger failure"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("marks the handle failed without turn.end when final turn-status checkpointing fails and preserves the root cause", async () => {
    const harness = createFakeKernelHarness();
    const kernel = {
      ...harness.kernel,
      staging: {
        ...harness.kernel.staging,
        async stage(runId, blob, taskId, objectType, status, interruptPayload) {
          if (taskId === "runtime_status_final") {
            throw new Error("final runtime status staging failed");
          }

          return await harness.kernel.staging.stage(
            runId,
            blob,
            taskId,
            objectType,
            status,
            interruptPayload
          );
        },
      },
    } satisfies KrakenKernel;
    const runtime = createTuvrenRuntime({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry(),
      kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      driverId: "missing-driver",
      signal: textSignal("Trigger finalize failure"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "turn.end")).toBe(false);
    expect(
      errorEvents.some((event) => event.error.code === "unknown_driver")
    ).toBe(true);
    expect(
      errorEvents.some(
        (event) => event.error.message === "final runtime status staging failed"
      )
    ).toBe(true);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "running",
    });
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
