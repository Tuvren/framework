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

/**
 * Shape every protocol adapter implements (framework spec §6.1 "Protocol
 * adapter consumption"): a pure transform from the canonical
 * `TuvrenStreamEvent` stream to an external wire format. Adapters consume
 * `AsyncIterable<TuvrenStreamEvent>` — typically one branch of
 * {@link teeTuvrenStreamEvents} — and never touch the `ExecutionHandle`
 * directly.
 */
export type StreamProtocolAdapter<T> = (
  events: AsyncIterable<TuvrenStreamEvent>
) => AsyncIterable<T>;

/**
 * A non-fatal adapter-level observation, reported through
 * {@link StreamAdapterOptions.onWarning} rather than thrown. `code` is a
 * stable identifier suitable for deduplication (see
 * {@link createStreamAdapterWarningReporter}); `details` carries
 * adapter-specific context.
 */
export interface StreamAdapterWarning {
  code: string;
  details?: unknown;
  message: string;
}

/** Shared adapter construction options accepted by protocol adapters in sibling packages. */
export interface StreamAdapterOptions {
  /** Receives each distinct warning code once per reporter (see {@link createStreamAdapterWarningReporter}). */
  onWarning?: (warning: StreamAdapterWarning) => void;
}

/** A pending `next()` call on an {@link AsyncBroadcastQueue}, settled once a value, close, or failure arrives. */
interface AsyncQueueWaiter<T> {
  reject(error: unknown): void;
  resolve(result: IteratorResult<T>): void;
}

/** Per-branch bookkeeping for {@link teeTuvrenStreamEvents}. */
interface TeeBranchState {
  /** True once the branch's `[Symbol.asyncIterator]()` has been called; a branch may only be claimed once. */
  claimed: boolean;
  /** True while the branch is still eligible to receive events (cleared on `return()` or source close). */
  open: boolean;
  /** Per-branch single-slot buffer feeding this branch's consumer. */
  queue: AsyncBroadcastQueue<TuvrenStreamEvent>;
}

/** Canonical named event sequences exposed as {@link streamAdapterFixtures}. */
interface TextFixtureSet {
  /** A turn that streams assistant text, executes one tool, and completes normally. */
  completedTurn: readonly TuvrenStreamEvent[];
  /** A turn that fails with a fatal error. */
  failedTurn: readonly TuvrenStreamEvent[];
  /** A turn that pauses on a tool approval request. */
  pausedTurn: readonly TuvrenStreamEvent[];
}

/**
 * Single-consumer async queue with exactly one buffered slot, used as the
 * per-branch buffer in {@link teeTuvrenStreamEvents}.
 *
 * {@link canAcceptValue} enforces the one-slot invariant: a branch that has
 * not yet been polled holds at most one unread event, giving a
 * claimed-but-not-yet-polled branch a consistent replay point without
 * letting tee fanout drain the upstream handle into an unbounded queue.
 * `close()` and `fail()` are idempotent and mutually exclusive — the first
 * call wins.
 */
class AsyncBroadcastQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private failure?: unknown;
  private readonly items: T[] = [];
  private readonly producerWaiters: Array<() => void> = [];
  private readonly waiters: AsyncQueueWaiter<T>[] = [];

  /** Marks the queue exhausted; every pending and future `next()` resolves `{ done: true }`. A no-op if already closed or failed. */
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

  /** Marks the queue failed; every pending and future `next()` rejects with `error`. A no-op if already closed or failed. */
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

  /** True when a `push()` can currently be accepted: a consumer is waiting, or the one-slot buffer is empty. */
  canAcceptValue(): boolean {
    // Each branch intentionally keeps at most one unread buffered event. That
    // gives claimed-but-not-yet-polled branches a consistent replay point
    // without letting tee fanout drain the upstream handle into an unbounded
    // queue.
    return this.waiters.length > 0 || this.items.length === 0;
  }

  /**
   * Delivers `value` to a waiting consumer, or buffers it in the single slot.
   * Silently dropped if the queue is already closed or failed.
   *
   * @throws TuvrenRuntimeError with code `invalid_stream_adapter_state` if
   *   called when {@link canAcceptValue} is `false` — callers must check
   *   capacity (e.g. via `waitForCapacity`) before pushing.
   */
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

  /** Resolves once {@link canAcceptValue} is true (or the queue closes/fails), for producers to await before pushing. */
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

/**
 * Deep-clones a `TuvrenStreamEvent` (via `structuredClone`) and re-validates
 * the clone, so a tee branch or fixture consumer cannot observe another
 * consumer's mutations to the same logical event.
 *
 * @throws If the cloned value somehow fails `assertTuvrenStreamEvent`
 *   (defensive; a valid input event always produces a valid clone).
 */
export function cloneTuvrenStreamEvent(
  event: TuvrenStreamEvent
): TuvrenStreamEvent {
  const clonedEvent = structuredClone(event);
  assertTuvrenStreamEvent(clonedEvent, "cloned stream event");
  return clonedEvent;
}

/**
 * Wraps a fixed event list as a fresh, one-pass `AsyncIterable`, cloning each
 * event on yield so repeated iterations (or fixtures shared across tests)
 * never alias mutable state.
 */
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

/**
 * Builds a warning callback that de-duplicates by `code`: each distinct
 * `warning.code` is forwarded to `options.onWarning` at most once per
 * reporter instance, and a throwing `onWarning` is swallowed — warning
 * observers are non-authoritative, so adapter output must keep flowing even
 * if a host-side logger or test hook throws.
 *
 * @param options.onWarning - Sink invoked with a cloned warning (see
 *   {@link cloneWarning}) the first time each code is reported; omit to
 *   silently discard warnings while still deduplicating.
 */
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

/**
 * Serializes a `TuvrenStreamEvent` to JSON, encoding any `Uint8Array` field
 * (e.g. binary `file.done` payloads) as `{ type: "Uint8Array", data: number[] }`
 * so binary content survives a JSON round-trip.
 */
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

/**
 * Fans a single-consumer `TuvrenStreamEvent` stream out to `branchCount`
 * independent, single-consumer branches (framework spec §6.1: "Hosts that
 * need multiple downstream consumers own teeing, multicast, filtering,
 * buffering, replay, and backpressure policy outside shared core").
 *
 * Source pulls are lazy and demand-driven: the upstream `events` iterator is
 * not read until the first branch begins consumption, and each subsequent
 * pull waits for every still-claimed, still-open branch to have buffer
 * capacity (backpressure across all branches, not just the slowest). Once
 * every claimed branch has closed (or none were ever claimed after the
 * source has already been read from), the source iterator's `return()` is
 * called to release its resources.
 *
 * Two invariants are enforced per branch, both throwing
 * `TuvrenRuntimeError`:
 *
 * - **Claim-before-first-pull**: a branch's `[Symbol.asyncIterator]()` must
 *   be called before the source's first `next()` call begins, or it throws
 *   with code `event_stream_subscription_too_late` — tee fanout cannot
 *   reconstruct an already-consumed prefix for a late joiner without
 *   buffering the entire upstream stream.
 * - **Single consumption**: a branch may only be iterated once; a second
 *   `[Symbol.asyncIterator]()` call throws with code
 *   `event_stream_already_consumed`.
 *
 * A source failure propagates to every still-open branch via `queue.fail`,
 * normalized to an `Error` first.
 *
 * @param branchCount - Number of independent branches to produce; must be a
 *   positive integer.
 * @returns Exactly `branchCount` async iterables, each a single-consumer view
 *   of the same underlying event sequence.
 * @throws TuvrenRuntimeError with code `invalid_stream_branch_count` when
 *   `branchCount` is not a positive integer.
 */
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

  /** Marks every branch closed (source exhausted). */
  const closeBranches = () => {
    for (const branch of branches) {
      branch.open = false;
      branch.queue.close();
    }
  };

  /** Propagates a source failure to every branch's queue. */
  const failBranches = (error: unknown) => {
    for (const branch of branches) {
      branch.queue.fail(error);
    }
  };

  /** Number of branches that are both claimed and still open — the demand signal driving source pulls. */
  const countClaimedOpenBranches = (): number => {
    let openBranchCount = 0;

    for (const branch of branches) {
      if (branch.claimed && branch.open) {
        openBranchCount += 1;
      }
    }

    return openBranchCount;
  };

  /**
   * Waits until every claimed, open branch has buffer capacity, so the next
   * source pull cannot overrun a slow branch's single-slot queue. Resolves
   * immediately once there are no claimed-open branches left.
   */
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

  /**
   * The single background loop that reads the upstream `events` iterator and
   * broadcasts each event to every claimed, open branch. Started at most
   * once (guarded by {@link ensureSourceStarted}); stops when the source
   * completes, every branch closes, or the source throws (in which case the
   * error is normalized and delivered to every branch instead of being
   * thrown from this loop).
   */
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

  /** Starts {@link pumpSource} on the first branch's first `next()` call; idempotent thereafter. */
  const ensureSourceStarted = (): void => {
    if (sourceStarted) {
      return;
    }

    sourceStarted = true;
    detachPromise(pumpSource());
  };

  /**
   * Calls `sourceIterator.return()` once no claimed branch remains open,
   * releasing the upstream resource early instead of waiting for it to
   * exhaust on its own. A no-op if the source already closed, is already
   * returning, or a claimed branch is still open.
   */
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

/**
 * Canonical `TuvrenStreamEvent` sequences for adapter and conformance tests:
 * a normal completed turn (assistant text plus one tool call), a fatally
 * failed turn, and a turn paused on tool approval. Consume through
 * {@link createFixtureStream} rather than iterating the arrays directly, so
 * events are cloned per use.
 */
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

/**
 * Deep-clones a warning for delivery to `onWarning`; falls back to a
 * code/message-only copy (dropping `details`) if `details` is not
 * structured-cloneable, so a non-cloneable detail payload never breaks
 * warning delivery entirely.
 */
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

/** Fires `promise` without awaiting it, swallowing any rejection (background pump loops are not awaited by callers). */
function detachPromise(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

/** Normalizes a thrown value from the source iterator to an `Error` before delivering it to branch queues. */
function normalizeQueueError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
