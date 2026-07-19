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

import type { TuvrenStreamEvent } from "@tuvren/core/events";

import {
  createStreamAdapterWarningReporter,
  type StreamAdapterOptions,
} from "./stream-core.js";

/**
 * Placeholder turn identity for events observed before any `turn.start`.
 * Canonical streams always open with `turn.start`, so this only appears when
 * a host feeds the sequencer a partial stream; a warning with code
 * `stream_sequencer_event_before_turn_start` is reported when it happens.
 */
const UNATTRIBUTED_TURN_ID = "unattributed";

/** Cursor payload version this implementation mints and accepts. */
const RESUME_CURSOR_VERSION = 1;

/**
 * A canonical stream event wrapped with its wire-level sequencing envelope
 * (authority: `spec/streaming/resume/`, packet
 * `tuvren.framework.event-stream-resume`, model `SequencedStreamFrame`).
 *
 * Sequencing is wire-level and additive per ADR-061: the canonical event is
 * carried unmodified, and in-process consumers of the canonical stream never
 * see this envelope.
 *
 * @experimental
 */
export interface SequencedTuvrenStreamEvent {
  /** Opaque resume-cursor token positioned at this event. */
  cursor: string;
  /** The canonical event, unmodified. */
  event: TuvrenStreamEvent;
  /** Monotonic intra-turn sequence, reset to 0 at each `turn.start`. */
  sequence: number;
  /** Identity of the Turn this event belongs to. */
  turnId: string;
}

/**
 * Decoded content of an opaque resume-cursor token (authority model
 * `ResumeCursorPayload`). Only the minting side decodes tokens; clients treat
 * them as opaque strings.
 *
 * @experimental
 */
export interface ResumeCursorPayload {
  sequence: number;
  turnId: string;
  /**
   * Most recent kernel checkpoint anchor (`state.checkpoint.turnNodeHash`)
   * observed at or before the cursor position. Absent when the host has state
   * observability disabled — `state.checkpoint` emission is optional, so
   * anchoring is supplementary, never assumed.
   */
  turnNodeHash?: string;
  v: 1;
}

/**
 * Encodes a resume-cursor payload as an opaque base64url token.
 *
 * The encoding is an implementation detail documented by the authority packet
 * for cross-implementation agreement; it is not a client-constructable
 * surface.
 *
 * @experimental
 */
export function encodeResumeCursor(payload: ResumeCursorPayload): string {
  return base64UrlEncode(JSON.stringify(payload));
}

/**
 * Decodes a resume-cursor token minted by {@link encodeResumeCursor}.
 *
 * Returns `undefined` for malformed tokens and unknown payload versions —
 * decode failure is reported as absence, which replay maps to the
 * out-of-window snapshot fallback, never a thrown error on the wire path.
 *
 * @experimental
 */
export function decodeResumeCursor(
  token: string
): ResumeCursorPayload | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(base64UrlDecode(token));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate.v !== RESUME_CURSOR_VERSION) {
    return undefined;
  }

  if (typeof candidate.turnId !== "string" || candidate.turnId.length === 0) {
    return undefined;
  }

  if (
    typeof candidate.sequence !== "number" ||
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence < 0
  ) {
    return undefined;
  }

  if (
    candidate.turnNodeHash !== undefined &&
    (typeof candidate.turnNodeHash !== "string" ||
      candidate.turnNodeHash.length === 0)
  ) {
    return undefined;
  }

  const payload: ResumeCursorPayload = {
    sequence: candidate.sequence,
    turnId: candidate.turnId,
    v: RESUME_CURSOR_VERSION,
  };

  if (candidate.turnNodeHash !== undefined) {
    payload.turnNodeHash = candidate.turnNodeHash;
  }

  return payload;
}

/**
 * Wraps a canonical `TuvrenStreamEvent` stream in the wire-level sequencing
 * envelope (ADR-061): each event is stamped with its Turn identity, a
 * monotonic intra-turn sequence (reset to 0 at each `turn.start`), and an
 * opaque resume-cursor token positioned at that event. The latest
 * `state.checkpoint.turnNodeHash` observed within the current turn rides the
 * cursor as the durable kernel anchor when state observability is enabled.
 *
 * Normative wiring rule (binding appendix, `spec/streaming/resume/bindings/`):
 * the sequenced stream that feeds a live transport and the one recorded into
 * a replay buffer must come from the same sequencer instance — two sequencer
 * instances over tee branches double-count sequence numbers.
 *
 * Events observed before any `turn.start` (only possible on partial streams)
 * are attributed to a placeholder turn and reported once through
 * `options.onWarning` with code `stream_sequencer_event_before_turn_start`.
 *
 * @experimental
 */
export function createSequencedTuvrenStreamEvents(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<SequencedTuvrenStreamEvent> {
  const reportWarning = createStreamAdapterWarningReporter(options);
  // Claim synchronously so the source's claim-before-first-pull rules (e.g. a
  // tee branch) observe the subscription before any awaiting begins.
  const sourceIterator = events[Symbol.asyncIterator]();

  return (async function* () {
    let turnId: string | undefined;
    let turnNodeHash: string | undefined;
    let sequence = 0;

    for (;;) {
      const next = await sourceIterator.next();

      if (next.done) {
        return;
      }

      const event = next.value;

      if (event.type === "turn.start") {
        turnId = event.turnId;
        turnNodeHash = undefined;
        sequence = 0;
      } else if (turnId === undefined) {
        reportWarning({
          code: "stream_sequencer_event_before_turn_start",
          details: { eventType: event.type },
          message:
            "sequencer observed an event before any turn.start; attributing it to a placeholder turn",
        });
        turnId = UNATTRIBUTED_TURN_ID;
      }

      if (event.type === "state.checkpoint") {
        turnNodeHash = event.turnNodeHash;
      }

      const effectiveTurnId = turnId ?? UNATTRIBUTED_TURN_ID;
      const payload: ResumeCursorPayload = {
        sequence,
        turnId: effectiveTurnId,
        v: RESUME_CURSOR_VERSION,
      };

      if (turnNodeHash !== undefined) {
        payload.turnNodeHash = turnNodeHash;
      }

      yield {
        cursor: encodeResumeCursor(payload),
        event,
        sequence,
        turnId: effectiveTurnId,
      };

      sequence += 1;
    }
  })();
}

/**
 * Outcome of a {@link ReplayBuffer.replayFrom} attempt (authority model
 * `ReplayResult`). Both non-`resumed` statuses mean snapshot fallback:
 * durable kernel state is truth and the stream layer does not reconstruct
 * evicted events.
 *
 * @experimental
 */
export type ReplayResult =
  | { status: "resumed"; events: SequencedTuvrenStreamEvent[] }
  | { status: "out-of-window" }
  | { status: "unknown-turn" };

/**
 * Bounded, host-owned replay window over sequenced stream events (ADR-061).
 *
 * @experimental
 */
export interface ReplayBuffer {
  /** Cursor of the most recently recorded frame, if any frame was recorded. */
  latestCursor(): string | undefined;
  /** Records a sequenced frame as it is forwarded to the live transport. */
  record(sequenced: SequencedTuvrenStreamEvent): void;
  /** Attempts to replay every retained frame strictly after the cursor position. */
  replayFrom(cursor: string): ReplayResult;
}

/**
 * Creates a bounded replay window retaining the most recent `capacity`
 * sequenced frames across turns, in arrival order.
 *
 * `replayFrom(cursor)` semantics (normative, binding appendix):
 * - Turn never observed by the buffer → `unknown-turn`.
 * - Position evicted below the retention floor → `out-of-window`.
 * - Cursor `turnNodeHash` present but not among the checkpoint anchors the
 *   buffer observed for that turn's retained history → `out-of-window`
 *   (never silently serve a different anchor lineage). A cursor anchored at
 *   an older retained checkpoint of the same turn replays normally.
 * - Malformed tokens and unknown payload versions → `out-of-window`.
 * - Otherwise → `resumed` with the retained frames strictly after the cursor
 *   position, in sequence order.
 *
 * @experimental
 */
export function createReplayBuffer(options: {
  capacity: number;
}): ReplayBuffer {
  const capacity = options.capacity;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(
      "createReplayBuffer() requires a positive integer capacity"
    );
  }

  const frames: SequencedTuvrenStreamEvent[] = [];
  /** Every turnId the buffer has ever observed, retained or not. */
  const observedTurnIds = new Set<string>();

  return {
    latestCursor(): string | undefined {
      return frames.at(-1)?.cursor;
    },

    record(sequenced: SequencedTuvrenStreamEvent): void {
      observedTurnIds.add(sequenced.turnId);
      frames.push(sequenced);

      if (frames.length > capacity) {
        frames.shift();
      }
    },

    replayFrom(cursor: string): ReplayResult {
      const payload = decodeResumeCursor(cursor);

      if (payload === undefined) {
        return { status: "out-of-window" };
      }

      if (!observedTurnIds.has(payload.turnId)) {
        return { status: "unknown-turn" };
      }

      const retainedForTurn = frames.filter(
        (frame) => frame.turnId === payload.turnId
      );

      if (payload.turnNodeHash !== undefined) {
        const retainedAnchors = new Set<string>();

        for (const frame of retainedForTurn) {
          const framePayload = decodeResumeCursor(frame.cursor);

          if (framePayload?.turnNodeHash !== undefined) {
            retainedAnchors.add(framePayload.turnNodeHash);
          }
        }

        if (!retainedAnchors.has(payload.turnNodeHash)) {
          return { status: "out-of-window" };
        }
      }

      const cursorFrameRetained = retainedForTurn.some(
        (frame) => frame.sequence === payload.sequence
      );

      if (!cursorFrameRetained) {
        return { status: "out-of-window" };
      }

      return {
        events: retainedForTurn.filter(
          (frame) => frame.sequence > payload.sequence
        ),
        status: "resumed",
      };
    },
  };
}

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Base64url encoder (no padding), matching the kernel thread-list cursor convention. */
function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * Base64url decoder matching {@link base64UrlEncode}. `Buffer.from` silently
 * skips characters it cannot map, so the alphabet is validated up front —
 * callers treat any throw as a malformed token.
 *
 * @throws SyntaxError on an empty token or characters outside the base64url
 *   alphabet.
 */
function base64UrlDecode(token: string): string {
  if (!BASE64_URL_PATTERN.test(token)) {
    throw new SyntaxError("invalid base64url token");
  }

  return Buffer.from(token, "base64url").toString("utf8");
}
