import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/event-stream-ws/")
namespace Tuvren.Framework.EventStreamWs;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

/**
 * Client-to-server handshake, the first message a client sends after the
 * socket opens. The transport carries the session protocol only after a
 * successful handshake exchange.
 */
model WsHandshakeRequest {
  kind: "handshake";

  /**
   * Wire protocol version literal. Mirrors the per-frame `protocolVersion`
   * discipline of the session frame vocabulary: a future incompatible
   * handshake ships as a new literal, never a negotiated value.
   */
  protocolVersion: "1";

  /**
   * Session identity the client expects to attach to. Omitted on a first
   * connection; a server MUST close with code 4002 (`session_not_found`)
   * when a presented `sessionId` does not match the bound session.
   */
  sessionId?: NonEmptyString;

  /**
   * Opaque resume cursor from a previous connection (semantics owned by the
   * event-stream-resume surface, packet `tuvren.framework.event-stream-resume`).
   * The transport passes it to the host's replay window verbatim and never
   * decodes it.
   */
  cursor?: NonEmptyString;

  /**
   * Opaque authentication material. The transport carries it to the host
   * unmodified and never inspects it; a host that rejects it closes with
   * code 4003 (`auth_rejected`).
   */
  authToken?: NonEmptyString;
}

/**
 * Server-to-client handshake acknowledgement, the first message a server
 * sends. After this message the server emits replayed frames (when
 * `resumeStatus` is `resumed`) followed by live frames.
 */
model WsHandshakeAck {
  kind: "handshake_ack";
  protocolVersion: "1";

  /** Session identity the connection is bound to. */
  sessionId: NonEmptyString;

  /**
   * Outcome of the client's resume request. Projects the
   * event-stream-resume `ReplayStatus` vocabulary; `none` means the client
   * presented no cursor. Every non-`resumed` status means the client MUST
   * treat durable state as truth (snapshot fallback) — missed events are not
   * reconstructable through this transport.
   */
  resumeStatus: WsResumeStatus;
}

/** Handshake resume outcomes. */
enum WsResumeStatus {
  /** The replay window retained the cursor position; missed frames are replayed before live frames. */
  resumed: "resumed",

  /** The cursor decoded but its position is no longer retained; snapshot fallback. */
  outOfWindow: "out-of-window",

  /** The replay window retains no frames for the cursor's turn; snapshot fallback. */
  unknownTurn: "unknown-turn",

  /** The client presented no cursor (fresh connection). */
  none: "none",
}

/**
 * Outbound envelope carrying one session frame from the host to the remote
 * peer. The wrapped frame is a `SessionOutboundFrame` exactly as defined by
 * the host-session authority packet (`tuvren.framework.host-session`); this
 * envelope adds carriage fields only and never alters frame semantics.
 */
model WsOutboundFrameEnvelope {
  kind: "frame";

  /**
   * Opaque resume cursor positioned at the wrapped frame. Present exactly
   * when the wrapped session frame has `kind: "event"` — the canonical event
   * stream is the only sequenced, replayable surface; `client_invocation`
   * and `session_rejection` frames carry no cursor.
   */
  cursor?: NonEmptyString;

  /**
   * The session frame, schema-owned by the host-session authority packet.
   * This schema deliberately does not constrain it.
   */
  frame: unknown;
}

/**
 * Inbound envelope carrying one session frame from the remote peer to the
 * host. The wrapped frame is a `SessionInboundFrame` per the host-session
 * authority packet; validation and rejection semantics belong to the session
 * binding, not this transport — a schema-invalid or state-refused frame
 * surfaces as an outbound `session_rejection` frame, never as a socket
 * close.
 */
model WsInboundFrameEnvelope {
  kind: "frame";

  /** The session frame, schema-owned by the host-session authority packet. */
  frame: unknown;
}

/**
 * Application-level heartbeat probe. The abstract socket seam has no opcode
 * surface, so liveness runs in-band: either side MAY send `ping`; the
 * receiver MUST answer with `pong`. A transport that misses a `pong` within
 * its configured timeout MUST treat the connection as half-open and close
 * with code 4004 (`heartbeat_timeout`).
 */
model WsPing {
  kind: "ping";
}

/** Answer to {@link WsPing}. */
model WsPong {
  kind: "pong";
}

/**
 * Connection-level close codes in the WebSocket application range
 * (4000-4999). Close codes are reserved for conditions the session frame
 * vocabulary cannot express; frame-level problems surface as
 * `session_rejection` frames on the open socket. `1000` (normal closure)
 * ends a completed session.
 */
enum WsCloseCode {
  /** The first client message was not a schema-valid handshake. */
  handshakeInvalid: 4000,

  /** The handshake presented an unsupported `protocolVersion` literal. */
  protocolVersionUnsupported: 4001,

  /** The presented `sessionId` does not match the bound session. */
  sessionNotFound: 4002,

  /** The host rejected the opaque `authToken`. */
  authRejected: 4003,

  /** Half-open connection detected: no `pong` within the configured timeout. */
  heartbeatTimeout: 4004,

  /**
   * The bounded outbound queue overflowed. The transport closes rather than
   * dropping frames — a silent drop would create a sequence gap the resume
   * cursor could neither explain nor repair; a close converts overflow into
   * an honest reconnect-with-cursor.
   */
  backpressureExceeded: 4005,
}
