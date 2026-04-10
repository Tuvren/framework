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
  frameworkContractFixtures,
  invalidFrameworkContractFixtures,
} from "../../../../../tests/fixtures/framework-contract-fixtures.js";
import {
  type AgentConfig,
  assertApprovalRequest,
  assertApprovalResponse,
  assertExecutionStatus,
  assertKrakenMessage,
  assertKrakenStreamEvent,
  assertKrakenToolDefinition,
  assertProviderStreamChunk,
  isApprovalRequest,
  isApprovalResponse,
  isExecutionStatus,
  isKrakenMessage,
  isKrakenStreamEvent,
  isKrakenToolDefinition,
  isProviderStreamChunk,
  type KrakenRuntime,
} from "../src/index.ts";

describe("runtime-api contracts", () => {
  test("accepts the canonical framework fixtures", () => {
    expect(isKrakenMessage(frameworkContractFixtures.assistantMessage)).toBe(
      true
    );
    expect(isApprovalRequest(frameworkContractFixtures.approvalRequest)).toBe(
      true
    );
    expect(
      isProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).toBe(true);
    expect(isKrakenStreamEvent(frameworkContractFixtures.streamEvent)).toBe(
      true
    );
    expect(
      isKrakenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).toBe(true);
    expect(isExecutionStatus(frameworkContractFixtures.executionStatus)).toBe(
      true
    );

    expect(() =>
      assertKrakenMessage(frameworkContractFixtures.assistantMessage)
    ).not.toThrow();
    expect(() =>
      assertApprovalRequest(frameworkContractFixtures.approvalRequest)
    ).not.toThrow();
    expect(() =>
      assertProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).not.toThrow();
    expect(() =>
      assertKrakenStreamEvent(frameworkContractFixtures.streamEvent)
    ).not.toThrow();
    expect(() =>
      assertKrakenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).not.toThrow();
    expect(() =>
      assertExecutionStatus(frameworkContractFixtures.executionStatus)
    ).not.toThrow();
  });

  test("rejects malformed contract values", () => {
    expect(
      isKrakenMessage(invalidFrameworkContractFixtures.malformedMessage)
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
      isKrakenStreamEvent(invalidFrameworkContractFixtures.malformedStreamEvent)
    ).toBe(false);
    expect(
      isKrakenToolDefinition(
        invalidFrameworkContractFixtures.malformedToolDefinition
      )
    ).toBe(false);
    expect(
      isExecutionStatus(
        invalidFrameworkContractFixtures.malformedExecutionStatus
      )
    ).toBe(false);
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

  test("rejects stream events that omit required fields", () => {
    expect(isKrakenStreamEvent({ type: "turn.end", timestamp: 1 })).toBe(false);
  });

  test("rejects stream events with empty tool names", () => {
    expect(
      isKrakenStreamEvent({
        callId: "call-1",
        input: {},
        name: "",
        timestamp: 1,
        type: "tool.start",
      })
    ).toBe(false);
  });

  test("rejects stream events with empty lifecycle identifiers", () => {
    expect(
      isKrakenStreamEvent({
        text: "ok",
        messageId: "",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);

    expect(
      isKrakenStreamEvent({
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
      isKrakenStreamEvent({
        resumedFrom: "not-a-hash",
        threadId: "thread-1",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.start",
      })
    ).toBe(false);

    expect(
      isKrakenStreamEvent({
        iterationCount: 1,
        timestamp: 1,
        turnNodeHash: "not-a-hash",
        type: "state.checkpoint",
      })
    ).toBe(false);
  });

  test("rejects negative iteration counters in stream events", () => {
    expect(
      isKrakenStreamEvent({
        iterationCount: -1,
        timestamp: 1,
        type: "iteration.start",
      })
    ).toBe(false);

    expect(
      isKrakenStreamEvent({
        iterationCount: -1,
        timestamp: 1,
        turnNodeHash: "1".repeat(64),
        type: "state.checkpoint",
      })
    ).toBe(false);
  });

  test("rejects assistant messages with incomplete content parts", () => {
    expect(
      isKrakenMessage({
        parts: [{ type: "text" }],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects assistant messages with malformed provider metadata", () => {
    expect(
      isKrakenMessage({
        parts: [],
        providerMetadata: 7,
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects empty durable messages across roles", () => {
    expect(
      isKrakenMessage({
        content: "",
        role: "system",
      })
    ).toBe(false);

    expect(
      isKrakenMessage({
        parts: [],
        role: "user",
      })
    ).toBe(false);

    expect(
      isKrakenMessage({
        parts: [],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isKrakenMessage({
        parts: [],
        role: "tool",
      })
    ).toBe(false);
  });

  test("rejects content parts with non-serializable payloads", () => {
    expect(
      isKrakenMessage({
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
      isKrakenMessage({
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
      isKrakenMessage({
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
      isKrakenStreamEvent({
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
      isKrakenStreamEvent({
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
      isKrakenToolDefinition({
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
      isKrakenToolDefinition({
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
      isKrakenToolDefinition({
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
      isKrakenToolDefinition({
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
  });

  test("accepts CustomSchema class instances", () => {
    class ExampleSchema {
      toJSONSchema() {
        return { type: "string" } as const;
      }

      validate(input: unknown) {
        return { valid: typeof input === "string", value: input } as const;
      }
    }

    expect(
      isKrakenToolDefinition({
        description: "Class-backed schema tool",
        execute() {
          return undefined;
        },
        inputSchema: new ExampleSchema(),
        name: "class-schema",
      })
    ).toBe(true);
  });

  test("accepts JSON Schema numeric keywords with fractional values", () => {
    expect(
      isKrakenToolDefinition({
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

  test("rejects tool definitions with malformed optional behavior fields", () => {
    expect(
      isKrakenToolDefinition({
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
      isKrakenToolDefinition({
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
      isKrakenToolDefinition({
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
      isKrakenStreamEvent({
        response: {
          decisions: [{ callId: "call-1", type: "edit" }],
        },
        timestamp: 1,
        type: "approval.resolved",
      })
    ).toBe(false);
  });

  test("rejects approval responses whose reject or custom decisions omit message", () => {
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
      isKrakenStreamEvent({
        source: { agent: "primary", workerId: 7 },
        timestamp: 1,
        type: "turn.end",
        turnId: "turn-1",
        status: "completed",
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
      isKrakenStreamEvent({
        messageId: "   ",
        text: "ok",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);

    expect(
      isKrakenStreamEvent({
        source: { agent: "" },
        status: "completed",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.end",
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
      isKrakenMessage({
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
      isKrakenStreamEvent({
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
    const runtime = frameworkContractFixtures.runtime as KrakenRuntime;
    const config = frameworkContractFixtures.agentConfig satisfies AgentConfig;

    expect(typeof runtime.executeTurn).toBe("function");
    expect(config.name).toBe("primary");
    expect(config.tools?.[0]?.name).toBe("search");
  });
});
