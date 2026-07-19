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

import { describe, expect, test } from "bun:test";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import {
  createFixtureStream,
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  decodeResumeCursor,
  encodeResumeCursor,
  type SequencedTuvrenStreamEvent,
  type StreamAdapterWarning,
  streamAdapterFixtures,
  teeTuvrenStreamEvents,
} from "../src/index.ts";

const HASH_ONE = "1".repeat(64);
const HASH_EARLY = "e".repeat(64);
const HASH_LATE = "f".repeat(64);
const HASH_REAL = "d".repeat(64);
const HASH_FOREIGN = "0".repeat(64);
const HASH_A = "a".repeat(64);

function turnEvents(
  turnId: string,
  withCheckpoint?: { turnNodeHash: string; afterIndex: number }
): TuvrenStreamEvent[] {
  const events: TuvrenStreamEvent[] = [
    { threadId: "thread-1", timestamp: 1, turnId, type: "turn.start" },
    {
      delta: "Hello",
      messageId: `${turnId}-message`,
      timestamp: 2,
      type: "text.delta",
    },
    {
      messageId: `${turnId}-message`,
      text: "Hello",
      timestamp: 3,
      type: "text.done",
    },
    { status: "completed", timestamp: 4, turnId, type: "turn.end" },
  ];

  if (withCheckpoint !== undefined) {
    events.splice(withCheckpoint.afterIndex, 0, {
      iterationCount: 1,
      timestamp: 2,
      turnNodeHash: withCheckpoint.turnNodeHash,
      type: "state.checkpoint",
    });
  }

  return events;
}

async function collect(
  sequenced: AsyncIterable<SequencedTuvrenStreamEvent>
): Promise<SequencedTuvrenStreamEvent[]> {
  const frames: SequencedTuvrenStreamEvent[] = [];

  for await (const frame of sequenced) {
    frames.push(frame);
  }

  return frames;
}

describe("resume cursor codec", () => {
  test("round-trips a payload with and without a checkpoint anchor", () => {
    const anchored = {
      sequence: 7,
      turnId: "turn-a",
      turnNodeHash: HASH_A,
      v: 1,
    } as const;
    const unanchored = { sequence: 0, turnId: "turn-b", v: 1 } as const;

    expect(decodeResumeCursor(encodeResumeCursor(anchored))).toEqual(anchored);
    expect(decodeResumeCursor(encodeResumeCursor(unanchored))).toEqual(
      unanchored
    );
  });

  test("decodes malformed tokens as absence, never throwing", () => {
    expect(decodeResumeCursor("")).toBeUndefined();
    expect(decodeResumeCursor("not/base64url!")).toBeUndefined();
    expect(decodeResumeCursor("aGVsbG8")).toBeUndefined();
    expect(
      decodeResumeCursor(
        encodeResumeCursor({ sequence: 1, turnId: "t", v: 1 }).slice(0, 3)
      )
    ).toBeUndefined();
  });

  test("rejects unknown payload versions and invalid fields", () => {
    const forgedVersion = Buffer.from(
      JSON.stringify({ sequence: 1, turnId: "t", v: 2 })
    ).toString("base64url");
    const negativeSequence = Buffer.from(
      JSON.stringify({ sequence: -1, turnId: "t", v: 1 })
    ).toString("base64url");
    const emptyTurn = Buffer.from(
      JSON.stringify({ sequence: 1, turnId: "", v: 1 })
    ).toString("base64url");

    expect(decodeResumeCursor(forgedVersion)).toBeUndefined();
    expect(decodeResumeCursor(negativeSequence)).toBeUndefined();
    expect(decodeResumeCursor(emptyTurn)).toBeUndefined();
  });
});

describe("createSequencedTuvrenStreamEvents", () => {
  test("stamps monotonic sequences that reset at each turn.start", async () => {
    const events = [...turnEvents("turn-1"), ...turnEvents("turn-2")];
    const frames = await collect(
      createSequencedTuvrenStreamEvents(createFixtureStream(events))
    );

    expect(frames.map((frame) => frame.sequence)).toEqual([
      0, 1, 2, 3, 0, 1, 2, 3,
    ]);
    expect(frames.map((frame) => frame.turnId)).toEqual([
      ...Array.from({ length: 4 }, () => "turn-1"),
      ...Array.from({ length: 4 }, () => "turn-2"),
    ]);
    expect(frames.map((frame) => frame.event.type)).toEqual(
      events.map((event) => event.type)
    );
  });

  test("carries the latest state.checkpoint anchor and resets it per turn", async () => {
    const events = [
      ...turnEvents("turn-1", { afterIndex: 2, turnNodeHash: HASH_ONE }),
      ...turnEvents("turn-2"),
    ];
    const frames = await collect(
      createSequencedTuvrenStreamEvents(createFixtureStream(events))
    );

    const decoded = frames.map((frame) => decodeResumeCursor(frame.cursor));

    // Before the checkpoint: no anchor. From the checkpoint on: anchored.
    expect(decoded[0]?.turnNodeHash).toBeUndefined();
    expect(decoded[1]?.turnNodeHash).toBeUndefined();
    expect(decoded[2]?.turnNodeHash).toBe(HASH_ONE);
    expect(decoded[3]?.turnNodeHash).toBe(HASH_ONE);
    expect(decoded[4]?.turnNodeHash).toBe(HASH_ONE);
    // Next turn starts unanchored again.
    expect(decoded[5]?.turnNodeHash).toBeUndefined();
  });

  test("cursor payloads reflect each frame's own position", async () => {
    const frames = await collect(
      createSequencedTuvrenStreamEvents(
        createFixtureStream(streamAdapterFixtures.completedTurn)
      )
    );

    for (const frame of frames) {
      const payload = decodeResumeCursor(frame.cursor);
      expect(payload?.turnId).toBe(frame.turnId);
      expect(payload?.sequence).toBe(frame.sequence);
    }
  });

  test("attributes pre-turn events to a placeholder turn with one warning", async () => {
    const warnings: StreamAdapterWarning[] = [];
    const events: TuvrenStreamEvent[] = [
      { delta: "orphan", messageId: "m", timestamp: 1, type: "text.delta" },
      { delta: "orphan-2", messageId: "m", timestamp: 2, type: "text.delta" },
      ...turnEvents("turn-late"),
    ];
    const frames = await collect(
      createSequencedTuvrenStreamEvents(createFixtureStream(events), {
        onWarning: (warning) => warnings.push(warning),
      })
    );

    expect(frames[0]?.turnId).toBe("unattributed");
    expect(frames[1]?.turnId).toBe("unattributed");
    expect(frames[2]?.turnId).toBe("turn-late");
    expect(frames[2]?.sequence).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("stream_sequencer_event_before_turn_start");
  });

  test("claims its source synchronously so tee branches are never late", async () => {
    const [branch] = teeTuvrenStreamEvents(
      createFixtureStream(streamAdapterFixtures.completedTurn),
      1
    );
    const sequenced = createSequencedTuvrenStreamEvents(
      branch as AsyncIterable<TuvrenStreamEvent>
    );

    const frames = await collect(sequenced);
    expect(frames).toHaveLength(streamAdapterFixtures.completedTurn.length);
  });
});

describe("createReplayBuffer", () => {
  async function sequencedFixture(
    events: TuvrenStreamEvent[]
  ): Promise<SequencedTuvrenStreamEvent[]> {
    return await collect(
      createSequencedTuvrenStreamEvents(createFixtureStream(events))
    );
  }

  test("replays retained frames strictly after the cursor position", async () => {
    const frames = await sequencedFixture(turnEvents("turn-1"));
    const buffer = createReplayBuffer({ capacity: 10 });

    for (const frame of frames) {
      buffer.record(frame);
    }

    const midCursor = frames[1]?.cursor as string;
    const result = buffer.replayFrom(midCursor);

    expect(result.status).toBe("resumed");

    if (result.status === "resumed") {
      expect(result.events.map((frame) => frame.sequence)).toEqual([2, 3]);
    }

    expect(buffer.latestCursor()).toBe(frames.at(-1)?.cursor);
  });

  test("reports unknown-turn for a turn the buffer never observed", async () => {
    const buffer = createReplayBuffer({ capacity: 10 });
    const foreignCursor = encodeResumeCursor({
      sequence: 0,
      turnId: "turn-never-seen",
      v: 1,
    });

    expect(buffer.replayFrom(foreignCursor).status).toBe("unknown-turn");

    for (const frame of await sequencedFixture(turnEvents("turn-1"))) {
      buffer.record(frame);
    }

    expect(buffer.replayFrom(foreignCursor).status).toBe("unknown-turn");
  });

  test("reports out-of-window once the cursor position is evicted", async () => {
    const frames = await sequencedFixture(turnEvents("turn-1"));
    const buffer = createReplayBuffer({ capacity: 2 });

    for (const frame of frames) {
      buffer.record(frame);
    }

    // Only sequences 2 and 3 are retained; a cursor at 0 fell out.
    expect(buffer.replayFrom(frames[0]?.cursor as string).status).toBe(
      "out-of-window"
    );
    expect(buffer.replayFrom(frames[2]?.cursor as string).status).toBe(
      "resumed"
    );
  });

  test("maps malformed cursors to out-of-window when any turn was observed", async () => {
    const buffer = createReplayBuffer({ capacity: 10 });

    for (const frame of await sequencedFixture(turnEvents("turn-1"))) {
      buffer.record(frame);
    }

    expect(buffer.replayFrom("not-a-cursor!").status).toBe("out-of-window");
  });

  test("cross-checkpoint resume: an older retained anchor still replays", async () => {
    const events: TuvrenStreamEvent[] = [
      { threadId: "t", timestamp: 1, turnId: "turn-1", type: "turn.start" },
      {
        iterationCount: 1,
        timestamp: 2,
        turnNodeHash: HASH_EARLY,
        type: "state.checkpoint",
      },
      { delta: "a", messageId: "m", timestamp: 3, type: "text.delta" },
      {
        iterationCount: 2,
        timestamp: 4,
        turnNodeHash: HASH_LATE,
        type: "state.checkpoint",
      },
      { delta: "b", messageId: "m", timestamp: 5, type: "text.delta" },
      {
        status: "completed",
        timestamp: 6,
        turnId: "turn-1",
        type: "turn.end",
      },
    ];
    const frames = await sequencedFixture(events);
    const buffer = createReplayBuffer({ capacity: 10 });

    for (const frame of frames) {
      buffer.record(frame);
    }

    // Cursor anchored at the earlier checkpoint, taken mid-turn.
    const earlyAnchored = frames[2]?.cursor as string;
    const result = buffer.replayFrom(earlyAnchored);

    expect(result.status).toBe("resumed");

    if (result.status === "resumed") {
      expect(result.events.map((frame) => frame.sequence)).toEqual([3, 4, 5]);
    }
  });

  test("rejects an anchor lineage the buffer no longer retains", async () => {
    const frames = await sequencedFixture(
      turnEvents("turn-1", { afterIndex: 2, turnNodeHash: HASH_REAL })
    );
    const buffer = createReplayBuffer({ capacity: 10 });

    for (const frame of frames) {
      buffer.record(frame);
    }

    const forged = encodeResumeCursor({
      sequence: 2,
      turnId: "turn-1",
      turnNodeHash: HASH_FOREIGN,
      v: 1,
    });

    expect(buffer.replayFrom(forged).status).toBe("out-of-window");
  });

  test("requires a positive integer capacity", () => {
    expect(() => createReplayBuffer({ capacity: 0 })).toThrow(RangeError);
    expect(() => createReplayBuffer({ capacity: 1.5 })).toThrow(RangeError);
  });
});

describe("review-fix regressions", () => {
  test("early termination releases the claimed source iterator", async () => {
    let returned = false;
    const source: AsyncIterable<TuvrenStreamEvent> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        const events = turnEvents("turn-cleanup");

        return {
          next(): Promise<IteratorResult<TuvrenStreamEvent>> {
            const event = events[index];
            index += 1;

            if (event === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }

            return Promise.resolve({ done: false, value: event });
          },
          return(): Promise<IteratorResult<TuvrenStreamEvent>> {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    for await (const frame of createSequencedTuvrenStreamEvents(source)) {
      if (frame.sequence === 1) {
        break;
      }
    }

    expect(returned).toBe(true);
  });

  test("a fully evicted turn reports unknown-turn and prunes bookkeeping", async () => {
    // One sequencer over both turns, per the binding appendix wiring rule.
    const frames = await collect(
      createSequencedTuvrenStreamEvents(
        createFixtureStream([
          ...turnEvents("turn-old"),
          ...turnEvents("turn-new"),
        ])
      )
    );
    const buffer = createReplayBuffer({ capacity: 4 });

    for (const frame of frames) {
      buffer.record(frame);
    }

    // turn-new's 4 frames pushed every turn-old frame out.
    const firstTurnCursor = frames[0]?.cursor as string;
    const secondTurnMidCursor = frames[5]?.cursor as string;

    expect(buffer.replayFrom(firstTurnCursor).status).toBe("unknown-turn");
    expect(buffer.replayFrom(secondTurnMidCursor).status).toBe("resumed");
  });

  test("resume across a turn boundary replays the cursor turn's tail and every later retained turn", async () => {
    // A client that sleeps across a turn boundary must not be told
    // "resumed" while whole retained turns are silently dropped.
    const frames = await collect(
      createSequencedTuvrenStreamEvents(
        createFixtureStream([...turnEvents("turn-a"), ...turnEvents("turn-b")])
      )
    );
    const buffer = createReplayBuffer({ capacity: 100 });

    for (const frame of frames) {
      buffer.record(frame);
    }

    // Cursor mid-turn-a (sequence 1 of 0..3).
    const result = buffer.replayFrom(frames[1]?.cursor as string);

    expect(result.status).toBe("resumed");

    if (result.status === "resumed") {
      expect(
        result.events.map((frame) => [frame.turnId, frame.sequence])
      ).toEqual([
        ["turn-a", 2],
        ["turn-a", 3],
        ["turn-b", 0],
        ["turn-b", 1],
        ["turn-b", 2],
        ["turn-b", 3],
      ]);
    }
  });
});
