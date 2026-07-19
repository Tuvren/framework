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

// biome-ignore-all lint/performance/noBarrelFile: This module is the intentional focused frame-envelope surface for issue #99.
// biome-ignore-all assist/source/organizeImports: The organizer collapses the one-export-per-statement layout back into a grouped export, which would strip the per-export @experimental release tags ADR-056 requires.

/**
 * Duplex session frame envelopes for the `tuvren.framework.host-session`
 * authority packet (`spec/host/session/typespec/main.tsp`, issue #99).
 *
 * This module hand-authors the TypeScript projection of the wire vocabulary
 * declared in that TypeSpec packet. It deliberately does not redeclare
 * payload types already owned elsewhere: `TuvrenStreamEvent` comes from
 * `@tuvren/core/events`, `ApprovalResponse` and `InputSignal` come from
 * `@tuvren/core/tools` and `@tuvren/core/execution` respectively, and the
 * client-endpoint capability shapes (`ClientInvocationEnvelope`,
 * `ClientReportedResult`, `AttachedClientEndpoint`,
 * `ClientEndpointCapabilityAdvertisement`) come from
 * `@tuvren/core/capabilities`. Only the frame envelopes themselves —
 * transport-only wrappers around those shared payloads — are declared here.
 *
 * @packageDocumentation
 */

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ApprovalResponse } from "@tuvren/core/tools";
import type { InputSignal } from "@tuvren/core/execution";
import type {
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";

/**
 * Every reason the session layer can refuse or fail to apply an inbound
 * frame (`spec/host/session/typespec/main.tsp` `SessionRejectionCode`).
 *
 * @experimental
 */
export type SessionRejectionCode =
  | "session_frame_invalid"
  | "session_frame_wrong_state"
  | "capability_result_stale";

/** @experimental */
export const SESSION_REJECTION_CODE_SESSION_FRAME_INVALID: SessionRejectionCode =
  "session_frame_invalid";
/** @experimental */
export const SESSION_REJECTION_CODE_SESSION_FRAME_WRONG_STATE: SessionRejectionCode =
  "session_frame_wrong_state";
/** @experimental */
export const SESSION_REJECTION_CODE_CAPABILITY_RESULT_STALE: SessionRejectionCode =
  "capability_result_stale";

/**
 * The rejection payload the runtime sends back for an inbound frame it
 * could not apply. Every invalid or refused inbound frame produces exactly
 * one {@link SessionRejectionFrame} echoing the offending frame's
 * `correlationId`.
 *
 * @experimental
 */
export interface SessionInboundRejection {
  /** Machine-readable reason the frame was rejected. */
  code: SessionRejectionCode;
  /** Echoes the `correlationId` of the inbound frame that was rejected. */
  correlationId: string;
  /**
   * Additional structured detail. When `code` is `session_frame_wrong_state`,
   * this MUST include a `runtimeErrorCode` entry carrying the underlying
   * runtime error code that caused the state refusal.
   */
  details?: Record<string, unknown>;
  /** Human-readable explanation of the rejection. */
  message: string;
}

/**
 * Runtime-to-client frame carrying a canonical stream event.
 *
 * @experimental
 */
export interface SessionEventFrame {
  event: TuvrenStreamEvent;
  kind: "event";
  protocolVersion: "1";
  sessionId: string;
}

/**
 * Runtime-to-client frame emitted when the runtime dispatches a
 * tuvren-client capability. The `leaseToken` carried inside `invocation`
 * travels only on this session channel — it is deliberately absent from the
 * canonical broadcast event stream.
 *
 * @experimental
 */
export interface SessionClientInvocationFrame {
  invocation: ClientInvocationEnvelope;
  kind: "client_invocation";
  protocolVersion: "1";
  sessionId: string;
}

/**
 * Runtime-to-client frame carrying a rejection for an inbound frame the
 * runtime could not apply.
 *
 * @experimental
 */
export interface SessionRejectionFrame {
  kind: "session_rejection";
  protocolVersion: "1";
  rejection: SessionInboundRejection;
  sessionId: string;
}

/**
 * Every frame kind the runtime sends to an attached client endpoint over a
 * duplex session channel (runtime -> client direction).
 *
 * @experimental
 */
export type SessionOutboundFrame =
  | SessionEventFrame
  | SessionClientInvocationFrame
  | SessionRejectionFrame;

/**
 * Client-to-runtime frame reporting the result of a previously dispatched
 * tuvren-client capability invocation.
 *
 * @experimental
 */
export interface SessionClientResultFrame {
  /**
   * Client-generated correlation identifier for this inbound frame. Echoed
   * verbatim on the {@link SessionRejectionFrame} if the runtime rejects
   * this frame.
   */
  correlationId: string;
  kind: "client_result";
  protocolVersion: "1";
  result: ClientReportedResult;
  sessionId: string;
}

/**
 * Client-to-runtime frame carrying an approval decision for a paused run.
 *
 * @experimental
 */
export interface SessionApprovalResponseFrame {
  correlationId: string;
  kind: "approval_response";
  protocolVersion: "1";
  response: ApprovalResponse;
  sessionId: string;
}

/**
 * Client-to-runtime frame carrying mid-run steering input.
 *
 * @experimental
 */
export interface SessionSteerFrame {
  correlationId: string;
  kind: "steer";
  protocolVersion: "1";
  sessionId: string;
  signal: InputSignal;
}

/**
 * Client-to-runtime frame requesting cancellation of the active run held by
 * this session.
 *
 * @experimental
 */
export interface SessionCancelFrame {
  correlationId: string;
  kind: "cancel";
  protocolVersion: "1";
  sessionId: string;
}

/**
 * Every frame kind a client endpoint sends to the runtime over a duplex
 * session channel (client -> runtime direction).
 *
 * @experimental
 */
export type SessionInboundFrame =
  | SessionClientResultFrame
  | SessionApprovalResponseFrame
  | SessionSteerFrame
  | SessionCancelFrame;
