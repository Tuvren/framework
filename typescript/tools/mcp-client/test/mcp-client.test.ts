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

import { TuvrenProviderError } from "@tuvren/core/errors";
import type {
  ToolExecutionContext,
  ToolResultPart,
  TuvrenToolDefinition,
} from "@tuvren/core/tools";
import {
  createMockMcpStdioCommand,
  createOfficialMcpEverythingStdioCommand,
  startMockMcpHttpServer,
  startOfficialMcpEverythingStreamableHttpServer,
} from "@tuvren/provider-testkit";

import { createMcpToolSource } from "../src/index.ts";
import type { MCPClient } from "../src/lib/mcp-sdk-client.ts";
import { createProviderError } from "../src/lib/mcp-sdk-client.ts";
import { createMcpToolSourceInternal } from "../src/lib/mcp-tool-source.ts";

const createToolContext = (
  callId: string,
  name: string
): ToolExecutionContext => ({ callId, name });

const requireTool = (
  tools: readonly TuvrenToolDefinition[],
  name: string
): TuvrenToolDefinition => {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }

  return tool;
};

const executeTool = async (
  tool: TuvrenToolDefinition,
  input: unknown,
  context: ToolExecutionContext
): Promise<unknown> => await Promise.resolve(tool.execute(input, context));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asToolResultPart = (value: unknown): ToolResultPart => {
  if (
    isRecord(value) &&
    value.type === "tool_result" &&
    typeof value.callId === "string" &&
    typeof value.name === "string" &&
    "output" in value &&
    (value.isError === undefined || typeof value.isError === "boolean")
  ) {
    return {
      callId: value.callId,
      ...(value.isError === undefined ? {} : { isError: value.isError }),
      name: value.name,
      output: value.output,
      type: "tool_result",
    };
  }

  throw new Error("expected tool result part");
};

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }

  throw new Error("expected record");
};

const requireSerializedProviderError = (
  result: ToolResultPart
): Record<string, unknown> => {
  const output = requireRecord(result.output);
  return requireRecord(output.error);
};

/* oxlint-disable typescript/promise-function-async -- MCP test doubles return exact settled or rejected promises so transport lifecycle and rejection timing remain explicit. */
const createFailingMcpClient = (): MCPClient => ({
  close() {
    return Promise.resolve();
  },
  initialize() {
    return Promise.resolve({ serverName: "failing" });
  },
  invokeTool() {
    return Promise.reject(
      createProviderError(
        "mcp_transport_failure",
        "Injected transport failure."
      )
    );
  },
  listTools() {
    return Promise.resolve([
      {
        description: "Always fails.",
        inputSchema: {
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
          type: "object",
        },
        name: "echo",
      },
    ]);
  },
});

const createToolErrorMcpClient = (options: {
  outputSchema: boolean;
}): MCPClient => ({
  close() {
    return Promise.resolve();
  },
  initialize() {
    return Promise.resolve({ serverName: "tool-error" });
  },
  invokeTool() {
    return Promise.resolve({
      content: [{ text: "tool said no", type: "text" }],
      isError: true,
    });
  },
  listTools() {
    return Promise.resolve([
      {
        description: "Returns an MCP tool error.",
        inputSchema: {
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
          type: "object",
        },
        name: "failing",
        ...(options.outputSchema
          ? {
              outputSchema: {
                properties: {
                  ok: { type: "boolean" },
                },
                required: ["ok"],
                type: "object",
              },
            }
          : {}),
      },
    ]);
  },
});

const createInvalidStructuredOutputMcpClient = (): MCPClient => ({
  close() {
    return Promise.resolve();
  },
  initialize() {
    return Promise.resolve({ serverName: "invalid-output" });
  },
  invokeTool() {
    return Promise.resolve({
      content: [{ text: "bad structured output", type: "text" }],
      structuredContent: { echoed: 123 },
    });
  },
  listTools() {
    return Promise.resolve([
      {
        description: "Returns invalid structured output.",
        inputSchema: {
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
          type: "object",
        },
        name: "echo",
        outputSchema: {
          properties: {
            echoed: { type: "string" },
          },
          required: ["echoed"],
          type: "object",
        },
      },
    ]);
  },
});

const createInvalidToolSchemaMcpClient = (): MCPClient & {
  closed: boolean;
} => ({
  close() {
    this.closed = true;
    return Promise.resolve();
  },
  closed: false,
  initialize() {
    return Promise.resolve({ serverName: "invalid-schema" });
  },
  invokeTool() {
    return Promise.resolve({
      content: [],
    });
  },
  listTools() {
    return Promise.resolve([
      {
        description: "Invalid schema.",
        inputSchema: {
          properties: {
            message: { type: "not-a-json-schema-type" },
          },
          type: "object",
        },
        name: "invalid",
      },
    ]);
  },
});
/* oxlint-enable typescript/promise-function-async */

describe("@tuvren/mcp-client", () => {
  test("connects over stdio, lists tools, invokes, refreshes, and closes", async () => {
    const command = createOfficialMcpEverythingStdioCommand();
    const source = await createMcpToolSource({
      ...command,
      name: "mock",
      transport: "stdio",
    });

    try {
      expect(source.serverName).toBe("mock");
      expect(source.tools.map((tool) => tool.name)).toContain("mock.echo");
      expect(source.tools.map((tool) => tool.name)).toContain(
        "mock.get-structured-content"
      );

      const echo = requireTool(source.tools, "mock.echo");
      expect(echo.description).toBe("Echoes back the input string");
      const metadata = requireRecord(echo.metadata);
      const mcpMetadata = requireRecord(metadata.mcp);
      expect(mcpMetadata.originalName).toBe("echo");
      expect(mcpMetadata.serverName).toBe("mock");

      const output = await executeTool(
        echo,
        { message: "hello" },
        createToolContext("call-stdio", "mock.echo")
      );
      expect(output).toEqual({
        content: [{ text: "Echo: hello", type: "text" }],
        isError: false,
      });

      const refreshed = await source.refresh();
      expect(refreshed.tools.map((tool) => tool.name)).toContain("mock.echo");
      expect(refreshed.tools.map((tool) => tool.name)).toContain(
        "mock.get-structured-content"
      );
    } finally {
      await source.close();
    }
  });

  test("connects over non-deprecated Streamable HTTP using the official everything server", async () => {
    const server = await startOfficialMcpEverythingStreamableHttpServer();
    const source = await createMcpToolSource({
      endpoint: server.endpoint,
      name: "http",
      transport: "http-sse",
    });

    try {
      const structured = requireTool(
        source.tools,
        "http.get-structured-content"
      );
      const output = await executeTool(
        structured,
        { location: "Chicago" },
        createToolContext("call-http", "http.get-structured-content")
      );
      expect(output).toEqual({
        conditions: "Light rain / drizzle",
        humidity: 82,
        temperature: 36,
      });
    } finally {
      await source.close();
      await server.close();
    }
  });

  test("honors auth headers over Streamable HTTP", async () => {
    const server = await startMockMcpHttpServer({
      requireHeaders: {
        authorization: "Bearer test-token",
        "x-mcp-test": "enabled",
      },
    });
    const source = await createMcpToolSource({
      auth: { kind: "bearer", token: "test-token" },
      endpoint: server.endpoint,
      headers: { "x-mcp-test": "enabled" },
      name: "http",
      transport: "http-sse",
    });

    try {
      const echo = requireTool(source.tools, "http.echo");
      const output = await executeTool(
        echo,
        { message: "streamable" },
        createToolContext("call-http", "http.echo")
      );
      expect(output).toEqual({ echoed: "streamable" });
    } finally {
      await source.close();
      await server.close();
    }
  });

  test("validates input schemas before invoking MCP tools", async () => {
    const command = createMockMcpStdioCommand({
      returnInvalidEchoOutput: true,
    });
    const source = await createMcpToolSource({
      ...command,
      name: "invalid",
      transport: "stdio",
    });

    try {
      const echo = requireTool(source.tools, "invalid.echo");
      const inputError = await executeTool(
        echo,
        { message: 1 },
        createToolContext("call-input", "invalid.echo")
      );
      expect(inputError).toEqual({
        callId: "call-input",
        isError: true,
        name: "invalid.echo",
        output: {
          error: expect.objectContaining({
            code: "mcp_tool_input_invalid",
            name: "TuvrenProviderError",
          }),
        },
        type: "tool_result",
      });
      const inputErrorResult = asToolResultPart(inputError);
      const inputProviderError =
        requireSerializedProviderError(inputErrorResult);
      expect(inputErrorResult.isError).toBe(true);
      expect(inputProviderError.code).toBe("mcp_tool_input_invalid");
      expect(inputProviderError.name).toBe("TuvrenProviderError");
    } finally {
      await source.close();
    }
  });

  test("validates successful MCP structured output against advertised output schemas", async () => {
    const source = await createMcpToolSourceInternal({
      client: createInvalidStructuredOutputMcpClient(),
      command: "unused",
      name: "invalid",
      transport: "stdio",
    });
    const echo = requireTool(source.tools, "invalid.echo");

    try {
      const outputError = await executeTool(
        echo,
        { message: "bad-output" },
        createToolContext("call-output", "invalid.echo")
      );
      expect(outputError).toEqual({
        callId: "call-output",
        isError: true,
        name: "invalid.echo",
        output: {
          error: expect.objectContaining({
            code: "mcp_tool_output_invalid",
            name: "TuvrenProviderError",
          }),
        },
        type: "tool_result",
      });
      const outputErrorResult = asToolResultPart(outputError);
      const outputProviderError =
        requireSerializedProviderError(outputErrorResult);
      expect(outputErrorResult.isError).toBe(true);
      expect(outputProviderError.code).toBe("mcp_tool_output_invalid");
      expect(outputProviderError.name).toBe("TuvrenProviderError");
    } finally {
      await source.close();
    }
  });

  test("normalizes transport failures into typed tool result errors", async () => {
    const observedErrors: TuvrenProviderError[] = [];
    const source = await createMcpToolSourceInternal({
      client: createFailingMcpClient(),
      command: "unused",
      name: "closed",
      onError(error) {
        observedErrors.push(error);
      },
      transport: "stdio",
    });
    const echo = requireTool(source.tools, "closed.echo");

    try {
      const rawResult = await executeTool(
        echo,
        { message: "after-close" },
        createToolContext("call-closed", "closed.echo")
      );
      expect(rawResult).toEqual({
        callId: "call-closed",
        isError: true,
        name: "closed.echo",
        output: {
          error: expect.objectContaining({
            code: "mcp_transport_failure",
            name: "TuvrenProviderError",
          }),
        },
        type: "tool_result",
      });
      const result = asToolResultPart(rawResult);

      const providerError = requireSerializedProviderError(result);
      expect(result.callId).toBe("call-closed");
      expect(result.isError).toBe(true);
      expect(result.name).toBe("closed.echo");
      expect(result.type).toBe("tool_result");
      expect(providerError.code).toBe("mcp_transport_failure");
      expect(providerError.name).toBe("TuvrenProviderError");
      expect(observedErrors).toHaveLength(1);
      expect(observedErrors[0]).toBeInstanceOf(TuvrenProviderError);
    } finally {
      await source.close();
    }
  });

  test("surfaces MCP tool error results as top-level tool errors", async () => {
    const source = await createMcpToolSourceInternal({
      client: createToolErrorMcpClient({ outputSchema: false }),
      command: "unused",
      name: "server",
      transport: "stdio",
    });
    const failing = requireTool(source.tools, "server.failing");

    try {
      const rawResult = await executeTool(
        failing,
        { message: "fail" },
        createToolContext("call-tool-error", "server.failing")
      );
      expect(rawResult).toEqual({
        callId: "call-tool-error",
        isError: true,
        name: "server.failing",
        output: {
          error: expect.objectContaining({
            code: "mcp_tool_error",
            message: expect.stringContaining("tool said no"),
            name: "TuvrenProviderError",
          }),
        },
        type: "tool_result",
      });
      const result = asToolResultPart(rawResult);

      const providerError = requireSerializedProviderError(result);
      expect(result.callId).toBe("call-tool-error");
      expect(result.isError).toBe(true);
      expect(result.name).toBe("server.failing");
      expect(result.type).toBe("tool_result");
      expect(providerError.code).toBe("mcp_tool_error");
      expect(providerError.message).toContain("tool said no");
      expect(providerError.name).toBe("TuvrenProviderError");
    } finally {
      await source.close();
    }
  });

  test("does not mask MCP tool error results as output-schema validation failures", async () => {
    const source = await createMcpToolSourceInternal({
      client: createToolErrorMcpClient({ outputSchema: true }),
      command: "unused",
      name: "server",
      transport: "stdio",
    });
    const failing = requireTool(source.tools, "server.failing");

    try {
      const rawResult = await executeTool(
        failing,
        { message: "fail" },
        createToolContext("call-schema-error", "server.failing")
      );
      expect(rawResult).toEqual({
        callId: "call-schema-error",
        isError: true,
        name: "server.failing",
        output: {
          error: expect.objectContaining({
            code: "mcp_tool_error",
            name: "TuvrenProviderError",
          }),
        },
        type: "tool_result",
      });
      const result = asToolResultPart(rawResult);

      const providerError = requireSerializedProviderError(result);
      expect(providerError.code).toBe("mcp_tool_error");
      expect(providerError.name).toBe("TuvrenProviderError");
    } finally {
      await source.close();
    }
  });

  test("closes the MCP client when initial refresh fails", async () => {
    const client = createInvalidToolSchemaMcpClient();

    let rejection: unknown;
    try {
      await createMcpToolSourceInternal({
        client,
        command: "unused",
        transport: "stdio",
      });
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(TuvrenProviderError);
    if (!(rejection instanceof TuvrenProviderError)) {
      throw new Error("expected TuvrenProviderError rejection");
    }
    expect(rejection.code).toBe("mcp_tool_list_failed");
    expect(rejection.name).toBe("TuvrenProviderError");
    expect(client.closed).toBe(true);
  });
});
