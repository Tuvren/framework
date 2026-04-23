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
import {
  type ApprovalRequest,
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertTuvrenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isTuvrenToolDefinition,
  type TuvrenToolDefinition,
} from "../src/index.ts";

describe("tool-contracts", () => {
  test("re-exports tool and approval contracts from the shared runtime anchor", () => {
    const approvalRequest = {
      completedResults: [
        {
          callId: "call-1",
          name: "search",
          output: { hits: 1 },
          type: "tool_result",
        },
      ],
      toolCalls: [
        {
          callId: "call-2",
          decisions: ["approve", "edit", "reject"],
          input: { query: "latest status" },
          message: "Approve the outbound search?",
          name: "search",
        },
      ],
    } satisfies ApprovalRequest;
    const toolDefinition = {
      description: "Search documentation",
      execute() {
        return { hits: 1 };
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    } satisfies TuvrenToolDefinition;

    expect(isApprovalRequest(approvalRequest)).toBe(true);
    expect(
      isApprovalResponse({ decisions: [{ callId: "call-1", type: "approve" }] })
    ).toBe(true);
    expect(isTuvrenToolDefinition(toolDefinition)).toBe(true);
    expect(() => assertApprovalRequest(approvalRequest)).not.toThrow();
    expect(() =>
      assertApprovalResponse({
        decisions: [{ callId: "call-1", type: "approve" }],
      })
    ).not.toThrow();
    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call-2", type: "approve" }] },
        approvalRequest
      )
    ).toBe(true);
    expect(() =>
      assertApprovalResponseForRequest(
        { decisions: [{ callId: "call-2", type: "approve" }] },
        approvalRequest
      )
    ).not.toThrow();
    expect(() => assertTuvrenToolDefinition(toolDefinition)).not.toThrow();
  });
});
