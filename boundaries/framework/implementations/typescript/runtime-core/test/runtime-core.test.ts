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
import type { KrakenDriver } from "@kraken/framework-driver-api";
import type {
  AgentConfig,
  HandoffContextPlan,
  HandoffSourceContext,
  InputSignal,
  KrakenMessage,
  KrakenStreamEvent,
  KrakenToolDefinition,
} from "@kraken/framework-runtime-api";
import type { TurnTreeSchema } from "@kraken/kernel-contract-protocol";
import {
  collectSystemPrompts,
  createContextManifest,
  createDriverRegistry,
  createKrakenRuntimeCore,
  createOrchestrationRuntime,
  createPreserveTraceHandoffContextBuilder,
  createToolRegistry,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";

describe("framework-runtime-core", () => {
  test("builds tool registries and rejects duplicate tool names across extensions", () => {
    const registry = createToolRegistry(
      [
        {
          description: "Search documentation",
          execute() {
            return {};
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
      [
        {
          name: "docs",
          tools: [
            {
              description: "Summarize content",
              execute() {
                return {};
              },
              inputSchema: {
                type: "object",
              },
              name: "summarize",
            },
          ],
        },
      ]
    );

    expect(registry.has("search")).toBe(true);
    expect(registry.has("summarize")).toBe(true);
    expect(() =>
      createToolRegistry(
        [
          {
            description: "Search documentation",
            execute() {
              return {};
            },
            inputSchema: {
              type: "object",
            },
            name: "search",
          },
        ],
        [
          {
            name: "docs",
            tools: [
              {
                description: "Duplicate search",
                execute() {
                  return {};
                },
                inputSchema: {
                  type: "object",
                },
                name: "search",
              },
            ],
          },
        ]
      )
    ).toThrow("already registered");
  });

  test("rejects duplicate extension names before runtime state can alias", () => {
    expect(() =>
      createToolRegistry(
        [],
        [
          {
            name: "shared",
          },
          {
            name: "shared",
          },
        ]
      )
    ).toThrow('extension "shared" is already registered');
  });

  test("collectSystemPrompts reports non-fatal prompt contribution failures", () => {
    const issues: Array<{ extensionName: string; message: string }> = [];
    const prompts = collectSystemPrompts(
      [
        {
          name: "broken",
          systemPrompt() {
            throw new Error("prompt failed");
          },
        },
        {
          name: "working",
          systemPrompt: "Visible prompt",
        },
      ],
      {
        byRole: {
          assistant: 0,
          system: 0,
          tool: 0,
          user: 0,
        },
        extensions: {},
        lastAssistantMessageIndex: -1,
        lastUserMessageIndex: -1,
        messageCount: 0,
        tokenEstimate: 0,
        toolCalls: {
          byName: {},
          total: 0,
        },
        toolResults: {
          byName: {},
          total: 0,
        },
        turnBoundaries: [],
      },
      1,
      {
        onError(input) {
          issues.push({
            extensionName: input.extensionName,
            message: input.error.message,
          });
        },
      }
    );

    expect(prompts).toEqual(["Visible prompt"]);
    expect(issues).toEqual([
      {
        extensionName: "broken",
        message: "prompt failed",
      },
    ]);
  });

  test("counts file payload bytes in tokenEstimate", () => {
    const payload = new Uint8Array(4096);
    const manifest = createContextManifest([
      {
        parts: [
          {
            data: payload,
            filename: "attachment.bin",
            mediaType: "application/octet-stream",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);

    expect(manifest.tokenEstimate).toBe(
      Math.ceil(
        (payload.byteLength +
          "attachment.bin".length +
          "application/octet-stream".length) /
          4
      )
    );
  });

  test("executes a driver-neutral turn and persists the input plus assistant output", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-1",
          text: "Hello from Kraken.",
          timestamp: context.runtime.now(),
          type: "text.done",
        });

        return {
          activeAgent: context.config.name,
          messages: [assistantText("Hello from Kraken.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Hello Kraken"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(events.map((event) => event.type)).toContain("turn.start");
    expect(events.map((event) => event.type)).toContain("iteration.start");
    expect(events.map((event) => event.type)).toContain("turn.end");
    expect(handle.status().phase).toBe("completed");
    expect(messages).toHaveLength(2);
  });

  test("fails malformed driver messages before they can be checkpointed", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
          messages: JSON.parse('[{"role":"assistant","parts":[123]}]'),
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject malformed driver output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_kraken_message");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject malformed driver output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("merges per-turn tools with agent-configured tools at turn start", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
          messages: [
            assistantText(
              [
                `configured:${String(context.toolRegistry.has("configured"))}`,
                `adhoc:${String(context.toolRegistry.has("adhoc"))}`,
              ].join("|")
            ),
          ],
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
    const runtime = createKrakenRuntimeCore({
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
            description: "Configured tool",
            execute() {
              return {
                configured: true,
              };
            },
            inputSchema: {
              type: "object",
            },
            name: "configured",
          },
        ],
      },
      signal: textSignal("Merge tools"),
      threadId: thread.threadId,
      tools: [
        {
          description: "Ad-hoc tool",
          execute() {
            return {
              adhoc: true,
            };
          },
          inputSchema: {
            type: "object",
          },
          name: "adhoc",
        },
      ],
    });

    await collectEvents(handle.events());

    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "configured:true|adhoc:true"
      )
    ).toBe(true);
  });

  test("implicitly links follow-up turns to the previous branch turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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

  test("preserves custom thread schemas through final turn-status checkpoints", async () => {
    const harness = createFakeKernelHarness();
    const customSchema = {
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
      schemaId: "custom.agent.v1",
    } satisfies TurnTreeSchema;
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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

  test("finalizes durable runtime status for post-start fatal failures", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createKrakenRuntimeCore({
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

    const events = await collectEvents(handle.events());
    const failedTurnId = extractTurnId(events);

    expect(handle.status().phase).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
      turnId: failedTurnId,
    });
  });

  test("rejects branch and thread mismatches before creating a turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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

  test("seeds extension initial state into the first turn manifest", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
          messages: [assistantText("Extension state observed.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            beforeTurn(context) {
              context.emit({
                data: context.extensionState,
                name: "seed.beforeTurn",
              });
              return undefined;
            },
            name: "seeded",
            state: {
              seeded: true,
            },
          },
        ],
        name: "primary",
      },
      signal: textSignal("Observe extension state"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const seedEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "seed.beforeTurn"
    );

    expect(seedEvent?.data).toEqual({
      seeded: true,
    });
    expect(handle.status().manifest?.extensions.seeded).toEqual({
      seeded: true,
    });
  });

  test("persists beforeTurn state updates on terminal short-circuits", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(context) {
        driverCalls += 1;
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            beforeTurn() {
              return {
                state: {
                  seeded: true,
                },
                reason: "stop before turn",
                verdict: "endTurn",
              };
            },
            name: "seeded",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Short-circuit beforeTurn"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(driverCalls).toBe(0);
    expect(handle.status().manifest?.extensions.seeded).toEqual({
      seeded: true,
    });
  });

  test("persists beforeIteration state updates on terminal verdicts", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(context) {
        driverCalls += 1;
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            beforeIteration() {
              return {
                state: {
                  seeded: true,
                },
                reason: "stop before iteration",
                verdict: "endTurn",
              };
            },
            name: "seeded",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Short-circuit beforeIteration"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(driverCalls).toBe(0);
    expect(handle.status().manifest?.extensions.seeded).toEqual({
      seeded: true,
    });
  });

  test("times out beforeIteration hooks as soft failures instead of stalling the turn", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(context) {
        driverCalls += 1;
        return {
          activeAgent: context.config.name,
          messages: [assistantText("Driver still completed.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async beforeIteration() {
              await delay(30);
              return undefined;
            },
            name: "slow-hook",
            timeout: 5,
          },
        ],
        name: "primary",
      },
      signal: textSignal("Timeout hook"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(driverCalls).toBe(1);
    expect(handle.status().phase).toBe("completed");
    expect(errorEvent?.fatal).toBe(false);
    expect(errorEvent?.error.message).toContain(
      'extension "slow-hook" beforeIteration timed out after 5ms'
    );
  });

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
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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

  test("rejects invalid context-engineering helper messages with a validation error", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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
    expect(errorEvent?.error.code).toBe("invalid_kraken_message");
  });

  test("fails invalid context-engineering plans before corrupting the branch head", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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

  test("pauses for mixed approval batches and resumes only unfinished tool calls", async () => {
    const harness = createFakeKernelHarness();
    let afterIterationCount = 0;
    let searchCalls = 0;
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessageCount = context.messages.filter(
          (message) => message.role === "tool"
        ).length;

        if (toolMessageCount === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "latest status" },
                  name: "search",
                },
                {
                  callId: "call-email",
                  input: { subject: "Status update", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [
            assistantText(`Handled ${toolMessageCount} tool results.`),
          ],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const tools: KrakenToolDefinition[] = [
      {
        description: "Search the latest status",
        execute(input: unknown) {
          searchCalls += 1;
          return {
            query: (input as { query: string }).query,
            status: "ok",
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
      {
        approval: true,
        description: "Send a status email",
        execute(input: unknown) {
          emailCalls += 1;
          return {
            sent: true,
            to: (input as { to: string }).to,
          };
        },
        inputSchema: {
          properties: {
            subject: { type: "string" },
            to: { type: "string" },
          },
          required: ["to", "subject"],
          type: "object",
        },
        name: "email",
      },
    ];
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            afterIteration() {
              afterIterationCount += 1;
              return undefined;
            },
            name: "after-iteration-observer",
          },
        ],
        name: "primary",
        tools,
      },
      signal: textSignal("Need approval"),
      threadId: thread.threadId,
    });

    const pausedEvents = await collectEvents(pausedHandle.events());
    expect(pausedHandle.status().phase).toBe("paused");
    expect(afterIterationCount).toBe(0);
    expect(searchCalls).toBe(1);
    expect(emailCalls).toBe(0);
    expect(pausedHandle.status().approval?.completedResults).toHaveLength(1);
    expect(pausedEvents.map((event) => event.type)).toContain(
      "approval.requested"
    );
    expect(
      pausedEvents.some(
        (event) => event.type === "tool.start" && event.callId === "call-search"
      )
    ).toBe(true);
    expect(
      pausedEvents.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-search"
      )
    ).toBe(true);

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(resumedEvents[0]?.type).toBe("turn.start");
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(true);
    expect(
      resumedEvents.some(
        (event) => event.type === "tool.start" && event.callId === "call-email"
      )
    ).toBe(true);
    expect(
      resumedEvents.some(
        (event) => event.type === "tool.result" && event.callId === "call-email"
      )
    ).toBe(true);
    expect(searchCalls).toBe(1);
    expect(emailCalls).toBe(1);
    expect(afterIterationCount).toBe(2);
    expect(messages).toHaveLength(5);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("invalidates a paused execution handle after approval resume", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Resume", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Approval resolved once.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send email once",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause once"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const approval = {
      decisions: [{ callId: "call-email", type: "approve" }],
    };
    const resumedHandle = pausedHandle.resolveApproval(approval);

    expect(pausedHandle.status().approval).toBeUndefined();
    expect(() => pausedHandle.resolveApproval(approval)).toThrow(
      "resolveApproval() is only valid while execution is paused"
    );

    await collectEvents(resumedHandle.events());
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("persists paused runtime status with the framework-owned active agent", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          activeAgent: "other-agent",
          messages: [
            assistantToolCalls([
              {
                callId: "call-email",
                input: { subject: "Pause", to: "ops@example.com" },
                name: "email",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createKrakenRuntimeCore({
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
            approval: true,
            description: "Pause with approval",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause with framework agent"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const turnId = extractTurnId(events);

    expect(handle.status().phase).toBe("paused");
    expect(handle.status().activeAgent).toBe("primary");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      iterationCount: 1,
      pauseReason: "approval_required",
      state: "paused",
      turnId,
    });
  });

  test("durably fails paused turns when the host cancels after approval pause", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Cancel", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("This should not resume.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Pause for cancellation",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause then cancel"),
      threadId: thread.threadId,
    });

    const pausedEvents = await collectEvents(pausedHandle.events());
    const pausedTurnId = extractTurnId(pausedEvents);
    pausedHandle.cancel();

    await waitForAsync(async () => {
      const runtimeStatus = await harness.readBranchRuntimeStatus(
        thread.branchId
      );

      return (
        runtimeStatus !== null &&
        typeof runtimeStatus === "object" &&
        "state" in runtimeStatus &&
        runtimeStatus.state === "failed"
      );
    });

    expect(pausedHandle.status().phase).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
      turnId: pausedTurnId,
    });
  });

  test("keeps later resumed tool results when an earlier resumed call pauses again", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-review",
                  input: { item: "proposal" },
                  name: "review",
                },
                {
                  callId: "call-search",
                  input: { query: "follow-up" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting for the remaining approval.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool(context, next) {
              if (
                context.tool.name === "review" &&
                context.approvalDecision?.type === "approve"
              ) {
                return {
                  approval: {
                    completedResults: [],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "Need a second approval for review.",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Review a proposal",
            execute() {
              return {
                reviewed: true,
              };
            },
            inputSchema: {
              properties: {
                item: { type: "string" },
              },
              required: ["item"],
              type: "object",
            },
            name: "review",
          },
          {
            approval: true,
            description: "Run a follow-up search",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: (input as { query: string }).query,
                status: "ok",
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
      signal: textSignal("Resume both tools"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-review", type: "approve" },
        { callId: "call-search", type: "approve" },
      ],
    });

    await collectEvents(resumedHandle.events());

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("paused");
    expect(resumedHandle.status().approval?.completedResults).toHaveLength(1);
    expect(resumedHandle.status().manifest?.toolResults.total).toBe(1);
  });

  test("rejects malformed aroundTool approval requests before pause state is published", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid approval" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool(context) {
              return {
                approval: {
                  completedResults: [
                    {
                      callId: context.callId,
                      name: context.tool.name,
                      output: { duplicate: true },
                      type: "tool_result",
                    },
                  ],
                  toolCalls: [
                    {
                      callId: context.callId,
                      decisions: ["approve"],
                      input: context.input,
                      message: "Duplicate call id should be rejected.",
                      name: context.tool.name,
                    },
                  ],
                },
                verdict: "pause",
              };
            },
            name: "broken-approval",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search once",
            execute() {
              return {
                ok: true,
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
      signal: textSignal("Reject invalid approval request"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
  });

  test("returns the executed result when aroundTool pauses after next()", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "run once" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Tool completed once.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(context, next) {
              await next();
              return {
                approval: {
                  completedResults: [],
                  toolCalls: [
                    {
                      callId: context.callId,
                      decisions: ["approve"],
                      input: context.input,
                      message: "This pause should be ignored.",
                      name: context.tool.name,
                    },
                  ],
                },
                state: {
                  attemptedPauseAfterNext: true,
                },
                verdict: "pause",
              };
            },
            name: "late-pause",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search once",
            execute(input: unknown) {
              executeCalls += 1;
              return {
                query: readQueryInput(input),
                status: "ok",
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
      signal: textSignal("Late pause"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(executeCalls).toBe(1);
    expect(handle.status().phase).toBe("completed");
    expect(handle.status().approval).toBeUndefined();
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(handle.status().manifest?.extensions["late-pause"]).toEqual({
      attemptedPauseAfterNext: true,
    });
  });

  test("surfaces after-next aroundTool errors without discarding the executed result", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "preserve result" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("After-next error was surfaced.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            async aroundTool(_context, next) {
              await next();
              await delay(1);
              throw new Error("aroundTool exploded after next");
            },
            name: "post-next-error",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search successfully",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                status: "ok",
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
      signal: textSignal("Surface after-next error"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(handle.status().phase).toBe("completed");
    expect(errorEvent?.fatal).toBe(false);
    expect(errorEvent?.error.message).toBe("aroundTool exploded after next");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts[0]).toEqual({
      callId: "call-search",
      name: "search",
      output: {
        query: "preserve result",
        status: "ok",
      },
      type: "tool_result",
    });
  });

  test("emits tool.result when each parallel tool finishes instead of after the slowest call", async () => {
    const harness = createFakeKernelHarness();
    const timeline: string[] = [];
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
                {
                  callId: "call-slow",
                  input: { query: "slow" },
                  name: "slow",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Tools finished.")],
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
    const runtime = createKrakenRuntimeCore({
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
            description: "Finish immediately",
            execute(input: unknown) {
              timeline.push(`fast-complete:${readQueryInput(input)}`);
              return {
                status: "fast",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "fast",
          },
          {
            description: "Finish after a delay",
            async execute(input: unknown) {
              await delay(20);
              timeline.push(`slow-complete:${readQueryInput(input)}`);
              return {
                status: "slow",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "slow",
          },
        ],
      },
      signal: textSignal("Run parallel tools"),
      threadId: thread.threadId,
    });

    await collectToolResultTimeline(handle.events(), timeline);

    expect(timeline).toEqual([
      "fast-complete:fast",
      "event:call-fast",
      "slow-complete:slow",
      "event:call-slow",
    ]);
  });

  test("incrementally stages completed tool results before slower siblings finish", async () => {
    const harness = createFakeKernelHarness();
    let releaseSlowTool: (() => void) | undefined;
    const slowTool = new Promise<void>((resolve) => {
      releaseSlowTool = resolve;
    });
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
                {
                  callId: "call-slow",
                  input: { query: "slow" },
                  name: "slow",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Tools finished.")],
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
    const runtime = createKrakenRuntimeCore({
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
            description: "Finish immediately",
            execute() {
              return {
                status: "fast",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "fast",
          },
          {
            description: "Wait for release",
            async execute() {
              await slowTool;
              return {
                status: "slow",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "slow",
          },
        ],
      },
      signal: textSignal("Run staged tools"),
      threadId: thread.threadId,
    });
    const eventsPromise = collectEvents(handle.events());

    await waitForAsync(async () => {
      const stagedMessages = await harness.readRunningStagedMessages(
        thread.branchId
      );
      return stagedMessages.some(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "tool"
      );
    });

    const stagedMessages = await harness.readRunningStagedMessages(
      thread.branchId
    );

    expect(extractToolMessages(stagedMessages)).toHaveLength(1);

    releaseSlowTool?.();
    await eventsPromise;
  });

  test("persists tool messages in call order even when parallel completion order differs", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-slow",
                  input: { query: "slow-first" },
                  name: "slow",
                },
                {
                  callId: "call-fast",
                  input: { query: "fast-second" },
                  name: "fast",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Persisted in call order.")],
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
    const runtime = createKrakenRuntimeCore({
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
            description: "Complete after a delay",
            async execute(input: unknown) {
              await delay(20);
              return {
                query: readQueryInput(input),
                status: "slow",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "slow",
          },
          {
            description: "Complete immediately",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                status: "fast",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "fast",
          },
        ],
      },
      signal: textSignal("Persist ordered tools"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(
      toolMessages.map((message) =>
        message.parts[0]?.type === "tool_result" ? message.parts[0].callId : ""
      )
    ).toEqual(["call-slow", "call-fast"]);
  });

  test("times out long-running tools into tool_result errors", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-slow",
                  input: { query: "timeout" },
                  name: "slow",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Timed out tool was handled.")],
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
    const runtime = createKrakenRuntimeCore({
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
            description: "Time out",
            async execute() {
              await delay(30);
              return {
                status: "late",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "slow",
            timeout: 5,
          },
        ],
      },
      signal: textSignal("Timeout tool"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts[0]).toEqual({
      callId: "call-slow",
      isError: true,
      name: "slow",
      output: {
        error: 'tool "slow" timed out after 5ms',
      },
      type: "tool_result",
    });
  });

  test("treats thrown CustomSchema validators as tool input validation errors", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-custom",
                  input: { query: "boom" },
                  name: "custom",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Recovered from validator error.")],
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
    const runtime = createKrakenRuntimeCore({
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
            description: "Throwing schema",
            execute() {
              return {
                ok: true,
              };
            },
            inputSchema: {
              toJSONSchema() {
                return {
                  properties: {
                    query: { type: "string" },
                  },
                  required: ["query"],
                  type: "object",
                };
              },
              validate() {
                throw new Error("validator exploded");
              },
            },
            name: "custom",
          },
        ],
      },
      signal: textSignal("Throw in validator"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(handle.status().phase).toBe("completed");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.parts[0]).toEqual({
      callId: "call-custom",
      isError: true,
      name: "custom",
      output: {
        details: {
          error: "validator exploded",
        },
        error: "Tool input failed validation.",
      },
      type: "tool_result",
    });
  });

  test("synthesizes rejected approval results without executing the tool", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Status update", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Acknowledged rejected tool.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send a status email",
            execute() {
              emailCalls += 1;
              return { sent: true };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Reject this tool"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "reject" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const rejectedToolMessage = messages.find(
      (message): message is Extract<KrakenMessage, { role: "tool" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool"
    );

    expect(emailCalls).toBe(0);
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "tool.result" &&
          event.callId === "call-email" &&
          event.isError === true
      )
    ).toBe(true);
    expect(rejectedToolMessage?.parts[0]?.type).toBe("tool_result");
    if (rejectedToolMessage?.parts[0]?.type === "tool_result") {
      expect(rejectedToolMessage.parts[0].isError).toBe(true);
      expect(JSON.stringify(rejectedToolMessage.parts[0].output)).toContain(
        "rejected"
      );
    }
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("resumes aroundTool approval gates through the shared executor", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "gated search" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Search completed after approval.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            aroundTool: async (context, next) => {
              if (context.approvalDecision === undefined) {
                return {
                  approval: {
                    completedResults: [],
                    toolCalls: [
                      {
                        callId: context.callId,
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "Approve the wrapped search?",
                        name: context.tool.name,
                      },
                    ],
                  },
                  state: { gated: true },
                  verdict: "pause",
                };
              }

              return {
                result: await next(),
                state: { approved: true },
              };
            },
            name: "approval-wrapper",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search the latest status",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: (input as { query: string }).query,
                status: "ok",
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
      signal: textSignal("Gate this search"),
      threadId: thread.threadId,
    });

    const pausedEvents = await collectEvents(pausedHandle.events());
    expect(pausedHandle.status().phase).toBe("paused");
    expect(searchCalls).toBe(0);
    expect(
      pausedHandle
        .status()
        .approval?.toolCalls.map((toolCall) => toolCall.callId)
    ).toEqual(["call-search"]);
    expect(
      pausedEvents.some(
        (event) => event.type === "tool.start" && event.callId === "call-search"
      )
    ).toBe(false);

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-search", type: "approve" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const manifest = resumedHandle.status().manifest;

    expect(searchCalls).toBe(1);
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-search"
      )
    ).toBe(true);
    expect(
      manifest?.extensions["approval-wrapper"] as Record<string, unknown>
    ).toEqual({
      approved: true,
      gated: true,
    });
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("status() returns deep-cloned manifest and approval snapshots", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Hello", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Email sent.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [
          {
            name: "stateful",
            state: {
              seeded: true,
            },
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send email",
            execute() {
              return {
                sent: true,
              };
            },
            inputSchema: {
              properties: {
                subject: { type: "string" },
                to: { type: "string" },
              },
              required: ["to", "subject"],
              type: "object",
            },
            name: "email",
          },
        ],
      },
      signal: textSignal("Pause and clone"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const firstStatus = pausedHandle.status();

    if (
      firstStatus.approval === undefined ||
      firstStatus.manifest === undefined
    ) {
      throw new Error("expected paused approval state");
    }

    firstStatus.approval.toolCalls[0].callId = "mutated";
    firstStatus.manifest.extensions.stateful = {
      seeded: false,
    };
    firstStatus.manifest.byRole.user = 999;

    const secondStatus = pausedHandle.status();

    expect(secondStatus.approval?.toolCalls[0]?.callId).toBe("call-email");
    expect(secondStatus.manifest?.extensions.stateful).toEqual({
      seeded: true,
    });
    expect(secondStatus.manifest?.byRole.user).toBe(1);
  });

  test("isolates event payloads between concurrent subscribers", async () => {
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
          activeAgent: context.config.name,
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
    const runtime = createKrakenRuntimeCore({
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

    const [eventsA, eventsB] = await Promise.all([
      collectEvents(handle.events()),
      collectEvents(handle.events()),
    ]);
    const customEventA = eventsA.find(
      (event): event is Extract<(typeof eventsA)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "shared.payload"
    );
    const customEventB = eventsB.find(
      (event): event is Extract<(typeof eventsB)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "shared.payload"
    );

    if (
      customEventA === undefined ||
      customEventB === undefined ||
      !hasCountData(customEventA.data) ||
      !hasCountData(customEventB.data)
    ) {
      throw new Error("expected both subscribers to receive the payload event");
    }

    customEventA.data.count = 99;

    expect(customEventB.data.count).toBe(1);
  });

  test("applies handoffs through the shared runtime layer and swaps active agents", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffBuilder = createPreserveTraceHandoffContextBuilder();
    const handoffDriver = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            activeAgent: "primary",
            messages: [assistantText("Passing this to review.")],
            resolution: {
              contextPlan: buildHandoffPlan(
                context,
                agents.primary,
                agents.reviewer,
                handoffBuilder
              ),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          activeAgent: "reviewer",
          messages: [assistantText("Review complete.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([handoffDriver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(
      events.some(
        (event) => event.type === "custom" && event.name === "handoff.start"
      )
    ).toBe(true);
    expect(handle.status().activeAgent).toBe("reviewer");
    expect(handle.status().phase).toBe("completed");
  });

  test("seeds target extension state during handoff before the next iteration hooks run", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: {
        extensions: [
          {
            beforeIteration(context) {
              context.emit({
                data: context.extensionState,
                name: "reviewer.state",
              });
              return undefined;
            },
            name: "reviewer-state",
            state: {
              enabled: true,
            },
          },
        ],
        name: "reviewer",
      },
    };
    const handoffBuilder = createPreserveTraceHandoffContextBuilder();
    const handoffDriver = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            activeAgent: "primary",
            messages: [assistantText("Passing this to review.")],
            resolution: {
              contextPlan: buildHandoffPlan(
                context,
                agents.primary,
                agents.reviewer,
                handoffBuilder
              ),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          activeAgent: "reviewer",
          messages: [assistantText("Review complete.")],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([handoffDriver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start seeded handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const reviewerStateEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "reviewer.state"
    );

    expect(reviewerStateEvent?.data).toEqual({
      enabled: true,
    });
    expect(handle.status().manifest?.extensions["reviewer-state"]).toEqual({
      enabled: true,
    });
  });

  test("fails invalid handoff builders before persisting a corrupted branch head", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffDriver = {
      async execute(context) {
        return {
          activeAgent: "primary",
          messages: [],
          resolution: {
            contextPlan: {
              mode: "broken",
              reason: "return a missing hash",
              builder() {
                return ["missing-handoff-message"];
              },
              sourceContext: {
                handoffIntent: {
                  targetAgent: "reviewer",
                },
                helpers: {
                  loadMessage() {
                    return null;
                  },
                  storeMessage() {
                    return "unused";
                  },
                  storeMessages() {
                    return [];
                  },
                },
                manifest: context.manifest,
                messages: context.messages,
                sourceAgent: agents.primary,
                targetAgent: agents.reviewer,
              },
              targetAgent: "reviewer",
            },
            targetAgent: "reviewer",
            type: "handoff",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([handoffDriver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start broken handoff"),
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
        parts: [{ text: "Start broken handoff", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("preserve_trace handoff summarizes assistant work without raw tool traces", () => {
    let storedMessage: KrakenMessage | null = null;
    const builder = createPreserveTraceHandoffContextBuilder();

    builder({
      handoffIntent: {
        reason: "delegate",
        targetAgent: "reviewer",
      },
      helpers: {
        loadMessage() {
          return null;
        },
        storeMessage(message) {
          storedMessage = message;
          return "0".repeat(64);
        },
        storeMessages() {
          return [];
        },
      },
      manifest: {
        byRole: {
          assistant: 1,
          system: 0,
          tool: 1,
          user: 1,
        },
        extensions: {},
        lastAssistantMessageIndex: 1,
        lastUserMessageIndex: 0,
        messageCount: 3,
        tokenEstimate: 0,
        toolCalls: {
          byName: {
            search: 1,
          },
          total: 1,
        },
        toolResults: {
          byName: {
            search: 1,
          },
          total: 1,
        },
        turnBoundaries: [0],
      },
      messages: [
        {
          parts: [{ text: "Please investigate.", type: "text" }],
          role: "user",
        },
        {
          parts: [
            { redacted: false, text: "private reasoning", type: "reasoning" },
            { text: "Visible summary", type: "text" },
            {
              callId: "call-search",
              input: { query: "leak me" },
              name: "search",
              type: "tool_call",
            },
            {
              data: { secret: true },
              name: "internal_payload",
              type: "structured",
            },
          ],
          role: "assistant",
        },
        {
          parts: [
            {
              callId: "call-search",
              name: "search",
              output: { result: "okay" },
              type: "tool_result",
            },
          ],
          role: "tool",
        },
      ],
      sourceAgent: { name: "primary" },
      targetAgent: { name: "reviewer" },
    } satisfies HandoffSourceContext);

    const handoffText = extractSingleUserText(storedMessage);

    expect(handoffText).toContain("Visible summary");
    expect(handoffText).toContain("[Structured output produced]");
    expect(handoffText).not.toContain("private reasoning");
    expect(handoffText).not.toContain("leak me");
    expect(handoffText).not.toContain('"secret":true');
  });

  test("preserves per-turn tools across handoff transitions", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffDriver = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            activeAgent: "primary",
            messages: [assistantText("Passing this to review.")],
            resolution: {
              contextPlan: buildHandoffPlan(
                context,
                agents.primary,
                agents.reviewer,
                createPreserveTraceHandoffContextBuilder()
              ),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

        return {
          activeAgent: "reviewer",
          messages: [
            assistantText(`adhoc:${String(context.toolRegistry.has("adhoc"))}`),
          ],
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
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([handoffDriver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start handoff"),
      threadId: thread.threadId,
      tools: [
        {
          description: "Ad-hoc tool",
          execute() {
            return {
              adhoc: true,
            };
          },
          inputSchema: {
            type: "object",
          },
          name: "adhoc",
        },
      ],
    });

    await collectEvents(handle.events());

    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "adhoc:true"
      )
    ).toBe(true);
  });

  test("does not start orchestration parent execution before an event stream is consumed", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute(context) {
        executeCount += 1;
        return {
          activeAgent: context.config.name,
          messages: [assistantText("Started after subscription.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Wait to start"),
      threadId: thread.threadId,
    });

    await delay(50);
    expect(executeCount).toBe(0);

    const events = await collectEvents(handle.events());

    expect(executeCount).toBe(1);
    expect(events.map((event) => event.type)).toContain("turn.end");
  });

  test("rejects launching workers before the parent handle has started execution", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute(context) {
        executeCount += 1;
        return {
          activeAgent: context.config.name,
          messages: [assistantText("Parent started only after subscription.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Stay lazy"),
      threadId: thread.threadId,
    });

    await expect(
      orchestration.launchWorker(
        "worker",
        {
          task: "too-early",
        },
        {
          parent: handle,
        }
      )
    ).rejects.toThrow(
      "launchWorker() requires the parent handle to start execution first"
    );
    expect(executeCount).toBe(0);
  });

  test("bridges worker execution through the orchestration runtime", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          context.runtime.emit({
            messageId: "worker-message",
            text: "Worker complete.",
            timestamp: context.runtime.now(),
            type: "text.done",
          });
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker complete.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (
          workerResult?.status === "completed" &&
          workerResult.output === "Worker complete."
        ) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent saw the worker result.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(20);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting for worker.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Start worker"),
      threadId: thread.threadId,
    });

    const eventsPromise = collectEvents(handle.events());
    const parentEventsPromise = collectEvents(handle.parentEvents());
    await delay(0);
    const workerId = await orchestration.launchWorker("worker", {
      task: "research",
    });
    const workerResult = await orchestration.awaitWorker(workerId);
    const events = await eventsPromise;
    const parentEvents = await parentEventsPromise;

    expect(workerResult).toBe("Worker complete.");
    expect(
      events.some(
        (event) =>
          event.source?.workerId === workerId && event.type === "text.done"
      )
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "custom" && event.name === "worker.completed"
      )
    ).toBe(true);
    expect(parentEvents.every((event) => event.source === undefined)).toBe(
      true
    );
    expect(handle.status().phase).toBe("completed");
  });

  test("launches workers against the explicit parent handle when multiple sessions coexist", async () => {
    const harness = createFakeKernelHarness();
    let threadAId = "";
    let threadBId = "";
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker bound to parent A.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (context.threadId === threadAId) {
          if (
            workerResult?.status === "completed" &&
            workerResult.output === "Worker bound to parent A."
          ) {
            return {
              activeAgent: "primary",
              messages: [assistantText("A received its worker.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await delay(10);
          return {
            activeAgent: "primary",
            messages: [assistantText("A is waiting.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        if (context.threadId === threadBId) {
          if (workerResult !== null) {
            return {
              activeAgent: "primary",
              messages: [assistantText("B received the wrong worker.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          return {
            activeAgent: "primary",
            messages: [assistantText("B stayed isolated.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        throw new Error(`unexpected thread "${context.threadId}"`);
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const threadA = await framework.createThread({});
    threadAId = threadA.threadId;
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Run A"),
      threadId: threadA.threadId,
    });
    const eventsAPromise = collectEvents(handleA.events());

    const threadB = await framework.createThread({});
    threadBId = threadB.threadId;
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Run B"),
      threadId: threadB.threadId,
    });
    const eventsBPromise = collectEvents(handleB.events());

    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "bound-parent",
      },
      {
        parent: handleA,
      }
    );
    await orchestration.awaitWorker(workerId, {
      parent: handleA,
    });
    const eventsA = await eventsAPromise;
    await eventsBPromise;
    const messagesA = await harness.readBranchMessages(threadA.branchId);
    const messagesB = await harness.readBranchMessages(threadB.branchId);

    expect(
      eventsA.some(
        (event) =>
          event.type === "custom" &&
          event.name === "worker.completed" &&
          event.source?.workerId === workerId
      )
    ).toBe(true);
    expect(hasAssistantText(messagesA, "A received its worker.")).toBe(true);
    expect(hasAssistantText(messagesB, "B received the wrong worker.")).toBe(
      false
    );
  });

  test("exposes only session-local workers on each orchestration handle", async () => {
    const harness = createFakeKernelHarness();
    let threadAId = "";
    let threadBId = "";
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          await delay(20);
          return {
            activeAgent: "worker",
            messages: [assistantText(`Worker for ${context.threadId}.`)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (context.threadId === threadAId || context.threadId === threadBId) {
          if (workerResult !== null) {
            return {
              activeAgent: "primary",
              messages: [assistantText(`Parent got ${workerResult.workerId}.`)],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          await delay(10);
          return {
            activeAgent: "primary",
            messages: [assistantText("Waiting.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        throw new Error(`unexpected thread "${context.threadId}"`);
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const threadA = await framework.createThread({});
    threadAId = threadA.threadId;
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Run A"),
      threadId: threadA.threadId,
    });
    const eventsAPromise = collectEvents(handleA.events());

    const threadB = await framework.createThread({});
    threadBId = threadB.threadId;
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Run B"),
      threadId: threadB.threadId,
    });
    const eventsBPromise = collectEvents(handleB.events());

    const workerA = await orchestration.launchWorker(
      "worker",
      {
        task: "A",
      },
      {
        parent: handleA,
      }
    );
    const workerB = await orchestration.launchWorker(
      "worker",
      {
        task: "B",
      },
      {
        parent: handleB,
      }
    );

    await waitFor(
      () => handleA.workers().has(workerA) && handleB.workers().has(workerB)
    );

    expect([...handleA.workers().keys()]).toEqual([workerA]);
    expect([...handleB.workers().keys()]).toEqual([workerB]);

    await orchestration.awaitWorker(workerA, {
      parent: handleA,
    });
    await orchestration.awaitWorker(workerB, {
      parent: handleB,
    });
    await eventsAPromise;
    await eventsBPromise;
  });

  test("requires the owning parent handle for worker control across concurrent sessions", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        if (context.config.name === "worker") {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              activeAgent: "worker",
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-review",
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
            activeAgent: "worker",
            messages: [assistantText("Worker approved correctly.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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
                return {
                  approved: true,
                };
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
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const threadA = await framework.createThread({});
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Session A"),
      threadId: threadA.threadId,
    });
    detachTestPromise(collectEventsForDuration(handleA.events(), 50));

    const threadB = await framework.createThread({});
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Session B"),
      threadId: threadB.threadId,
    });
    detachTestPromise(collectEventsForDuration(handleB.events(), 50));

    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "approval",
      },
      {
        parent: handleA,
      }
    );

    await waitFor(() => handleA.workers().get(workerId)?.status === "paused");

    await expect(orchestration.awaitWorker(workerId)).rejects.toThrow(
      "awaitWorker() requires { parent } when multiple orchestration sessions exist"
    );
    expect(() =>
      orchestration.resolveWorkerApproval(
        workerId,
        {
          decisions: [{ callId: "call-review", type: "approve" }],
        },
        {
          parent: handleB,
        }
      )
    ).toThrow(
      "resolveWorkerApproval() requires the worker's owning parent handle"
    );

    orchestration.resolveWorkerApproval(
      workerId,
      {
        decisions: [{ callId: "call-review", type: "approve" }],
      },
      {
        parent: handleA,
      }
    );

    const workerResult = await orchestration.awaitWorker(workerId, {
      parent: handleA,
    });

    expect(workerResult).toBe("Worker approved correctly.");
    handleA.cancel();
    handleB.cancel();
  });

  test("does not keep historical worker sessions ambiguous once only one session is active", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          return {
            activeAgent: "worker",
            messages: [assistantText(`Worker for ${context.threadId}.`)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (workerResult !== null) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent saw worker output.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });

    const threadA = await framework.createThread({});
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Session A"),
      threadId: threadA.threadId,
    });
    const eventsAPromise = collectEvents(handleA.events());

    const threadB = await framework.createThread({});
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Session B"),
      threadId: threadB.threadId,
    });
    const eventsBPromise = collectEvents(handleB.events());

    const workerA = await orchestration.launchWorker(
      "worker",
      {
        task: "A",
      },
      {
        parent: handleA,
      }
    );
    const workerB = await orchestration.launchWorker(
      "worker",
      {
        task: "B",
      },
      {
        parent: handleB,
      }
    );

    await orchestration.awaitWorker(workerA, {
      parent: handleA,
    });
    await orchestration.awaitWorker(workerB, {
      parent: handleB,
    });
    await eventsAPromise;
    await eventsBPromise;

    const threadC = await framework.createThread({});
    const handleC = orchestration.executeTurn({
      branchId: threadC.branchId,
      signal: textSignal("Session C"),
      threadId: threadC.threadId,
    });
    const eventsCPromise = collectEvents(handleC.events());

    const workerC = await orchestration.launchWorker("worker", {
      task: "C",
    });
    const workerCResult = await orchestration.awaitWorker(workerC);

    expect(workerCResult).toBe(`Worker for ${workerC}.`);

    handleC.cancel();
    await eventsCPromise;
  });

  test("rejects launching brand-new workers from completed parent sessions", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
          messages: [assistantText("Parent finished.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Finish parent"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    await expect(
      orchestration.launchWorker(
        "worker",
        {
          task: "late worker",
        },
        {
          parent: handle,
        }
      )
    ).rejects.toThrow(
      "launchWorker() requires a running or paused parent handle"
    );
  });

  test("workers() returns deep-cloned approval snapshots", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              activeAgent: "worker",
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-approval",
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
            activeAgent: "worker",
            messages: [assistantText("Worker resumed.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (workerResult !== null) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent resumed worker.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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
              description: "Pause worker approval",
              execute() {
                return {
                  approved: true,
                };
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
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Pause worker snapshot"),
      threadId: thread.threadId,
    });

    const allEventsPromise = collectEvents(handle.allEvents());
    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "approval",
      },
      {
        parent: handle,
      }
    );

    await waitFor(() => handle.workers().get(workerId)?.status === "paused");

    const firstSnapshot = handle.workers().get(workerId);

    if (firstSnapshot?.approval === undefined) {
      throw new Error("expected a paused worker approval snapshot");
    }

    firstSnapshot.approval.toolCalls[0].callId = "mutated-call";

    const secondSnapshot = handle.workers().get(workerId);

    expect(secondSnapshot?.approval?.toolCalls[0]?.callId).toBe(
      "call-approval"
    );

    orchestration.resolveWorkerApproval(workerId, {
      decisions: [{ callId: "call-approval", type: "approve" }],
    });
    await orchestration.awaitWorker(workerId);
    await allEventsPromise;
  });

  test("keeps queued worker results scoped to the paused parent turn", async () => {
    const harness = createFakeKernelHarness();
    let parentAThreadId = "";
    let parentBThreadId = "";
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          await delay(10);
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker A complete.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (context.threadId === parentAThreadId) {
          if (
            workerResult?.status === "completed" &&
            workerResult.output === "Worker A complete."
          ) {
            return {
              activeAgent: "primary",
              messages: [assistantText("A got its worker result.")],
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
              activeAgent: "primary",
              messages: [
                assistantToolCalls([
                  {
                    callId: "hold-a",
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
            activeAgent: "primary",
            messages: [assistantText("Waiting for queued worker.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        if (context.threadId === parentBThreadId) {
          if (workerResult !== null) {
            return {
              activeAgent: "primary",
              messages: [assistantText("B received leaked worker output.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          }

          if (context.iterationCount === 1) {
            await delay(20);
            return {
              activeAgent: "primary",
              messages: [assistantText("B still running cleanly.")],
              resolution: {
                type: "continue_iteration",
              },
            };
          }

          return {
            activeAgent: "primary",
            messages: [assistantText("B stayed clean.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        throw new Error(`unexpected parent thread "${context.threadId}"`);
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });

    const threadA = await framework.createThread({});
    parentAThreadId = threadA.threadId;
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      tools: [
        {
          approval: true,
          description: "Pause parent A until approval resumes it",
          execute() {
            return {
              approved: true,
            };
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
      signal: textSignal("Pause A"),
      threadId: threadA.threadId,
    });
    const pausedParentAEvents = startEventCapture<KrakenStreamEvent>(
      handleA.parentEvents()
    );
    await waitFor(() => handleA.status().phase === "paused");

    const workerId = await orchestration.launchWorker("worker", {
      task: "A",
    });
    await orchestration.awaitWorker(workerId);

    const threadB = await framework.createThread({});
    parentBThreadId = threadB.threadId;
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Run B"),
      threadId: threadB.threadId,
    });
    const eventsBPromise = collectEvents(handleB.events());

    const resumedHandleA = handleA.resolveApproval({
      decisions: [{ callId: "hold-a", type: "approve" }],
    });
    await collectEvents(resumedHandleA.events());
    await eventsBPromise;
    await pausedParentAEvents.done;
    const messagesA = await harness.readBranchMessages(threadA.branchId);
    const messagesB = await harness.readBranchMessages(threadB.branchId);

    expect(resumedHandleA.status().phase).toBe("completed");
    expect(hasAssistantText(messagesA, "A got its worker result.")).toBe(true);
    expect(
      hasAssistantText(messagesB, "B received leaked worker output.")
    ).toBe(false);
  });

  test("resolveApproval returns a fresh orchestration handle and exhausts the paused wrapper streams", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Resume", to: "ops@example.com" },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Resumed parent completed.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause parent until approval",
              execute() {
                return {
                  approved: true,
                };
              },
              inputSchema: {
                properties: {
                  subject: { type: "string" },
                  to: { type: "string" },
                },
                required: ["to", "subject"],
                type: "object",
              },
              name: "email",
            },
          ],
        },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Pause orchestration parent"),
      threadId: thread.threadId,
    });
    const pausedParentCapture = startEventCapture<KrakenStreamEvent>(
      handle.parentEvents()
    );

    await waitFor(() => handle.status().phase === "paused");

    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });

    const resumedParentEvents = await collectEvents<KrakenStreamEvent>(
      resumedHandle.parentEvents()
    );
    await pausedParentCapture.done;

    expect(resumedHandle).not.toBe(handle);
    expect(
      pausedParentCapture.events.some(
        (event) =>
          event.type === "turn.start" &&
          "resumedFrom" in event &&
          typeof event.resumedFrom === "string"
      )
    ).toBe(false);
    expect(
      resumedParentEvents.some(
        (event) =>
          event.type === "turn.start" &&
          "resumedFrom" in event &&
          typeof event.resumedFrom === "string"
      )
    ).toBe(true);
  });

  test("closes paused parent streams and releases the cancelled session", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (context.config.name === "worker") {
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker after cancelled session.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (
          workerResult?.status === "completed" &&
          workerResult.output === "Worker after cancelled session."
        ) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent saw post-cancel worker.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (toolMessages.length === 0) {
          return {
            activeAgent: "primary",
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

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause parent session",
              execute() {
                return {
                  approved: true,
                };
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
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const threadA = await framework.createThread({});
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Pause and cancel A"),
      threadId: threadA.threadId,
    });

    detachTestPromise(collectEventsForDuration(handleA.events(), 50));
    await waitFor(() => handleA.status().phase === "paused");
    const parentDrain = settleWithin(
      collectEvents(handleA.parentEvents()),
      100
    );
    const allDrain = settleWithin(collectEvents(handleA.allEvents()), 100);

    handleA.cancel();
    await waitFor(() => handleA.status().phase === "failed");

    expect(await parentDrain).toEqual([]);
    expect(await allDrain).toEqual([]);

    const threadB = await framework.createThread({});
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Single live session"),
      threadId: threadB.threadId,
    });
    detachTestPromise(collectEventsForDuration(handleB.events(), 50));

    const workerId = await orchestration.launchWorker("worker", {
      task: "cleanup",
    });
    const workerResult = await orchestration.awaitWorker(workerId);

    expect(workerResult).toBe("Worker after cancelled session.");
  });

  test("routes worker completions to the resumed orchestration handle", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          await delay(30);
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker survived the resume.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (
          workerResult?.status === "completed" &&
          workerResult.output === "Worker survived the resume."
        ) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent received the resumed worker.")],
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
          await delay(10);
          return {
            activeAgent: "primary",
            messages: [
              assistantToolCalls([
                {
                  callId: "hold-resume-worker",
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

        await delay(5);
        return {
          activeAgent: "primary",
          messages: [assistantText("Still waiting on the resumed worker.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: {
          name: "primary",
          tools: [
            {
              approval: true,
              description: "Pause until approval resumes the parent",
              execute() {
                return {
                  approved: true,
                };
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
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Pause, then resume with a worker"),
      threadId: thread.threadId,
    });

    const parentEventsPromise = collectEvents(handle.parentEvents());
    const allEventsPromise = collectEvents(handle.allEvents());
    await delay(0);
    const workerId = await orchestration.launchWorker("worker", {
      task: "resume",
    });

    await waitFor(() => handle.status().phase === "paused");

    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "hold-resume-worker", type: "approve" }],
    });

    const resumedEventsPromise = collectEvents(resumedHandle.allEvents());
    const workerResult = await orchestration.awaitWorker(workerId);
    await parentEventsPromise;
    await allEventsPromise;
    const resumedEvents = await resumedEventsPromise;

    expect(workerResult).toBe("Worker survived the resume.");
    expect(resumedHandle.status().phase).toBe("completed");
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "custom" &&
          event.name === "worker.completed" &&
          event.source?.workerId === workerId
      )
    ).toBe(true);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Parent received the resumed worker."
      )
    ).toBe(true);
  });

  test("keeps running workers available after the parent turn completes", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        if (context.config.name === "worker") {
          await delay(25);
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker finished after parent.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Parent finished early.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Finish parent first"),
      threadId: thread.threadId,
    });

    const allEventsPromise = collectEvents(handle.allEvents());
    const workerId = await orchestration.launchWorker("worker", {
      task: "slow path",
    });
    const workerResult = await orchestration.awaitWorker(workerId);
    const allEvents = await allEventsPromise;

    expect(handle.status().phase).toBe("completed");
    expect(workerResult).toBe("Worker finished after parent.");
    expect(
      allEvents.some(
        (event) => event.type === "custom" && event.name === "worker.completed"
      )
    ).toBe(true);
  });

  test("does not mark paused workers as completed or resolve awaitWorker()", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              activeAgent: "worker",
              messages: [
                assistantToolCalls([
                  {
                    callId: "call-hold-worker",
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
            activeAgent: "worker",
            messages: [assistantText("Worker resumed unexpectedly.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (workerResult !== null) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent received a premature worker.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Still waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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
              description: "Pause the worker",
              execute() {
                return {
                  approved: true,
                };
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
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Wait for paused worker"),
      threadId: thread.threadId,
    });

    const parentEventsPromise = collectEventsForDuration(
      handle.parentEvents(),
      40
    );
    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "pause",
      },
      {
        parent: handle,
      }
    );
    await delay(40);
    const awaitWorkerOutcome = await settleWithin(
      orchestration.awaitWorker(workerId),
      20
    );
    const workerStatus = handle.workers().get(workerId);
    const allEvents = await collectEventsForDuration(handle.allEvents(), 20);
    const parentEvents = await parentEventsPromise;

    expect(awaitWorkerOutcome).toBe(TIMEOUT_TOKEN);
    expect(workerStatus?.status).toBe("paused");
    expect(
      allEvents.some(
        (event) =>
          event.type === "custom" &&
          event.name === "worker.completed" &&
          event.source?.workerId === workerId
      )
    ).toBe(false);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Parent received a premature worker."
      )
    ).toBe(false);
    expect(parentEvents.some((event) => event.type === "turn.start")).toBe(
      true
    );
  });

  test("resolves paused workers through the orchestration runtime", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          const toolMessages = context.messages.filter(
            (message) => message.role === "tool"
          );

          if (toolMessages.length === 0) {
            return {
              activeAgent: "worker",
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
            activeAgent: "worker",
            messages: [assistantText("Worker resumed with approval.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (
          workerResult?.status === "completed" &&
          workerResult.output === "Worker resumed with approval."
        ) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent saw the resumed worker.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
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
              description: "Pause the worker",
              execute() {
                return {
                  approved: true,
                };
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
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Resume paused worker"),
      threadId: thread.threadId,
    });

    const allEventsPromise = collectEvents(handle.allEvents());
    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "approval",
      },
      {
        parent: handle,
      }
    );

    await waitFor(() => handle.workers().get(workerId)?.status === "paused");

    const pausedWorker = handle.workers().get(workerId);

    expect(
      pausedWorker?.approval?.toolCalls.map((toolCall) => toolCall.callId)
    ).toEqual(["call-approve-worker"]);

    orchestration.resolveWorkerApproval(
      workerId,
      {
        decisions: [{ callId: "call-approve-worker", type: "approve" }],
      },
      {
        parent: handle,
      }
    );

    const workerResult = await orchestration.awaitWorker(workerId);
    const allEvents = await allEventsPromise;

    expect(workerResult).toBe("Worker resumed with approval.");
    expect(handle.status().phase).toBe("completed");
    expect(
      allEvents.some(
        (event) =>
          event.type === "custom" &&
          event.name === "worker.completed" &&
          event.source?.workerId === workerId
      )
    ).toBe(true);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Parent saw the resumed worker."
      )
    ).toBe(true);
  });

  test("returns structured worker outputs through awaitWorker", async () => {
    const harness = createFakeKernelHarness();
    const report = {
      status: "ok",
      summary: "Structured worker output",
    };
    const driver = {
      async execute(context) {
        if (context.config.name === "worker") {
          context.runtime.emit({
            data: report,
            messageId: "worker-structured",
            name: "worker_report",
            timestamp: context.runtime.now(),
            type: "structured.done",
          });
          return {
            activeAgent: "worker",
            messages: [assistantStructured("worker_report", report)],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Parent finished.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Collect structured worker output"),
      threadId: thread.threadId,
    });
    detachTestPromise(collectEventsForDuration(handle.events(), 50));

    const workerId = await orchestration.launchWorker("worker", {
      task: "structured",
    });
    const workerResult = await orchestration.awaitWorker(workerId);
    await collectEvents(handle.allEvents());

    expect(workerResult).toEqual(report);
  });

  test("launches worker threads on the parent session schema", async () => {
    const harness = createFakeKernelHarness();
    const customSchema = {
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
      schemaId: "custom.worker.agent.v1",
    } satisfies TurnTreeSchema;
    const driver = {
      async execute(context) {
        if (context.config.name === "worker") {
          return {
            activeAgent: "worker",
            messages: [assistantText("Worker ran on the custom schema.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;

    await harness.kernel.schema.register(customSchema);
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({
      schemaId: customSchema.schemaId,
    });
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      schemaId: customSchema.schemaId,
      signal: textSignal("Launch schema-aware worker"),
      threadId: thread.threadId,
    });
    detachTestPromise(collectEventsForDuration(handle.allEvents(), 50));

    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "schema",
      },
      {
        parent: handle,
      }
    );

    await orchestration.awaitWorker(workerId, {
      parent: handle,
    });

    expect((await harness.kernel.thread.get(workerId))?.schemaId).toBe(
      customSchema.schemaId
    );
  });

  test("rejects malformed worker task signals before creating worker history", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          activeAgent: context.config.name,
          messages: [assistantText("Worker should not start.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Parent"),
      threadId: thread.threadId,
    });
    detachTestPromise(collectEventsForDuration(handle.events(), 50));

    await expect(
      orchestration.launchWorker("worker", JSON.parse('{"parts":[123]}'), {
        parent: handle,
      })
    ).rejects.toThrow("worker task must be a valid KrakenMessage");
  });

  test("workers() returns deep-cloned completed worker results", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          return {
            activeAgent: "worker",
            messages: [assistantStructured("worker_report", { ok: true })],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        if (workerResult?.status === "completed") {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent saw structured worker output.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Clone worker result snapshot"),
      threadId: thread.threadId,
    });
    const allEventsPromise = collectEvents(handle.allEvents());

    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "structured",
      },
      {
        parent: handle,
      }
    );

    await orchestration.awaitWorker(workerId);
    await allEventsPromise;

    const firstSnapshot = handle.workers().get(workerId);

    if (firstSnapshot === undefined || !hasOkData(firstSnapshot.result)) {
      throw new Error("expected a completed worker result snapshot");
    }

    firstSnapshot.result.ok = false;

    const secondSnapshot = handle.workers().get(workerId);

    expect(hasOkData(secondSnapshot?.result) && secondSnapshot.result.ok).toBe(
      true
    );
  });

  test("returns failure payloads from failed workers", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        if (context.config.name === "worker") {
          throw new Error("worker exploded");
        }

        return {
          activeAgent: "primary",
          messages: [assistantText("Parent finished.")],
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
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Collect failed worker output"),
      threadId: thread.threadId,
    });
    detachTestPromise(collectEventsForDuration(handle.events(), 50));

    const workerId = await orchestration.launchWorker("worker", {
      task: "failure",
    });
    const workerResult = await orchestration.awaitWorker(workerId);
    await collectEvents(handle.allEvents());

    expect(workerResult).toEqual({
      code: undefined,
      details: undefined,
      message: "worker exploded",
    });
  });

  test("steers failed worker payloads back into a running parent turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          throw new Error("worker exploded");
        }

        if (
          workerResult?.status === "failed" &&
          workerResult.output !== null &&
          typeof workerResult.output === "object" &&
          "message" in workerResult.output &&
          workerResult.output.message === "worker exploded"
        ) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent observed worker failure.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Still waiting on worker outcome.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const thread = await framework.createThread({});
    const handle = orchestration.executeTurn({
      branchId: thread.branchId,
      signal: textSignal("Observe failed worker"),
      threadId: thread.threadId,
    });
    const allEventsPromise = collectEvents(handle.allEvents());

    const workerId = await orchestration.launchWorker(
      "worker",
      {
        task: "failure",
      },
      {
        parent: handle,
      }
    );

    await orchestration.awaitWorker(workerId);
    await allEventsPromise;

    expect(handle.status().phase).toBe("completed");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Parent observed worker failure."
      )
    ).toBe(true);
  });

  test("cancels only the current session workers when a parent handle is cancelled", async () => {
    const harness = createFakeKernelHarness();
    let activeWorkers = 0;
    const driver = {
      async execute(context) {
        const workerResult = extractLastWorkerResult(context.messages);

        if (context.config.name === "worker") {
          activeWorkers += 1;

          try {
            if (readWorkerTask(context.messages) === "cancel-me") {
              await waitForAbort(context.signal);
              throw new Error("worker cancel-me cancelled");
            }

            await delay(20);
            return {
              activeAgent: "worker",
              messages: [assistantText("Worker stay-alive completed.")],
              resolution: {
                reason: "done",
                type: "end_turn",
              },
            };
          } finally {
            activeWorkers -= 1;
          }
        }

        if (workerResult !== null) {
          return {
            activeAgent: "primary",
            messages: [assistantText("Parent saw a worker result.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const threadA = await framework.createThread({});
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Cancel A"),
      threadId: threadA.threadId,
    });
    detachTestPromise(collectEventsForDuration(handleA.events(), 50));
    const threadB = await framework.createThread({});
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Keep B"),
      threadId: threadB.threadId,
    });
    detachTestPromise(collectEventsForDuration(handleB.events(), 50));

    const workerA = await orchestration.launchWorker(
      "worker",
      {
        task: "cancel-me",
      },
      {
        parent: handleA,
      }
    );
    const workerB = await orchestration.launchWorker(
      "worker",
      {
        task: "stay-alive",
      },
      {
        parent: handleB,
      }
    );

    await waitFor(() => activeWorkers === 2);
    handleA.cancel();

    const workerAResult = await orchestration.awaitWorker(workerA, {
      parent: handleA,
    });
    const workerBResult = await orchestration.awaitWorker(workerB, {
      parent: handleB,
    });

    expect(workerAResult).toEqual({
      code: undefined,
      details: undefined,
      message: "worker cancel-me cancelled",
    });
    expect(workerBResult).toBe("Worker stay-alive completed.");
  });

  test("runtime cancel aborts every active session consistently", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        if (context.config.name === "worker") {
          await waitForAbort(context.signal);
          throw new Error(
            `worker ${readWorkerTask(context.messages)} cancelled`
          );
        }

        await waitForAbort(context.signal);
        throw new Error(`parent ${context.threadId} cancelled`);
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const framework = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const orchestration = createOrchestrationRuntime({
      agents: {
        primary: { name: "primary" },
        worker: { name: "worker" },
      },
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      entrypoint: "primary",
      framework,
      kernel: harness.kernel,
    });
    const threadA = await framework.createThread({});
    const handleA = orchestration.executeTurn({
      branchId: threadA.branchId,
      signal: textSignal("Cancel everything A"),
      threadId: threadA.threadId,
    });
    const eventsAPromise = collectEvents(handleA.events());

    const threadB = await framework.createThread({});
    const handleB = orchestration.executeTurn({
      branchId: threadB.branchId,
      signal: textSignal("Cancel everything B"),
      threadId: threadB.threadId,
    });
    const eventsBPromise = collectEvents(handleB.events());

    const workerA = await orchestration.launchWorker(
      "worker",
      {
        task: "A",
      },
      {
        parent: handleA,
      }
    );
    const workerB = await orchestration.launchWorker(
      "worker",
      {
        task: "B",
      },
      {
        parent: handleB,
      }
    );

    orchestration.cancel();

    const workerAResult = await orchestration.awaitWorker(workerA, {
      parent: handleA,
    });
    const workerBResult = await orchestration.awaitWorker(workerB, {
      parent: handleB,
    });
    await eventsAPromise;
    await eventsBPromise;

    expect(handleA.status().phase).toBe("failed");
    expect(handleB.status().phase).toBe("failed");
    expect(workerAResult).toEqual({
      code: undefined,
      details: undefined,
      message: "execution cancelled",
    });
    expect(workerBResult).toEqual({
      code: undefined,
      details: undefined,
      message: "execution cancelled",
    });
  });

  test("emits steering.incorporated with the steering message hash", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const steeringMessage = context.messages.find(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Injected steering"
            )
        );

        if (steeringMessage !== undefined) {
          return {
            activeAgent: "primary",
            messages: [],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
          activeAgent: "primary",
          messages: [assistantText("Waiting for steering.")],
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
      async resume() {
        throw new Error("resume was not expected");
      },
    } satisfies KrakenDriver;
    const runtime = createKrakenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Start steering test"),
      threadId: thread.threadId,
    });

    await delay(0);
    handle.steer(textSignal("Injected steering"));
    const events = await collectEvents(handle.events());
    const manifest = await harness.readBranchManifest(thread.branchId);
    const steeringEvent = events.find(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { type: "steering.incorporated" }
      > => event.type === "steering.incorporated"
    );

    expect(steeringEvent?.messageId).toBe(extractLastMessageHash(manifest));
  });
});

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

function detachTestPromise(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

const TIMEOUT_TOKEN = Symbol("timeout");

async function collectEventsForDuration<T>(
  events: AsyncIterable<T>,
  durationMilliseconds: number
): Promise<T[]> {
  const collected: T[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + durationMilliseconds;

  try {
    while (Date.now() < deadline) {
      const nextValue = await settleWithin(
        iterator.next(),
        deadline - Date.now()
      );

      if (nextValue === TIMEOUT_TOKEN || nextValue.done) {
        break;
      }

      collected.push(nextValue.value);
    }
  } finally {
    await iterator.return?.();
  }

  return collected;
}

function startEventCapture<T>(events: AsyncIterable<T>): {
  done: Promise<void>;
  events: T[];
} {
  const collected: T[] = [];

  return {
    done: (async () => {
      for await (const event of events) {
        collected.push(event);
      }
    })(),
    events: collected,
  };
}

async function collectToolResultTimeline(
  events: AsyncIterable<{ callId?: string; type: string }>,
  timeline: string[]
): Promise<void> {
  for await (const event of events) {
    if (event.type === "tool.result" && typeof event.callId === "string") {
      timeline.push(`event:${event.callId}`);
    }
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number
): Promise<T | typeof TIMEOUT_TOKEN> {
  return await Promise.race<T | typeof TIMEOUT_TOKEN>([
    promise,
    delay(timeoutMilliseconds).then((): typeof TIMEOUT_TOKEN => TIMEOUT_TOKEN),
  ]);
}

async function waitFor(
  condition: () => boolean,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for condition");
    }

    await delay(5);
  }
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  timeoutMilliseconds = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!(await condition())) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("timed out waiting for condition");
    }

    await delay(5);
  }
}

function assistantText(text: string): KrakenMessage {
  return {
    parts: [{ text, type: "text" }],
    role: "assistant",
  };
}

function assistantStructured(name: string, data: unknown): KrakenMessage {
  return {
    parts: [{ data, name, type: "structured" }],
    role: "assistant",
  };
}

function assistantToolCalls(
  calls: Array<{
    callId: string;
    input: unknown;
    name: string;
  }>
): KrakenMessage {
  return {
    parts: calls.map((call) => ({
      callId: call.callId,
      input: call.input,
      name: call.name,
      type: "tool_call" as const,
    })),
    role: "assistant",
  };
}

function buildHandoffPlan(
  context: Parameters<KrakenDriver["execute"]>[0],
  sourceAgent: AgentConfig,
  targetAgent: AgentConfig,
  builder: HandoffContextPlan["builder"]
): HandoffContextPlan {
  return {
    builder,
    mode: "preserve_trace",
    reason: "delegate",
    sourceContext: {
      handoffIntent: {
        reason: "delegate",
        targetAgent: targetAgent.name,
      },
      helpers: {
        loadMessage() {
          return null;
        },
        storeMessage() {
          return "0".repeat(64);
        },
        storeMessages() {
          return [];
        },
      },
      manifest: context.manifest,
      messages: context.messages,
      sourceAgent,
      targetAgent,
    } satisfies HandoffSourceContext,
    targetAgent: targetAgent.name,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function extractLastWorkerResult(messages: KrakenMessage[]): {
  agent: string;
  output: unknown;
  status: string;
  workerId: string;
} | null {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];

    if (message.role !== "user") {
      continue;
    }

    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts[partIndex];

      if (part.type !== "structured" || part.name !== "worker_result") {
        continue;
      }

      const { data } = part;

      if (
        data === null ||
        typeof data !== "object" ||
        !("agent" in data) ||
        !("output" in data) ||
        !("status" in data) ||
        !("workerId" in data) ||
        typeof data.agent !== "string" ||
        typeof data.status !== "string" ||
        typeof data.workerId !== "string"
      ) {
        continue;
      }

      return {
        agent: data.agent,
        output: data.output,
        status: data.status,
        workerId: data.workerId,
      };
    }
  }

  return null;
}

function extractToolMessages(
  messages: unknown[]
): Extract<KrakenMessage, { role: "tool" }>[] {
  return messages.filter(
    (message): message is Extract<KrakenMessage, { role: "tool" }> =>
      message !== null &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "tool" &&
      "parts" in message &&
      Array.isArray(message.parts)
  );
}

function hasAssistantText(messages: unknown[], text: string): boolean {
  return messages.some((message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("parts" in message) ||
      !Array.isArray(message.parts)
    ) {
      return false;
    }

    return message.parts.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        part.text === text
    );
  });
}

function hasCountData(value: unknown): value is { count: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "count" in value &&
    typeof value.count === "number"
  );
}

function hasOkData(value: unknown): value is { ok: boolean } {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function extractSingleUserText(message: KrakenMessage | null): string {
  if (message === null || message.role !== "user") {
    throw new Error("expected a captured user handoff message");
  }

  const firstPart = message.parts[0];

  if (firstPart?.type !== "text") {
    throw new Error("expected the captured handoff message to start with text");
  }

  return firstPart.text;
}

function extractLastMessageHash(manifest: {
  messages?: unknown;
}): string | undefined {
  return Array.isArray(manifest.messages)
    ? manifest.messages.findLast(
        (hash): hash is string => typeof hash === "string"
      )
    : undefined;
}

function extractTurnId(
  events: Array<{ type: string; turnId?: string }>
): string {
  for (const event of events) {
    if (event.type === "turn.start" && typeof event.turnId === "string") {
      return event.turnId;
    }
  }

  throw new Error("turn.start event was not observed");
}

function readQueryInput(input: unknown): string {
  if (
    input !== null &&
    typeof input === "object" &&
    "query" in input &&
    typeof input.query === "string"
  ) {
    return input.query;
  }

  throw new Error("tool input did not contain a query string");
}

function readWorkerTask(messages: KrakenMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    for (const part of message.parts) {
      if (
        part.type === "structured" &&
        part.name === "worker_task" &&
        part.data !== null &&
        typeof part.data === "object" &&
        "task" in part.data &&
        typeof part.data.task === "string"
      ) {
        return part.data.task;
      }
    }
  }

  return null;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    throw new Error("expected an abort signal");
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}
