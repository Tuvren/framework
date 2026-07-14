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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional MCP client surface.

/**
 * `@tuvren/mcp-client` — a Model Context Protocol (MCP) tool source for the
 * Tuvren runtime.
 *
 * {@link createMcpToolSource} connects to an MCP server over `stdio` or
 * `http-sse` (Streamable HTTP), lists the server's tools, and exposes them as
 * Tuvren tool definitions an agent can invoke. Every tool invocation validates
 * input/output against the server's advertised JSON schemas and normalizes
 * failures into `tool_result` error outputs rather than throwing.
 *
 * MCP credentials (`McpAuth`, transport `headers`/`env`) are confined to the
 * transport edge and never reach any observable, persisted, or replayed
 * runtime surface — see this package's README ("Secret Isolation — Edge
 * Confinement", ADR-044) and the `secret-isolation` conformance check set
 * (KRT-BD004).
 *
 * @packageDocumentation
 */
export type {
  CreateMcpToolSourceOptions,
  McpAuth,
  McpToolSource,
  McpTransport,
  McpTransportConfig,
} from "./lib/mcp-tool-source.js";
export { createMcpToolSource } from "./lib/mcp-tool-source.js";
