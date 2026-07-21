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
  type SessionClientClock,
  type SessionClientSocket,
  type SessionClientStatus,
} from "../src/index.js";

const NO_SUCH_CAPABILITY_PATTERN = /no\.such\.capability/;

class FakeSocket implements SessionClientSocket {
  readonly url: string;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | Uint8Array }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
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
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code: number, reason?: string): void {
    this.onclose?.({ code, reason });
  }

  lastSent(): Record<string, unknown> {
    const value = this.sent.at(-1);
    if (typeof value !== "object" || value === null) {
      throw new Error("FakeSocket: no message sent yet");
    }
    return value as Record<string, unknown>;
  }

  /** Unwraps the last sent message's `{kind:"frame", frame}` carriage envelope. */
  lastFrame(): Record<string, unknown> {
    const envelope = this.lastSent();
    if (envelope.kind !== "frame") {
      throw new Error(
        `FakeSocket: last sent message is not a frame envelope (kind: ${String(envelope.kind)})`
      );
    }
    return envelope.frame as Record<string, unknown>;
  }
}

class FakeClock implements SessionClientClock {
  private nextHandle = 1;
  private readonly pending = new Map<
    number,
    { callback: () => void; ms: number }
  >();

  scheduleTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.pending.set(handle, { callback, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fires every currently-pending timer whose delay is `<= ms`, in insertion order. */
  advance(ms: number): void {
    const due = [...this.pending.entries()]
      .filter(([, entry]) => entry.ms <= ms)
      .sort((a, b) => a[0] - b[0]);
    for (const [handle, entry] of due) {
      this.pending.delete(handle);
      entry.callback();
    }
  }

  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }
}

function makeClient(
  overrides: Partial<Parameters<typeof createSessionClient>[0]> = {}
) {
  const sockets: FakeSocket[] = [];
  const clock = new FakeClock();
  const statuses: SessionClientStatus[] = [];
  const events: Array<{ event: unknown; cursor?: string }> = [];
  const rejections: unknown[] = [];

  const client = createSessionClient({
    capabilities: {},
    clock,
    onEvent: (event, cursor) => events.push({ event, cursor }),
    onRejection: (rejection) => rejections.push(rejection),
    onStatusChange: (status) => statuses.push(status),
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
}

/** Flushes the microtask queue (and any already-settled macrotask) so a chained async handler's settle() has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ack(
  socket: FakeSocket,
  resumeStatus = "none",
  sessionId = "test-session"
): void {
  socket.receive({
    kind: "handshake_ack",
    protocolVersion: "1",
    resumeStatus,
    sessionId,
  });
}

describe("createSessionClient: handshake and events", () => {
  test("sends handshake on open with no cursor on first connect", () => {
    const { client, sockets } = makeClient();
    client.connect();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0] as FakeSocket;

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const handshake = socket.lastSent();
    expect(handshake.kind).toBe("handshake");
    expect(handshake.sessionId).toBe("test-session");
    expect(handshake.protocolVersion).toBe("1");
    expect("cursor" in handshake).toBe(false);
  });

  test("delivers events to onEvent after handshake ack and tracks cursor", () => {
    const { client, events, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.receive({
      cursor: "cursor-1",
      frame: {
        event: { type: "turn.start" },
        kind: "event",
        sessionId: "test-session",
      },
      kind: "frame",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual({ type: "turn.start" });
    expect(events[0]?.cursor).toBe("cursor-1");
  });
});

describe("createSessionClient: capability dispatch", () => {
  test("runs the matching handler and echoes leaseToken verbatim", async () => {
    const { client, sockets } = makeClient({
      capabilities: {
        "echo.tool": async (input) => ({ echoed: input }),
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.receive({
      frame: {
        invocation: {
          callId: "call-1",
          capabilityId: "echo.tool",
          input: { value: 42 },
          leaseToken: "lease-abc",
        },
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });

    // Let the microtask queue for the async handler drain.
    await flush();

    const resultFrame = socket.lastFrame();
    expect(resultFrame.kind).toBe("client_result");
    const result = resultFrame.result as Record<string, unknown>;
    expect(result.callId).toBe("call-1");
    expect(result.leaseToken).toBe("lease-abc");
    expect(result.content).toEqual({ echoed: { value: 42 } });
    expect(result.isError).toBeUndefined();
  });

  test("handler throw produces an isError client_result without dangling", async () => {
    const { client, sockets } = makeClient({
      capabilities: {
        "failing.tool": () => {
          throw new Error("boom");
        },
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.receive({
      frame: {
        invocation: {
          callId: "call-2",
          capabilityId: "failing.tool",
          input: {},
          leaseToken: "lease-2",
        },
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });

    await flush();

    const resultFrame = socket.lastFrame();
    const result = resultFrame.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("boom");
    expect(result.leaseToken).toBe("lease-2");
  });

  test("unknown capabilityId yields a well-shaped isError result", async () => {
    const { client, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.receive({
      frame: {
        invocation: {
          callId: "call-3",
          capabilityId: "no.such.capability",
          input: {},
          leaseToken: "lease-3",
        },
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });

    await Promise.resolve();

    const resultFrame = socket.lastFrame();
    const result = resultFrame.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toMatch(
      NO_SUCH_CAPABILITY_PATTERN
    );
  });
});

describe("createSessionClient: redelivery dedup", () => {
  test("already-answered redelivery re-sends the recorded result without re-running the handler", async () => {
    let runs = 0;
    const { client, sockets } = makeClient({
      capabilities: {
        "counted.tool": () => {
          runs += 1;
          return { runs };
        },
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    const invocation = {
      callId: "call-redeliver",
      capabilityId: "counted.tool",
      input: {},
      leaseToken: "lease-redeliver",
    };

    socket.receive({
      frame: {
        invocation,
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await flush();

    expect(runs).toBe(1);
    const firstResult = socket.lastFrame().result as Record<string, unknown>;
    expect(firstResult.content).toEqual({ runs: 1 });

    // Server redelivers the same callId after a reconnect because it never
    // received the first client_result.
    socket.receive({
      frame: {
        invocation,
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await Promise.resolve();

    expect(runs).toBe(1);
    const secondResult = socket.lastFrame().result as Record<string, unknown>;
    expect(secondResult.content).toEqual({ runs: 1 });
  });

  test("still-in-flight redelivery is ignored; the running handler answers once", async () => {
    let resolveHandler: ((value: { done: true }) => void) | undefined;
    let runs = 0;
    const { client, sockets } = makeClient({
      capabilities: {
        "slow.tool": () => {
          runs += 1;
          return new Promise((resolve) => {
            resolveHandler = resolve;
          });
        },
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    const invocation = {
      callId: "call-inflight",
      capabilityId: "slow.tool",
      input: {},
      leaseToken: "lease-inflight",
    };

    socket.receive({
      frame: {
        invocation,
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(socket.sent).toHaveLength(1); // only the handshake so far

    // Redelivered while still in-flight: must not start a second run.
    socket.receive({
      frame: {
        invocation,
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(socket.sent).toHaveLength(1);

    resolveHandler?.({ done: true });
    await flush();

    expect(socket.sent).toHaveLength(2);
    const result = socket.lastFrame().result as Record<string, unknown>;
    expect(result.content).toEqual({ done: true });
  });
});

describe("createSessionClient: reconnect and backoff", () => {
  test("reconnects after a retryable close with the last-seen cursor and exponential backoff", () => {
    const { client, clock, sockets, statuses } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const first = sockets[0] as FakeSocket;
    first.open();
    ack(first);

    first.receive({
      cursor: "cursor-x",
      frame: { event: { type: "x" }, kind: "event", sessionId: "test-session" },
      kind: "frame",
    });

    // Retryable close (heartbeat timeout).
    first.serverClose(4004, "heartbeat timeout");
    expect(clock.delays()).toEqual([100]);

    clock.advance(100);
    expect(sockets).toHaveLength(2);
    const second = sockets[1] as FakeSocket;
    second.open();
    const handshake = second.lastSent();
    expect(handshake.cursor).toBe("cursor-x");

    // Second retryable close backs off further.
    second.serverClose(4005, "backpressure exceeded");
    expect(clock.delays()).toEqual([200]);

    const reconnectingStatuses = statuses.filter(
      (status) => status.phase === "reconnecting"
    );
    expect(reconnectingStatuses).toHaveLength(2);
    expect(reconnectingStatuses[0]).toMatchObject({ attempt: 1, delayMs: 100 });
    expect(reconnectingStatuses[1]).toMatchObject({ attempt: 2, delayMs: 200 });
  });

  test("a non-retryable close (auth rejected) does not reconnect and surfaces a terminal status", () => {
    const { client, clock, sockets, statuses } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();

    socket.serverClose(4003, "auth rejected");

    expect(clock.delays()).toEqual([]);
    expect(sockets).toHaveLength(1);
    const terminal = statuses.at(-1);
    expect(terminal).toMatchObject({
      code: 4003,
      phase: "closed",
      terminal: true,
    });
  });
});

describe("createSessionClient: heartbeat", () => {
  test("answers an inbound ping with pong", () => {
    const { client, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.receive({ kind: "ping" });

    const pong = socket.lastSent();
    expect(pong.kind).toBe("pong");
  });
});

describe("createSessionClient: inbound frame shapes", () => {
  test("approve/steer/cancel send correctly-shaped inbound frames", () => {
    const { client, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    client.approve({
      decisions: [{ callId: "call-1", type: "approve" }],
    });
    let sent = socket.lastFrame();
    expect(sent.kind).toBe("approval_response");
    expect(sent.protocolVersion).toBe("1");
    expect(sent.sessionId).toBe("test-session");
    expect(typeof sent.correlationId).toBe("string");
    expect((sent.correlationId as string).length).toBeGreaterThan(0);

    client.steer({ parts: [{ text: "keep going", type: "text" }] });
    sent = socket.lastFrame();
    expect(sent.kind).toBe("steer");
    expect(sent.protocolVersion).toBe("1");
    expect(sent.sessionId).toBe("test-session");
    expect(typeof sent.correlationId).toBe("string");
    expect((sent.correlationId as string).length).toBeGreaterThan(0);

    client.cancel();
    sent = socket.lastFrame();
    expect(sent.kind).toBe("cancel");
    expect(sent.protocolVersion).toBe("1");
    expect(sent.sessionId).toBe("test-session");
    expect(typeof sent.correlationId).toBe("string");
    expect((sent.correlationId as string).length).toBeGreaterThan(0);
  });
});

describe("createSessionClient: void handler wire shape (P1-1)", () => {
  test("a void-returning handler's client_result carries a present content:null, not a dropped key", async () => {
    const { client, sockets } = makeClient({
      capabilities: {
        "void.tool": () => {
          // Deliberately returns nothing.
        },
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.receive({
      frame: {
        invocation: {
          callId: "call-void",
          capabilityId: "void.tool",
          input: {},
          leaseToken: "lease-void",
        },
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await flush();

    const resultFrame = socket.lastFrame();
    const result = resultFrame.result as Record<string, unknown>;
    expect("content" in result).toBe(true);
    expect(result.content).toBeNull();

    // Also assert directly against the raw sent JSON string, since a naive
    // fix could satisfy the parsed-object assertion above while a different
    // serialization step still dropped the key.
    const rawSent = socket.sent.at(-1);
    const rawFrame = (rawSent as Record<string, unknown>).frame as Record<
      string,
      unknown
    >;
    const rawResult = rawFrame.result as Record<string, unknown>;
    expect("content" in rawResult).toBe(true);
  });
});

describe("createSessionClient: control frames queue until handshake_ack (P2-2)", () => {
  test("steer() called before the handshake ack is not on the wire until after ack", () => {
    const { client, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();

    // No ack yet: steer() must not reach the socket.
    client.steer({ parts: [{ text: "too early", type: "text" }] });
    expect(socket.sent).toHaveLength(1); // only the handshake
    expect(socket.sent[0]).toMatchObject({ kind: "handshake" });

    ack(socket);

    // The queued steer flushes right after the ack.
    expect(socket.sent).toHaveLength(2);
    const flushed = socket.lastFrame();
    expect(flushed.kind).toBe("steer");
  });

  test("steer() called during backoff flushes after the next successful handshake", () => {
    const { client, clock, sockets } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const first = sockets[0] as FakeSocket;
    first.open();
    ack(first);

    // Retryable close drops us into backoff with no live socket.
    first.serverClose(4004, "heartbeat timeout");

    // Called mid-backoff: no live socket at all, so this can only queue.
    client.steer({ parts: [{ text: "during backoff", type: "text" }] });

    clock.advance(100);
    const second = sockets[1] as FakeSocket;
    second.open();

    // Not sent yet: still waiting on the new socket's ack.
    expect(second.sent).toHaveLength(1); // only the handshake
    expect(second.sent[0]).toMatchObject({ kind: "handshake" });

    ack(second);

    expect(second.sent).toHaveLength(2);
    const flushed = second.lastFrame();
    expect(flushed.kind).toBe("steer");
  });
});

describe("createSessionClient: malformed client_invocation (P2-3)", () => {
  test("malformed invocation frames are ignored and do not throw; later valid frames still process", async () => {
    const { client, sockets } = makeClient({
      capabilities: {
        "echo.tool": async (input) => ({ echoed: input }),
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    const malformedInvocations: unknown[] = [
      undefined,
      null,
      "not-an-object",
      42,
      {},
      { callId: "call-x" }, // missing capabilityId/leaseToken
      { callId: 7, capabilityId: "echo.tool", leaseToken: "l" }, // non-string callId
    ];

    for (const invocation of malformedInvocations) {
      expect(() => {
        socket.receive({
          frame: {
            invocation,
            kind: "client_invocation",
            sessionId: "test-session",
          },
          kind: "frame",
        });
      }).not.toThrow();
    }

    // No client_result should have been produced for any malformed frame.
    expect(socket.sent).toHaveLength(1); // only the handshake

    // A subsequent valid invocation still dispatches normally.
    socket.receive({
      frame: {
        invocation: {
          callId: "call-valid",
          capabilityId: "echo.tool",
          input: { ok: true },
          leaseToken: "lease-valid",
        },
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await flush();

    const resultFrame = socket.lastFrame();
    expect(resultFrame.kind).toBe("client_result");
    const result = resultFrame.result as Record<string, unknown>;
    expect(result.callId).toBe("call-valid");
    expect(result.content).toEqual({ echoed: { ok: true } });
  });
});

describe("createSessionClient: close() during backoff emits terminal status (P2-5)", () => {
  test("connect -> retryable close -> close() during backoff observes a terminal status and stops reconnecting", () => {
    const { client, clock, sockets, statuses } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    ack(socket);

    socket.serverClose(4004, "heartbeat timeout");
    expect(clock.delays()).toEqual([100]);

    client.close(1000, "user closed during backoff");

    const terminal = statuses.at(-1);
    expect(terminal).toMatchObject({ phase: "closed", terminal: true });

    // The pending reconnect timer must have been cancelled: advancing the
    // clock produces no new socket.
    clock.advance(1000);
    expect(sockets).toHaveLength(1);
  });
});

describe("createSessionClient: option validation (P2-6)", () => {
  test("throws RangeError for an empty url", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        sessionId: "test-session",
        url: "",
      })
    ).toThrow(RangeError);
  });

  test("throws RangeError for an empty sessionId", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        sessionId: "",
        url: "wss://example.invalid/session",
      })
    ).toThrow(RangeError);
  });

  test("throws RangeError for a non-positive reconnect.baseDelayMs", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { baseDelayMs: 0 },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).toThrow(RangeError);
  });

  test("throws RangeError for a non-finite reconnect.maxDelayMs", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { maxDelayMs: Number.POSITIVE_INFINITY },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).toThrow(RangeError);
  });

  test("throws RangeError for a non-positive reconnect.maxAttempts", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { maxAttempts: -1 },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).toThrow(RangeError);
  });

  test("accepts valid options without throwing", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { baseDelayMs: 100, maxAttempts: 5, maxDelayMs: 1000 },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).not.toThrow();
  });
});
