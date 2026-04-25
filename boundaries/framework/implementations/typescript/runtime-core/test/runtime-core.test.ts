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
import type {
  RuntimeKernel as KrakenKernel,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type {
  AgentConfig,
  AroundToolContext,
  AroundToolResult,
  ContextManifest,
  CustomSchema,
  HandoffSourceContext,
  ToolResultPart,
  TuvrenExtension,
  TuvrenMessage,
  TuvrenModelResponse,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";
import {
  collectSystemPrompts,
  createDriverRegistry as createBaseDriverRegistry,
  createContextManifest,
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
  createToolRegistry,
  createTuvrenRuntimeCore,
  type RuntimeWarning,
  runAfterTurnHooks,
  runBeforeIterationHooks,
  runBeforeTurnHooks,
  updateContextManifest,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantStructured,
  assistantText,
  assistantToolCalls,
  buildHandoffPlan,
  collectEvents,
  collectToolResultTimeline,
  delay,
  extractLastMessageHash,
  extractSingleUserText,
  extractToolMessages,
  extractTurnId,
  hasAssistantText,
  hasCountData,
  overwriteBranchSinglePath,
  readBranchCheckpointEventTypes,
  readBranchContextManifest,
  readQueryInput,
  requireStoredHandoffMessage,
  settleWithin,
  startEventCapture,
  TIMEOUT_TOKEN,
  textSignal,
  toKrakenMessages,
  toOptionalRecord,
  waitFor,
  waitForAbort,
  waitForAsync,
} from "./runtime-core-test-helpers.ts";

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

  test("tool registries snapshot tool definitions instead of exposing live references", () => {
    const originalMetadata = {
      channel: "primary",
    };
    const originalTool: TuvrenToolDefinition = {
      approval: true,
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
      metadata: originalMetadata,
      name: "search",
      timeout: 1000,
    };
    const registry = createToolRegistry([originalTool]);
    const firstRead = registry.get("search");
    const secondRead = registry.get("search");
    const listedRead = registry.list()[0];

    if (
      firstRead === undefined ||
      secondRead === undefined ||
      listedRead === undefined
    ) {
      throw new Error("expected the registered tool to be readable");
    }

    expect(firstRead).not.toBe(originalTool);
    expect(secondRead).not.toBe(originalTool);
    expect(listedRead).not.toBe(originalTool);
    expect(secondRead).not.toBe(firstRead);
    expect(listedRead).not.toBe(firstRead);
    expect(firstRead.metadata).not.toBe(originalMetadata);

    firstRead.approval = false;
    firstRead.timeout = 5;

    if (
      firstRead.metadata !== undefined &&
      typeof firstRead.metadata === "object" &&
      !Array.isArray(firstRead.metadata)
    ) {
      firstRead.metadata.channel = "mutated";
    }

    const freshRead = registry.get("search");

    if (freshRead === undefined) {
      throw new Error("expected the registered tool to remain readable");
    }

    expect(originalTool.approval).toBe(true);
    expect(originalTool.timeout).toBe(1000);
    expect(originalMetadata.channel).toBe("primary");
    expect(freshRead.approval).toBe(true);
    expect(freshRead.timeout).toBe(1000);
    expect(freshRead.metadata).toEqual({
      channel: "primary",
    });
  });

  test("allows same-turn user messages without creating new turn boundaries", () => {
    const manifest = createContextManifest([
      {
        parts: [{ text: "Turn start", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Assistant reply", type: "text" }],
        role: "assistant",
      },
    ]);
    const continuedManifest = updateContextManifest(
      manifest,
      [
        {
          parts: [{ text: "Injected same-turn user message", type: "text" }],
          role: "user",
        },
      ],
      [],
      []
    );

    expect(manifest.turnBoundaries).toEqual([0]);
    expect(continuedManifest.turnBoundaries).toEqual([0]);
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

  test("collectSystemPrompts and intercept hooks preserve extension method receivers", async () => {
    interface ReceiverExtension extends TuvrenExtension {
      afterTurnCalls: number;
      beforeIterationCalls: number;
      beforeTurnCalls: number;
      prompt: string;
    }

    const extension: ReceiverExtension = {
      afterTurn() {
        this.afterTurnCalls += 1;
        return undefined;
      },
      afterTurnCalls: 0,
      beforeIteration() {
        this.beforeIterationCalls += 1;
        return undefined;
      },
      beforeIterationCalls: 0,
      beforeTurn() {
        this.beforeTurnCalls += 1;
        return undefined;
      },
      beforeTurnCalls: 0,
      name: "receiver-aware",
      prompt: "Receiver-aware prompt",
      systemPrompt() {
        return this.prompt;
      },
    };
    const manifest = createContextManifest([]);

    expect(collectSystemPrompts([extension], manifest, 1)).toEqual([
      "Receiver-aware prompt",
    ]);

    await runBeforeTurnHooks({
      emit() {
        return;
      },
      extensions: [extension],
      iterationCount: 0,
      manifest,
      messages: [],
      runId: "run-before-turn",
      turnId: "turn-before-turn",
    });
    await runBeforeIterationHooks({
      emit() {
        return;
      },
      extensions: [extension],
      iterationCount: 1,
      manifest,
      messages: [],
      runId: "run-before-iteration",
      turnId: "turn-before-iteration",
    });
    await runAfterTurnHooks({
      emit() {
        return;
      },
      extensions: [extension],
      iterationCount: 1,
      manifest,
      messages: [],
      runId: "run-after-turn",
      turnId: "turn-after-turn",
    });

    expect(extension.beforeTurnCalls).toBe(1);
    expect(extension.beforeIterationCalls).toBe(1);
    expect(extension.afterTurnCalls).toBe(1);
  });

  test("collectSystemPrompts and hook contexts do not expose live extension state or shared exports", async () => {
    const manifest = {
      byRole: {
        assistant: 0,
        system: 0,
        tool: 0,
        user: 0,
      },
      extensions: {
        exporter: {
          nested: {
            count: 1,
          },
        },
        viewer: {
          local: {
            flag: true,
          },
        },
      },
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
    } satisfies ContextManifest;

    collectSystemPrompts(
      [
        {
          exports: ["nested"],
          name: "exporter",
        },
        {
          name: "viewer",
          systemPrompt(context) {
            const exportedNested = context.sharedExports.exporter?.nested;

            if (
              exportedNested !== undefined &&
              typeof exportedNested === "object" &&
              exportedNested !== null &&
              "count" in exportedNested
            ) {
              exportedNested.count = 99;
            }

            context.extensionState.local = { flag: false };
            context.manifest.extensions.exporter = {
              nested: {
                count: 100,
              },
            };
            return "Prompt";
          },
        },
      ],
      manifest,
      1
    );

    await runBeforeTurnHooks({
      emit() {
        return;
      },
      extensions: [
        {
          exports: ["nested"],
          name: "exporter",
        },
        {
          beforeTurn(context) {
            const exportedNested = context.sharedExports.exporter?.nested;

            if (
              exportedNested !== undefined &&
              typeof exportedNested === "object" &&
              exportedNested !== null &&
              "count" in exportedNested
            ) {
              exportedNested.count = 77;
            }

            context.extensionState.local = { flag: false };
            context.manifest.extensions.exporter = {
              nested: {
                count: 200,
              },
            };
            return undefined;
          },
          name: "viewer",
        },
      ],
      iterationCount: 0,
      manifest,
      messages: [],
      runId: "run-1",
      turnId: "turn-1",
    });

    expect(manifest.extensions).toEqual({
      exporter: {
        nested: {
          count: 1,
        },
      },
      viewer: {
        local: {
          flag: true,
        },
      },
    });
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

  test("deep-clones nested extension state when manifest snapshots are updated", () => {
    const originalManifest = createContextManifest([], {
      budget: {
        limits: {
          tokens: 10,
        },
      },
    });
    const nextManifest = updateContextManifest(originalManifest, []);
    const originalBudget = toOptionalRecord(originalManifest.extensions.budget);
    const originalLimits = toOptionalRecord(originalBudget?.limits);

    if (originalLimits === undefined) {
      throw new Error("expected nested extension state in the source manifest");
    }

    originalLimits.tokens = 99;

    expect(nextManifest.extensions).toEqual({
      budget: {
        limits: {
          tokens: 10,
        },
      },
    });
  });

  test("executes a driver-neutral turn and persists the input plus assistant output", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Hello from Kraken.",
          messageId: "assistant-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-1",
          text: "Hello from Kraken.",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-1",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
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
    const runtime = createTuvrenRuntimeCore({
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
    const checkpointEventTypes = await readBranchCheckpointEventTypes(
      harness.kernel,
      thread.branchId
    );

    expect(events.map((event) => event.type)).toContain("turn.start");
    expect(events.map((event) => event.type)).toContain("iteration.start");
    expect(events.map((event) => event.type)).toContain("turn.end");
    expect(handle.status().phase).toBe("completed");
    expect(handle.status().manifest).toEqual(
      await readBranchContextManifest(harness.kernel, thread.branchId)
    );
    expect(messages).toHaveLength(2);
    expect(checkpointEventTypes).toEqual(
      expect.arrayContaining([
        "input_received",
        "iteration_step_completed",
        "turn_status_finalized",
      ])
    );
  });

  test("synthesizes assistant content events when a driver returns durable output without streaming it", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantText("Visible without explicit runtime.emit.")],
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
      signal: textSignal("Show durable output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const messageStartIndex = events.findIndex(
      (event) => event.type === "message.start"
    );
    const textDeltaIndex = events.findIndex(
      (event) =>
        event.type === "text.delta" &&
        event.delta === "Visible without explicit runtime.emit."
    );
    const textDoneIndex = events.findIndex(
      (event) =>
        event.type === "text.done" &&
        event.text === "Visible without explicit runtime.emit."
    );
    const messageDoneIndex = events.findIndex(
      (event) => event.type === "message.done"
    );

    expect(
      events.some(
        (event) =>
          event.type === "text.delta" &&
          event.delta === "Visible without explicit runtime.emit."
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "text.done" &&
          event.text === "Visible without explicit runtime.emit."
      )
    ).toBe(true);
    expect(events.some((event) => event.type === "message.done")).toBe(true);
    expect(messageStartIndex).toBeLessThan(textDeltaIndex);
    expect(textDeltaIndex).toBeLessThan(textDoneIndex);
    expect(textDoneIndex).toBeLessThan(messageDoneIndex);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Show durable output", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            text: "Visible without explicit runtime.emit.",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("synthesizes structured delta events when a driver returns durable structured output without streaming it", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantStructured("result", { answer: "ok" })],
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
      signal: textSignal("Return structured output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const structuredDeltaIndex = events.findIndex(
      (event) =>
        event.type === "structured.delta" && event.delta === '{"answer":"ok"}'
    );
    const structuredDoneIndex = events.findIndex(
      (event) =>
        event.type === "structured.done" &&
        event.name === "result" &&
        toOptionalRecord(event.data)?.answer === "ok"
    );

    expect(structuredDeltaIndex).toBeGreaterThan(-1);
    expect(structuredDoneIndex).toBeGreaterThan(structuredDeltaIndex);
  });

  test("synthesizes structured string deltas as serialized JSON strings", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantStructured("result", "hello")],
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
      signal: textSignal("Return structured string output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(
      events.some(
        (event) =>
          event.type === "structured.delta" && event.delta === '"hello"'
      )
    ).toBe(true);
  });

  test("synthesizes tool-call args deltas when a driver returns durable tool calls without streaming them", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "search term" },
                  name: "search",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText("Done.")],
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
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
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
      signal: textSignal("Synthesize tool call deltas"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const argsDeltaIndex = events.findIndex(
      (event) =>
        event.type === "tool_call.args_delta" &&
        event.callId === "call-search" &&
        event.delta === '{"query":"search term"}'
    );
    const toolCallDoneIndex = events.findIndex(
      (event) =>
        event.type === "tool_call.done" && event.callId === "call-search"
    );

    expect(argsDeltaIndex).toBeGreaterThan(-1);
    expect(toolCallDoneIndex).toBeGreaterThan(argsDeltaIndex);
  });

  test("synthesizes string tool-call arg deltas as serialized JSON strings", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-echo",
                  input: "hello",
                  name: "echo",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "parallel",
          };
        }

        return {
          messages: [assistantText("Done.")],
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
        name: "primary",
        tools: [
          {
            description: "Echo",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              type: "string",
            },
            name: "echo",
          },
        ],
      },
      signal: textSignal("Synthesize string tool call delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(
      events.some(
        (event) =>
          event.type === "tool_call.args_delta" &&
          event.callId === "call-echo" &&
          event.delta === '"hello"'
      )
    ).toBe(true);
  });

  test("does not start execution until the event stream is consumed", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const driver = {
      async execute(_context) {
        executeCalls += 1;
        return {
          messages: [assistantText("Started on demand.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Wait to start"),
      threadId: thread.threadId,
    });
    const events = handle.events();

    await delay(25);

    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);

    await collectEvents(events);

    expect(executeCalls).toBe(1);
    expect(handle.status().phase).toBe("completed");
  });

  test("cancels running execution when the last event subscriber stops consuming", async () => {
    const harness = createFakeKernelHarness();
    let driverStarted = false;
    let observedAbort = false;
    const driver = {
      async execute(context) {
        driverStarted = true;
        await waitForAbort(context.signal);
        observedAbort = context.signal?.aborted === true;
        return {
          resolution: {
            type: "continue_iteration",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Cancel on stream close"),
      threadId: thread.threadId,
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const firstEvent = await iterator.next();

    expect(firstEvent.done).toBe(false);
    expect(firstEvent.value?.type).toBe("turn.start");

    await waitFor(() => driverStarted);
    await iterator.return?.();
    await waitFor(() => handle.status().phase === "failed");

    expect(observedAbort).toBe(true);
    expect(handle.status().phase).toBe("failed");
  });

  test("gives drivers frozen execution snapshots instead of live framework state", async () => {
    const harness = createFakeKernelHarness();
    let configMutationError: unknown;
    let manifestMutationError: unknown;
    let messageMutationError: unknown;
    let toolMutationError: unknown;
    let registryMutationError: unknown;
    let configToolExecutionError: unknown;
    let observedToolTimeout: number | undefined;
    const driver = {
      async execute(context) {
        try {
          Object.defineProperty(context.config, "name", {
            value: "mutated",
          });
        } catch (error: unknown) {
          configMutationError = error;
        }

        try {
          Object.defineProperty(context.manifest, "messageCount", {
            value: 999,
          });
        } catch (error: unknown) {
          manifestMutationError = error;
        }

        try {
          Array.prototype.push.call(context.messages, assistantText("mutated"));
        } catch (error: unknown) {
          messageMutationError = error;
        }

        try {
          const tool = context.toolRegistry.get("safe");

          if (tool !== undefined) {
            observedToolTimeout = tool.timeout;
            Object.defineProperty(tool, "description", {
              value: "mutated description",
            });
          }
        } catch (error: unknown) {
          toolMutationError = error;
        }

        try {
          const configTool = context.config.tools?.[0];

          if (configTool !== undefined) {
            configTool.execute({}, { callId: "driver-bypass", name: "safe" });
          }
        } catch (error: unknown) {
          configToolExecutionError = error;
        }

        try {
          context.toolRegistry.register({
            description: "rogue",
            execute() {
              return {
                rogue: true,
              };
            },
            inputSchema: {
              type: "object",
            },
            name: "rogue",
          });
        } catch (error: unknown) {
          registryMutationError = error;
        }

        return {
          messages: [
            assistantText(
              `rogue:${String(context.toolRegistry.has("rogue"))};timeout:${String(observedToolTimeout)};configBlocked:${String(configToolExecutionError instanceof Error)}`
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
    const runtime = createTuvrenRuntimeCore({
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
            description: "safe tool",
            execute() {
              return {
                safe: true,
              };
            },
            inputSchema: {
              type: "object",
            },
            name: "safe",
            timeout: 1000,
          },
        ],
      },
      signal: textSignal("Immutable driver context"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(configMutationError).toBeInstanceOf(TypeError);
    expect(manifestMutationError).toBeInstanceOf(TypeError);
    expect(messageMutationError).toBeInstanceOf(TypeError);
    expect(toolMutationError).toBeInstanceOf(TypeError);
    expect(registryMutationError).toBeInstanceOf(Error);
    expect(configToolExecutionError).toBeInstanceOf(Error);
    expect(handle.status().phase).toBe("completed");
    expect(handle.status().activeAgent).toBe("primary");
    expect(manifest.messageCount).toBe(2);
    expect(manifest.lastAssistantMessageIndex).toBe(1);
    expect(messages).toEqual([
      {
        parts: [{ text: "Immutable driver context", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            text: "rogue:false;timeout:1000;configBlocked:true",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("snapshots explicit request tools at executeTurn time", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-request-tool",
                  input: { query: "snapshot" },
                  name: "request-tool",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Request tool complete.")],
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
    const requestTool = {
      description: "Original request-scoped tool",
      execute() {
        return { status: "original" };
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      metadata: {
        version: "original",
      },
      name: "request-tool",
    };
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
      },
      signal: textSignal("Use the request-scoped tool"),
      threadId: thread.threadId,
      tools: [requestTool],
    });

    requestTool.description = "mutated";
    requestTool.execute = () => ({ status: "mutated" });
    requestTool.metadata = {
      version: "mutated",
    };

    await collectEvents(handle.events());
    const toolMessages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(toolMessages).toEqual([
      {
        parts: [
          {
            callId: "call-request-tool",
            name: "request-tool",
            output: { status: "original" },
            type: "tool_result",
          },
        ],
        role: "tool",
      },
    ]);
  });

  test("rejects non-cloneable stream events before they reach the handle fanout", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            bad() {
              return "not cloneable";
            },
          },
          name: "bad.custom.event",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [assistantText("This should not persist.")],
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
      signal: textSignal("Reject bad custom event"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject bad custom event", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects driver-emitted shared-core lifecycle events", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          callId: "forged-call",
          name: "search",
          output: { forged: true },
          timestamp: context.runtime.now(),
          type: "tool.result",
        });

        return {
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
      signal: textSignal("Reject forged lifecycle event"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) =>
          event.type === "tool.result" && event.callId === "forged-call"
      )
    ).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject forged lifecycle event", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("overrides forged driver event source attribution", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: { ok: true },
          name: "driver.custom",
          source: {
            agent: "forged-agent",
            driver: "forged-driver",
            threadId: "forged-thread",
            workerId: "forged-worker",
          },
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
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
      signal: textSignal("Stamp the real source"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const customEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "custom" }> =>
        event.type === "custom" && event.name === "driver.custom"
    );

    expect(customEvent?.source).toEqual({
      agent: "primary",
      driver: "fake",
      threadId: thread.threadId,
    });
  });

  test("rejects assistant stream events when the driver does not return a durable assistant message", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-ghost",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-ghost",
          text: "ghost output",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-ghost",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
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
      signal: textSignal("Reject ghost assistant output"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "text.done" && event.text === "ghost output"
      )
    ).toBe(true);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject ghost assistant output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant stream events without a durable assistant message on soft driver failures", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(context) {
        driverCalls += 1;

        if (driverCalls === 1) {
          context.runtime.emit({
            messageId: "assistant-soft-fail",
            role: "assistant",
            timestamp: context.runtime.now(),
            type: "message.start",
          });
          context.runtime.emit({
            delta: "partial",
            messageId: "assistant-soft-fail",
            timestamp: context.runtime.now(),
            type: "text.delta",
          });

          return {
            resolution: {
              error: new Error("soft retry"),
              fatality: "soft",
              type: "fail",
            },
          };
        }

        return {
          messages: [assistantText("second iteration should not run")],
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
      signal: textSignal("Reject soft-fail assistant leak"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(driverCalls).toBe(1);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "text.delta" && event.delta === "partial"
      )
    ).toBe(true);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject soft-fail assistant leak", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant stream events that do not match the durable assistant message", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "streamed-wrong",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("persisted-right")],
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
      signal: textSignal("Reject mismatched assistant stream"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(events.map((event) => event.type)).toContain("iteration.end");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched assistant stream", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("does not allow durable/live assistant divergence from a no-op aroundModel alone", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "live",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "live",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("durable mismatch")],
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
        extensions: [
          {
            async aroundModel(_context, next) {
              return await next();
            },
            name: "noop-around",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Reject inferred aroundModel divergence"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [
          { text: "Reject inferred aroundModel divergence", type: "text" },
        ],
        role: "user",
      },
    ]);
  });

  test("does not allow assistantEventReconciliation divergence without active aroundModel extensions", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "live",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "live",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable mismatch")],
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
        name: "primary",
      },
      signal: textSignal("Reject reconciliation escape hatch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject reconciliation escape hatch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("does not allow assistantEventReconciliation without emitted assistant events", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable only")],
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
        extensions: [
          {
            async aroundModel(_context, next) {
              return await next();
            },
            name: "noop-around",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Reject unused reconciliation flag"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject unused reconciliation flag", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("passes a coherent durable response into afterIteration when final assistant divergence is allowed", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse:
      | {
          finishReason: string;
          parts: TuvrenModelResponse["parts"];
          usage: TuvrenModelResponse["usage"];
        }
      | undefined;
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "live",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-streamed",
          text: "live",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "length",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
          usage: {
            inputTokens: 3,
            outputTokens: 5,
          },
        });

        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable replacement")],
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
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = {
                finishReason: context.response.finishReason,
                parts: context.response.parts,
                usage: context.response.usage,
              };
              return undefined;
            },
            async aroundModel(_context, next) {
              return await next();
            },
            name: "capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture durable divergence response"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(capturedResponse).toEqual({
      finishReason: "stop",
      parts: [{ text: "durable replacement", type: "text" }],
      usage: {
        inputTokens: 3,
        outputTokens: 5,
      },
    });
  });

  test("rejects final tool-call divergence even when aroundModel is active", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-streamed",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-streamed",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          delta: '{"query":"docs"}',
          timestamp: context.runtime.now(),
          type: "tool_call.args_delta",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { query: "docs" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-streamed",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          assistantEventReconciliation: "allow_final_sequence_divergence",
          messages: [assistantText("durable text")],
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
        extensions: [
          {
            async aroundModel(_context, next) {
              return await next();
            },
            name: "rewriter",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Reject tool-call divergence"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject tool-call divergence", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("allows multiple assistant message sequences when only the final retry response becomes durable", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-attempt-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "First attempt",
          messageId: "assistant-attempt-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-attempt-1",
          text: "First attempt",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-attempt-1",
          timestamp: context.runtime.now(),
          type: "message.done",
        });
        context.runtime.emit({
          messageId: "assistant-attempt-2",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Final attempt",
          messageId: "assistant-attempt-2",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-attempt-2",
          text: "Final attempt",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-attempt-2",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("Final attempt")],
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
      signal: textSignal("Allow retry-shaped assistant streams"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(events.filter((event) => event.type === "message.done").length).toBe(
      2
    );
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Allow retry-shaped assistant streams", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Final attempt", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("rejects text assistant streams that omit text.delta", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-text-without-delta",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-text-without-delta",
          text: "missing delta",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-text-without-delta",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("missing delta")],
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
      signal: textSignal("Reject missing text delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
  });

  test("rejects structured assistant streams that omit structured.delta", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-structured-without-delta",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          data: { answer: "ok" },
          messageId: "assistant-structured-without-delta",
          name: "result",
          timestamp: context.runtime.now(),
          type: "structured.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-structured-without-delta",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantStructured("result", { answer: "ok" })],
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
      signal: textSignal("Reject missing structured delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
  });

  test("rejects tool-call stream previews that do not match the durable tool call", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-call",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-call",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "streamed-wrong" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-call",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
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
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject mismatched tool preview"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched tool preview", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects tool-call assistant streams that omit tool_call.args_delta", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-call-without-delta",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-call-without-delta",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "persisted-right" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-call-without-delta",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
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
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject missing tool-call args delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
  });

  test("rejects incomplete assistant event sequences", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-incomplete",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-incomplete",
          text: "missing message.done",
          timestamp: context.runtime.now(),
          type: "text.done",
        });

        return {
          messages: [assistantText("missing message.done")],
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
      signal: textSignal("Reject incomplete assistant events"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(events.some((event) => event.type === "message.done")).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject incomplete assistant events", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant stream events whose message ids do not reconcile", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-a",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-b",
          text: "split identity",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-b",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("split identity")],
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
      signal: textSignal("Reject split assistant identity"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject split assistant identity", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects assistant delta events that arrive before message.start", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          delta: "out-of-order",
          messageId: "assistant-out-of-order",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "assistant-out-of-order",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-out-of-order",
          text: "out-of-order",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-out-of-order",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("out-of-order")],
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
      signal: textSignal("Reject out-of-order assistant delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "text.delta" && event.delta === "out-of-order"
      )
    ).toBe(true);
  });

  test("rejects reasoning deltas that do not reconcile to the durable assistant message", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-reasoning",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "secret reasoning leak",
          messageId: "assistant-reasoning",
          timestamp: context.runtime.now(),
          type: "reasoning.delta",
        });
        context.runtime.emit({
          messageId: "assistant-reasoning",
          text: "safe output",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-reasoning",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("safe output")],
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
      signal: textSignal("Reject leaked reasoning delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) =>
          event.type === "reasoning.delta" &&
          event.delta === "secret reasoning leak"
      )
    ).toBe(true);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject leaked reasoning delta", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects non-redacted reasoning parts that omit reasoning.delta content", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-reasoning-missing",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-reasoning-missing",
          timestamp: context.runtime.now(),
          type: "reasoning.done",
        });
        context.runtime.emit({
          finishReason: "stop",
          messageId: "assistant-reasoning-missing",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            {
              parts: [
                {
                  redacted: false,
                  text: "visible reasoning",
                  type: "reasoning",
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
      signal: textSignal("Reject missing reasoning delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject missing reasoning delta", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects tool-call args deltas that do not reconcile to the durable tool input", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-args",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-args",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-search",
          delta: '{"value":"WRONG"}',
          timestamp: context.runtime.now(),
          type: "tool_call.args_delta",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "persisted-right" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-args",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
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
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject mismatched args delta"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(events.some((event) => event.type === "tool_call.args_delta")).toBe(
      true
    );
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched args delta", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects tool-call args deltas whose call ids do not match the current tool call", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-tool-call-id",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          callId: "call-search",
          messageId: "assistant-tool-call-id",
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.start",
        });
        context.runtime.emit({
          callId: "call-other",
          delta: '{"value":"persisted-right"}',
          timestamp: context.runtime.now(),
          type: "tool_call.args_delta",
        });
        context.runtime.emit({
          callId: "call-search",
          input: { value: "persisted-right" },
          name: "search",
          timestamp: context.runtime.now(),
          type: "tool_call.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-tool-call-id",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { value: "persisted-right" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            type: "continue_iteration",
          },
          toolExecutionMode: "parallel",
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
        name: "primary",
        tools: [
          {
            description: "Search",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              type: "object",
            },
            name: "search",
          },
        ],
      },
      signal: textSignal("Reject mismatched args delta call id"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(
      events.some(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
    ).toBe(false);
  });

  test("rejects assistant message.done events whose finishReason disagrees with durable output", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "assistant-finish-reason",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          messageId: "assistant-finish-reason",
          text: "wrong finish reason",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "tool_call",
          messageId: "assistant-finish-reason",
          timestamp: context.runtime.now(),
          type: "message.done",
        });

        return {
          messages: [assistantText("wrong finish reason")],
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
      signal: textSignal("Reject mismatched finish reason"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_stream_event");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject mismatched finish reason", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects malformed initial input signals before staging branch history", async () => {
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

    expect(() =>
      runtime.executeTurn({
        branchId: thread.branchId,
        config: { name: "primary" },
        signal: JSON.parse('{"parts":[123]}'),
        threadId: thread.threadId,
      })
    ).toThrow("request.signal must be a valid TuvrenMessage");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
  });

  test("does not start a fresh handle when it is canceled before the first stream pull", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const driver = {
      async execute() {
        executeCalls += 1;
        return {
          messages: [assistantText("This should never run.")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Never start"),
      threadId: thread.threadId,
    });

    handle.cancel();
    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(events).toEqual([]);
    expect(executeCalls).toBe(0);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([]);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toBeNull();
  });

  test("fails malformed driver messages before they can be checkpointed", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
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
    const runtime = createTuvrenRuntimeCore({
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
    expect(errorEvent?.error.code).toBe("invalid_tuvren_message");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject malformed driver output", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("fails invalid driver resolutions at the execution boundary", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Invalid resolution payload.")],
          resolution: JSON.parse('{"bogus":true}'),
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
      signal: textSignal("Reject invalid driver resolution"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject invalid driver resolution", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects malformed driver handoff plans at the execution boundary", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return JSON.parse(
          '{"activeAgent":"primary","messages":[{"role":"assistant","parts":[{"type":"text","text":"Bad handoff"}]}],"resolution":{"type":"handoff","targetAgent":"reviewer","contextPlan":{"targetAgent":"reviewer"}}}'
        );
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
      signal: textSignal("Reject malformed handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject malformed handoff", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects driver messages that bypass the shared tool-result path", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [
            {
              parts: [
                {
                  callId: "call-search",
                  name: "search",
                  output: { hits: 1 },
                  type: "tool_result",
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
      signal: textSignal("Reject driver tool result"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject driver tool result", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects removed driver response fields at the runtime boundary", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantText("Plain assistant output.")],
          response: {
            finishReason: "tool_call",
            parts: [
              {
                callId: "call-search",
                input: { query: "mismatch" },
                name: "search",
                type: "tool_call",
              },
            ],
          },
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
      signal: textSignal("Reject contradictory driver response"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject contradictory driver response", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects driver handoff resolutions whose target disagrees with the context plan", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        return {
          messages: [assistantText("Mismatched handoff target.")],
          resolution: {
            contextPlan: context.handoff.createContextPlan({
              reason: "handoff",
              targetAgent: "worker",
            }),
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        ({
          primary: { name: "primary" },
          reviewer: { name: "reviewer" },
          worker: { name: "worker" },
        })[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject handoff target mismatch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject handoff target mismatch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects raw handoff plans whose source context target disagrees with the plan target", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      planner: { name: "planner" },
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const driver = {
      async execute(context) {
        return {
          resolution: {
            contextPlan: {
              builder(sourceContext) {
                return sourceContext.helpers.storeMessages([
                  {
                    parts: [
                      {
                        text: `prepared-for:${sourceContext.targetAgent.name}`,
                        type: "text",
                      },
                    ],
                    role: "user",
                  },
                ]);
              },
              mode: "preserve_trace",
              reason: "delegate",
              sourceContext: {
                handoffIntent: {
                  reason: "delegate",
                  targetAgent: "planner",
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
                targetAgent: agents.planner,
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Reject raw handoff mismatch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject raw handoff mismatch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects terminal driver resolutions that still contain executable tool calls before persistence", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid" },
                name: "search",
              },
            ]),
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Reject terminal tool call"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject terminal tool call", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects driver state updates for extensions that are not active in the current turn", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
          messages: [assistantText("ghost state")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
          stateUpdates: [
            {
              extensionName: "ghost-extension",
              state: { leaked: true },
            },
          ],
        } satisfies DriverExecutionResult;
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
      signal: textSignal("Reject ghost extension state"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(manifest.extensions).toEqual({});
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject ghost extension state", type: "text" }],
        role: "user",
      },
    ]);
  });

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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
      async execute(_context) {
        return {
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
    const runtime = createTuvrenRuntimeCore({
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

  test("deep-clones nested initial extension state before first-turn seeding", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(_context) {
            return {
              messages: [assistantText("Seeded state captured.")],
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
    const nestedState = {
      limits: {
        remaining: 3,
      },
    };
    const config: AgentConfig = {
      extensions: [
        {
          name: "seeded",
          state: nestedState,
        },
      ],
      name: "primary",
    };
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config,
      signal: textSignal("Seed initial state"),
      threadId: thread.threadId,
    });

    nestedState.limits.remaining = 0;

    await collectEvents(handle.events());

    expect(handle.status().manifest?.extensions.seeded).toEqual({
      limits: {
        remaining: 3,
      },
    });
  });

  test("keeps runtime hook receiver state mutable across live extension execution", async () => {
    interface ReceiverExtension extends TuvrenExtension {
      beforeIteration(): undefined;
      beforeTurn(): undefined;
      beforeTurnCalls: number;
    }

    const harness = createFakeKernelHarness();
    const extension: ReceiverExtension = {
      beforeIteration() {
        if (this.beforeTurnCalls !== 1) {
          throw new Error(
            `expected beforeTurnCalls to be 1, received ${this.beforeTurnCalls}`
          );
        }

        return undefined;
      },
      beforeTurn() {
        this.beforeTurnCalls += 1;
        return undefined;
      },
      beforeTurnCalls: 0,
      name: "mutable-receiver",
    };
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute() {
            return {
              messages: [assistantText("Hook receiver stayed mutable.")],
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
        extensions: [extension],
        name: "primary",
      },
      signal: textSignal("Exercise mutable hook receiver"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Hook receiver stayed mutable."
      )
    ).toBe(true);
  });

  test("persists beforeTurn state updates on terminal short-circuits", async () => {
    const harness = createFakeKernelHarness();
    let driverCalls = 0;
    const driver = {
      async execute(_context) {
        driverCalls += 1;
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
      async execute(_context) {
        driverCalls += 1;
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
      async execute(_context) {
        driverCalls += 1;
        return {
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
    const runtime = createTuvrenRuntimeCore({
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

  test("suppresses late hook events after timeout soft-fail conversion", async () => {
    const harness = createFakeKernelHarness();
    let lateEmitAttempts = 0;
    const driver = {
      async execute(_context) {
        return {
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
    const runtime = createTuvrenRuntimeCore({
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
            async beforeIteration(context) {
              await delay(25);
              lateEmitAttempts += 1;
              context.emit({
                data: {
                  late: true,
                },
                name: "late-event",
              });
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

    const capture = startEventCapture(handle.events());
    await capture.done;
    await delay(40);

    expect(lateEmitAttempts).toBe(1);
    expect(
      capture.events.some(
        (event) => event.type === "custom" && event.name === "late-event"
      )
    ).toBe(false);
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

  test("surfaces afterTurn cleanup failures as non-fatal error events", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Finished main execution.")],
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
        extensions: [
          {
            afterTurn() {
              throw new Error("cleanup failed");
            },
            name: "cleanup-observer",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Run afterTurn cleanup"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("completed");
    expect(errorEvent?.fatal).toBe(false);
    expect(errorEvent?.error.message).toBe("cleanup failed");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Finished main execution."
      )
    ).toBe(true);
  });

  test("passes synthesized assistant response data into afterIteration hooks", async () => {
    const harness = createFakeKernelHarness();
    let capturedFinishReason: string | undefined;
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Truncated assistant output.")],
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
        extensions: [
          {
            afterIteration(context) {
              capturedFinishReason = context.response.finishReason;
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture the full driver response"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedFinishReason).toBe("stop");
  });

  test("marks synthesized partial assistant failures as error responses in afterIteration", async () => {
    const harness = createFakeKernelHarness();
    let capturedFinishReason: string | undefined;
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Interrupted assistant output.")],
          partial: true,
          resolution: {
            error: new Error("execution interrupted"),
            fatality: "hard",
            type: "fail",
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
        extensions: [
          {
            afterIteration(context) {
              capturedFinishReason = context.response.finishReason;
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture partial failure response"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("failed");
    expect(capturedFinishReason).toBe("error");
  });

  test("checkpoints failed partial tool-call messages without executing tools", async () => {
    const harness = createFakeKernelHarness();
    const partialToolCall = assistantToolCalls([
      {
        callId: "call-search",
        input: { query: "interrupted" },
        name: "search",
      },
    ]);
    const driver = {
      async execute(_context) {
        return {
          messages: [partialToolCall],
          partial: true,
          resolution: {
            error: new Error("execution interrupted"),
            fatality: "hard",
            type: "fail",
          },
          toolExecutionMode: "sequential",
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
      signal: textSignal("Cancel during tool call"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).not.toBe("invalid_driver_resolution");
    expect(events.some((event) => event.type === "tool.start")).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel during tool call", type: "text" }],
        role: "user",
      },
      partialToolCall,
    ]);
  });

  test("preserves emitted finish reason, usage, and provider metadata in synthesized afterIteration responses", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse: TuvrenModelResponse | undefined;
    const driver = {
      async execute(context) {
        context.runtime.emit({
          messageId: "message-1",
          role: "assistant",
          timestamp: context.runtime.now(),
          type: "message.start",
        });
        context.runtime.emit({
          delta: "Visible output",
          messageId: "message-1",
          timestamp: context.runtime.now(),
          type: "text.delta",
        });
        context.runtime.emit({
          messageId: "message-1",
          text: "Visible output",
          timestamp: context.runtime.now(),
          type: "text.done",
        });
        context.runtime.emit({
          finishReason: "length",
          messageId: "message-1",
          timestamp: context.runtime.now(),
          type: "message.done",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
          },
        });

        return {
          messages: [
            {
              parts: [{ text: "Visible output", type: "text" }],
              providerMetadata: {
                provider: "test-provider",
              },
              role: "assistant",
            },
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
    const runtime = createTuvrenRuntimeCore({
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
            afterIteration(context) {
              capturedResponse = context.response;
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture synthesized response metadata"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedResponse).toEqual({
      finishReason: "length",
      parts: [{ text: "Visible output", type: "text" }],
      providerMetadata: {
        provider: "test-provider",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });
  });

  test("rejects driver results with more than one assistant message before afterIteration hooks run", async () => {
    const harness = createFakeKernelHarness();
    let capturedResponse:
      | {
          finishReason: string;
          parts: TuvrenModelResponse["parts"];
        }
      | undefined;
    const driver = {
      async execute() {
        return {
          messages: [
            assistantText("First assistant message."),
            {
              parts: [
                {
                  data: { ok: true },
                  name: "summary",
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
        extensions: [
          {
            afterIteration(context) {
              capturedResponse = {
                finishReason: context.response.finishReason,
                parts: context.response.parts,
              };
              return undefined;
            },
            name: "response-capture",
          },
        ],
        name: "primary",
      },
      signal: textSignal("Capture every assistant message"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(capturedResponse).toEqual({
      finishReason: "error",
      parts: [],
    });
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
  });

  test("clones afterIteration resolution, response, and toolResults per hook invocation", async () => {
    const harness = createFakeKernelHarness();
    const capturedSnapshots: Array<{
      resolutionType: string;
      responsePartName?: string;
      toolOutput: unknown;
    }> = [];
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "clone hook context" },
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
          messages: [assistantText("Search complete.")],
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
        extensions: [
          {
            afterIteration(context) {
              if (context.resolution.type !== "continue_iteration") {
                return undefined;
              }

              const firstPart = context.response.parts[0];
              const firstToolResult = context.toolResults?.[0];
              capturedSnapshots.push({
                resolutionType: context.resolution.type,
                responsePartName:
                  firstPart?.type === "tool_call" ? firstPart.name : undefined,
                toolOutput: firstToolResult?.output,
              });
              return undefined;
            },
            name: "capture",
          },
          {
            afterIteration(context) {
              const firstToolResult = context.toolResults?.[0];

              if (firstToolResult !== undefined) {
                firstToolResult.output = { mutated: true };
              }

              const firstPart = context.response.parts[0];

              if (firstPart?.type === "tool_call") {
                firstPart.name = "mutated";
              }

              if (context.resolution.type === "continue_iteration") {
                Object.assign(context.resolution, {
                  reason: "mutated",
                  type: "end_turn",
                });
              }
              return undefined;
            },
            name: "mutate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs",
            execute(input: unknown) {
              return {
                query: readQueryInput(input),
                result: "ok",
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
      signal: textSignal("Clone afterIteration hook context"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedSnapshots).toHaveLength(1);
    expect(capturedSnapshots[0]?.resolutionType).toBe("continue_iteration");
    expect(capturedSnapshots[0]?.toolOutput).toEqual({
      query: "clone hook context",
      result: "ok",
    });
    expect(capturedSnapshots[0]?.responsePartName).toBe("search");
    expect(handle.status().phase).toBe("completed");
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const tools: TuvrenToolDefinition[] = [
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
    expect(afterIterationCount).toBe(1);
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
    const resumedTurnStartIndex = resumedEvents.findIndex(
      (event) => event.type === "turn.start"
    );
    const approvalResolvedIndex = resumedEvents.findIndex(
      (event) => event.type === "approval.resolved"
    );

    expect(resumedEvents.slice(0, 2).map((event) => event.type)).toEqual([
      "turn.start",
      "approval.resolved",
    ]);
    expect(resumedTurnStartIndex).toBeGreaterThan(-1);
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(true);
    expect(approvalResolvedIndex).toBeGreaterThan(resumedTurnStartIndex);
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
    expect(afterIterationCount).toBe(3);
    expect(messages).toHaveLength(5);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("does not publish resumed turn.start when closing the paused run fails", async () => {
    const harness = createFakeKernelHarness();
    let failPausedRunClose = false;
    const originalComplete = harness.kernel.run.complete;
    harness.kernel.run.complete = async (runId, status, eventHash) => {
      if (failPausedRunClose && status === "failed") {
        failPausedRunClose = false;
        throw new Error("paused run close failed");
      }

      return await originalComplete(runId, status, eventHash);
    };

    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Approval needed", to: "ops@example.com" },
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
    const runtime = createTuvrenRuntimeCore({
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
            description: "Pause for approval",
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
      signal: textSignal("Pause before failed resume prelude"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    failPausedRunClose = true;

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const errorEvent = resumedEvents.find(
      (
        event
      ): event is Extract<(typeof resumedEvents)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(resumedEvents.some((event) => event.type === "turn.start")).toBe(
      false
    );
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(false);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.message).toBe("paused run close failed");
  });

  test("surfaces normalized approval inputs and executes the same normalized payload after resume", async () => {
    const harness = createFakeKernelHarness();
    const executedInputs: unknown[] = [];
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-normalize",
                  input: { raw: true },
                  name: "normalize",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Normalization completed.")],
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
    const normalizedSchema = {
      toJSONSchema() {
        return {
          properties: {
            raw: { type: "boolean" },
          },
          required: ["raw"],
          type: "object",
        };
      },
      validate(input) {
        return {
          valid: true,
          value: {
            normalized: true,
            original: input,
          },
        };
      },
    } satisfies CustomSchema;
    const runtime = createTuvrenRuntimeCore({
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
            description: "Normalize input before approval",
            execute(input) {
              executedInputs.push(input);
              return input;
            },
            inputSchema: normalizedSchema,
            name: "normalize",
          },
        ],
      },
      signal: textSignal("Normalize approval"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    expect(pausedHandle.status().approval?.toolCalls[0]?.input).toEqual({
      normalized: true,
      original: { raw: true },
    });

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-normalize", type: "approve" }],
    });

    await collectEvents(resumedHandle.events());

    expect(executedInputs).toEqual([
      {
        normalized: true,
        original: { raw: true },
      },
    ]);
  });

  test("keeps a valid paused snapshot on the exhausted handle after approval resume", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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

    expect(pausedHandle.status().phase).toBe("paused");
    expect(pausedHandle.status().pauseReason).toBe("approval_required");
    expect(pausedHandle.status().approval?.toolCalls[0]?.callId).toBe(
      "call-email"
    );
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
    const runtime = createTuvrenRuntimeCore({
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

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("paused");
    expect(handle.status().activeAgent).toBe("primary");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      pauseReason: "approval_required",
      state: "paused",
    });
  });

  test("finalizes failed runtime status when afterIteration upgrades an approval pause to hard fail", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute() {
        return {
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
    const runtime = createTuvrenRuntimeCore({
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
            afterIteration(context) {
              if (context.resolution.type !== "pause") {
                return undefined;
              }

              return {
                error: new Error("afterIteration rejected the approval pause"),
                verdict: "hardFail",
              };
            },
            name: "pause-hard-fail",
          },
        ],
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
      signal: textSignal("Pause then fail"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const turnEndEvent = events.findLast(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "turn.end" }> =>
        event.type === "turn.end"
    );

    expect(handle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(errorEvent?.error.message).toBe(
      "afterIteration rejected the approval pause"
    );
    expect(turnEndEvent?.status).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("keeps live handle activeAgent framework-owned while a turn is still running", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    let releaseSecondIteration: (() => void) | undefined;
    const secondIterationGate = new Promise<void>((resolve) => {
      releaseSecondIteration = resolve;
    });
    const driver = {
      async execute(_context) {
        executeCount += 1;

        if (executeCount === 1) {
          return {
            messages: [assistantText("First pass complete.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        await secondIterationGate;
        return {
          messages: [assistantText("Second pass complete.")],
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
      signal: textSignal("Keep the turn running"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await waitFor(() => {
      const status = handle.status();
      return status.phase === "running" && status.manifest?.messageCount === 2;
    });

    expect(handle.status().activeAgent).toBe("primary");

    if (releaseSecondIteration === undefined) {
      throw new Error("second iteration gate was not initialized");
    }

    releaseSecondIteration();
    await capture.done;

    expect(handle.status().phase).toBe("completed");
  });

  test("ends the loop at maxIterations and finalizes completed runtime status", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute() {
        executeCount += 1;
        return {
          messages: [assistantText(`Iteration ${executeCount} complete.`)],
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        maxIterations: 2,
        name: "primary",
      },
      signal: textSignal("Stop at the loop limit"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const turnEndEvent = events.find(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "turn.end" }> =>
        event.type === "turn.end"
    );

    expect(executeCount).toBe(2);
    expect(
      events.filter((event) => event.type === "iteration.start").length
    ).toBe(2);
    expect(
      events.filter((event) => event.type === "iteration.end").length
    ).toBe(2);
    expect(turnEndEvent?.status).toBe("completed");
    expect(handle.status().phase).toBe("completed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "completed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Stop at the loop limit", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Iteration 1 complete.", type: "text" }],
        role: "assistant",
      },
      {
        parts: [{ text: "Iteration 2 complete.", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("stops the iteration loop after cancellation without entering another pass", async () => {
    const harness = createFakeKernelHarness();
    let executeCount = 0;
    const driver = {
      async execute(context) {
        executeCount += 1;

        if (executeCount === 1) {
          return {
            messages: [assistantText("First pass complete.")],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        await waitForAbort(context.signal);
        return {
          messages: [assistantText("Interrupted second pass.")],
          partial: true,
          resolution: {
            error: new Error("driver noticed cancellation"),
            fatality: "hard",
            type: "fail",
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
      signal: textSignal("Cancel during the second pass"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await waitFor(() => handle.status().phase === "running");
    await waitFor(() => handle.status().iterationCount === 2);

    handle.cancel();
    await capture.done;

    const errorEvent = capture.events.find(
      (
        event
      ): event is Extract<(typeof capture.events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(executeCount).toBe(2);
    expect(handle.status().phase).toBe("failed");
    expect(
      capture.events.filter((event) => event.type === "iteration.start").length
    ).toBe(2);
    expect(
      capture.events.filter((event) => event.type === "iteration.end").length
    ).toBe(2);
    expect(errorEvent?.error.code).toBe("runtime_execution_cancelled");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      partial: true,
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Cancel during the second pass", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "First pass complete.", type: "text" }],
        role: "assistant",
      },
      {
        parts: [{ text: "Interrupted second pass.", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("rejects driver-provided pause resolutions that are not rooted in tool approvals", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [assistantText("Pause for external review.")],
          resolution: {
            approval: {
              completedResults: [],
              toolCalls: [
                {
                  callId: "driver-review",
                  decisions: ["approve", "reject"],
                  input: { review: true },
                  message: "Resume after external review.",
                  name: "driver_review",
                },
              ],
            },
            reason: "driver_review_required",
            type: "pause",
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Pause for driver review"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(pausedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(pausedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("fails invalid driver resolutions even when earlier custom events were published live", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        context.runtime.emit({
          data: {
            leaked: true,
          },
          name: "ghost.output",
          timestamp: context.runtime.now(),
          type: "custom",
        });

        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "invalid resolution" },
                name: "search",
              },
            ]),
          ],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        };
      },
      id: "fake",
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
      signal: textSignal("Reject ghost output"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(
      events.some(
        (event) => event.type === "custom" && event.name === "ghost.output"
      )
    ).toBe(true);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_driver_result");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Reject ghost output", type: "text" }],
        role: "user",
      },
    ]);
    expect(
      (await harness.readBranchRuns(thread.branchId)).some(
        (run) =>
          run.status === "failed" &&
          run.stepSequence.some((step) => step.id === "iterate")
      )
    ).toBe(true);
    expect(
      (await harness.readBranchRuns(thread.branchId)).some(
        (run) =>
          run.status === "completed" &&
          run.stepSequence.some((step) => step.id === "iterate")
      )
    ).toBe(false);
  });

  test("fails the resumed turn instead of rewriting approval into rejection when the fresh resumed handle is canceled before start", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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
              emailCalls += 1;
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

    await collectEvents(pausedHandle.events());
    pausedHandle.cancel();

    expect(pausedHandle.status().phase).toBe("paused");
    expect(pausedHandle.status().pauseReason).toBe("approval_required");
    expect(pausedHandle.status().approval?.toolCalls[0]?.callId).toBe(
      "call-email"
    );

    await waitForAsync(async () => {
      const runtimeStatus = await harness.readBranchRuntimeStatus(
        thread.branchId
      );

      return (
        runtimeStatus !== null &&
        typeof runtimeStatus === "object" &&
        "state" in runtimeStatus &&
        runtimeStatus.state === "completed"
      );
    });

    const messages = extractToolMessages(
      await harness.readBranchMessages(thread.branchId)
    );

    expect(emailCalls).toBe(0);
    expect(pausedHandle.status().phase).toBe("completed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "completed",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]?.type).toBe("tool_result");
    if (messages[0]?.parts[0]?.type === "tool_result") {
      expect(messages[0].parts[0].isError).toBe(true);
      expect(JSON.stringify(messages[0].parts[0].output)).toContain("rejected");
    }
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "This should not resume."
      )
    ).toBe(false);
  });

  test("preserves carried afterIteration state updates when a paused approval is canceled", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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
            afterIteration(context) {
              if (context.resolution.type !== "pause") {
                return undefined;
              }

              return {
                state: {
                  preservedAcrossCancel: true,
                },
              };
            },
            name: "approval-state",
          },
        ],
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
      signal: textSignal("Pause then cancel with carried state"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    pausedHandle.cancel();

    await waitForAsync(async () => {
      const runtimeStatus = await harness.readBranchRuntimeStatus(
        thread.branchId
      );

      return (
        runtimeStatus !== null &&
        typeof runtimeStatus === "object" &&
        "state" in runtimeStatus &&
        runtimeStatus.state === "completed"
      );
    });

    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );

    expect(manifest.extensions["approval-state"]).toEqual({
      preservedAcrossCancel: true,
    });
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "This should not resume."
      )
    ).toBe(false);
  });

  test("keeps the old paused handle inert after resolveApproval returns a fresh handle", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Approval needed", to: "ops@example.com" },
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
          messages: [assistantText("This should not be reached.")],
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
      signal: textSignal("Pause then cancel after approval"),
      threadId: thread.threadId,
    });
    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    expect(() => pausedHandle.cancel()).toThrow(
      "cancel() is not valid once approval has been resolved"
    );
    const resumedEvents = await collectEvents(resumedHandle.events());

    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "completed",
    });
    expect(pausedHandle.status().phase).toBe("paused");
    expect(resumedHandle.status().phase).toBe("completed");
    expect(resumedEvents.some((event) => event.type === "turn.end")).toBe(true);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "This should not be reached."
      )
    ).toBe(true);
  });

  test("does not revive a cancelled resumed handle when events start later", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Approval needed", to: "ops@example.com" },
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
    const runtime = createTuvrenRuntimeCore({
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
            description: "Pause for approval",
            execute() {
              emailCalls += 1;
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
      signal: textSignal("Pause, approve, then cancel before start"),
      threadId: thread.threadId,
    });
    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    resumedHandle.cancel();

    const resumedEvents = await collectEvents(resumedHandle.events());
    const errorEvent = resumedEvents.find(
      (
        event
      ): event is Extract<(typeof resumedEvents)[number], { type: "error" }> =>
        event.type === "error"
    );
    const turnEndEvent = resumedEvents.findLast(
      (
        event
      ): event is Extract<
        (typeof resumedEvents)[number],
        { type: "turn.end" }
      > => event.type === "turn.end"
    );
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(emailCalls).toBe(0);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(
      resumedEvents.some((event) => event.type === "approval.resolved")
    ).toBe(true);
    expect(errorEvent?.fatal).toBe(true);
    expect(turnEndEvent?.status).toBe("failed");
    expect(extractToolMessages(messages)).toEqual([]);
    expect(messages).toEqual([
      {
        parts: [
          { text: "Pause, approve, then cancel before start", type: "text" },
        ],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-email",
            input: { subject: "Approval needed", to: "ops@example.com" },
            name: "email",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
    expect(hasAssistantText(messages, "This should not resume.")).toBe(false);
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("canceling a resumed handle before stream consumption still closes the paused run", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Approval needed", to: "ops@example.com" },
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
    const runtime = createTuvrenRuntimeCore({
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
            description: "Pause for approval",
            execute() {
              emailCalls += 1;
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
      signal: textSignal("Pause, approve, then cancel lazily"),
      threadId: thread.threadId,
    });
    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    resumedHandle.cancel();

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

    expect(emailCalls).toBe(0);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Pause, approve, then cancel lazily", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-email",
            input: { subject: "Approval needed", to: "ops@example.com" },
            name: "email",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("preserves queued steering across approval resume", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );
        const steeringSeen = context.messages.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "Late steering"
            )
        );

        if (toolMessages.length === 0) {
          await delay(20);
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: { subject: "Approval needed", to: "ops@example.com" },
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
          messages: [
            assistantText(
              steeringSeen ? "Saw transferred steering." : "Missed steering."
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
    const runtime = createTuvrenRuntimeCore({
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
            description: "Pause for steering transfer",
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
      signal: textSignal("Pause after queued steering"),
      threadId: thread.threadId,
    });
    const pausedEventsPromise = collectEvents(handle.events());

    await delay(0);
    handle.steer(textSignal("Late steering"));
    await waitFor(() => handle.status().phase === "paused");

    const resumedHandle = handle.resolveApproval({
      decisions: [{ callId: "call-email", type: "approve" }],
    });
    await collectEvents(resumedHandle.events());

    await pausedEventsPromise;

    expect(await harness.readBranchMessages(thread.branchId)).toEqual(
      expect.arrayContaining([
        {
          parts: [{ text: "Late steering", type: "text" }],
          role: "user",
        },
      ])
    );
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Saw transferred steering."
      )
    ).toBe(true);
  });

  test("preserves receiver context for function and object-form aroundTool handlers", async () => {
    interface MethodAroundToolExtension extends TuvrenExtension {
      aroundTool(
        context: AroundToolContext,
        next: (context?: AroundToolContext) => Promise<ToolResultPart>
      ): Promise<AroundToolResult> | AroundToolResult;
      aroundToolCalls: number;
      label: string;
    }

    interface AroundToolSpecReceiver {
      calls: number;
      handler(
        context: AroundToolContext,
        next: (context?: AroundToolContext) => Promise<ToolResultPart>
      ): Promise<AroundToolResult> | AroundToolResult;
      label: string;
      tools: string[];
    }

    const harness = createFakeKernelHarness();
    const originalMetadata = {
      channel: "primary",
    };
    let sameAroundToolRef = false;
    let sameAroundMetadataRef = false;
    let sameExecuteMetadataRef = false;
    const methodExtension: MethodAroundToolExtension = {
      aroundTool(_context, next) {
        this.aroundToolCalls += 1;

        if (this.label !== "method" || this.aroundToolCalls !== 1) {
          throw new Error("lost function-form aroundTool receiver");
        }

        return next();
      },
      aroundToolCalls: 0,
      label: "method",
      name: "method-around-tool",
    };
    const aroundToolSpec: AroundToolSpecReceiver = {
      handler(context, next) {
        this.calls += 1;

        if (
          this.label !== "spec" ||
          this.calls !== 1 ||
          !this.tools.includes(context.tool.name)
        ) {
          throw new Error("lost object-form aroundTool receiver");
        }

        return next();
      },
      calls: 0,
      label: "spec",
      tools: ["email"],
    };
    const specExtension: TuvrenExtension = {
      aroundTool: aroundToolSpec,
      name: "spec-around-tool",
    };
    const originalTool: TuvrenToolDefinition = {
      description: "Send email",
      execute(_input, context) {
        sameExecuteMetadataRef = context.metadata === originalMetadata;

        if (
          context.metadata !== undefined &&
          typeof context.metadata === "object" &&
          !Array.isArray(context.metadata)
        ) {
          context.metadata.channel = "mutated-in-execute";
        }

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
      metadata: originalMetadata,
      name: "email",
    };
    methodExtension.aroundTool = function (context, next) {
      this.aroundToolCalls += 1;
      sameAroundToolRef = context.tool === originalTool;
      sameAroundMetadataRef = context.tool.metadata === originalMetadata;

      if (
        context.tool.metadata !== undefined &&
        typeof context.tool.metadata === "object" &&
        !Array.isArray(context.tool.metadata)
      ) {
        context.tool.metadata.channel = "mutated-in-around";
      }

      if (this.label !== "method" || this.aroundToolCalls !== 1) {
        throw new Error("lost function-form aroundTool receiver");
      }

      return next();
    };
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: {
                    subject: "Receiver binding",
                    to: "ops@example.com",
                  },
                  name: "email",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "parallel",
          };
        }

        const receiverLost = toolMessages.some((message) =>
          message.parts.some((part) => part.isError === true)
        );

        return {
          messages: [
            assistantText(
              receiverLost
                ? "aroundTool receivers lost."
                : "aroundTool receivers preserved."
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        extensions: [methodExtension, specExtension],
        name: "primary",
        tools: [originalTool],
      },
      signal: textSignal("Exercise aroundTool receivers"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().phase).toBe("completed");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "aroundTool receivers preserved."
      )
    ).toBe(true);
    expect(sameAroundToolRef).toBe(false);
    expect(sameAroundMetadataRef).toBe(false);
    expect(sameExecuteMetadataRef).toBe(false);
    expect(originalMetadata.channel).toBe("primary");
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
    const runtime = createTuvrenRuntimeCore({
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

  test("finalizes failed runtime status when afterIteration upgrades a renewed approval pause to hard fail", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
          messages: [assistantText("This should not be reached.")],
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
    const runtime = createTuvrenRuntimeCore({
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
            afterIteration(context) {
              if (
                context.resolution.type !== "pause" ||
                (context.toolResults?.length ?? 0) === 0
              ) {
                return undefined;
              }

              return {
                error: new Error(
                  "afterIteration rejected the renewed approval"
                ),
                verdict: "hardFail",
              };
            },
            name: "pause-hard-fail",
          },
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
      signal: textSignal("Resume both tools then hard fail"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-review", type: "approve" },
        { callId: "call-search", type: "approve" },
      ],
    });
    const events = await collectEvents(resumedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );
    const turnEndEvent = events.findLast(
      (
        event
      ): event is Extract<(typeof events)[number], { type: "turn.end" }> =>
        event.type === "turn.end"
    );

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(errorEvent?.error.message).toBe(
      "afterIteration rejected the renewed approval"
    );
    expect(turnEndEvent?.status).toBe("failed");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "primary",
      state: "failed",
    });
  });

  test("rejects malformed aroundTool approval requests before pause state is published", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
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
    const runtime = createTuvrenRuntimeCore({
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

  test("does not hang mixed batches when malformed approvals race immediate tool errors", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-missing",
                input: { query: "missing" },
                name: "missing",
              },
              {
                callId: "call-review",
                input: { item: "mixed" },
                name: "review",
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
    const runtime = createTuvrenRuntimeCore({
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
              if (context.tool.name !== "review") {
                throw new Error("unexpected tool");
              }

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
                      message: "broken mixed approval",
                      name: context.tool.name,
                    },
                  ],
                },
                verdict: "pause",
              };
            },
            name: "broken-mixed-approval",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Break the mixed approval batch"),
      threadId: thread.threadId,
    });

    const events = await settleWithin(collectEvents(handle.events()), 100);

    expect(events).not.toBe(TIMEOUT_TOKEN);

    if (events === TIMEOUT_TOKEN) {
      throw new Error("expected malformed mixed approval batch to terminate");
    }

    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
  });

  test("aborts cooperative sibling tools without checkpointing malformed initial approval batches", async () => {
    const harness = createFakeKernelHarness();
    let searchSideEffectCount = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "abort me" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "abort me" },
                name: "review",
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
    const runtime = createTuvrenRuntimeCore({
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
            aroundTool(context, next) {
              if (context.tool.name === "review") {
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
                        message: "broken initial approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-initial-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs slowly",
            async execute(_input, context) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  resolve();
                }, 40);
                context.signal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timer);
                    reject(new Error("search aborted"));
                  },
                  { once: true }
                );
              });
              searchSideEffectCount += 1;
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
          {
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Continue sibling tools on malformed approval"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    await delay(60);

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(searchSideEffectCount).toBe(0);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("waits for non-cooperative sibling tools to settle before surfacing malformed initial approval failures", async () => {
    const harness = createFakeKernelHarness();
    let slowSideEffectCount = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "slow side effect" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "broken approval" },
                name: "review",
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
    const runtime = createTuvrenRuntimeCore({
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
            aroundTool(context, next) {
              if (context.tool.name === "review") {
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
                        message: "broken initial approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-initial-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Ignore abort and finish later",
            async execute() {
              await delay(40);
              slowSideEffectCount += 1;
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
          {
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Wait for the slow sibling"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(slowSideEffectCount).toBe(1);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("does not checkpoint resumed sibling tool progress when resume approval is malformed", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "resume batch" },
                  name: "search",
                },
                {
                  callId: "call-review",
                  input: { item: "resume batch" },
                  name: "review",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("This should not be reached.")],
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
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "broken resume approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-resume-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Search docs",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: readQueryInput(input),
                result: "ok",
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
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Break the resumed approval batch"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-search", type: "approve" },
        { callId: "call-review", type: "approve" },
      ],
    });
    const events = await collectEvents(resumedHandle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(searchCalls).toBe(1);
    expect(resumedHandle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Break the resumed approval batch", type: "text" }],
        role: "user",
      },
      {
        parts: [
          {
            callId: "call-search",
            input: { query: "resume batch" },
            name: "search",
            type: "tool_call",
          },
          {
            callId: "call-review",
            input: { item: "resume batch" },
            name: "review",
            type: "tool_call",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("aborts cooperative resumed sibling tools without checkpointing malformed approvals", async () => {
    const harness = createFakeKernelHarness();
    let searchSideEffectCount = 0;
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "resume abort" },
                  name: "search",
                },
                {
                  callId: "call-review",
                  input: { item: "resume abort" },
                  name: "review",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("This should not be reached.")],
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
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "broken resume approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-resume-review-abort-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Search docs slowly",
            async execute(_input, context) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  resolve();
                }, 40);
                context.signal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timer);
                    reject(new Error("search aborted"));
                  },
                  { once: true }
                );
              });
              searchSideEffectCount += 1;
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
          {
            approval: true,
            description: "Review docs",
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
        ],
      },
      signal: textSignal(
        "Continue resumed sibling tools on malformed approval"
      ),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-search", type: "approve" },
        { callId: "call-review", type: "approve" },
      ],
    });
    await collectEvents(resumedHandle.events());

    await delay(60);

    expect(resumedHandle.status().phase).toBe("failed");
    expect(searchSideEffectCount).toBe(0);
    expect(
      extractToolMessages(await harness.readBranchMessages(thread.branchId))
    ).toHaveLength(0);
  });

  test("does not checkpoint sibling tool progress when a parallel batch fails on invalid approval", async () => {
    const harness = createFakeKernelHarness();
    let searchCalls = 0;
    const driver = {
      async execute(_context) {
        return {
          messages: [
            assistantToolCalls([
              {
                callId: "call-search",
                input: { query: "parallel batch" },
                name: "search",
              },
              {
                callId: "call-review",
                input: { item: "proposal" },
                name: "review",
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
    const runtime = createTuvrenRuntimeCore({
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
            aroundTool(context, next) {
              if (context.tool.name === "review") {
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
                        decisions: ["approve", "reject"],
                        input: context.input,
                        message: "broken approval",
                        name: context.tool.name,
                      },
                    ],
                  },
                  verdict: "pause",
                };
              }

              return next();
            },
            name: "broken-review-gate",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Search docs",
            execute(input: unknown) {
              searchCalls += 1;
              return {
                query: readQueryInput(input),
                result: "ok",
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
            description: "Review docs",
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
        ],
      },
      signal: textSignal("Break the parallel approval batch"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(searchCalls).toBe(1);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Break the parallel approval batch", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("rejects aroundTool pauses returned after next()", async () => {
    const harness = createFakeKernelHarness();
    let executeCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(executeCalls).toBe(1);
    expect(handle.status().phase).toBe("failed");
    expect(errorEvent?.error.code).toBe("invalid_approval_request");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false
    );
    expect(events.some((event) => event.type === "tool.result")).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Late pause", type: "text" }],
        role: "user",
      },
    ]);
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
    const runtime = createTuvrenRuntimeCore({
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

  test("isolates aroundTool manifest state and shared exports between extensions", async () => {
    const harness = createFakeKernelHarness();
    let observedState:
      | {
          extensionState: Record<string, unknown>;
          manifestState: Record<string, unknown> | undefined;
          sharedExports: Record<string, unknown> | undefined;
        }
      | undefined;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-search",
                  input: { query: "isolate state" },
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
          messages: [assistantText("AroundTool contexts stayed isolated.")],
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
        extensions: [
          {
            aroundTool(context, next) {
              if (
                context.manifest.extensions.b !== null &&
                typeof context.manifest.extensions.b === "object" &&
                !Array.isArray(context.manifest.extensions.b)
              ) {
                Reflect.set(context.manifest.extensions.b, "leaked", true);
              }

              if (context.sharedExports.b !== undefined) {
                context.sharedExports.b.leaked = true;
              }

              return next();
            },
            name: "a",
            state: {
              shared: "alpha",
            },
          },
          {
            aroundTool(context, next) {
              observedState = {
                extensionState: globalThis.structuredClone(
                  context.extensionState
                ),
                manifestState: toOptionalRecord(context.manifest.extensions.b),
                sharedExports: toOptionalRecord(context.sharedExports.b),
              };
              return next();
            },
            exports: ["shared"],
            name: "b",
            state: {
              shared: "beta",
            },
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
      signal: textSignal("Isolate aroundTool state"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(observedState).toEqual({
      extensionState: {
        shared: "beta",
      },
      manifestState: {
        shared: "beta",
      },
      sharedExports: {
        shared: "beta",
      },
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
    const runtime = createTuvrenRuntimeCore({
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

  test("caps parallel tool execution with wave-ordered tool events", async () => {
    const harness = createFakeKernelHarness();
    const activeCalls = new Set<string>();
    let maxActiveCalls = 0;
    const completions: string[] = [];
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-a",
                  input: { delay: 20, id: "a" },
                  name: "work",
                },
                {
                  callId: "call-b",
                  input: { delay: 5, id: "b" },
                  name: "work",
                },
                {
                  callId: "call-c",
                  input: { delay: 1, id: "c" },
                  name: "work",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
          messages: [assistantText("Capped tools finished.")],
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
      defaultMaxParallelToolCalls: 1,
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        maxParallelToolCalls: 2,
        name: "primary",
        tools: [
          {
            description: "Track bounded work",
            async execute(input: unknown) {
              const record = toOptionalRecord(input);

              if (
                record === undefined ||
                typeof record.id !== "string" ||
                typeof record.delay !== "number"
              ) {
                throw new Error("invalid work input");
              }

              activeCalls.add(record.id);
              maxActiveCalls = Math.max(maxActiveCalls, activeCalls.size);
              await delay(record.delay);
              activeCalls.delete(record.id);
              completions.push(record.id);
              return {
                id: record.id,
              };
            },
            inputSchema: {
              properties: {
                delay: { type: "number" },
                id: { type: "string" },
              },
              required: ["id", "delay"],
              type: "object",
            },
            name: "work",
          },
        ],
      },
      signal: textSignal("Run capped tools"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const toolTimeline = events
      .filter(
        (event) => event.type === "tool.start" || event.type === "tool.result"
      )
      .map((event) => `${event.type}:${event.callId}`);

    expect(maxActiveCalls).toBe(2);
    expect(completions).toEqual(["b", "a", "c"]);
    expect(toolTimeline).toEqual([
      "tool.start:call-a",
      "tool.start:call-b",
      "tool.result:call-b",
      "tool.result:call-a",
      "tool.start:call-c",
      "tool.result:call-c",
    ]);
  });

  test("runs tool batches sequentially when the driver selects sequential mode", async () => {
    const harness = createFakeKernelHarness();
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-slow",
                  input: { query: "slow" },
                  name: "slow",
                },
                {
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "sequential",
          };
        }

        return {
          messages: [assistantText("Sequential tools finished.")],
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
      signal: textSignal("Run sequential tools"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const toolEvents = events.filter(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { callId: string; type: "tool.start" | "tool.result" }
      > => event.type === "tool.start" || event.type === "tool.result"
    );

    expect(toolEvents.map((event) => `${event.type}:${event.callId}`)).toEqual([
      "tool.start:call-slow",
      "tool.result:call-slow",
      "tool.start:call-fast",
      "tool.result:call-fast",
    ]);
  });

  test("stops resolving later sequential tool calls after the first approval gate", async () => {
    const harness = createFakeKernelHarness();
    const approvalChecks: string[] = [];
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-first",
                  input: { query: "first" },
                  name: "first",
                },
                {
                  callId: "call-second",
                  input: { query: "second" },
                  name: "second",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
            toolExecutionMode: "sequential",
          };
        }

        return {
          messages: [assistantText("This should not be reached.")],
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
        name: "primary",
        tools: [
          {
            approval() {
              approvalChecks.push("first");
              return true;
            },
            description: "Pause first",
            execute() {
              return { ok: false };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "first",
          },
          {
            approval() {
              approvalChecks.push("second");
              return false;
            },
            description: "Should not be inspected yet",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "second",
          },
        ],
      },
      signal: textSignal("Pause sequentially at the first approval gate"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const approvalEvent = events.find(
      (
        event
      ): event is Extract<
        (typeof events)[number],
        { type: "approval.requested" }
      > => event.type === "approval.requested"
    );

    expect(handle.status().phase).toBe("paused");
    expect(approvalChecks).toEqual(["first"]);
    expect(
      approvalEvent?.request.toolCalls.map((toolCall) => toolCall.callId)
    ).toEqual(["call-first"]);
  });

  test("emits all parallel tool.start events before any tool.result when aroundTool preflights are delayed", async () => {
    const harness = createFakeKernelHarness();
    const completedCalls: string[] = [];
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-fast",
                  input: { query: "fast" },
                  name: "fast",
                },
                {
                  callId: "call-delayed",
                  input: { query: "delayed" },
                  name: "delayed",
                },
              ]),
            ],
            resolution: {
              type: "continue_iteration",
            },
          };
        }

        return {
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
    const runtime = createTuvrenRuntimeCore({
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
              if (context.tool.name === "delayed") {
                await delay(20);
              }

              return await next();
            },
            name: "delayed-preflight",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Finish quickly",
            execute(input: unknown) {
              completedCalls.push(`fast:${readQueryInput(input)}`);
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
            description: "Finish after preflight",
            execute(input: unknown) {
              completedCalls.push(`delayed:${readQueryInput(input)}`);
              return {
                status: "delayed",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "delayed",
          },
        ],
      },
      signal: textSignal("Run delayed preflight tools"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const firstToolResultIndex = events.findIndex(
      (event) => event.type === "tool.result"
    );
    const startEventsBeforeFirstResult = events.filter(
      (
        event,
        index
      ): event is Extract<
        (typeof events)[number],
        { callId: string; type: "tool.start" }
      > => index < firstToolResultIndex && event.type === "tool.start"
    );

    expect(firstToolResultIndex).toBeGreaterThan(0);
    expect(startEventsBeforeFirstResult.map((event) => event.callId)).toEqual([
      "call-fast",
      "call-delayed",
    ]);
    expect(completedCalls).toEqual(["fast:fast", "delayed:delayed"]);
  });

  test("preserves original parallel tool.start order when the first call has the slower preflight", async () => {
    const harness = createFakeKernelHarness();
    const completedCalls: string[] = [];
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-delayed",
                  input: { query: "delayed" },
                  name: "delayed",
                },
                {
                  callId: "call-fast",
                  input: { query: "fast" },
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
    const runtime = createTuvrenRuntimeCore({
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
              if (context.tool.name === "delayed") {
                await delay(20);
              }

              return await next();
            },
            name: "delayed-preflight",
          },
        ],
        name: "primary",
        tools: [
          {
            description: "Finish after preflight",
            execute(input: unknown) {
              completedCalls.push(`delayed:${readQueryInput(input)}`);
              return {
                status: "delayed",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "delayed",
          },
          {
            description: "Finish quickly",
            execute(input: unknown) {
              completedCalls.push(`fast:${readQueryInput(input)}`);
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
        ],
      },
      signal: textSignal("Run delayed-first preflight tools"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const firstToolResultIndex = events.findIndex(
      (event) => event.type === "tool.result"
    );
    const startEventsBeforeFirstResult = events.filter(
      (
        event,
        index
      ): event is Extract<
        (typeof events)[number],
        { callId: string; type: "tool.start" }
      > => index < firstToolResultIndex && event.type === "tool.start"
    );

    expect(firstToolResultIndex).toBeGreaterThan(0);
    expect(startEventsBeforeFirstResult.map((event) => event.callId)).toEqual([
      "call-delayed",
      "call-fast",
    ]);
    expect(completedCalls).toEqual(["fast:fast", "delayed:delayed"]);
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
    const runtime = createTuvrenRuntimeCore({
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

  test("stages and emits immediate invalid tool results before slower executable siblings finish", async () => {
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
            messages: [
              assistantToolCalls([
                {
                  callId: "call-missing",
                  input: { query: "missing" },
                  name: "missing",
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
    const runtime = createTuvrenRuntimeCore({
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
      signal: textSignal("Run mixed immediate and slow tools"),
      threadId: thread.threadId,
    });
    const capture = startEventCapture(handle.events());

    await waitForAsync(async () => {
      const stagedMessages = await harness.readRunningStagedMessages(
        thread.branchId
      );
      return extractToolMessages(stagedMessages).some(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-missing"
      );
    });

    expect(
      capture.events.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-missing"
      )
    ).toBe(true);

    releaseSlowTool?.();
    await capture.done;

    expect(
      capture.events.filter(
        (event) =>
          event.type === "tool.result" && event.callId === "call-missing"
      )
    ).toHaveLength(1);
    expect(
      extractToolMessages(
        await harness.readBranchMessages(thread.branchId)
      ).filter(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-missing"
      )
    ).toHaveLength(1);
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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

  test("aborts timed-out tool contexts and suppresses late tool events", async () => {
    const harness = createFakeKernelHarness();
    let observedAbort = false;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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
            description: "Time out cooperatively",
            async execute(_input, context) {
              await waitForAbort(context.signal);
              observedAbort = context.signal?.aborted === true;
              context.emit?.({
                data: { late: true },
                name: "late-tool-event",
              });
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
      signal: textSignal("Timeout tool cooperatively"),
      threadId: thread.threadId,
    });

    const capture = startEventCapture(handle.events());
    await capture.done;
    await delay(30);

    expect(observedAbort).toBe(true);
    expect(
      capture.events.some(
        (event) => event.type === "custom" && event.name === "late-tool-event"
      )
    ).toBe(false);
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
    const runtime = createTuvrenRuntimeCore({
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

  test("continues the same turn after explicit rejected approval decisions without executing the tool", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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
      (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
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
    expect(hasAssistantText(messages, "Acknowledged rejected tool.")).toBe(
      true
    );
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("preserves approval commentary on invalid edited approval inputs", async () => {
    const harness = createFakeKernelHarness();
    let emailCalls = 0;
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
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
          messages: [assistantText("Acknowledged invalid edit.")],
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
      signal: textSignal("Edit this tool incorrectly"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        {
          callId: "call-email",
          editedInput: { to: "ops@example.com" },
          message: "human note",
          type: "edit",
        },
      ],
    });
    await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const editedToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool"
    );

    expect(emailCalls).toBe(0);
    expect(editedToolMessage?.parts[0]?.type).toBe("tool_result");
    if (editedToolMessage?.parts[0]?.type === "tool_result") {
      expect(editedToolMessage.parts[0].isError).toBe(true);
      expect(editedToolMessage.parts[0].output).toEqual({
        approval: {
          editedInput: { to: "ops@example.com" },
          message: "human note",
          originalInput: {
            subject: "Status update",
            to: "ops@example.com",
          },
          type: "edit",
        },
        details: {
          decisionType: "edit",
          validation: expect.anything(),
        },
        error: "Approved tool input failed validation.",
      });
    }
    expect(hasAssistantText(messages, "Acknowledged invalid edit.")).toBe(true);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("executes edited approvals with the edited input and a durable audit trace", async () => {
    const harness = createFakeKernelHarness();
    const executedInputs: unknown[] = [];
    const originalInput = {
      subject: "Status update",
      to: "ops@example.com",
    };
    const editedInput = {
      subject: "Reviewed status update",
      to: "review@example.com",
    };
    const driver = {
      async execute(context) {
        const toolMessages = context.messages.filter(
          (message) => message.role === "tool"
        );

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-email",
                  input: originalInput,
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
          messages: [assistantText("Acknowledged edited tool.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Send a status email",
            execute(input) {
              executedInputs.push(input);
              return {
                sent: true,
                to:
                  input !== null &&
                  typeof input === "object" &&
                  "to" in input &&
                  typeof input.to === "string"
                    ? input.to
                    : "unknown",
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
      signal: textSignal("Edit this tool correctly"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());
    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        {
          callId: "call-email",
          editedInput,
          message: "Use the reviewed recipient instead.",
          type: "edit",
        },
      ],
    });
    const resumedEvents = await collectEvents(resumedHandle.events());
    const messages = await harness.readBranchMessages(thread.branchId);
    const assistantToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant" &&
        "parts" in message &&
        Array.isArray(message.parts) &&
        message.parts.some(
          (part) =>
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "tool_call"
        )
    );
    const editedToolMessage = messages.find(
      (message): message is Extract<TuvrenMessage, { role: "tool" }> =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "tool"
    );

    expect(executedInputs).toEqual([editedInput]);
    expect(
      resumedEvents.some(
        (event) =>
          event.type === "tool.start" &&
          event.callId === "call-email" &&
          JSON.stringify(event.input) === JSON.stringify(editedInput)
      )
    ).toBe(true);
    expect(assistantToolMessage?.parts[0]?.type).toBe("tool_call");
    if (assistantToolMessage?.parts[0]?.type === "tool_call") {
      expect(assistantToolMessage.parts[0].input).toEqual(originalInput);
    }
    expect(editedToolMessage?.parts[0]?.type).toBe("tool_result");
    if (editedToolMessage?.parts[0]?.type === "tool_result") {
      expect(editedToolMessage.parts[0].output).toEqual({
        approval: {
          editedInput,
          message: "Use the reviewed recipient instead.",
          originalInput,
          type: "edit",
        },
        result: {
          sent: true,
          to: "review@example.com",
        },
      });
    }
    expect(hasAssistantText(messages, "Acknowledged edited tool.")).toBe(true);
    expect(resumedHandle.status().phase).toBe("completed");
  });

  test("stages and emits immediate resumed decisions before slower approved siblings finish", async () => {
    const harness = createFakeKernelHarness();
    let releaseSlowTool: (() => void) | undefined;
    const slowTool = new Promise<void>((resolve) => {
      releaseSlowTool = resolve;
    });
    const driver = {
      async execute(context) {
        const toolMessages = extractToolMessages(context.messages);

        if (toolMessages.length === 0) {
          return {
            messages: [
              assistantToolCalls([
                {
                  callId: "call-reject",
                  input: { query: "reject" },
                  name: "rejectable",
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
          messages: [assistantText("Resume finished.")],
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
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [
          {
            approval: true,
            description: "Reject immediately on resume",
            execute() {
              return {
                status: "unexpected",
              };
            },
            inputSchema: {
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              type: "object",
            },
            name: "rejectable",
          },
          {
            approval: true,
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
      signal: textSignal("Pause for resume staging"),
      threadId: thread.threadId,
    });

    await collectEvents(pausedHandle.events());

    const resumedHandle = pausedHandle.resolveApproval({
      decisions: [
        { callId: "call-reject", type: "reject" },
        { callId: "call-slow", type: "approve" },
      ],
    });
    const capture = startEventCapture(resumedHandle.events());

    await waitForAsync(async () => {
      const stagedMessages = await harness.readRunningStagedMessages(
        thread.branchId
      );
      return extractToolMessages(stagedMessages).some(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-reject"
      );
    });

    expect(
      capture.events.some(
        (event) =>
          event.type === "tool.result" && event.callId === "call-reject"
      )
    ).toBe(true);

    releaseSlowTool?.();
    await capture.done;

    expect(
      capture.events.filter(
        (event) =>
          event.type === "tool.result" && event.callId === "call-reject"
      )
    ).toHaveLength(1);
    expect(
      extractToolMessages(
        await harness.readBranchMessages(thread.branchId)
      ).filter(
        (message) =>
          message.parts[0]?.type === "tool_result" &&
          message.parts[0].callId === "call-reject"
      )
    ).toHaveLength(1);
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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

  test("preserves the handed-off activeAgent when later execution fails", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: {
        contextPolicy: {
          evaluate() {
            throw new Error("reviewer context policy boom");
          },
        },
        name: "reviewer",
      },
    };
    const handoffDriver = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
            messages: [assistantText("Pass this to the reviewer.")],
            resolution: {
              contextPlan: context.handoff.createContextPlan({
                reason: "handoff",
                targetAgent: "reviewer",
              }),
              targetAgent: "reviewer",
              type: "handoff",
            },
          };
        }

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
      driverRegistry: createDriverRegistry([handoffDriver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start failing handoff"),
      threadId: thread.threadId,
    });

    const events = await collectEvents(handle.events());
    const errorEvent = events.find(
      (event): event is Extract<(typeof events)[number], { type: "error" }> =>
        event.type === "error"
    );

    expect(errorEvent?.error.message).toContain("reviewer context policy boom");
    expect(handle.status().phase).toBe("failed");
    expect(handle.status().activeAgent).toBe("reviewer");
    expect(await harness.readBranchRuntimeStatus(thread.branchId)).toEqual({
      activeAgent: "reviewer",
      state: "failed",
    });
  });

  test("lets drivers build valid handoff plans through DriverExecutionContext.handoff", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the driver helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    reason: "driver_helper_handoff",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [assistantText("Driver helper handoff completed.")],
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
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use the driver handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().activeAgent).toBe("reviewer");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Driver helper handoff completed."
      )
    ).toBe(true);
    expect(
      await readBranchCheckpointEventTypes(harness.kernel, thread.branchId)
    ).toEqual(expect.arrayContaining(["handoff_applied"]));
  });

  test("driver helper handoff plans accept provider-backed agent configs with extra provider state", async () => {
    const harness = createFakeKernelHarness();
    const primaryProvider = {
      extra: true,
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "unused primary provider output", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "primary-provider",
      async *stream() {
        yield* [];
      },
    };
    const reviewerProvider = {
      extra: true,
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "unused reviewer provider output", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "reviewer-provider",
      async *stream() {
        yield* [];
      },
    };
    const agents: Record<string, AgentConfig> = {
      primary: {
        model: primaryProvider,
        name: "primary",
      },
      reviewer: {
        model: reviewerProvider,
        name: "reviewer",
      },
    };
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the driver helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    reason: "driver_helper_handoff",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [
                assistantText("Provider-backed helper handoff completed."),
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
        } satisfies KrakenDriver,
      ]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Use the provider-backed driver handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(handle.status().activeAgent).toBe("reviewer");
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Provider-backed helper handoff completed."
      )
    ).toBe(true);
  });

  test("driver helper handoff plans use the latest source context at apply time", async () => {
    const harness = createFakeKernelHarness();
    let capturedSourceContext: HandoffSourceContext | undefined;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText("Passing this through the driver helper."),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    builder: (sourceContext) => {
                      capturedSourceContext = sourceContext;
                      return createPreserveTraceHandoffContextBuilder()(
                        sourceContext
                      );
                    },
                    reason: "driver_helper_handoff",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [assistantText("Reviewer complete.")],
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
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use the driver handoff helper"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedSourceContext?.messages).toEqual([
      {
        parts: [{ text: "Use the driver handoff helper", type: "text" }],
        role: "user",
      },
      {
        parts: [
          { text: "Passing this through the driver helper.", type: "text" },
        ],
        role: "assistant",
      },
    ]);
    expect(capturedSourceContext?.manifest.messageCount).toBe(2);
    expect(capturedSourceContext?.manifest.lastAssistantMessageIndex).toBe(1);
  });

  test("driver helper last_output_only handoffs forward the just-produced assistant output", async () => {
    const harness = createFakeKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [
                  assistantText(
                    "Passing this through the last_output_only helper."
                  ),
                ],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    mode: "last_output_only",
                    reason: "delegate",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [
                assistantText("Reviewer completed the pipeline step."),
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
        } satisfies KrakenDriver,
      ]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Start the pipeline"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [
          {
            text: "Passing this through the last_output_only helper.",
            type: "text",
          },
        ],
        role: "user",
      },
      {
        parts: [
          {
            text: "Reviewer completed the pipeline step.",
            type: "text",
          },
        ],
        role: "assistant",
      },
    ]);
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
    const runtime = createTuvrenRuntimeCore({
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
    const runtime = createTuvrenRuntimeCore({
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

  test("rolls back pre-handoff assistant output when the handoff builder fails", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const driver = {
      async execute(context) {
        return {
          messages: [assistantText("Passing this to review.")],
          resolution: {
            contextPlan: context.handoff.createContextPlan({
              builder() {
                return ["missing-handoff-message"];
              },
              reason: "delegate",
              targetAgent: "reviewer",
            }),
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Start rollback handoff"),
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
        parts: [{ text: "Start rollback handoff", type: "text" }],
        role: "user",
      },
    ]);
  });

  test("preserve_trace handoff preserves chronological summarized trace without raw tool traces", () => {
    let storedMessage: TuvrenMessage | null = null;
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
          parts: [{ text: "Please continue carefully.", type: "text" }],
          role: "user",
        },
        {
          parts: [{ text: "Second visible summary", type: "text" }],
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
    const firstUserIndex = handoffText.indexOf(
      "[User] Text request: Please investigate."
    );
    const firstAssistantIndex = handoffText.indexOf(
      "[Assistant] Text output: Visible summary"
    );
    const secondUserIndex = handoffText.indexOf(
      "[User] Text request: Please continue carefully.",
      firstUserIndex + 1
    );
    const secondAssistantIndex = handoffText.indexOf(
      "[Assistant] Text output: Second visible summary"
    );
    const toolIndex = handoffText.indexOf(
      '[Tool:search] Returned a result: {"result":"okay"}'
    );

    expect(handoffText).toContain("Visible summary");
    expect(handoffText).toContain("[Structured output produced]");
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
    expect(secondUserIndex).toBeGreaterThanOrEqual(firstAssistantIndex);
    expect(secondAssistantIndex).toBeGreaterThan(secondUserIndex);
    expect(toolIndex).toBeGreaterThan(secondAssistantIndex);
    expect(handoffText).not.toContain("private reasoning");
    expect(handoffText).toContain("Please investigate.");
    expect(handoffText).toContain("Please continue carefully.");
    expect(handoffText).not.toContain("leak me");
    expect(handoffText).toContain("okay");
    expect(handoffText).not.toContain('"secret":true');
  });

  test("preserve_trace handoff summarizes assistant text instead of copying it verbatim", () => {
    let storedMessage: TuvrenMessage | null = null;
    const builder = createPreserveTraceHandoffContextBuilder();
    const longAssistantText = `First line with spacing\n${"x".repeat(180)}`;
    const normalizedText = longAssistantText.replace(/\s+/g, " ").trim();
    const expectedSummary = `${normalizedText.slice(0, 117)}...`;

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
          return "1".repeat(64);
        },
        storeMessages() {
          return [];
        },
      },
      manifest: createContextManifest([]),
      messages: [
        {
          parts: [{ text: longAssistantText, type: "text" }],
          role: "assistant",
        },
      ],
      sourceAgent: { name: "primary" },
      targetAgent: { name: "reviewer" },
    } satisfies HandoffSourceContext);

    const handoffText = extractSingleUserText(storedMessage);
    const assistantLine = handoffText
      .split("\n")
      .find((line) => line.startsWith("[Assistant]"));

    expect(assistantLine).toBe(`[Assistant] Text output: ${expectedSummary}`);
    expect(handoffText).not.toContain(longAssistantText);
  });

  test("driver handoff plans expose full source and target agent configs", async () => {
    const harness = createFakeKernelHarness();
    const capturedAgents: Array<{
      source: AgentConfig;
      target: AgentConfig;
    }> = [];
    const reviewerTool = {
      description: "Review a draft",
      execute() {
        return { approved: true };
      },
      inputSchema: {
        properties: {
          draft: { type: "string" },
        },
        required: ["draft"],
        type: "object",
      },
      name: "review_draft",
    } satisfies TuvrenToolDefinition;
    const agents: Record<string, AgentConfig> = {
      primary: {
        name: "primary",
        systemPrompt: "You are the primary agent.",
        tools: [
          {
            description: "Plan work",
            execute() {
              return { ok: true };
            },
            inputSchema: {
              type: "object",
            },
            name: "plan_work",
          },
        ],
      },
      reviewer: {
        name: "reviewer",
        responseFormat: {
          name: "review",
          schema: {
            properties: {
              approved: { type: "boolean" },
            },
            required: ["approved"],
            type: "object",
          },
        },
        systemPrompt: "You review drafts.",
        tools: [reviewerTool],
      },
    };
    const driver = {
      async execute(context) {
        if (context.config.name === "reviewer") {
          return {
            messages: [assistantText("Reviewer picked up the handoff.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        const contextPlan = context.handoff.createContextPlan({
          builder: (handoffContext) => {
            capturedAgents.push({
              source: handoffContext.sourceAgent,
              target: handoffContext.targetAgent,
            });
            return handoffContext.helpers.storeMessages([]);
          },
          reason: "delegate",
          targetAgent: "reviewer",
        });

        return {
          resolution: {
            contextPlan,
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Delegate this review"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedAgents).toHaveLength(1);
    expect(capturedAgents[0]?.source.tools?.[0]?.name).toBe("plan_work");
    expect(capturedAgents[0]?.target.tools?.[0]?.name).toBe("review_draft");
    expect(capturedAgents[0]?.target.systemPrompt).toBe("You review drafts.");
    expect(capturedAgents[0]?.target.responseFormat?.name).toBe("review");
  });

  test("normalizes raw handoff plans to the latest framework-owned source context", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    let capturedSourceContext: HandoffSourceContext | undefined;
    const driver = {
      async execute(context) {
        if (context.config.name === "reviewer") {
          return {
            messages: [assistantText("Reviewer finished.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        return {
          messages: [assistantText("Pass this through the raw handoff plan.")],
          resolution: {
            contextPlan: {
              builder(sourceContext) {
                capturedSourceContext = sourceContext;
                return sourceContext.helpers.storeMessages([
                  {
                    parts: [{ text: "Raw handoff prepared.", type: "text" }],
                    role: "user",
                  },
                ]);
              },
              mode: "preserve_trace",
              reason: "delegate",
              sourceContext: {
                handoffIntent: {
                  reason: "delegate",
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
                manifest: createContextManifest([]),
                messages: [],
                sourceAgent: {
                  name: "provided-source",
                  systemPrompt: "Use the provided source context.",
                },
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
    } satisfies KrakenDriver;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) => agents[agentName],
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: agents.primary,
      signal: textSignal("Use explicit source context"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(capturedSourceContext?.messages).toEqual([
      {
        parts: [{ text: "Use explicit source context", type: "text" }],
        role: "user",
      },
      {
        parts: [
          { text: "Pass this through the raw handoff plan.", type: "text" },
        ],
        role: "assistant",
      },
    ]);
    expect(capturedSourceContext?.manifest).toEqual(
      createContextManifest([...(capturedSourceContext?.messages ?? [])])
    );
    expect(capturedSourceContext?.sourceAgent).toEqual(agents.primary);
    expect(capturedSourceContext?.targetAgent).toEqual(agents.reviewer);
  });

  test("last_output_only handoff forwards the final visible assistant parts", () => {
    let storedMessage: TuvrenMessage | null = null;
    const builder = createLastOutputOnlyHandoffContextBuilder();
    const fileData = new Uint8Array([1, 2, 3]);

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
          tool: 0,
          user: 1,
        },
        extensions: {},
        lastAssistantMessageIndex: 1,
        lastUserMessageIndex: 0,
        messageCount: 2,
        tokenEstimate: 0,
        toolCalls: {
          byName: {},
          total: 0,
        },
        toolResults: {
          byName: {},
          total: 0,
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
            {
              providerMetadata: {
                opaque: "token",
              },
              text: "Visible final output",
              type: "text",
            },
            {
              data: { score: 42 },
              name: "scorecard",
              providerMetadata: {
                opaque: "schema-token",
              },
              type: "structured",
            },
            {
              data: fileData,
              filename: "report.csv",
              mediaType: "text/csv",
              providerMetadata: {
                opaque: "file-token",
              },
              type: "file",
            },
          ],
          role: "assistant",
        },
      ],
      sourceAgent: { name: "primary" },
      targetAgent: { name: "reviewer" },
    } satisfies HandoffSourceContext);

    const capturedMessage = requireStoredHandoffMessage(storedMessage);

    expect(capturedMessage.role).toBe("user");

    if (capturedMessage.role !== "user") {
      throw new Error(
        "expected the stored handoff message to be user-authored"
      );
    }

    expect(capturedMessage.parts).toEqual([
      { text: "Visible final output", type: "text" },
      {
        data: { score: 42 },
        name: "scorecard",
        type: "structured",
      },
      {
        data: fileData,
        filename: "report.csv",
        mediaType: "text/csv",
        type: "file",
      },
    ]);
    expect(
      capturedMessage.parts.some(
        (part) =>
          "providerMetadata" in part && part.providerMetadata !== undefined
      )
    ).toBe(false);
  });

  test("global handoff builder overrides do not replace last_output_only semantics", async () => {
    const harness = createFakeKernelHarness();
    let overrideUsed = false;
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([
        {
          async execute(context) {
            if (context.config.name === "primary") {
              return {
                messages: [assistantText("Final visible output")],
                resolution: {
                  contextPlan: context.handoff.createContextPlan({
                    mode: "last_output_only",
                    reason: "delegate",
                    targetAgent: "reviewer",
                  }),
                  targetAgent: "reviewer",
                  type: "handoff",
                },
              };
            }

            return {
              messages: [assistantText("Reviewer complete.")],
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
      handoffContextBuilder: (context) => {
        overrideUsed = true;
        return createPreserveTraceHandoffContextBuilder()(context);
      },
      kernel: harness.kernel,
      resolveAgentConfig: (agentName) =>
        agentName === "reviewer" ? { name: "reviewer" } : undefined,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Use fixed last output only"),
      threadId: thread.threadId,
    });

    await collectEvents(handle.events());

    expect(overrideUsed).toBe(false);
    expect(
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Reviewer complete."
      )
    ).toBe(true);
  });

  test("does not leak per-turn tools across handoff transitions", async () => {
    const harness = createFakeKernelHarness();
    const agents: Record<string, AgentConfig> = {
      primary: { name: "primary" },
      reviewer: { name: "reviewer" },
    };
    const handoffDriver = {
      async execute(context) {
        if (context.config.name === "primary") {
          return {
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
    const runtime = createTuvrenRuntimeCore({
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
        "adhoc:false"
      )
    ).toBe(true);
  });

  test("rejects malformed steering signals before they can be incorporated", async () => {
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
            messages: [assistantText("Saw valid steering.")],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
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
    const runtime = createTuvrenRuntimeCore({
      defaultDriverId: "fake",
      driverRegistry: createDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary" },
      signal: textSignal("Start steering validation"),
      threadId: thread.threadId,
    });
    const eventsPromise = collectEvents(handle.events());

    await waitForAsync(async () =>
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Waiting for steering."
      )
    );
    expect(() => handle.steer(JSON.parse('{"parts":[123]}'))).toThrow(
      "steering signal must be a valid TuvrenMessage"
    );
    handle.steer(textSignal("Injected steering"));
    await eventsPromise;
    const manifest = await readBranchContextManifest(
      harness.kernel,
      thread.branchId
    );
    const messages = await harness.readBranchMessages(thread.branchId);

    expect(handle.status().phase).toBe("completed");
    expect(manifest.turnBoundaries).toEqual([0]);
    expect(messages[0]).toEqual({
      parts: [{ text: "Start steering validation", type: "text" }],
      role: "user",
    });
    expect(hasAssistantText(messages, "Waiting for steering.")).toBe(true);
    expect(
      messages.some((message) => {
        if (
          message === null ||
          typeof message !== "object" ||
          !("role" in message) ||
          message.role !== "user" ||
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
            part.text === "Injected steering"
        );
      })
    ).toBe(true);
    expect(hasAssistantText(messages, "Saw valid steering.")).toBe(true);
    expect(
      messages.some((message) => {
        if (
          message === null ||
          typeof message !== "object" ||
          !("role" in message) ||
          !("parts" in message) ||
          !Array.isArray(message.parts)
        ) {
          return false;
        }

        return message.parts.some((part) => typeof part === "number");
      })
    ).toBe(false);
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
            messages: [],
            resolution: {
              reason: "done",
              type: "end_turn",
            },
          };
        }

        await delay(10);
        return {
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
    const runtime = createTuvrenRuntimeCore({
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

    const eventsPromise = collectEvents(handle.events());

    await waitForAsync(async () =>
      hasAssistantText(
        await harness.readBranchMessages(thread.branchId),
        "Waiting for steering."
      )
    );
    handle.steer(textSignal("Injected steering"));
    const events = await eventsPromise;
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

  test("rejects steering before execution has started", async () => {
    const harness = createFakeKernelHarness();
    let firstExecuteSawSteering = false;
    const driver = {
      async execute(context) {
        firstExecuteSawSteering = context.messages.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text === "Injected too early"
            )
        );

        return {
          messages: [assistantText("No early steering.")],
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
      signal: textSignal("Start steering validation"),
      threadId: thread.threadId,
    });

    expect(() => handle.steer(textSignal("Injected too early"))).toThrow(
      "steer() is only valid while execution is running"
    );
    await collectEvents(handle.events());

    expect(firstExecuteSawSteering).toBe(false);
    expect(await harness.readBranchMessages(thread.branchId)).toEqual([
      {
        parts: [{ text: "Start steering validation", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "No early steering.", type: "text" }],
        role: "assistant",
      },
    ]);
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
