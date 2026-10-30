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

import { describe, expect, test } from "bun:test";

import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  RunnerExecutionResult,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";
import type { RuntimeKernel, TurnTreeSchema } from "@tuvren/kernel-protocol";

import {
  createRunnerRegistry as createBaseRunnerRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  fromSynchronousVariadicAwaited,
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

const _hasAssistantTextMessage = (
  messages: readonly unknown[],
  expectedText: string
): boolean =>
  messages.some((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "assistant" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  });

const _countUserTextMessages = (
  messages: readonly unknown[],
  expectedText: string
): number =>
  messages.filter((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "user" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  }).length;

const isKrakenRunnerFactory = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory =>
  "create" in entry && typeof entry.create === "function";

const requestsToolExecution = (result: RunnerExecutionResult): boolean =>
  (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );

const normalizeRunnerResult = (
  result: RunnerExecutionResult
): RunnerExecutionResult => {
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
};

const wrapRunner = (runner: RuntimeRunner): RuntimeRunner => {
  const resume = runner.resume?.bind(runner);

  return {
    async execute(context) {
      return normalizeRunnerResult(await runner.execute(context));
    },
    id: runner.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeRunnerResult(await resume(context));
          },
        }),
  };
};

const wrapRunnerEntry = (
  entry: RuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory => {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
};

const createRunnerRegistry = (
  runners: (RuntimeRunner | RuntimeRunnerFactory)[] = []
) => createBaseRunnerRegistry(runners.map(wrapRunnerEntry));
describe("framework-runtime-core", () => {
  test("fails the active iteration run before finalizing post-start runtime errors", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute: fromSynchronousVariadicAwaited(() => {
        const malformedMessage = assistantText("invalid");
        Object.defineProperty(malformedMessage, "parts", { value: [123] });
        const result = {
          messages: [malformedMessage],
          resolution: { reason: "done", type: "end_turn" },
        } satisfies RunnerExecutionResult;
        Object.defineProperty(result, "activeAgent", { value: "primary" });
        return result;
      }),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    const runner = {
      execute: fromSynchronousVariadicAwaited((context) => {
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
      }),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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

  test("materializes runner factories once per execution handle instead of once per iteration", async () => {
    const harness = createFakeKernelHarness();
    const callSequence: string[] = [];
    let createdInstances = 0;
    let overallCalls = 0;
    const runnerFactory = {
      create() {
        createdInstances += 1;
        const instanceId = createdInstances;
        let instanceCalls = 0;

        return {
          execute: fromSynchronousVariadicAwaited((_context) => {
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
          }),
          id: "fake",
          resume: fromSynchronousVariadicAwaited(() => {
            throw new Error("resume was not expected");
          }),
        } satisfies RuntimeRunner;
      },
      id: "fake",
    } satisfies RuntimeRunnerFactory;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runnerFactory]),
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
    const runner = {
      execute: fromSynchronousVariadicAwaited((_context) => ({
        messages: [assistantText("Turn complete.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    const runner = {
      execute: fromSynchronousVariadicAwaited((_context) => ({
        messages: [assistantText("Used the custom schema.")],
        resolution: {
          reason: "done",
          type: "end_turn",
        },
      })),
      id: "fake",
      resume: fromSynchronousVariadicAwaited(() => {
        throw new Error("resume was not expected");
      }),
    } satisfies RuntimeRunner;

    await harness.kernel.schema.register(customSchema);
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
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
    const storedThread = await harness.kernel.thread.get(thread.threadId);
    expect(storedThread?.schemaId).toBe(customSchema.schemaId);
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
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry(),
    });

    const createThreadError = await runtime
      .createThread({ schemaId: "invalid.custom.agent.v1" })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(createThreadError).toBeInstanceOf(Error);
    if (!(createThreadError instanceof Error)) {
      throw new Error("expected schema validation to reject with an Error");
    }
    expect(createThreadError.message).toContain(
      'must define single path "turn.lineage"'
    );
  });

  test("finalizes durable runtime status for post-start fatal failures", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry(),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      runnerId: "missing-runner",
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

  test("keeps an earlier non-fatal error out of a later failed result", async () => {
    const harness = createFakeKernelHarness();
    const runner = {
      execute: fromSynchronousVariadicAwaited(() => ({
        resolution: {
          error: new TuvrenRuntimeError("runner failed", {
            code: "runner_failed",
          }),
          fatality: "hard" as const,
          type: "fail" as const,
        },
      })),
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            afterTurn() {
              throw new Error("cleanup failed");
            },
            name: "cleanup",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Fail after cleanup"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const result = await handle.awaitResult();
    const errorEvents = events.filter((event) => event.type === "error");

    expect(errorEvents.map((event) => event.fatal)).toEqual([false, true]);
    expect(result).toMatchObject({
      error: { code: "runner_failed", message: "runner failed" },
      status: "failed",
    });
    expect("subsequentErrors" in result).toBe(false);
  });

  test("preserves later failures in event order", async () => {
    const harness = createFakeKernelHarness();
    let finalStatusStaged = false;
    let headReadFailed = false;
    const kernel = {
      ...harness.kernel,
      branch: {
        ...harness.kernel.branch,
        async get(branchId) {
          if (finalStatusStaged && !headReadFailed) {
            headReadFailed = true;
            throw new Error("post-failure head read failed");
          }
          return await harness.kernel.branch.get(branchId);
        },
      },
      staging: {
        ...harness.kernel.staging,
        async stage(runId, blob, taskId, objectType, status, interruptPayload) {
          if (taskId === "runtime_status_final") {
            if (headReadFailed) {
              throw new Error("failure status staging failed");
            }
            finalStatusStaged = true;
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
    } satisfies RuntimeKernel;
    const runner = {
      execute: fromSynchronousVariadicAwaited(() => ({
        resolution: {
          error: new TuvrenRuntimeError("runner failed first", {
            code: "runner_failed",
          }),
          fatality: "hard" as const,
          type: "fail" as const,
        },
      })),
      id: "fake",
    } satisfies RuntimeRunner;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Fail during finalization"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errors = events.filter((event) => event.type === "error");
    const result = await handle.awaitResult();

    expect(errors.map((event) => event.error.message)).toEqual([
      "runner failed first",
      "post-failure head read failed",
      "failure status staging failed",
    ]);
    expect(result).toMatchObject({
      error: { code: "runner_failed", message: "runner failed first" },
      status: "failed",
      subsequentErrors: [
        { message: "post-failure head read failed" },
        { message: "failure status staging failed" },
      ],
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
            throw Object.assign(
              new Error("final runtime status staging failed"),
              {
                code: "ERR_FINALIZATION",
              }
            );
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
    } satisfies RuntimeKernel;
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "fake",
      kernel,
      runnerRegistry: createRunnerRegistry(),
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      runnerId: "missing-runner",
      signal: textSignal("Trigger finalize failure"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const result = await handle.awaitResult();

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "turn.end")).toBe(false);
    expect(
      errorEvents.some((event) => event.error.code === "unknown_runner")
    ).toBe(true);
    expect(
      errorEvents.some(
        (event) => event.error.message === "final runtime status staging failed"
      )
    ).toBe(true);
    expect(errorEvents.map((event) => event.fatal)).toEqual([true, false]);
    expect(errorEvents[1]?.error.code).toBe("ERR_FINALIZATION");
    expect(result).toMatchObject({
      error: {
        code: "unknown_runner",
        message: 'runner "missing-runner" is not registered',
      },
      status: "failed",
      subsequentErrors: [
        {
          code: "execution_failed",
          message: "final runtime status staging failed",
        },
      ],
    });
    if (result.status !== "failed") {
      throw new Error("expected a failed execution result");
    }
    expect(result.error).toBeInstanceOf(TuvrenRuntimeError);
    expect(result.subsequentErrors?.[0]).toBeInstanceOf(TuvrenRuntimeError);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "running",
    });
  });
});
