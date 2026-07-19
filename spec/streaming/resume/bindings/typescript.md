# TypeScript Binding — Event Stream Resume (`tuvren.framework.event-stream-resume`)

Binding projection: `typescript/streaming/core` (`@tuvren/stream-core`).

## Surface

| Authority model | TypeScript projection |
| --- | --- |
| `SequencedStreamFrame` | `SequencedTuvrenStreamEvent` (`{ event, turnId, sequence, cursor }`) |
| `ResumeCursorPayload` | internal payload of `encodeResumeCursor` / `decodeResumeCursor` |
| `ReplayStatus` / `ReplayResult` | `ReplayResult` union returned by `ReplayBuffer.replayFrom` |

Exports (all `@experimental`, ADR-056 posture):

- `createSequencedTuvrenStreamEvents(events: AsyncIterable<TuvrenStreamEvent>): AsyncIterable<SequencedTuvrenStreamEvent>` — wraps the canonical stream in the wire-level sequencing envelope. Tracks `turnId` from `turn.start` (sequence resets to `0` there), and the latest `state.checkpoint.turnNodeHash` when state observability is enabled. The canonical events themselves are never mutated.
- `encodeResumeCursor(payload)` / `decodeResumeCursor(token)` — opaque base64url-JSON token round-trip. Decode failure is reported as absence, which replay maps to `out-of-window` (snapshot fallback), never a thrown error on the wire path.
- `createReplayBuffer({ capacity })` — bounded host-owned replay window (see semantics below).

## Wiring rules (normative for hosts)

1. **One sequencer instance per logical stream.** The sequenced stream that feeds the live transport and the one recorded into a `ReplayBuffer` MUST be the same `createSequencedTuvrenStreamEvents` instance. Instantiating two sequencers over tee branches double-counts sequence numbers and desynchronizes replay from live output. Correct wiring: sequence first, then fan out the *sequenced* frames (or `record()` each frame as it is forwarded).
2. **Single-consumer sources are unchanged.** `ExecutionHandle.events()` remains single-consumer; hosts that need both a live projection and replay recording own the fan-out (e.g. `teeTuvrenStreamEvents` upstream of the sequencer, or recording inline while forwarding).
3. **Replay window ownership.** The window is host/stream-layer owned. The kernel durably anchors turn identity (`turnNodeHash`) but does not re-project fine-grained stream events; when a cursor falls outside the window the client falls back to snapshot semantics — durable kernel state is truth.

## Replay window semantics

- The buffer retains the most recent `capacity` sequenced frames, across turns, in arrival order.
- `replayFrom(cursor)` resolves the cursor to a `(turnId, sequence)` position:
  - Turn never observed by the buffer → `unknown-turn`.
  - Turn observed but the position (or any frame after it) has been evicted below the retention floor → `out-of-window`.
  - Cursor `turnNodeHash` present but not among the checkpoint anchors the buffer observed for that turn's retained history → `out-of-window` (never silently serve a different anchor lineage). A cursor anchored at an *older retained* checkpoint of the same turn replays normally (cross-checkpoint resume).
  - Otherwise → `resumed`, returning every retained frame strictly after the cursor position in sequence order.
- Malformed tokens and unknown payload versions map to `out-of-window`.

## Transport projections

- **SSE** (`@tuvren/stream-sse`): `toResumableSseFrames` places `cursor` in the SSE frame `id` field, so WHATWG `Last-Event-ID` reconnection carries the cursor natively.
- **WebSocket** (`@tuvren/stream-ws`, packet `tuvren.framework.event-stream-ws`): the cursor rides the transport's outer message envelope for `kind: "event"` session frames; the ADR-060 session-frame vocabulary itself is unchanged.
- `TurnStartEvent.resumedFrom` (kernel-level turn resume) is a distinct concept and is not part of this surface.
