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

export interface FrameworkStreamTestFixtureSet {
  completedTurn: readonly TuvrenStreamEvent[];
  failedTurn: readonly TuvrenStreamEvent[];
  pausedTurn: readonly TuvrenStreamEvent[];
}

export const frameworkStreamTestFixtures: FrameworkStreamTestFixtureSet = {
  completedTurn: [
    {
      threadId: "thread-main",
      timestamp: 1,
      turnId: "turn-main",
      type: "turn.start",
    },
    {
      iterationCount: 1,
      timestamp: 2,
      type: "iteration.start",
    },
    {
      messageId: "message-main",
      role: "assistant",
      timestamp: 3,
      type: "message.start",
    },
    {
      delta: "Hello",
      messageId: "message-main",
      timestamp: 4,
      type: "text.delta",
    },
    {
      messageId: "message-main",
      text: "Hello",
      timestamp: 5,
      type: "text.done",
    },
    {
      callId: "call-search",
      messageId: "message-main",
      name: "search",
      timestamp: 6,
      type: "tool_call.start",
    },
    {
      callId: "call-search",
      delta: '{"query":"docs"}',
      timestamp: 7,
      type: "tool_call.args_delta",
    },
    {
      callId: "call-search",
      input: {
        query: "docs",
      },
      name: "search",
      timestamp: 8,
      type: "tool_call.done",
    },
    {
      callId: "call-search",
      input: {
        query: "docs",
      },
      name: "search",
      timestamp: 9,
      type: "tool.start",
    },
    {
      callId: "call-search",
      name: "search",
      output: {
        hits: 2,
      },
      timestamp: 10,
      type: "tool.result",
    },
    {
      manifest: {
        byRole: {
          assistant: 1,
          system: 0,
          tool: 1,
          user: 1,
        },
        extensions: {},
        lastAssistantMessageIndex: 1,
        lastUserMessageIndex: 0,
        messageCount: 3,
        tokenEstimate: 42,
        toolCalls: {
          byName: {
            search: 1,
          },
          total: 1,
        },
        toolResults: {
          byName: {
            search: 1,
          },
          total: 1,
        },
        turnBoundaries: [0],
      },
      timestamp: 11,
      type: "state.snapshot",
    },
    {
      data: {
        ready: true,
      },
      name: "driver.executed",
      timestamp: 12,
      type: "custom",
    },
    {
      finishReason: "stop",
      messageId: "message-main",
      timestamp: 13,
      type: "message.done",
    },
    {
      iterationCount: 1,
      timestamp: 14,
      type: "iteration.end",
    },
    {
      status: "completed",
      timestamp: 15,
      turnId: "turn-main",
      type: "turn.end",
    },
  ],
  failedTurn: [
    {
      threadId: "thread-failed",
      timestamp: 21,
      turnId: "turn-failed",
      type: "turn.start",
    },
    {
      error: {
        code: "runtime_execution_cancelled",
        message: "execution cancelled",
      },
      fatal: true,
      timestamp: 22,
      type: "error",
    },
    {
      status: "failed",
      timestamp: 23,
      turnId: "turn-failed",
      type: "turn.end",
    },
  ],
  pausedTurn: [
    {
      threadId: "thread-paused",
      timestamp: 31,
      turnId: "turn-paused",
      type: "turn.start",
    },
    {
      request: {
        completedResults: [],
        toolCalls: [
          {
            callId: "call-email",
            decisions: ["approve", "reject"],
            input: {
              to: "team@example.com",
            },
            message: "Approve this email?",
            name: "send_email",
          },
        ],
      },
      timestamp: 32,
      type: "approval.requested",
    },
    {
      status: "paused",
      timestamp: 33,
      turnId: "turn-paused",
      type: "turn.end",
    },
  ],
};

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
