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
 * `@tuvren/remote-session` is the host-owned, reattachable remote client
 * session lifecycle seam (ADR-063): it sits above `@tuvren/host-session`'s
 * `DuplexSessionBinding` and below any carriage (WebSocket, SSE-plus-inbound,
 * IPC, or an in-memory test harness), holding the binding's single
 * `outbound()` claim, one `createSequencedTuvrenStreamEvents` instance, and
 * one shared `createReplayBuffer` for the session's whole life so that
 * reattaching a dropped link never restarts sequence numbering, never feeds
 * a shared replay window from two sequencers, and recovers outstanding
 * `client_invocation` work by redelivery rather than by extending the wire
 * vocabulary.
 */

/** @experimental */
export type { RemoteClientSession } from "./lib/remote-client-session.js";
/** @experimental */
export type { RemoteClientSessionOptions } from "./lib/remote-client-session.js";
/** @experimental */
export type { RemoteClientSessionSink } from "./lib/remote-client-session.js";
/** @experimental */
export type { RemoteClientSessionAttachOptions } from "./lib/remote-client-session.js";
/** @experimental */
export type { RemoteClientSessionAttachResult } from "./lib/remote-client-session.js";
/** @experimental */
export type { RemoteClientSessionResumeStatus } from "./lib/remote-client-session.js";
/** @experimental */
export type { RemoteSessionClock } from "./lib/remote-client-session.js";
/** @experimental */
export { createRemoteClientSession } from "./lib/remote-client-session.js";
/** @experimental */
export { REMOTE_SESSION_ALREADY_ATTACHED } from "./lib/remote-client-session.js";
/** @experimental */
export { REMOTE_SESSION_ENDED } from "./lib/remote-client-session.js";
