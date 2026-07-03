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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TuvrenProviderError } from "@tuvren/core/errors";
import type { McpTransportConfig } from "./mcp-tool-source.js";

export type McpSdkTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];
type McpSdkListToolsResult = Awaited<ReturnType<Client["listTools"]>>;
export type McpSdkToolResult = Awaited<ReturnType<Client["callTool"]>>;

export interface MCPClient {
  close(): Promise<void>;
  initialize(): Promise<{ serverName: string }>;
  invokeTool(name: string, input: unknown): Promise<McpSdkToolResult>;
  listTools(): Promise<McpSdkTool[]>;
}

const CLIENT_INFO = {
  name: "tuvren-mcp-client",
  version: "0.0.0",
};

export function createSdkMcpClient(config: McpTransportConfig): MCPClient {
  return new SdkMcpClient(config);
}

class SdkMcpClient implements MCPClient {
  private readonly client = new Client(CLIENT_INFO, {
    capabilities: {},
  });
  private readonly config: McpTransportConfig;
  private transport: Transport | undefined;

  constructor(config: McpTransportConfig) {
    this.config = config;
  }

  async initialize(): Promise<{ serverName: string }> {
    try {
      this.transport = createTransport(this.config);
      await this.client.connect(this.transport);
      return {
        serverName: this.client.getServerVersion()?.name ?? "mcp-server",
      };
    } catch (error: unknown) {
      throw createProviderError(
        "mcp_initialize_failed",
        "MCP client initialization failed.",
        error
      );
    }
  }

  async listTools(): Promise<McpSdkTool[]> {
    try {
      const tools: McpSdkTool[] = [];
      let cursor: string | undefined;

      do {
        const result: McpSdkListToolsResult = await this.client.listTools(
          cursor === undefined ? undefined : { cursor }
        );
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor !== undefined);

      return tools;
    } catch (error: unknown) {
      throw createProviderError(
        "mcp_tool_list_failed",
        "MCP tool listing failed.",
        error
      );
    }
  }

  async invokeTool(name: string, input: unknown): Promise<McpSdkToolResult> {
    try {
      return await this.client.callTool({
        arguments: normalizeToolArguments(input),
        name,
      });
    } catch (error: unknown) {
      throw createProviderError(
        "mcp_transport_failure",
        `MCP tool "${name}" invocation failed.`,
        error,
        { toolName: name }
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function createTransport(config: McpTransportConfig): Transport {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        args: config.args,
        command: config.command,
        cwd: config.cwd,
        env: config.env,
        stderr: "pipe",
      });
    case "http-sse":
      return new StreamableHTTPClientTransport(new URL(config.endpoint), {
        requestInit: {
          headers: createHttpHeaders(config),
        },
      });
    default: {
      const exhaustive: never = config;
      throw createProviderError(
        "mcp_connection_failed",
        `Unsupported MCP transport ${(exhaustive as { transport: string }).transport}.`
      );
    }
  }
}

function createHttpHeaders(
  config: Extract<McpTransportConfig, { transport: "http-sse" }>
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(config.headers ?? {})) {
    headers[name] = value;
  }

  if (config.auth?.kind === "bearer") {
    headers.Authorization = `Bearer ${config.auth.token}`;
  }

  if (config.auth?.kind === "header") {
    headers[config.auth.name] = config.auth.value;
  }

  return headers;
}

function normalizeToolArguments(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {};
  }

  if (isRecord(input)) {
    return input;
  }

  return { value: input };
}

export function createProviderError(
  code: string,
  message: string,
  cause?: unknown,
  details?: unknown
): TuvrenProviderError {
  if (cause instanceof TuvrenProviderError) {
    return cause;
  }

  return new TuvrenProviderError(message, {
    cause,
    code,
    details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
