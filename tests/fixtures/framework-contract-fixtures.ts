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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  AgentConfig,
  ApprovalRequest,
  ExecutionHandle,
  ExecutionStatus,
  KrakenMessage,
  KrakenRuntime,
  KrakenStreamEvent,
  KrakenToolDefinition,
  ProviderStreamChunk,
} from "../../boundaries/framework/contracts/runtime-api/src/index.ts";

const noopExecutionHandle: ExecutionHandle = {
  cancel() {
    return;
  },
  events() {
    return (async function* () {
      yield* [];
    })();
  },
  resolveApproval() {
    return this;
  },
  status() {
    return frameworkContractFixtures.executionStatus;
  },
  steer() {
    return;
  },
};

export const frameworkContractFixtures = {
  agentConfig: {
    extensions: [],
    maxIterations: 8,
    name: "primary",
    systemPrompt: "You are Kraken.",
    tools: [
      {
        description: "Search documentation",
        execute() {
          return { hits: 1 };
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
  } satisfies AgentConfig,
  approvalRequest: {
    completedResults: [
      {
        callId: "call_1",
        name: "search",
        output: { hits: 1 },
        type: "tool_result",
      },
    ],
    toolCalls: [
      {
        callId: "call_2",
        decisions: ["approve", "edit", "reject"],
        input: { query: "latest status" },
        message: "Approve the outbound search?",
        name: "search",
      },
    ],
  } satisfies ApprovalRequest,
  assistantMessage: {
    parts: [
      {
        text: "Need approval before continuing.",
        type: "text",
      },
      {
        callId: "call_2",
        input: { query: "latest status" },
        name: "search",
        type: "tool_call",
      },
    ],
    role: "assistant",
  } satisfies KrakenMessage,
  executionStatus: {
    activeAgent: "primary",
    approval: {
      completedResults: [],
      toolCalls: [
        {
          callId: "call_2",
          decisions: ["approve", "edit", "reject"],
          input: { query: "latest status" },
          message: "Approve the outbound search?",
          name: "search",
        },
      ],
    },
    iterationCount: 2,
    pauseReason: "approval_required",
    phase: "paused",
  } satisfies ExecutionStatus,
  providerStreamChunk: {
    delta: '{"status":"pending"}',
    type: "structured_delta",
  } satisfies ProviderStreamChunk,
  runtime: {
    createBranch() {
      return Promise.resolve({
        branchId: "branch_main",
        headTurnNodeHash: "1".repeat(64),
        threadId: "thread_main",
      });
    },
    createThread() {
      return Promise.resolve({
        branchId: "branch_main",
        rootTurnNodeHash: "1".repeat(64),
        rootTurnTreeHash: "2".repeat(64),
        threadId: "thread_main",
      });
    },
    executeTurn() {
      return noopExecutionHandle;
    },
    getThread() {
      return Promise.resolve({
        rootTurnNodeHash: "1".repeat(64),
        schemaId: "kraken.agent.v1",
        threadId: "thread_main",
      });
    },
    setBranchHead() {
      return Promise.resolve({
        archiveBranchId: "branch_archive",
        branchId: "branch_main",
        headTurnNodeHash: "3".repeat(64),
      });
    },
  } satisfies KrakenRuntime,
  streamEvent: {
    messageId: "message_1",
    source: {
      agent: "primary",
      driver: "react",
      threadId: "thread_main",
    },
    text: "Need approval before continuing.",
    timestamp: 1_717_171_717_171,
    type: "text.done",
  } satisfies KrakenStreamEvent,
  toolDefinition: {
    description: "Search documentation",
    execute() {
      return { hits: 1 };
    },
    inputSchema: {
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      type: "object",
    },
    name: "search",
  } satisfies KrakenToolDefinition,
};

export const invalidFrameworkContractFixtures = {
  malformedApprovalRequest: {
    completedResults: "not-an-array",
    toolCalls: [],
  },
  malformedExecutionStatus: {
    iterationCount: 1.5,
    phase: "waiting",
  },
  malformedMessage: {
    parts: "not-an-array",
    role: "assistant",
  },
  malformedProviderStreamChunk: {
    type: "delta",
  },
  malformedStreamEvent: {
    text: "missing timestamp",
    type: "text.done",
  },
  malformedToolDefinition: {
    description: "Missing execute",
    inputSchema: true,
    name: "search",
  },
};
