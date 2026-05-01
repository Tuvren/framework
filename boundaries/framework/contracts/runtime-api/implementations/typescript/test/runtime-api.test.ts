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
import {
  assertTuvrenStreamEvent as assertKrakenStreamEventFromSubpath,
  type TuvrenStreamEvent as KrakenStreamEventFromSubpath,
} from "../src/events.ts";
import {
  assertExecutionStatus as assertExecutionStatusFromSubpath,
  type ExecutionStatus as ExecutionStatusFromSubpath,
} from "../src/execution.ts";
import {
  type AgentConfig,
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertContextManifest,
  assertExecutionStatus,
  assertProviderStreamChunk,
  assertTuvrenMessage,
  assertTuvrenModelResponse,
  assertTuvrenStreamEvent,
  assertTuvrenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isExecutionStatus,
  isProviderStreamChunk,
  isTuvrenMessage,
  isTuvrenStreamEvent,
  isTuvrenToolDefinition,
} from "../src/index.ts";
import type { OrchestrationHandle as OrchestrationHandleFromSubpath } from "../src/orchestration.ts";
import {
  assertProviderStreamChunk as assertProviderStreamChunkFromSubpath,
  type ProviderStreamChunk as ProviderStreamChunkFromSubpath,
} from "../src/provider.ts";
import {
  type ApprovalRequest as ApprovalRequestFromSubpath,
  assertApprovalRequest as assertApprovalRequestFromSubpath,
} from "../src/tools.ts";
import {
  frameworkContractFixtures,
  invalidFrameworkContractFixtures,
} from "./runtime-api-fixtures.js";

describe("runtime-api contracts", () => {
  test("accepts the canonical framework fixtures", () => {
    expect(isTuvrenMessage(frameworkContractFixtures.assistantMessage)).toBe(
      true
    );
    expect(isApprovalRequest(frameworkContractFixtures.approvalRequest)).toBe(
      true
    );
    expect(
      isProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).toBe(true);
    expect(isTuvrenStreamEvent(frameworkContractFixtures.streamEvent)).toBe(
      true
    );
    expect(
      isTuvrenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).toBe(true);
    expect(isExecutionStatus(frameworkContractFixtures.executionStatus)).toBe(
      true
    );
    expect(() =>
      assertContextManifest(frameworkContractFixtures.contextManifest)
    ).not.toThrow();

    expect(() =>
      assertTuvrenMessage(frameworkContractFixtures.assistantMessage)
    ).not.toThrow();
    expect(() =>
      assertApprovalRequest(frameworkContractFixtures.approvalRequest)
    ).not.toThrow();
    expect(() =>
      assertProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).not.toThrow();
    expect(() =>
      assertTuvrenStreamEvent(frameworkContractFixtures.streamEvent)
    ).not.toThrow();
    expect(() =>
      assertTuvrenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).not.toThrow();
    expect(() =>
      assertExecutionStatus(frameworkContractFixtures.executionStatus)
    ).not.toThrow();
    expect(() =>
      assertTuvrenModelResponse({
        finishReason: "length",
        parts: [{ text: "partial", type: "text" }],
        providerMetadata: { stop: "max_tokens" },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      })
    ).not.toThrow();
  });

  test("exposes narrow runtime-api subpaths without changing contract behavior", () => {
    const approvalRequest = {
      completedResults: [],
      toolCalls: [
        {
          callId: "call-1",
          decisions: ["approve", "reject"],
          input: { query: "status" },
          message: "Approve this search?",
          name: "search",
        },
      ],
    } satisfies ApprovalRequestFromSubpath;
    const streamEvent = {
      messageId: "message-1",
      text: "done",
      timestamp: 1,
      type: "text.done",
    } satisfies KrakenStreamEventFromSubpath;
    const providerChunk = {
      finishReason: "stop",
      type: "finish",
    } satisfies ProviderStreamChunkFromSubpath;
    const executionStatus = {
      activeAgent: "primary",
      iterationCount: 0,
      phase: "running",
    } satisfies ExecutionStatusFromSubpath;
    const orchestrationHandle =
      frameworkContractFixtures.orchestrationRuntime.executeTurn({
        agent: "primary",
        branchId: "branch_subpath",
        signal: {
          parts: [{ text: "Subpath orchestration", type: "text" }],
        },
        threadId: "thread_subpath",
      }) satisfies OrchestrationHandleFromSubpath;

    expect(() =>
      assertApprovalRequestFromSubpath(approvalRequest)
    ).not.toThrow();
    expect(() => assertKrakenStreamEventFromSubpath(streamEvent)).not.toThrow();
    expect(() =>
      assertProviderStreamChunkFromSubpath(providerChunk)
    ).not.toThrow();
    expect(() =>
      assertExecutionStatusFromSubpath(executionStatus)
    ).not.toThrow();
    expect(typeof orchestrationHandle.spawn).toBe("function");
    expect(typeof orchestrationHandle.awaitResult).toBe("function");
  });

  test("accepts file.done stream events through the focused events surface", () => {
    const streamEvent = {
      data: new Uint8Array([1, 2, 3]),
      filename: "report.csv",
      mediaType: "text/csv",
      messageId: "message-1",
      timestamp: 1,
      type: "file.done",
    } satisfies KrakenStreamEventFromSubpath;

    expect(() => assertKrakenStreamEventFromSubpath(streamEvent)).not.toThrow();
  });

  test("exposes the orchestration contract surface through canonical fixtures", async () => {
    const handle = frameworkContractFixtures.orchestrationRuntime.executeTurn({
      agent: "primary",
      branchId: "branch_main",
      signal: {
        parts: [{ text: "Start orchestration", type: "text" }],
      },
      threadId: "thread_main",
    });
    const resumedHandle = handle.resolveApproval({ decisions: [] });
    const childHandle = handle.spawn({
      agent: "worker",
      signal: {
        parts: [
          {
            data: { task: "summarize" },
            name: "task",
            type: "structured",
          },
        ],
      },
    });

    expect(resumedHandle).not.toBe(handle);
    expect(await childHandle.awaitResult()).toBe("child result");
    expect(await resumedHandle.awaitResult()).toEqual({ ok: "resumed" });
  });

  test("rejects malformed contract values", () => {
    expect(
      isTuvrenMessage(invalidFrameworkContractFixtures.malformedMessage)
    ).toBe(false);
    expect(
      isApprovalRequest(
        invalidFrameworkContractFixtures.malformedApprovalRequest
      )
    ).toBe(false);
    expect(
      isProviderStreamChunk(
        invalidFrameworkContractFixtures.malformedProviderStreamChunk
      )
    ).toBe(false);
    expect(
      isTuvrenStreamEvent(invalidFrameworkContractFixtures.malformedStreamEvent)
    ).toBe(false);
    expect(
      isTuvrenToolDefinition(
        invalidFrameworkContractFixtures.malformedToolDefinition
      )
    ).toBe(false);
    expect(
      isExecutionStatus(
        invalidFrameworkContractFixtures.malformedExecutionStatus
      )
    ).toBe(false);
    expect(() =>
      assertContextManifest(
        invalidFrameworkContractFixtures.malformedContextManifest
      )
    ).toThrow("must be a valid ContextManifest");
  });

  test("rejects provider chunks that omit required fields", () => {
    expect(isProviderStreamChunk({ type: "tool_call_start" })).toBe(false);
  });

  test("rejects provider chunks with empty provider tool identifiers", () => {
    expect(
      isProviderStreamChunk({
        name: "search",
        providerCallId: "",
        type: "tool_call_start",
      })
    ).toBe(false);

    expect(
      isProviderStreamChunk({
        input: {},
        name: "",
        providerCallId: "provider-call-1",
        type: "tool_call_done",
      })
    ).toBe(false);
  });

  test("rejects provider chunks with mixed-variant payload fields", () => {
    expect(
      isProviderStreamChunk({
        providerCallId: "provider-call-1",
        text: "ok",
        type: "text_delta",
      })
    ).toBe(false);
  });

  test("rejects provider usage payloads with undeclared fields", () => {
    expect(
      isProviderStreamChunk({
        finishReason: "stop",
        type: "finish",
        usage: {
          extra: 3,
          inputTokens: 1,
          outputTokens: 2,
        },
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        finishReason: "stop",
        messageId: "message-1",
        timestamp: 1,
        type: "message.done",
        usage: {
          extra: 3,
          inputTokens: 1,
          outputTokens: 2,
        },
      })
    ).toBe(false);
  });

  test("rejects approval requests with incomplete tool results", () => {
    expect(
      isApprovalRequest({
        completedResults: [
          { callId: "call-1", name: "search", type: "tool_result" },
        ],
        toolCalls: [],
      })
    ).toBe(false);
  });

  test("rejects approval requests with undeclared top-level fields", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        extra: 1,
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests and tool-result messages with undeclared fields", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            extra: 1,
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            extra: 1,
            name: "search",
            output: { hits: 1 },
            type: "tool_result",
          },
        ],
        role: "tool",
      })
    ).toBe(false);
  });

  test("rejects approval requests with incomplete pending tool calls", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-2",
            decisions: ["approve"],
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with duplicate callIds across pending and completed work", () => {
    expect(
      isApprovalRequest({
        completedResults: [
          {
            callId: "call-1",
            name: "search",
            output: { hits: 1 },
            type: "tool_result",
          },
        ],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with empty decision lists", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: [],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with blank decision labels", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["   "],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with duplicate decision labels", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve", "approve"],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("returns false instead of throwing for hostile accessor payloads", () => {
    const hostileProviderMetadata = {
      get foo() {
        throw new Error("boom");
      },
    };

    expect(() =>
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: hostileProviderMetadata,
            text: "hello",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).not.toThrow();

    expect(
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: hostileProviderMetadata,
            text: "hello",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects approval requests with no pending tool calls", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [],
      })
    ).toBe(false);
  });

  test("accepts manifests with multiple user messages in a single turn", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("accepts manifests whose first user turn starts after a system message", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 1,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: 2,
          lastUserMessageIndex: 3,
          messageCount: 4,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1, 3],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("rejects manifests that skip the earliest possible first user turn", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests whose turn boundary collides with the known last assistant index", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 1,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: 1,
          lastUserMessageIndex: 3,
          messageCount: 4,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects stream events that omit required fields", () => {
    expect(isTuvrenStreamEvent({ type: "turn.end", timestamp: 1 })).toBe(false);
  });

  test("rejects stream events with empty tool names", () => {
    expect(
      isTuvrenStreamEvent({
        callId: "call-1",
        input: {},
        name: "",
        timestamp: 1,
        type: "tool.start",
      })
    ).toBe(false);
  });

  test("rejects stream events with mixed-variant payload fields", () => {
    expect(
      isTuvrenStreamEvent({
        callId: "call-1",
        input: {},
        messageId: "message-1",
        name: "search",
        text: "ok",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);
  });

  test("rejects file parts with empty media types", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            data: "YWJj",
            mediaType: "",
            type: "file",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects stream events with empty lifecycle identifiers", () => {
    expect(
      isTuvrenStreamEvent({
        text: "ok",
        messageId: "",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        resumedFrom: "1".repeat(64),
        threadId: "",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.start",
      })
    ).toBe(false);
  });

  test("rejects stream events with invalid hash references", () => {
    expect(
      isTuvrenStreamEvent({
        resumedFrom: "not-a-hash",
        threadId: "thread-1",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.start",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        iterationCount: 1,
        timestamp: 1,
        turnNodeHash: "not-a-hash",
        type: "state.checkpoint",
      })
    ).toBe(false);
  });

  test("rejects negative iteration counters in stream events", () => {
    expect(
      isTuvrenStreamEvent({
        iterationCount: -1,
        timestamp: 1,
        type: "iteration.start",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        iterationCount: -1,
        timestamp: 1,
        turnNodeHash: "1".repeat(64),
        type: "state.checkpoint",
      })
    ).toBe(false);
  });

  test("rejects non-canonical epoch timestamps in stream events", () => {
    expect(
      isTuvrenStreamEvent({
        status: "completed",
        timestamp: -0,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);
  });

  test("rejects assistant messages with incomplete content parts", () => {
    expect(
      isTuvrenMessage({
        parts: [{ type: "text" }],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects messages with undeclared top-level fields", () => {
    expect(
      isTuvrenMessage({
        extra: 1,
        parts: [{ text: "hi", type: "text" }],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects assistant messages with malformed provider metadata", () => {
    expect(
      isTuvrenMessage({
        parts: [],
        providerMetadata: 7,
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects empty durable messages across roles", () => {
    expect(
      isTuvrenMessage({
        content: "",
        role: "system",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [],
        role: "user",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [],
        role: "tool",
      })
    ).toBe(false);
  });

  test("rejects content parts with non-serializable payloads", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            input: {
              fn() {
                return 1;
              },
            },
            name: "search",
            type: "tool_call",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            data: {
              nested: {
                fn() {
                  return 1;
                },
              },
            },
            type: "structured",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: {
              nested: {
                fn() {
                  return 1;
                },
              },
            },
            text: "hi",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects content parts with mixed-variant fields", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            input: {},
            name: "search",
            text: "hi",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            data: { ok: true },
            type: "structured",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects empty non-redacted reasoning parts", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            redacted: false,
            text: "",
            type: "reasoning",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects stream payloads with non-serializable structured data", () => {
    expect(
      isProviderStreamChunk({
        data: {
          fn() {
            return 1;
          },
        },
        type: "structured_done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        data: {
          fn() {
            return 1;
          },
        },
        messageId: "message-1",
        timestamp: 1,
        type: "structured.done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        callId: "call-1",
        input: {
          fn() {
            return 1;
          },
        },
        name: "search",
        timestamp: 1,
        type: "tool_call.done",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with malformed optional fields", () => {
    expect(
      isExecutionStatus({
        approval: "oops",
        iterationCount: 1,
        phase: "paused",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with undeclared fields", () => {
    expect(
      isExecutionStatus({
        extra: 1,
        iterationCount: 0,
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with undeclared nested fields", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            extra: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: {
            byName: {},
            extra: 1,
            total: 0,
          },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          extra: 1,
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with invalid phase invariants", () => {
    expect(
      isExecutionStatus({
        iterationCount: 1,
        phase: "paused",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        approval: frameworkContractFixtures.approvalRequest,
        iterationCount: 1,
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 1,
        pauseReason: "approval_required",
        phase: "completed",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        approval: frameworkContractFixtures.approvalRequest,
        iterationCount: 1,
        phase: "paused",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with invalid schemas", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: 123,
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with malformed JSON Schema objects", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Bad required schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          required: [7],
          type: "object",
        },
        name: "bad-required",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad properties schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          properties: "oops",
          type: "object",
        },
        name: "bad-properties",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad nested property schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          properties: {
            foo: 1,
          },
          type: "object",
        },
        name: "bad-nested-properties",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad schema type",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: "banana",
        },
        name: "bad-type",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad schema type array",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: ["object", "banana"],
        },
        name: "bad-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty schema type array",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: [],
        },
        name: "bad-empty-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate schema type array",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: ["string", "string"],
        },
        name: "bad-duplicate-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate required entries",
        execute() {
          return undefined;
        },
        inputSchema: {
          properties: {
            a: { type: "string" },
          },
          required: ["a", "a"],
          type: "object",
        },
        name: "bad-duplicate-required",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad items schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          items: 123,
          type: "array",
        },
        name: "bad-items-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad additionalProperties schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          additionalProperties: 123,
          type: "object",
        },
        name: "bad-additional-properties-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad propertyNames schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          propertyNames: 123,
          type: "object",
        },
        name: "bad-property-names-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad oneOf schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          oneOf: [123],
        },
        name: "bad-one-of-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad minLength schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          minLength: "abc",
          type: "string",
        },
        name: "bad-min-length",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad enum schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          enum: "not-an-array",
          type: "string",
        },
        name: "bad-enum",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty enum schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          enum: [],
          type: "string",
        },
        name: "bad-empty-enum",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate enum schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          enum: ["a", "a"],
          type: "string",
        },
        name: "bad-duplicate-enum",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad allOf schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          allOf: "oops",
          type: "string",
        },
        name: "bad-all-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad anyOf schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          anyOf: 123,
          type: "string",
        },
        name: "bad-any-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad prefixItems schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          prefixItems: 123,
          type: "array",
        },
        name: "bad-prefix-items",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty oneOf schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          oneOf: [],
        },
        name: "bad-empty-one-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad $ref schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          $ref: 123,
        },
        name: "bad-ref",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad $defs schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          $defs: [1],
          type: "object",
        },
        name: "bad-defs",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad title schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          title: 123,
          type: "string",
        },
        name: "bad-title",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad description schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          description: 123,
          type: "string",
        },
        name: "bad-description",
      })
    ).toBe(false);
  });

  test("accepts structurally valid CustomSchema class instances", () => {
    class ExampleSchema {
      toJSONSchema() {
        return { type: "string" };
      }

      validate(input: unknown) {
        if (typeof input === "string") {
          return { valid: true, value: input };
        }

        return {
          error: { message: "Expected string" },
          valid: false,
        };
      }
    }

    expect(
      isTuvrenToolDefinition({
        description: "Class-backed schema tool",
        execute() {
          return undefined;
        },
        inputSchema: new ExampleSchema(),
        name: "class-schema",
      })
    ).toBe(true);
  });

  test("accepts structurally valid CustomSchema shapes without executing them", () => {
    let methodCalls = 0;
    class LazySchema {
      toJSONSchema() {
        methodCalls += 1;
        return 123;
      }

      validate() {
        methodCalls += 1;
        return { valid: true, value: "ok" };
      }
    }

    expect(
      isTuvrenToolDefinition({
        description: "Lazy custom schema",
        execute() {
          return undefined;
        },
        inputSchema: new LazySchema(),
        name: "lazy-custom-schema",
      })
    ).toBe(true);
    expect(methodCalls).toBe(0);
  });

  test("accepts JSON Schema numeric keywords with fractional values", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Constrained number tool",
        execute() {
          return undefined;
        },
        inputSchema: {
          multipleOf: 0.1,
          type: "number",
        },
        name: "fractional-schema",
      })
    ).toBe(true);
  });

  test("accepts structurally valid but unsatisfiable JSON Schemas", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Unsatisfiable numeric bounds",
        execute() {
          return undefined;
        },
        inputSchema: {
          maximum: 3,
          minimum: 5,
          type: "number",
        },
        name: "unsat-bounds",
      })
    ).toBe(true);
  });

  test("rejects tool definitions with undeclared fields", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        extra: 1,
        inputSchema: true,
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with non-serializable metadata", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: true,
        metadata: {
          fn() {
            return 1;
          },
        },
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with malformed optional behavior fields", () => {
    expect(
      isTuvrenToolDefinition({
        approval: 7,
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: true,
        name: "search",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: true,
        metadata: 7,
        name: "search",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: true,
        name: "search",
        timeout: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
  });

  test("rejects approval resolved events with edit decisions missing edited input", () => {
    expect(
      isTuvrenStreamEvent({
        response: {
          decisions: [{ callId: "call-1", type: "edit" }],
        },
        timestamp: 1,
        type: "approval.resolved",
      })
    ).toBe(false);
  });

  test("accepts approval responses whose reject or custom decisions omit message", () => {
    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", type: "reject" }],
      })
    ).toBe(true);

    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", type: "needs_human" }],
      })
    ).toBe(true);
  });

  test("validates approval responses against the active approval request when context is available", () => {
    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call_2", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toBe(true);

    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "missing-call", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toBe(false);

    expect(() =>
      assertApprovalResponseForRequest(
        { decisions: [{ callId: "missing-call", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toThrow();
  });

  test("rejects request-aware approval responses that use disallowed decisions or omit pending calls", () => {
    const multiCallApprovalRequest = {
      completedResults: [],
      toolCalls: [
        {
          callId: "call-1",
          decisions: ["approve", "reject"],
          input: { query: "status" },
          message: "Decide the search",
          name: "search",
        },
        {
          callId: "call-2",
          decisions: ["approve"],
          input: { target: "ops" },
          message: "Decide the notify call",
          name: "notify",
        },
      ],
    };

    expect(
      isApprovalResponseForRequest(
        {
          decisions: [
            {
              callId: "call-1",
              editedInput: { query: "updated status" },
              type: "edit",
            },
            { callId: "call-2", type: "approve" },
          ],
        },
        multiCallApprovalRequest
      )
    ).toBe(false);

    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call-1", type: "approve" }] },
        multiCallApprovalRequest
      )
    ).toBe(false);
  });

  test("rejects approval responses with undeclared decision fields", () => {
    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", extra: 1, type: "approve" }],
      })
    ).toBe(false);
  });

  test("accepts approval response messages as optional annotations", () => {
    expect(
      isApprovalResponse({
        decisions: [
          { callId: "call-1", message: "Proceed with care.", type: "approve" },
        ],
      })
    ).toBe(true);

    expect(
      isApprovalResponse({
        decisions: [
          {
            callId: "call-1",
            message: "Please revise and continue.",
            type: "edit",
            editedInput: { query: "updated status" },
          },
        ],
      })
    ).toBe(true);

    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", message: "", type: "reject" }],
      })
    ).toBe(false);

    expect(
      isApprovalResponse({
        decisions: [
          {
            callId: "call-1",
            editedInput: { query: "updated" },
            type: "approve",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval responses with no decisions", () => {
    expect(
      isApprovalResponse({
        decisions: [],
      })
    ).toBe(false);
  });

  test("rejects approval responses with duplicate decision callIds", () => {
    expect(
      isApprovalResponse({
        decisions: [
          { callId: "call-1", type: "approve" },
          { callId: "call-1", type: "reject" },
        ],
      })
    ).toBe(false);

    expect(() =>
      assertApprovalResponse({
        decisions: [
          { callId: "call-1", type: "approve" },
          { callId: "call-1", type: "reject" },
        ],
      })
    ).toThrow();
  });

  test("rejects empty approval and tool identifiers", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "",
            decisions: [""],
            input: {},
            message: "",
            name: "",
          },
        ],
      })
    ).toBe(false);

    expect(
      isApprovalResponse({
        decisions: [{ callId: "", type: "", message: "x" }],
      })
    ).toBe(false);
  });

  test("rejects approval requests with empty review message text", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            input: {},
            message: "",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects event sources with a non-string workerId", () => {
    expect(
      isTuvrenStreamEvent({
        source: { agent: "primary", workerId: 7 },
        timestamp: 1,
        type: "turn.end",
        turnId: "turn-1",
        status: "completed",
      })
    ).toBe(false);
  });

  test("rejects event sources and error payloads with undeclared fields", () => {
    expect(
      isTuvrenStreamEvent({
        source: { agent: "primary", extra: 1 },
        status: "completed",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        error: {
          extra: 1,
          message: "boom",
        },
        fatal: true,
        timestamp: 1,
        type: "error",
      })
    ).toBe(false);
  });

  test("rejects blank correlation identifiers", () => {
    expect(
      isApprovalResponse({
        decisions: [{ callId: "   ", type: "approve" }],
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        messageId: "   ",
        text: "ok",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        source: { agent: "" },
        status: "completed",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);
  });

  test("rejects serializable-boundary objects with hidden or symbol-backed state", () => {
    const symbolBackedMetadata = {
      visible: 1,
      [Symbol("hidden")]: 2,
    };
    const hiddenPropertyExtensions = {};
    Object.defineProperty(hiddenPropertyExtensions, "hidden", {
      enumerable: false,
      value: 1,
    });

    expect(
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: symbolBackedMetadata,
            text: "hello",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: hiddenPropertyExtensions,
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects error events with non-serializable details", () => {
    expect(
      isTuvrenStreamEvent({
        error: {
          details: {
            fn() {
              return 1;
            },
          },
          message: "boom",
        },
        fatal: true,
        timestamp: 1,
        type: "error",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with non-finite manifest token estimates", () => {
    expect(
      isExecutionStatus({
        iterationCount: 1,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: Number.NaN,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 1,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: -5,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with non-serializable extension state", () => {
    expect(
      isExecutionStatus({
        iterationCount: 1,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {
            myExt: {
              fn() {
                return 1;
              },
            },
          },
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects execution statuses with negative manifest counters", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: -1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: -2 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("accepts first-turn manifests with sentinel assistant indexes", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 0,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("rejects manifests with inconsistent summary indexes and totals", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 99,
          lastUserMessageIndex: 0,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: { search: 2 }, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [5, 0, 5],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests whose turn boundaries do not match user-turn count", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 0,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: -1,
          messageCount: 1,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);

    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(true);
  });

  test("rejects manifests whose turn boundaries contradict the last user index", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with empty tool-name buckets", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 1,
            system: 0,
            tool: 0,
            user: 1,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: 1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: { "": 1 }, total: 1 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with impossible last-role summary indexes", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 2,
            system: 0,
            tool: 0,
            user: 0,
          },
          extensions: {},
          lastAssistantMessageIndex: 0,
          lastUserMessageIndex: -1,
          messageCount: 2,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests with impossible multi-turn boundaries", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 2,
          messageCount: 3,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects manifests whose final turn boundary cannot match the last user", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 1,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 2,
          messageCount: 3,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0, 1],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects multi-turn boundaries that exceed the last user index", () => {
    expect(
      isExecutionStatus({
        iterationCount: 0,
        manifest: {
          byRole: {
            assistant: 0,
            system: 0,
            tool: 0,
            user: 2,
          },
          extensions: {},
          lastAssistantMessageIndex: -1,
          lastUserMessageIndex: 1,
          messageCount: 3,
          tokenEstimate: 12,
          toolCalls: { byName: {}, total: 0 },
          toolResults: { byName: {}, total: 0 },
          turnBoundaries: [0, 2],
        },
        phase: "running",
      })
    ).toBe(false);
  });

  test("rejects mixed-shape discriminated messages", () => {
    expect(
      isTuvrenMessage({
        content: "system",
        parts: [],
        role: "system",
      })
    ).toBe(false);
  });

  test("rejects provider usage with negative token counts", () => {
    expect(
      isProviderStreamChunk({
        finishReason: "stop",
        type: "finish",
        usage: {
          inputTokens: -1,
          outputTokens: 0,
        },
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        finishReason: "stop",
        messageId: "message-1",
        timestamp: 1,
        type: "message.done",
        usage: {
          inputTokens: 1,
          outputTokens: -1,
        },
      })
    ).toBe(false);
  });

  test("exposes a host-facing type surface that composes with the shared fixtures", () => {
    const runtime = frameworkContractFixtures.runtime;
    const config = frameworkContractFixtures.agentConfig satisfies AgentConfig;

    expect(typeof runtime.executeTurn).toBe("function");
    expect(config.name).toBe("primary");
    expect(config.tools?.[0]?.name).toBe("search");
  });
});
