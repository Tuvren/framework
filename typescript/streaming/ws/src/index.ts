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
 * @packageDocumentation
 *
 * `@tuvren/stream-ws` is the runtime-agnostic WebSocket carriage binding for
 * the duplex session protocol (ADR-060, `spec/host/session/`) and the
 * event-stream resume cursor (ADR-061, `spec/streaming/resume/`), per
 * ADR-062 (`spec/streaming/ws/`, packet `tuvren.framework.event-stream-ws`,
 * issue #100). It owns carriage only — handshake, heartbeat, close codes,
 * and bounded outbound queueing — never frame or cursor semantics.
 *
 * This milestone (M6) ships the handshake/frame/inbound-routing transport
 * core: `createWsSessionTransport`, `WsSocketSink`, the wire message types,
 * and `parseWsMessage`. Application-level heartbeat (`ping`/`pong` timeout
 * handling) and bounded outbound backpressure land in milestone M7.
 */
// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
export type { WsCloseCode } from "./lib/ws-close-codes.js";
export {
  WS_CLOSE_CODE_AUTH_REJECTED,
  WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED,
  WS_CLOSE_CODE_HANDSHAKE_INVALID,
  WS_CLOSE_CODE_HEARTBEAT_TIMEOUT,
  WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED,
  WS_CLOSE_CODE_SESSION_NOT_FOUND,
} from "./lib/ws-close-codes.js";
export type {
  ParsedWsMessage,
  WsClientMessage,
  WsHandshakeAck,
  WsHandshakeRequest,
  WsInboundFrameEnvelope,
  WsOutboundFrameEnvelope,
  WsPing,
  WsPong,
  WsResumeStatus,
  WsServerMessage,
} from "./lib/ws-messages.js";
export { parseWsMessage } from "./lib/ws-messages.js";
export type {
  WsSessionTransport,
  WsSessionTransportOptions,
  WsSocketSink,
} from "./lib/ws-session-transport.js";
export { createWsSessionTransport } from "./lib/ws-session-transport.js";
