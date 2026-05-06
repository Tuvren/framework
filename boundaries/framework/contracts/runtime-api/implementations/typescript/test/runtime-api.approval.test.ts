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
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isTuvrenMessage,
  isTuvrenStreamEvent,
} from "../src/index.ts";
import { frameworkContractFixtures } from "./runtime-api-fixtures.js";

describe("runtime-api approval contracts", () => {
  test("rejects approval requests with incomplete tool results", () => {
    expect(
      isApprovalRequest({
        completedResults: [
          { callId: "call-1", name: "search", type: "tool_result" },
        ],
        toolCalls: [],
      })
    ).toBe(false);
  });

  test("rejects approval requests with undeclared top-level fields", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        extra: 1,
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests and tool-result messages with undeclared fields", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            extra: 1,
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            extra: 1,
            name: "search",
            output: { hits: 1 },
            type: "tool_result",
          },
        ],
        role: "tool",
      })
    ).toBe(false);
  });

  test("rejects approval requests with incomplete pending tool calls", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-2",
            decisions: ["approve"],
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with duplicate callIds across pending and completed work", () => {
    expect(
      isApprovalRequest({
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
            callId: "call-1",
            decisions: ["approve"],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with empty decision lists", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: [],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with blank decision labels", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["   "],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with duplicate decision labels", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve", "approve"],
            input: { query: "status" },
            message: "Approve?",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("returns false instead of throwing for hostile accessor payloads", () => {
    const hostileProviderMetadata = {
      get foo() {
        throw new Error("boom");
      },
    };

    expect(() =>
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: hostileProviderMetadata,
            text: "hello",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).not.toThrow();

    expect(
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: hostileProviderMetadata,
            text: "hello",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects approval resolved events with edit decisions missing edited input", () => {
    expect(
      isTuvrenStreamEvent({
        response: {
          decisions: [{ callId: "call-1", type: "edit" }],
        },
        timestamp: 1,
        type: "approval.resolved",
      })
    ).toBe(false);
  });

  test("accepts approval responses whose reject or custom decisions omit message", () => {
    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", type: "reject" }],
      })
    ).toBe(true);

    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", type: "needs_human" }],
      })
    ).toBe(true);
  });

  test("validates approval responses against the active approval request when context is available", () => {
    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call_2", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toBe(true);

    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "missing-call", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toBe(false);

    expect(() =>
      assertApprovalResponseForRequest(
        { decisions: [{ callId: "missing-call", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toThrow();
  });

  test("rejects request-aware approval responses that use disallowed decisions or omit pending calls", () => {
    const multiCallApprovalRequest = {
      completedResults: [],
      toolCalls: [
        {
          callId: "call-1",
          decisions: ["approve", "reject"],
          input: { query: "status" },
          message: "Decide the search",
          name: "search",
        },
        {
          callId: "call-2",
          decisions: ["approve"],
          input: { target: "ops" },
          message: "Decide the notify call",
          name: "notify",
        },
      ],
    };

    expect(
      isApprovalResponseForRequest(
        {
          decisions: [
            {
              callId: "call-1",
              editedInput: { query: "updated status" },
              type: "edit",
            },
            { callId: "call-2", type: "approve" },
          ],
        },
        multiCallApprovalRequest
      )
    ).toBe(false);

    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call-1", type: "approve" }] },
        multiCallApprovalRequest
      )
    ).toBe(false);
  });

  test("rejects approval responses with undeclared decision fields", () => {
    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", extra: 1, type: "approve" }],
      })
    ).toBe(false);
  });

  test("accepts approval response messages as optional annotations", () => {
    expect(
      isApprovalResponse({
        decisions: [
          { callId: "call-1", message: "Proceed with care.", type: "approve" },
        ],
      })
    ).toBe(true);

    expect(
      isApprovalResponse({
        decisions: [
          {
            callId: "call-1",
            message: "Please revise and continue.",
            type: "edit",
            editedInput: { query: "updated status" },
          },
        ],
      })
    ).toBe(true);

    expect(
      isApprovalResponse({
        decisions: [{ callId: "call-1", message: "", type: "reject" }],
      })
    ).toBe(false);

    expect(
      isApprovalResponse({
        decisions: [
          {
            callId: "call-1",
            editedInput: { query: "updated" },
            type: "approve",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval responses with no decisions", () => {
    expect(
      isApprovalResponse({
        decisions: [],
      })
    ).toBe(false);
  });

  test("rejects approval responses with duplicate decision callIds", () => {
    expect(
      isApprovalResponse({
        decisions: [
          { callId: "call-1", type: "approve" },
          { callId: "call-1", type: "reject" },
        ],
      })
    ).toBe(false);

    expect(() =>
      assertApprovalResponse({
        decisions: [
          { callId: "call-1", type: "approve" },
          { callId: "call-1", type: "reject" },
        ],
      })
    ).toThrow();
  });

  test("rejects empty approval and tool identifiers", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "",
            decisions: [""],
            input: {},
            message: "",
            name: "",
          },
        ],
      })
    ).toBe(false);

    expect(
      isApprovalResponse({
        decisions: [{ callId: "", type: "", message: "x" }],
      })
    ).toBe(false);
  });

  test("rejects approval requests with empty review message text", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve"],
            input: {},
            message: "",
            name: "search",
          },
        ],
      })
    ).toBe(false);
  });

  test("rejects approval requests with no pending tool calls", () => {
    expect(
      isApprovalRequest({
        completedResults: [],
        toolCalls: [],
      })
    ).toBe(false);
  });
});
