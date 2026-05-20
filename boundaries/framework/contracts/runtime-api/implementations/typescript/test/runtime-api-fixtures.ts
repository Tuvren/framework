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
  ContextManifest,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  OrchestrationHandle,
  OrchestrationResult,
  OrchestrationRuntime,
  ProviderStreamChunk,
  TuvrenMessage,
  TuvrenRuntime,
  TuvrenStreamEvent,
  TuvrenToolDefinition,
} from "@tuvren/runtime-api";

// Binding-local harness only: cross-implementation runtime-api authority lives
// in the packet TypeSpec and conformance plans, not in these TypeScript values.
function emptyEvents<T>(): AsyncIterable<T> {
  return (async function* () {
    yield* [];
  })();
}

const noopExecutionHandle: ExecutionHandle = {
  async awaitResult(): Promise<ExecutionResult> {
    return {
      executionStatus: { iterationCount: 0, phase: "completed" },
      status: "completed",
    };
  },
  cancel() {
    return;
  },
  events() {
    return emptyEvents();
  },
  resolveApproval() {
    return resumedExecutionHandle;
  },
  status() {
    return frameworkContractFixtures.executionStatus;
  },
  steer() {
    return;
  },
};

const resumedExecutionHandle: ExecutionHandle = {
  async awaitResult(): Promise<ExecutionResult> {
    return {
      executionStatus: { iterationCount: 2, phase: "completed" },
      status: "completed",
    };
  },
  cancel() {
    return;
  },
  events() {
    return emptyEvents();
  },
  resolveApproval() {
    return this;
  },
  status() {
    return {
      activeAgent: "primary",
      iterationCount: 2,
      phase: "running",
    };
  },
  steer() {
    return;
  },
};

const contextManifestFixture = {
  byRole: {
    assistant: 1,
    system: 0,
    tool: 1,
    user: 1,
  },
  extensions: {
    budget: {
      remaining: 3,
    },
  },
  lastAssistantMessageIndex: 1,
  lastUserMessageIndex: 0,
  messageCount: 3,
  tokenEstimate: 42,
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
} satisfies ContextManifest;

let resumedOrchestrationHandle: OrchestrationHandle;
let childOrchestrationHandle: OrchestrationHandle;

const noopOrchestrationHandle: OrchestrationHandle = {
  ...noopExecutionHandle,
  allEvents() {
    return emptyEvents();
  },
  awaitResult(): Promise<OrchestrationResult> {
    return Promise.resolve({
      childResults: {},
      executionStatus: { iterationCount: 0, phase: "completed" as const },
      status: "completed" as const,
    });
  },
  resolveApproval() {
    return resumedOrchestrationHandle;
  },
  spawn() {
    return childOrchestrationHandle;
  },
};

resumedOrchestrationHandle = {
  ...resumedExecutionHandle,
  allEvents() {
    return emptyEvents();
  },
  awaitResult(): Promise<OrchestrationResult> {
    return Promise.resolve({
      childResults: {},
      executionStatus: { iterationCount: 2, phase: "completed" as const },
      status: "completed" as const,
    });
  },
  resolveApproval() {
    return this;
  },
  spawn() {
    return childOrchestrationHandle;
  },
};

childOrchestrationHandle = {
  ...noopExecutionHandle,
  allEvents() {
    return emptyEvents();
  },
  awaitResult(): Promise<OrchestrationResult> {
    return Promise.resolve({
      childResults: {},
      executionStatus: { iterationCount: 0, phase: "completed" as const },
      status: "completed" as const,
    });
  },
  resolveApproval() {
    return this;
  },
  spawn() {
    return this;
  },
};

const noopOrchestrationRuntime: OrchestrationRuntime = {
  executeTurn() {
    return noopOrchestrationHandle;
  },
};

export const frameworkContractFixtures = {
  agentConfig: {
    extensions: [],
    maxIterations: 8,
    name: "primary",
    systemPrompt: "You are Tuvren Runtime.",
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
  } satisfies TuvrenMessage,
  contextManifest: contextManifestFixture,
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
    manifest: contextManifestFixture,
    pauseReason: "approval_required",
    phase: "paused",
  } satisfies ExecutionStatus,
  orchestrationHandle: noopOrchestrationHandle,
  orchestrationRuntime: noopOrchestrationRuntime,
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
        schemaId: "tuvren.agent.v1",
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
    listThreads() {
      return Promise.resolve({ threads: [] });
    },
    listBranches() {
      return Promise.resolve([]);
    },
    getTurnState() {
      return Promise.resolve({
        eventHash: null,
        manifest: null,
        paths: {},
        previousTurnNodeHash: null,
        schemaId: "tuvren.agent.v1",
        turnNodeHash: "1".repeat(64),
        turnTreeHash: "2".repeat(64),
      });
    },
    async *getTurnHistory() {
      // no-op iterator
    },
    readBranchMessages() {
      return Promise.resolve({ messages: [] });
    },
  } satisfies TuvrenRuntime,
  streamEvent: {
    messageId: "message_1",
    source: {
      agent: "primary",
      driver: "example",
      threadId: "thread_main",
    },
    text: "Need approval before continuing.",
    timestamp: 1_717_171_717_171,
    type: "text.done",
  } satisfies TuvrenStreamEvent,
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
  } satisfies TuvrenToolDefinition,
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
  malformedContextManifest: {
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
      total: -1,
    },
    toolResults: {
      byName: {},
      total: 0,
    },
    turnBoundaries: [],
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
