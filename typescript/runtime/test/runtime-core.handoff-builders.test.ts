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
import type { AgentConfig, HandoffSourceContext } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createContextManifest,
  createLastOutputOnlyHandoffContextBuilder,
  createPreserveTraceHandoffContextBuilder,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  collectEvents,
  extractSingleUserText,
  hasAssistantText,
  requireStoredHandoffMessage,
  textSignal,
} from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
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
    const runtime = createTuvrenRuntime({
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
    const runtime = createTuvrenRuntime({
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
    const runtime = createTuvrenRuntime({
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
