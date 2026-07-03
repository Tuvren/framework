import "@typespec/json-schema";

@TypeSpec.JsonSchema.jsonSchema("https://tuvren.dev/schemas/framework/event-stream-sse/")
namespace Tuvren.Framework.EventStreamSse;

@minLength(1)
@pattern(".*\\S.*", "Must contain non-whitespace content.")
scalar NonEmptyString extends string;

@minValue(0)
@maxValue(9007199254740991)
scalar NonNegativeSafeInt extends safeint;

/**
 * Decoded representation of a single Server-Sent Events frame as produced by a
 * conformant decoder against a `text/event-stream` byte trace per the WHATWG
 * HTML server-sent events normative section.
 *
 * The decoded shape is intentionally minimal and provider-neutral: every field
 * that an SSE encoder may control on the wire appears here, every field that
 * an SSE encoder may not control is omitted, and the decoder discards
 * comment-only lines per WHATWG so they never reach this shape.
 */
model DecodedSseEvent {
  /**
   * Event type set by the most recent `event:` field. Decoders MUST default to
   * `message` when no `event:` field is present, matching the WHATWG default
   * dispatch type.
   */
  type: NonEmptyString;

  /**
   * Concatenated value of every `data:` field in the frame, joined by
   * U+000A LINE FEED characters per WHATWG. A trailing LF appended by the
   * algorithm MUST be removed before dispatch.
   */
  data: string;

  /**
   * Last `id:` value the decoder saw before dispatch. Implementations MUST
   * ignore an `id:` field whose value contains U+0000 NULL per WHATWG.
   */
  id?: string;

  /**
   * Reconnect delay in milliseconds set by the most recent `retry:` field
   * whose value is a sequence of ASCII digits. Non-digit `retry:` values are
   * ignored.
   */
  retryMs?: NonNegativeSafeInt;
}

/**
 * Sequence of zero or more decoded SSE frames produced by a conformant decoder
 * over an entire byte trace. Implementations MUST emit frames in the order
 * they appear in the byte trace.
 */
model DecodedSseStream {
  events: DecodedSseEvent[];

  /**
   * Last event identifier observed across the full stream. Equal to the most
   * recent decoded `id:` value (or absent when no valid `id:` field was seen).
   * Decoders MUST send this value back via the `Last-Event-ID` HTTP header on
   * automatic reconnection.
   */
  lastEventId?: string;

  /**
   * Most recent reconnect delay set by a valid `retry:` field. Absent when no
   * valid `retry:` field was seen.
   */
  reconnectDelayMs?: NonNegativeSafeInt;
}

/**
 * Normative wire characteristics that a conformant encoder MUST honor and a
 * conformant decoder MUST tolerate. These are presented as observable booleans
 * so the conformance plan can assert each one independently from a single
 * decoder observation.
 */
model SseWireCompliance {
  /**
   * Encoder emits `Content-Type: text/event-stream` for the response.
   */
  contentTypeIsEventStream: boolean;

  /**
   * Encoder output is valid UTF-8.
   */
  encodingIsUtf8: boolean;

  /**
   * Decoder accepts each of LF (`\n`), CRLF (`\r\n`), and CR (`\r`) as a line
   * terminator per WHATWG.
   */
  acceptsLfCrlfAndCrLineTerminators: boolean;

  /**
   * Decoder strips at most one leading UTF-8 BOM per WHATWG.
   */
  stripsLeadingBom: boolean;

  /**
   * Decoder strips a single leading U+0020 SPACE from field values per WHATWG.
   */
  stripsSingleLeadingFieldSpace: boolean;

  /**
   * Decoder dispatches the buffered event only on an empty line per WHATWG.
   */
  dispatchesOnEmptyLine: boolean;

  /**
   * Decoder treats every line that starts with U+003A COLON as a comment and
   * does NOT surface those lines as decoded events.
   */
  ignoresCommentLines: boolean;
}
