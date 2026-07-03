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

/**
 * Conformance adapter operations for the framework `trust-boundary` check set
 * (ADR-039 / ADR-044, KRT-BD009). Each operation drives the real runtime across
 * a trust boundary the PRD elevated and returns the RAW observation surfaces
 * (paused phase, executed tool names, persisted tool results) plus enough
 * context for the shared runner-owned plan assertions to grade the guarantee.
 * This adapter performs no pass/fail grading.
 */

import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticRunner,
  DRIVER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasToolMessage(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) => isRecord(message) && message.role === "tool"
  );
}

function readEventType(event: unknown): string | undefined {
  return isRecord(event) && typeof event.type === "string"
    ? event.type
    : undefined;
}

interface ObservedToolResult {
  callId: unknown;
  errorCode: string | undefined;
  isError: boolean;
  name: unknown;
}

function readToolResults(messages: readonly unknown[]): ObservedToolResult[] {
  const results: ObservedToolResult[] = [];

  for (const message of messages) {
    if (!(isRecord(message) && message.role === "tool")) {
      continue;
    }

    const parts = Array.isArray(message.parts) ? message.parts : [];

    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }

      // A validation-error tool result carries its stable code on
      // `output.code` (with `output.error` holding the human message); see
      // createValidationErrorToolResult in the runtime.
      const output = part.output;
      const errorCode =
        isRecord(output) && typeof output.code === "string"
          ? output.code
          : undefined;

      results.push({
        callId: part.callId,
        errorCode,
        isError: part.isError === true,
        name: part.name,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Operation: runtime.trust-boundary.approval-gate
//
// A turn calls an approval-gated tool but no approval decision is ever
// supplied. The framework must pause the turn awaiting an explicit decision and
// must NOT execute the gated tool. The raw surface captures the paused phase,
// whether an approval request was emitted, and the names of tools that actually
// executed — proving the gate cannot be bypassed without a decision.
// ---------------------------------------------------------------------------

export async function runTrustBoundaryApprovalNonBypassable(
  _input: unknown
): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  const executedToolNames: string[] = [];
  const gatedToolName = "trust-boundary-gated-tool";
  const driver = createStaticRunner(async () => {
    await Promise.resolve();
    return {
      messages: [
        assistantToolCalls([
          {
            callId: "call-gated",
            input: { confirm: true },
            name: gatedToolName,
          },
        ]),
      ],
      resolution: { type: "continue_iteration" },
      toolExecutionMode: "parallel",
    };
  });
  const tools: TuvrenToolDefinition[] = [
    {
      approval: true,
      description: "Trust-boundary approval-gated tool",
      execute() {
        executedToolNames.push(gatedToolName);
        return { ok: true };
      },
      inputSchema: { type: "object" },
      name: gatedToolName,
    },
  ];
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: DRIVER_ID,
    driverRegistry: createRunnerRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME, tools },
    signal: textSignal("Run the gated action."),
    threadId: thread.threadId,
  });

  // The stream completes (yields control) when the turn pauses for approval.
  const events = await collectValues(handle.events());
  const pausedPhase = handle.status().phase;
  const approvalRequested = events.some(
    (event) => readEventType(event) === "approval.requested"
  );
  const gatedToolExecutedWithoutDecision =
    executedToolNames.includes(gatedToolName);

  // No decision is supplied; release the paused turn so the harness tears down.
  handle.cancel();
  await handle.awaitResult().catch(() => undefined);

  return {
    result: {
      trustBoundary: {
        approval: {
          approvalRequested,
          executedToolNames,
          gatedToolExecutedWithoutDecision,
          pausedPhase,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.trust-boundary.local-tool-input
//
// A turn calls a local tool with input that violates the tool's declared input
// schema. The framework must reject it before execution and surface a
// `tool.result` with `isError: true` carrying `tool_input_validation_failed`.
// The raw surface captures the persisted tool results and whether the tool's
// `execute` was ever invoked.
// ---------------------------------------------------------------------------

export async function runTrustBoundaryLocalToolInput(
  _input: unknown
): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  let toolExecuted = false;
  const toolName = "trust-boundary-strict-tool";
  const driver = createStaticRunner(async (context) => {
    await Promise.resolve();

    if (!hasToolMessage(context.messages)) {
      return {
        messages: [
          assistantToolCalls([
            // `city` must be a string; a number violates the declared schema.
            { callId: "call-invalid", input: { city: 123 }, name: toolName },
          ]),
        ],
        resolution: { type: "continue_iteration" },
        toolExecutionMode: "parallel",
      };
    }

    return {
      messages: [assistantText("trust-boundary local-input turn complete")],
      resolution: { reason: "done", type: "end_turn" },
    };
  });
  const tools: TuvrenToolDefinition[] = [
    {
      description: "Trust-boundary strict-input tool",
      execute() {
        toolExecuted = true;
        return { ok: true };
      },
      inputSchema: {
        additionalProperties: false,
        properties: { city: { type: "string" } },
        required: ["city"],
        type: "object",
      },
      name: toolName,
    },
  ];
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: DRIVER_ID,
    driverRegistry: createRunnerRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME, tools },
    signal: textSignal("Run the strict tool with bad input."),
    threadId: thread.threadId,
  });
  await collectValues(handle.events());
  await handle.awaitResult();
  const messages = await harness.readBranchMessages(thread.branchId);
  const toolResults = readToolResults(messages);

  return {
    result: {
      trustBoundary: {
        localToolInput: {
          toolExecuted,
          toolResults,
        },
      },
    },
  };
}
