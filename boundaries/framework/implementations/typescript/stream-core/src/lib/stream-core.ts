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

import { TuvrenRuntimeError } from "@tuvren/core";
import {
  assertTuvrenStreamEvent,
  type TuvrenStreamEvent,
} from "@tuvren/core/events";

const UINT8_ARRAY_JSON_MARKER = "Uint8Array";

export type StreamProtocolAdapter<T> = (
  events: AsyncIterable<TuvrenStreamEvent>
) => AsyncIterable<T>;

export interface StreamAdapterWarning {
  code: string;
  details?: unknown;
  message: string;
}

export interface StreamAdapterOptions {
  onWarning?: (warning: StreamAdapterWarning) => void;
}

interface AsyncQueueWaiter<T> {
  reject(error: unknown): void;
  resolve(result: IteratorResult<T>): void;
}

interface TeeBranchState {
  claimed: boolean;
  open: boolean;
  queue: AsyncBroadcastQueue<TuvrenStreamEvent>;
}

interface TextFixtureSet {
  completedTurn: readonly TuvrenStreamEvent[];
  failedTurn: readonly TuvrenStreamEvent[];
  pausedTurn: readonly TuvrenStreamEvent[];
}

class AsyncBroadcastQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private failure?: unknown;
  private readonly items: T[] = [];
  private readonly producerWaiters: Array<() => void> = [];
  private readonly waiters: AsyncQueueWaiter<T>[] = [];

  close(): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.closed = true;
    this.releaseProducerWaiters();

    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({
        done: true,
        value: undefined,
      });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.failure = error;
    this.releaseProducerWaiters();

    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  canAcceptValue(): boolean {
    // Each branch intentionally keeps at most one unread buffered event. That
    // gives claimed-but-not-yet-polled branches a consistent replay point
    // without letting tee fanout drain the upstream handle into an unbounded
    // queue.
    return this.waiters.length > 0 || this.items.length === 0;
  }

  push(value: T): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    if (!this.canAcceptValue()) {
      throw new TuvrenRuntimeError(
        "async broadcast queue received a value without downstream capacity",
        {
          code: "invalid_stream_adapter_state",
        }
      );
    }

    const waiter = this.waiters.shift();

    if (waiter !== undefined) {
      waiter.resolve({
        done: false,
        value,
      });
      return;
    }

    this.items.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          const value = this.items.shift();
          this.releaseProducerWaiter();

          if (value === undefined) {
            return {
              done: true,
              value: undefined,
            };
          }

          return {
            done: false,
            value,
          };
        }

        this.releaseProducerWaiter();

        if (this.failure !== undefined) {
          throw this.failure;
        }

        if (this.closed) {
          return {
            done: true,
            value: undefined,
          };
        }

        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({
            reject,
            resolve,
          });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({
          done: true,
          value: undefined,
        });
      },
    };
  }

  async waitForCapacity(): Promise<void> {
    while (
      !this.closed &&
      this.failure === undefined &&
      !this.canAcceptValue()
    ) {
      await new Promise<void>((resolve) => {
        this.producerWaiters.push(resolve);
      });
    }
  }

  private releaseProducerWaiter(): void {
    this.producerWaiters.shift()?.();
  }

  private releaseProducerWaiters(): void {
    while (this.producerWaiters.length > 0) {
      this.producerWaiters.shift()?.();
    }
  }
}

export function cloneTuvrenStreamEvent(
  event: TuvrenStreamEvent
): TuvrenStreamEvent {
  const clonedEvent = structuredClone(event);
  assertTuvrenStreamEvent(clonedEvent, "cloned stream event");
  return clonedEvent;
}

export function createFixtureStream(
  events: readonly TuvrenStreamEvent[]
): AsyncIterable<TuvrenStreamEvent> {
  // biome-ignore lint/suspicious/useAwait: Async generators must remain async even when fixture production is synchronous.
  return (async function* () {
    for (const event of events) {
      yield cloneTuvrenStreamEvent(event);
    }
  })();
}

export function createStreamAdapterWarningReporter(
  options?: StreamAdapterOptions
): (warning: StreamAdapterWarning) => void {
  const emittedCodes = new Set<string>();

  return (warning) => {
    if (emittedCodes.has(warning.code)) {
      return;
    }

    emittedCodes.add(warning.code);

    if (options?.onWarning === undefined) {
      return;
    }

    try {
      options.onWarning(cloneWarning(warning));
    } catch {
      // Warning observers are non-authoritative. Adapter output must still flow
      // even if a host-side logger or test hook throws.
    }
  };
}

export function serializeTuvrenStreamEvent(event: TuvrenStreamEvent): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (value instanceof Uint8Array) {
      return {
        data: Array.from(value),
        type: UINT8_ARRAY_JSON_MARKER,
      };
    }

    return value;
  });
}

export function teeTuvrenStreamEvents(
  events: AsyncIterable<TuvrenStreamEvent>,
  branchCount: number
): readonly AsyncIterable<TuvrenStreamEvent>[] {
  if (!Number.isInteger(branchCount) || branchCount < 1) {
    throw new TuvrenRuntimeError(
      "teeTuvrenStreamEvents() requires at least one branch",
      {
        code: "invalid_stream_branch_count",
        details: {
          branchCount,
        },
      }
    );
  }

  const sourceIterator = events[Symbol.asyncIterator]();
  // Fanout belongs above the canonical handle stream. Each tee branch still
  // keeps single-consumer semantics so hosts cannot accidentally replay one
  // branch while the source stream remains strictly one-pass. Source reads also
  // follow claimed branch capacity so tee fanout does not silently drain the
  // canonical stream into an unbounded unread buffer.
  const branches: TeeBranchState[] = Array.from(
    { length: branchCount },
    () => ({
      claimed: false,
      open: false,
      queue: new AsyncBroadcastQueue<TuvrenStreamEvent>(),
    })
  );
  let sourceClosed = false;
  let sourceReadStarted = false;
  let sourceStarted = false;
  let sourceReturning = false;

  const closeBranches = () => {
    for (const branch of branches) {
      branch.open = false;
      branch.queue.close();
    }
  };

  const failBranches = (error: unknown) => {
    for (const branch of branches) {
      branch.queue.fail(error);
    }
  };

  const countClaimedOpenBranches = (): number => {
    let openBranchCount = 0;

    for (const branch of branches) {
      if (branch.claimed && branch.open) {
        openBranchCount += 1;
      }
    }

    return openBranchCount;
  };

  const waitForClaimedBranchCapacity = async (): Promise<void> => {
    for (;;) {
      const openBranches = branches.filter(
        (branch) => branch.claimed && branch.open
      );

      if (openBranches.length === 0) {
        return;
      }

      const saturatedBranches = openBranches.filter(
        (branch) => !branch.queue.canAcceptValue()
      );

      if (saturatedBranches.length === 0) {
        return;
      }

      await Promise.race(
        saturatedBranches.map(async (branch) => {
          await branch.queue.waitForCapacity();
        })
      );
    }
  };

  const pumpSource = async (): Promise<void> => {
    try {
      for (;;) {
        await waitForClaimedBranchCapacity();

        if (sourceReturning || countClaimedOpenBranches() === 0) {
          return;
        }

        sourceReadStarted = true;
        const nextEvent = await sourceIterator.next();

        if (nextEvent.done) {
          sourceClosed = true;
          closeBranches();
          return;
        }

        assertTuvrenStreamEvent(nextEvent.value, "tee source event");

        for (const branch of branches) {
          if (!(branch.claimed && branch.open)) {
            continue;
          }

          branch.queue.push(cloneTuvrenStreamEvent(nextEvent.value));
        }
      }
    } catch (error: unknown) {
      sourceClosed = true;
      failBranches(normalizeQueueError(error));
    }
  };

  const ensureSourceStarted = (): void => {
    if (sourceStarted) {
      return;
    }

    sourceStarted = true;
    detachPromise(pumpSource());
  };

  const stopSourceIfNeeded = async (): Promise<void> => {
    if (sourceClosed || sourceReturning || countClaimedOpenBranches() > 0) {
      return;
    }

    sourceReturning = true;

    try {
      await sourceIterator.return?.();
      sourceClosed = true;
      closeBranches();
    } catch (error: unknown) {
      sourceClosed = true;
      failBranches(normalizeQueueError(error));
    }
  };

  return branches.map((branch) => ({
    [Symbol.asyncIterator](): AsyncIterator<TuvrenStreamEvent> {
      if (branch.claimed) {
        throw new TuvrenRuntimeError(
          "tee branch event streams may only be consumed once",
          {
            code: "event_stream_already_consumed",
          }
        );
      }

      // Tee fanout cannot reconstruct the already-consumed prefix for a branch
      // once the source iterator has started advancing without buffering the
      // entire upstream stream. We therefore allow subscriptions during setup
      // but fail any branch that joins after the first upstream read begins.
      if (sourceReadStarted) {
        throw new TuvrenRuntimeError(
          "tee branches must subscribe before source consumption begins",
          {
            code: "event_stream_subscription_too_late",
          }
        );
      }

      branch.claimed = true;
      branch.open = true;

      const iterator = branch.queue[Symbol.asyncIterator]();
      let startedConsumption = false;

      return {
        next: async (): Promise<IteratorResult<TuvrenStreamEvent>> => {
          if (!startedConsumption) {
            startedConsumption = true;
            ensureSourceStarted();
          }

          return await iterator.next();
        },
        return: async (): Promise<IteratorResult<TuvrenStreamEvent>> => {
          branch.open = false;
          const closedResult: IteratorResult<TuvrenStreamEvent> = {
            done: true,
            value: undefined,
          };
          const result: IteratorResult<TuvrenStreamEvent> =
            iterator.return === undefined
              ? closedResult
              : await iterator.return();

          await stopSourceIfNeeded();
          return result;
        },
      };
    },
  }));
}

export const streamAdapterFixtures: TextFixtureSet = {
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
      name: "runner.executed",
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

function cloneWarning(warning: StreamAdapterWarning): StreamAdapterWarning {
  try {
    return structuredClone(warning);
  } catch {
    return {
      code: warning.code,
      message: warning.message,
    };
  }
}

function detachPromise(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function normalizeQueueError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
