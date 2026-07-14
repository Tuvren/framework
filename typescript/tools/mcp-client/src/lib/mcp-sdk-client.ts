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

/** One tool entry as advertised by the official MCP SDK's `listTools`. */
export type McpSdkTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];
/** The raw paginated result of the official MCP SDK's `listTools`. */
type McpSdkListToolsResult = Awaited<ReturnType<Client["listTools"]>>;
/** The raw result of the official MCP SDK's `callTool`. */
export type McpSdkToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * The minimal MCP transport-and-protocol surface `mcp-tool-source.ts`
 * depends on. Implemented by {@link createSdkMcpClient}'s
 * {@link SdkMcpClient} in production, and by fakes in tests (see
 * `McpToolSourcePrivateOptions.client`).
 */
export interface MCPClient {
  close(): Promise<void>;
  initialize(): Promise<{ serverName: string }>;
  invokeTool(name: string, input: unknown): Promise<McpSdkToolResult>;
  listTools(): Promise<McpSdkTool[]>;
}

/** Client identity reported to MCP servers during connection handshake. */
const CLIENT_INFO = {
  name: "tuvren-mcp-client",
  version: "0.0.0",
};

/** Builds the production {@link MCPClient}, backed by the official `@modelcontextprotocol/sdk` `Client`. */
export function createSdkMcpClient(config: McpTransportConfig): MCPClient {
  return new SdkMcpClient(config);
}

/**
 * {@link MCPClient} implementation over the official
 * `@modelcontextprotocol/sdk` `Client`, connected via
 * {@link createTransport}'s stdio or Streamable HTTP transport.
 */
class SdkMcpClient implements MCPClient {
  private readonly client = new Client(CLIENT_INFO, {
    capabilities: {},
  });
  private readonly config: McpTransportConfig;
  private transport: Transport | undefined;

  constructor(config: McpTransportConfig) {
    this.config = config;
  }

  /**
   * Creates and connects the transport, returning the server's advertised
   * name (or `"mcp-server"` when it does not report one).
   *
   * @throws TuvrenProviderError with code `mcp_initialize_failed` when the
   *   transport connection fails.
   */
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

  /**
   * Lists all of the server's tools, following `nextCursor` pagination until
   * exhausted.
   *
   * @throws TuvrenProviderError with code `mcp_tool_list_failed` when
   *   listing fails.
   */
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

  /**
   * Invokes one named tool with `input` normalized via
   * {@link normalizeToolArguments}.
   *
   * @throws TuvrenProviderError with code `mcp_transport_failure` when the
   *   call fails.
   */
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

  /** Closes the underlying transport. */
  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Builds the MCP SDK transport for a connection config: `StdioClientTransport`
 * for `stdio`, `StreamableHTTPClientTransport` (with auth/extra headers via
 * {@link createHttpHeaders}) for `http-sse`.
 *
 * @throws TuvrenProviderError with code `mcp_connection_failed` for an
 *   unrecognized transport kind.
 */
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

/**
 * Merges the transport's plain `headers` with its `auth` credential
 * (bearer becomes an `Authorization` header; header-auth sets the named
 * header directly). This is the one place `McpAuth` material is turned into
 * wire-format request headers, confined to the transport edge (README
 * "Secret Isolation — Edge Confinement", ADR-044).
 */
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

/**
 * Coerces a tool's execution input into the plain-object shape the MCP SDK's
 * `callTool` requires: `undefined`/`null` becomes `{}`, an existing record
 * passes through, and any other value is wrapped as `{ value: input }`.
 */
function normalizeToolArguments(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {};
  }

  if (isRecord(input)) {
    return input;
  }

  return { value: input };
}

/**
 * Builds a `TuvrenProviderError` for an MCP failure; an existing
 * `TuvrenProviderError` `cause` passes through unchanged (its original code
 * and message win) instead of being double-wrapped.
 */
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

/** True when a value is a non-null object (loose record predicate). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
