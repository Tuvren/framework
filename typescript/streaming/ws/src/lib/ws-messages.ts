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
 * Wire message shapes for the `tuvren.framework.event-stream-ws` authority
 * packet (`spec/streaming/ws/typespec/main.tsp`, ADR-062) and a pure,
 * throw-free structural parser for them.
 *
 * Every wire message is a JSON text frame discriminated by `kind`. This
 * module owns carriage-level structure only: it validates the envelope
 * fields the transport itself reads (the `kind` discriminator, the
 * handshake fields, and the `cursor` string) and deliberately never
 * validates the inner `frame` payload carried by a {@link WsOutboundFrameEnvelope}
 * or {@link WsInboundFrameEnvelope} — that payload is owned and validated by
 * the `tuvren.framework.host-session` binding (the layering rule recorded in
 * `spec/streaming/ws/bindings/typescript.md`).
 *
 * @packageDocumentation
 */

/**
 * Client-to-server handshake, the first message a client sends after the
 * socket opens.
 *
 * @experimental
 */
export interface WsHandshakeRequest {
  /** Opaque authentication material, carried to the host unmodified. */
  authToken?: string;
  /** Opaque resume cursor from a previous connection (semantics owned by the event-stream-resume surface). */
  cursor?: string;
  kind: "handshake";
  /** Wire protocol version literal; echoed, never negotiated. */
  protocolVersion: string;
  /** Session identity the client expects to attach to. */
  sessionId?: string;
}

/**
 * Server-to-client handshake acknowledgement, the first message a server
 * sends.
 *
 * @experimental
 */
export interface WsHandshakeAck {
  kind: "handshake_ack";
  protocolVersion: string;
  /** Outcome of the client's resume request. */
  resumeStatus: WsResumeStatus;
  /** Session identity the connection is bound to. */
  sessionId: string;
}

/**
 * Handshake resume outcomes (projects the event-stream-resume `ReplayResult`
 * vocabulary plus `"none"` for a fresh connection).
 *
 * @experimental
 */
export type WsResumeStatus =
  | "resumed"
  | "out-of-window"
  | "unknown-turn"
  | "none";

/**
 * Outbound envelope carrying one session frame from the host to the remote
 * peer. `frame` is a `SessionOutboundFrame` (packet
 * `tuvren.framework.host-session`); this envelope adds carriage fields only
 * and this module never inspects `frame`'s contents.
 *
 * @experimental
 */
export interface WsOutboundFrameEnvelope {
  /** Present exactly when the wrapped session frame has `kind: "event"`. */
  cursor?: string;
  frame: unknown;
  kind: "frame";
}

/**
 * Inbound envelope carrying one session frame from the remote peer to the
 * host. `frame` is a `SessionInboundFrame` per the host-session authority
 * packet; validation and rejection semantics belong to the session binding,
 * not this transport.
 *
 * @experimental
 */
export interface WsInboundFrameEnvelope {
  frame: unknown;
  kind: "frame";
}

/**
 * Application-level heartbeat probe. Either side MAY send `ping`; the
 * receiver MUST answer with `pong`.
 *
 * @experimental
 */
export interface WsPing {
  kind: "ping";
}

/** Answer to {@link WsPing}. @experimental */
export interface WsPong {
  kind: "pong";
}

/** Every message kind a client may send. @experimental */
export type WsClientMessage =
  | WsHandshakeRequest
  | WsInboundFrameEnvelope
  | WsPing
  | WsPong;

/** Every message kind a server may send. @experimental */
export type WsServerMessage =
  | WsHandshakeAck
  | WsOutboundFrameEnvelope
  | WsPing
  | WsPong;

/**
 * Result of {@link parseWsMessage}: a discriminated union covering every
 * recognized wire message kind plus an `"unparseable"` catch-all for
 * malformed JSON, non-object payloads, and unrecognized `kind` values.
 * `parseWsMessage` never throws — every input maps to exactly one of these
 * variants.
 *
 * @experimental
 */
export type ParsedWsMessage =
  | { kind: "handshake"; message: WsHandshakeRequest }
  | { kind: "handshake_ack"; message: WsHandshakeAck }
  | { kind: "frame"; frame: unknown }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "unparseable"; raw: unknown };

const WS_RESUME_STATUSES: readonly WsResumeStatus[] = [
  "resumed",
  "out-of-window",
  "unknown-turn",
  "none",
];

const utf8Decoder = new TextDecoder();

/**
 * Decodes and structurally parses one wire message: UTF-8-decodes a
 * `Uint8Array` payload, `JSON.parse`s the resulting text, and validates only
 * the transport-owned envelope fields for the message's `kind` (never the
 * inner `frame` payload of a frame envelope — see the module doc's layering
 * rule). Malformed JSON, a non-object payload, or an object without a
 * recognized/well-formed `kind` all resolve to the `"unparseable"` variant
 * carrying whatever value was parsed (or the raw decoded text when `JSON.parse`
 * itself failed). This function never throws.
 *
 * @experimental
 */
export function parseWsMessage(data: string | Uint8Array): ParsedWsMessage {
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
    case "handshake": {
      const message = asHandshakeRequest(parsed);
      return message === undefined
        ? { kind: "unparseable", raw: parsed }
        : { kind: "handshake", message };
    }
    case "handshake_ack": {
      const message = asHandshakeAck(parsed);
      return message === undefined
        ? { kind: "unparseable", raw: parsed }
        : { kind: "handshake_ack", message };
    }
    case "frame": {
      return { frame: parsed.frame, kind: "frame" };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function asHandshakeRequest(
  candidate: Record<string, unknown>
): WsHandshakeRequest | undefined {
  if (typeof candidate.protocolVersion !== "string") {
    return undefined;
  }

  if (
    !(
      isOptionalString(candidate.sessionId) &&
      isOptionalString(candidate.cursor) &&
      isOptionalString(candidate.authToken)
    )
  ) {
    return undefined;
  }

  const message: WsHandshakeRequest = {
    kind: "handshake",
    protocolVersion: candidate.protocolVersion,
  };

  if (candidate.sessionId !== undefined) {
    message.sessionId = candidate.sessionId as string;
  }
  if (candidate.cursor !== undefined) {
    message.cursor = candidate.cursor as string;
  }
  if (candidate.authToken !== undefined) {
    message.authToken = candidate.authToken as string;
  }

  return message;
}

function asHandshakeAck(
  candidate: Record<string, unknown>
): WsHandshakeAck | undefined {
  if (typeof candidate.protocolVersion !== "string") {
    return undefined;
  }

  if (typeof candidate.sessionId !== "string") {
    return undefined;
  }

  if (
    typeof candidate.resumeStatus !== "string" ||
    !WS_RESUME_STATUSES.includes(candidate.resumeStatus as WsResumeStatus)
  ) {
    return undefined;
  }

  return {
    kind: "handshake_ack",
    protocolVersion: candidate.protocolVersion,
    resumeStatus: candidate.resumeStatus as WsResumeStatus,
    sessionId: candidate.sessionId,
  };
}
