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
import type { SessionOutboundFrame } from "@tuvren/host-session";
import {
  REMOTE_SESSION_ALREADY_ATTACHED,
  type RemoteClientSession,
  type RemoteClientSessionAttachResult,
  type RemoteClientSessionSink,
} from "@tuvren/remote-session";
import {
  createStreamAdapterWarningReporter,
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
/** Standard WebSocket internal-error code (RFC 6455 §7.4.1), used when a heartbeat ping cannot be sent — not part of ADR-062's 4000-range application vocabulary. */
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
 * ADR-063 moved sequencing and replay ownership host-side into
 * `@tuvren/remote-session`: this transport no longer takes a
 * `DuplexSessionBinding` or a replay buffer, only the {@link RemoteClientSession}
 * it attaches beneath. A host composes `binding → session → transport →
 * socket`, and the same session can outlive many transports across a link
 * that drops and reconnects.
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
   * non-event frames, and frames replayed/redelivered during the handshake —
   * the transport reads `sink.bufferedAmount()`; when it exceeds
   * `maxBufferedBytes` the transport reports a
   * `ws_transport_backpressure_exceeded` warning and closes with
   * `WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED` instead of sending. ADR-062
   * forbids a silent drop here: a dropped `event` frame would create a
   * sequence gap the resume cursor could neither explain nor repair, while
   * the close converts overflow into an honest reconnect-with-cursor —
   * unconditionally safe now that the session (not this transport) records
   * every sequenced event before it is ever handed to a sink, regardless of
   * whether that sink is still attached when the budget check runs. Throws
   * `RangeError` at construction if `maxBufferedBytes` is not a positive
   * finite number.
   */
  backpressure?: { maxBufferedBytes: number };
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
   * The host-owned, reattachable session (ADR-063, `@tuvren/remote-session`)
   * this transport attaches beneath on a successful handshake and detaches
   * from on close. The session — not this transport — owns sequencing, the
   * replay window, and unanswered-`client_invocation` redelivery, so the
   * same session may be attached by a later transport instance after this
   * one closes; the session's `disconnectGraceMs` governs how long that
   * reattach window stays open.
   */
  session: RemoteClientSession;
  /** The socket adapter this transport sends to and closes. */
  sink: WsSocketSink;
}

/**
 * A running WebSocket session transport (ADR-062, as amended by ADR-063).
 *
 * @experimental
 */
export interface WsSessionTransport {
  /**
   * Idempotently closes the connection: closes `sink` with `code` (default
   * `1000`), and — only if this transport's handshake ever succeeded in
   * attaching a sink to `options.session` — detaches from the session. The
   * transport never ends the session itself; detaching only starts (or
   * leaves running) the session's own `disconnectGraceMs` window, so a later
   * transport can still reattach and resume. Hosts MUST call this on every
   * terminal socket condition they observe (error, unexpected close,
   * connection drop) — a transport whose socket dies without `close()` keeps
   * its heartbeat interval scheduled and its session sink still (nominally)
   * attached.
   */
  close(code?: number, reason?: string): void;
  /** Feeds one inbound wire message into the transport. Throws if called before {@link start}. */
  ingest(data: string | Uint8Array): void;
  /** Enters the `awaiting-handshake` state. May only be called once. */
  start(): void;
}

/**
 * Creates a server-side WebSocket session transport over a
 * {@link RemoteClientSession} (ADR-062 as amended by ADR-063,
 * `spec/streaming/ws/typespec/main.tsp`).
 *
 * This is pure carriage: the transport owns only the WebSocket-level
 * concerns — handshake parse/validate, heartbeat, bounded backpressure, and
 * close-code vocabulary. It never claims a `DuplexSessionBinding.outbound()`
 * stream, never creates a sequencer, and never records a replay buffer; all
 * of that is `options.session`'s job for the session's entire life, across
 * however many transports attach and detach beneath it. `start()` merely
 * enters the `awaiting-handshake` state — nothing is claimed and nothing is
 * sent until a valid handshake is ingested.
 *
 * On a valid handshake, the transport calls `options.session.attach(sink,
 * {cursor})`. That call is synchronous and, for a resumed reattach, sends
 * every replayed `event` frame and every redelivered unanswered
 * `client_invocation` through the sink **before returning** — so this
 * transport queues those sends internally and flushes them only after its
 * own `handshake_ack` has gone out, preserving the wire-order contract
 * (ack, then replay/redelivery, then live frames) with a session that no
 * longer waits for the transport to ask for its resume burst one frame at a
 * time.
 *
 * A second concurrent handshake for a session that already has a live sink
 * attached is refused: `session.attach()` throws, and this transport closes
 * the *new* socket with `WS_CLOSE_CODE_HANDSHAKE_INVALID` — reusing the
 * "this handshake cannot be honored" code rather than inventing a new one,
 * since a double-attach is exactly a handshake this transport cannot accept
 * as presented. A handshake against a session that has already permanently
 * ended closes with `WS_CLOSE_CODE_SESSION_NOT_FOUND` — there is no longer a
 * live session for the presented identity to bind to. `RemoteClientSession`
 * does not expose a structured error code for either failure (both are a
 * thrown `Error` with a descriptive message), so this transport
 * distinguishes them by matching a stable substring of that message; see
 * `isSinkAlreadyAttachedError` below.
 *
 * Per ADR-062, frame-level and unrecognized-message problems never close the
 * socket — only handshake failures and the transport's own heartbeat/
 * backpressure policy do. On any close, if this transport's handshake had
 * already attached a sink, the transport calls `session.detach(reason)` —
 * never `close`/end — so the session's `disconnectGraceMs` window (not this
 * transport) decides whether a later reattach is still possible.
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
  // Whether this transport's handshake ever succeeded in attaching a sink to
  // options.session. Gates whether close() detaches (a handshake that never
  // reached attach() has nothing to detach).
  let attached = false;
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

    // The transport never ends or closes the session (ADR-063): a dropped
    // link, a heartbeat half-open close, or a backpressure overflow only
    // detaches this sink, starting (or leaving running) the session's own
    // disconnectGraceMs window so a later transport can still reattach and
    // resume. Skipped entirely when this handshake never reached attach() —
    // there is nothing to detach.
    if (attached) {
      options.session.detach(reason);
    }

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

    try {
      options.sink.send(JSON.stringify({ kind: "ping" }));
    } catch {
      // A throwing send from a timer callback would otherwise surface as an
      // uncaught exception; a sink that cannot send is exactly the half-open
      // condition the heartbeat exists to detect, so close gracefully with
      // the same internal-error discipline the outbound path always used.
      doClose(WS_CLOSE_CODE_INTERNAL_ERROR, "internal error");
      return;
    }

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
      options.session.dispatchInbound(value);
    } catch (error) {
      reportWarning({
        code: "ws_transport_inbound_dispatch_failed",
        details: { error: describeError(error) },
        message:
          "session.dispatchInbound() threw for an inbound WebSocket message",
      });
    }
  }

  /**
   * Sends one outbound envelope (a live frame, a replayed `event`, or a
   * redelivered `client_invocation`), enforcing backpressure first. Returns
   * `false` when the caller must stop — already closed, or this send just
   * overflowed the budget and closed `4005` (backpressure already invoked
   * `doClose`).
   */
  function sendFrameEnvelope(
    frame: SessionOutboundFrame,
    cursor: string | undefined
  ): boolean {
    if (closed) {
      return false;
    }

    if (enforceBackpressure()) {
      return false;
    }

    options.sink.send(
      JSON.stringify(
        cursor === undefined
          ? { frame, kind: "frame" }
          : { cursor, frame, kind: "frame" }
      )
    );
    return true;
  }

  /**
   * Adapts this transport's `WsSocketSink` into the
   * `RemoteClientSessionSink` shape `session.attach()` expects, with one
   * carriage-ordering seam: `session.attach()` is synchronous and, for a
   * resumed reattach, sends every replayed `event` and every redelivered
   * `client_invocation` through this sink **from inside that call**, before
   * `attach()` returns to the caller — i.e. before this transport has had a
   * chance to send its own `handshake_ack`. Every `send()` before
   * {@link release} is called is therefore queued rather than written to the
   * wire; `release()` (called right after the `handshake_ack` is sent) flushes
   * the queue in order, and every `send()` after that point goes straight to
   * the wire. This is what keeps the wire order `handshake_ack`, then
   * replay/redelivery, then live frames — the same order ADR-062 always
   * guaranteed, now produced by a session whose replay/redelivery burst is
   * not paced one frame at a time by this transport's own pump.
   */
  function createSessionSinkAdapter(): {
    release(): boolean;
    sink: RemoteClientSessionSink;
  } {
    let released = false;
    const queued: Array<{
      cursor: string | undefined;
      frame: SessionOutboundFrame;
    }> = [];

    const sink: RemoteClientSessionSink = {
      send(frame: SessionOutboundFrame, cursor?: string): void {
        if (!released) {
          queued.push({ cursor, frame });
          return;
        }
        // A live send after the handshake fully completed; a `false` return
        // means sendFrameEnvelope already closed the connection (or it was
        // already closed), and there is nothing further for this call to do.
        sendFrameEnvelope(frame, cursor);
      },
    };

    return {
      release(): boolean {
        released = true;
        for (const item of queued) {
          if (!sendFrameEnvelope(item.frame, item.cursor)) {
            return false;
          }
        }
        return true;
      },
      sink,
    };
  }

  /**
   * Distinguishes `session.attach()`'s two documented throw cases by their
   * stable `TuvrenRuntimeError` codes (`remote_session_already_attached` vs
   * `remote_session_ended`) — the core error contract's rule that callers
   * branch on `code`, never on message text. Anything that is not the
   * already-attached code (including a non-Tuvren error) falls through to
   * the session-not-found close below.
   */
  function isSinkAlreadyAttachedError(error: unknown): boolean {
    return (
      error instanceof TuvrenRuntimeError &&
      error.code === REMOTE_SESSION_ALREADY_ATTACHED
    );
  }

  /**
   * Attaches this transport's sink adapter to `options.session` for the
   * given (already-authorized) handshake request, closing the connection
   * with the appropriate code when the session refuses the attach. Split
   * out of {@link processHandshake} purely to keep that function's own
   * branching within the lint-enforced cognitive-complexity budget — no
   * behavioral seam.
   */
  function attachToSession(cursor: string | undefined): void {
    const adapter = createSessionSinkAdapter();
    let attachResult: RemoteClientSessionAttachResult;

    try {
      attachResult = options.session.attach(adapter.sink, { cursor });
    } catch (error) {
      if (isSinkAlreadyAttachedError(error)) {
        doClose(
          WS_CLOSE_CODE_HANDSHAKE_INVALID,
          "a live sink is already attached to this session; a concurrent second handshake cannot be honored"
        );
        return;
      }

      doClose(
        WS_CLOSE_CODE_SESSION_NOT_FOUND,
        "this remote client session has already ended and can no longer be attached"
      );
      return;
    }

    attached = true;
    handshakeDone = true;

    try {
      options.sink.send(
        JSON.stringify({
          kind: "handshake_ack",
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          resumeStatus: attachResult.resumeStatus,
          sessionId: options.session.sessionId,
        })
      );
    } catch (error) {
      // A sink that cannot even carry the ack is a dead socket: close (which
      // detaches, since attach succeeded above) instead of leaving a
      // half-initialized transport whose only recovery would be heartbeat
      // half-open detection — or nothing at all when heartbeat is disabled.
      reportWarning({
        code: "ws_transport_ack_send_failed",
        message: `handshake_ack could not be sent on the socket sink: ${describeError(error)}`,
      });
      doClose(
        WS_CLOSE_CODE_INTERNAL_ERROR,
        "handshake_ack could not be sent on the socket sink"
      );
      return;
    }

    if (closed) {
      return;
    }

    // Flushes the replay/redelivery burst session.attach() queued above, in
    // order, honoring the same backpressure guard as any live send.
    if (!adapter.release()) {
      return;
    }

    if (closed) {
      return;
    }

    // Heartbeat pings start only once the handshake has fully completed
    // (ack plus any replay/redelivery burst sent), per ADR-062 §6.
    startHeartbeat();
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
      message.sessionId !== options.session.sessionId
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

    attachToSession(message.cursor);
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
      // preserved (replay/redelivery-before-live, handshake-before-frames)
      // even when options.authorize is async and a later ingest() call
      // arrives first. The chain itself never rejects (a throwing
      // authorize() is reported as a warning instead) so one bad message can
      // never wedge every subsequent ingest() call behind a rejected
      // promise.
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
      // Nothing to claim eagerly: options.session claims its underlying
      // binding's outbound() stream lazily, on its own first attach() call
      // (ADR-063), which this transport triggers only once a valid
      // handshake is ingested. The transport is in the awaiting-handshake
      // state until then — nothing is sent.
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
