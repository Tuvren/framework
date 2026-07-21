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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
// biome-ignore-all assist/source/organizeImports: The organizer merges the one-export-per-statement layout back into a grouped export, which would strip the per-export @experimental release tags ADR-056 requires.

/**
 * @packageDocumentation
 *
 * `@tuvren/session-client` is the thin, reference-quality REMOTE PEER for the
 * Tuvren duplex session protocol over WebSocket: it runs where tools
 * actually execute (browser tab, Bun process, Node >=22 process) and speaks
 * the wire vocabulary a host server exposes by composing
 * `DuplexSessionBinding -> RemoteClientSession -> createWsSessionTransport`
 * (`@tuvren/host-session` + `@tuvren/remote-session` + `@tuvren/stream-ws`,
 * ADR-060/ADR-061/ADR-062/ADR-063).
 *
 * **Zero runtime dependencies.** This package has no `dependencies`,
 * `peerDependencies`, or `devDependencies` at all — it uses only the
 * standard `WebSocket` global. This is a deliberate design decision, not an
 * oversight: every other TypeScript projection of this protocol in this
 * repository (`@tuvren/host-session`, `@tuvren/stream-ws`,
 * `@tuvren/remote-session`) takes a `dependencies`/`peerDependencies` entry
 * on `@tuvren/core` purely to import payload *types*
 * (`@tuvren/core/capabilities`, `@tuvren/core/events`), because this
 * repository's `tsconfig.dts.json` path-mapping convention resolves those
 * imports against `@tuvren/core`'s built `dist/*.d.ts` output, which only
 * exists once `@tuvren/core` has actually been built as a workspace
 * dependency. A package meant to be dropped unmodified into a browser tab or
 * a standalone Bun/Node process — with no framework workspace present —
 * cannot carry that requirement. `./lib/session-protocol-types.ts` hand-mirrors
 * the wire shapes instead (frame envelopes from `spec/host/session/typespec/main.tsp`
 * and the runtime-api models that packet itself mirrors field-for-field), and
 * `./lib/ws-wire.ts` hand-mirrors the WS carriage parser and close codes from
 * `spec/streaming/ws/typespec/main.tsp`. Every mirrored type carries a
 * doc-comment pointer back to the authority model it mirrors.
 *
 * Every export is tagged `@experimental` per ADR-056 — the whole package is
 * still settling, and signatures may change without a major version bump
 * until an export graduates by losing its tag.
 *
 * **Known limitation — unbounded answered-call retention.** `createSessionClient`
 * retains every settled `callId` for the client instance's whole lifetime with
 * no eviction. The duplex session protocol has no result-ack frame, so there
 * is no wire signal telling this client when it is safe to forget an answered
 * call; an LRU or other size-bounded cache would silently weaken the
 * redelivery-dedup guarantee ADR-063 depends on. See the `capabilities` option
 * doc comment on {@link SessionClientOptions} for the full rationale.
 */

/** @experimental */
export type { SessionClientSocket } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientClock } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientCapabilityContext } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientCapabilityHandler } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientStatus } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientReconnectOptions } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientOptions } from "./lib/session-client.js";
/** @experimental */
export type { SessionClientHandle } from "./lib/session-client.js";
/** @experimental */
export { createSessionClient } from "./lib/session-client.js";

/** @experimental */
export type { SessionClientTextPart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientReasoningPart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientToolCallPart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientToolResultPart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientFilePart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientStructuredPart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientContentPart } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientInputSignal } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientApprovalDecision } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientApprovalResponse } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientInvocationEnvelope } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientReportedResult } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientRejectionCode } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientInboundRejection } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientOutboundFrame } from "./lib/session-protocol-types.js";
/** @experimental */
export type { SessionClientInboundFrame } from "./lib/session-protocol-types.js";
/** @experimental */
export { SESSION_PROTOCOL_VERSION } from "./lib/session-protocol-types.js";

/** @experimental */
export type { ParsedWsClientMessage } from "./lib/ws-wire.js";
/** @experimental */
export { parseWsClientMessage } from "./lib/ws-wire.js";
/** @experimental */
export { isRetryableCloseCode } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_HANDSHAKE_INVALID } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_SESSION_NOT_FOUND } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_AUTH_REJECTED } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_HEARTBEAT_TIMEOUT } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED } from "./lib/ws-wire.js";
/** @experimental */
export { WS_CLOSE_CODE_NORMAL } from "./lib/ws-wire.js";
/** @experimental */
export { NON_RETRYABLE_WS_CLOSE_CODES } from "./lib/ws-wire.js";
