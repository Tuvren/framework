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

/**
 * Shared structural fakes for the `@tuvren/stream-ws` test suite (ADR-063
 * composition: `binding → session → transport → socket`). These are plain
 * structural doubles, not `bun:test` test files — nothing here is a `test()`
 * or `describe()` block.
 */

import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
} from "@tuvren/core/capabilities";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ExecutionHandle, ExecutionResult } from "@tuvren/core/execution";
import {
  createDuplexSessionBinding,
  type DuplexSessionBinding,
  type SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  createRemoteClientSession,
  type RemoteClientSession,
  type RemoteClientSessionOptions,
  type RemoteClientSessionSink,
} from "@tuvren/remote-session";
import type { WsSocketSink } from "../src/lib/ws-session-transport.js";

export const SESSION_ID = "session-under-test";

const unusedClientEndpoint: AttachedClientEndpoint = {
  advertisedCapabilities: [],
  dispatch(): Promise<never> {
    return Promise.reject(new Error("clientEndpoint.dispatch is unused"));
  },
  endpointId: "unused-endpoint",
};

export interface FakeBinding {
  binding: DuplexSessionBinding;
  claimCount: () => number;
  dispatched: unknown[];
  outboundReturnCallCount: () => number;
}

/** A finite outbound iterable that observes `.return()` calls and closes normally after its frames are exhausted. */
export function createFiniteOutboundIterable(frames: SessionOutboundFrame[]): {
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
export function createHangingOutboundIterable(
  frames: SessionOutboundFrame[] = []
): {
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

export function emptyAsyncIterable(): AsyncIterable<SessionOutboundFrame> {
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

/** A structural fake `DuplexSessionBinding`: records `outbound()` claims and `dispatchInbound()` calls; the session (and, transitively, the transport under test) only relies on the structural contract. */
export function createFakeBinding(
  outbound?: {
    iterable: AsyncIterable<SessionOutboundFrame>;
    returnCallCount: () => number;
  },
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

/** Builds a {@link RemoteClientSession} over a fake binding with test-friendly defaults (generous grace/timeout so they never fire incidentally; override per test as needed). */
export function createTestSession(
  overrides: Partial<RemoteClientSessionOptions> & {
    binding: DuplexSessionBinding;
  }
): RemoteClientSession {
  return createRemoteClientSession({
    disconnectGraceMs: 10_000,
    dispatchTimeoutMs: 10_000,
    replayBufferCapacity: 100,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// A real DuplexSessionBinding over a fake ExecutionHandle, for the one test
// scenario that needs a genuine client_invocation/client_result round trip
// (redelivery on reattach). Trimmed from
// typescript/host/remote-session/test/remote-client-session.test.ts's own
// fake: only a controllable events() source is needed, never
// resolveApproval/steer/cancel, and awaitResult() never settles on its own.
// ---------------------------------------------------------------------------

interface FakeEvent {
  turnId?: string;
  type: string;
  [key: string]: unknown;
}

export class FakeEventSource implements AsyncIterable<FakeEvent> {
  private claimed = false;
  private readonly closed = false;
  private readonly items: FakeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<FakeEvent>) => void> =
    [];

  push(event: FakeEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: event });
      return;
    }
    this.items.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<FakeEvent> {
    if (this.claimed) {
      throw new Error("FakeEventSource consumed twice");
    }
    this.claimed = true;
    return {
      next: (): Promise<IteratorResult<FakeEvent>> => {
        const value = this.items.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export function createFakeExecutionHandle(): {
  events: FakeEventSource;
  handle: ExecutionHandle;
} {
  const events = new FakeEventSource();
  const neverSettles = new Promise<ExecutionResult>(() => undefined);
  neverSettles.catch(() => undefined);

  const handle = {
    awaitResult: () => neverSettles,
    cancel: () => undefined,
    events: () => events,
    resolveApproval: () => {
      throw new Error("resolveApproval not used in this suite");
    },
    status: () => ({ iterationCount: 0, phase: "running" as const }),
    steer: () => undefined,
  } as unknown as ExecutionHandle;

  return { events, handle };
}

/** A real `DuplexSessionBinding` (packet `tuvren.framework.host-session`) over a fake `ExecutionHandle`, for tests that need genuine `clientEndpoint.dispatch()` / `client_result` round trips rather than a structural outbound-frame fake. */
export function createRealBinding(sessionId: string = SESSION_ID): {
  binding: DuplexSessionBinding;
  events: FakeEventSource;
} {
  const { events, handle } = createFakeExecutionHandle();
  const binding = createDuplexSessionBinding(handle, { sessionId });
  return { binding, events };
}

/** A bare `RemoteClientSessionSink` fake for tests that attach directly to a session (bypassing the WS transport entirely) to prime its replay buffer or observe raw session frames. */
export interface FakeSessionSink extends RemoteClientSessionSink {
  sent: Array<{ cursor: string | undefined; frame: SessionOutboundFrame }>;
}

export function createFakeSessionSink(): FakeSessionSink {
  const sent: Array<{
    cursor: string | undefined;
    frame: SessionOutboundFrame;
  }> = [];
  return {
    send(frame: SessionOutboundFrame, cursor?: string): void {
      sent.push({ cursor, frame });
    },
    sent,
  };
}

export interface FakeSink extends WsSocketSink {
  closes: Array<{ code: number; reason: string | undefined }>;
  sent: unknown[];
}

export function createFakeSink(): FakeSink {
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
export function createScriptedBufferedAmountSink(script: number[]): FakeSink {
  const sink = createFakeSink();
  let index = 0;

  sink.bufferedAmount = (): number => {
    const value = script[Math.min(index, script.length - 1)] as number;
    index += 1;
    return value;
  };

  return sink;
}

/**
 * Flushes the internal ingest promise chain so async processing (including a
 * resolved `authorize`, the handshake/replay sends, and any pending
 * microtask hops from the underlying session's own event pump) completes
 * before assertions run.
 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function handshakeMessage(
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

export function eventOutboundFrame(
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

export function clientInvocationOutboundFrame(
  sessionId: string = SESSION_ID,
  overrides: Partial<ClientInvocationEnvelope> = {}
): SessionOutboundFrame {
  const invocation: ClientInvocationEnvelope = {
    callId: "call-1",
    capabilityId: "capability.example",
    input: { key: "value" },
    leaseToken: "lease-1",
    ...overrides,
  };

  return {
    invocation,
    kind: "client_invocation",
    protocolVersion: "1",
    sessionId,
  };
}
