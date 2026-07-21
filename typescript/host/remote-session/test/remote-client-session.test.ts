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
import type { ExecutionHandle, ExecutionResult } from "@tuvren/core/execution";
import {
  createDuplexSessionBinding,
  type DuplexSessionBinding,
  type SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  decodeResumeCursor,
  type StreamAdapterWarning,
} from "@tuvren/stream-core";
import {
  createRemoteClientSession,
  type RemoteClientSessionOptions,
  type RemoteClientSessionSink,
  type RemoteSessionClock,
} from "../src/lib/remote-client-session.ts";

// ---------------------------------------------------------------------------
// Fake ExecutionHandle double (trimmed from typescript/host/session's own
// test fake: this suite only needs a controllable events() source, never
// resolveApproval/steer/cancel, and an awaitResult() that never settles on
// its own — termination-by-awaitResult is host-session's own concern).
// ---------------------------------------------------------------------------

interface FakeEvent {
  turnId?: string;
  type: string;
  [key: string]: unknown;
}

class FakeEventSource implements AsyncIterable<FakeEvent> {
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

function makeFakeHandle(): {
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

// ---------------------------------------------------------------------------
// Fake sink and clock
// ---------------------------------------------------------------------------

interface SentFrame {
  cursor: string | undefined;
  frame: SessionOutboundFrame;
}

function createFakeSink(): RemoteClientSessionSink & { sent: SentFrame[] } {
  const sent: SentFrame[] = [];
  return {
    sent,
    send(frame: SessionOutboundFrame, cursor?: string): void {
      sent.push({ cursor, frame });
    },
  };
}

/** A deterministic, test-controlled substitute for {@link RemoteSessionClock}: timers only fire when the test explicitly calls {@link fireOldest}. */
function createFakeClock(): {
  clock: RemoteSessionClock;
  fireOldest(): void;
  pendingCount(): number;
} {
  let nextId = 0;
  const timers = new Map<number, () => void>();

  const clock: RemoteSessionClock = {
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    scheduleTimeout(callback: () => void, _ms: number): unknown {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
  };

  return {
    clock,
    fireOldest(): void {
      const ids = [...timers.keys()].sort((a, b) => a - b);
      const id = ids[0];
      if (id === undefined) {
        throw new Error("createFakeClock.fireOldest: no pending timer");
      }
      const callback = timers.get(id);
      timers.delete(id);
      callback?.();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** Drains pending microtask continuations of the session's internal pump loop without any real (wall-clock) wait. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function setup(overrides: Partial<RemoteClientSessionOptions> = {}) {
  const { events, handle } = makeFakeHandle();
  const binding = createDuplexSessionBinding(handle, {
    sessionId: "sess-remote-1",
  });
  const fakeClock = createFakeClock();
  const warnings: StreamAdapterWarning[] = [];

  const session = createRemoteClientSession({
    binding,
    clock: fakeClock.clock,
    disconnectGraceMs: 1000,
    dispatchTimeoutMs: 500,
    onWarning: (warning) => warnings.push(warning),
    replayBufferCapacity: 50,
    ...overrides,
  });

  return { binding, events, fakeClock, session, warnings };
}

function resultContentCode(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) {
    return undefined;
  }
  const code = (content as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRemoteClientSession", () => {
  test("reattach continues sequence numbering across two sinks (no restart at 0)", async () => {
    const { events, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    events.push({ turnId: "t1", type: "turn.start" });
    await flush();
    events.push({ turnId: "t1", type: "message.delta" });
    await flush();

    expect(sink1.sent).toHaveLength(2);
    const lastCursor = sink1.sent[1]?.cursor;
    expect(lastCursor).toBeDefined();
    expect(decodeResumeCursor(lastCursor as string)?.sequence).toBe(1);

    session.detach();

    // Recorded into the shared replay buffer even while no sink is attached.
    events.push({ turnId: "t1", type: "message.delta" });
    await flush();

    const sink2 = createFakeSink();
    const { resumeStatus } = session.attach(sink2, {
      cursor: lastCursor as string,
    });

    expect(resumeStatus).toBe("resumed");
    expect(sink2.sent).toHaveLength(1);
    expect(decodeResumeCursor(sink2.sent[0]?.cursor as string)?.sequence).toBe(
      2
    );

    events.push({ turnId: "t1", type: "message.delta" });
    await flush();

    expect(sink2.sent).toHaveLength(2);
    expect(decodeResumeCursor(sink2.sent[1]?.cursor as string)?.sequence).toBe(
      3
    );
  });

  test("redelivers an unanswered client_invocation on reattach but never redelivers a session_rejection", async () => {
    const { binding, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-1",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-1",
    });
    dispatchPromise.catch(() => undefined);
    await flush();

    // A structurally invalid inbound frame produces a session_rejection.
    session.dispatchInbound({ nonsense: true });
    await flush();

    expect(
      sink1.sent.filter((s) => s.frame.kind === "client_invocation")
    ).toHaveLength(1);
    expect(
      sink1.sent.filter((s) => s.frame.kind === "session_rejection")
    ).toHaveLength(1);

    session.detach();
    const sink2 = createFakeSink();
    session.attach(sink2);
    await flush();

    expect(
      sink2.sent.filter((s) => s.frame.kind === "client_invocation")
    ).toHaveLength(1);
    expect(
      sink2.sent.filter((s) => s.frame.kind === "session_rejection")
    ).toHaveLength(0);
  });

  test("grace-window expiry settles a pending dispatch with capability_binding_unavailable", async () => {
    const { binding, fakeClock, session } = setup({ disconnectGraceMs: 1000 });
    const sink1 = createFakeSink();
    session.attach(sink1);

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-2",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-2",
    });
    await flush();

    session.detach();
    // Only the grace timer is pending now (the dispatch timer was suspended
    // by detach()); firing it is the grace-window expiry.
    expect(fakeClock.pendingCount()).toBe(1);
    fakeClock.fireOldest();

    const result = await dispatchPromise;
    expect(result.isError).toBe(true);
    expect(result.leaseToken).toBe("lease-2");
    expect(resultContentCode(result.content)).toBe(
      "capability_binding_unavailable"
    );
    expect(session.isEnded()).toBe(true);
  });

  test("dispatch timeout settles with capability_dispatch_timeout; the clock is suspended while detached and restarted on redelivery", async () => {
    const { binding, fakeClock, session } = setup({
      disconnectGraceMs: 100_000,
      dispatchTimeoutMs: 500,
    });
    const sink1 = createFakeSink();
    session.attach(sink1);

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-3",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-3",
    });
    dispatchPromise.catch(() => undefined);
    await flush();

    // The dispatch timer is armed while a sink is attached.
    expect(fakeClock.pendingCount()).toBe(1);

    session.detach();
    // The dispatch timer was suspended; only the (much longer) grace timer
    // is pending now, so the dispatch clock cannot expire while detached.
    expect(fakeClock.pendingCount()).toBe(1);

    const sink2 = createFakeSink();
    session.attach(sink2);
    // Reattach cancels the grace timer and re-arms a fresh, full-budget
    // dispatch timer for the redelivered invocation.
    expect(fakeClock.pendingCount()).toBe(1);

    fakeClock.fireOldest();

    const result = await dispatchPromise;
    expect(result.isError).toBe(true);
    expect(result.leaseToken).toBe("lease-3");
    expect(resultContentCode(result.content)).toBe(
      "capability_dispatch_timeout"
    );
  });

  test("a second concurrent attach is a programming error", () => {
    const { session } = setup();
    session.attach(createFakeSink());
    expect(() => session.attach(createFakeSink())).toThrow();
  });

  test("cursor replay across a reconnect delivers the missed sequenced events from the shared buffer", async () => {
    const { events, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    events.push({ turnId: "t1", type: "turn.start" });
    await flush();
    events.push({ turnId: "t1", type: "message.delta", text: "a" });
    await flush();

    const cursorAfterFirstDelta = sink1.sent[1]?.cursor as string;
    session.detach();

    events.push({ turnId: "t1", type: "message.delta", text: "b" });
    await flush();
    events.push({ turnId: "t1", type: "message.delta", text: "c" });
    await flush();

    const sink2 = createFakeSink();
    const { resumeStatus } = session.attach(sink2, {
      cursor: cursorAfterFirstDelta,
    });

    expect(resumeStatus).toBe("resumed");
    expect(sink2.sent).toHaveLength(2);
    expect(sink2.sent.every((s) => s.frame.kind === "event")).toBe(true);
    const texts = sink2.sent.map((s) =>
      s.frame.kind === "event"
        ? (s.frame.event as unknown as { text: string }).text
        : undefined
    );
    expect(texts).toEqual(["b", "c"]);
  });

  test("lazy-start: constructing without attaching never claims outbound() and starts no timers", () => {
    const { handle } = makeFakeHandle();
    const realBinding = createDuplexSessionBinding(handle, {
      sessionId: "sess-lazy",
    });
    let outboundClaims = 0;
    const wrappedBinding: DuplexSessionBinding = {
      ...realBinding,
      outbound: () => {
        outboundClaims += 1;
        return realBinding.outbound();
      },
    };
    const fakeClock = createFakeClock();

    createRemoteClientSession({
      binding: wrappedBinding,
      clock: fakeClock.clock,
      disconnectGraceMs: 1000,
      dispatchTimeoutMs: 500,
      replayBufferCapacity: 10,
    });

    expect(outboundClaims).toBe(0);
    expect(fakeClock.pendingCount()).toBe(0);
  });

  test("inbound frames are refused while unattached, both before the first attach and after a detach", () => {
    const { handle } = makeFakeHandle();
    const realBinding = createDuplexSessionBinding(handle, {
      sessionId: "sess-refuse",
    });
    let dispatchInboundCalls = 0;
    const wrappedBinding: DuplexSessionBinding = {
      ...realBinding,
      dispatchInbound: (frame: unknown) => {
        dispatchInboundCalls += 1;
        realBinding.dispatchInbound(frame);
      },
    };
    const warnings: StreamAdapterWarning[] = [];

    const session = createRemoteClientSession({
      binding: wrappedBinding,
      disconnectGraceMs: 1000,
      dispatchTimeoutMs: 500,
      onWarning: (warning) => warnings.push(warning),
      replayBufferCapacity: 10,
    });

    const cancelFrame = {
      correlationId: "c1",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: "sess-refuse",
    };

    // Before any attach.
    session.dispatchInbound(cancelFrame);
    expect(dispatchInboundCalls).toBe(0);

    session.attach(createFakeSink());
    session.detach();

    // After a detach, with no sink currently attached.
    session.dispatchInbound(cancelFrame);
    expect(dispatchInboundCalls).toBe(0);

    // createStreamAdapterWarningReporter deduplicates by code (one report per
    // distinct code per reporter lifetime), so both refusals above surface as
    // exactly one warning; dispatchInboundCalls staying at 0 across both
    // calls is the authoritative signal that each was actually refused.
    expect(
      warnings.filter(
        (w) => w.code === "remote_session_inbound_while_unattached"
      ).length
    ).toBe(1);
  });

  test("disconnectGraceMs of 0 reproduces immediate-detach semantics: no grace timer, pending dispatch settles at once", async () => {
    const { binding, fakeClock, session } = setup({ disconnectGraceMs: 0 });
    session.attach(createFakeSink());

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-zero-grace",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-zg",
    });
    await flush();

    session.detach();

    // No timer was ever scheduled for the grace window (the dispatch timer
    // was suspended by detach before endSession released it); the session is
    // already ended and the dispatch already settled.
    expect(fakeClock.pendingCount()).toBe(0);
    expect(session.isEnded()).toBe(true);
    const result = await dispatchPromise;
    expect(result.isError).toBe(true);
    expect(resultContentCode(result.content)).toBe(
      "capability_binding_unavailable"
    );
  });

  test("close() settles tracked dispatches, releases the outbound claim, and makes new dispatches fail fast instead of hanging", async () => {
    const { binding, fakeClock, session } = setup();
    session.attach(createFakeSink());

    const trackedDispatch = binding.clientEndpoint.dispatch({
      callId: "call-before-close",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-bc",
    });
    await flush();

    session.close("host is done with this session");
    await flush();

    // The tracked dispatch settles with the session's well-shaped result, not
    // the binding sweep's rejection: the settle loop runs before the claimed
    // outbound() iterator is released.
    const settled = await trackedDispatch;
    expect(settled.isError).toBe(true);
    expect(resultContentCode(settled.content)).toBe(
      "capability_binding_unavailable"
    );
    expect(fakeClock.pendingCount()).toBe(0);

    // Releasing the iterator drove the binding's queue terminal, so a NEW
    // dispatch after close() is refused immediately by the binding itself
    // (duplex_session_closed) rather than parked forever against a dead link.
    await expect(
      binding.clientEndpoint.dispatch({
        callId: "call-after-close",
        capabilityId: "cap-1",
        input: {},
        leaseToken: "lease-ac",
      })
    ).rejects.toMatchObject({ code: "duplex_session_closed" });
  });

  test("a malformed callId-bearing client_result does not clear redelivery tracking or the dispatch timer", async () => {
    const { binding, fakeClock, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-orphan",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-or",
    });
    dispatchPromise.catch(() => undefined);
    await flush();
    expect(fakeClock.pendingCount()).toBe(1);

    // Names the tracked callId but is missing leaseToken and content, so the
    // binding rejects it as session_frame_invalid without settling anything.
    // If the session treated it as settleable it would delete the pending
    // entry and its timer, leaving the dispatch owed by no one — the hung
    // tool call ADR-062 §6 exists to eliminate.
    session.dispatchInbound({
      correlationId: "corr-malformed",
      kind: "client_result",
      protocolVersion: "1",
      result: { callId: "call-orphan" },
      sessionId: "sess-remote-1",
    });
    await flush();

    // The dispatch timer is still armed, and the malformed frame drew a
    // session_rejection from the binding.
    expect(fakeClock.pendingCount()).toBe(1);
    expect(
      sink1.sent.filter((s) => s.frame.kind === "session_rejection")
    ).toHaveLength(1);

    // The invocation is still owed redelivery on reattach.
    session.detach();
    const sink2 = createFakeSink();
    session.attach(sink2);
    expect(
      sink2.sent.filter((s) => s.frame.kind === "client_invocation")
    ).toHaveLength(1);

    // And the re-armed timer still settles it if the peer stays quiet.
    fakeClock.fireOldest();
    const result = await dispatchPromise;
    expect(result.isError).toBe(true);
    expect(resultContentCode(result.content)).toBe(
      "capability_dispatch_timeout"
    );
  });
});
