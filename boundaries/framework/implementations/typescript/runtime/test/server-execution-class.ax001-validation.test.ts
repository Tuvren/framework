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

/**
 * KRT-AX001: Tuvren-server invocation lifecycle — input and output validation.
 *
 * Acceptance criteria:
 * - Inputs are validated against the declared contract before execution.
 * - Outputs are validated against the declared result shape before being surfaced.
 * - A validation failure surfaces as tool.result with isError true carrying
 *   tool_input_validation_failed or tool_result_validation_failed.
 * - A within-contract invocation executes and returns its result unchanged.
 *
 * Note on schema paths:
 * - Input validation via raw TuvrenToolDefinition (plain JSON schema) goes
 *   through the AJV path in validateToolInput — this is the operative path.
 * - Output validation goes through the AJV path in validateToolOutput since
 *   outputSchema is stored as a plain TuvrenJsonSchema, not a CustomSchema.
 * - defineTool with a bare JSON schema produces a CustomSchema with no
 *   validate function, so its validate() always succeeds — by design, callers
 *   opt into runtime validation via Zod, Standard Schema, or an explicit
 *   validate option. Input validation tests therefore use raw TuvrenToolDefinition.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import {
  TOOL_INPUT_VALIDATION_FAILED,
  TOOL_RESULT_VALIDATION_FAILED,
} from "@tuvren/core/errors";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createTuvrenRuntime,
} from "../src/index.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Input schema with AJV enforcement (strict schema, raw TuvrenToolDefinition)
// ---------------------------------------------------------------------------

const STRICT_INPUT_SCHEMA: import("@tuvren/core/tools").TuvrenJsonSchema = {
  type: "object",
  properties: {
    value: { type: "number" },
  },
  required: ["value"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeDriverWithInput(toolName: string, input: unknown): RuntimeDriver {
  return {
    id: "ax001-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-ax001", input, name: toolName },
            ]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
    async resume() {
      throw new Error("resume not expected");
    },
  };
}

async function runWithTool(tool: TuvrenToolDefinition, driver: RuntimeDriver) {
  const harness = createFakeKernelHarness();
  const runtime = createTuvrenRuntime({
    defaultDriverId: driver.id,
    driverRegistry: createBaseDriverRegistry([driver]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary", tools: [tool] },
    signal: textSignal("ax001 test"),
    threadId: thread.threadId,
  });
  return collectEvents(handle.events());
}

function findToolResult(events: unknown[]) {
  return events.find(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      "type" in e &&
      (e as Record<string, unknown>).type === "tool.result"
  ) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Input validation: error code (AJV path via raw TuvrenToolDefinition)
// ---------------------------------------------------------------------------

describe("KRT-AX001 — input validation", () => {
  const toolName = "ax001-validate-input";

  test("input validation failure surfaces as tool.result isError true", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool with strict input schema",
      inputSchema: STRICT_INPUT_SCHEMA,
      execute() {
        return { result: 0 };
      },
    };
    const driver = makeDriverWithInput(toolName, { wrongField: "bad" });
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);

    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBe(true);
  });

  test("input validation failure carries tool_input_validation_failed code", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool with strict input schema",
      inputSchema: STRICT_INPUT_SCHEMA,
      execute() {
        return { result: 0 };
      },
    };
    const driver = makeDriverWithInput(toolName, { wrongField: "bad" });
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);
    const output = toolResult?.output as Record<string, unknown> | undefined;

    expect(output?.code).toBe(TOOL_INPUT_VALIDATION_FAILED);
  });

  test("tool body is not executed when input validation fails", async () => {
    let executed = false;
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "spy tool",
      inputSchema: STRICT_INPUT_SCHEMA,
      execute() {
        executed = true;
        return { result: 0 };
      },
    };
    const driver = makeDriverWithInput(toolName, { wrongField: "bad" });
    await runWithTool(tool, driver);

    expect(executed).toBe(false);
  });

  test("within-contract input passes validation and executes normally", async () => {
    let executedWith: unknown;
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "spy tool",
      inputSchema: STRICT_INPUT_SCHEMA,
      execute(input) {
        executedWith = input;
        return { result: (input as { value: number }).value };
      },
    };
    const driver = makeDriverWithInput(toolName, { value: 42 });
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);

    expect(executedWith).toEqual({ value: 42 });
    expect(toolResult?.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Output validation (AJV path via outputSchema as plain TuvrenJsonSchema)
// ---------------------------------------------------------------------------

describe("KRT-AX001 — output validation", () => {
  const toolName = "ax001-validate-output";

  const OUTPUT_SCHEMA: import("@tuvren/core/tools").TuvrenJsonSchema = {
    type: "object",
    properties: {
      count: { type: "number" },
    },
    required: ["count"],
    additionalProperties: false,
  };

  test("output validation failure surfaces as tool.result isError true", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool with output schema",
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
      execute() {
        // Return an output that violates the outputSchema
        return { wrongField: "invalid" };
      },
    };

    const driver = makeDriverWithInput(toolName, {});
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);

    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBe(true);
  });

  test("output validation failure carries tool_result_validation_failed code", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool with output schema",
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
      execute() {
        return { wrongField: "invalid" };
      },
    };

    const driver = makeDriverWithInput(toolName, {});
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);
    const output = toolResult?.output as Record<string, unknown> | undefined;

    expect(output?.code).toBe(TOOL_RESULT_VALIDATION_FAILED);
  });

  test("within-contract output passes validation and result is unchanged", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool with output schema",
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
      execute() {
        return { count: 7 };
      },
    };

    const driver = makeDriverWithInput(toolName, {});
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);

    expect(toolResult?.isError).toBeFalsy();
    expect((toolResult?.output as Record<string, unknown>)?.count).toBe(7);
  });

  test("tool without outputSchema has its output surfaced unchanged regardless of shape", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool without output schema",
      inputSchema: { type: "object" },
      // No outputSchema — no output validation
      execute() {
        return { anyShape: true, nested: { x: 1 } };
      },
    };

    const driver = makeDriverWithInput(toolName, {});
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);

    expect(toolResult?.isError).toBeFalsy();
    const output = toolResult?.output as Record<string, unknown> | undefined;
    expect(output?.anyShape).toBe(true);
  });

  test("direct error result from tool bypasses output schema validation", async () => {
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "tool that returns direct error result",
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
      execute(_input, context) {
        // Return a direct ToolResultPart with isError: true — should bypass output validation
        return {
          callId: context.callId,
          isError: true as const,
          name: toolName,
          output: { error: "explicit error", code: "custom_error" },
          type: "tool_result" as const,
        };
      },
    };

    const driver = makeDriverWithInput(toolName, {});
    const events = await runWithTool(tool, driver);
    const toolResult = findToolResult(events);

    // The tool explicitly declared an error — outputSchema must not override it
    expect(toolResult?.isError).toBe(true);
    const output = toolResult?.output as Record<string, unknown> | undefined;
    expect(output?.code).not.toBe(TOOL_RESULT_VALIDATION_FAILED);
    expect(output?.code).toBe("custom_error");
  });
});
