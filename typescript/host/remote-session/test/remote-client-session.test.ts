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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ExecutionHandle, ExecutionResult } from "@tuvren/core/execution";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import type {
  DuplexSessionBinding,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import { decodeResumeCursor } from "@tuvren/stream-core";
import type { StreamAdapterWarning } from "@tuvren/stream-core";

import { createRemoteClientSession } from "../src/lib/remote-client-session.ts";
import type {
  RemoteClientSessionOptions,
  RemoteClientSessionSink,
  RemoteSessionClock,
} from "../src/lib/remote-client-session.ts";

// ---------------------------------------------------------------------------
// Fake ExecutionHandle double (trimmed from typescript/host/session's own
// test fake: this suite only needs a controllable events() source, never
// resolveApproval/steer/cancel, and an awaitResult() that never settles on
// its own — termination-by-awaitResult is host-session's own concern).
// ---------------------------------------------------------------------------

class FakeEventSource implements AsyncIterable<TuvrenStreamEvent> {
  private claimed = false;
  private readonly closed = false;
  private readonly items: TuvrenStreamEvent[] = [];
  private readonly waiters: ((
    result: IteratorResult<TuvrenStreamEvent>
  ) => void)[] = [];

  push(event: TuvrenStreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: event });
      return;
    }
    this.items.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<TuvrenStreamEvent> {
    if (this.claimed) {
      throw new Error("FakeEventSource consumed twice");
    }
    this.claimed = true;
    return {
      next: async (): Promise<IteratorResult<TuvrenStreamEvent>> => {
        const value = this.items.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        const pending =
          Promise.withResolvers<IteratorResult<TuvrenStreamEvent>>();
        this.waiters.push(pending.resolve);
        return await pending.promise;
      },
    };
  }
}

const makeFakeHandle = (): {
  events: FakeEventSource;
  handle: ExecutionHandle;
} => {
  const events = new FakeEventSource();
  const result = Promise.withResolvers<ExecutionResult>();

  const handle: ExecutionHandle = {
    awaitResult: async () => await result.promise,
    cancel: () => {
      // This suite never requests execution control.
    },
    events: () => events,
    resolveApproval: () => {
      throw new Error("resolveApproval not used in this suite");
    },
    status: () => ({ iterationCount: 0, phase: "running" as const }),
    steer: () => {
      // This suite never requests execution control.
    },
  };

  return { events, handle };
};

// ---------------------------------------------------------------------------
// Fake sink and clock
// ---------------------------------------------------------------------------

interface SentFrame {
  cursor: string | undefined;
  frame: SessionOutboundFrame;
}

const createFakeSink = (): RemoteClientSessionSink & { sent: SentFrame[] } => {
  const sent: SentFrame[] = [];
  return {
    send(frame: SessionOutboundFrame, cursor?: string): void {
      sent.push({ cursor, frame });
    },
    sent,
  };
};

/** A deterministic, test-controlled substitute for {@link RemoteSessionClock}: timers only fire when the test explicitly calls {@link fireOldest}. */
const createFakeClock = (): {
  clock: RemoteSessionClock;
  fireOldest: () => void;
  pendingCount: () => number;
} => {
  let nextId = 0;
  const timers = new Map<number, () => void>();

  const clock: RemoteSessionClock = {
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") {
        timers.delete(handle);
      }
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
      const [id] = [...timers.keys()].toSorted((a, b) => a - b);
      if (id === undefined) {
        throw new Error("createFakeClock.fireOldest: no pending timer");
      }
      const timer = timers.get(id);
      timers.delete(id);
      timer?.();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
};

/** Drains pending microtask continuations of the session's internal pump loop without any real (wall-clock) wait. */
const flush = async (times = 8): Promise<void> => {
  if (times === 0) {
    return;
  }
  await Promise.resolve();
  await flush(times - 1);
};

const setup = (overrides: Partial<RemoteClientSessionOptions> = {}) => {
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
    onWarning: (warning) => {
      warnings.push(warning);
    },
    replayBufferCapacity: 50,
    ...overrides,
  });

  return { binding, events, fakeClock, session, warnings };
};

const resultContentCode = (content: unknown): string | undefined => {
  if (typeof content !== "object" || content === null || !("code" in content)) {
    return undefined;
  }
  const { code } = content;
  return typeof code === "string" ? code : undefined;
};

const requiredCursor = (sent: SentFrame | undefined): string => {
  if (sent?.cursor === undefined) {
    throw new Error("expected a sequenced cursor");
  }
  return sent.cursor;
};
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise rejection");
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRemoteClientSession", () => {
  test("reattach continues sequence numbering across two sinks (no restart at 0)", async () => {
    const { events, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    events.push({
      threadId: "thread-1",
      timestamp: 0,
      turnId: "t1",
      type: "turn.start",
    });
    await flush();
    events.push({
      delta: "",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    expect(sink1.sent).toHaveLength(2);
    const lastCursor = sink1.sent[1]?.cursor;
    if (lastCursor === undefined) {
      throw new Error("expected a sequenced cursor");
    }
    expect(decodeResumeCursor(lastCursor)?.sequence).toBe(1);

    session.detach();

    // Recorded into the shared replay buffer even while no sink is attached.
    events.push({
      delta: "",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    const sink2 = createFakeSink();
    const { resumeStatus } = session.attach(sink2, {
      cursor: lastCursor,
    });

    expect(resumeStatus).toBe("resumed");
    expect(sink2.sent).toHaveLength(1);
    expect(decodeResumeCursor(requiredCursor(sink2.sent[0]))?.sequence).toBe(2);

    events.push({
      delta: "",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    expect(sink2.sent).toHaveLength(2);
    expect(decodeResumeCursor(requiredCursor(sink2.sent[1]))?.sequence).toBe(3);
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
    session.dispatchInbound({
      correlationId: "corr-settle",
      kind: "client_result",
      protocolVersion: "1",
      result: {
        callId: "call-1",
        content: { ok: true },
        leaseToken: "lease-1",
      },
      sessionId: "sess-remote-1",
    });
    const settled = await dispatchPromise;
    expect(settled.content).toEqual({ ok: true });
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

  test("a second concurrent attach is a programming error with a stable code, as is attaching to an ended session", () => {
    const { session } = setup();
    session.attach(createFakeSink());

    let doubleAttachError: unknown;
    try {
      session.attach(createFakeSink());
    } catch (error) {
      doubleAttachError = error;
    }
    expect(doubleAttachError).toMatchObject({
      code: "remote_session_already_attached",
    });

    session.close();
    let endedError: unknown;
    try {
      session.attach(createFakeSink());
    } catch (error) {
      endedError = error;
    }
    expect(endedError).toMatchObject({ code: "remote_session_ended" });
  });

  test("cursor replay across a reconnect delivers the missed sequenced events from the shared buffer", async () => {
    const { events, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    events.push({
      threadId: "thread-1",
      timestamp: 0,
      turnId: "t1",
      type: "turn.start",
    });
    await flush();
    events.push({
      delta: "a",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    const cursorAfterFirstDelta = requiredCursor(sink1.sent[1]);
    session.detach();

    events.push({
      delta: "b",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();
    events.push({
      delta: "c",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    const sink2 = createFakeSink();
    const { resumeStatus } = session.attach(sink2, {
      cursor: cursorAfterFirstDelta,
    });

    expect(resumeStatus).toBe("resumed");
    expect(sink2.sent).toHaveLength(2);
    expect(sink2.sent.every((s) => s.frame.kind === "event")).toBe(true);
    const texts = sink2.sent.map((s) =>
      s.frame.kind === "event" && s.frame.event.type === "text.delta"
        ? s.frame.event.delta
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
      onWarning: (warning) => {
        warnings.push(warning);
      },
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
    expect(
      await rejectionOf(
        binding.clientEndpoint.dispatch({
          callId: "call-after-close",
          capabilityId: "cap-1",
          input: {},
          leaseToken: "lease-ac",
        })
      )
    ).toMatchObject({ code: "duplex_session_closed" });
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
    await flush();
    expect(fakeClock.pendingCount()).toBe(1);

    // Names the tracked callId but is missing leaseToken and content, so the
    // binding rejects it as session_frame_invalid without settling anything.
    // If the session treated it as settleable it would delete the pending
    // entry and its timer, leaving the dispatch owed by no one — the hung
    // tool call ADR-0062 §6 exists to eliminate.
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

  test("a client_result with a whitespace-only leaseToken does not clear redelivery tracking or the dispatch timer", async () => {
    const { binding, fakeClock, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-whitespace",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-ws",
    });
    await flush();
    expect(fakeClock.pendingCount()).toBe(1);

    // Names the tracked callId and has a `leaseToken` key, but its value is
    // whitespace-only, so the binding's own `isNonEmptyString` (`/\S/`) rejects
    // it as session_frame_invalid without settling anything. A `.length > 0`
    // predicate here would have wrongly treated this as settleable, clearing
    // the pending entry and its timer and orphaning the dispatch.
    session.dispatchInbound({
      correlationId: "corr-whitespace",
      kind: "client_result",
      protocolVersion: "1",
      result: { callId: "call-whitespace", content: {}, leaseToken: "   " },
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

  test("reattach ordering: replayed events arrive before the redelivered client_invocation, which arrives before live forwarding resumes (ADR-0063 §2/§3)", async () => {
    const { binding, events, session } = setup();
    const sink1 = createFakeSink();
    session.attach(sink1);

    events.push({
      threadId: "thread-1",
      timestamp: 0,
      turnId: "t1",
      type: "turn.start",
    });
    await flush();
    const cursorAfterTurnStart = requiredCursor(sink1.sent[0]);

    // An unanswered client_invocation: created while sink1 is attached, so it
    // is both forwarded live and tracked as pending for later redelivery.
    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-reattach-order",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-reattach-order",
    });
    await flush();

    session.detach();

    // Recorded into the shared replay buffer while no sink is attached: this
    // is the "replayable event gap" a reattach with cursorAfterTurnStart must
    // deliver before anything else.
    events.push({
      delta: "gap",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    const sink2 = createFakeSink();
    const { resumeStatus } = session.attach(sink2, {
      cursor: cursorAfterTurnStart,
    });

    // Live forwarding: a fresh event arriving right after attach must land
    // strictly after both the replay and the redelivery below.
    events.push({
      delta: "live",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    await flush();

    expect(resumeStatus).toBe("resumed");
    expect(sink2.sent.map((s) => s.frame.kind)).toEqual([
      "event",
      "client_invocation",
      "event",
    ]);

    const [replayed, redelivered, live] = sink2.sent;
    expect(
      replayed?.frame.kind === "event" &&
        replayed.frame.event.type === "text.delta"
        ? replayed.frame.event.delta
        : undefined
    ).toBe("gap");
    expect(
      redelivered?.frame.kind === "client_invocation"
        ? redelivered.frame.invocation.callId
        : undefined
    ).toBe("call-reattach-order");
    expect(
      live?.frame.kind === "event" && live.frame.event.type === "text.delta"
        ? live.frame.event.delta
        : undefined
    ).toBe("live");

    session.dispatchInbound({
      correlationId: "call-reattach-order",
      kind: "client_result",
      protocolVersion: "1",
      result: {
        callId: "call-reattach-order",
        content: { ok: true },
        leaseToken: "lease-reattach-order",
      },
      sessionId: "sess-remote-1",
    });
    await dispatchPromise;
  });

  test("an invocation dispatched while fully detached is not forwarded anywhere and arms no dispatch timer; reattach redelivers it with a fresh timer", async () => {
    const { binding, fakeClock, session } = setup({ disconnectGraceMs: 1000 });
    const sink1 = createFakeSink();
    session.attach(sink1);
    await flush();

    session.detach();
    // Only the grace timer is pending immediately after detach.
    expect(fakeClock.pendingCount()).toBe(1);

    const dispatchPromise = binding.clientEndpoint.dispatch({
      callId: "call-while-detached",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-while-detached",
    });
    await flush();

    // No sink is attached: forwardFrame is a no-op (nothing sent to sink1,
    // which is already detached), and handleOutboundInvocation only arms a
    // dispatch timer when a sink is attached — so pendingCount stays at 1
    // (grace-only), never 2.
    expect(
      sink1.sent.filter((s) => s.frame.kind === "client_invocation")
    ).toHaveLength(0);
    expect(fakeClock.pendingCount()).toBe(1);

    const sink2 = createFakeSink();
    session.attach(sink2);

    // Reattach clears the grace timer and arms a fresh, full-budget dispatch
    // timer for the now-redelivered invocation: still exactly one pending
    // timer, but it is the dispatch timer now, not the grace timer.
    expect(fakeClock.pendingCount()).toBe(1);
    expect(
      sink2.sent.filter((s) => s.frame.kind === "client_invocation")
    ).toHaveLength(1);

    fakeClock.fireOldest();
    const result = await dispatchPromise;
    expect(result.isError).toBe(true);
    expect(resultContentCode(result.content)).toBe(
      "capability_dispatch_timeout"
    );
  });

  test("outbound() is claimed exactly once across attach -> detach -> attach -> detach -> attach", () => {
    const { handle } = makeFakeHandle();
    const realBinding = createDuplexSessionBinding(handle, {
      sessionId: "sess-claim-count",
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

    const session = createRemoteClientSession({
      binding: wrappedBinding,
      clock: fakeClock.clock,
      disconnectGraceMs: 1000,
      dispatchTimeoutMs: 500,
      replayBufferCapacity: 10,
    });

    session.attach(createFakeSink());
    expect(outboundClaims).toBe(1);

    session.detach();
    expect(outboundClaims).toBe(1);

    session.attach(createFakeSink());
    expect(outboundClaims).toBe(1);

    session.detach();
    expect(outboundClaims).toBe(1);

    session.attach(createFakeSink());
    expect(outboundClaims).toBe(1);
  });

  test("an outbound pump failure is reported and ends the session instead of wedging it silently", async () => {
    const { handle } = makeFakeHandle();
    const realBinding = createDuplexSessionBinding(handle, {
      sessionId: "sess-pump-fail",
    });
    const failedRead =
      Promise.withResolvers<IteratorResult<SessionOutboundFrame>>();
    const closed =
      Promise.withResolvers<IteratorResult<SessionOutboundFrame>>();
    closed.resolve({ done: true, value: undefined });
    let reads = 0;
    let returns = 0;
    // A binding whose claimed outbound iterator rejects mid-stream: the
    // session must not swallow it (attached sink, no frames, nothing ever
    // ending) — it must surface a warning and end the session.
    const wrappedBinding: DuplexSessionBinding = {
      ...realBinding,
      outbound: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            reads += 1;
            return await failedRead.promise;
          },
          return: async () => {
            returns += 1;
            return await closed.promise;
          },
        }),
      }),
    };
    const warnings: StreamAdapterWarning[] = [];
    let endedReason: string | undefined;

    const session = createRemoteClientSession({
      binding: wrappedBinding,
      disconnectGraceMs: 1000,
      dispatchTimeoutMs: 500,
      onEnded: (reason) => {
        endedReason = reason;
      },
      onWarning: (warning) => {
        warnings.push(warning);
      },
      replayBufferCapacity: 10,
    });

    session.attach(createFakeSink());
    failedRead.reject(new Error("outbound stream broke mid-pump"));
    await flush();

    expect(
      warnings.filter((w) => w.code === "remote_session_outbound_pump_failed")
    ).toHaveLength(1);
    expect(session.isEnded()).toBe(true);
    expect(endedReason).toBe("the session's outbound pump failed");
    expect(reads).toBe(1);
    expect(returns).toBe(1);
    await flush();
    expect(reads).toBe(1);
  });
});
