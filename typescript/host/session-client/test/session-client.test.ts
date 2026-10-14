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

import { createSessionClient } from "../src/index.js";
import {
  ack,
  flush,
  makeClient,
  requiredRecord,
  requiredString,
} from "./session-client-fixtures.js";

const NO_SUCH_CAPABILITY_PATTERN = /no\.such\.capability/u;

describe("createSessionClient: handshake and events", () => {
  test("sends handshake on open with no cursor on first connect", () => {
    const { client, sockets } = makeClient();
    client.connect();
    expect(sockets).toHaveLength(1);
    const [socket] = sockets;

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
    const [socket] = sockets;
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

  test("ignores invalid acknowledgements and outbound envelopes before side effects", async () => {
    const calls: string[] = [];
    const { client, events, sockets, statuses } = makeClient({
      capabilities: {
        tool: () => {
          calls.push("called");
          return "ok";
        },
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    socket.receive({
      kind: "handshake_ack",
      protocolVersion: "2",
      resumeStatus: "none",
      sessionId: "test-session",
    });
    socket.receive({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "none",
      sessionId: "another-session",
    });
    client.cancel();
    expect(socket.sent).toHaveLength(1);
    expect(statuses.some((status) => status.phase === "open")).toBe(false);

    ack(socket, "none", "test-session");
    expect(socket.sent).toHaveLength(2);
    socket.receive({
      cursor: "trusted-cursor",
      frame: {
        event: { marker: "trusted" },
        kind: "event",
        protocolVersion: "1",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    socket.receive({
      cursor: "foreign-cursor",
      frame: {
        event: { marker: "foreign" },
        kind: "event",
        protocolVersion: "1",
        sessionId: "other-session",
      },
      kind: "frame",
    });
    socket.receive({
      cursor: "unsupported-cursor",
      frame: {
        event: { marker: "unsupported" },
        kind: "event",
        protocolVersion: "2",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    socket.receive({
      frame: {
        event: { marker: "accepted" },
        kind: "event",
        protocolVersion: "1",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    socket.receive({
      frame: {
        invocation: {
          callId: "before-envelope-check",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
        protocolVersion: "2",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await flush();
    expect(events).toEqual([
      { cursor: "trusted-cursor", event: { marker: "trusted" } },
      { cursor: "trusted-cursor", event: { marker: "accepted" } },
    ]);
    expect(calls).toEqual([]);
    expect(socket.sent).toHaveLength(2);

    socket.receive({
      frame: {
        invocation: {
          callId: "valid-control",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
        protocolVersion: "1",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await flush();
    expect(calls).toEqual(["called"]);
    expect(socket.sent).toHaveLength(3);
    expect(socket.lastFrame()).toMatchObject({
      kind: "client_result",
      result: { callId: "valid-control", content: "ok", leaseToken: "lease" },
    });
    client.close();
  });

  test("whitespace-only invocation identifiers are ignored before handlers", async () => {
    const calls: string[] = [];
    const { client, sockets } = makeClient({
      capabilities: {
        tool: () => {
          calls.push("called");
          return "ok";
        },
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);
    for (const invocation of [
      { callId: " ", capabilityId: "tool", input: null, leaseToken: "lease" },
      { callId: "call", capabilityId: " \t", input: null, leaseToken: "lease" },
      { callId: "call", capabilityId: "tool", input: null, leaseToken: "\n" },
    ]) {
      socket.receive({
        frame: { invocation, kind: "client_invocation" },
        kind: "frame",
      });
    }
    await flush();
    expect(calls).toEqual([]);
    expect(socket.sent).toHaveLength(1);

    socket.receive({
      frame: {
        invocation: {
          callId: "valid-after-whitespace",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
        protocolVersion: "1",
        sessionId: "test-session",
      },
      kind: "frame",
    });
    await flush();
    expect(calls).toEqual(["called"]);
    expect(socket.sent).toHaveLength(2);
    expect(socket.lastFrame()).toMatchObject({
      kind: "client_result",
      result: {
        callId: "valid-after-whitespace",
        content: "ok",
        leaseToken: "lease",
      },
    });
    client.close();
  });
});

describe("createSessionClient: capability dispatch", () => {
  test("runs the matching handler and echoes leaseToken verbatim", async () => {
    const { client, sockets } = makeClient({
      capabilities: {
        "echo.tool": (input) => ({ echoed: input }),
      },
    });
    client.connect();
    const [socket] = sockets;
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
    const result = requiredRecord(resultFrame.result);
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
    const [socket] = sockets;
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
    const result = requiredRecord(resultFrame.result);
    expect(result.isError).toBe(true);
    expect(requiredRecord(result.content).error).toBe("boom");
    expect(result.leaseToken).toBe("lease-2");
  });

  test("unknown capabilityId yields a well-shaped isError result", async () => {
    const { client, sockets } = makeClient();
    client.connect();
    const [socket] = sockets;
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
    const result = requiredRecord(resultFrame.result);
    expect(result.isError).toBe(true);
    expect(requiredRecord(result.content).error).toMatch(
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
    const [socket] = sockets;
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
    const firstResult = requiredRecord(socket.lastFrame().result);
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
    const secondResult = requiredRecord(socket.lastFrame().result);
    expect(secondResult.content).toEqual({ runs: 1 });
  });

  test("still-in-flight redelivery is ignored; the running handler answers once", async () => {
    const pendingHandler = Promise.withResolvers<{ done: true }>();
    let runs = 0;
    const { client, sockets } = makeClient({
      capabilities: {
        "slow.tool": async () => {
          runs += 1;
          return await pendingHandler.promise;
        },
      },
    });
    client.connect();
    const [socket] = sockets;
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
    // only the handshake so far
    expect(socket.sent).toHaveLength(1);

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

    pendingHandler.resolve({ done: true });
    await flush();

    expect(socket.sent).toHaveLength(2);
    const result = requiredRecord(socket.lastFrame().result);
    expect(result.content).toEqual({ done: true });
  });
});

describe("createSessionClient: reconnect and backoff", () => {
  test("reconnects after a retryable close with the last-seen cursor and exponential backoff", () => {
    const { client, clock, sockets, statuses } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const [first] = sockets;
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
    const [, second] = sockets;
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
    const [socket] = sockets;
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
    const [socket] = sockets;
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
    const [socket] = sockets;
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
    expect(requiredString(sent.correlationId).length).toBeGreaterThan(0);

    client.steer({ parts: [{ text: "keep going", type: "text" }] });
    sent = socket.lastFrame();
    expect(sent.kind).toBe("steer");
    expect(sent.protocolVersion).toBe("1");
    expect(sent.sessionId).toBe("test-session");
    expect(typeof sent.correlationId).toBe("string");
    expect(requiredString(sent.correlationId).length).toBeGreaterThan(0);

    client.cancel();
    sent = socket.lastFrame();
    expect(sent.kind).toBe("cancel");
    expect(sent.protocolVersion).toBe("1");
    expect(sent.sessionId).toBe("test-session");
    expect(typeof sent.correlationId).toBe("string");
    expect(requiredString(sent.correlationId).length).toBeGreaterThan(0);
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
    const [socket] = sockets;
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
    const result = requiredRecord(resultFrame.result);
    expect("content" in result).toBe(true);
    expect(result.content).toBeNull();

    // Also assert directly against the raw sent JSON string, since a naive
    // fix could satisfy the parsed-object assertion above while a different
    // serialization step still dropped the key.

    const rawSent = socket.sent.at(-1);
    const rawFrame = requiredRecord(requiredRecord(rawSent).frame);
    const rawResult = requiredRecord(rawFrame.result);
    expect("content" in rawResult).toBe(true);
  });
});

describe("createSessionClient: control frames queue until handshake_ack (P2-2)", () => {
  test("steer() called before the handshake ack is not on the wire until after ack", () => {
    const { client, sockets } = makeClient();
    client.connect();
    const [socket] = sockets;
    socket.open();

    // No ack yet: steer() must not reach the socket.

    client.steer({ parts: [{ text: "too early", type: "text" }] });
    // only the handshake
    expect(socket.sent).toHaveLength(1);
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
    const [first] = sockets;
    first.open();
    ack(first);

    // Retryable close drops us into backoff with no live socket.

    first.serverClose(4004, "heartbeat timeout");

    // Called mid-backoff: no live socket at all, so this can only queue.

    client.steer({ parts: [{ text: "during backoff", type: "text" }] });

    clock.advance(100);
    const [, second] = sockets;
    second.open();

    // Not sent yet: still waiting on the new socket's ack.
    // only the handshake
    expect(second.sent).toHaveLength(1);
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
        "echo.tool": (input) => ({ echoed: input }),
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);

    const malformedInvocations: unknown[] = [
      undefined,
      null,
      "not-an-object",
      42,
      {},
      // missing capabilityId/leaseToken
      { callId: "call-x" },
      // non-string callId
      { callId: 7, capabilityId: "echo.tool", leaseToken: "l" },
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
    // only the handshake
    expect(socket.sent).toHaveLength(1);

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
    const result = requiredRecord(resultFrame.result);
    expect(result.callId).toBe("call-valid");
    expect(result.content).toEqual({ echoed: { ok: true } });
  });
});

describe("createSessionClient: malformed session_rejection (P2-3b)", () => {
  test("malformed rejection frames do not throw and are not delivered; a valid one still is", () => {
    const { client, sockets, rejections } = makeClient();
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);

    const malformedRejections: unknown[] = [
      undefined,
      null,
      "not-an-object",
      42,
      {},
      // missing code/message
      { correlationId: "corr-1" },
      // missing message
      { code: "session_frame_invalid", correlationId: "corr-2" },
      { code: "not-a-real-code", correlationId: "corr-3", message: "bad code" },
      {
        code: "session_frame_invalid",
        correlationId: 7,
        message: "non-string correlationId",
      },
    ];

    for (const rejection of malformedRejections) {
      expect(() => {
        socket.receive({
          frame: {
            kind: "session_rejection",
            rejection,
            sessionId: "test-session",
          },
          kind: "frame",
        });
      }).not.toThrow();
    }

    expect(rejections).toHaveLength(0);

    // A subsequent well-shaped rejection is still delivered.

    socket.receive({
      frame: {
        kind: "session_rejection",
        rejection: {
          code: "session_frame_invalid",
          correlationId: "corr-valid",
          message: "inbound frame must be an object",
        },
        sessionId: "test-session",
      },
      kind: "frame",
    });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual({
      code: "session_frame_invalid",
      correlationId: "corr-valid",
      message: "inbound frame must be an object",
    });
  });
});

describe("createSessionClient: close() during backoff emits terminal status (P2-5)", () => {
  test("connect -> retryable close -> close() during backoff observes a terminal status and stops reconnecting", () => {
    const { client, clock, sockets, statuses } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const [socket] = sockets;
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

  test("throws RangeError for a NaN reconnect.maxAttempts", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { maxAttempts: Number.NaN },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).toThrow(RangeError);
  });

  test("throws RangeError for a zero reconnect.maxAttempts", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { maxAttempts: 0 },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).toThrow(RangeError);
  });

  test("accepts an explicit reconnect.maxAttempts of Infinity, matching the documented default", () => {
    expect(() =>
      createSessionClient({
        capabilities: {},
        reconnect: { maxAttempts: Number.POSITIVE_INFINITY },
        sessionId: "test-session",
        url: "wss://example.invalid/session",
      })
    ).not.toThrow();
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

describe("createSessionClient: outboundQueue robustness (P2 close/flush/settle)", () => {
  test("close() clears the outboundQueue instead of re-queuing it across a later reconnect", () => {
    const { client, clock, sockets } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const [first] = sockets;
    first.open();
    ack(first);

    // Drop into backoff with no live socket, then queue a steer while
    // reconnecting.

    first.serverClose(4004, "heartbeat timeout");
    client.steer({ parts: [{ text: "should be cleared", type: "text" }] });

    // The user closes explicitly before the reconnect completes: the queued
    // steer must be cleared, not carried over to a subsequent connection.

    client.close(1000, "user closed during backoff");

    // Advancing the clock must not resume the reconnect (close() cancels the
    // pending timer) or send the cleared frame.

    clock.advance(1000);
    expect(sockets).toHaveLength(1);

    // Reconnecting fresh afterwards must not replay the cleared steer.

    client.connect();
    expect(sockets).toHaveLength(2);
    const [, second] = sockets;
    second.open();
    ack(second);

    // only the handshake
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]).toMatchObject({ kind: "handshake" });
  });

  test("flushOutboundQueue re-queues the unsent tail when a send throws mid-flush", () => {
    const { client, clock, sockets } = makeClient({
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const [first] = sockets;
    first.open();

    // Queue two control frames before the handshake ack lands.

    client.steer({ parts: [{ text: "first", type: "text" }] });
    client.cancel();
    // only the handshake so far
    expect(first.sent).toHaveLength(1);

    // The first flush attempt's send throws (socket looked alive but died).

    first.sendFailures = 1;
    ack(first);

    // Neither queued frame reached the wire: the throwing send must not have
    // dropped itself or the frame after it.

    expect(first.sent).toHaveLength(1);

    // Simulate the connection dying and reconnecting; the still-queued
    // frames must flush, in original order, once the new socket acks.

    first.serverClose(4004, "heartbeat timeout");
    clock.advance(100);
    const [, second] = sockets;
    second.open();
    ack(second);

    // handshake + steer + cancel
    expect(second.sent).toHaveLength(3);
    const steerEnvelope = requiredRecord(second.sent[1]);
    expect(steerEnvelope.frame).toMatchObject({ kind: "steer" });
    const cancelEnvelope = requiredRecord(second.sent[2]);
    expect(cancelEnvelope.frame).toMatchObject({ kind: "cancel" });
  });

  test("a socket.send throw in the error-path settle does not reject the handler chain; the result queues and flushes after the next handshake", async () => {
    const { client, clock, sockets } = makeClient({
      capabilities: {
        "boom.tool": () => {
          throw new Error("boom");
        },
      },
      reconnect: { baseDelayMs: 100, maxDelayMs: 1000 },
    });
    client.connect();
    const [first] = sockets;
    first.open();
    ack(first);

    // The socket is "open" (handshakeOpen) but the very next send throws,
    // simulating a socket that died between the ack and this dispatch.

    first.sendFailures = 1;

    first.receive({
      frame: {
        invocation: {
          callId: "call-boom",
          capabilityId: "boom.tool",
          input: {},
          leaseToken: "lease-boom",
        },
        kind: "client_invocation",
        sessionId: "test-session",
      },
      kind: "frame",
    });

    // If the throw inside settle()'s send escaped as an unhandled rejection,
    // this await would not be what surfaces it (bun fails the run instead) —
    // asserting the queue recovers on the next handshake below is the
    // behavioral proof that the chain settled without throwing further.

    await flush();

    // The result never reached the wire (send failed) and was not dropped.
    // only the handshake
    expect(first.sent).toHaveLength(1);

    // Reconnect: the queued client_result for call-boom flushes in order.

    first.serverClose(4004, "heartbeat timeout");
    clock.advance(100);
    const [, second] = sockets;
    second.open();
    ack(second);

    // handshake + the queued client_result
    expect(second.sent).toHaveLength(2);
    const resultFrame = second.lastFrame();
    expect(resultFrame.kind).toBe("client_result");
    const result = requiredRecord(resultFrame.result);
    expect(result.callId).toBe("call-boom");
    expect(result.isError).toBe(true);
    expect(requiredRecord(result.content).error).toBe("boom");
  });
});
