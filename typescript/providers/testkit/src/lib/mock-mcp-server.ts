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

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

/**
 * Failure-mode and auth switches for the mock MCP server's `echo`/`search`
 * tools, used by MCP-client conformance tests to exercise error paths
 * without a real MCP backend.
 */
export interface MockMcpServerOptions {
  /**
   * When true, destroys the connection instead of responding to any
   * `tools/call` request — simulates a transport drop mid-call
   * (Streamable HTTP transport only).
   */
  failToolCallsWithTransportClose?: boolean;
  /** Header name/value pairs a request must match exactly, or the server responds 401. */
  requireHeaders?: Record<string, string>;
  /** When true, the `echo` tool returns a structured output that violates its declared schema. */
  returnInvalidEchoOutput?: boolean;
}

/** A running mock MCP Streamable HTTP server bound to a loopback TCP port. */
export interface RunningMockMcpHttpServer {
  /** Stops the server and releases the port. */
  close(): Promise<void>;
  /** The `http://127.0.0.1:<port>/mcp` endpoint URL. */
  endpoint: string;
}

/** A running official `@modelcontextprotocol/server-everything` Streamable HTTP process. */
export interface RunningOfficialMcpEverythingServer {
  /** Stops the child process and releases the port. */
  close(): Promise<void>;
  /** The `http://127.0.0.1:<port>/mcp` endpoint URL. */
  endpoint: string;
}

/** Zod input schema for the mock `echo` tool. */
const ECHO_INPUT_SCHEMA = {
  message: z.string(),
};

/** Zod output schema for the mock `echo` tool. */
const ECHO_OUTPUT_SCHEMA = {
  echoed: z.string(),
};

/** Zod input schema for the mock `search` tool. */
const SEARCH_INPUT_SCHEMA = {
  query: z.string(),
};

/**
 * Starts a mock MCP server on a Streamable HTTP transport, bound to an
 * ephemeral loopback port.
 *
 * @throws Error when the underlying HTTP server does not bind a TCP port.
 */
export async function startMockMcpHttpServer(
  options: MockMcpServerOptions = {}
): Promise<RunningMockMcpHttpServer> {
  const httpServer = createServer(async (request, response) => {
    if (!request.url?.startsWith("/mcp")) {
      response.writeHead(404).end();
      return;
    }

    if (!headersMatch(request, options.requireHeaders ?? {})) {
      response.writeHead(401).end("unauthorized");
      return;
    }

    try {
      const parsedBody =
        request.method === "POST" ? await readRequestBody(request) : undefined;

      if (
        options.failToolCallsWithTransportClose === true &&
        isJsonRpcMethod(parsedBody, "tools/call")
      ) {
        request.socket.destroy();
        return;
      }

      const mcpServer = createMockMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } catch (error: unknown) {
      response
        .writeHead(500)
        .end(error instanceof Error ? error.message : String(error));
    }
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  const address = httpServer.address();

  if (typeof address !== "object" || address === null) {
    throw new Error("mock MCP HTTP server did not bind a TCP port");
  }

  return {
    async close() {
      await closeHttpServer(httpServer);
    },
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
  };
}

/**
 * Builds a stdio child-process command that runs the mock MCP server via
 * `src/bin/mock-mcp-stdio.ts`. Only `returnInvalidEchoOutput` threads
 * through (as the `MOCK_MCP_INVALID_ECHO_OUTPUT` env var); the other
 * {@link MockMcpServerOptions} apply to the HTTP transport only.
 */
export function createMockMcpStdioCommand(options: MockMcpServerOptions = {}): {
  args: string[];
  command: string;
  env?: Record<string, string>;
} {
  return {
    args: [resolveMockMcpStdioBin()],
    command: process.execPath,
    env: {
      MOCK_MCP_INVALID_ECHO_OUTPUT:
        options.returnInvalidEchoOutput === true ? "1" : "0",
    },
  };
}

/** Builds a stdio child-process command that runs the official `@modelcontextprotocol/server-everything` binary. */
export function createOfficialMcpEverythingStdioCommand(): {
  args: string[];
  command: string;
} {
  return {
    args: [resolveMcpEverythingBin(), "stdio"],
    command: process.execPath,
  };
}

/**
 * Reserves a loopback port, spawns the official
 * `@modelcontextprotocol/server-everything` binary on Streamable HTTP, and
 * waits for it to accept requests before resolving.
 *
 * @throws Error when the child process exits, or does not become ready,
 *   before the readiness deadline.
 */
export async function startOfficialMcpEverythingStreamableHttpServer(): Promise<RunningOfficialMcpEverythingServer> {
  const port = await reserveTcpPort();
  const command = resolveMcpEverythingBin();
  const child = spawn(process.execPath, [command, "streamableHttp"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  try {
    await waitForHttpServer(endpoint, child);
  } catch (error: unknown) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    async close() {
      await stopChildProcess(child);
    },
    endpoint,
  };
}

/** Connects a mock MCP server to stdio; used as the entry point for {@link createMockMcpStdioCommand}'s child process. */
export async function serveMockMcpStdio(
  options: MockMcpServerOptions = {}
): Promise<void> {
  const server = createMockMcpServer(options);
  await server.connect(new StdioServerTransport());
}

/** Builds the shared `echo`/`search` mock MCP server used by both transports. */
function createMockMcpServer(options: MockMcpServerOptions): McpServer {
  const server = new McpServer({
    name: "tuvren-mock-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      annotations: {
        readOnlyHint: true,
        title: "Echo",
      },
      description: "Echo a message deterministically.",
      inputSchema: ECHO_INPUT_SCHEMA,
      outputSchema: ECHO_OUTPUT_SCHEMA,
    },
    (input) => {
      const message = input.message;
      const structuredContent =
        options.returnInvalidEchoOutput === true
          ? { echoed: 123 }
          : { echoed: message };

      return {
        content: [{ text: `echo:${message}`, type: "text" }],
        structuredContent,
      };
    }
  );

  server.registerTool(
    "search",
    {
      description: "Return a deterministic search result.",
      inputSchema: SEARCH_INPUT_SCHEMA,
    },
    (input) => ({
      content: [
        {
          text: `result:${input.query}`,
          type: "text",
        },
      ],
    })
  );

  return server;
}

/** True when every expected header (case-insensitive name) is present on the request with an exact value match. */
function headersMatch(
  request: IncomingMessage,
  expectedHeaders: Record<string, string>
): boolean {
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    if (request.headers[name.toLowerCase()] !== expected) {
      return false;
    }
  }

  return true;
}

/**
 * Walks up from this file to find `src/bin/mock-mcp-stdio.ts`.
 *
 * @throws Error when the bin file cannot be located within 8 parent directories.
 */
function resolveMockMcpStdioBin(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  let currentDirectory = dirname(currentFilePath);

  for (let index = 0; index < 8; index += 1) {
    const candidate = join(currentDirectory, "src", "bin", "mock-mcp-stdio.ts");

    if (existsSync(candidate)) {
      return candidate;
    }

    currentDirectory = dirname(currentDirectory);
  }

  throw new Error("unable to locate mock MCP stdio bin");
}

/**
 * Walks up from this file to find the installed
 * `node_modules/.bin/mcp-server-everything` binary.
 *
 * @throws Error when the binary cannot be located within 10 parent directories.
 */
function resolveMcpEverythingBin(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  let currentDirectory = dirname(currentFilePath);

  for (let index = 0; index < 10; index += 1) {
    const candidate = join(
      currentDirectory,
      "node_modules",
      ".bin",
      "mcp-server-everything"
    );

    if (existsSync(candidate)) {
      return candidate;
    }

    currentDirectory = dirname(currentDirectory);
  }

  throw new Error("unable to locate official MCP everything server bin");
}

/**
 * Binds an ephemeral loopback port, closes the probe server, and returns the
 * OS-assigned port number for a subsequent server to reuse.
 *
 * @throws Error when the OS does not assign a TCP port.
 */
async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await closeHttpServer(server);

  if (typeof address !== "object" || address === null) {
    throw new Error("unable to reserve a TCP port");
  }

  return address.port;
}

/**
 * Polls `endpoint` with `POST` requests until it responds, the child process
 * exits, or a 5-second deadline elapses.
 *
 * @throws Error when the child exits early or the deadline elapses first.
 */
async function waitForHttpServer(
  endpoint: string,
  child: ChildProcess
): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `official MCP everything server exited ${child.exitCode}`
      );
    }

    try {
      const response = await fetch(endpoint, { method: "POST" });

      if (response.status !== 0) {
        return;
      }
    } catch (error: unknown) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `official MCP everything server did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/** Sends `SIGINT`, waits up to 1 second, then escalates to `SIGKILL` if the process is still alive. */
async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGINT");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

/** Closes an HTTP server, force-closing open connections; a no-op if it is already stopped. */
async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ERR_SERVER_NOT_RUNNING"
      ) {
        resolve();
        return;
      }

      reject(error);
    });
    server.closeAllConnections();
  });
}

/** Buffers a request body and JSON-parses it; returns `undefined` for an empty body. */
async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");

  if (body.length === 0) {
    return undefined;
  }

  return JSON.parse(body) as unknown;
}

/** True when a parsed JSON-RPC request (or any entry of a batch array) declares the given `method`. */
function isJsonRpcMethod(value: unknown, method: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => isJsonRpcMethod(entry, method));
  }

  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    value.method === method
  );
}
