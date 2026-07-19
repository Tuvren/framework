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
 * `@tuvren/host-session` is the TypeScript reference binding for the
 * `tuvren.framework.host-session` authority packet (issue #99,
 * `spec/host/session/typespec/main.tsp`): it merges an `ExecutionHandle`'s
 * event stream — including any successor handle installed by
 * `resolveApproval()` — with client-invocation and rejection frames into a
 * single duplex session channel a host can carry over any transport (SSE,
 * WebSocket, stdio, ...).
 */

/** @experimental */
export type { DuplexSessionBinding } from "./lib/duplex-session-binding.js";
/** @experimental */
export type { DuplexSessionBindingOptions } from "./lib/duplex-session-binding.js";
/** @experimental */
export { createDuplexSessionBinding } from "./lib/duplex-session-binding.js";

/** @experimental */
export type { SessionApprovalResponseFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionCancelFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionClientInvocationFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionClientResultFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionEventFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionInboundFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionInboundRejection } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionOutboundFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionRejectionCode } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionRejectionFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export type { SessionSteerFrame } from "./lib/session-frame-shapes.js";
/** @experimental */
export { SESSION_REJECTION_CODE_CAPABILITY_RESULT_STALE } from "./lib/session-frame-shapes.js";
/** @experimental */
export { SESSION_REJECTION_CODE_SESSION_FRAME_INVALID } from "./lib/session-frame-shapes.js";
/** @experimental */
export { SESSION_REJECTION_CODE_SESSION_FRAME_WRONG_STATE } from "./lib/session-frame-shapes.js";
