import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/host-session/")
namespace Tuvren.Framework.HostSession;

// ---------------------------------------------------------------------------
// Shared models mirrored from the runtime-api authority packet
// ---------------------------------------------------------------------------
//
// Every model in this section mirrors, field-for-field, the model of the same
// name declared in the `tuvren.framework.runtime-api` authority packet
// (`spec/host/typespec/main.tsp`). This packet is transport-only: it wraps
// those shared shapes inside duplex session frames without importing the
// runtime-api namespace, so each mirrored model MUST stay in sync by hand
// whenever the runtime-api authority changes.

/**
 * Mirrors `NonEmptyString` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

/**
 * Mirrors `Metadata` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model Metadata is Record<unknown>;

/**
 * Mirrors `TextPart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model TextPart {
  type: "text";
  text: string;
  providerMetadata?: Metadata;
}

/**
 * Mirrors `ReasoningPart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`), including its unredacted-non-empty-text
 * conditional. Must stay in sync with that declaration.
 */
@TypeSpec.JsonSchema.extension(
  "allOf",
  #[
    #{
      `if`: #{properties: #{redacted: #{`const`: false}}, required: #["redacted"]},
      // Mirror the current binding validator exactly: unredacted reasoning
      // must be non-empty, but whitespace-only payloads are still valid here.
      then: #{properties: #{text: #{type: "string", minLength: 1}}},
    },
  ]
)
model ReasoningPart {
  type: "reasoning";
  text: string;
  redacted: boolean;
  providerMetadata?: Metadata;
}

/**
 * Mirrors `ToolCallPart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model ToolCallPart {
  type: "tool_call";
  callId: NonEmptyString;
  name: NonEmptyString;
  input: unknown;
  providerMetadata?: Metadata;
}

/**
 * Mirrors `ToolResultPart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model ToolResultPart {
  type: "tool_result";
  callId: NonEmptyString;
  name: NonEmptyString;
  output: unknown;
  isError?: boolean;
  providerMetadata?: Metadata;
}

/**
 * Mirrors `FilePart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model FilePart {
  type: "file";
  data: string | uint8[];
  mediaType: NonEmptyString;
  filename?: string;
  providerMetadata?: Metadata;
}

/**
 * Mirrors `StructuredPart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model StructuredPart {
  type: "structured";
  data: unknown;
  name?: string;
  providerMetadata?: Metadata;
}

/**
 * Mirrors `ContentPart` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
union ContentPart {
  text: TextPart,
  reasoning: ReasoningPart,
  toolCall: ToolCallPart,
  toolResult: ToolResultPart,
  file: FilePart,
  structured: StructuredPart,
}

/**
 * Mirrors `InputSignal` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model InputSignal {
  @minItems(1)
  parts: ContentPart[];
}

/**
 * Mirrors `ApprovalDecision` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model ApprovalDecision {
  callId: NonEmptyString;
  type: "approve" | "edit" | "reject" | string;
  editedInput?: unknown;
  message?: NonEmptyString;
}

/**
 * Mirrors `ApprovalResponse` in the runtime-api authority packet
 * (`spec/host/typespec/main.tsp`). Must stay in sync with that declaration.
 */
model ApprovalResponse {
  @minItems(1)
  decisions: ApprovalDecision[];
}

// ---------------------------------------------------------------------------
// Duplex session frame vocabulary (issue #99)
// ---------------------------------------------------------------------------
//
// The models below are this packet's own authority: the duplex session wire
// vocabulary exchanged between a Tuvren runtime and an attached client
// endpoint over a bidirectional session channel. The vocabulary is
// transport-agnostic — SSE, WebSocket, and stdio bindings each carry these
// frames over their own wire encoding, and binding that encoding is a
// separate transport-level concern outside this packet.

/**
 * The invocation envelope the runtime dispatches to an attached client
 * endpoint when it executes a tuvren-client capability (ADR-052, §4.21 /
 * KRT-AZ001). Contains everything the client needs to execute the
 * capability. Credentials and environment secrets are never included — they
 * are owned by the client edge and MUST NOT appear on this envelope.
 */
model ClientInvocationEnvelope {
  /**
   * Identifier of the specific tool call this envelope dispatches. Echoed
   * back on the matching `ClientReportedResult`.
   */
  callId: NonEmptyString;

  /**
   * Identifier of the tuvren-client capability being invoked.
   */
  capabilityId: NonEmptyString;

  /**
   * Side-effect-once idempotency identity for this invocation (ADR-052 as
   * amended by ADR-065).
   *
   * A deterministic identity derived from the turn id and call id — the
   * logical call identity. The client environment can present it to the
   * external system it drives so a dispatch it has already seen is
   * deduplicated: every dispatch of one logical call presents an identical
   * key, across framework retries, approval resume, and redelivery after a
   * reconnect. The run id and the run fencing token are deliberately
   * excluded — a Run is one execution attempt and the fencing token rotates
   * per lease renewal, so either would make the identity churn under the
   * very conditions it must survive. Distinct from `leaseToken`: the lease
   * token guards staleness of *this* dispatch and is echoed back, while the
   * idempotency key dedupes the *external effect* and is never echoed.
   */
  idempotencyKey?: string;

  /**
   * Capability input payload, opaque to this packet.
   */
  input: unknown;

  /**
   * Opaque non-secret lease token. The client MUST echo it verbatim in the
   * corresponding `ClientReportedResult`. A mismatched or missing echo
   * signals a stale dispatch.
   */
  leaseToken: NonEmptyString;
}

/**
 * The result a client endpoint reports back after executing a tuvren-client
 * capability. The client owns environmental execution; this value is a
 * proposal only — it enters durable run lineage exclusively when the
 * runtime's active run authority accepts it (fencing/leasing per ADR-052).
 *
 * The `leaseToken` MUST match the corresponding invocation envelope's
 * `leaseToken`. A mismatch signals a stale late-completion that the runtime
 * MUST ignore rather than accept into lineage.
 */
model ClientReportedResult {
  /**
   * Identifier of the tool call this result answers. Must match a `callId`
   * the runtime previously dispatched via `ClientInvocationEnvelope`.
   */
  callId: NonEmptyString;

  /**
   * Capability result payload, opaque to this packet. No secret material
   * (credentials, environment tokens, internal state) should appear here —
   * this value enters durable lineage once accepted.
   */
  content: unknown;

  /**
   * True when the client endpoint reports the capability execution failed.
   */
  isError?: boolean;

  /**
   * Must echo the corresponding invocation envelope's `leaseToken`. The
   * runtime treats a mismatch as stale and ignores the result.
   */
  leaseToken: NonEmptyString;
}

/**
 * Enumerates every reason the session layer can refuse or fail to apply an
 * inbound frame. This code space is session-layer specific: it is distinct
 * from (and narrower than) the runtime's own error code vocabulary, though
 * `session_frame_wrong_state` and `capability_result_stale` both carry or
 * reuse runtime-owned identifiers as described below.
 */
union SessionRejectionCode {
  /**
   * The inbound frame failed schema validation before it reached any
   * execution handle. The frame was rejected at the session boundary and no
   * runtime state was touched.
   */
  "session_frame_invalid",

  /**
   * The held execution handle refused the operation for state reasons (for
   * example, an approval response arriving while the run is not paused, or
   * a cancel racing an already-applied approval). The underlying runtime
   * error code is carried in `SessionInboundRejection.details.runtimeErrorCode`.
   */
  "session_frame_wrong_state",

  /**
   * A `client_result` frame whose `callId` matches no pending dispatch at
   * the session layer. This code reuses the existing capability error code
   * vocabulary. It is deliberately independent from — and does not
   * replace — the per-dispatch `leaseToken`/`callId` echo staleness check
   * that still runs inside the Client Endpoint Boundary for every accepted
   * dispatch.
   */
  "capability_result_stale",
}

/**
 * The rejection payload the runtime sends back for an inbound frame it
 * could not apply. Inbound frames are never silently dropped: every
 * invalid or refused inbound frame produces exactly one
 * `SessionRejectionFrame` echoing the offending frame's `correlationId`.
 */
model SessionInboundRejection {
  /**
   * Echoes the `correlationId` of the inbound frame that was rejected.
   */
  correlationId: NonEmptyString;

  /**
   * Machine-readable reason the frame was rejected.
   */
  code: SessionRejectionCode;

  /**
   * Human-readable explanation of the rejection.
   */
  message: string;

  /**
   * Additional structured detail. When `code` is `session_frame_wrong_state`,
   * this MUST include a `runtimeErrorCode` entry carrying the underlying
   * runtime error code that caused the state refusal.
   */
  details?: Metadata;
}

/**
 * Runtime-to-client frame carrying a canonical stream event. The `event`
 * payload is a canonical `TuvrenStreamEvent` whose authority is the
 * `tuvren.shared.core` packet (see `spec/streaming/typespec/main.tsp` and
 * `spec/core`). This packet deliberately does not redeclare that 26-variant
 * union here — it wraps the canonical event opaquely so the session
 * vocabulary does not fork from the shared event authority.
 */
model SessionEventFrame {
  protocolVersion: "1";
  kind: "event";
  sessionId: NonEmptyString;

  /**
   * Opaque canonical `TuvrenStreamEvent` payload. See the `tuvren.shared.core`
   * authority packet for the event union this value MUST conform to.
   */
  event: unknown;
}

/**
 * Runtime-to-client frame emitted when the runtime dispatches a
 * tuvren-client capability. The `leaseToken` carried inside `invocation`
 * travels only on this session channel: it is deliberately absent from the
 * canonical broadcast event stream (`SessionEventFrame` / `TuvrenStreamEvent`)
 * so lease material never leaks into observers that only consume the
 * broadcast stream.
 */
model SessionClientInvocationFrame {
  protocolVersion: "1";
  kind: "client_invocation";
  sessionId: NonEmptyString;
  invocation: ClientInvocationEnvelope;
}

/**
 * Runtime-to-client frame carrying a rejection for an inbound frame the
 * runtime could not apply. Inbound frames are never silently dropped: every
 * invalid or refused inbound frame produces exactly one frame of this kind,
 * echoing the rejected frame's `correlationId`.
 */
model SessionRejectionFrame {
  protocolVersion: "1";
  kind: "session_rejection";
  sessionId: NonEmptyString;
  rejection: SessionInboundRejection;
}

/**
 * Client-to-runtime frame reporting the result of a previously dispatched
 * tuvren-client capability invocation.
 */
model SessionClientResultFrame {
  protocolVersion: "1";
  kind: "client_result";
  sessionId: NonEmptyString;

  /**
   * Client-generated correlation identifier for this inbound frame. Echoed
   * verbatim on the `SessionRejectionFrame` if the runtime rejects this
   * frame.
   */
  correlationId: NonEmptyString;

  result: ClientReportedResult;
}

/**
 * Client-to-runtime frame carrying an approval decision for a paused run.
 */
model SessionApprovalResponseFrame {
  protocolVersion: "1";
  kind: "approval_response";
  sessionId: NonEmptyString;

  /**
   * Client-generated correlation identifier for this inbound frame. Echoed
   * verbatim on the `SessionRejectionFrame` if the runtime rejects this
   * frame.
   */
  correlationId: NonEmptyString;

  response: ApprovalResponse;
}

/**
 * Client-to-runtime frame carrying mid-run steering input.
 */
model SessionSteerFrame {
  protocolVersion: "1";
  kind: "steer";
  sessionId: NonEmptyString;

  /**
   * Client-generated correlation identifier for this inbound frame. Echoed
   * verbatim on the `SessionRejectionFrame` if the runtime rejects this
   * frame.
   */
  correlationId: NonEmptyString;

  signal: InputSignal;
}

/**
 * Client-to-runtime frame requesting cancellation of the active run held by
 * this session.
 */
model SessionCancelFrame {
  protocolVersion: "1";
  kind: "cancel";
  sessionId: NonEmptyString;

  /**
   * Client-generated correlation identifier for this inbound frame. Echoed
   * verbatim on the `SessionRejectionFrame` if the runtime rejects this
   * frame.
   */
  correlationId: NonEmptyString;
}

/**
 * Every frame kind the runtime sends to an attached client endpoint over a
 * duplex session channel (runtime -> client direction). This family is
 * transport-agnostic: SSE, WebSocket, and stdio bindings each carry these
 * frames over their own wire encoding as a separate transport-level concern.
 */
union SessionOutboundFrame {
  event: SessionEventFrame,
  clientInvocation: SessionClientInvocationFrame,
  rejection: SessionRejectionFrame,
}

/**
 * Every frame kind a client endpoint sends to the runtime over a duplex
 * session channel (client -> runtime direction). This family is
 * transport-agnostic: SSE, WebSocket, and stdio bindings each carry these
 * frames over their own wire encoding as a separate transport-level concern.
 */
union SessionInboundFrame {
  clientResult: SessionClientResultFrame,
  approvalResponse: SessionApprovalResponseFrame,
  steer: SessionSteerFrame,
  cancel: SessionCancelFrame,
}
