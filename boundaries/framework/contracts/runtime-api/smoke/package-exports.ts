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
  assertApprovalRequest,
  assertContextManifest,
  assertProviderStreamChunk,
  assertTuvrenMessage,
  assertTuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { assertTuvrenStreamEvent as assertKrakenStreamEventFromEvents } from "@tuvren/runtime-api/events";
import { assertContextManifest as assertContextManifestFromExecution } from "@tuvren/runtime-api/execution";
import type { OrchestrationHandle } from "@tuvren/runtime-api/orchestration";
import { assertProviderStreamChunk as assertProviderStreamChunkFromProvider } from "@tuvren/runtime-api/provider";
import { assertApprovalRequest as assertApprovalRequestFromTools } from "@tuvren/runtime-api/tools";

async function* createEmptyEventStream() {
  // Smoke tests only need an async iterable shape, not delivered events.
}

describe("runtime-api package exports", () => {
  test("resolve the root and focused subpaths from the built package surface", () => {
    const manifest = {
      byRole: { assistant: 0, system: 0, tool: 0, user: 1 },
      extensions: {},
      lastAssistantMessageIndex: -1,
      lastUserMessageIndex: 0,
      messageCount: 1,
      tokenEstimate: 1,
      toolCalls: { byName: {}, total: 0 },
      toolResults: { byName: {}, total: 0 },
      turnBoundaries: [0],
    };
    const message = {
      parts: [{ text: "hello", type: "text" }],
      role: "user",
    };
    const streamEvent = {
      messageId: "message-1",
      text: "done",
      timestamp: 1,
      type: "text.done",
    };
    const providerChunk = {
      finishReason: "stop",
      type: "finish",
    };
    const approvalRequest = {
      completedResults: [],
      toolCalls: [
        {
          callId: "call-1",
          decisions: ["approve"],
          input: { query: "status" },
          message: "Approve this request",
          name: "search",
        },
      ],
    };
    let orchestrationHandleShape: OrchestrationHandle;
    orchestrationHandleShape = {
      awaitResult: async () => ({ ok: true }),
      allEvents: () => ({
        [Symbol.asyncIterator]: createEmptyEventStream,
      }),
      cancel: () => undefined,
      events: () => ({
        [Symbol.asyncIterator]: createEmptyEventStream,
      }),
      resolveApproval: () => orchestrationHandleShape,
      spawn: () => orchestrationHandleShape,
      status: () => ({ iterationCount: 0, phase: "running" as const }),
      steer: () => undefined,
    };

    expect(() => assertContextManifest(manifest)).not.toThrow();
    expect(() => assertContextManifestFromExecution(manifest)).not.toThrow();
    expect(() => assertTuvrenMessage(message)).not.toThrow();
    expect(() => assertTuvrenStreamEvent(streamEvent)).not.toThrow();
    expect(() => assertKrakenStreamEventFromEvents(streamEvent)).not.toThrow();
    expect(() => assertProviderStreamChunk(providerChunk)).not.toThrow();
    expect(() =>
      assertProviderStreamChunkFromProvider(providerChunk)
    ).not.toThrow();
    expect(() => assertApprovalRequest(approvalRequest)).not.toThrow();
    expect(() => assertApprovalRequestFromTools(approvalRequest)).not.toThrow();
    expect(orchestrationHandleShape.status().phase).toBe("running");
  });
});
