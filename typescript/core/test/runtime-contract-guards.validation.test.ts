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

// Ported from the retired @tuvren/runtime-api shim (epic 87, M9.2). The shim
// re-exported this vocabulary from @tuvren/core/{provider,messages,events}
// without adding behavior; only the import sources changed below.

import { describe, expect, test } from "bun:test";
import { isTuvrenStreamEvent } from "@tuvren/core/events";
import { isTuvrenMessage } from "@tuvren/core/messages";
import { isProviderStreamChunk } from "@tuvren/core/provider";

describe("runtime-contract-guards validation contracts", () => {
  test("rejects provider chunks with mixed-variant payload fields", () => {
    expect(
      isProviderStreamChunk({
        providerCallId: "provider-call-1",
        text: "ok",
        type: "text_delta",
      })
    ).toBe(false);
  });

  test("rejects provider usage payloads with undeclared fields", () => {
    expect(
      isProviderStreamChunk({
        finishReason: "stop",
        type: "finish",
        usage: {
          extra: 3,
          inputTokens: 1,
          outputTokens: 2,
        },
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        finishReason: "stop",
        messageId: "message-1",
        timestamp: 1,
        type: "message.done",
        usage: {
          extra: 3,
          inputTokens: 1,
          outputTokens: 2,
        },
      })
    ).toBe(false);
  });

  test("rejects mixed-shape discriminated messages", () => {
    expect(
      isTuvrenMessage({
        content: "system",
        parts: [],
        role: "system",
      })
    ).toBe(false);
  });

  test("rejects provider usage with negative token counts", () => {
    expect(
      isProviderStreamChunk({
        finishReason: "stop",
        type: "finish",
        usage: {
          inputTokens: -1,
          outputTokens: 0,
        },
      })
    ).toBe(false);

    expect(
      isTuvrenStreamEvent({
        finishReason: "stop",
        messageId: "message-1",
        timestamp: 1,
        type: "message.done",
        usage: {
          inputTokens: 1,
          outputTokens: -1,
        },
      })
    ).toBe(false);
  });
});
