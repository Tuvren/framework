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

import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import {
  CAPABILITY_BINDING_UNAVAILABLE,
  CAPABILITY_DISPATCH_TIMEOUT,
} from "@tuvren/core/errors";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  DuplexSessionBinding,
  SessionEventFrame,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  createStreamAdapterWarningReporter,
  type ReplayBuffer,
  type StreamAdapterOptions,
  type StreamAdapterWarning,
} from "@tuvren/stream-core";

const PROTOCOL_VERSION = "1";

/**
 * Stable code carried by the `TuvrenRuntimeError` thrown when
 * {@link RemoteClientSession.attach} is called while another sink is still
 * attached — ADR-063 decision 2's at-most-one-sink rule surfacing a
 * concurrent second attach as a programming error rather than a silent
 * second consumer. Transports branch on this code (never on message text)
 * to refuse the *new* connection while leaving the live one untouched.
 *
 * @experimental
 */
export const REMOTE_SESSION_ALREADY_ATTACHED =
  "remote_session_already_attached" as const;

/**
 * Stable code carried by the `TuvrenRuntimeError` thrown when
 * {@link RemoteClientSession.attach} is called on a session that has
 * permanently ended (explicit `close()`, disconnect grace-window expiry, or
 * the underlying binding's outbound stream reaching a terminal state).
 *
 * @experimental
 */
export const REMOTE_SESSION_ENDED = "remote_session_ended" as const;

/**
 * Injectable timer pair backing {@link RemoteClientSession}'s disconnect
 * grace window and per-dispatch timeout. Defaults to the global
 * `setTimeout`/`clearTimeout` when {@link RemoteClientSessionOptions.clock}
 * is omitted. Tests supply a controllable fake so grace/timeout expiry is
 * driven deterministically rather than by a real wall-clock sleep.
 *
 * @experimental
 */
export interface RemoteSessionClock {
  /** Cancels a pending timeout previously returned by {@link scheduleTimeout}. */
  clearTimeout(handle: unknown): void;
  /** Schedules `callback` to run after `ms` milliseconds; returns an opaque handle. */
  scheduleTimeout(callback: () => void, ms: number): unknown;
}

const globalClock: RemoteSessionClock = {
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  scheduleTimeout(callback: () => void, ms: number): unknown {
    return setTimeout(callback, ms);
  },
};

/**
 * The carriage-facing push seam a transport attaches beneath a
 * {@link RemoteClientSession}. Transport-agnostic by design (ADR-063): a
 * WebSocket, SSE-plus-inbound-channel, IPC, or in-memory test harness all
 * implement the same one-method shape.
 *
 * `cursor` is present only for `event` frames — the sequenced, replayable
 * channel (ADR-061) — and is `undefined` for `client_invocation` and
 * `session_rejection` frames, which are never replayable.
 *
 * @experimental
 */
export interface RemoteClientSessionSink {
  /** Sends one outbound frame, with its resume cursor when the frame is a sequenced `event`. */
  send(frame: SessionOutboundFrame, cursor?: string): void;
}

/**
 * Outcome of attempting cursor-based replay during {@link RemoteClientSession.attach}
 * (mirrors {@link ReplayResult} from `@tuvren/stream-core`, plus `"none"` for
 * an attach that carried no cursor at all — a fresh connection, not a
 * reattach).
 *
 * @experimental
 */
export type RemoteClientSessionResumeStatus =
  | "resumed"
  | "out-of-window"
  | "unknown-turn"
  | "none";

/**
 * Options accepted by {@link RemoteClientSession.attach}.
 *
 * @experimental
 */
export interface RemoteClientSessionAttachOptions {
  /** Resume-cursor token (ADR-061) carried by a reattaching peer's handshake. Omit for a fresh connection. */
  cursor?: string;
}

/**
 * Result of {@link RemoteClientSession.attach}: the outcome a transport needs
 * to answer its own handshake acknowledgement (e.g. `WsHandshakeAck.resumeStatus`).
 *
 * @experimental
 */
export interface RemoteClientSessionAttachResult {
  /** Replay outcome for the supplied cursor, or `"none"` when no cursor was supplied. */
  resumeStatus: RemoteClientSessionResumeStatus;
}

/**
 * Options accepted by {@link createRemoteClientSession}.
 *
 * @experimental
 */
export interface RemoteClientSessionOptions {
  /**
   * The single duplex session binding this session owns for its whole life
   * (ADR-063 decision 2). Its `outbound()` stream is claimed exactly once, on
   * first {@link RemoteClientSession.attach}, never at construction.
   */
  binding: DuplexSessionBinding;
  /** Injectable timer pair for the grace/timeout clocks. Defaults to the global timers. */
  clock?: RemoteSessionClock;
  /**
   * How long a detached session waits for a reattach before treating the
   * link as permanently gone (ADR-063 decision 4). `0` reproduces
   * immediate-detach semantics. Must be a finite number `>= 0`.
   */
  disconnectGraceMs: number;
  /**
   * How long a dispatched `client_invocation` may go unanswered while a sink
   * is attached before it is treated as an unresponsive peer (ADR-063
   * decision 5). Suspended while detached, and restarted in full for any
   * invocation redelivered on reattach. Must be a finite number `> 0`.
   */
  dispatchTimeoutMs: number;
  /**
   * Notified once, with a human-readable reason, when the session
   * permanently ends: explicit {@link RemoteClientSession.close}, disconnect
   * grace-window expiry, or the underlying binding's own outbound stream
   * reaching a terminal state. Purely observational — hosts do not need it to
   * keep the session correct.
   */
  onEnded?: (reason: string) => void;
  /** Receives non-fatal session-level observations, deduplicated by warning code. */
  onWarning?: (warning: StreamAdapterWarning) => void;
  /** Capacity (in retained sequenced frames) of the shared replay window. Must be a positive integer. */
  replayBufferCapacity: number;
}

/**
 * A host-owned, reattachable remote client session (ADR-063): the
 * transport-agnostic lifecycle seam that keeps one {@link DuplexSessionBinding}
 * alive across a link that can drop, above the frame binding and below
 * carriage.
 *
 * @experimental
 */
export interface RemoteClientSession {
  /**
   * Attaches a sink beneath this session: at most one sink is attached at a
   * time, and a second concurrent `attach` (without an intervening
   * {@link detach}) is a programming error, not a silent second consumer.
   * The **first** call in this session's life claims the underlying
   * binding's single `outbound()` stream — preserving the runtime's
   * lazy-start contract, since a session constructed but never attached
   * never claims it and never starts a turn.
   *
   * A reattach (`options.cursor` supplied, or simply a second attach after a
   * prior detach) replays retained sequenced events strictly after the
   * cursor from the shared replay window, then redelivers every unanswered
   * `client_invocation` — re-arming each one's dispatch-timeout clock with a
   * full fresh budget — before resuming live forwarding. `session_rejection`
   * frames are never redelivered.
   *
   * Throws a `TuvrenRuntimeError` if this session has already ended
   * (grace-window expiry or an explicit {@link close}) — code
   * {@link REMOTE_SESSION_ENDED} — or if a sink is already attached — code
   * {@link REMOTE_SESSION_ALREADY_ATTACHED}. Callers branch on `code`, never
   * on message text.
   */
  attach(
    sink: RemoteClientSessionSink,
    options?: RemoteClientSessionAttachOptions
  ): RemoteClientSessionAttachResult;
  /**
   * Permanently ends the session: detaches any attached sink without
   * starting a grace window, settles every pending dispatch with
   * `capability_binding_unavailable`, and marks the session so that any
   * later `attach` throws. Idempotent — a second call is a no-op.
   */
  close(reason?: string): void;
  /**
   * Detaches the currently attached sink and starts the `disconnectGraceMs`
   * timer; pending dispatches are **not** failed immediately. A reattach
   * inside the window cancels the timer. No-op if no sink is currently
   * attached.
   */
  detach(reason?: string): void;
  /**
   * Routes one inbound frame, mirroring {@link DuplexSessionBinding.dispatchInbound}'s
   * fire-and-forget `unknown`-accepting shape so a transport can call this in
   * place of the binding directly. Refuses to route (and reports a
   * `remote_session_inbound_while_unattached` warning) while no sink is
   * attached — the session must claim the binding's outbound stream and have
   * a live peer before any inbound frame has defined ordering.
   */
  dispatchInbound(frame: unknown): void;
  /** Whether this session has permanently ended. Observability only. */
  isEnded(): boolean;
  /** The session identifier carried on every frame the underlying binding produces or accepts. */
  readonly sessionId: string;
}

interface PendingInvocation {
  dispatchTimer?: unknown;
  envelope: ClientInvocationEnvelope;
}

/**
 * Single-slot push channel feeding exactly one {@link createSequencedTuvrenStreamEvents}
 * instance: `push(value)` followed immediately by a `next()` call is
 * guaranteed to resolve with that exact value, because the pump only ever
 * calls `next()` in that lockstep push-then-pull order (mirrors the identical
 * helper in `@tuvren/stream-ws`'s `createWsSessionTransport`).
 */
class SingleSlotPushChannel<T> implements AsyncIterable<T> {
  private hasValue = false;
  private value: T | undefined;

  push(value: T): void {
    this.value = value;
    this.hasValue = true;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      // biome-ignore lint/suspicious/useAwait: kept async to satisfy the AsyncIterator contract even though resolution is always synchronous under the lockstep push/next contract.
      next: async (): Promise<IteratorResult<T>> => {
        if (!this.hasValue) {
          throw new Error(
            "SingleSlotPushChannel: next() called without a pending push()"
          );
        }

        const pushed = this.value as T;
        this.hasValue = false;
        this.value = undefined;
        return { done: false, value: pushed };
      },
    };
  }
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Extracts the `callId` of a `client_result` frame, but only when the frame
 * would pass the binding's own structural validation (`validateInboundFrame`
 * in `@tuvren/host-session`: `protocolVersion`, matching `sessionId`,
 * non-empty `correlationId`, and a result payload with non-empty `callId`,
 * non-empty `leaseToken`, and a `content` key). Mirroring those criteria is
 * load-bearing: the session clears its redelivery tracking for a `callId` the
 * moment a settleable result naming it is observed, so treating a frame the
 * binding will *reject* as settleable would orphan an in-flight dispatch —
 * no timer, no redelivery, nobody left owing the call.
 */
function extractSettleableClientResultCallId(
  raw: unknown,
  sessionId: string
): string | undefined {
  if (
    !isRecord(raw) ||
    raw.kind !== "client_result" ||
    raw.protocolVersion !== "1" ||
    raw.sessionId !== sessionId ||
    !isNonEmptyString(raw.correlationId)
  ) {
    return undefined;
  }
  const result = raw.result;
  if (
    !(
      isRecord(result) &&
      isNonEmptyString(result.callId) &&
      isNonEmptyString(result.leaseToken) &&
      "content" in result
    )
  ) {
    return undefined;
  }
  return result.callId;
}

/**
 * Creates the transport-agnostic session-lifecycle seam ADR-063 describes:
 * one {@link DuplexSessionBinding.outbound} claim, one `createSequencedTuvrenStreamEvents`
 * instance, and one shared `createReplayBuffer`, all held for this session's
 * whole life regardless of how many sinks attach and detach beneath it.
 *
 * @experimental
 */
export function createRemoteClientSession(
  options: RemoteClientSessionOptions
): RemoteClientSession {
  if (!isPositiveFiniteNumber(options.dispatchTimeoutMs)) {
    throw new RangeError(
      "createRemoteClientSession: dispatchTimeoutMs must be a positive finite number"
    );
  }
  if (!isNonNegativeFiniteNumber(options.disconnectGraceMs)) {
    throw new RangeError(
      "createRemoteClientSession: disconnectGraceMs must be a non-negative finite number"
    );
  }

  const binding = options.binding;
  const sessionId = binding.sessionId;
  const clock = options.clock ?? globalClock;
  // Throws RangeError for a non-positive-integer capacity, same as every
  // other createReplayBuffer caller in the tree.
  const replayBuffer: ReplayBuffer = createReplayBuffer({
    capacity: options.replayBufferCapacity,
  });
  const reportWarning = createStreamAdapterWarningReporter({
    onWarning: options.onWarning,
  } satisfies StreamAdapterOptions);

  let attachedSink: RemoteClientSessionSink | undefined;
  let started = false;
  let ended = false;
  let graceTimerHandle: unknown;
  let outboundIterator: AsyncIterator<SessionOutboundFrame> | undefined;
  const pendingInvocations = new Map<string, PendingInvocation>();

  function forwardFrame(
    frame: SessionOutboundFrame,
    cursor: string | undefined
  ): void {
    if (ended || attachedSink === undefined) {
      return;
    }
    attachedSink.send(frame, cursor);
  }

  function settleSynthesizedResult(
    envelope: ClientInvocationEnvelope,
    code: string,
    message: string
  ): void {
    // Converts a lost link or an unresponsive peer into a well-shaped
    // {code, error} result routed as an ordinary client_result back into the
    // binding, rather than letting the dispatch promise reject — the
    // code-less thrown path `spec/host/client-endpoint-integration.md` warns
    // hosts away from. Reusing the binding's own pending-call table this way
    // means a genuine (even if now-redundant) late result for the same
    // callId is still handled by the binding's existing
    // capability_result_stale staleness guard, unchanged by this session.
    const result: ClientReportedResult = {
      callId: envelope.callId,
      content: { code, error: message },
      isError: true,
      leaseToken: envelope.leaseToken,
    };
    binding.dispatchInbound({
      correlationId: envelope.callId,
      kind: "client_result",
      protocolVersion: PROTOCOL_VERSION,
      result,
      sessionId,
    });
  }

  function armDispatchTimer(callId: string): unknown {
    return clock.scheduleTimeout(() => {
      const pending = pendingInvocations.get(callId);
      if (pending === undefined) {
        return;
      }
      pendingInvocations.delete(callId);
      settleSynthesizedResult(
        pending.envelope,
        CAPABILITY_DISPATCH_TIMEOUT,
        `client_result for callId "${callId}" did not arrive within dispatchTimeoutMs (${options.dispatchTimeoutMs}ms) while a peer was attached`
      );
    }, options.dispatchTimeoutMs);
  }

  function clearGraceTimer(): void {
    if (graceTimerHandle !== undefined) {
      clock.clearTimeout(graceTimerHandle);
      graceTimerHandle = undefined;
    }
  }

  function endSession(reason: string): void {
    if (ended) {
      return;
    }
    ended = true;
    clearGraceTimer();
    attachedSink = undefined;

    for (const pending of pendingInvocations.values()) {
      if (pending.dispatchTimer !== undefined) {
        clock.clearTimeout(pending.dispatchTimer);
      }
      settleSynthesizedResult(
        pending.envelope,
        CAPABILITY_BINDING_UNAVAILABLE,
        reason
      );
    }
    pendingInvocations.clear();

    // Release the claimed outbound() iterator so the binding's underlying
    // handle/queue resources are never leaked (same discipline as
    // @tuvren/stream-ws's close paths). Ordered after the settle loop above:
    // return() drives the binding's queue terminal, and its onTerminal sweep
    // rejects surviving binding-pending calls with duplex_session_closed —
    // the tracked ones must settle with their well-shaped {code, error}
    // results first.
    outboundIterator?.return?.().catch(() => undefined);

    options.onEnded?.(reason);
  }

  function startGraceTimer(reason: string | undefined): void {
    if (options.disconnectGraceMs <= 0) {
      // A zero-length grace window reproduces immediate-detach semantics
      // (ADR-063 decision 4): there is nothing to wait for.
      endSession(
        reason ??
          "disconnectGraceMs is 0; detach reproduces immediate-detach semantics"
      );
      return;
    }

    graceTimerHandle = clock.scheduleTimeout(() => {
      graceTimerHandle = undefined;
      endSession(reason ?? "disconnect grace window expired with no reattach");
    }, options.disconnectGraceMs);
  }

  function handleBindingTerminal(): void {
    // The binding's own onTerminal sweep already rejects every one of its
    // pending client dispatches with duplex_session_closed the moment its
    // outbound stream goes terminal, so this session's redelivery bookkeeping
    // is now moot for those calls — release their timers and drop them here
    // rather than let endSession synthesize results the binding would only
    // discard as settling already-swept calls.
    for (const pending of pendingInvocations.values()) {
      if (pending.dispatchTimer !== undefined) {
        clock.clearTimeout(pending.dispatchTimer);
      }
    }
    pendingInvocations.clear();
    endSession("the underlying duplex session binding's outbound stream ended");
  }

  function handleOutboundInvocation(
    invocation: ClientInvocationEnvelope
  ): void {
    if (ended) {
      // The session already ended (grace expiry, explicit close, or a prior
      // binding termination that raced this frame) but the binding somehow
      // still produced a fresh dispatch; refuse it rather than deliver it
      // into a dead link — mirrors ADR-063 decision 4's "subsequent
      // invocations are refused" outcome without requiring a
      // ClientEndpointBoundary reference, which this package deliberately
      // does not depend on.
      settleSynthesizedResult(
        invocation,
        CAPABILITY_BINDING_UNAVAILABLE,
        "remote client session has already ended; the invocation cannot be delivered"
      );
      return;
    }

    const pending: PendingInvocation = { envelope: invocation };
    pendingInvocations.set(invocation.callId, pending);

    if (attachedSink !== undefined) {
      pending.dispatchTimer = armDispatchTimer(invocation.callId);
    }

    forwardFrame(
      {
        invocation,
        kind: "client_invocation",
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
      },
      undefined
    );
  }

  function claimAndStartPump(): void {
    started = true;

    const claimedIterator = binding.outbound()[Symbol.asyncIterator]();
    outboundIterator = claimedIterator;
    const channel = new SingleSlotPushChannel<TuvrenStreamEvent>();
    const sequenced = createSequencedTuvrenStreamEvents(channel, {
      onWarning: reportWarning,
    });
    const sequencedIterator = sequenced[Symbol.asyncIterator]();

    const pump = (async () => {
      for (;;) {
        const next = await claimedIterator.next();

        if (next.done) {
          handleBindingTerminal();
          return;
        }

        const frame = next.value;

        if (frame.kind === "event") {
          channel.push(frame.event);
          const sequencedResult = await sequencedIterator.next();
          if (sequencedResult.done) {
            continue;
          }
          const sequencedEvent = sequencedResult.value;
          replayBuffer.record(sequencedEvent);
          forwardFrame(frame, sequencedEvent.cursor);
          continue;
        }

        if (frame.kind === "client_invocation") {
          handleOutboundInvocation(frame.invocation);
          continue;
        }

        // session_rejection: not tracked for redelivery, not sequenced.
        forwardFrame(frame, undefined);
      }
    })();

    // Detached: the pump's only observable effects are the forwardFrame /
    // settleSynthesizedResult calls above, so callers never need to await it.
    pump.catch(() => undefined);
  }

  function attach(
    sink: RemoteClientSessionSink,
    attachOptions: RemoteClientSessionAttachOptions = {}
  ): RemoteClientSessionAttachResult {
    if (ended) {
      throw new TuvrenRuntimeError(
        "RemoteClientSession.attach: this session has already ended and can no longer be attached",
        { code: REMOTE_SESSION_ENDED }
      );
    }
    if (attachedSink !== undefined) {
      throw new TuvrenRuntimeError(
        "RemoteClientSession.attach: a sink is already attached; a second concurrent attach is a programming error",
        { code: REMOTE_SESSION_ALREADY_ATTACHED }
      );
    }

    clearGraceTimer();

    // Claims binding.outbound() exactly once, on this session's first
    // attach — never at construction — preserving the runtime's lazy-start
    // contract (ADR-063 decision 2).
    if (!started) {
      claimAndStartPump();
    }

    const cursor = attachOptions.cursor;
    let resumeStatus: RemoteClientSessionResumeStatus = "none";

    if (cursor !== undefined) {
      const replay = replayBuffer.replayFrom(cursor);
      resumeStatus = replay.status;

      if (replay.status === "resumed") {
        for (const sequencedEvent of replay.events) {
          const eventFrame: SessionEventFrame = {
            event: sequencedEvent.event,
            kind: "event",
            protocolVersion: PROTOCOL_VERSION,
            sessionId,
          };
          sink.send(eventFrame, sequencedEvent.cursor);
        }
      }
    }

    // Redeliver unanswered client_invocation frames after replay, before
    // live forwarding resumes (ADR-063 decision 3): each redelivery reuses
    // its original callId/leaseToken and re-arms a fresh full-budget dispatch
    // timer, since a peer just handed the work again deserves the full
    // dispatchTimeoutMs rather than a deadline that ran out while it was gone
    // (ADR-063 decision 5).
    for (const pending of pendingInvocations.values()) {
      sink.send(
        {
          invocation: pending.envelope,
          kind: "client_invocation",
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
        },
        undefined
      );
      pending.dispatchTimer = armDispatchTimer(pending.envelope.callId);
    }

    attachedSink = sink;
    return { resumeStatus };
  }

  function detach(reason?: string): void {
    if (attachedSink === undefined) {
      return;
    }
    attachedSink = undefined;

    // The dispatch clock measures reachable-peer responsiveness only
    // (ADR-063 decision 5): suspend every in-flight timer rather than let it
    // keep running against a peer that just vanished.
    for (const pending of pendingInvocations.values()) {
      if (pending.dispatchTimer !== undefined) {
        clock.clearTimeout(pending.dispatchTimer);
        pending.dispatchTimer = undefined;
      }
    }

    if (ended) {
      return;
    }

    startGraceTimer(reason);
  }

  function close(reason?: string): void {
    if (ended) {
      return;
    }
    attachedSink = undefined;
    clearGraceTimer();
    endSession(reason ?? "session closed by host");
  }

  function dispatchInbound(raw: unknown): void {
    if (attachedSink === undefined) {
      reportWarning({
        code: "remote_session_inbound_while_unattached",
        message:
          "an inbound frame arrived while no sink is attached to this remote client session; refusing to route it",
      });
      return;
    }

    // Once a *settleable* client_result frame naming a tracked callId is
    // observed — one the binding's structural validation will accept, whether
    // it is then applied or discarded as stale — the session's redelivery job
    // for that callId is done; a genuinely duplicate late result is exactly
    // what the binding's own capability_result_stale guard already handles,
    // unaffected by this bookkeeping. A frame the binding will *reject*
    // (missing leaseToken/content, wrong session, ...) must NOT clear
    // tracking: it settles nothing, so the dispatch is still owed its timer
    // and its redelivery.
    const callId = extractSettleableClientResultCallId(raw, sessionId);
    if (callId !== undefined) {
      const pending = pendingInvocations.get(callId);
      if (pending !== undefined) {
        if (pending.dispatchTimer !== undefined) {
          clock.clearTimeout(pending.dispatchTimer);
        }
        pendingInvocations.delete(callId);
      }
    }

    binding.dispatchInbound(raw);
  }

  return {
    attach,
    close,
    detach,
    dispatchInbound,
    isEnded(): boolean {
      return ended;
    },
    sessionId,
  };
}
