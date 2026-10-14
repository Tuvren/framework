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

import { setTimeout as delay } from "node:timers/promises";

import { createSessionClient } from "../src/index.js";
import type { SessionClientSocket, SessionClientStatus } from "../src/index.js";
import { FakeClock } from "./session-client-clock.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const requiredRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("expected an object");
  }
  return value;
};
export const requiredString = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("expected a string");
  }
  return value;
};

export class FakeSocket implements SessionClientSocket {
  readonly url: string;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | Uint8Array }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  /**
   * Number of remaining `send()` calls that should throw instead of
   * succeeding, decremented on each throw. Lets tests simulate a socket that
   * looks live (post-handshake_ack) but dies mid-send.
   */
  sendFailures = 0;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.sendFailures > 0) {
      this.sendFailures -= 1;
      throw new Error("FakeSocket: simulated send failure");
    }
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason });
  }

  open(): void {
    this.onopen?.();
  }

  receive(message: unknown): void {
    const received = requiredRecord(message);
    if (received.kind === "frame" && isRecord(received.frame)) {
      this.onmessage?.({
        data: JSON.stringify({
          ...received,
          frame: {
            protocolVersion: "1",
            sessionId: "test-session",
            ...received.frame,
          },
        }),
      });
      return;
    }
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code: number, reason?: string): void {
    this.onclose?.({ code, reason });
  }

  lastSent(): Record<string, unknown> {
    const value = this.sent.at(-1);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("FakeSocket: no message sent yet");
    }
    return requiredRecord(value);
  }

  /** Unwraps the last sent message's `{kind:"frame", frame}` carriage envelope. */
  lastFrame(): Record<string, unknown> {
    const envelope = this.lastSent();
    if (envelope.kind !== "frame") {
      throw new Error(
        `FakeSocket: last sent message is not a frame envelope (kind: ${String(envelope.kind)})`
      );
    }
    return requiredRecord(envelope.frame);
  }
}

export const makeClient = (
  overrides: Partial<Parameters<typeof createSessionClient>[0]> = {}
) => {
  const sockets: FakeSocket[] = [];
  const clock = new FakeClock();
  const statuses: SessionClientStatus[] = [];
  const events: { event: unknown; cursor?: string }[] = [];
  const rejections: unknown[] = [];

  const client = createSessionClient({
    capabilities: {},
    clock,
    onEvent: (event, cursor) => {
      events.push({ cursor, event });
    },
    onRejection: (rejection) => {
      rejections.push(rejection);
    },
    onStatusChange: (status) => {
      statuses.push(status);
    },
    sessionId: "test-session",
    url: "wss://example.invalid/session",
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });

  return { client, clock, events, rejections, sockets, statuses };
};

/** Flushes the microtask queue (and any already-settled macrotask) so a chained async handler's settle() has run. */
export const flush = async (): Promise<void> => {
  await delay(0);
};

export const ack = (
  socket: FakeSocket,
  resumeStatus = "none",
  sessionId = "test-session"
): void => {
  socket.receive({
    kind: "handshake_ack",
    protocolVersion: "1",
    resumeStatus,
    sessionId,
  });
};
