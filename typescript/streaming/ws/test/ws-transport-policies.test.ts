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
import type {
  DuplexSessionBinding,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  streamAdapterFixtures,
} from "@tuvren/stream-core";
import {
  createWsSessionTransport,
  type WsSocketSink,
} from "../src/lib/ws-session-transport.js";

const SESSION_ID = "session-under-test";

const unusedClientEndpoint: AttachedClientEndpoint = {
  advertisedCapabilities: [],
  dispatch(): Promise<never> {
    return Promise.reject(new Error("clientEndpoint.dispatch is unused"));
  },
  endpointId: "unused-endpoint",
};

interface FakeBinding {
  binding: DuplexSessionBinding;
  dispatched: unknown[];
}

/** A structural fake `DuplexSessionBinding` whose outbound stream hangs forever (models an open live connection with no more frames yet). */
function createFakeBinding(
  outboundFrames: SessionOutboundFrame[] = []
): FakeBinding {
  const dispatched: unknown[] = [];
  let index = 0;
  let claimed = false;

  const binding: DuplexSessionBinding = {
    clientEndpoint: unusedClientEndpoint,
    currentHandle(): never {
      throw new Error("currentHandle is unused in these tests");
    },
    dispatchInbound(frame: unknown): void {
      dispatched.push(frame);
    },
    outbound(): AsyncIterable<SessionOutboundFrame> {
      if (claimed) {
        throw new Error(
          "outbound() may only be called once per DuplexSessionBinding"
        );
      }
      claimed = true;

      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
          return {
            next(): Promise<IteratorResult<SessionOutboundFrame>> {
              if (index < outboundFrames.length) {
                const value = outboundFrames[index] as SessionOutboundFrame;
                index += 1;
                return Promise.resolve({ done: false, value });
              }

              return new Promise<IteratorResult<SessionOutboundFrame>>(() => {
                // Never resolves: models a still-open connection.
              });
            },
            // biome-ignore lint/suspicious/useAwait: intentionally synchronous resolution.
            async return(): Promise<IteratorResult<SessionOutboundFrame>> {
              index = outboundFrames.length;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    sessionId: SESSION_ID,
  };

  return { binding, dispatched };
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

/** A fake sink whose `bufferedAmount()` is scripted call-by-call; the last scripted value repeats once the script is exhausted. */
function createScriptedBufferedAmountSink(script: number[]): FakeSink {
  const sink = createFakeSink();
  let index = 0;

  sink.bufferedAmount = (): number => {
    const value = script[Math.min(index, script.length - 1)] as number;
    index += 1;
    return value;
  };

  return sink;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

function clientInvocationOutboundFrame(): SessionOutboundFrame {
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
    sessionId: SESSION_ID,
  };
}

describe("createWsSessionTransport: option validation", () => {
  test("heartbeat.intervalMs must be a positive finite number", () => {
    const fake = createFakeBinding();
    expect(() =>
      createWsSessionTransport({
        binding: fake.binding,
        heartbeat: { intervalMs: 0, timeoutMs: 10 },
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        binding: fake.binding,
        heartbeat: { intervalMs: -5, timeoutMs: 10 },
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        binding: fake.binding,
        heartbeat: { intervalMs: Number.POSITIVE_INFINITY, timeoutMs: 10 },
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
  });

  test("heartbeat.timeoutMs must be a positive finite number", () => {
    const fake = createFakeBinding();
    expect(() =>
      createWsSessionTransport({
        binding: fake.binding,
        heartbeat: { intervalMs: 10, timeoutMs: 0 },
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        binding: fake.binding,
        heartbeat: { intervalMs: 10, timeoutMs: Number.NaN },
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
  });

  test("heartbeat.timeoutMs may be less than, equal to, or greater than intervalMs", () => {
    const fakeLess = createFakeBinding();
    expect(() =>
      createWsSessionTransport({
        binding: fakeLess.binding,
        heartbeat: { intervalMs: 20, timeoutMs: 5 },
        sink: createFakeSink(),
      })
    ).not.toThrow();

    const fakeEqual = createFakeBinding();
    expect(() =>
      createWsSessionTransport({
        binding: fakeEqual.binding,
        heartbeat: { intervalMs: 20, timeoutMs: 20 },
        sink: createFakeSink(),
      })
    ).not.toThrow();

    const fakeGreater = createFakeBinding();
    expect(() =>
      createWsSessionTransport({
        binding: fakeGreater.binding,
        heartbeat: { intervalMs: 20, timeoutMs: 60 },
        sink: createFakeSink(),
      })
    ).not.toThrow();
  });

  test("backpressure.maxBufferedBytes must be a positive finite number", () => {
    const fake = createFakeBinding();
    expect(() =>
      createWsSessionTransport({
        backpressure: { maxBufferedBytes: 0 },
        binding: fake.binding,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        backpressure: { maxBufferedBytes: -1 },
        binding: fake.binding,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
    expect(() =>
      createWsSessionTransport({
        backpressure: { maxBufferedBytes: Number.POSITIVE_INFINITY },
        binding: fake.binding,
        sink: createFakeSink(),
      })
    ).toThrow(RangeError);
  });
});

describe("createWsSessionTransport: heartbeat / half-open detection", () => {
  const INTERVAL_MS = 15;
  const TIMEOUT_MS = 40;

  test("a silent peer is closed with 4004 and the timeout warning after no inbound activity", async () => {
    const fake = createFakeBinding();
    const sink = createFakeSink();
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      binding: fake.binding,
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
      onWarning: (warning) => warnings.push(warning.code),
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
    const fake = createFakeBinding();
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
      binding: fake.binding,
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
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
  });

  test("inbound frame traffic (not only pong) counts as heartbeat liveness", async () => {
    const fake = createFakeBinding();
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
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
    const fake = createFakeBinding();
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS },
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
    const fake = createFakeBinding();
    const sink = createFakeSink();
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

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
    const fake = createFakeBinding([invocationFrame]);
    // handshake_ack read is not scripted against the budget (no pump send
    // yet); the pump's first send reads a bufferedAmount over budget.
    const sink = createScriptedBufferedAmountSink([500]);
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 100 },
      binding: fake.binding,
      onWarning: (warning) => warnings.push(warning.code),
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
    // Prime a replay buffer the same way the "resume path" tests in
    // ws-session-transport.test.ts do, so the handshake's replay loop has
    // frames to send.
    const replayBuffer = createReplayBuffer({ capacity: 100 });
    const sourceEvents = streamAdapterFixtures.completedTurn;
    const sequenced = createSequencedTuvrenStreamEvents(
      // biome-ignore lint/suspicious/useAwait: async generators must remain async even when fixture production is synchronous.
      (async function* () {
        for (const event of sourceEvents) {
          yield event;
        }
      })()
    );

    const recorded: Array<{ cursor: string }> = [];
    for await (const frame of sequenced) {
      replayBuffer.record(frame);
      recorded.push({ cursor: frame.cursor });
    }

    const fake = createFakeBinding([]);
    const sink = createScriptedBufferedAmountSink([500]);
    const warnings: string[] = [];
    const transport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 100 },
      binding: fake.binding,
      onWarning: (warning) => warnings.push(warning.code),
      replayBuffer,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage({ cursor: recorded[0]?.cursor }));
    await flushMicrotasks();

    // Only the handshake_ack was sent before the replay loop's own
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
    const fake = createFakeBinding([invocationFrame]);
    const sink = createFakeSink(); // no bufferedAmount()
    const transport = createWsSessionTransport({
      backpressure: { maxBufferedBytes: 1 },
      binding: fake.binding,
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
    const fake = createFakeBinding([invocationFrame]);
    const sink = createScriptedBufferedAmountSink([1_000_000]);
    const transport = createWsSessionTransport({
      binding: fake.binding,
      sink,
    });

    transport.start();
    transport.ingest(handshakeMessage());
    await flushMicrotasks();

    expect(sink.closes).toEqual([]);
    const frameMessage = sink.sent[1] as { frame: SessionOutboundFrame };
    expect(frameMessage.frame).toEqual(invocationFrame);
  });
});
