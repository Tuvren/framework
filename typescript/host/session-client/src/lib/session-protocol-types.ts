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
 * Local, hand-authored structural mirror of the `tuvren.framework.host-session`
 * frame vocabulary (`spec/host/session/typespec/main.tsp`, ADR-060) and the
 * `tuvren.framework.event-stream-ws` carriage vocabulary
 * (`spec/streaming/ws/typespec/main.tsp`, ADR-062/ADR-063).
 *
 * `@tuvren/session-client` is a deliberately zero-dependency package (see the
 * package-level doc comment in `../index.ts`): every other TypeScript
 * projection of these frames in this repository (`@tuvren/host-session`,
 * `@tuvren/stream-ws`, `@tuvren/remote-session`) declares a `peerDependencies`
 * or `dependencies` entry on `@tuvren/core` even when only importing types
 * from it (`@tuvren/core/capabilities`, `@tuvren/core/events`) — this
 * repository's `tsconfig.dts.json` `paths` convention resolves those imports
 * against `../../core/dist/*.d.ts`, which only exists once `@tuvren/core` has
 * been built as a workspace dependency, and Nx's `dependsOn: ["^build"]`
 * wiring follows the same package.json edge. A published client meant to run
 * unmodified in a browser tab, therefore, would drag in a workspace
 * dependency purely for compile-time shapes.
 *
 * This module resolves that by hand-authoring the wire shapes directly from
 * the authority packets above, exactly as `typescript/host/session/src/lib/session-frame-shapes.ts`
 * does for the server-side binding — except this module also inlines the
 * shared runtime-api models (`ClientInvocationEnvelope`, `ClientReportedResult`,
 * `ApprovalResponse`, `InputSignal`, `ContentPart`, ...) that the host-session
 * packet itself mirrors field-for-field rather than importing, since this
 * package has no sibling packet to import them from either. Every type below
 * MUST stay in sync by hand with `spec/host/session/typespec/main.tsp` and
 * `spec/streaming/ws/typespec/main.tsp`.
 *
 * @packageDocumentation
 */

/** Wire protocol version literal this package speaks. Echoed, never negotiated. @experimental */
export const SESSION_PROTOCOL_VERSION = "1" as const;

// ---------------------------------------------------------------------------
// Runtime-api models mirrored by the host-session packet (and, here, by us)
// ---------------------------------------------------------------------------

/** Mirrors `TextPart`. @experimental */
export interface SessionClientTextPart {
  providerMetadata?: Record<string, unknown>;
  text: string;
  type: "text";
}

/** Mirrors `ReasoningPart`. @experimental */
export interface SessionClientReasoningPart {
  providerMetadata?: Record<string, unknown>;
  redacted: boolean;
  text: string;
  type: "reasoning";
}

/** Mirrors `ToolCallPart`. @experimental */
export interface SessionClientToolCallPart {
  callId: string;
  input: unknown;
  name: string;
  providerMetadata?: Record<string, unknown>;
  type: "tool_call";
}

/** Mirrors `ToolResultPart`. @experimental */
export interface SessionClientToolResultPart {
  callId: string;
  isError?: boolean;
  name: string;
  output: unknown;
  providerMetadata?: Record<string, unknown>;
  type: "tool_result";
}

/** Mirrors `FilePart`. @experimental */
export interface SessionClientFilePart {
  data: string | Uint8Array;
  filename?: string;
  mediaType: string;
  providerMetadata?: Record<string, unknown>;
  type: "file";
}

/** Mirrors `StructuredPart`. @experimental */
export interface SessionClientStructuredPart {
  data: unknown;
  name?: string;
  providerMetadata?: Record<string, unknown>;
  type: "structured";
}

/** Mirrors `ContentPart`. @experimental */
export type SessionClientContentPart =
  | SessionClientTextPart
  | SessionClientReasoningPart
  | SessionClientToolCallPart
  | SessionClientToolResultPart
  | SessionClientFilePart
  | SessionClientStructuredPart;

/** Mirrors `InputSignal`. @experimental */
export interface SessionClientInputSignal {
  parts: SessionClientContentPart[];
}

/** Mirrors `ApprovalDecision`. @experimental */
export interface SessionClientApprovalDecision {
  callId: string;
  editedInput?: unknown;
  message?: string;
  type: "approve" | "edit" | "reject" | string;
}

/** Mirrors `ApprovalResponse`. @experimental */
export interface SessionClientApprovalResponse {
  decisions: SessionClientApprovalDecision[];
}

// ---------------------------------------------------------------------------
// Duplex session frame vocabulary (spec/host/session, ADR-060)
// ---------------------------------------------------------------------------

/** Mirrors `ClientInvocationEnvelope`. @experimental */
export interface SessionClientInvocationEnvelope {
  callId: string;
  capabilityId: string;
  idempotencyKey?: string;
  input: unknown;
  leaseToken: string;
}

/** Mirrors `ClientReportedResult`. @experimental */
export interface SessionClientReportedResult {
  callId: string;
  content: unknown;
  isError?: boolean;
  leaseToken: string;
}

/** Mirrors `SessionRejectionCode`. @experimental */
export type SessionClientRejectionCode =
  | "session_frame_invalid"
  | "session_frame_wrong_state"
  | "capability_result_stale";

/** Mirrors `SessionInboundRejection`. @experimental */
export interface SessionClientInboundRejection {
  code: SessionClientRejectionCode;
  correlationId: string;
  details?: Record<string, unknown>;
  message: string;
}

/** Mirrors `SessionEventFrame`. @experimental */
export interface SessionClientEventFrame {
  event: unknown;
  kind: "event";
  protocolVersion: "1";
  sessionId: string;
}

/** Mirrors `SessionClientInvocationFrame`. @experimental */
export interface SessionClientInvocationFrame {
  invocation: SessionClientInvocationEnvelope;
  kind: "client_invocation";
  protocolVersion: "1";
  sessionId: string;
}

/** Mirrors `SessionRejectionFrame`. @experimental */
export interface SessionClientRejectionFrame {
  kind: "session_rejection";
  protocolVersion: "1";
  rejection: SessionClientInboundRejection;
  sessionId: string;
}

/** Mirrors `SessionOutboundFrame` (server -> client direction). @experimental */
export type SessionClientOutboundFrame =
  | SessionClientEventFrame
  | SessionClientInvocationFrame
  | SessionClientRejectionFrame;

/** Mirrors `SessionClientResultFrame`. @experimental */
export interface SessionClientResultFrame {
  correlationId: string;
  kind: "client_result";
  protocolVersion: "1";
  result: SessionClientReportedResult;
  sessionId: string;
}

/** Mirrors `SessionApprovalResponseFrame`. @experimental */
export interface SessionClientApprovalResponseFrame {
  correlationId: string;
  kind: "approval_response";
  protocolVersion: "1";
  response: SessionClientApprovalResponse;
  sessionId: string;
}

/** Mirrors `SessionSteerFrame`. @experimental */
export interface SessionClientSteerFrame {
  correlationId: string;
  kind: "steer";
  protocolVersion: "1";
  sessionId: string;
  signal: SessionClientInputSignal;
}

/** Mirrors `SessionCancelFrame`. @experimental */
export interface SessionClientCancelFrame {
  correlationId: string;
  kind: "cancel";
  protocolVersion: "1";
  sessionId: string;
}

/** Mirrors `SessionInboundFrame` (client -> server direction). @experimental */
export type SessionClientInboundFrame =
  | SessionClientResultFrame
  | SessionClientApprovalResponseFrame
  | SessionClientSteerFrame
  | SessionClientCancelFrame;

// ---------------------------------------------------------------------------
// WS carriage envelope (spec/streaming/ws, ADR-062/ADR-063)
// ---------------------------------------------------------------------------

/** Mirrors `WsHandshakeRequest`. @experimental */
export interface SessionClientHandshakeRequest {
  authToken?: string;
  cursor?: string;
  kind: "handshake";
  protocolVersion: string;
  sessionId?: string;
}

/** Mirrors `WsResumeStatus`. @experimental */
export type SessionClientResumeStatus =
  | "resumed"
  | "out-of-window"
  | "unknown-turn"
  | "none";

/** Mirrors `WsHandshakeAck`. @experimental */
export interface SessionClientHandshakeAck {
  kind: "handshake_ack";
  protocolVersion: string;
  resumeStatus: SessionClientResumeStatus;
  sessionId: string;
}

/** Mirrors `WsOutboundFrameEnvelope` (server -> client carriage wrapper). @experimental */
export interface SessionClientOutboundEnvelope {
  cursor?: string;
  frame: unknown;
  kind: "frame";
}

/** Mirrors `WsInboundFrameEnvelope` (client -> server carriage wrapper). @experimental */
export interface SessionClientInboundEnvelope {
  frame: unknown;
  kind: "frame";
}

/** Mirrors `WsPing`. @experimental */
export interface SessionClientPing {
  kind: "ping";
}

/** Mirrors `WsPong`. @experimental */
export interface SessionClientPong {
  kind: "pong";
}
