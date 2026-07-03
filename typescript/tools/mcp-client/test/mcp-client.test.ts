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
import type { ToolExecutionContext, ToolResultPart } from "@tuvren/core/tools";
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

      const echo = source.tools.find((tool) => tool.name === "mock.echo");
      expect(echo?.description).toBe("Echoes back the input string");
      expect(echo?.metadata).toEqual(
        expect.objectContaining({
          mcp: expect.objectContaining({
            originalName: "echo",
            serverName: "mock",
          }),
        })
      );

      const output = await echo?.execute(
        { message: "hello" },
        createToolContext("call-stdio", "mock.echo")
      );
      expect(output).toEqual({
        content: [{ text: "Echo: hello", type: "text" }],
        isError: false,
      });

      await expect(source.refresh()).resolves.toEqual({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "mock.echo" }),
          expect.objectContaining({ name: "mock.get-structured-content" }),
        ]),
      });
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
      const structured = source.tools.find(
        (tool) => tool.name === "http.get-structured-content"
      );
      const output = await structured?.execute(
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
      const echo = source.tools.find((tool) => tool.name === "http.echo");
      const output = await echo?.execute(
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
      const inputError = await echo.execute(
        { message: 1 },
        createToolContext("call-input", "invalid.echo")
      );
      expect(asToolResultPart(inputError).isError).toBe(true);
      expect(asToolResultPart(inputError).output).toEqual({
        error: expect.objectContaining({
          code: "mcp_tool_input_invalid",
          name: "TuvrenProviderError",
        }),
      });
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
      const outputError = await echo.execute(
        { message: "bad-output" },
        createToolContext("call-output", "invalid.echo")
      );
      expect(asToolResultPart(outputError).isError).toBe(true);
      expect(asToolResultPart(outputError).output).toEqual({
        error: expect.objectContaining({
          code: "mcp_tool_output_invalid",
          name: "TuvrenProviderError",
        }),
      });
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
      const result = asToolResultPart(
        await echo.execute(
          { message: "after-close" },
          createToolContext("call-closed", "closed.echo")
        )
      );

      expect(result).toEqual({
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
      const result = asToolResultPart(
        await failing.execute(
          { message: "fail" },
          createToolContext("call-tool-error", "server.failing")
        )
      );

      expect(result).toEqual({
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
      const result = asToolResultPart(
        await failing.execute(
          { message: "fail" },
          createToolContext("call-schema-error", "server.failing")
        )
      );

      expect(result.output).toEqual({
        error: expect.objectContaining({
          code: "mcp_tool_error",
          name: "TuvrenProviderError",
        }),
      });
    } finally {
      await source.close();
    }
  });

  test("closes the MCP client when initial refresh fails", async () => {
    const client = createInvalidToolSchemaMcpClient();

    await expect(
      createMcpToolSourceInternal({
        client,
        command: "unused",
        transport: "stdio",
      })
    ).rejects.toMatchObject({
      code: "mcp_tool_list_failed",
      name: "TuvrenProviderError",
    });
    expect(client.closed).toBe(true);
  });
});

function createToolContext(callId: string, name: string): ToolExecutionContext {
  return { callId, name };
}

function requireTool(
  tools: readonly {
    name: string;
    execute: (
      input: unknown,
      context: ToolExecutionContext
    ) => Promise<unknown> | unknown;
  }[],
  name: string
) {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }

  return tool;
}

function asToolResultPart(value: unknown): ToolResultPart {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "tool_result"
  ) {
    return value as ToolResultPart;
  }

  throw new Error("expected tool result part");
}

function createFailingMcpClient(): MCPClient {
  return {
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
  };
}

function createToolErrorMcpClient(options: {
  outputSchema: boolean;
}): MCPClient {
  return {
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
  };
}

function createInvalidStructuredOutputMcpClient(): MCPClient {
  return {
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
  };
}

function createInvalidToolSchemaMcpClient(): MCPClient & { closed: boolean } {
  return {
    closed: false,
    close() {
      this.closed = true;
      return Promise.resolve();
    },
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
  };
}
