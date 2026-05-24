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
import type { McpToolSource } from "@tuvren/mcp-client";
import { createMcpToolSource } from "@tuvren/mcp-client";

describe("@tuvren/mcp-client package exports", () => {
  test("exports the public MCP tool-source helper without zod", () => {
    const source: McpToolSource | undefined = undefined;
    expect(source).toBeUndefined();
    expect(typeof createMcpToolSource).toBe("function");
  });
});
