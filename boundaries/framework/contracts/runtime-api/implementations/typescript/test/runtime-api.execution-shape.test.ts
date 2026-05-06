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
  isApprovalResponse,
  isProviderStreamChunk,
  isTuvrenMessage,
  isTuvrenStreamEvent,
} from "../src/index.ts";

describe("runtime-api execution shape contracts", () => {
  test("rejects stream events that omit required fields", () => {
    expect(isTuvrenStreamEvent({ type: "turn.end", timestamp: 1 })).toBe(false);
  });

  test("rejects stream events with empty tool names", () => {
    expect(
      isTuvrenStreamEvent({
        callId: "call-1",
        input: {},
        name: "",
        timestamp: 1,
        type: "tool.start",
      })
    ).toBe(false);
  });

  test("rejects stream events with mixed-variant payload fields", () => {
    expect(
      isTuvrenStreamEvent({
        callId: "call-1",
        input: {},
        messageId: "message-1",
        name: "search",
        text: "ok",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);
  });

  test("rejects file parts with empty media types", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            data: "YWJj",
            mediaType: "",
            type: "file",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects stream events with empty lifecycle identifiers", () => {
    expect(
      isTuvrenStreamEvent({
        text: "ok",
        messageId: "",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        resumedFrom: "1".repeat(64),
        threadId: "",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.start",
      })
    ).toBe(false);
  });

  test("rejects stream events with invalid hash references", () => {
    expect(
      isTuvrenStreamEvent({
        resumedFrom: "not-a-hash",
        threadId: "thread-1",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.start",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        iterationCount: 1,
        timestamp: 1,
        turnNodeHash: "not-a-hash",
        type: "state.checkpoint",
      })
    ).toBe(false);
  });

  test("rejects negative iteration counters in stream events", () => {
    expect(
      isTuvrenStreamEvent({
        iterationCount: -1,
        timestamp: 1,
        type: "iteration.start",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        iterationCount: -1,
        timestamp: 1,
        turnNodeHash: "1".repeat(64),
        type: "state.checkpoint",
      })
    ).toBe(false);
  });

  test("rejects non-canonical epoch timestamps in stream events", () => {
    expect(
      isTuvrenStreamEvent({
        status: "completed",
        timestamp: -0,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);
  });

  test("rejects assistant messages with incomplete content parts", () => {
    expect(
      isTuvrenMessage({
        parts: [{ type: "text" }],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects messages with undeclared top-level fields", () => {
    expect(
      isTuvrenMessage({
        extra: 1,
        parts: [{ text: "hi", type: "text" }],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects assistant messages with malformed provider metadata", () => {
    expect(
      isTuvrenMessage({
        parts: [],
        providerMetadata: 7,
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects empty durable messages across roles", () => {
    expect(
      isTuvrenMessage({
        content: "",
        role: "system",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [],
        role: "user",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [],
        role: "tool",
      })
    ).toBe(false);
  });

  test("rejects content parts with non-serializable payloads", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            input: {
              fn() {
                return 1;
              },
            },
            name: "search",
            type: "tool_call",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            data: {
              nested: {
                fn() {
                  return 1;
                },
              },
            },
            type: "structured",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: {
              nested: {
                fn() {
                  return 1;
                },
              },
            },
            text: "hi",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects content parts with mixed-variant fields", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            input: {},
            name: "search",
            text: "hi",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);

    expect(
      isTuvrenMessage({
        parts: [
          {
            callId: "call-1",
            data: { ok: true },
            type: "structured",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects empty non-redacted reasoning parts", () => {
    expect(
      isTuvrenMessage({
        parts: [
          {
            redacted: false,
            text: "",
            type: "reasoning",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects stream payloads with non-serializable structured data", () => {
    expect(
      isProviderStreamChunk({
        data: {
          fn() {
            return 1;
          },
        },
        type: "structured_done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        data: {
          fn() {
            return 1;
          },
        },
        messageId: "message-1",
        timestamp: 1,
        type: "structured.done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        callId: "call-1",
        input: {
          fn() {
            return 1;
          },
        },
        name: "search",
        timestamp: 1,
        type: "tool_call.done",
      })
    ).toBe(false);
  });

  test("rejects event sources with a non-string workerId", () => {
    expect(
      isTuvrenStreamEvent({
        source: { agent: "primary", workerId: 7 },
        status: "completed",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);
  });

  test("rejects event sources and error payloads with undeclared fields", () => {
    expect(
      isTuvrenStreamEvent({
        source: { agent: "primary", extra: 1 },
        status: "completed",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        error: {
          extra: 1,
          message: "boom",
        },
        fatal: true,
        timestamp: 1,
        type: "error",
      })
    ).toBe(false);
  });

  test("rejects blank correlation identifiers", () => {
    expect(
      isApprovalResponse({
        decisions: [{ callId: "   ", type: "approve" }],
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        messageId: "   ",
        text: "ok",
        timestamp: 1,
        type: "text.done",
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        source: { agent: "" },
        status: "completed",
        timestamp: 1,
        turnId: "turn-1",
        type: "turn.end",
      })
    ).toBe(false);
  });

  test("rejects serializable-boundary objects with hidden or symbol-backed state", () => {
    const symbolBackedMetadata = {
      visible: 1,
      [Symbol("hidden")]: 2,
    };

    expect(
      isTuvrenMessage({
        parts: [
          {
            providerMetadata: symbolBackedMetadata,
            text: "hello",
            type: "text",
          },
        ],
        role: "assistant",
      })
    ).toBe(false);
  });

  test("rejects error events with non-serializable details", () => {
    expect(
      isTuvrenStreamEvent({
        error: {
          details: {
            fn() {
              return 1;
            },
          },
          message: "boom",
        },
        fatal: true,
        timestamp: 1,
        type: "error",
      })
    ).toBe(false);
  });
});
