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
 * The host rejected the opaque `authToken`.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export const WS_CLOSE_CODE_AUTH_REJECTED = 4003;

/**
 * The bounded outbound queue overflowed. The transport closes rather than
 * dropping frames — a silent drop would create a sequence gap the resume
 * cursor could neither explain nor repair; a close converts overflow into
 * an honest reconnect-with-cursor.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export const WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED = 4005;

/**
 * The first client message was not a schema-valid handshake.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export const WS_CLOSE_CODE_HANDSHAKE_INVALID = 4000;

/**
 * Half-open connection detected: no `pong` within the configured timeout.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export const WS_CLOSE_CODE_HEARTBEAT_TIMEOUT = 4004;

/**
 * The handshake presented an unsupported `protocolVersion` literal.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export const WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED = 4001;

/**
 * The presented `sessionId` does not match the bound session.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export const WS_CLOSE_CODE_SESSION_NOT_FOUND = 4002;

/**
 * Connection-level close codes in the WebSocket application range
 * (4000-4999) reserved for conditions the session frame vocabulary cannot
 * express; frame-level problems surface as `session_rejection` frames on
 * the open socket instead. `1000` (normal closure) is not modeled here — it
 * is the standard WebSocket normal-closure code and carries no
 * transport-specific meaning.
 *
 * @experimental ADR-056 posture: `0.x`, subject to change before graduation.
 */
export type WsCloseCode =
  | typeof WS_CLOSE_CODE_AUTH_REJECTED
  | typeof WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED
  | typeof WS_CLOSE_CODE_HANDSHAKE_INVALID
  | typeof WS_CLOSE_CODE_HEARTBEAT_TIMEOUT
  | typeof WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED
  | typeof WS_CLOSE_CODE_SESSION_NOT_FOUND;
