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

  test("rejects stream events that omit required fields", () => {
    expect(isKrakenStreamEvent({ type: "turn.end", timestamp: 1 })).toBe(false);
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
