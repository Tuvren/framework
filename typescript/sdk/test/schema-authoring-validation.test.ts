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

import { createMemoryBackend } from "@tuvren/backend-memory";
import { TuvrenValidationError } from "@tuvren/core/errors";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createRunnerRegistry, createTuvrenRuntime } from "@tuvren/runtime";
import { z } from "zod/v3";

import { createStaticRunner } from "../../runtime/test/orchestration-runtime-runner-helpers.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
} from "../../runtime/test/runtime-core-test-helpers.ts";
import type { Schema } from "../src/lib/schema-authoring.js";
import { defineTool, jsonSchema } from "../src/lib/schema-authoring.js";

const citySchema = {
  additionalProperties: false,
  properties: { city: { type: "string" } },
  required: ["city"],
  type: "object",
};

const executeTool = async (tool: TuvrenToolDefinition, input: unknown) => {
  const runner = createStaticRunner((context) => {
    if (context.messages.some((message) => message.role === "tool")) {
      return {
        messages: [assistantText("done")],
        resolution: { reason: "done", type: "end_turn" },
      };
    }
    return {
      messages: [
        assistantToolCalls([{ callId: "call-1", input, name: tool.name }]),
      ],
      resolution: { type: "continue_iteration" },
      toolExecutionMode: "parallel",
    };
  }, "schema-test-runner");
  const runtime = createTuvrenRuntime({
    defaultRunnerId: runner.id,
    kernel: createRuntimeKernel({ backend: createMemoryBackend() }),
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "schema-test", tools: [tool] },
    signal: textSignal("run tool"),
    threadId: thread.threadId,
  });
  const events = await collectEvents(handle.events());
  const result = await handle.awaitResult();
  expect(result).toMatchObject({ status: "completed" });
  return events.filter((event) => event.type === "tool.result");
};

describe("schema-authoring tool input validation", () => {
  for (const [label, schema] of [
    ["plain", citySchema],
    ["wrapped", jsonSchema(citySchema)],
    ["lazy plain", () => citySchema],
    ["boolean false", false],
    ["wrapped boolean false", jsonSchema(false)],
  ] as const) {
    test(`${label} rejects invalid input before execution`, async () => {
      const executed: unknown[] = [];
      const tool = defineTool({
        description: "validates city",
        execute(input) {
          executed.push(input);
          return input;
        },
        inputSchema: schema,
        name: "city",
      });
      const events = await executeTool(tool, { city: 123 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        isError: true,
        output: { code: "tool_input_validation_failed" },
      });
      expect(executed).toEqual([]);
    });
  }

  test("plain JSON Schema permits valid input unchanged", async () => {
    const executed: unknown[] = [];
    const tool = defineTool({
      description: "validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: citySchema,
      name: "city",
    });
    const events = await executeTool(tool, { city: "Santiago" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ output: { city: "Santiago" } });
    expect(executed).toEqual([{ city: "Santiago" }]);
  });

  test("host validator accepts and transforms input that the JSON Schema rejects", async () => {
    const executed: unknown[] = [];
    const tool = defineTool({
      description: "host validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: jsonSchema(citySchema, {
        validate: () => ({ success: true, value: { city: "host-validated" } }),
      }),
      name: "city",
    });
    const events = await executeTool(tool, { city: 123 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ output: { city: "host-validated" } });
    expect(executed).toEqual([{ city: "host-validated" }]);
  });

  test("host validator rejects input that the JSON Schema accepts", async () => {
    const executed: unknown[] = [];
    const tool = defineTool({
      description: "host validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: jsonSchema(citySchema, {
        validate: () => ({
          error: new TuvrenValidationError("host rejected", {
            code: "tool_input_validation_failed",
            details: [{ message: "host rejected" }],
          }),
          success: false,
        }),
      }),
      name: "city",
    });
    const events = await executeTool(tool, { city: "Santiago" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      isError: true,
      output: { code: "tool_input_validation_failed" },
    });
    expect(executed).toEqual([]);
  });

  test("host validator can reject without diagnostic details", async () => {
    const executed: unknown[] = [];
    const tool = defineTool({
      description: "host validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: jsonSchema(citySchema, {
        validate: () => ({
          error: new TuvrenValidationError("host rejected", {
            code: "tool_input_validation_failed",
          }),
          success: false,
        }),
      }),
      name: "city",
    });
    const events = await executeTool(tool, { city: "Santiago" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      isError: true,
      output: {
        code: "tool_input_validation_failed",
        details: { message: "host rejected" },
      },
    });
    expect(executed).toEqual([]);
  });

  test("host validator receives the schema wrapper as its receiver", async () => {
    const tool = defineTool({
      description: "host validates city",
      execute: (input) => input,
      inputSchema: jsonSchema(citySchema, {
        validate(this: Schema<{ city: string }>, _input: unknown) {
          return {
            success: true,
            value: { city: this.jsonSchema === citySchema ? "bound" : "wrong" },
          };
        },
      }),
      name: "city",
    });
    const events = await executeTool(tool, { city: 123 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ output: { city: "bound" } });
  });

  test("Zod transformations reach execute", async () => {
    const executed: unknown[] = [];
    const tool = defineTool({
      description: "Zod validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: z.string().transform((value) => value.toUpperCase()),
      name: "city",
    });
    const events = await executeTool(tool, "santiago");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ output: "SANTIAGO" });
    expect(executed).toEqual(["SANTIAGO"]);
  });

  test("Standard Schema validator takes precedence over its JSON Schema", async () => {
    const executed: unknown[] = [];
    const schema = {
      toJSONSchema: () => citySchema,
      "~standard": {
        validate: (_input: unknown) => ({ value: { city: "standard" } }),
        vendor: "test",
        version: 1 as const,
      },
    };
    const tool = defineTool({
      description: "Standard Schema validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: schema,
      name: "city",
    });
    const events = await executeTool(tool, { city: 123 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ output: { city: "standard" } });
    expect(executed).toEqual([{ city: "standard" }]);
  });

  test("a CustomSchema on a tool definition retains its validator", async () => {
    const executed: unknown[] = [];
    const tool: TuvrenToolDefinition = {
      description: "custom schema validates city",
      execute(input) {
        executed.push(input);
        return input;
      },
      inputSchema: {
        toJSONSchema: () => citySchema,
        validate: () => ({ valid: true, value: { city: "custom" } }),
      },
      name: "city",
    };
    const events = await executeTool(tool, { city: 123 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ output: { city: "custom" } });
    expect(executed).toEqual([{ city: "custom" }]);
  });
});
