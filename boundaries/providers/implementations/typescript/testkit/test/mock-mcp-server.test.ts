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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMockMcpStdioCommand,
  createOfficialMcpEverythingStdioCommand,
  startMockMcpHttpServer,
  startOfficialMcpEverythingStreamableHttpServer,
} from "../src/index.ts";

describe("@tuvren/provider-testkit mock MCP server", () => {
  test("serves deterministic tools over stdio", async () => {
    const command = createMockMcpStdioCommand();
    const client = createClient();
    await client.connect(new StdioClientTransport(command));

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "echo",
        "search",
      ]);
      const result = await client.callTool({
        arguments: { message: "stdio" },
        name: "echo",
      });
      expect(result.structuredContent).toEqual({ echoed: "stdio" });
    } finally {
      await client.close();
    }
  });

  test("serves deterministic tools over Streamable HTTP", async () => {
    const server = await startMockMcpHttpServer();
    const client = createClient();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.endpoint))
    );

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "echo",
        "search",
      ]);
      const result = await client.callTool({
        arguments: { message: "http" },
        name: "echo",
      });
      expect(result.structuredContent).toEqual({ echoed: "http" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("starts the official everything server over stdio", async () => {
    const command = createOfficialMcpEverythingStdioCommand();
    const client = createClient();
    await client.connect(new StdioClientTransport(command));

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("echo");
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "get-structured-content"
      );
    } finally {
      await client.close();
    }
  });

  test("starts the official everything server over Streamable HTTP", async () => {
    const server = await startOfficialMcpEverythingStreamableHttpServer();
    const client = createClient();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.endpoint))
    );

    try {
      const result = await client.callTool({
        arguments: { message: "official" },
        name: "echo",
      });
      expect(result.content).toEqual([
        { text: "Echo: official", type: "text" },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function createClient(): Client {
  return new Client({
    name: "provider-testkit-test",
    version: "0.0.0",
  });
}
