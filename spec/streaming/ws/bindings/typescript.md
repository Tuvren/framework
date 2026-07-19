# TypeScript Binding — Event Stream WebSocket Transport (`tuvren.framework.event-stream-ws`)

Binding projection: `typescript/streaming/ws` (`@tuvren/stream-ws`).

## Surface

| Authority model | TypeScript projection |
| --- | --- |
| `WsHandshakeRequest` / `WsHandshakeAck` | in-band handshake exchange consumed by the transport's socket seam |
| `WsOutboundFrameEnvelope` / `WsInboundFrameEnvelope` | `{ kind: "frame", cursor?, frame }` carriage envelopes wrapping `SessionOutboundFrame` / `SessionInboundFrame` (packet `tuvren.framework.host-session`) |
| `WsPing` / `WsPong` | in-band heartbeat messages |
| `WsCloseCode` | `WsCloseCode` union and `WS_CLOSE_CODE_*` constants |

Exports (all `@experimental`, ADR-056 posture; implementation is split across milestones M6/M7):

- `createWsSessionTransport(...)` — adapts a host's `DuplexSessionBinding` (packet `tuvren.framework.host-session`), an optional replay buffer (packet `tuvren.framework.event-stream-resume`), and a `WsSocketSink` into the handshake/frame/inbound-routing state machine described by ADR-062. **Shipped in M6**: handshake (including all four close-code failure paths and serialized async `authorize`), the sequenced/replayable outbound event pump, non-event outbound frame carriage, `ping`/`pong` echo, and the settled unknown-kind inbound-routing policy below. **Deferred to M7**: heartbeat-timeout enforcement (the `pong` side is already a no-op seam) and bounded-outbound-queue backpressure (`4005`).
- `WsSocketSink` — the runtime-agnostic push-model socket seam (`send(data)`, `close(code, reason?)`) a host adapts from `Bun.serve` websockets, the browser `WebSocket` global, Node `ws`, or an in-memory pair in tests. Shipped in M6.
- `parseWsMessage(data)` and the `WsHandshakeRequest` / `WsHandshakeAck` / `WsResumeStatus` / `WsOutboundFrameEnvelope` / `WsInboundFrameEnvelope` / `WsPing` / `WsPong` wire types — the pure, throw-free structural parser and its message shapes. Shipped in M6.
- `WS_CLOSE_CODE_HANDSHAKE_INVALID` (`4000`), `WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED` (`4001`), `WS_CLOSE_CODE_SESSION_NOT_FOUND` (`4002`), `WS_CLOSE_CODE_AUTH_REJECTED` (`4003`), `WS_CLOSE_CODE_HEARTBEAT_TIMEOUT` (`4004`), `WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED` (`4005`), and the `WsCloseCode` union type — shipped since the scaffold milestone; the six close codes and their semantics are fixed by ADR-062 §5.

## Transport rules (normative for hosts, from `spec/streaming/ws/typespec/main.tsp`)

1. **Handshake-first.** The first message a client sends after the socket opens MUST be a schema-valid `WsHandshakeRequest`; the first message a server sends back MUST be `WsHandshakeAck`. The session protocol is carried only after a successful handshake exchange.
2. **Cursor only on `kind: "event"` outbound envelopes.** `WsOutboundFrameEnvelope.cursor` (the opaque ADR-061 resume token) is present exactly when the wrapped session frame has `kind: "event"` — the canonical event stream is the only sequenced, replayable surface. `client_invocation` and `session_rejection` frames carry no cursor.
3. **Frame-level problems surface as `session_rejection` frames, never socket closes.** A schema-invalid or state-refused inbound frame is the session binding's concern, not the transport's; it is answered with an ADR-060 `session_rejection` frame on the still-open socket. **Settled unknown-kind policy:** any post-handshake message that is not a recognized envelope kind — malformed JSON, an object with no `kind`, an unrecognized `kind`, or a stray `handshake`/`handshake_ack` arriving after the handshake completed — is forwarded to `binding.dispatchInbound()` exactly like a `frame` envelope's inner payload, carrying whatever value `parseWsMessage` produced (the parsed object, or the raw decoded text when `JSON.parse` itself failed). The binding's own schema validation turns that into a `session_rejection` frame with code `session_frame_invalid`. The socket never closes for a frame-level or unrecognized-message problem — only handshake failures and the outbound pump's own terminal conditions close the connection.
4. **Close codes are reserved for connection-level conditions**: `4000` handshake_invalid, `4001` protocol_version_unsupported, `4002` session_not_found, `4003` auth_rejected, `4004` heartbeat_timeout, `4005` backpressure_exceeded, and `1000` for normal end-of-session close.
5. **Ping/pong liveness.** Either side MAY send `{kind: "ping"}`; the receiver MUST answer `{kind: "pong"}`. A missing pong within the configured `heartbeatTimeoutMs` is half-open detection and closes with `4004`.
6. **Bounded outbound queue, close-on-overflow.** The outbound queue is bounded by a configurable frame budget. Overflow closes with `4005` rather than silently dropping a frame — a silent drop would create a sequence gap the resume cursor could neither explain nor repair; a close converts overflow into an honest reconnect-with-cursor. **No silent drop is permitted.**

## Layering rule

- Frame semantics (the `SessionOutboundFrame` / `SessionInboundFrame` vocabulary itself, including `session_rejection`) are owned by `spec/host/session/` (packet `tuvren.framework.host-session`), not this surface.
- Cursor semantics (encoding, replay-window resolution, `ReplayStatus`) are owned by `spec/streaming/resume/` (packet `tuvren.framework.event-stream-resume`), not this surface.
- This surface (`spec/streaming/ws/`, packet `tuvren.framework.event-stream-ws`) owns **carriage only**: handshake, heartbeat, close codes, and outbound queueing. No frame or cursor semantic may drift into the transport without violating this packet's `forbiddenAuthoritySources`.

## `DuplexSessionBinding` integration obligations

Per `typescript/host/session/src/index.ts` and its `duplex-session-binding.ts` documentation, a transport built on top of `DuplexSessionBinding` MUST honor:

- **`outbound()` is claimed exactly once before inbound dispatch begins.** The binding's outbound frame stream has single-consumer semantics; the transport must take ownership of it before it starts forwarding inbound socket messages into `dispatchInbound`, and must not attempt to claim it a second time.
- **`dispatchInbound` calls are wrapped in the transport's own `try`/`catch`.** The binding does not protect callers from adapter-level failures (malformed socket payloads, sink errors); the transport is responsible for isolating each `dispatchInbound` invocation so a single bad inbound message cannot take down the connection's read loop.
