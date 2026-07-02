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
 * KRT-AX004: Server-side MCP binding and server sandbox endpoint.
 *
 * Acceptance criteria:
 * - An MCP server invoked by Tuvren server-side resolves as a Tuvren-server
 *   binding with endpoint kind mcp-server.
 * - A server sandbox endpoint executes isolated server-side capability work as
 *   a Tuvren-server binding.
 * - Both expose full Tuvren-server lifecycle observation and control.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeDriver } from "@tuvren/core/driver";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDriverRegistry as createBaseDriverRegistry,
  createBindingResolver,
  createTuvrenRuntime,
} from "../src/index.ts";
import { observationForClass } from "../src/lib/capability-attribution.ts";
import { createFakeKernelHarness } from "./fake-kernel.ts";
import {
  assistantText,
  assistantToolCalls,
  collectEvents,
  textSignal,
} from "./runtime-core-test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDriver(toolName: string): RuntimeDriver {
  return {
    id: "ax004-driver",
    async execute(context) {
      if (!context.messages.some((m) => m.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([
              { callId: "call-ax004", input: {}, name: toolName },
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
      throw new Error("no");
    },
  };
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
// MCP binding classification
// ---------------------------------------------------------------------------

describe("KRT-AX004 — MCP binding classification", () => {
  test("MCP tool resolves as tuvren-server execution class with mcp-server endpoint kind", () => {
    const mcpTool: TuvrenToolDefinition = {
      name: "mcp.my-server.search",
      description: "MCP search tool",
      inputSchema: { type: "object" },
      execute() {
        return {};
      },
      metadata: { mcp: { serverName: "my-server" } },
    };

    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition(mcpTool);

    expect(binding.executionClass).toBe("tuvren-server");
    expect(binding.endpoint.kind).toBe("mcp-server");
    expect(binding.endpoint.id).toBe("mcp-server:my-server");
    expect(binding.capabilityId).toBe("mcp.my-server.search");
  });

  test("MCP binding has full tuvren-server observation (canAudit, canCancel, canRetry)", () => {
    const observation = observationForClass("tuvren-server");

    expect(observation.canAudit).toBe(true);
    expect(observation.canCancel).toBe(true);
    expect(observation.canRetry).toBe(true);
    expect(observation.canResume).toBe(true);
    expect(observation.canObserveIntermediate).toBe(true);
    expect(observation.canPersistResult).toBe(true);
  });

  test("MCP tool emits tool.result event attributed to tuvren-server class", async () => {
    const toolName = "ax004-mcp-tool";
    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "mcp tool",
      inputSchema: { type: "object" },
      execute() {
        return { found: true };
      },
      metadata: { mcp: { serverName: "test-server" } },
    };

    const harness = createFakeKernelHarness();
    const driver = makeDriver(toolName);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax004-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary", tools: [tool] },
      signal: textSignal("mcp test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const toolResult = findToolResult(events);

    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBeFalsy();
    const attribution = toolResult?.attribution as
      | Record<string, unknown>
      | undefined;
    expect(attribution?.executionClass).toBe("tuvren-server");
  });
});

// ---------------------------------------------------------------------------
// Sandbox endpoint classification and execution
// ---------------------------------------------------------------------------

describe("KRT-AX004 — sandbox endpoint", () => {
  test("tool with sandbox metadata resolves as tuvren-server / tuvren-sandbox", () => {
    const sandboxTool: TuvrenToolDefinition = {
      name: "code.execute",
      description: "sandbox code execution",
      inputSchema: { type: "object" },
      execute() {
        return {};
      },
      metadata: { sandbox: { endpointId: "code-sandbox" } },
    };

    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition(sandboxTool);

    expect(binding.executionClass).toBe("tuvren-server");
    expect(binding.endpoint.kind).toBe("tuvren-sandbox");
    expect(binding.endpoint.id).toBe("sandbox:code-sandbox");
  });

  test("sandbox tool uses the registered executor, not tool.execute", async () => {
    const toolName = "ax004-sandbox-tool";
    const SANDBOX_OUTPUT = { sandboxed: true, result: 42 };
    let toolExecuteCalled = false;
    let sandboxExecuteCalled = false;

    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "sandbox tool",
      inputSchema: { type: "object" },
      execute() {
        toolExecuteCalled = true;
        return { wrong: true };
      },
      metadata: { sandbox: { endpointId: "my-sandbox" } },
    };

    const sandboxExecutor = {
      execute(_input: unknown, _context: unknown) {
        sandboxExecuteCalled = true;
        return SANDBOX_OUTPUT;
      },
    };

    const harness = createFakeKernelHarness();
    const driver = makeDriver(toolName);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax004-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [tool],
        sandboxExecutors: new Map([["my-sandbox", sandboxExecutor]]),
      },
      signal: textSignal("sandbox test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const toolResult = findToolResult(events);

    expect(sandboxExecuteCalled).toBe(true);
    expect(toolExecuteCalled).toBe(false);
    expect(toolResult?.isError).toBeFalsy();
    const output = toolResult?.output as Record<string, unknown> | undefined;
    expect(output?.sandboxed).toBe(true);
    expect(output?.result).toBe(42);
  });

  test("sandbox tool without registered executor falls back to tool.execute", async () => {
    const toolName = "ax004-sandbox-fallback";
    let toolExecuteCalled = false;

    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "sandbox tool with no registered executor",
      inputSchema: { type: "object" },
      execute() {
        toolExecuteCalled = true;
        return { fallback: true };
      },
      metadata: { sandbox: { endpointId: "missing-sandbox" } },
    };

    const harness = createFakeKernelHarness();
    const driver = makeDriver(toolName);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax004-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: "primary", tools: [tool] },
      signal: textSignal("fallback test"),
      threadId: thread.threadId,
    });
    await collectEvents(handle.events());

    expect(toolExecuteCalled).toBe(true);
  });

  test("sandbox binding has full tuvren-server observation", () => {
    const observation = observationForClass("tuvren-server");
    expect(observation.canAudit).toBe(true);
    expect(observation.canCancel).toBe(true);
    expect(observation.canRetry).toBe(true);
  });

  test("sandbox executor survives an aroundTool handler calling next(context)", async () => {
    const toolName = "ax004-sandbox-around-tool";
    const SANDBOX_OUTPUT = { sandboxed: true, fromSandbox: 99 };
    let sandboxExecuteCalled = false;
    let toolExecuteCalled = false;

    const tool: TuvrenToolDefinition = {
      name: toolName,
      description: "sandbox tool with aroundTool wrapper",
      inputSchema: { type: "object" },
      execute() {
        toolExecuteCalled = true;
        return { wrong: true };
      },
      metadata: { sandbox: { endpointId: "around-sandbox" } },
    };

    const sandboxExecutor = {
      execute(_input: unknown, _context: unknown) {
        sandboxExecuteCalled = true;
        return SANDBOX_OUTPUT;
      },
    };

    const harness = createFakeKernelHarness();
    const driver = makeDriver(toolName);
    const runtime = createTuvrenRuntime({
      defaultDriverId: "ax004-driver",
      driverRegistry: createBaseDriverRegistry([driver]),
      kernel: harness.kernel,
    });
    const thread = await runtime.createThread({});
    const handle = runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        name: "primary",
        tools: [tool],
        sandboxExecutors: new Map([["around-sandbox", sandboxExecutor]]),
        extensions: [
          {
            name: "passthrough-wrapper",
            // AroundToolSpec as a function — triggers the next(context) code path
            aroundTool: async (context, next) => next(context),
          },
        ],
      },
      signal: textSignal("around-tool sandbox test"),
      threadId: thread.threadId,
    });
    const events = await collectEvents(handle.events());
    const toolResult = findToolResult(events);

    expect(sandboxExecuteCalled).toBe(true);
    expect(toolExecuteCalled).toBe(false);
    expect(toolResult?.isError).toBeFalsy();
    const output = toolResult?.output as Record<string, unknown> | undefined;
    expect(output?.fromSandbox).toBe(99);
  });
});
