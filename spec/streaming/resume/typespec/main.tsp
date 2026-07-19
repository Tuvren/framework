import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/event-stream-resume/")
namespace Tuvren.Framework.EventStreamResume;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

@minValue(0)
@maxValue(9007199254740991)
scalar NonNegativeSafeInt extends safeint;

/**
 * Decoded content of an opaque resume-cursor token.
 *
 * On the wire a cursor is a single opaque string (base64url-encoded JSON of
 * this model). Consumers MUST treat the token as opaque: only the encoder that
 * minted a cursor may decode it, and the encoding is an implementation detail
 * this schema documents for cross-implementation agreement, not a surface a
 * client may construct by hand. A token that fails to decode against this
 * model MUST be treated exactly like an out-of-window cursor (snapshot
 * fallback), never as an error surfaced to the remote peer.
 */
model ResumeCursorPayload {
  /**
   * Cursor payload version. A future incompatible payload ships as a new
   * literal; decoders MUST treat an unknown version as out-of-window.
   */
  v: 1;

  /**
   * Identity of the Turn the cursor position belongs to, as carried by the
   * canonical `turn.start` event. The replay window is keyed by this value.
   */
  turnId: NonEmptyString;

  /**
   * Most recent kernel checkpoint anchor (`state.checkpoint.turnNodeHash`)
   * observed at or before the cursor position. Present only when the host
   * enabled state observability; `state.checkpoint` emission is optional, so
   * anchoring MUST NOT be assumed. When present it is supplementary
   * validation: a replay window that retains no record of this anchor for the
   * cursor's Turn MUST report out-of-window rather than silently serve events
   * from a different anchor lineage.
   */
  turnNodeHash?: NonEmptyString;

  /**
   * Monotonic intra-turn offset of the last event the client observed.
   * Sequence numbers start at 0 at each `turn.start` and increase by exactly
   * 1 per sequenced event within the Turn.
   */
  sequence: NonNegativeSafeInt;
}

/**
 * A canonical stream event wrapped with its wire-level sequencing envelope.
 *
 * Sequencing is deliberately wire-level and additive: the canonical
 * `TuvrenStreamEvent` union is not extended with a sequence field. Transports
 * carry the envelope (SSE places `cursor` in the frame `id`; the WebSocket
 * transport carries `cursor` on its own outer message envelope), and
 * in-process consumers of the canonical stream never see it.
 */
model SequencedStreamFrame {
  /** Identity of the Turn this event belongs to. */
  turnId: NonEmptyString;

  /**
   * Monotonic intra-turn sequence of this event, starting at 0 at each
   * `turn.start`.
   */
  sequence: NonNegativeSafeInt;

  /**
   * Opaque resume-cursor token positioned at this event (decoded shape:
   * `ResumeCursorPayload`). A client that reconnects presents the last cursor
   * it observed.
   */
  cursor: NonEmptyString;

  /**
   * The canonical `TuvrenStreamEvent`, serialized per the canonical stream
   * contract (packet `tuvren.shared.core`, including its binary-payload
   * marker convention). This schema does not constrain the event shape — the
   * canonical stream authority does.
   */
  event: unknown;
}

/**
 * Outcome vocabulary of a replay attempt against a bounded replay window.
 */
enum ReplayStatus {
  /**
   * The cursor position is retained: the window replays every sequenced event
   * after the cursor position, in order, then live tailing continues.
   */
  resumed: "resumed",

  /**
   * The cursor decodes but its position is no longer retained (evicted by
   * capacity, unknown checkpoint anchor, unknown payload version, or a
   * malformed token). The client MUST fall back to snapshot semantics: the
   * durable kernel state is truth and the missed events are not
   * reconstructable from the stream layer.
   */
  outOfWindow: "out-of-window",

  /**
   * The cursor names a Turn for which the replay window retains no frames —
   * either never observed, or fully evicted (windows prune per-turn
   * bookkeeping with eviction so memory stays bounded). Snapshot fallback
   * applies exactly as for `out-of-window`; the distinct status exists so
   * hosts can observe cross-session, cross-process, or long-stale cursor
   * presentation.
   */
  unknownTurn: "unknown-turn",
}

/**
 * Result of a replay attempt. `events` is present exactly when `status` is
 * `resumed` and contains the retained sequenced frames strictly after the
 * cursor position, in sequence order.
 *
 * Modeling note: the generated JSON Schema leaves `events` unconditionally
 * optional because this model is not expressed as a per-status discriminated
 * union; the presence rule above is normative regardless, and conformance
 * checks must assert it directly rather than relying on schema validation
 * alone.
 */
model ReplayResult {
  status: ReplayStatus;
  events?: SequencedStreamFrame[];
}
