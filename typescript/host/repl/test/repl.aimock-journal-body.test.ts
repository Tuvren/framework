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
import type { JournalBody } from "@copilotkit/aimock";
import { isChatCompletionBody, LLMock } from "@copilotkit/aimock";
import {
  assertStructuredResponseFormat,
  hasApprovalToolContinuation,
  hasSearchToolContinuation,
} from "./repl-test-helpers.ts";

/**
 * Journal bodies that are not chat-completion requests. `JournalBody` is
 * `ChatCompletionRequest | Record<string, unknown>`, and aimock's own guard
 * discriminates on `messages` + `model`, so these are the shapes the host-repl
 * helpers must reject explicitly instead of reading a chat-only field off them.
 */
const NON_CHAT_JOURNAL_BODIES: readonly (JournalBody | null | undefined)[] = [
  null,
  undefined,
  { model: "gpt-4o-mini" },
  { messages: "Run tools", model: "gpt-4o-mini" },
  { model: "gpt-4o-mini-2024-07-18", training_file: "file-abc123" },
  {
    __aimock_truncated: true,
    note: "body truncated by aimock journal cap (64 KB limit)",
    originalByteSize: 70_000,
  },
];

const CHAT_COMPLETION_BODY: JournalBody = {
  messages: [
    {
      content: "Run streaming",
      role: "user",
    },
  ],
  model: "gpt-4o-mini",
};

const SEARCH_CONTINUATION_BODY: JournalBody = {
  messages: [
    {
      role: "assistant",
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify({ query: "docs" }),
            name: "search",
          },
          id: "aimock-call-search",
          type: "function",
        },
      ],
    },
    {
      content: JSON.stringify({
        hits: [{ title: "Tuvren", url: "https://example.invalid/tuvren" }],
        query: "docs",
      }),
      role: "tool",
      tool_call_id: "aimock-call-search",
    },
  ],
  model: "gpt-4o-mini",
};

const APPROVAL_CONTINUATION_BODY: JournalBody = {
  messages: [
    {
      role: "assistant",
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify({ query: "latest status" }),
            name: "search",
          },
          id: "aimock-call-search",
          type: "function",
        },
        {
          function: {
            arguments: JSON.stringify({
              subject: "Status update",
              to: "ops@example.com",
            }),
            name: "email",
          },
          id: "aimock-call-email",
          type: "function",
        },
      ],
    },
    {
      content: JSON.stringify({
        hits: [{ title: "Tuvren", url: "https://example.invalid/tuvren" }],
        query: "latest status",
      }),
      role: "tool",
      tool_call_id: "aimock-call-search",
    },
    {
      content: JSON.stringify({
        approval: {
          editedInput: {
            subject: "Edited status update",
            to: "ops@example.com",
          },
          originalInput: {
            subject: "Status update",
            to: "ops@example.com",
          },
          type: "edit",
        },
        result: { sent: true, to: "ops@example.com" },
      }),
      role: "tool",
      tool_call_id: "aimock-call-email",
    },
  ],
  model: "gpt-4o-mini",
};

const STRUCTURED_CHAT_BODY: JournalBody = {
  messages: [
    {
      content: "Run structured",
      role: "user",
    },
  ],
  model: "gpt-4o-mini",
  response_format: {
    json_schema: {
      name: "repl_summary",
      schema: {
        properties: {
          scenario: { type: "string" },
          status: { type: "string" },
        },
        required: ["scenario", "status"],
        type: "object",
      },
    },
    type: "json_schema",
  },
};

describe("repl aimock journal body narrowing", () => {
  test("isChatCompletionBody rejects every non-chat journal shape", () => {
    for (const body of NON_CHAT_JOURNAL_BODIES) {
      expect(isChatCompletionBody(body)).toBe(false);
    }

    expect(isChatCompletionBody(CHAT_COMPLETION_BODY)).toBe(true);
    expect(isChatCompletionBody(SEARCH_CONTINUATION_BODY)).toBe(true);
    expect(isChatCompletionBody(APPROVAL_CONTINUATION_BODY)).toBe(true);
    expect(isChatCompletionBody(STRUCTURED_CHAT_BODY)).toBe(true);
  });

  test("continuation helpers reject non-chat journal bodies explicitly", () => {
    for (const body of NON_CHAT_JOURNAL_BODIES) {
      expect(hasSearchToolContinuation(body)).toBe(false);
      expect(hasApprovalToolContinuation(body)).toBe(false);
    }
  });

  test("continuation helpers still recognize real chat continuation bodies", () => {
    expect(hasSearchToolContinuation(SEARCH_CONTINUATION_BODY)).toBe(true);
    expect(hasApprovalToolContinuation(APPROVAL_CONTINUATION_BODY)).toBe(true);
    expect(hasSearchToolContinuation(APPROVAL_CONTINUATION_BODY)).toBe(false);
    expect(hasApprovalToolContinuation(SEARCH_CONTINUATION_BODY)).toBe(false);
  });

  test("assertStructuredResponseFormat rejects non-chat bodies and validates json_schema", () => {
    for (const body of NON_CHAT_JOURNAL_BODIES) {
      expect(() => assertStructuredResponseFormat(body)).toThrow(
        "structured response_format requires a chat completion request body"
      );
    }

    expect(() => assertStructuredResponseFormat(CHAT_COMPLETION_BODY)).toThrow(
      "structured response_format was not an object"
    );

    assertStructuredResponseFormat(STRUCTURED_CHAT_BODY);
  });

  test("rejects a non-chat body the aimock journal actually recorded", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });

    await mock.start();

    try {
      const sentBody = {
        model: "gpt-4o-mini-2024-07-18",
        training_file: "file-abc123",
      };
      const response = await fetch(`${mock.url}/v1/fine_tuning/jobs`, {
        body: JSON.stringify(sentBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const journalEntry = mock.getLastRequest();

      expect(response.status).toBe(200);
      expect(journalEntry).not.toBeNull();

      if (journalEntry === null) {
        throw new Error(
          "aimock journal did not record the fine_tuning/jobs request"
        );
      }

      expect(journalEntry.path).toBe("/v1/fine_tuning/jobs");
      expect(journalEntry.method).toBe("POST");
      expect(journalEntry.body).toBeDefined();
      expect(journalEntry.body).not.toBeNull();

      // The runtime surfaces the recorded body as a nullable/possibly-absent
      // value, so prove it is really there instead of coalescing it to null
      // (which would let the rejection assertions below pass vacuously).
      const journalBody: JournalBody | null | undefined = journalEntry.body;

      if (journalBody === undefined || journalBody === null) {
        throw new Error(
          "aimock journal recorded no body for the fine_tuning/jobs request"
        );
      }

      // Explicit narrowing through the exported guard: the recorded body must
      // not be a chat completion request, and must carry the fine-tuning
      // payload the test actually sent.
      if (isChatCompletionBody(journalBody)) {
        throw new Error(
          "aimock journal recorded a chat completion body for the fine_tuning/jobs request"
        );
      }

      expect(journalBody.model).toBe(sentBody.model);
      expect(journalBody.training_file).toBe(sentBody.training_file);
      expect(isChatCompletionBody(journalBody)).toBe(false);
      expect(hasSearchToolContinuation(journalBody)).toBe(false);
      expect(hasApprovalToolContinuation(journalBody)).toBe(false);
    } finally {
      await mock.stop();
    }
  });

  test("rejects the journal-cap truncation marker aimock substitutes for an oversized body", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });

    await mock.start();

    try {
      const sentBody = JSON.stringify({
        messages: [{ content: "x".repeat(70_000), role: "user" }],
        model: "gpt-4o-mini",
      });
      const sentBodyByteSize = Buffer.byteLength(sentBody, "utf8");
      const response = await fetch(`${mock.url}/v1/chat/completions`, {
        body: sentBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const journalEntry = mock.getLastRequest();

      expect(response.status).toBe(404);
      expect(journalEntry).not.toBeNull();
      expect(sentBodyByteSize).toBeGreaterThan(64 * 1024);

      if (journalEntry === null) {
        throw new Error(
          "aimock journal did not record the oversized chat completions request"
        );
      }

      expect(journalEntry.path).toBe("/v1/chat/completions");
      expect(journalEntry.method).toBe("POST");
      expect(journalEntry.body).toBeDefined();
      expect(journalEntry.body).not.toBeNull();

      // The runtime surfaces the recorded body as a nullable/possibly-absent
      // value, so prove it is really there instead of coalescing it to null
      // (which would let the rejection assertions below pass vacuously).
      const journalBody: JournalBody | null | undefined = journalEntry.body;

      if (journalBody === undefined || journalBody === null) {
        throw new Error(
          "aimock journal recorded no body for the oversized chat completions request"
        );
      }

      // Explicit narrowing through the exported guard: the body the journal
      // retained is the substituted cap marker, not the oversized chat
      // request it replaced.
      if (isChatCompletionBody(journalBody)) {
        throw new Error(
          "aimock journal retained the oversized chat body instead of the truncation marker"
        );
      }

      expect(journalBody.__aimock_truncated).toBe(true);
      expect(journalBody.note).toBe(
        "body truncated by aimock journal cap (64 KB limit)"
      );

      const originalByteSize = journalBody.originalByteSize;

      expect(typeof originalByteSize).toBe("number");

      if (typeof originalByteSize !== "number") {
        throw new Error(
          "aimock truncation marker carried a non-numeric originalByteSize"
        );
      }

      expect(originalByteSize).toBeGreaterThan(64 * 1024);
      // aimock caps the re-serialized parsed body, so the recorded size is the
      // sent payload's byte length plus the library's small internal match
      // markers (it sets `_endpointType` before journalling). Assert the sent
      // byte length as a floor and a tight ceiling instead of equality: the
      // marker's size is attributable to this exact oversized body.
      expect(originalByteSize).toBeGreaterThanOrEqual(sentBodyByteSize);
      expect(originalByteSize).toBeLessThan(sentBodyByteSize + 1024);

      expect(isChatCompletionBody(journalBody)).toBe(false);
      expect(hasSearchToolContinuation(journalBody)).toBe(false);
      expect(hasApprovalToolContinuation(journalBody)).toBe(false);
    } finally {
      await mock.stop();
    }
  });
});
