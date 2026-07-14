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

/** One event dispatched by the WHATWG SSE interpretation algorithm. */
export interface TuvrenDecodedSseEvent {
  /** Concatenated `data:` field values with the trailing newline stripped. */
  data: string;
  /** Value of the `last event ID` buffer at dispatch time, when non-empty and null-free. */
  id?: string;
  /** Reconnection delay, in milliseconds, if a valid `retry:` field preceded this event. */
  retryMs?: number;
  /** Event type; defaults to `"message"` when no `event:` field was set. */
  type: string;
}

/** Result of decoding a complete SSE byte/text trace with {@link decodeSseStream}. */
export interface TuvrenDecodedSseStream {
  /** Every event dispatched, in stream order. */
  events: TuvrenDecodedSseEvent[];
  /** Final `last event ID` buffer value a client would carry across a reconnect, if ever set. */
  lastEventId?: string;
  /** Final reconnection time buffer value, in milliseconds, if ever set by a valid `retry:` field. */
  reconnectDelayMs?: number;
}

const UTF8_BOM = "\uFEFF";
const NULL_CHARACTER = "\u0000";
const RETRY_DIGITS_PATTERN = /^[0-9]+$/u;
const UTF8_DECODER = new TextDecoder("utf-8");

/** Mutable per-stream buffers threaded through {@link decodeSseStream}'s line-processing loop. */
interface DecoderState {
  dataBuffer: string;
  events: TuvrenDecodedSseEvent[];
  eventTypeBuffer: string;
  lastEventId: string | undefined;
  reconnectDelayMs: number | undefined;
}

/**
 * Decodes a complete SSE byte or text trace per the WHATWG
 * `text/event-stream` interpretation algorithm
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation),
 * returning every event the algorithm would dispatch plus the final `last
 * event ID`/`reconnection time` buffer values a client would carry across a
 * reconnect.
 *
 * `input` must be the complete trace, not an incremental chunk: any
 * unterminated trailing line at end-of-input is discarded per spec rather
 * than treated as a partial pending line. A leading UTF-8 BOM is stripped
 * before processing; `Uint8Array` input is decoded as UTF-8.
 */
export function decodeSseStream(
  input: string | Uint8Array
): TuvrenDecodedSseStream {
  // Implements the WHATWG `text/event-stream` interpretation
  // (https://html.spec.whatwg.org/multipage/server-sent-events.html
  // #event-stream-interpretation). The decoder consumes a complete byte
  // trace and returns the sequence of events the algorithm would dispatch,
  // along with the final values of the `last event ID` and `reconnection
  // time` buffers a client would carry across reconnects. Any incomplete
  // line at end-of-stream is discarded per spec.
  const text = typeof input === "string" ? input : UTF8_DECODER.decode(input);
  const stripped = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const state: DecoderState = {
    dataBuffer: "",
    eventTypeBuffer: "",
    events: [],
    lastEventId: undefined,
    reconnectDelayMs: undefined,
  };

  for (const line of iterateCompleteLines(stripped)) {
    processSseLine(line, state);
  }

  const result: TuvrenDecodedSseStream = { events: state.events };

  if (state.lastEventId !== undefined) {
    result.lastEventId = state.lastEventId;
  }

  if (state.reconnectDelayMs !== undefined) {
    result.reconnectDelayMs = state.reconnectDelayMs;
  }

  return result;
}

/**
 * Processes one already-terminated line per the WHATWG algorithm: a blank
 * line dispatches the pending event and resets the per-event buffers; a line
 * starting with `:` is a comment and ignored; any other line splits on the
 * first `:` into a field name and value (a single leading space in the value
 * is stripped) and applies it via {@link applyFieldUpdate}.
 */
function processSseLine(line: string, state: DecoderState): void {
  if (line === "") {
    dispatchPendingEvent(state);
    state.eventTypeBuffer = "";
    state.dataBuffer = "";
    return;
  }

  if (line.startsWith(":")) {
    return;
  }

  const colonIndex = line.indexOf(":");
  const fieldName = colonIndex === -1 ? line : line.slice(0, colonIndex);
  const rawValue = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
  const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

  applyFieldUpdate(fieldName, fieldValue, state);
}

/**
 * Dispatches the buffered event on a blank-line boundary: a no-op when
 * `dataBuffer` is empty (per spec, an event with no `data:` field is never
 * dispatched), otherwise pushes a {@link TuvrenDecodedSseEvent} with its
 * trailing newline stripped and the current `id`/`retry` buffers attached.
 */
function dispatchPendingEvent(state: DecoderState): void {
  if (state.dataBuffer === "") {
    return;
  }

  const trimmedData = state.dataBuffer.endsWith("\n")
    ? state.dataBuffer.slice(0, -1)
    : state.dataBuffer;
  const event: TuvrenDecodedSseEvent = {
    data: trimmedData,
    type: state.eventTypeBuffer === "" ? "message" : state.eventTypeBuffer,
  };

  if (state.lastEventId !== undefined) {
    event.id = state.lastEventId;
  }

  if (state.reconnectDelayMs !== undefined) {
    event.retryMs = state.reconnectDelayMs;
  }

  state.events.push(event);
}

/**
 * Applies one parsed field to the decoder state per its WHATWG semantics:
 * `event` replaces the pending event-type buffer; `data` appends the value
 * plus a newline to the pending data buffer; `id` updates the last-event-ID
 * buffer unless the value contains a null character (silently ignored per
 * spec); `retry` updates the reconnection-time buffer only when the value is
 * all ASCII digits. Any other field name is ignored.
 */
function applyFieldUpdate(
  fieldName: string,
  fieldValue: string,
  state: DecoderState
): void {
  switch (fieldName) {
    case "event":
      state.eventTypeBuffer = fieldValue;
      return;
    case "data":
      state.dataBuffer += `${fieldValue}\n`;
      return;
    case "id":
      if (!fieldValue.includes(NULL_CHARACTER)) {
        state.lastEventId = fieldValue;
      }
      return;
    case "retry":
      if (RETRY_DIGITS_PATTERN.test(fieldValue)) {
        state.reconnectDelayMs = Number.parseInt(fieldValue, 10);
      }
      return;
    default:
      return;
  }
}

/**
 * Per-check WHATWG SSE wire-compliance results produced by
 * {@link reportSseWireCompliance}. Every field is `true` only when the
 * corresponding behavior was actually observed against this lane's live
 * encoder/decoder pair.
 */
export interface TuvrenSseWireCompliance {
  acceptsLfCrlfAndCrLineTerminators: boolean;
  contentTypeIsEventStream: boolean;
  dispatchesOnEmptyLine: boolean;
  encodingIsUtf8: boolean;
  ignoresCommentLines: boolean;
  stripsLeadingBom: boolean;
  stripsSingleLeadingFieldSpace: boolean;
}

/**
 * Produces a {@link TuvrenSseWireCompliance} report by probing the live
 * encoder (via `observeEncoder`) for Content-Type/UTF-8 compliance and the
 * live {@link decodeSseStream} decoder with minimal targeted byte traces for
 * every other check (line-terminator handling, BOM stripping, leading-space
 * stripping, empty-line dispatch, comment-line handling).
 *
 * Every boolean is derived from an actual observation rather than a static
 * claim, so a regression in either the encoder or the decoder surfaces as a
 * failed check instead of a stale `true`. Decoder probes exercise the same
 * `decodeSseStream` the production adapter uses, so drift between this
 * report and the decoder is impossible by construction.
 *
 * @param observeEncoder - One-shot probe that produces a real encoded SSE
 *   response's bytes and Content-Type header (e.g. by driving
 *   `toSseResponse`), decoupling this report from any specific host's
 *   response-construction path.
 */
export async function reportSseWireCompliance(
  observeEncoder: () => Promise<{ body: Uint8Array; contentType: string }>
): Promise<TuvrenSseWireCompliance> {
  // Each boolean is derived from an actual observation of this lane's
  // encoder/decoder pair, so a regression in either implementation surfaces
  // as a failed wire-compliance check rather than as a stale `true`. The
  // caller supplies `observeEncoder` — a one-shot probe of `toSseResponse`
  // (or equivalent) that returns the encoded bytes plus the surfaced
  // Content-Type header — so this report stays usable from any lane that
  // can produce one SSE response without coupling this module to a specific
  // observation strategy.
  const encoded = await observeEncoder();
  const contentTypeIsEventStream =
    encoded.contentType.toLowerCase().split(";")[0]?.trim() ===
    "text/event-stream";
  const encodingIsUtf8 = isValidUtf8(encoded.body);

  // Decoder probes feed minimal byte traces through the same `decodeSseStream`
  // the production lane uses, so any drift between this report and the
  // decoder is impossible by construction.
  const lfEvents = decodeSseStream("data: lf-line\n\n").events;
  const crlfEvents = decodeSseStream("data: crlf-line\r\n\r\n").events;
  const crEvents = decodeSseStream("data: cr-line\r\r").events;
  const acceptsLfCrlfAndCrLineTerminators =
    lfEvents.length === 1 &&
    crlfEvents.length === 1 &&
    crEvents.length === 1 &&
    lfEvents[0]?.data === "lf-line" &&
    crlfEvents[0]?.data === "crlf-line" &&
    crEvents[0]?.data === "cr-line";

  const bomProbe = decodeSseStream("\uFEFFdata: bom-stripped\n\n").events;
  const stripsLeadingBom =
    bomProbe.length === 1 && bomProbe[0]?.data === "bom-stripped";

  const spaceProbe = decodeSseStream("data:  one-space-stripped\n\n").events;
  const stripsSingleLeadingFieldSpace =
    spaceProbe.length === 1 && spaceProbe[0]?.data === " one-space-stripped";

  const pendingProbe = decodeSseStream("data: never-dispatches\n").events;
  const dispatchedProbe = decodeSseStream("data: dispatches\n\n").events;
  const dispatchesOnEmptyLine =
    pendingProbe.length === 0 &&
    dispatchedProbe.length === 1 &&
    dispatchedProbe[0]?.data === "dispatches";

  const commentProbe = decodeSseStream(": heartbeat\ndata: kept\n\n").events;
  const ignoresCommentLines =
    commentProbe.length === 1 && commentProbe[0]?.data === "kept";

  return {
    acceptsLfCrlfAndCrLineTerminators,
    contentTypeIsEventStream,
    dispatchesOnEmptyLine,
    encodingIsUtf8,
    ignoresCommentLines,
    stripsLeadingBom,
    stripsSingleLeadingFieldSpace,
  };
}

/** True when `bytes` decode as strict (non-lossy) UTF-8. */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits `text` into complete lines per the WHATWG line-terminator rule: LF,
 * CRLF, or a bare CR each end a line. A trailing unterminated run of
 * characters at end-of-stream is not a complete line and is therefore not
 * yielded — it corresponds to a partial frame the algorithm must discard.
 */
function* iterateCompleteLines(text: string): Generator<string> {
  // WHATWG line terminators are LF, CRLF, or bare CR. A trailing unterminated
  // run of characters at end-of-stream is NOT a complete line and is
  // therefore not yielded — it would correspond to a partial frame the
  // algorithm must discard.
  let current = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character === "\r") {
      yield current;
      current = "";
      const next = text[index + 1];

      if (next === "\n") {
        index += 2;
      } else {
        index += 1;
      }

      continue;
    }

    if (character === "\n") {
      yield current;
      current = "";
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }
}
