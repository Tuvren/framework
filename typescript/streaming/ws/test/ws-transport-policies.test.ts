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
import type { SessionOutboundFrame } from "@tuvren/host-session";
import { streamAdapterFixtures } from "@tuvren/stream-core";
import { createWsSessionTransport } from "../src/lib/ws-session-transport.js";
import {
  clientInvocationOutboundFrame,
  createFakeBinding,
  createFakeSessionSink,
  createFakeSink,
  createFiniteOutboundIterable,
  createHangingOutboundIterable,
  createScriptedBufferedAmountSink,
  createTestSession,
  delay,
  eventOutboundFrame,
  flushMicrotasks,
  handshakeMessage,
  SESSION_ID,
} from "./session-test-helpers.js";

describe("createWsSessionTransport: option validation", () => {
  test("heartbeat.intervalMs must be a positive finite number", () => {
    const fake = createFakeBinding();
    const session = createTestSession({ binding: fake.binding });
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: 0, timeoutMs: 10 },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: -5, timeoutMs: 10 },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: Number.POSITIVE_INFINITY, timeoutMs: 10 },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
  });

  test("heartbeat.timeoutMs must be a positive finite number", () => {
    const fake = createFakeBinding();
    const session = createTestSession({ binding: fake.binding });
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: 10, timeoutMs: 0 },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: 10, timeoutMs: Number.NaN },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
  });

  test("heartbeat.timeoutMs may be less than, equal to, or greater than intervalMs", () => {
    const fakeLess = createFakeBinding();
    const sessionLess = createTestSession({ binding: fakeLess.binding });
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: 20, timeoutMs: 5 },
        session: sessionLess,
        sink: createFakeSink(),
      })
    ).not.toThrow();

    const fakeEqual = createFakeBinding();
    const sessionEqual = createTestSession({ binding: fakeEqual.binding });
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: 20, timeoutMs: 20 },
        session: sessionEqual,
        sink: createFakeSink(),
      })
    ).not.toThrow();

    const fakeGreater = createFakeBinding();
    const sessionGreater = createTestSession({ binding: fakeGreater.binding });
    expect(() =>
      createWsSessionTransport({
        heartbeat: { intervalMs: 20, timeoutMs: 60 },
        session: sessionGreater,
        sink: createFakeSink(),
      })
    ).not.toThrow();
  });

  test("backpressure.maxBufferedBytes must be a positive finite number", () => {
    const fake = createFakeBinding();
    const session = createTestSession({ binding: fake.binding });
    expect(() =>
      createWsSessionTransport({
        backpressure: { maxBufferedBytes: 0 },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        backpressure: { maxBufferedBytes: -1 },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        backpressure: { maxBufferedBytes: Number.POSITIVE_INFINITY },
        session,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
  });
});

describe("createWsSessionTransport: heartbeat / half-open detection", () => {
  const INTERVAL_MS = 15;
  const TIMEOUT_MS = 40;

  test("a silent peer is closed with 4004 and the timeout warning after no inbound activity", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable());
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
      onWarning: (warning) => warnings.push(warning.code),
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    // At least one ping must fire before the first timeout can.
    await delay(INTERVAL_MS + TIMEOUT_MS + 150);

    expect(
      sink.sent.some((message) => (message as { kind: string }).kind === "ping")
    ).toBe(true);
    expect(sink.closes).toEqual([
      {
        code: 4004,
        reason: "no inbound activity within the configured heartbeat timeout",
      },
    ]);
    expect(warnings).toContain("ws_transport_heartbeat_timeout");
  });

  test("a peer that answers every ping with pong keeps the connection open across several intervals", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable());
    const session = createTestSession({ binding: fake.binding });
    let transportRef: { ingest(data: string): void } | undefined;
    const sink = createFakeSink();
    const baseSend = sink.send.bind(sink);
    sink.send = (data: string): void => {
      baseSend(data);
      const parsed = JSON.parse(data) as { kind: string };
      if (parsed.kind === "ping") {
        queueMicrotask(() => {
          transportRef?.ingest(JSON.stringify({ kind: "pong" }));
        });
      }
    };

    const transport = createWsSessionTransport({
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
      session,
      sink,
    });
    transportRef = transport;

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    await delay(INTERVAL_MS * 8);

    const pingCount = sink.sent.filter(
      (message) => (message as { kind: string }).kind === "ping"
    ).length;
    expect(pingCount).toBeGreaterThanOrEqual(3);
    expect(sink.closes).toEqual([]);
    transport.close();
  });

  test("inbound frame traffic (not only pong) counts as heartbeat liveness", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable());
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    // Let the first ping go out, then answer with plain frame traffic
    // instead of a pong before its timeout would fire.
    await delay(INTERVAL_MS + 5);
    transport.ingest(
      JSON.stringify({ frame: { kind: "cancel" }, kind: "frame" })
    );

    // Without the liveness reset, the first ping's timeout would have fired
    // well before this point (INTERVAL_MS + TIMEOUT_MS from start).
    await delay(TIMEOUT_MS);

    expect(sink.closes).toEqual([]);
    transport.close();
  });

  test("timers are cleaned up after close: no further sink activity after a wait longer than the interval", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable());
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    transport.close();
    const sentAtClose = sink.sent.length;
    const closesAtClose = sink.closes.length;

    await delay(INTERVAL_MS * 6);

    expect(sink.sent).toHaveLength(sentAtClose);
    expect(sink.closes).toHaveLength(closesAtClose);
  });

  test("heartbeat is disabled (no timers run) when the option is omitted", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable());
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    await delay(200);

    expect(
      sink.sent.some((message) => (message as { kind: string }).kind === "ping")
    ).toBe(false);
    expect(sink.closes).toEqual([]);
    transport.close();
  });
});

describe("createWsSessionTransport: bounded backpressure", () => {
  test("a live pump send that would overflow the budget closes with 4005 instead of sending it", async () => {
    const invocationFrame = clientInvocationOutboundFrame();
    const fake = createFakeBinding(
      createFiniteOutboundIterable([invocationFrame])
    );
    const session = createTestSession({ binding: fake.binding });
    // handshake_ack read is not scripted against the budget (no pump send
    // yet); the pump's first send reads a bufferedAmount over budget.
    const sink = createScriptedBufferedAmountSink([500]);
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 100 },
      onWarning: (warning) => warnings.push(warning.code),
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    // Only the handshake_ack was sent; the overflowing frame must not be.
    expect(sink.sent).toEqual([
      {
        kind: "handshake_ack",
        protocolVersion: "1",
        resumeStatus: "none",
        sessionId: SESSION_ID,
      },
    ]);
    expect(sink.closes).toEqual([
      {
        code: 4005,
        reason:
          "outbound socket buffer exceeded the configured backpressure budget",
      },
    ]);
    expect(warnings).toContain("ws_transport_backpressure_exceeded");
  });

  test("a replayed frame sent during handshake that would overflow the budget closes with 4005", async () => {
    // Prime the session's replay buffer via a first attach/detach cycle,
    // then reconnect with a cursor so the handshake's replay flush has
    // frames to send.
    const sourceEvents = streamAdapterFixtures.completedTurn;
    const outboundFrames = sourceEvents.map((event) =>
      eventOutboundFrame(event)
    );
    const fake = createFakeBinding(
      createHangingOutboundIterable(outboundFrames)
    );
    const session = createTestSession({ binding: fake.binding });

    const primerSink = createFakeSessionSink();
    session.attach(primerSink);
    await flushMicrotasks();
    const resumeCursor = primerSink.sent[0]?.cursor as string;
    session.detach();

    const sink = createScriptedBufferedAmountSink([500]);
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 100 },
      onWarning: (warning) => warnings.push(warning.code),
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage({ cursor: resumeCursor }));
    await flushMicrotasks();

    // Only the handshake_ack was sent before the replay flush's own
    // backpressure check tripped.
    expect(sink.sent).toEqual([
      {
        kind: "handshake_ack",
        protocolVersion: "1",
        resumeStatus: "resumed",
        sessionId: SESSION_ID,
      },
    ]);
    expect(sink.closes).toEqual([
      {
        code: 4005,
        reason:
          "outbound socket buffer exceeded the configured backpressure budget",
      },
    ]);
    expect(warnings).toContain("ws_transport_backpressure_exceeded");
  });

  test("no bufferedAmount capability on the sink disables enforcement even with the option set", async () => {
    const invocationFrame = clientInvocationOutboundFrame();
    const fake = createFakeBinding(
      createFiniteOutboundIterable([invocationFrame])
    );
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink(); // no bufferedAmount()
    const transport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 1 },
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(sink.closes).toEqual([]);
    const frameMessage = sink.sent[1] as { frame: SessionOutboundFrame };
    expect(frameMessage.frame).toEqual(invocationFrame);
  });

  test("backpressure option absent disables enforcement even when the sink reports a large bufferedAmount", async () => {
    const invocationFrame = clientInvocationOutboundFrame();
    const fake = createFakeBinding(
      createFiniteOutboundIterable([invocationFrame])
    );
    const session = createTestSession({ binding: fake.binding });
    const sink = createScriptedBufferedAmountSink([1_000_000]);
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(sink.closes).toEqual([]);
    const frameMessage = sink.sent[1] as { frame: SessionOutboundFrame };
    expect(frameMessage.frame).toEqual(invocationFrame);
  });
});

describe("createWsSessionTransport: overflow keeps the unsent event frame resumable", () => {
  test("an event frame recorded before an overflow close replays on the next transport over the SAME session", async () => {
    const eventFrames: SessionOutboundFrame[] =
      streamAdapterFixtures.completedTurn.slice(0, 3).map((event) => ({
        event,
        kind: "event",
        protocolVersion: "1",
        sessionId: SESSION_ID,
      }));
    const fake = createFakeBinding(createHangingOutboundIterable(eventFrames));
    const session = createTestSession({ binding: fake.binding });

    // The first two event sends stay under budget (the handshake ack is not
    // budget-checked); the third event's pre-send check reports an
    // over-budget socket.
    const overflowSink = createScriptedBufferedAmountSink([0, 0, 999]);
    const firstTransport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 100 },
      session,
      sink: overflowSink,
    });

    firstTransport.start();
    firstTransport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(overflowSink.closes).toEqual([
      {
        code: 4005,
        reason:
          "outbound socket buffer exceeded the configured backpressure budget",
      },
    ]);

    // Two live event envelopes made it onto the wire; the third was
    // sequenced and recorded by the session (event recording happens
    // unconditionally, before the budget check ever runs) but never sent.
    const sentFrames = (
      overflowSink.sent as Array<{ kind: string; cursor?: string }>
    ).filter((message) => message.kind === "frame");

    expect(sentFrames).toHaveLength(2);

    const lastReceivedCursor = sentFrames.at(-1)?.cursor as string;
    const secondSink = createFakeSink();
    const secondTransport = createWsSessionTransport({
      session,
      sink: secondSink,
    });

    secondTransport.start();
    secondTransport.ingest(handshakeMessage({ cursor: lastReceivedCursor }));
    await flushMicrotasks();

    const ack = secondSink.sent[0] as { kind: string; resumeStatus: string };

    expect(ack.resumeStatus).toBe("resumed");

    const replayed = (
      secondSink.sent.slice(1) as Array<{
        kind: string;
        frame: { event: { type: string } };
      }>
    ).filter((message) => message.kind === "frame");

    // Exactly the recorded-but-unsent third frame comes back.
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.frame.event.type).toBe(
      streamAdapterFixtures.completedTurn[2]?.type as string
    );

    secondTransport.close();
  });
});
