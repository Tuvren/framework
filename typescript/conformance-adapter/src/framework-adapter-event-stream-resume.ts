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
  createFixtureStream,
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  decodeResumeCursor,
  encodeResumeCursor,
  type ReplayResult,
  type SequencedTuvrenStreamEvent,
} from "@tuvren/stream-core";
import { decodeSseStream, toResumableSseFrames } from "@tuvren/stream-sse";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

interface ReplayScenarioCursor {
  kind: "at-sequence" | "foreign-turn" | "forged-anchor" | "malformed";
  sequence?: number;
  token?: string;
  turnId?: string;
  turnNodeHash?: string;
}

interface ReplayScenario {
  capacity: number;
  cursor: ReplayScenarioCursor;
  events: readonly TuvrenStreamEvent[];
}

interface SseReconnectScenario {
  capacity: number;
  events: readonly TuvrenStreamEvent[];
  truncateAfterFrames: number;
}

export function createFrameworkAdapterEventStreamResume(): {
  runReplayScenario(input: unknown): Promise<AdapterProjection>;
  runSseReconnect(input: unknown): Promise<AdapterProjection>;
} {
  async function runReplayScenario(input: unknown): Promise<AdapterProjection> {
    // The runner resolves the plan's `fixturePath` against
    // `event-stream-resume-scenarios.json` and hands the resolved scenario
    // object to the adapter under `input.fixture`. The adapter's only
    // responsibility is to drive the real sequencer and replay buffer over
    // the fixture events and surface the observed outcome under
    // `result.resume`.
    const scenario = readReplayScenario(input);

    const sequenced = await collectSequenced(scenario.events);
    const buffer = createReplayBuffer({ capacity: scenario.capacity });

    for (const frame of sequenced) {
      buffer.record(frame);
    }

    const probeCursor = resolveProbeCursor(scenario.cursor, sequenced);
    const result = buffer.replayFrom(probeCursor);

    return {
      result: {
        resume: {
          cursorTurnNodeHash:
            decodeResumeCursor(probeCursor)?.turnNodeHash ?? null,
          replaySequences: replaySequences(result),
          status: result.status,
        },
      },
    };
  }

  async function runSseReconnect(input: unknown): Promise<AdapterProjection> {
    // As above, but for the SSE reconnect scenario: the adapter sequences the
    // fixture events, records every frame into a replay buffer while
    // projecting the same sequenced stream into SSE frames (mirroring the
    // server-side recording pattern in stream-sse's round-trip test), formats
    // a wire trace, truncates it to simulate a dropped connection, decodes it
    // with the real WHATWG decoder, and replays from the decoded
    // `lastEventId`.
    const scenario = readSseReconnectScenario(input);

    const sequenced = createSequencedTuvrenStreamEvents(
      createFixtureStream(scenario.events)
    );
    const buffer = createReplayBuffer({ capacity: scenario.capacity });

    const recording = (async function* () {
      for await (const frame of sequenced) {
        buffer.record(frame);
        yield frame;
      }
    })();

    const frames: { data: string; event?: string; id?: string }[] = [];

    for await (const frame of toResumableSseFrames(recording)) {
      frames.push(frame);
    }

    const wireFrames = frames
      .slice(0, scenario.truncateAfterFrames)
      .map(
        (frame) =>
          `event: ${frame.event}\nid: ${frame.id}\ndata: ${frame.data}\n\n`
      )
      .join("");

    const decoded = decodeSseStream(wireFrames);
    const lastEventId = decoded.lastEventId ?? "";
    const reconnectResult = buffer.replayFrom(lastEventId);

    return {
      result: {
        resume: {
          sse: {
            frameIdSequences: frames.map(
              (frame) => decodeResumeCursor(frame.id ?? "")?.sequence ?? null
            ),
            lastEventIdTurnId: decodeResumeCursor(lastEventId)?.turnId ?? null,
            reconnectReplaySequences: replaySequences(reconnectResult),
            reconnectStatus: reconnectResult.status,
          },
        },
      },
    };
  }

  return { runReplayScenario, runSseReconnect };
}

async function collectSequenced(
  events: readonly TuvrenStreamEvent[]
): Promise<SequencedTuvrenStreamEvent[]> {
  const sequenced: SequencedTuvrenStreamEvent[] = [];

  for await (const frame of createSequencedTuvrenStreamEvents(
    createFixtureStream(events)
  )) {
    sequenced.push(frame);
  }

  return sequenced;
}

function resolveProbeCursor(
  cursor: ReplayScenarioCursor,
  sequenced: readonly SequencedTuvrenStreamEvent[]
): string {
  if (cursor.kind === "at-sequence") {
    const sequence = cursor.sequence;

    if (typeof sequence !== "number") {
      throw new Error(
        'event-stream-resume replay scenario cursor.kind "at-sequence" requires a numeric cursor.sequence'
      );
    }

    const frame = sequenced.find((entry) => entry.sequence === sequence);

    if (frame === undefined) {
      throw new Error(
        `event-stream-resume replay scenario cursor.sequence ${sequence} does not match any collected sequenced frame`
      );
    }

    return frame.cursor;
  }

  if (cursor.kind === "foreign-turn") {
    const turnId = cursor.turnId;

    if (typeof turnId !== "string") {
      throw new Error(
        'event-stream-resume replay scenario cursor.kind "foreign-turn" requires a string cursor.turnId'
      );
    }

    return encodeResumeCursor({ sequence: 0, turnId, v: 1 });
  }

  if (cursor.kind === "forged-anchor") {
    const turnId = cursor.turnId;
    const sequence = cursor.sequence;
    const turnNodeHash = cursor.turnNodeHash;

    if (typeof turnId !== "string") {
      throw new Error(
        'event-stream-resume replay scenario cursor.kind "forged-anchor" requires a string cursor.turnId'
      );
    }

    if (typeof sequence !== "number") {
      throw new Error(
        'event-stream-resume replay scenario cursor.kind "forged-anchor" requires a numeric cursor.sequence'
      );
    }

    if (typeof turnNodeHash !== "string") {
      throw new Error(
        'event-stream-resume replay scenario cursor.kind "forged-anchor" requires a string cursor.turnNodeHash'
      );
    }

    // Mints a cursor naming a retained sequence but a turnNodeHash anchor the
    // buffer never recorded for that turn — a forged anchor lineage. The
    // buffer must never silently serve a different anchor lineage, per
    // createReplayBuffer's replayFrom contract.
    return encodeResumeCursor({ sequence, turnId, turnNodeHash, v: 1 });
  }

  if (cursor.kind === "malformed") {
    const token = cursor.token;

    if (typeof token !== "string") {
      throw new Error(
        'event-stream-resume replay scenario cursor.kind "malformed" requires a string cursor.token'
      );
    }

    return token;
  }

  throw new Error(
    `event-stream-resume replay scenario cursor.kind "${(cursor as { kind: string }).kind}" is not recognized`
  );
}

function replaySequences(result: ReplayResult): number[] | null {
  return result.status === "resumed"
    ? result.events.map((frame) => frame.sequence)
    : null;
}

function readReplayScenario(input: unknown): ReplayScenario {
  const fixture = readFixture(input, "replay-scenario");

  return {
    capacity: readNumberProperty(fixture, "capacity"),
    cursor: readCursor(fixture),
    events: readEventsProperty(fixture),
  };
}

function readSseReconnectScenario(input: unknown): SseReconnectScenario {
  const fixture = readFixture(input, "sse-reconnect");

  return {
    capacity: readNumberProperty(fixture, "capacity"),
    events: readEventsProperty(fixture),
    truncateAfterFrames: readNumberProperty(fixture, "truncateAfterFrames"),
  };
}

function readFixture(
  input: unknown,
  operation: string
): Record<string, unknown> {
  if (
    typeof input === "object" &&
    input !== null &&
    "fixture" in input &&
    typeof (input as { fixture: unknown }).fixture === "object" &&
    (input as { fixture: unknown }).fixture !== null
  ) {
    return (input as { fixture: Record<string, unknown> }).fixture;
  }

  throw new Error(
    `${operation} expects the runner to supply the resolved scenario object under input.fixture`
  );
}

function readNumberProperty(
  fixture: Record<string, unknown>,
  key: string
): number {
  const value = fixture[key];

  if (typeof value !== "number") {
    throw new Error(
      `event-stream-resume scenario fixture is missing a numeric "${key}" property`
    );
  }

  return value;
}

function readEventsProperty(
  fixture: Record<string, unknown>
): readonly TuvrenStreamEvent[] {
  const value = fixture.events;

  if (!Array.isArray(value)) {
    throw new Error(
      'event-stream-resume scenario fixture is missing an "events" array'
    );
  }

  return value as readonly TuvrenStreamEvent[];
}

function readCursor(fixture: Record<string, unknown>): ReplayScenarioCursor {
  const value = fixture.cursor;

  if (typeof value !== "object" || value === null) {
    throw new Error(
      'event-stream-resume replay scenario fixture is missing a "cursor" object'
    );
  }

  const cursor = value as Record<string, unknown>;
  const kind = cursor.kind;

  if (
    kind !== "at-sequence" &&
    kind !== "foreign-turn" &&
    kind !== "forged-anchor" &&
    kind !== "malformed"
  ) {
    throw new Error(
      `event-stream-resume replay scenario fixture has an unrecognized cursor.kind "${String(kind)}"`
    );
  }

  return {
    kind,
    sequence: typeof cursor.sequence === "number" ? cursor.sequence : undefined,
    token: typeof cursor.token === "string" ? cursor.token : undefined,
    turnId: typeof cursor.turnId === "string" ? cursor.turnId : undefined,
    turnNodeHash:
      typeof cursor.turnNodeHash === "string" ? cursor.turnNodeHash : undefined,
  };
}
