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
  assertContextManifest,
  assertExecutionStatus,
  assertProviderStreamChunk,
  assertTuvrenMessage,
  assertTuvrenModelResponse,
  assertTuvrenStreamEvent,
  assertTuvrenToolDefinition,
  isApprovalRequest,
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

  test("exposes a host-facing type surface that composes with the shared fixtures", () => {
    const runtime = frameworkContractFixtures.runtime;
    const config = frameworkContractFixtures.agentConfig satisfies AgentConfig;

    expect(typeof runtime.executeTurn).toBe("function");
    expect(config.name).toBe("primary");
    expect(config.tools?.[0]?.name).toBe("search");
  });
});
