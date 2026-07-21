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
import {
  decodeResumeCursor,
  encodeResumeCursor,
  streamAdapterFixtures,
} from "@tuvren/stream-core";
import {
  createWsSessionTransport,
  type WsSessionTransport,
} from "../src/lib/ws-session-transport.js";
import {
  clientInvocationOutboundFrame,
  createFakeBinding,
  createFakeSessionSink,
  createFakeSink,
  createFiniteOutboundIterable,
  createHangingOutboundIterable,
  createRealBinding,
  createTestSession,
  eventOutboundFrame,
  type FakeSink,
  flushMicrotasks,
  handshakeMessage,
  SESSION_ID,
} from "./session-test-helpers.js";

describe("createWsSessionTransport: claim and lifecycle", () => {
  test("a second start() throws", () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const transport = createWsSessionTransport({
      session,
      sink: createFakeSink(),
    });

    transport.start();
    expect(() => transport.start()).toThrow();
  });

  test("ingest() before start() throws", () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const transport = createWsSessionTransport({
      session,
      sink: createFakeSink(),
    });

    expect(() => transport.ingest(handshakeMessage())).toThrow();
  });

  test("transport.close() before any successful handshake never touches the session", () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.close();

    expect(sink.closes).toEqual([{ code: 1000, reason: undefined }]);
    // A session that was never attached has nothing to detach from, and
    // detaching an unattached session is a documented no-op regardless, so
    // the only observable fact this test pins is that close() before a
    // handshake never throws and closes the socket normally.
    expect(session.isEnded()).toBe(false);
  });

  test("transport.close() after a successful handshake detaches the attached sink from the session", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({
      binding: fake.binding,
      disconnectGraceMs: 10_000,
    });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    transport.close();

    expect(sink.closes).toEqual([{ code: 1000, reason: undefined }]);
    // detach() starts the grace window rather than ending the session
    // outright (ADR-063 decision 4) — the transport must never end/close
    // the session itself.
    expect(session.isEnded()).toBe(false);

    // A second attach (as a later transport would perform on reattach)
    // succeeds, proving the prior sink was actually released rather than
    // left dangling as "still attached".
    expect(() => session.attach(createFakeSessionSink())).not.toThrow();
  });
});

describe("createWsSessionTransport: happy path", () => {
  async function startHandshakedTransport(
    outboundFrames: SessionOutboundFrame[]
  ): Promise<{
    sink: FakeSink;
    transport: WsSessionTransport;
  }> {
    const fake = createFakeBinding(
      createFiniteOutboundIterable(outboundFrames)
    );
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    return { sink, transport };
  }

  test("handshake with no cursor acks resumeStatus none", async () => {
    const { sink } = await startHandshakedTransport([]);

    expect(sink.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "none",
      sessionId: SESSION_ID,
    });
  });

  test("live event frames are sent with monotonically increasing cursors and the correct turnId", async () => {
    const events = streamAdapterFixtures.completedTurn;
    const outboundFrames = events.map((event) => eventOutboundFrame(event));
    const { sink } = await startHandshakedTransport(outboundFrames);

    // First message is the handshake_ack; the rest are frame envelopes.
    const frameMessages = sink.sent.slice(1) as Array<{
      cursor?: string;
      frame: SessionOutboundFrame;
      kind: "frame";
    }>;

    expect(frameMessages).toHaveLength(events.length);

    frameMessages.forEach((message, index) => {
      expect(message.kind).toBe("frame");
      expect(message.cursor).toBeDefined();

      const decoded = decodeResumeCursor(message.cursor as string);
      expect(decoded?.sequence).toBe(index);
      expect(decoded?.turnId).toBe("turn-main");
      expect(message.frame).toEqual(outboundFrames[index]);
    });
  });

  test("a non-event outbound frame is sent without a cursor", async () => {
    const invocationFrame = clientInvocationOutboundFrame();
    const { sink } = await startHandshakedTransport([invocationFrame]);

    const frameMessage = sink.sent[1] as {
      cursor?: string;
      frame: SessionOutboundFrame;
      kind: "frame";
    };

    expect(frameMessage.kind).toBe("frame");
    expect(frameMessage.cursor).toBeUndefined();
    expect(frameMessage.frame).toEqual(invocationFrame);
  });

  test("the underlying session ending closes the currently attached socket: a host-composition responsibility via onEnded", async () => {
    // ADR-063: the transport no longer owns the outbound pump, so it has no
    // intrinsic signal for "the turn is over, close the socket normally".
    // That signal is now RemoteClientSessionOptions.onEnded, and it is the
    // HOST's job (not the transport's) to close whichever transport is
    // currently attached when it fires. This test pins that composition
    // contract rather than any transport-internal behavior.
    const fake = createFakeBinding(createFiniteOutboundIterable([]));
    let currentTransport: WsSessionTransport | undefined;
    const session = createTestSession({
      binding: fake.binding,
      onEnded: (reason) => currentTransport?.close(1000, reason),
    });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });
    currentTransport = transport;

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      {
        code: 1000,
        reason: "the underlying duplex session binding's outbound stream ended",
      },
    ]);
  });
});

describe("createWsSessionTransport: resume and redelivery across a reconnect", () => {
  test("a second transport attaching to the SAME session after the first closes replays retained events with continuous sequence numbering", async () => {
    const sourceEvents = streamAdapterFixtures.completedTurn;
    const outboundFrames = sourceEvents.map((event) =>
      eventOutboundFrame(event)
    );

    // A hanging (still-open) outbound iterable: the underlying turn is
    // still live after these events, so the session does not permanently
    // end once they drain — exactly the "socket dropped mid-turn" scenario
    // a reconnect test needs.
    const fake = createFakeBinding(
      createHangingOutboundIterable(outboundFrames)
    );
    const session = createTestSession({ binding: fake.binding });

    const sinkOne = createFakeSink();
    const transportOne = createWsSessionTransport({
      session,
      sink: sinkOne,
    });

    transportOne.start();
    transportOne.ingest(handshakeMessage());
    await flushMicrotasks();

    const sentFrameMessages = sinkOne.sent.slice(1) as Array<{
      cursor: string;
      frame: SessionOutboundFrame;
      kind: "frame";
    }>;
    expect(sentFrameMessages).toHaveLength(outboundFrames.length);

    // Close the first socket (not the session) partway through, then attach
    // a second transport to the SAME session, resuming from a cursor
    // partway through what the first socket already received.
    transportOne.close();

    const resumeCursor = sentFrameMessages[1]?.cursor as string;
    const expectedTail = sentFrameMessages.slice(2);

    const sinkTwo = createFakeSink();
    const transportTwo = createWsSessionTransport({
      session,
      sink: sinkTwo,
    });

    transportTwo.start();
    transportTwo.ingest(handshakeMessage({ cursor: resumeCursor }));
    await flushMicrotasks();

    expect(sinkTwo.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "resumed",
      sessionId: SESSION_ID,
    });

    const replayedMessages = sinkTwo.sent.slice(1) as Array<{
      cursor: string;
      frame: SessionOutboundFrame;
      kind: "frame";
    }>;

    expect(replayedMessages).toHaveLength(expectedTail.length);
    replayedMessages.forEach((message, index) => {
      // Continuous numbering: the replayed sequence on the SECOND socket
      // picks up exactly where the FIRST socket's own cursors left off —
      // there is only ever one sequencer (ADR-063), owned by the session,
      // not recreated per transport.
      expect(decodeResumeCursor(message.cursor)?.sequence).toBe(
        decodeResumeCursor(expectedTail[index]?.cursor as string)?.sequence
      );
      expect(message.cursor).toBe(expectedTail[index]?.cursor);
      expect(message.frame).toEqual(expectedTail[index]?.frame);
    });

    transportTwo.close();
  });

  test("an unanswered client_invocation is redelivered by the session through the new transport on reattach", async () => {
    const { binding } = createRealBinding();
    const session = createTestSession({
      binding,
      disconnectGraceMs: 10_000,
      dispatchTimeoutMs: 10_000,
    });

    const sinkOne = createFakeSink();
    const transportOne = createWsSessionTransport({
      session,
      sink: sinkOne,
    });

    transportOne.start();
    transportOne.ingest(handshakeMessage());
    await flushMicrotasks();

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "reconnect-call-1",
      capabilityId: "capability.reconnect",
      input: {},
      leaseToken: "reconnect-lease-1",
    });
    dispatchPromise.catch(() => undefined);
    await flushMicrotasks();

    const invocationMessages = (
      sinkOne.sent as Array<{ frame?: { kind: string } }>
    ).filter((message) => message.frame?.kind === "client_invocation");
    expect(invocationMessages).toHaveLength(1);

    // The socket drops before a client_result ever arrives: close the first
    // transport (detaching, not ending, the session) and reattach with a
    // second transport over the SAME session.
    transportOne.close();

    const sinkTwo = createFakeSink();
    const transportTwo = createWsSessionTransport({
      session,
      sink: sinkTwo,
    });

    transportTwo.start();
    transportTwo.ingest(handshakeMessage());
    await flushMicrotasks();

    const redeliveredMessages = (
      sinkTwo.sent as Array<{ frame?: { invocation?: { callId?: string } } }>
    ).filter((message) => message.frame?.invocation !== undefined);

    expect(redeliveredMessages).toHaveLength(1);
    expect(redeliveredMessages[0]?.frame?.invocation?.callId).toBe(
      "reconnect-call-1"
    );

    transportTwo.close();
  });

  test("a malformed opaque cursor resolves resumeStatus out-of-window", async () => {
    const fake = createFakeBinding(createFiniteOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage({ cursor: "any-opaque-cursor" }));
    await flushMicrotasks();

    expect(sink.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "out-of-window",
      sessionId: SESSION_ID,
    });
  });

  test("a foreign-turn cursor resolves resumeStatus unknown-turn", async () => {
    const sourceEvents = streamAdapterFixtures.completedTurn;
    const outboundFrames = sourceEvents.map((event) =>
      eventOutboundFrame(event)
    );
    const fake = createFakeBinding(
      createHangingOutboundIterable(outboundFrames)
    );
    const session = createTestSession({ binding: fake.binding });

    // Drive the session's own sequencer/replay buffer by attaching once.
    const primerSink = createFakeSessionSink();
    session.attach(primerSink);
    await flushMicrotasks();
    session.detach();

    const foreignCursor = encodeResumeCursor({
      sequence: 0,
      turnId: "turn-never-seen",
      v: 1,
    });

    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage({ cursor: foreignCursor }));
    await flushMicrotasks();

    expect(sink.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "unknown-turn",
      sessionId: SESSION_ID,
    });
  });
});

describe("createWsSessionTransport: handshake close codes", () => {
  test("a non-handshake first message closes with 4000 and stops further processing", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(JSON.stringify({ kind: "ping" }));
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      {
        code: 4000,
        reason:
          "first message on a WebSocket session transport must be a handshake",
      },
    ]);

    // Further ingest after close must not dispatch anything further.
    transport.ingest(JSON.stringify({ kind: "frame", frame: {} }));
    await flushMicrotasks();
    expect(fake.dispatched).toEqual([]);
    expect(sink.closes).toHaveLength(1);
  });

  test("an unsupported protocolVersion closes with 4001", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage({ protocolVersion: "2" }));
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      { code: 4001, reason: 'unsupported handshake protocolVersion "2"' },
    ]);
  });

  test("a mismatched sessionId closes with 4002", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage({ sessionId: "wrong-session" }));
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      {
        code: 4002,
        reason: 'sessionId "wrong-session" does not match this session',
      },
    ]);
  });

  test("a handshake against a permanently-ended session closes with 4002", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    session.close("host is done with this session");

    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      {
        code: 4002,
        reason:
          "this remote client session has already ended and can no longer be attached",
      },
    ]);
  });

  test("a second concurrent handshake for an already-attached session closes the NEW socket with 4000 and leaves the first attached", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });

    const sinkOne = createFakeSink();
    const transportOne = createWsSessionTransport({
      session,
      sink: sinkOne,
    });
    transportOne.start();
    transportOne.ingest(handshakeMessage());
    await flushMicrotasks();

    const sinkTwo = createFakeSink();
    const transportTwo = createWsSessionTransport({
      session,
      sink: sinkTwo,
    });
    transportTwo.start();
    transportTwo.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(sinkTwo.closes).toEqual([
      {
        code: 4000,
        reason:
          "a live sink is already attached to this session; a concurrent second handshake cannot be honored",
      },
    ]);
    // The first connection is untouched: no close, and its handshake_ack
    // remains the only message it ever received.
    expect(sinkOne.closes).toEqual([]);
    expect(sinkOne.sent).toHaveLength(1);

    transportOne.close();
  });

  test("authorize resolving false (async) closes with 4003", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      authorize: async (authToken) => {
        await Promise.resolve();
        return authToken === "the-right-token";
      },
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage({ authToken: "wrong-token" }));
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      { code: 4003, reason: "handshake authToken was rejected" },
    ]);
    expect(sink.sent).toEqual([]);
  });

  test("authorize resolving true (async) proceeds to a normal handshake ack", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      authorize: async (authToken) => {
        await Promise.resolve();
        return authToken === "the-right-token";
      },
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage({ authToken: "the-right-token" }));
    await flushMicrotasks();

    expect(sink.closes).toEqual([]);
    expect(sink.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "none",
      sessionId: SESSION_ID,
    });
  });
});

describe("createWsSessionTransport: post-handshake inbound routing", () => {
  async function startHandshakedTransport(): Promise<{
    fake: ReturnType<typeof createFakeBinding>;
    sink: FakeSink;
    transport: WsSessionTransport;
  }> {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    const transport = createWsSessionTransport({ session, sink });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    return { fake, sink, transport };
  }

  test("a frame envelope's inner frame reaches the binding verbatim", async () => {
    const { fake, transport } = await startHandshakedTransport();
    const innerFrame = {
      correlationId: "corr-1",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: SESSION_ID,
    };

    transport.ingest(JSON.stringify({ frame: innerFrame, kind: "frame" }));
    await flushMicrotasks();

    expect(fake.dispatched).toEqual([innerFrame]);
  });

  test("a malformed post-handshake message reaches the binding and does not close the socket", async () => {
    const { fake, sink, transport } = await startHandshakedTransport();

    transport.ingest("{not json");
    await flushMicrotasks();

    expect(fake.dispatched).toEqual(["{not json"]);
    expect(sink.closes).toEqual([]);
  });

  test("an unrecognized-kind post-handshake message reaches the binding and does not close the socket", async () => {
    const { fake, sink, transport } = await startHandshakedTransport();
    const raw = { field: "value", kind: "not-a-real-kind" };

    transport.ingest(JSON.stringify(raw));
    await flushMicrotasks();

    expect(fake.dispatched).toEqual([raw]);
    expect(sink.closes).toEqual([]);
  });

  test("ping is answered with pong", async () => {
    const { sink, transport } = await startHandshakedTransport();

    transport.ingest(JSON.stringify({ kind: "ping" }));
    await flushMicrotasks();

    expect(sink.sent.at(-1)).toEqual({ kind: "pong" });
  });

  test("pong is a no-op", async () => {
    const { fake, sink, transport } = await startHandshakedTransport();
    const sentBefore = sink.sent.length;

    transport.ingest(JSON.stringify({ kind: "pong" }));
    await flushMicrotasks();

    expect(sink.sent).toHaveLength(sentBefore);
    expect(fake.dispatched).toEqual([]);
  });
});

describe("createWsSessionTransport: ingest ordering", () => {
  test("ingest() serializes a slow async authorize: dispatch sees nothing until authorize resolves, the ack is sent[0], and the frame dispatches only after it", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const session = createTestSession({ binding: fake.binding });
    const sink = createFakeSink();
    let resolveAuthorize: (authorized: boolean) => void = () => undefined;
    const transport = createWsSessionTransport({
      authorize: () =>
        new Promise<boolean>((resolve) => {
          resolveAuthorize = resolve;
        }),
      session,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    transport.ingest(
      JSON.stringify({
        frame: { kind: "cancel" },
        kind: "frame",
      })
    );

    // authorize() is still pending: nothing may be sent or dispatched yet.
    await flushMicrotasks();
    expect(sink.sent).toEqual([]);
    expect(fake.dispatched).toEqual([]);

    resolveAuthorize(true);
    await flushMicrotasks();

    expect(sink.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "none",
      sessionId: SESSION_ID,
    });
    expect(fake.dispatched).toEqual([{ kind: "cancel" }]);
  });
});
