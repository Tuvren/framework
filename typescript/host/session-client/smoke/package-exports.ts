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
  createSessionClient,
  isRetryableCloseCode,
  parseWsClientMessage,
  SESSION_PROTOCOL_VERSION,
  type SessionClientSocket,
  WS_CLOSE_CODE_AUTH_REJECTED,
} from "@tuvren/session-client";

describe("session-client package exports", () => {
  test("expose the client factory and wire helpers over a fake socket", () => {
    expect(SESSION_PROTOCOL_VERSION).toBe("1");
    expect(isRetryableCloseCode(WS_CLOSE_CODE_AUTH_REJECTED)).toBe(false);
    expect(parseWsClientMessage("not json").kind).toBe("unparseable");

    const sent: string[] = [];
    const fakeSocket: SessionClientSocket = {
      close(): void {
        // no-op for this smoke test
      },
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
      send(data: string): void {
        sent.push(data);
      },
    };

    const client = createSessionClient({
      capabilities: {},
      sessionId: "smoke-session-client",
      url: "wss://example.invalid/session",
      webSocketFactory: () => fakeSocket,
    });

    expect(typeof client.connect).toBe("function");
    expect(typeof client.close).toBe("function");
    expect(typeof client.approve).toBe("function");
    expect(typeof client.steer).toBe("function");
    expect(typeof client.cancel).toBe("function");

    client.connect();
    fakeSocket.onopen?.();

    expect(sent).toHaveLength(1);
    const handshake = JSON.parse(sent[0] ?? "{}");
    expect(handshake.kind).toBe("handshake");
    expect(handshake.sessionId).toBe("smoke-session-client");
    expect(handshake.protocolVersion).toBe(SESSION_PROTOCOL_VERSION);

    client.close();
  });
});
