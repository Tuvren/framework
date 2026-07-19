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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  DuplexSessionBinding,
  SessionEventFrame,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  createSequencedTuvrenStreamEvents,
  createStreamAdapterWarningReporter,
  type ReplayBuffer,
  type SequencedTuvrenStreamEvent,
  type StreamAdapterOptions,
  type StreamAdapterWarning,
} from "@tuvren/stream-core";

import {
  WS_CLOSE_CODE_AUTH_REJECTED,
  WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED,
  WS_CLOSE_CODE_HANDSHAKE_INVALID,
  WS_CLOSE_CODE_HEARTBEAT_TIMEOUT,
  WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED,
  WS_CLOSE_CODE_SESSION_NOT_FOUND,
} from "./ws-close-codes.js";
import { type ParsedWsMessage, parseWsMessage } from "./ws-messages.js";

/** Standard WebSocket normal-closure code (RFC 6455 §7.4.1), not part of ADR-062's 4000-range application vocabulary. */
const WS_CLOSE_CODE_NORMAL = 1000;
/** Standard WebSocket internal-error code (RFC 6455 §7.4.1), used when the outbound pump fails unexpectedly — not part of ADR-062's 4000-range application vocabulary. */
const WS_CLOSE_CODE_INTERNAL_ERROR = 1011;
const SUPPORTED_PROTOCOL_VERSION = "1";

/**
 * The runtime-agnostic push-model socket seam a host adapts from its real
 * socket (`Bun.serve` websockets, the browser `WebSocket` global, Node
 * `ws`, or an in-memory pair in tests). {@link createWsSessionTransport}
 * never opens or owns a socket directly.
 *
 * @experimental
 */
export interface WsSocketSink {
  /**
   * Optional capability: bytes currently queued on the real socket,
   * matching the WebSocket `bufferedAmount` concept. When present alongside
   * {@link WsSessionTransportOptions.backpressure}, the transport reads this
   * before each outbound send to enforce the configured byte budget. When
   * absent, backpressure enforcement is disabled regardless of the
   * `backpressure` option.
   */
  bufferedAmount?(): number;
  /** Closes the underlying socket with a WebSocket close code and optional reason. */
  close(code: number, reason?: string): void;
  /** Sends one text message over the underlying socket. */
  send(data: string): void;
}

/**
 * Options accepted by {@link createWsSessionTransport}.
 *
 * @experimental
 */
export interface WsSessionTransportOptions {
  /**
   * Authorizes a handshake's opaque `authToken`. The transport carries the
   * token to this callback unmodified and never inspects it; a falsy result
   * (sync or async) closes the connection with `WS_CLOSE_CODE_AUTH_REJECTED`.
   * Omit to accept every handshake unconditionally.
   */
  authorize?: (authToken: string | undefined) => boolean | Promise<boolean>;
  /**
   * Bounds the outbound socket buffer. Enforced only when both this option
   * and the sink's optional {@link WsSocketSink.bufferedAmount} capability
   * are present: before each outbound send — live event frames, live
   * non-event frames, and frames replayed during handshake — the transport
   * reads `sink.bufferedAmount()`; when it exceeds `maxBufferedBytes` the
   * transport reports a `ws_transport_backpressure_exceeded` warning and
   * closes with `WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED` instead of sending.
   * ADR-062 forbids a silent drop here: a dropped frame would create a
   * sequence gap the resume cursor could neither explain nor repair, while
   * the close converts overflow into an honest reconnect-with-cursor. Hosts
   * whose sink cannot report buffering run without transport-level
   * backpressure enforcement even when this option is set. Throws
   * `RangeError` at construction if `maxBufferedBytes` is not a positive
   * finite number.
   */
  backpressure?: { maxBufferedBytes: number };
  /** The duplex session binding this transport carries (packet `tuvren.framework.host-session`). */
  binding: DuplexSessionBinding;
  /**
   * Enables application-level heartbeat / half-open detection. When
   * present, once the handshake completes the transport sends
   * `{kind: "ping"}` every `intervalMs` and arms a `timeoutMs` timer after
   * each ping. ANY inbound message ingested before that timer fires counts
   * as liveness — not only `pong` — because a peer that is actively sending
   * frames is demonstrably alive. `pong` remains the answer a quiet peer
   * produces: the transport always answers an inbound `{kind: "ping"}` with
   * `{kind: "pong"}` (the M6 seam), so a peer with nothing else to say still
   * keeps the connection alive by answering the transport's pings. A timer
   * that fires with no inbound activity since its ping was sent is
   * half-open detection: the transport reports a
   * `ws_transport_heartbeat_timeout` warning and closes with
   * `WS_CLOSE_CODE_HEARTBEAT_TIMEOUT`. Omit to disable heartbeat entirely —
   * no timers run. Throws `RangeError` at construction if `intervalMs` or
   * `timeoutMs` is not a positive finite number; `timeoutMs` may be less
   * than, equal to, or greater than `intervalMs`.
   */
  heartbeat?: { intervalMs: number; timeoutMs: number };
  /** Receives non-fatal transport-level observations, deduplicated by warning code. */
  onWarning?: (warning: StreamAdapterWarning) => void;
  /**
   * Host-owned replay window (packet `tuvren.framework.event-stream-resume`)
   * fed by this transport's outbound pump. Omit to always report
   * `resumeStatus: "out-of-window"` for a cursor-bearing handshake.
   */
  replayBuffer?: ReplayBuffer;
  /** The socket adapter this transport sends to and closes. */
  sink: WsSocketSink;
}

/**
 * A running WebSocket session transport (ADR-062).
 *
 * @experimental
 */
export interface WsSessionTransport {
  /** Idempotently closes the connection: releases the claimed outbound iterator, then closes `sink` with `code` (default `1000`). */
  close(code?: number, reason?: string): void;
  /** Feeds one inbound wire message into the transport. Throws if called before {@link start}. */
  ingest(data: string | Uint8Array): void;
  /** Claims the binding's outbound stream and enters the `awaiting-handshake` state. May only be called once. */
  start(): void;
}

/**
 * Creates a server-side WebSocket session transport over a
 * {@link DuplexSessionBinding} (ADR-062, `spec/streaming/ws/typespec/main.tsp`).
 *
 * `start()` claims `options.binding.outbound()`'s iterator exactly once,
 * synchronously, honoring the binding's single-consumer obligation, and does
 * not send anything until a valid handshake is ingested. All `ingest()`
 * calls are serialized through one internal promise chain — including an
 * async `options.authorize` — so message ordering (replay-before-live,
 * handshake-before-frames) is preserved even when a callback is slow.
 *
 * Only the canonical event stream is sequenced and replayable: `event`
 * frames are stamped with a resume cursor via one internal
 * `createSequencedTuvrenStreamEvents` instance and (when
 * `options.replayBuffer` is supplied) recorded into it; `client_invocation`
 * and `session_rejection` frames are forwarded without a cursor. Per
 * ADR-062, frame-level and unrecognized-message problems never close the
 * socket — only handshake failures and the outbound pump's own terminal
 * conditions do.
 *
 * @experimental
 */
export function createWsSessionTransport(
  options: WsSessionTransportOptions
): WsSessionTransport {
  if (options.heartbeat !== undefined) {
    if (!isPositiveFiniteNumber(options.heartbeat.intervalMs)) {
      throw new RangeError(
        "createWsSessionTransport: heartbeat.intervalMs must be a positive finite number"
      );
    }
    if (!isPositiveFiniteNumber(options.heartbeat.timeoutMs)) {
      throw new RangeError(
        "createWsSessionTransport: heartbeat.timeoutMs must be a positive finite number"
      );
    }
  }

  if (
    options.backpressure !== undefined &&
    !isPositiveFiniteNumber(options.backpressure.maxBufferedBytes)
  ) {
    throw new RangeError(
      "createWsSessionTransport: backpressure.maxBufferedBytes must be a positive finite number"
    );
  }

  const reportWarning = createStreamAdapterWarningReporter({
    onWarning: options.onWarning,
  } satisfies StreamAdapterOptions);

  let started = false;
  let handshakeDone = false;
  let closed = false;
  let outboundIterator: AsyncIterator<SessionOutboundFrame> | undefined;
  let ingestChain: Promise<void> = Promise.resolve();
  let heartbeatIntervalTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeatTimeoutTimers = new Set<ReturnType<typeof setTimeout>>();
  // Timestamp (ms, monotonic-enough via Date.now()) of the most recent
  // inbound message since the handshake completed. A ping's timeout only
  // half-open-closes when no liveness has been observed since that specific
  // ping was sent — comparing timestamps (rather than cancelling a single
  // shared timer) stays correct even when timeoutMs > intervalMs puts
  // several pings' timeouts in flight at once.
  let lastHeartbeatLivenessAt = 0;

  function clearHeartbeatTimers(): void {
    if (heartbeatIntervalTimer !== undefined) {
      clearInterval(heartbeatIntervalTimer);
      heartbeatIntervalTimer = undefined;
    }
    for (const timer of heartbeatTimeoutTimers) {
      clearTimeout(timer);
    }
    heartbeatTimeoutTimers.clear();
  }

  function doClose(code: number, reason?: string): void {
    if (closed) {
      return;
    }

    closed = true;
    clearHeartbeatTimers();
    // Always release the claimed outbound iterator on every close path, so
    // the binding's underlying handle/queue resources are never leaked.
    outboundIterator?.return?.().catch(() => undefined);
    options.sink.close(code, reason);
  }

  /**
   * Records inbound liveness for the heartbeat's half-open detection: any
   * inbound message ingested after the handshake — not only `pong` — marks
   * the connection alive, since a peer actively sending frames is
   * demonstrably alive.
   */
  function noteHeartbeatLiveness(): void {
    lastHeartbeatLivenessAt = Date.now();
  }

  function sendHeartbeatPing(): void {
    if (closed || options.heartbeat === undefined) {
      return;
    }

    options.sink.send(JSON.stringify({ kind: "ping" }));
    const pingSentAt = Date.now();
    const timeoutMs = options.heartbeat.timeoutMs;

    const timer = setTimeout(() => {
      heartbeatTimeoutTimers.delete(timer);

      if (closed || lastHeartbeatLivenessAt >= pingSentAt) {
        // Either already closed by another path, or liveness was observed
        // after this specific ping was sent — not half-open.
        return;
      }

      reportWarning({
        code: "ws_transport_heartbeat_timeout",
        details: { timeoutMs },
        message:
          "no inbound activity within the configured heartbeat timeout; treating connection as half-open",
      });
      doClose(
        WS_CLOSE_CODE_HEARTBEAT_TIMEOUT,
        "no inbound activity within the configured heartbeat timeout"
      );
    }, timeoutMs);

    heartbeatTimeoutTimers.add(timer);
  }

  function startHeartbeat(): void {
    if (options.heartbeat === undefined || closed) {
      return;
    }

    heartbeatIntervalTimer = setInterval(
      sendHeartbeatPing,
      options.heartbeat.intervalMs
    );
  }

  /**
   * Enforces the configured outbound backpressure budget: returns `true`
   * (and closes with `WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED`) when both
   * `options.backpressure` and the sink's optional `bufferedAmount()`
   * capability are present and the buffered amount exceeds the configured
   * budget. Callers must not send the pending frame when this returns
   * `true` — ADR-062 forbids a silent drop.
   */
  function enforceBackpressure(): boolean {
    if (options.backpressure === undefined) {
      return false;
    }

    const bufferedAmount = options.sink.bufferedAmount?.();
    if (
      bufferedAmount === undefined ||
      bufferedAmount <= options.backpressure.maxBufferedBytes
    ) {
      return false;
    }

    reportWarning({
      code: "ws_transport_backpressure_exceeded",
      details: {
        bufferedAmount,
        maxBufferedBytes: options.backpressure.maxBufferedBytes,
      },
      message:
        "outbound socket buffer exceeded the configured backpressure budget",
    });
    doClose(
      WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED,
      "outbound socket buffer exceeded the configured backpressure budget"
    );
    return true;
  }

  function dispatchInboundSafely(value: unknown): void {
    try {
      options.binding.dispatchInbound(value);
    } catch (error) {
      reportWarning({
        code: "ws_transport_inbound_dispatch_failed",
        details: { error: describeError(error) },
        message:
          "binding.dispatchInbound() threw for an inbound WebSocket message",
      });
    }
  }

  function computeResumeStatus(cursor: string | undefined): {
    events: SequencedTuvrenStreamEvent[];
    status: "resumed" | "out-of-window" | "unknown-turn" | "none";
  } {
    if (cursor === undefined) {
      return { events: [], status: "none" };
    }

    if (options.replayBuffer === undefined) {
      return { events: [], status: "out-of-window" };
    }

    const result = options.replayBuffer.replayFrom(cursor);

    if (result.status === "resumed") {
      return { events: result.events, status: "resumed" };
    }

    return { events: [], status: result.status };
  }

  /**
   * Sends the replay burst resolved for a resumed handshake, honoring the
   * same closed/backpressure guards as the live pump (ADR-062: replay
   * bursts are exactly when a slow socket saturates). Returns `false` if the
   * connection was closed partway through and the caller must stop.
   */
  function sendReplayedFrames(
    events: readonly SequencedTuvrenStreamEvent[]
  ): boolean {
    for (const sequenced of events) {
      if (closed) {
        return false;
      }

      if (enforceBackpressure()) {
        return false;
      }

      const replayedFrame: SessionEventFrame = {
        event: sequenced.event,
        kind: "event",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        sessionId: options.binding.sessionId,
      };

      options.sink.send(
        JSON.stringify({
          cursor: sequenced.cursor,
          frame: replayedFrame,
          kind: "frame",
        })
      );
    }

    return true;
  }

  async function processHandshake(parsed: ParsedWsMessage): Promise<void> {
    if (parsed.kind !== "handshake") {
      doClose(
        WS_CLOSE_CODE_HANDSHAKE_INVALID,
        "first message on a WebSocket session transport must be a handshake"
      );
      return;
    }

    const message = parsed.message;

    if (message.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      doClose(
        WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED,
        `unsupported handshake protocolVersion "${message.protocolVersion}"`
      );
      return;
    }

    if (
      message.sessionId !== undefined &&
      message.sessionId !== options.binding.sessionId
    ) {
      doClose(
        WS_CLOSE_CODE_SESSION_NOT_FOUND,
        `sessionId "${message.sessionId}" does not match this session`
      );
      return;
    }

    if (options.authorize !== undefined) {
      const authorized = await options.authorize(message.authToken);

      // The socket may have been closed by another path (e.g. an explicit
      // transport.close()) while authorize() was pending; do not resume
      // handshake processing on a connection that is already gone.
      if (closed) {
        return;
      }

      if (!authorized) {
        doClose(
          WS_CLOSE_CODE_AUTH_REJECTED,
          "handshake authToken was rejected"
        );
        return;
      }
    }

    const resume = computeResumeStatus(message.cursor);
    handshakeDone = true;

    options.sink.send(
      JSON.stringify({
        kind: "handshake_ack",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        resumeStatus: resume.status,
        sessionId: options.binding.sessionId,
      })
    );

    if (!sendReplayedFrames(resume.events)) {
      return;
    }

    if (closed) {
      return;
    }

    // Heartbeat pings start only once the handshake has fully completed
    // (ack plus any replay burst sent), per ADR-062 §6.
    startHeartbeat();

    // Detached: the pump's only observable effects are sink.send()/close()
    // above, so ingest() never needs to await it (mirrors
    // teeTuvrenStreamEvents' detached pump in @tuvren/stream-core).
    runOutboundPump().catch(() => undefined);
  }

  function processPostHandshake(parsed: ParsedWsMessage): void {
    // ANY inbound message counts as heartbeat liveness, not only pong — a
    // peer actively sending frames is demonstrably alive.
    noteHeartbeatLiveness();

    switch (parsed.kind) {
      case "ping": {
        options.sink.send(JSON.stringify({ kind: "pong" }));
        return;
      }
      case "pong": {
        // pong is the answer a quiet peer produces (the transport always
        // answers an inbound ping); liveness itself is already recorded
        // above for every inbound message, wiring the M6 no-op seam into
        // heartbeat tracking.
        return;
      }
      case "frame": {
        dispatchInboundSafely(parsed.frame);
        return;
      }
      case "handshake": {
        // A stray post-handshake handshake message is not a transport
        // concern (ADR-062: frame-level and unrecognized-message problems
        // never close the socket) — forward it so the binding's schema
        // validation turns it into a session_rejection.
        dispatchInboundSafely(parsed.message);
        return;
      }
      case "handshake_ack": {
        dispatchInboundSafely(parsed.message);
        return;
      }
      case "unparseable": {
        // Same rule: no inbound message is silently dropped. The binding's
        // schema validation rejects this with session_frame_invalid.
        dispatchInboundSafely(parsed.raw);
        return;
      }
      default: {
        // Exhaustive over ParsedWsMessage; kept only to satisfy the lint
        // rule requiring a default clause.
        return;
      }
    }
  }

  /**
   * Sequences and sends one live `event` outbound frame: pushes it through
   * the connection's one sequencer instance, records it into the replay
   * buffer when configured, enforces backpressure, then sends. Returns
   * `false` when the caller must stop the pump (closed mid-await, or a
   * backpressure close just happened) and `true` otherwise.
   */
  async function pumpEventFrame(
    frame: SessionOutboundFrame,
    channel: SingleSlotPushChannel<TuvrenStreamEvent>,
    sequencedIterator: AsyncIterator<SequencedTuvrenStreamEvent>
  ): Promise<boolean> {
    if (frame.kind !== "event") {
      return true;
    }

    channel.push(frame.event);
    const sequencedResult = await sequencedIterator.next();

    if (closed) {
      return false;
    }

    if (sequencedResult.done) {
      return true;
    }

    const envelope = sequencedResult.value;
    options.replayBuffer?.record(envelope);

    if (enforceBackpressure()) {
      return false;
    }

    options.sink.send(
      JSON.stringify({
        cursor: envelope.cursor,
        frame,
        kind: "frame",
      })
    );
    return true;
  }

  /**
   * Sends one live non-event outbound frame (`client_invocation` /
   * `session_rejection`, ADR-062 §3: not replayable, carries no cursor)
   * after enforcing backpressure. Returns `false` when the caller must stop
   * the pump.
   */
  function pumpNonEventFrame(frame: SessionOutboundFrame): boolean {
    if (enforceBackpressure()) {
      return false;
    }

    options.sink.send(JSON.stringify({ frame, kind: "frame" }));
    return true;
  }

  /**
   * Dispatches one already-fetched `outboundIterator.next()` result: a
   * `done` result ends the connection normally, an `event` frame is
   * sequenced/recorded/sent via {@link pumpEventFrame}, and any other frame
   * is sent as-is via {@link pumpNonEventFrame}. Returns `false` when the
   * caller must stop the pump.
   */
  async function handleOutboundNext(
    next: IteratorResult<SessionOutboundFrame>,
    channel: SingleSlotPushChannel<TuvrenStreamEvent>,
    sequencedIterator: AsyncIterator<SequencedTuvrenStreamEvent>
  ): Promise<boolean> {
    if (next.done) {
      doClose(WS_CLOSE_CODE_NORMAL, "session ended");
      return false;
    }

    const frame = next.value;

    return frame.kind === "event"
      ? await pumpEventFrame(frame, channel, sequencedIterator)
      : pumpNonEventFrame(frame);
  }

  async function runOutboundPump(): Promise<void> {
    if (outboundIterator === undefined) {
      return;
    }

    // One sequencer instance feeds the whole connection, fed one event at a
    // time by a single-slot push channel: push(event) then
    // sequencedIterator.next() is guaranteed to yield exactly one envelope
    // because the channel's next() never resolves without a pending push.
    const channel = new SingleSlotPushChannel<TuvrenStreamEvent>();
    const sequenced = createSequencedTuvrenStreamEvents(channel, {
      onWarning: reportWarning,
    });
    const sequencedIterator = sequenced[Symbol.asyncIterator]();

    try {
      for (;;) {
        const next = await outboundIterator.next();

        // A next() call can latch a value in the very tick close() runs
        // (e.g. an explicit transport.close() or a concurrent backpressure
        // close); re-check after every await so nothing sends post-close.
        if (closed) {
          return;
        }

        const shouldContinue = await handleOutboundNext(
          next,
          channel,
          sequencedIterator
        );

        if (!shouldContinue) {
          return;
        }
      }
    } catch (error) {
      reportWarning({
        code: "ws_transport_outbound_pump_failed",
        details: { error: describeError(error) },
        message: "the outbound frame pump failed unexpectedly",
      });
      doClose(WS_CLOSE_CODE_INTERNAL_ERROR, "internal error");
    }
  }

  return {
    close(code?: number, reason?: string): void {
      doClose(code ?? WS_CLOSE_CODE_NORMAL, reason);
    },
    ingest(data: string | Uint8Array): void {
      if (!started) {
        throw new Error(
          "createWsSessionTransport: ingest() called before start()"
        );
      }

      // Serialize every ingest through one promise chain so ordering is
      // preserved (replay-before-live, handshake-before-frames) even when
      // options.authorize is async and a later ingest() call arrives first.
      // The chain itself never rejects (a throwing authorize() is reported
      // as a warning instead) so one bad message can never wedge every
      // subsequent ingest() call behind a rejected promise.
      ingestChain = ingestChain
        .then(() => {
          if (closed) {
            return;
          }

          const parsed = parseWsMessage(data);
          return handshakeDone
            ? processPostHandshake(parsed)
            : processHandshake(parsed);
        })
        .catch((error) => {
          reportWarning({
            code: "ws_transport_inbound_dispatch_failed",
            details: { error: describeError(error) },
            message: "ingest() processing failed unexpectedly",
          });
        });
    },
    start(): void {
      if (started) {
        throw new Error(
          "createWsSessionTransport: start() may only be called once"
        );
      }

      started = true;
      // Claims the binding's single-consumer outbound stream synchronously,
      // before returning, honoring the binding's single-claim obligation.
      // Nothing is sent yet — the transport is in the awaiting-handshake
      // state until a valid handshake is ingested.
      outboundIterator = options.binding.outbound()[Symbol.asyncIterator]();
    },
  };
}

/**
 * Single-slot push channel: `push(value)` followed immediately by a `next()`
 * call is guaranteed to resolve with that exact value, because `next()`
 * never resolves without a pending push (the outbound pump only ever calls
 * `next()` in that lockstep order).
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

        const value = this.value as T;
        this.hasValue = false;
        this.value = undefined;
        return { done: false, value };
      },
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
