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

import {
  SESSION_PROTOCOL_VERSION,
  type SessionClientApprovalResponse,
  type SessionClientInboundRejection,
  type SessionClientInputSignal,
  type SessionClientInvocationEnvelope,
  type SessionClientReportedResult,
} from "./session-protocol-types.js";
import { isRetryableCloseCode, parseWsClientMessage } from "./ws-wire.js";

/**
 * The minimal socket surface this package needs from a `WebSocket`-shaped
 * object: `send`/`close` plus the four `on*` callback properties every
 * standard `WebSocket` implementation exposes (browser, Bun, Node >=22's
 * global `WebSocket`). Using assignable callback properties rather than
 * `addEventListener` keeps the seam trivial for a test double to satisfy
 * without also implementing `EventTarget`.
 *
 * @experimental
 */
export interface SessionClientSocket {
  close(code?: number, reason?: string): void;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string | Uint8Array }) => void) | null;
  onopen: (() => void) | null;
  send(data: string): void;
}

/**
 * Injectable timer pair backing the reconnect backoff scheduler, mirroring
 * `RemoteSessionClock` in `@tuvren/remote-session`
 * (`typescript/host/remote-session/src/lib/remote-client-session.ts`). Tests
 * supply a fake so backoff delays are driven deterministically rather than by
 * a real wall-clock sleep.
 *
 * @experimental
 */
export interface SessionClientClock {
  clearTimeout(handle: unknown): void;
  scheduleTimeout(callback: () => void, ms: number): unknown;
}

const globalClock: SessionClientClock = {
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  scheduleTimeout(callback: () => void, ms: number): unknown {
    return setTimeout(callback, ms);
  },
};

/**
 * Context passed to every capability handler alongside its `input`.
 *
 * @experimental
 */
export interface SessionClientCapabilityContext {
  /** The call this invocation answers. Echoed on the resulting `client_result`. */
  callId: string;
  /** The capability identifier this envelope dispatched to. */
  capabilityId: string;
  /**
   * Side-effect-once idempotency identity (ADR-052 as amended by ADR-065). A
   * handler that drives an external system with a non-idempotent effect
   * should present this key to that system so a redelivered invocation (same
   * `callId`, same key) after a reconnect does not double the effect.
   */
  idempotencyKey?: string;
}

/**
 * A capability handler this client registers for one `capabilityId`.
 * Resolving produces the `content` of a successful `client_result`; throwing
 * (or rejecting) produces `{ isError: true, content: { error: message } }` —
 * the handler never needs to shape the error envelope itself, and the
 * promise this function returns is always settled, never left dangling.
 *
 * @experimental
 */
export type SessionClientCapabilityHandler = (
  input: unknown,
  ctx: SessionClientCapabilityContext
) => Promise<unknown> | unknown;

/**
 * Connection status this client surfaces via `onStatusChange`.
 *
 * @experimental
 */
export type SessionClientStatus =
  | { phase: "connecting" }
  | { phase: "open"; resumeStatus: string }
  | { phase: "reconnecting"; attempt: number; delayMs: number }
  | { phase: "closed"; code?: number; reason?: string; terminal: boolean };

/**
 * Reconnect backoff tuning. All fields optional; see
 * {@link createSessionClient} for defaults. Every field, when provided, must
 * be a positive finite number; {@link createSessionClient} throws
 * `RangeError` at construction otherwise.
 *
 * @experimental
 */
export interface SessionClientReconnectOptions {
  /** Delay before the first reconnect attempt, in milliseconds. Defaults to `250`. */
  baseDelayMs?: number;
  /** Maximum consecutive reconnect attempts before giving up as terminal. Defaults to `Infinity`. */
  maxAttempts?: number;
  /** Upper bound for the exponential backoff delay, in milliseconds. Defaults to `10000`. */
  maxDelayMs?: number;
}

/**
 * Options accepted by {@link createSessionClient}.
 *
 * @experimental
 */
export interface SessionClientOptions {
  /** Opaque authentication material, carried to the host unmodified. */
  authToken?: string;
  /**
   * Capability handlers, keyed by `capabilityId`.
   *
   * **Known limitation — unbounded answered-call retention.** Every settled
   * `callId` this client has ever answered is retained for the lifetime of
   * the client instance (see `callState` in `createSessionClient`), never
   * evicted. This is a deliberate, conservative choice, not an oversight: the
   * duplex session protocol has no result-ack frame, so this client cannot
   * learn when the server has durably recorded a `client_result` and it is
   * therefore safe to forget. An LRU or size-bounded cache would silently
   * weaken the redelivery-dedup guarantee `handleInvocation` relies on — a
   * long-lived connection that evicted an old `callId` could re-run a
   * handler's non-idempotent effect on a very late redelivery. Callers
   * running this client for very long-lived sessions with very many calls
   * should be aware memory grows with total answered-call count.
   */
  capabilities: Record<string, SessionClientCapabilityHandler>;
  /** Injectable timer pair for the reconnect backoff scheduler. Defaults to the global timers. */
  clock?: SessionClientClock;
  /** Called for every canonical stream event the host forwards. */
  onEvent?: (event: unknown, cursor?: string) => void;
  /** Called for every `session_rejection` frame the host sends. */
  onRejection?: (rejection: SessionClientInboundRejection) => void;
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: SessionClientStatus) => void;
  /** Reconnect backoff tuning. */
  reconnect?: SessionClientReconnectOptions;
  /**
   * Session identity to attach to; carried on the handshake and every frame.
   * Must be a non-empty string; {@link createSessionClient} throws
   * `RangeError` at construction otherwise.
   */
  sessionId: string;
  /**
   * WebSocket URL of the host's session endpoint. Must be a non-empty
   * string; {@link createSessionClient} throws `RangeError` at construction
   * otherwise.
   */
  url: string;
  /** Injection seam for tests: builds the socket for a given URL. Defaults to `new WebSocket(url)`. */
  webSocketFactory?: (url: string) => SessionClientSocket;
}

/**
 * The handle returned by {@link createSessionClient}.
 *
 * @experimental
 */
export interface SessionClientHandle {
  /**
   * Sends an `approval_response` frame for a paused run. If the current
   * socket's handshake has not yet been acknowledged (still connecting, or
   * mid-reconnect backoff), the frame is queued and flushed in order once
   * the next `handshake_ack` arrives, rather than dropped.
   */
  approve(response: SessionClientApprovalResponse): void;
  /**
   * Sends a `cancel` frame for the active run. If the current socket's
   * handshake has not yet been acknowledged (still connecting, or
   * mid-reconnect backoff), the frame is queued and flushed in order once
   * the next `handshake_ack` arrives, rather than dropped.
   */
  cancel(): void;
  /**
   * Closes the connection permanently; no further reconnect attempts are
   * made. If called while a reconnect backoff is pending (no live socket),
   * the terminal `closed` status is reported directly, since no `onclose`
   * event will ever fire to report it otherwise.
   */
  close(code?: number, reason?: string): void;
  /** Opens the connection (and begins the reconnect lifecycle on drop). No-op if already connecting/open. */
  connect(): void;
  /**
   * Sends a `steer` frame carrying mid-run input. If the current socket's
   * handshake has not yet been acknowledged (still connecting, or
   * mid-reconnect backoff), the frame is queued and flushed in order once
   * the next `handshake_ack` arrives, rather than dropped.
   */
  steer(signal: SessionClientInputSignal): void;
}

type CallState =
  | { status: "in-flight" }
  | { status: "answered"; result: SessionClientReportedResult };

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for a `client_invocation` frame's `invocation` field.
 * This package trusts the wire only as far as its shape: a malformed or
 * missing invocation (absent, non-object, or missing/non-string `callId` /
 * `capabilityId` / `leaseToken`) must never throw inside the `onmessage`
 * handler — it is simply ignored, same server-trust-boundary posture as
 * {@link parseWsClientMessage}'s throw-free parsing.
 */
function isInvocationEnvelope(
  value: unknown
): value is SessionClientInvocationEnvelope {
  return (
    isRecord(value) &&
    isNonEmptyString(value.callId) &&
    isNonEmptyString(value.capabilityId) &&
    isNonEmptyString(value.leaseToken)
  );
}

function validateOptions(options: SessionClientOptions): void {
  if (!isNonEmptyString(options.url)) {
    throw new RangeError("createSessionClient: url must be a non-empty string");
  }
  if (!isNonEmptyString(options.sessionId)) {
    throw new RangeError(
      "createSessionClient: sessionId must be a non-empty string"
    );
  }
  const reconnect = options.reconnect;
  if (
    reconnect?.baseDelayMs !== undefined &&
    !isPositiveFiniteNumber(reconnect.baseDelayMs)
  ) {
    throw new RangeError(
      "createSessionClient: reconnect.baseDelayMs must be a positive finite number"
    );
  }
  if (
    reconnect?.maxDelayMs !== undefined &&
    !isPositiveFiniteNumber(reconnect.maxDelayMs)
  ) {
    throw new RangeError(
      "createSessionClient: reconnect.maxDelayMs must be a positive finite number"
    );
  }
  if (
    reconnect?.maxAttempts !== undefined &&
    !isPositiveFiniteNumber(reconnect.maxAttempts)
  ) {
    throw new RangeError(
      "createSessionClient: reconnect.maxAttempts must be a positive finite number"
    );
  }
}

let correlationCounter = 0;

function nextCorrelationId(): string {
  const cryptoGlobal = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  if (typeof cryptoGlobal?.randomUUID === "function") {
    return cryptoGlobal.randomUUID();
  }
  correlationCounter += 1;
  return `session-client-correlation-${correlationCounter}`;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a thin, reference-quality remote peer for the Tuvren duplex
 * session protocol over WebSocket. See the package-level doc comment in
 * `../index.ts` for the wire contract this implements.
 *
 * @experimental
 */
export function createSessionClient(
  options: SessionClientOptions
): SessionClientHandle {
  validateOptions(options);
  const clock = options.clock ?? globalClock;
  const maxAttempts =
    options.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY;
  const baseDelayMs = options.reconnect?.baseDelayMs ?? 250;
  const maxDelayMs = options.reconnect?.maxDelayMs ?? 10_000;
  const webSocketFactory =
    options.webSocketFactory ??
    ((url: string) => new WebSocket(url) as unknown as SessionClientSocket);

  let socket: SessionClientSocket | undefined;
  let closedByUser = false;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown;
  let lastCursor: string | undefined;
  // Set once the current socket's handshake_ack has been observed, cleared on
  // every close. Sending an inbound control frame before the ack lands can
  // throw (socket still `CONNECTING`) or, worse, hand the server a
  // non-handshake first message it closes with `WS_CLOSE_CODE_HANDSHAKE_INVALID`
  // (4000) — the handshake is defined to be the first frame on every fresh
  // connection. See `outboundQueue` below for what happens to a frame sent
  // before this is true.
  let handshakeOpen = false;
  // Outbound `client_result` / `approval_response` / `steer` / `cancel`
  // frames queued because `handshakeOpen` was false when they were sent.
  // Queuing (rather than dropping) is the deliberate choice here: a `steer()`
  // or `approve()` call made while a reconnect is in flight represents real
  // user/handler intent that should still reach the server once the
  // connection is re-established, not silently vanish because of a backoff
  // window the caller has no visibility into. The queue is flushed in order
  // as soon as the next `handshake_ack` arrives, and is cleared (not
  // re-queued) if the user calls `close()` themselves.
  const outboundQueue: unknown[] = [];
  const callState = new Map<string, CallState>();

  function reportStatus(status: SessionClientStatus): void {
    options.onStatusChange?.(status);
  }

  function sendInboundFrame(frame: unknown): void {
    if (socket === undefined || !handshakeOpen) {
      outboundQueue.push(frame);
      return;
    }
    socket.send(JSON.stringify({ frame, kind: "frame" }));
  }

  function flushOutboundQueue(): void {
    if (socket === undefined) {
      return;
    }
    const queued = outboundQueue.splice(0, outboundQueue.length);
    for (const frame of queued) {
      socket.send(JSON.stringify({ frame, kind: "frame" }));
    }
  }

  function sendClientResult(result: SessionClientReportedResult): void {
    sendInboundFrame({
      correlationId: nextCorrelationId(),
      kind: "client_result",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      result,
      sessionId: options.sessionId,
    });
  }

  function settle(
    envelope: SessionClientInvocationEnvelope,
    result: SessionClientReportedResult
  ): void {
    callState.set(envelope.callId, { result, status: "answered" });
    sendClientResult(result);
  }

  function errorResult(
    envelope: SessionClientInvocationEnvelope,
    message: string
  ): SessionClientReportedResult {
    return {
      callId: envelope.callId,
      content: { error: message },
      isError: true,
      leaseToken: envelope.leaseToken,
    };
  }

  function handleInvocation(envelope: SessionClientInvocationEnvelope): void {
    const existing = callState.get(envelope.callId);
    if (existing !== undefined) {
      if (existing.status === "answered") {
        // The server redelivered a client_invocation whose original result it
        // never received (ADR-063 §3). Re-send the recorded result rather
        // than re-run the handler — the handler already produced this
        // answer, and re-executing it could double a non-idempotent effect
        // the idempotencyKey contract exists precisely to avoid.
        sendClientResult(existing.result);
      }
      // "in-flight": a redelivery arrived while the first dispatch is still
      // running. Ignore it; the running handler will answer once, and that
      // single answer settles this callId.
      return;
    }

    callState.set(envelope.callId, { status: "in-flight" });

    const handler = options.capabilities[envelope.capabilityId];
    if (handler === undefined) {
      settle(
        envelope,
        errorResult(
          envelope,
          `no capability handler registered for capabilityId "${envelope.capabilityId}"`
        )
      );
      return;
    }

    Promise.resolve()
      .then(() =>
        handler(envelope.input, {
          callId: envelope.callId,
          capabilityId: envelope.capabilityId,
          idempotencyKey: envelope.idempotencyKey,
        })
      )
      .then((content) => {
        settle(envelope, {
          callId: envelope.callId,
          // `content ?? null`, not `content` verbatim: a handler that
          // resolves `undefined` (the common case for a void handler) would
          // otherwise produce `JSON.stringify({..., content: undefined,
          // ...})`, which drops the `content` key entirely. Both the
          // server's `validateInboundFrame` and
          // `@tuvren/remote-session`'s `extractSettleableClientResultCallId`
          // require `"content" in result` to accept a `client_result`; a
          // dropped key fails that check, the frame is rejected as
          // `session_frame_invalid`, and the redelivery-tracking entry this
          // callId depended on is never cleared — triggering a redelivery
          // loop and, eventually, a dispatch timeout. `null` serializes and
          // satisfies both checks.
          content: content ?? null,
          leaseToken: envelope.leaseToken,
        });
      })
      .catch((error: unknown) => {
        settle(envelope, errorResult(envelope, errorMessageOf(error)));
      });
  }

  function handleOutboundFrame(frame: unknown): void {
    if (typeof frame !== "object" || frame === null || !("kind" in frame)) {
      return;
    }
    const record = frame as Record<string, unknown>;
    const kind = record.kind;
    if (kind === "event") {
      options.onEvent?.(record.event, lastCursor);
      return;
    }
    if (kind === "client_invocation") {
      // Server-trust-boundary hygiene: a malformed `client_invocation` (no
      // `invocation` field, a non-object one, or one missing/mistyping
      // `callId` / `capabilityId` / `leaseToken`) must not crash the
      // `onmessage` handler and take down every future frame on this socket.
      // Silently ignore it — there is no rejection channel back to the
      // server for a carriage-level shape problem, and `onRejection` is
      // reserved for the server's own `session_rejection` frames, not
      // client-observed malformity.
      if (!isInvocationEnvelope(record.invocation)) {
        return;
      }
      handleInvocation(record.invocation);
      return;
    }
    if (kind === "session_rejection") {
      options.onRejection?.(record.rejection as SessionClientInboundRejection);
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) {
      clock.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function scheduleReconnect(
    code: number | undefined,
    reason: string | undefined
  ): void {
    reconnectAttempt += 1;
    if (reconnectAttempt > maxAttempts) {
      reportStatus({ code, phase: "closed", reason, terminal: true });
      return;
    }
    const delayMs = Math.min(
      maxDelayMs,
      baseDelayMs * 2 ** (reconnectAttempt - 1)
    );
    reportStatus({ attempt: reconnectAttempt, delayMs, phase: "reconnecting" });
    reconnectTimer = clock.scheduleTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delayMs);
  }

  function openSocket(): void {
    reportStatus({ phase: "connecting" });
    const nextSocket = webSocketFactory(options.url);
    socket = nextSocket;

    nextSocket.onopen = () => {
      nextSocket.send(
        JSON.stringify({
          authToken: options.authToken,
          cursor: lastCursor,
          kind: "handshake",
          protocolVersion: SESSION_PROTOCOL_VERSION,
          sessionId: options.sessionId,
        })
      );
    };

    nextSocket.onmessage = (event) => {
      const parsed = parseWsClientMessage(event.data);
      switch (parsed.kind) {
        case "handshake_ack": {
          reconnectAttempt = 0;
          handshakeOpen = true;
          flushOutboundQueue();
          reportStatus({
            phase: "open",
            resumeStatus: parsed.message.resumeStatus,
          });
          break;
        }
        case "frame": {
          if (parsed.cursor !== undefined) {
            lastCursor = parsed.cursor;
          }
          handleOutboundFrame(parsed.frame);
          break;
        }
        case "ping": {
          nextSocket.send(JSON.stringify({ kind: "pong" }));
          break;
        }
        case "pong":
        case "unparseable": {
          break;
        }
        default: {
          break;
        }
      }
    };

    nextSocket.onclose = (event) => {
      socket = undefined;
      handshakeOpen = false;
      if (closedByUser) {
        reportStatus({
          code: event.code,
          phase: "closed",
          reason: event.reason,
          terminal: true,
        });
        return;
      }
      if (isRetryableCloseCode(event.code)) {
        scheduleReconnect(event.code, event.reason);
        return;
      }
      reportStatus({
        code: event.code,
        phase: "closed",
        reason: event.reason,
        terminal: true,
      });
    };

    nextSocket.onerror = () => undefined;
  }

  function connect(): void {
    if (socket !== undefined || reconnectTimer !== undefined) {
      return;
    }
    closedByUser = false;
    reconnectAttempt = 0;
    openSocket();
  }

  function close(code = 1000, reason?: string): void {
    closedByUser = true;
    const wasWaitingOnBackoff = reconnectTimer !== undefined;
    clearReconnectTimer();
    if (socket === undefined) {
      // No live socket to close: either never connected, or currently
      // waiting out a reconnect backoff window. Neither case will ever fire
      // `onclose` to report the terminal status this call promises, so emit
      // it directly. `wasWaitingOnBackoff` distinguishes this from the
      // never-connected case only in spirit — both report the same terminal
      // status shape; the point is that the caller unconditionally observes
      // a terminal `closed` status after calling `close()`, regardless of
      // which connection phase it was called in.
      if (wasWaitingOnBackoff) {
        reportStatus({ code, phase: "closed", reason, terminal: true });
      }
      return;
    }
    socket.close(code, reason);
  }

  function approve(response: SessionClientApprovalResponse): void {
    sendInboundFrame({
      correlationId: nextCorrelationId(),
      kind: "approval_response",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      response,
      sessionId: options.sessionId,
    });
  }

  function steer(signal: SessionClientInputSignal): void {
    sendInboundFrame({
      correlationId: nextCorrelationId(),
      kind: "steer",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      signal,
    });
  }

  function cancel(): void {
    sendInboundFrame({
      correlationId: nextCorrelationId(),
      kind: "cancel",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      sessionId: options.sessionId,
    });
  }

  return { approve, cancel, close, connect, steer };
}
