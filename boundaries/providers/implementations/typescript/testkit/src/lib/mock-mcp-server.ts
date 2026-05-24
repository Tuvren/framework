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

export interface MockMcpServerOptions {
  failToolCallsWithTransportClose?: boolean;
  requireHeaders?: Record<string, string>;
  returnInvalidEchoOutput?: boolean;
}

export interface RunningMockMcpHttpServer {
  close(): Promise<void>;
  endpoint: string;
}

export interface RunningOfficialMcpEverythingServer {
  close(): Promise<void>;
  endpoint: string;
}

const ECHO_INPUT_SCHEMA = {
  message: z.string(),
};

const ECHO_OUTPUT_SCHEMA = {
  echoed: z.string(),
};

const SEARCH_INPUT_SCHEMA = {
  query: z.string(),
};

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

export function createOfficialMcpEverythingStdioCommand(): {
  args: string[];
  command: string;
} {
  return {
    args: [resolveMcpEverythingBin(), "stdio"],
    command: process.execPath,
  };
}

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

export async function serveMockMcpStdio(
  options: MockMcpServerOptions = {}
): Promise<void> {
  const server = createMockMcpServer(options);
  await server.connect(new StdioServerTransport());
}

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
