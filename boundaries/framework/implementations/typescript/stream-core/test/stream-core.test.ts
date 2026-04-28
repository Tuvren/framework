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
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import {
  collectStreamValues,
  frameworkStreamTestFixtures,
  waitForAsyncTurn,
} from "@tuvren/framework-testkit";
import {
  cloneTuvrenStreamEvent,
  createFixtureStream,
  createStreamAdapterWarningReporter,
  serializeTuvrenStreamEvent,
  teeTuvrenStreamEvents,
} from "../src/index.ts";

const EVENT_STREAMS_CONSUMED_PATTERN =
  /event streams may only be consumed once/;
const LATE_SUBSCRIPTION_PATTERN =
  /must subscribe before source consumption begins/;

describe("stream-core", () => {
  test("tees one canonical stream into isolated single-consumer branches", async () => {
    let started = false;
    // biome-ignore lint/suspicious/useAwait: Async generators must remain async even when fixture production is synchronous.
    const source = (async function* (): AsyncIterable<TuvrenStreamEvent> {
      started = true;

      for (const event of frameworkStreamTestFixtures.completedTurn) {
        yield cloneTuvrenStreamEvent(event);
      }
    })();
    const [leftBranch, rightBranch] = teeTuvrenStreamEvents(source, 2);

    expect(started).toBe(false);

    const leftEventsPromise = collectStreamValues(leftBranch);
    const rightEventsPromise = collectStreamValues(rightBranch);
    const [leftEvents, rightEvents] = await Promise.all([
      leftEventsPromise,
      rightEventsPromise,
    ]);

    expect(started).toBe(true);
    expect(leftEvents).toEqual([...frameworkStreamTestFixtures.completedTurn]);
    expect(rightEvents).toEqual([...frameworkStreamTestFixtures.completedTurn]);
    expect(leftEvents[0]).not.toBe(rightEvents[0]);

    if (
      leftEvents[0]?.type !== "turn.start" ||
      rightEvents[0]?.type !== "turn.start"
    ) {
      throw new Error("expected turn.start fixtures");
    }

    leftEvents[0].turnId = "mutated-left";
    expect(rightEvents[0].turnId).toBe("turn-main");

    expect(() => leftBranch[Symbol.asyncIterator]()).toThrow(
      EVENT_STREAMS_CONSUMED_PATTERN
    );
  });

  test("dedupes warnings by code and swallows observer failures", () => {
    const warnings: string[] = [];
    const reportWarning = createStreamAdapterWarningReporter({
      onWarning(warning) {
        warnings.push(warning.code);

        if (warning.code === "first_warning") {
          throw new Error("observer failure should be ignored");
        }
      },
    });

    reportWarning({
      code: "first_warning",
      message: "one",
    });
    reportWarning({
      code: "first_warning",
      message: "duplicate",
    });
    reportWarning({
      code: "second_warning",
      message: "two",
    });

    expect(warnings).toEqual(["first_warning", "second_warning"]);
  });

  test("serializes Uint8Array payloads into JSON-safe marker objects", async () => {
    const [event] = await collectStreamValues(
      createFixtureStream([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "application/octet-stream",
          messageId: "message-binary",
          timestamp: 1,
          type: "file.done",
        },
      ])
    );

    if (event?.type !== "file.done") {
      throw new Error("expected file.done event");
    }

    const serialized = serializeTuvrenStreamEvent(event);

    expect(JSON.parse(serialized)).toEqual({
      data: {
        data: [1, 2, 3],
        type: "Uint8Array",
      },
      mediaType: "application/octet-stream",
      messageId: "message-binary",
      timestamp: 1,
      type: "file.done",
    });
  });

  test("stops the source when the only active branch returns and siblings were never claimed", async () => {
    const source = createInstrumentedSource(
      frameworkStreamTestFixtures.completedTurn
    );
    const [activeBranch] = teeTuvrenStreamEvents(source.events, 2);
    const iterator = activeBranch[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: frameworkStreamTestFixtures.completedTurn[0],
    });

    await iterator.return?.();
    await waitForAsyncTurn();

    expect(source.returned).toBe(1);
    expect(source.produced).toBeLessThanOrEqual(2);
  });

  test("applies backpressure to claimed branches that have not started polling yet", async () => {
    const source = createInstrumentedSource(
      frameworkStreamTestFixtures.completedTurn
    );
    const [leftBranch, rightBranch] = teeTuvrenStreamEvents(source.events, 2);
    const leftIterator = leftBranch[Symbol.asyncIterator]();
    const rightIterator = rightBranch[Symbol.asyncIterator]();

    expect(await leftIterator.next()).toMatchObject({
      done: false,
      value: frameworkStreamTestFixtures.completedTurn[0],
    });
    await waitForAsyncTurn();

    // The idle claimed branch is allowed to hold one unread event, but it must
    // also hold upstream progress there until it either polls or closes.
    expect(source.produced).toBe(1);

    expect(await rightIterator.next()).toMatchObject({
      done: false,
      value: frameworkStreamTestFixtures.completedTurn[0],
    });

    await Promise.all([leftIterator.return?.(), rightIterator.return?.()]);
    await waitForAsyncTurn();
    expect(source.returned).toBe(1);
  });

  test("replays the full prefix for branches that subscribe before source start and poll later", async () => {
    const source = createInstrumentedSource(
      frameworkStreamTestFixtures.completedTurn
    );
    const [leftBranch, rightBranch] = teeTuvrenStreamEvents(source.events, 2);
    const leftIterator = leftBranch[Symbol.asyncIterator]();
    const rightIterator = rightBranch[Symbol.asyncIterator]();
    const leftFirst = await leftIterator.next();

    expect(leftFirst).toMatchObject({
      done: false,
      value: frameworkStreamTestFixtures.completedTurn[0],
    });
    await waitForAsyncTurn();

    expect(source.produced).toBe(1);

    const [leftRest, rightEvents] = await Promise.all([
      collectIteratorEvents(leftIterator),
      collectIteratorEvents(rightIterator),
    ]);

    expect([leftFirst.value, ...leftRest]).toEqual([
      ...frameworkStreamTestFixtures.completedTurn,
    ]);
    expect(rightEvents).toEqual([...frameworkStreamTestFixtures.completedTurn]);
  });

  test("rejects branches that subscribe after source consumption has started", async () => {
    const source = createInstrumentedSource(
      frameworkStreamTestFixtures.completedTurn
    );
    const [leftBranch, rightBranch] = teeTuvrenStreamEvents(source.events, 2);
    const leftIterator = leftBranch[Symbol.asyncIterator]();

    await leftIterator.next();
    await waitForAsyncTurn();

    expect(() => rightBranch[Symbol.asyncIterator]()).toThrow(
      LATE_SUBSCRIPTION_PATTERN
    );

    try {
      rightBranch[Symbol.asyncIterator]();
      throw new Error("expected late tee subscription to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect(readErrorCode(error)).toBe("event_stream_subscription_too_late");
    }

    await leftIterator.return?.();
  });
});

async function collectIteratorEvents<T>(
  iterator: AsyncIterator<T>
): Promise<T[]> {
  const collected: T[] = [];

  for (;;) {
    const nextEvent = await iterator.next();

    if (nextEvent.done) {
      return collected;
    }

    collected.push(nextEvent.value);
  }
}

function readErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return error.code;
}

function createInstrumentedSource(events: readonly TuvrenStreamEvent[]): {
  events: AsyncIterable<TuvrenStreamEvent>;
  produced: number;
  returned: number;
} {
  let index = 0;
  let produced = 0;
  let returned = 0;

  return {
    get events(): AsyncIterable<TuvrenStreamEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<TuvrenStreamEvent> {
          return {
            next(): Promise<IteratorResult<TuvrenStreamEvent>> {
              const event = events[index];

              if (event === undefined) {
                return Promise.resolve({
                  done: true,
                  value: undefined,
                });
              }

              index += 1;
              produced += 1;

              return Promise.resolve({
                done: false,
                value: cloneTuvrenStreamEvent(event),
              });
            },
            return(): Promise<IteratorResult<TuvrenStreamEvent>> {
              returned += 1;
              return Promise.resolve({
                done: true,
                value: undefined,
              });
            },
          };
        },
      };
    },
    get produced(): number {
      return produced;
    },
    get returned(): number {
      return returned;
    },
  };
}
