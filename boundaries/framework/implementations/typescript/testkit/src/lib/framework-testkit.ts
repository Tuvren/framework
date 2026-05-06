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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import { assertTuvrenStreamEvent } from "@tuvren/event-stream";

export interface EventLike {
  type: string;
}

export interface SseFrameLike {
  data: string;
  event?: string;
}

export interface AsyncCapture<T> {
  readonly done: Promise<void>;
  readonly events: T[];
}

export interface FrameworkStreamFixtureSet {
  completedTurn: readonly TuvrenStreamEvent[];
  failedTurn: readonly TuvrenStreamEvent[];
  pausedTurn: readonly TuvrenStreamEvent[];
}

const FRAMEWORK_TESTKIT_ROOT = dirname(fileURLToPath(import.meta.url));
const STREAM_FIXTURE_PATHS = [
  resolve(
    FRAMEWORK_TESTKIT_ROOT,
    "../../../../../conformance/fixtures/stream-events.json"
  ),
  resolve(
    FRAMEWORK_TESTKIT_ROOT,
    "../../../../conformance/fixtures/stream-events.json"
  ),
];

export function createFixtureEventStream(
  events: readonly TuvrenStreamEvent[]
): AsyncIterable<TuvrenStreamEvent> {
  // biome-ignore lint/suspicious/useAwait: Async generators must remain async even for synchronous fixtures.
  return (async function* () {
    for (const event of events) {
      yield cloneTuvrenStreamEvent(event);
    }
  })();
}

export async function collectStreamValues<T>(
  stream: AsyncIterable<T>
): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

export async function collectTuvrenStreamEvents(
  stream: AsyncIterable<TuvrenStreamEvent>,
  label = "event stream"
): Promise<TuvrenStreamEvent[]> {
  const events: TuvrenStreamEvent[] = [];
  let index = 0;

  for await (const event of stream) {
    assertTuvrenStreamEvent(event, `${label} event ${index}`);
    events.push(cloneTuvrenStreamEvent(event));
    index += 1;
  }

  return events;
}

export async function readFrameworkStreamFixtures(): Promise<FrameworkStreamFixtureSet> {
  const fixture = (await readFirstJsonFile(
    STREAM_FIXTURE_PATHS,
    "stream-events fixture"
  )) as unknown;

  assertFrameworkStreamFixtureSet(fixture, "stream-events fixture");
  return fixture;
}

export function assertStreamEventTypes(
  events: readonly EventLike[],
  expectedTypes: readonly string[],
  label = "event stream"
): void {
  assertEventTypes(events, expectedTypes, label);
}

export function assertSseFrameEvents(
  frames: readonly SseFrameLike[],
  expectedEvents: readonly string[],
  label = "SSE stream"
): void {
  const actualEvents = frames.map((frame) => frame.event ?? "message");
  assertStringArrays(actualEvents, expectedEvents, label);
}

export function assertAgUiEventTypes(
  events: readonly EventLike[],
  expectedTypes: readonly string[],
  label = "AG-UI stream"
): void {
  assertEventTypes(events, expectedTypes, label);
}

export function startAsyncCapture<T>(
  stream: AsyncIterable<T>
): AsyncCapture<T> {
  const events: T[] = [];
  const done = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })();

  return {
    done,
    events,
  };
}

export async function waitForCondition(
  condition: () => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const intervalMs = options.intervalMs ?? 1;
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

export async function waitForAsyncTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function assertEventTypes(
  events: readonly EventLike[],
  expectedTypes: readonly string[],
  label: string
): void {
  const actualTypes = events.map((event) => event.type);
  assertStringArrays(actualTypes, expectedTypes, label);
}

function assertStringArrays(
  actualValues: readonly string[],
  expectedValues: readonly string[],
  label: string
): void {
  if (actualValues.length !== expectedValues.length) {
    throw new Error(
      `${label} emitted ${JSON.stringify(
        actualValues
      )}; expected ${JSON.stringify(expectedValues)}`
    );
  }

  for (const [index, actualValue] of actualValues.entries()) {
    if (actualValue !== expectedValues[index]) {
      throw new Error(
        `${label} emitted ${JSON.stringify(
          actualValues
        )}; expected ${JSON.stringify(expectedValues)}`
      );
    }
  }
}

function cloneTuvrenStreamEvent(event: TuvrenStreamEvent): TuvrenStreamEvent {
  const cloned = structuredClone(event);
  assertTuvrenStreamEvent(cloned, "cloned stream event");
  return cloned;
}

async function readFirstJsonFile(
  paths: readonly string[],
  label: string
): Promise<unknown> {
  const errors: string[] = [];

  for (const path of paths) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (isNotFoundError(error)) {
        errors.push(path);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`${label} was not found at ${errors.join(", ")}`);
}

function assertFrameworkStreamFixtureSet(
  value: unknown,
  label: string
): asserts value is FrameworkStreamFixtureSet {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  assertTuvrenStreamEvents(value.completedTurn, `${label}.completedTurn`);
  assertTuvrenStreamEvents(value.failedTurn, `${label}.failedTurn`);
  assertTuvrenStreamEvents(value.pausedTurn, `${label}.pausedTurn`);
}

function assertTuvrenStreamEvents(
  value: unknown,
  label: string
): asserts value is readonly TuvrenStreamEvent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  for (const [index, event] of value.entries()) {
    assertTuvrenStreamEvent(event, `${label}[${index}]`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
