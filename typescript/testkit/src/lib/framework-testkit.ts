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
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import { assertTuvrenStreamEvent } from "@tuvren/core/events";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";

/** Minimal shape {@link assertStreamEventTypes}/{@link assertAgUiEventTypes} need from a protocol event. */
export interface EventLike {
  type: string;
}

/** Minimal shape {@link assertSseFrameEvents} needs from an SSE frame. */
export interface SseFrameLike {
  data: string;
  event?: string;
}

/**
 * Result of {@link startAsyncCapture}: `events` accumulates live as the
 * source stream is consumed in the background; `done` resolves once the
 * stream is fully drained (or rejects if it throws).
 */
export interface AsyncCapture<T> {
  readonly done: Promise<void>;
  readonly events: T[];
}

/** Canonical named `TuvrenStreamEvent` sequences loaded by {@link readFrameworkStreamFixtures}. */
export interface FrameworkStreamFixtureSet {
  /** A turn that streams assistant content, executes a tool, and completes normally. */
  completedTurn: readonly TuvrenStreamEvent[];
  /** A turn that fails with a fatal error. */
  failedTurn: readonly TuvrenStreamEvent[];
  /** A turn that pauses on a tool approval request. */
  pausedTurn: readonly TuvrenStreamEvent[];
}

/**
 * In-memory `TuvrenTelemetrySink` capture built by
 * {@link createTelemetryCaptureSink}, for asserting on telemetry a test
 * subject emits without a real OpenTelemetry backend.
 */
export interface TelemetryCapture {
  /** Empties `events` and `spans` in place, for reuse across test cases. */
  clear(): void;
  /** Every event emitted through `sink.event`, deep-cloned at capture time. */
  readonly events: TelemetryEvent[];
  /** The sink to pass to the code under test. */
  readonly sink: TuvrenTelemetrySink;
  /** Every span emitted through `sink.span`, deep-cloned at capture time. */
  readonly spans: TelemetrySpan[];
}

const FRAMEWORK_TESTKIT_ROOT = dirname(fileURLToPath(import.meta.url));
const STREAM_FIXTURE_PATHS = [
  resolve(
    FRAMEWORK_TESTKIT_ROOT,
    "../../../../spec/conformance/streaming/fixtures/stream-events.json"
  ),
  resolve(
    FRAMEWORK_TESTKIT_ROOT,
    "../../../spec/conformance/streaming/fixtures/stream-events.json"
  ),
];

/**
 * Wraps a fixed event list as a fresh, one-pass `AsyncIterable`, cloning each
 * event on yield so repeated iterations (or fixtures shared across tests)
 * never alias mutable state.
 */
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

/** Drains `stream` fully and returns every value in emission order. */
export async function collectStreamValues<T>(
  stream: AsyncIterable<T>
): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

/**
 * Drains `stream` fully, validating and cloning each event.
 *
 * @throws If any yielded value fails `assertTuvrenStreamEvent`, with `label`
 *   and the event's index in the message.
 */
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

/**
 * Loads and validates the canonical `stream-events.json` conformance fixture
 * (`spec/conformance/streaming/fixtures/stream-events.json`) as a
 * {@link FrameworkStreamFixtureSet}.
 *
 * Tries a short list of relative paths from this package's own location so
 * the helper works whether it's consumed from a package one or two levels
 * under `typescript/`.
 *
 * @throws If the fixture file is not found at any candidate path, or its
 *   contents do not validate as a {@link FrameworkStreamFixtureSet} (via
 *   `assertTuvrenStreamEvent` on every entry).
 */
export async function readFrameworkStreamFixtures(): Promise<FrameworkStreamFixtureSet> {
  const fixture = (await readFirstJsonFile(
    STREAM_FIXTURE_PATHS,
    "stream-events fixture"
  )) as unknown;

  assertFrameworkStreamFixtureSet(fixture, "stream-events fixture");
  return fixture;
}

/**
 * Asserts that `events`' `type` values, in order, exactly equal
 * `expectedTypes`.
 *
 * @throws An `Error` (with both actual and expected sequences serialized)
 *   when the lengths or any positional value differ.
 */
export function assertStreamEventTypes(
  events: readonly EventLike[],
  expectedTypes: readonly string[],
  label = "event stream"
): void {
  assertEventTypes(events, expectedTypes, label);
}

/**
 * Asserts that `frames`' SSE `event` fields, in order, exactly equal
 * `expectedEvents` — a frame with no `event` field is treated as the SSE
 * default event name `"message"`.
 *
 * @throws An `Error` when the lengths or any positional value differ.
 */
export function assertSseFrameEvents(
  frames: readonly SseFrameLike[],
  expectedEvents: readonly string[],
  label = "SSE stream"
): void {
  const actualEvents = frames.map((frame) => frame.event ?? "message");
  assertStringArrays(actualEvents, expectedEvents, label);
}

/**
 * Asserts that `events`' `type` values, in order, exactly equal
 * `expectedTypes` (AG-UI event `type` values, e.g. `RUN_STARTED`).
 *
 * @throws An `Error` when the lengths or any positional value differ.
 */
export function assertAgUiEventTypes(
  events: readonly EventLike[],
  expectedTypes: readonly string[],
  label = "AG-UI stream"
): void {
  assertEventTypes(events, expectedTypes, label);
}

/**
 * Starts draining `stream` in the background immediately, returning a
 * live-accumulating {@link AsyncCapture}. Useful for asserting on events
 * produced concurrently with other test actions (e.g. driving a handle while
 * observing its emitted stream).
 */
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

/**
 * Builds an in-memory {@link TelemetryCapture}: its `sink` deep-clones every
 * event/span it receives into `events`/`spans`, so a test can assert on
 * emitted telemetry without a real OpenTelemetry (or other) backend.
 */
export function createTelemetryCaptureSink(): TelemetryCapture {
  const events: TelemetryEvent[] = [];
  const spans: TelemetrySpan[] = [];

  return {
    clear: () => {
      events.length = 0;
      spans.length = 0;
    },
    events,
    sink: {
      event: (event) => {
        events.push(structuredClone(event));
      },
      span: (span) => {
        spans.push(structuredClone(span));
      },
    },
    spans,
  };
}

/**
 * Polls `condition` at `options.intervalMs` (default `1`ms) until it returns
 * `true` or `options.timeoutMs` (default `1000`ms) elapses.
 *
 * @throws An `Error` if `condition` has not returned `true` before the
 *   timeout elapses.
 */
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

/** Yields one macrotask (a zero-delay `setTimeout`), for letting pending microtasks/timers in the system under test settle. */
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

/**
 * Reads and JSON-parses the first path in `paths` that exists, trying each
 * in order and skipping past `ENOENT` failures.
 *
 * @throws The first non-`ENOENT` read/parse error encountered, or an `Error`
 *   naming every attempted path if none exist.
 */
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

/**
 * @throws An `Error` when `value` is not an object, or (via
 *   {@link assertTuvrenStreamEvents}) when any of its three named turn
 *   sequences is missing, not an array, or contains an invalid stream event.
 */
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
