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
 * A pure, throw-free structural parser for the server-to-client messages this
 * package needs to understand, mirroring `parseWsMessage` in
 * `typescript/streaming/ws/src/lib/ws-messages.ts` (this package cannot
 * import that module without taking on a workspace dependency; see the
 * zero-dependency rationale in `./session-protocol-types.ts`). Only the
 * message kinds a client ever receives are decoded here (`handshake_ack`,
 * `frame`, `ping`, `pong`); a client never receives a bare `handshake`.
 *
 * One deliberate divergence from `@tuvren/stream-ws`'s `ParsedWsMessage`:
 * this parser's `"frame"` variant also surfaces the envelope's `cursor`
 * field. `@tuvren/stream-ws`'s own `"frame"` variant drops it, which is
 * correct for that package's actual use — `parseWsMessage` there only ever
 * parses *inbound* messages arriving at the server (`WsInboundFrameEnvelope`,
 * which never carries `cursor`); the server's own outbound sends, which do
 * carry `cursor`, are serialized directly, never round-tripped back through
 * that parser. This package's parser runs on the opposite side of the wire —
 * it is the one that actually receives `WsOutboundFrameEnvelope` messages —
 * so dropping `cursor` here would silently discard the resume token every
 * `event` frame carries.
 *
 * @packageDocumentation
 */

import type {
  SessionClientHandshakeAck,
  SessionClientResumeStatus,
} from "./session-protocol-types.js";

/**
 * Result of {@link parseWsClientMessage}. Mirrors `ParsedWsMessage` from
 * `@tuvren/stream-ws` for the subset a client peer receives.
 *
 * @experimental
 */
export type ParsedWsClientMessage =
  | { kind: "handshake_ack"; message: SessionClientHandshakeAck }
  | { kind: "frame"; frame: unknown; cursor?: string }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "unparseable"; raw: unknown };

const WS_RESUME_STATUSES: readonly SessionClientResumeStatus[] = [
  "resumed",
  "out-of-window",
  "unknown-turn",
  "none",
];

const utf8Decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asHandshakeAck(
  candidate: Record<string, unknown>
): SessionClientHandshakeAck | undefined {
  if (typeof candidate.protocolVersion !== "string") {
    return undefined;
  }
  if (typeof candidate.sessionId !== "string") {
    return undefined;
  }
  if (
    typeof candidate.resumeStatus !== "string" ||
    !WS_RESUME_STATUSES.includes(
      candidate.resumeStatus as SessionClientResumeStatus
    )
  ) {
    return undefined;
  }
  return {
    kind: "handshake_ack",
    protocolVersion: candidate.protocolVersion,
    resumeStatus: candidate.resumeStatus as SessionClientResumeStatus,
    sessionId: candidate.sessionId,
  };
}

/**
 * Decodes and structurally parses one inbound wire message. Never throws:
 * malformed JSON, a non-object payload, or an object with no recognized
 * `kind` all resolve to the `"unparseable"` variant.
 *
 * @experimental
 */
export function parseWsClientMessage(
  data: string | Uint8Array
): ParsedWsClientMessage {
  const text = typeof data === "string" ? data : utf8Decoder.decode(data);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unparseable", raw: text };
  }

  if (!isRecord(parsed)) {
    return { kind: "unparseable", raw: parsed };
  }

  switch (parsed.kind) {
    case "handshake_ack": {
      const message = asHandshakeAck(parsed);
      return message === undefined
        ? { kind: "unparseable", raw: parsed }
        : { kind: "handshake_ack", message };
    }
    case "frame": {
      return typeof parsed.cursor === "string"
        ? { cursor: parsed.cursor, frame: parsed.frame, kind: "frame" }
        : { frame: parsed.frame, kind: "frame" };
    }
    case "ping": {
      return { kind: "ping" };
    }
    case "pong": {
      return { kind: "pong" };
    }
    default: {
      return { kind: "unparseable", raw: parsed };
    }
  }
}

/**
 * Connection-level close codes in the WebSocket application range
 * (4000-4999), mirroring `WS_CLOSE_CODE_*` from `@tuvren/stream-ws`
 * (`typescript/streaming/ws/src/lib/ws-close-codes.ts`) — duplicated here
 * rather than imported, per this package's zero-dependency design (see
 * `./session-protocol-types.ts`).
 *
 * @experimental
 */
export const WS_CLOSE_CODE_HANDSHAKE_INVALID = 4000;
/** @experimental */
export const WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED = 4001;
/** @experimental */
export const WS_CLOSE_CODE_SESSION_NOT_FOUND = 4002;
/** @experimental */
export const WS_CLOSE_CODE_AUTH_REJECTED = 4003;
/** @experimental */
export const WS_CLOSE_CODE_HEARTBEAT_TIMEOUT = 4004;
/** @experimental */
export const WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED = 4005;
/** Standard WebSocket normal-closure code. @experimental */
export const WS_CLOSE_CODE_NORMAL = 1000;

/**
 * Close codes after which this client MUST NOT attempt to reconnect: the
 * server has told us the handshake itself can never succeed as presented
 * (bad protocol version, unknown session, rejected auth, malformed
 * handshake) or the session ended normally. Every other close code —
 * including the two connection-level policy closes the transport can also
 * emit (`4004` heartbeat timeout, `4005` backpressure exceeded) and any
 * abnormal/unspecified closure (for example code `1006`, which browsers
 * report for a dropped TCP connection with no server-sent close frame) — is
 * retryable: the peer or the network hiccuped, not the protocol negotiation.
 *
 * @experimental
 */
export const NON_RETRYABLE_WS_CLOSE_CODES: ReadonlySet<number> = new Set([
  WS_CLOSE_CODE_HANDSHAKE_INVALID,
  WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED,
  WS_CLOSE_CODE_SESSION_NOT_FOUND,
  WS_CLOSE_CODE_AUTH_REJECTED,
  WS_CLOSE_CODE_NORMAL,
]);

/**
 * Whether a reconnect should be attempted after a close carrying `code`.
 * `undefined` (no close code observed at all, e.g. a `WebSocket` fake or
 * runtime that never populates `CloseEvent.code`) is treated as retryable —
 * the safer default when the reason for the drop is unknown.
 *
 * @experimental
 */
export function isRetryableCloseCode(code: number | undefined): boolean {
  return code === undefined || !NON_RETRYABLE_WS_CLOSE_CODES.has(code);
}
