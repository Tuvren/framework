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
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
} from "@tuvren/core/capabilities";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  DuplexSessionBinding,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  decodeResumeCursor,
  encodeResumeCursor,
  streamAdapterFixtures,
} from "@tuvren/stream-core";
import {
  createWsSessionTransport,
  type WsSessionTransport,
  type WsSocketSink,
} from "../src/lib/ws-session-transport.js";

const SESSION_ID = "session-under-test";

/** A finite outbound iterable that observes `.return()` calls and closes normally after its frames are exhausted. */
function createFiniteOutboundIterable(frames: SessionOutboundFrame[]): {
  iterable: AsyncIterable<SessionOutboundFrame>;
  returnCallCount: () => number;
} {
  let index = 0;
  let returnCallCount = 0;

  const iterable: AsyncIterable<SessionOutboundFrame> = {
    [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
      return {
        // biome-ignore lint/suspicious/useAwait: intentionally synchronous resolution for deterministic test ordering.
        async next(): Promise<IteratorResult<SessionOutboundFrame>> {
          if (index >= frames.length) {
            return { done: true, value: undefined };
          }

          const value = frames[index] as SessionOutboundFrame;
          index += 1;
          return { done: false, value };
        },
        // biome-ignore lint/suspicious/useAwait: intentionally synchronous resolution for deterministic test ordering.
        async return(): Promise<IteratorResult<SessionOutboundFrame>> {
          returnCallCount += 1;
          index = frames.length;
          return { done: true, value: undefined };
        },
      };
    },
  };

  return { iterable, returnCallCount: () => returnCallCount };
}

/** An outbound iterable that yields its frames and then hangs forever, modeling a still-open live connection until `.return()` releases it. */
function createHangingOutboundIterable(frames: SessionOutboundFrame[]): {
  iterable: AsyncIterable<SessionOutboundFrame>;
  returnCallCount: () => number;
} {
  let index = 0;
  let returnCallCount = 0;

  const iterable: AsyncIterable<SessionOutboundFrame> = {
    [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
      return {
        next(): Promise<IteratorResult<SessionOutboundFrame>> {
          if (index < frames.length) {
            const value = frames[index] as SessionOutboundFrame;
            index += 1;
            return Promise.resolve({ done: false, value });
          }

          return new Promise<IteratorResult<SessionOutboundFrame>>(() => {
            // Never resolves: models an open connection with no more frames yet.
          });
        },
        // biome-ignore lint/suspicious/useAwait: intentionally synchronous resolution for deterministic test ordering.
        async return(): Promise<IteratorResult<SessionOutboundFrame>> {
          returnCallCount += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };

  return { iterable, returnCallCount: () => returnCallCount };
}

const unusedClientEndpoint: AttachedClientEndpoint = {
  advertisedCapabilities: [],
  dispatch(): Promise<never> {
    return Promise.reject(new Error("clientEndpoint.dispatch is unused"));
  },
  endpointId: "unused-endpoint",
};

interface FakeBinding {
  binding: DuplexSessionBinding;
  claimCount: () => number;
  dispatched: unknown[];
  outboundReturnCallCount: () => number;
}

/** A structural fake `DuplexSessionBinding`: records `outbound()` claims and `dispatchInbound()` calls; the transport only relies on the structural contract. */
function createFakeBinding(
  outbound:
    | {
        iterable: AsyncIterable<SessionOutboundFrame>;
        returnCallCount: () => number;
      }
    | undefined,
  sessionId: string = SESSION_ID
): FakeBinding {
  let claimCount = 0;
  const dispatched: unknown[] = [];

  const binding: DuplexSessionBinding = {
    clientEndpoint: unusedClientEndpoint,
    currentHandle(): never {
      throw new Error("currentHandle is unused in these tests");
    },
    dispatchInbound(frame: unknown): void {
      dispatched.push(frame);
    },
    outbound(): AsyncIterable<SessionOutboundFrame> {
      claimCount += 1;
      if (claimCount > 1) {
        throw new Error(
          "outbound() may only be called once per DuplexSessionBinding"
        );
      }

      return outbound?.iterable ?? emptyAsyncIterable();
    },
    sessionId,
  };

  return {
    binding,
    claimCount: () => claimCount,
    dispatched,
    outboundReturnCallCount: () => outbound?.returnCallCount() ?? 0,
  };
}

function emptyAsyncIterable(): AsyncIterable<SessionOutboundFrame> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
      return {
        next(): Promise<IteratorResult<SessionOutboundFrame>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

interface FakeSink extends WsSocketSink {
  closes: Array<{ code: number; reason: string | undefined }>;
  sent: unknown[];
}

function createFakeSink(): FakeSink {
  const sent: unknown[] = [];
  const closes: Array<{ code: number; reason: string | undefined }> = [];

  return {
    close(code: number, reason?: string): void {
      closes.push({ code, reason });
    },
    closes,
    send(data: string): void {
      sent.push(JSON.parse(data));
    },
    sent,
  };
}

/**
 * Flushes the internal ingest promise chain so async processing (including a
 * resolved `authorize`, the handshake/replay sends, and the outbound pump's
 * per-frame sequencer round-trip) completes before assertions run. Each
 * pumped frame costs a handful of microtask hops, so this drains a generous
 * number of microtask turns plus one macrotask turn for good measure.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function handshakeMessage(
  overrides: Partial<{
    authToken: string;
    cursor: string;
    protocolVersion: string;
    sessionId: string;
  }> = {}
): string {
  return JSON.stringify({
    kind: "handshake",
    protocolVersion: "1",
    ...overrides,
  });
}

function eventOutboundFrame(
  event: TuvrenStreamEvent,
  sessionId: string = SESSION_ID
): SessionOutboundFrame {
  return {
    event,
    kind: "event",
    protocolVersion: "1",
    sessionId,
  };
}

function clientInvocationOutboundFrame(
  sessionId: string = SESSION_ID
): SessionOutboundFrame {
  const invocation: ClientInvocationEnvelope = {
    callId: "call-1",
    capabilityId: "capability.example",
    input: { key: "value" },
    leaseToken: "lease-1",
  };

  return {
    invocation,
    kind: "client_invocation",
    protocolVersion: "1",
    sessionId,
  };
}

describe("createWsSessionTransport: claim and lifecycle", () => {
  test("start() claims the outbound stream exactly once, synchronously", () => {
    const { iterable } = createHangingOutboundIterable([]);
    const fake = createFakeBinding({ iterable, returnCallCount: () => 0 });
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink: createFakeSink(),
    });

    expect(fake.claimCount()).toBe(0);
    transport.start();
    expect(fake.claimCount()).toBe(1);
  });

  test("a second start() throws", () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink: createFakeSink(),
    });

    transport.start();
    expect(() => transport.start()).toThrow();
  });

  test("ingest() before start() throws", () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink: createFakeSink(),
    });

    expect(() => transport.ingest(handshakeMessage())).toThrow();
  });

  test("transport.close() releases the outbound iterator", async () => {
    const outbound = createHangingOutboundIterable([]);
    const fake = createFakeBinding(outbound);
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

    transport.start();
    expect(outbound.returnCallCount()).toBe(0);

    transport.close();
    await flushMicrotasks();

    expect(outbound.returnCallCount()).toBe(1);
    expect(sink.closes).toEqual([{ code: 1000, reason: undefined }]);
  });
});

describe("createWsSessionTransport: happy path", () => {
  async function startHandshakedTransport(
    outboundFrames: SessionOutboundFrame[]
  ): Promise<{
    fake: FakeBinding;
    sink: FakeSink;
    transport: WsSessionTransport;
  }> {
    const fake = createFakeBinding(
      createFiniteOutboundIterable(outboundFrames)
    );
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    return { fake, sink, transport };
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

  test("normal outbound completion closes with 1000", async () => {
    const { sink } = await startHandshakedTransport([]);

    expect(sink.closes).toEqual([{ code: 1000, reason: "session ended" }]);
  });
});

describe("createWsSessionTransport: resume path", () => {
  test("resumed status replays retained frames after the ack and before live frames", async () => {
    const replayBuffer = createReplayBuffer({ capacity: 100 });
    const sourceEvents = streamAdapterFixtures.completedTurn;

    // Feed the fixture through the same kind of sequencer the transport uses
    // internally, recording every sequenced frame into the replay buffer —
    // mirroring the ADR-061 one-sequencer-instance wiring rule.
    const sequenced = createSequencedTuvrenStreamEvents(
      // biome-ignore lint/suspicious/useAwait: async generators must remain async even when fixture production is synchronous.
      (async function* () {
        for (const event of sourceEvents) {
          yield event;
        }
      })()
    );

    const recorded: Array<{ cursor: string; sequence: number }> = [];
    for await (const frame of sequenced) {
      replayBuffer.record(frame);
      recorded.push({ cursor: frame.cursor, sequence: frame.sequence });
    }

    // Resume from partway through the turn (after the second recorded frame).
    const resumeCursor = recorded[1]?.cursor as string;

    const liveEvent: TuvrenStreamEvent = {
      threadId: "thread-live",
      timestamp: 100,
      turnId: "turn-live",
      type: "turn.start",
    };
    const outboundFrames = [eventOutboundFrame(liveEvent)];

    const fake = createFakeBinding(
      createFiniteOutboundIterable(outboundFrames)
    );
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      replayBuffer,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage({ cursor: resumeCursor }));
    await flushMicrotasks();

    expect(sink.sent[0]).toEqual({
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "resumed",
      sessionId: SESSION_ID,
    });

    // Replayed frames (strictly after the cursor position) come next, in
    // order, before the live frame.
    const replayedCount = sourceEvents.length - 2;
    const replayedMessages = sink.sent.slice(1, 1 + replayedCount) as Array<{
      cursor: string;
      frame: { kind: string };
      kind: "frame";
    }>;

    expect(replayedMessages).toHaveLength(replayedCount);
    replayedMessages.forEach((message, index) => {
      expect(message.cursor).toBe(recorded[2 + index]?.cursor);
      expect(message.frame.kind).toBe("event");
    });

    const liveMessage = sink.sent.at(-1) as {
      frame: SessionOutboundFrame;
      kind: "frame";
    };
    expect(liveMessage.frame).toEqual(outboundFrames[0]);
  });

  test("a cursor with no replay buffer configured resolves resumeStatus out-of-window", async () => {
    const fake = createFakeBinding(createFiniteOutboundIterable([]));
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

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

  test("a foreign-turn cursor with a replay buffer resolves resumeStatus unknown-turn", async () => {
    const replayBuffer = createReplayBuffer({ capacity: 100 });
    const sequenced = createSequencedTuvrenStreamEvents(
      // biome-ignore lint/suspicious/useAwait: async generators must remain async even when fixture production is synchronous.
      (async function* () {
        for (const event of streamAdapterFixtures.completedTurn) {
          yield event;
        }
      })()
    );

    for await (const frame of sequenced) {
      replayBuffer.record(frame);
    }

    const foreignCursor = encodeResumeCursor({
      sequence: 0,
      turnId: "turn-never-seen",
      v: 1,
    });

    const fake = createFakeBinding(createFiniteOutboundIterable([]));
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      replayBuffer,
      sink,
    });

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
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

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
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage({ protocolVersion: "2" }));
    await flushMicrotasks();

    expect(sink.closes).toEqual([
      { code: 4001, reason: 'unsupported handshake protocolVersion "2"' },
    ]);
  });

  test("a mismatched sessionId closes with 4002", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

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

  test("authorize resolving false (async) closes with 4003", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      authorize: async (authToken) => {
        await Promise.resolve();
        return authToken === "the-right-token";
      },
      binding: fake.binding,
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
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      authorize: async (authToken) => {
        await Promise.resolve();
        return authToken === "the-right-token";
      },
      binding: fake.binding,
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
    fake: FakeBinding;
    sink: FakeSink;
    transport: WsSessionTransport;
  }> {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    return { fake, sink, transport };
  }

  test("a frame envelope's inner frame reaches dispatchInbound verbatim", async () => {
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

  test("a malformed post-handshake message reaches dispatchInbound and does not close the socket", async () => {
    const { fake, sink, transport } = await startHandshakedTransport();

    transport.ingest("{not json");
    await flushMicrotasks();

    expect(fake.dispatched).toEqual(["{not json"]);
    expect(sink.closes).toEqual([]);
  });

  test("an unrecognized-kind post-handshake message reaches dispatchInbound and does not close the socket", async () => {
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

describe("createWsSessionTransport: M6 review carry-overs", () => {
  test("a second transport over the same replay buffer resumes with the pump-recorded tail (pins runOutboundPump's record() call)", async () => {
    // Deliberately do NOT pre-record anything manually: the replay buffer is
    // fed only by the first transport's own outbound pump, so deleting the
    // pump's `options.replayBuffer?.record(envelope)` call must fail this
    // test.
    const replayBuffer = createReplayBuffer({ capacity: 100 });
    const sourceEvents = streamAdapterFixtures.completedTurn;
    const outboundFrames = sourceEvents.map((event) =>
      eventOutboundFrame(event)
    );

    const fakeOne = createFakeBinding(
      createFiniteOutboundIterable(outboundFrames)
    );
    const sinkOne = createFakeSink();
    const transportOne = createWsSessionTransport({
      binding: fakeOne.binding,
      replayBuffer,
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

    // Resume from partway through the first transport's own sent envelopes.
    const resumeCursor = sentFrameMessages[1]?.cursor as string;
    const expectedTail = sentFrameMessages.slice(2);

    const fakeTwo = createFakeBinding(createFiniteOutboundIterable([]));
    const sinkTwo = createFakeSink();
    const transportTwo = createWsSessionTransport({
      binding: fakeTwo.binding,
      replayBuffer,
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
      expect(message.cursor).toBe(expectedTail[index]?.cursor);
      expect(message.frame).toEqual(expectedTail[index]?.frame);
    });
  });

  test("an outbound iterable whose next() rejects reports ws_transport_outbound_pump_failed and closes with 1011", async () => {
    const failure = new Error("outbound iterable exploded");
    const rejectingIterable: AsyncIterable<SessionOutboundFrame> = {
      [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
        return {
          next(): Promise<IteratorResult<SessionOutboundFrame>> {
            return Promise.reject(failure);
          },
        };
      },
    };

    const fake = createFakeBinding({
      iterable: rejectingIterable,
      returnCallCount: () => 0,
    });
    const sink = createFakeSink();
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      binding: fake.binding,
      onWarning: (warning) => warnings.push(warning.code),
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(warnings).toContain("ws_transport_outbound_pump_failed");
    expect(sink.closes).toEqual([{ code: 1011, reason: "internal error" }]);
  });

  test("ingest() serializes a slow async authorize: dispatchInbound sees nothing until authorize resolves, the ack is sent[0], and the frame dispatches only after it", async () => {
    const fake = createFakeBinding(createHangingOutboundIterable([]));
    const sink = createFakeSink();
    let resolveAuthorize: (authorized: boolean) => void = () => undefined;
    const transport = createWsSessionTransport({
      authorize: () =>
        new Promise<boolean>((resolve) => {
          resolveAuthorize = resolve;
        }),
      binding: fake.binding,
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
