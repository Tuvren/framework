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
  createWsSessionTransport,
  parseWsMessage,
  WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED,
  WS_CLOSE_CODE_HANDSHAKE_INVALID,
} from "@tuvren/stream-ws";

describe("stream-ws package exports", () => {
  test("export the close-code vocabulary", () => {
    expect(WS_CLOSE_CODE_HANDSHAKE_INVALID).toBe(4000);
    expect(WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED).toBe(4005);
  });

  test("parseWsMessage resolves and parses a ping message", () => {
    const parsed = parseWsMessage(JSON.stringify({ kind: "ping" }));
    expect(parsed).toEqual({ kind: "ping" });
  });

  test("createWsSessionTransport resolves and does something minimal end-to-end", () => {
    const sent: string[] = [];
    const closes: Array<{ code: number; reason: string | undefined }> = [];

    async function* emptyOutbound() {
      // No frames; the pump observes completion once start() drains it.
    }

    const transport = createWsSessionTransport({
      binding: {
        clientEndpoint: {
          advertisedCapabilities: [],
          dispatch: () => Promise.reject(new Error("unused in smoke test")),
          endpointId: "smoke-endpoint",
        },
        currentHandle: () => {
          throw new Error("unused in smoke test");
        },
        dispatchInbound: () => undefined,
        outbound: () => emptyOutbound(),
        sessionId: "smoke-session",
      },
      sink: {
        close: (code, reason) => closes.push({ code, reason }),
        send: (data) => sent.push(data),
      },
    });

    transport.start();
    transport.ingest(
      JSON.stringify({ kind: "handshake", protocolVersion: "1" })
    );

    expect(typeof transport.close).toBe("function");
  });
});
