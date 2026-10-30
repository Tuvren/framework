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

import {
  assertKernelRecord,
  isTuvrenErrorCode,
  TuvrenRuntimeError,
} from "@tuvren/core";
import type {
  TuvrenErrorProjection,
  TuvrenStreamEvent,
} from "@tuvren/core/events";
import { assertTuvrenStreamEvent } from "@tuvren/core/events";
import type { ExecutionStatus, InputSignal } from "@tuvren/core/execution";
import { assertTuvrenMessage } from "@tuvren/core/messages";

/**
 * Unbounded FIFO queue that bridges a push-based producer to async-iterator
 * consumers.
 *
 * Items pushed while a consumer awaits `next()` are handed to the oldest
 * waiter directly; otherwise they are buffered until consumed. Closing the
 * queue resolves all pending waiters with `done: true`, drops subsequent
 * pushes, and invokes the optional `onClose` callback exactly once. An early
 * consumer exit (`return()`, e.g. a `break` out of `for await`) also closes
 * the queue.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private readonly items: { value: T }[] = [];
  private onClose?: () => void;
  private readonly waiters: ((value: IteratorResult<T>) => void)[] = [];

  /**
   * @param onClose - Invoked once when the queue is closed, whether by
   *   {@link AsyncEventQueue.close} or by a consumer's early `return()`.
   */
  constructor(onClose?: () => void) {
    this.onClose = onClose;
  }

  /**
   * Closes the queue: resolves every pending waiter with `done: true` and
   * fires `onClose`. Idempotent; already-buffered items remain readable by
   * subsequent `next()` calls.
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }

    this.onClose?.();
    this.onClose = undefined;
  }

  /**
   * Enqueues an item, delivering it immediately to the oldest pending waiter
   * when one exists. Silently dropped after the queue is closed.
   */
  push(item: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();

    if (waiter !== undefined) {
      waiter({ done: false, value: item });
      return;
    }

    this.items.push({
      value: item,
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          const nextItem = this.items.shift();

          if (nextItem === undefined) {
            return {
              done: true,
              value: undefined,
            };
          }

          return {
            done: false,
            value: nextItem.value,
          };
        }

        if (this.closed) {
          return {
            done: true,
            value: undefined,
          };
        }

        const { promise, resolve } = Promise.withResolvers<IteratorResult<T>>();
        this.waiters.push(resolve);
        return await promise;
      },
      return: async (): Promise<IteratorResult<T>> => {
        if (this.closed) {
          return {
            done: true,
            value: undefined,
          };
        }

        const { promise, resolve } = Promise.withResolvers<IteratorResult<T>>();
        this.waiters.push(resolve);
        this.close();
        return await promise;
      },
    };
  }
}

/**
 * Deep-clones a value with `structuredClone`. Functions are not cloneable
 * here — use {@link cloneSnapshotPreservingFunctions} for values that carry
 * function members.
 */
export const cloneValue = <T>(value: T): T => globalThis.structuredClone(value);

/**
 * Deep-copies an {@link ExecutionStatus} so callers can hold or mutate the
 * snapshot without observing later runtime updates; the `approval` and
 * `manifest` members are structured-cloned.
 */
export const cloneExecutionStatus = (
  status: ExecutionStatus
): ExecutionStatus => ({
  activeAgent: status.activeAgent,
  approval: cloneValue(status.approval),
  iterationCount: status.iterationCount,
  manifest: cloneValue(status.manifest),
  pauseReason: status.pauseReason,
  phase: status.phase,
});

/**
 * Creates a deferred: a promise together with its externally callable
 * `resolve`. Calls to `resolve` after the first are no-ops (standard promise
 * semantics); there is deliberately no reject channel.
 */
export const createDeferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<T>();

  return {
    promise,
    resolve(value: T) {
      resolvePromise(value);
    },
  };
};

const cloneObjectPreservingFunctions = (
  value: object,
  seen: Map<object, unknown>,
  cloneNestedValue: (value: unknown, seen: Map<object, unknown>) => unknown
): object => {
  const clone: Record<PropertyKey, unknown> = {};
  const prototype: unknown = Object.getPrototypeOf(value);

  if (
    prototype !== null &&
    typeof prototype !== "object" &&
    typeof prototype !== "function"
  ) {
    throw new TypeError("object prototype must be an object or null");
  }

  Object.setPrototypeOf(clone, prototype);
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined) {
      continue;
    }

    if ("value" in descriptor) {
      const descriptorValue: unknown = descriptor.value;
      descriptor.value = cloneNestedValue(descriptorValue, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone;
};

/**
 * Recursive worker behind {@link cloneSnapshotPreservingFunctions} and
 * {@link createFrozenSnapshot}.
 *
 * Primitives and functions are returned as-is; `Uint8Array` is byte-copied
 * while other ArrayBuffer views are kept by reference; `Date`, `Map`, `Set`,
 * and arrays are rebuilt; objects are recreated with their original
 * prototype and per-property descriptors (cloning descriptor values,
 * preserving getters/setters). The `seen` map short-circuits cycles and
 * shared references among arrays and plain objects so the clone mirrors the
 * source's object graph.
 */
function cloneValuePreservingFunctions<T>(
  value: T,
  seen?: Map<object, unknown>
): T;
function cloneValuePreservingFunctions(
  value: unknown,
  seen = new Map<object, unknown>()
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value);
  }

  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);

    for (const [key, entry] of value.entries()) {
      clone.set(
        cloneValuePreservingFunctions(key, seen),
        cloneValuePreservingFunctions(entry, seen)
      );
    }

    return clone;
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);

    for (const entry of value.values()) {
      clone.add(cloneValuePreservingFunctions(entry, seen));
    }

    return clone;
  }

  const existing = seen.get(value);

  if (existing !== undefined) {
    return existing;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);

    for (const entry of value) {
      clone.push(cloneValuePreservingFunctions(entry, seen));
    }

    return clone;
  }

  return cloneObjectPreservingFunctions(
    value,
    seen,
    cloneValuePreservingFunctions
  );
}

/**
 * Deep-clones a value while keeping function values (and non-Uint8Array
 * ArrayBuffer views) by reference, preserving prototypes, property
 * descriptors, and cyclic references. `Uint8Array`, `Date`, `Map`, `Set`,
 * arrays, and plain/prototyped objects are copied.
 */
export const cloneSnapshotPreservingFunctions = <T>(value: T): T =>
  cloneValuePreservingFunctions(value);

/**
 * Recursively `Object.freeze`s a value graph, tolerating cycles via `seen`.
 *
 * ArrayBuffer views are returned unfrozen (typed arrays with elements cannot
 * be frozen), and
 * `Map`/`Set` containers have their keys/entries frozen but are not frozen
 * themselves so their internal slots keep working; every other object and
 * array is frozen after its own-property values are.
 */
const freezeSnapshot = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      freezeSnapshot(entry, seen);
    }
  } else if (value instanceof Map) {
    for (const [key, entry] of value.entries()) {
      freezeSnapshot(key, seen);
      freezeSnapshot(entry, seen);
    }

    return value;
  } else if (value instanceof Set) {
    for (const entry of value.values()) {
      freezeSnapshot(entry, seen);
    }

    return value;
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor !== undefined && "value" in descriptor) {
        freezeSnapshot(descriptor.value, seen);
      }
    }
  }

  return Object.freeze(value);
};

/**
 * Deep-clones a value (preserving functions by reference, as in
 * {@link cloneSnapshotPreservingFunctions}) and then deep-freezes the clone,
 * yielding an immutable snapshot safe to share with runners and extensions.
 * `Map`/`Set` containers and ArrayBuffer views are traversed but not frozen
 * themselves; see the non-exported `freezeSnapshot` for details.
 */
export const createFrozenSnapshot = <T>(value: T): T =>
  freezeSnapshot(cloneValuePreservingFunctions(value));

const detachedRejectionObservers = new WeakSet<Promise<void>>();

/**
 * Detaches a promise from the caller's control flow, swallowing its
 * rejection solely to prevent an unhandled-rejection crash. This is NOT an
 * error-handling mechanism: the detached task must route its own errors
 * (log, telemetry signal, state transition) before this boundary, because
 * any rejection reaching here is silently discarded.
 */
export const detachPromise = (task: Promise<unknown>): void => {
  const ignoreRejection = async (): Promise<void> => {
    try {
      await task;
    } catch {
      // The task owns error reporting before reaching this boundary.
    }
  };

  detachedRejectionObservers.add(ignoreRejection());
};

/**
 * Creates the canonical cancellation error with code
 * `runtime_execution_cancelled`, used when an execution is cancelled by the
 * caller rather than failing on its own.
 */
export const createExecutionCancelledError = (): TuvrenRuntimeError =>
  new TuvrenRuntimeError("execution cancelled", {
    code: "runtime_execution_cancelled",
  });

/**
 * Coerces an arbitrary thrown value into an `Error`, wrapping non-Error
 * values in `new Error(String(value))`.
 */
export const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Type guard for a non-null, non-array object usable as a string-keyed
 * record.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Returns a clone of error details only when they validate as a kernel
 * record; anything else (including values that fail to clone) becomes
 * `undefined`.
 */
const sanitizeErrorDetails = (details: unknown): unknown => {
  if (details === undefined) {
    return undefined;
  }

  try {
    assertKernelRecord(details, "error details");
    return cloneValue(details);
  } catch {
    return undefined;
  }
};

/**
 * Projects an `Error` into the stream-facing {@link TuvrenErrorProjection}:
 * `message` always, `code` when the error carries a string `code`, and
 * `details` only when the error's `details` validate as a kernel record
 * (otherwise they are dropped rather than leaking arbitrary values).
 */
export const projectError = (error: Error): TuvrenErrorProjection => {
  const errorRecord = isRecord(error) ? error : undefined;

  return {
    code:
      errorRecord !== undefined && typeof errorRecord.code === "string"
        ? errorRecord.code
        : undefined,
    details:
      errorRecord === undefined
        ? undefined
        : sanitizeErrorDetails(errorRecord.details),
    message: error.message,
  };
};

/**
 * Converts a projection to a runtime error, falling back to `execution_failed`
 * for an absent or non-snake_case code (KrakenFrameworkSpecification §7.1).
 */
export const projectionToError = (
  projection: TuvrenErrorProjection | undefined
): TuvrenRuntimeError =>
  new TuvrenRuntimeError(projection?.message ?? "Execution failed", {
    code: isTuvrenErrorCode(projection?.code)
      ? projection.code
      : "execution_failed",
    ...(projection?.details === undefined
      ? {}
      : { details: projection.details }),
  });

/**
 * Normalizes an {@link InputSignal} by deep-cloning its parts and validating
 * that they form a well-formed user message.
 *
 * @param label - Name used in the message-validation error.
 * @returns A new signal containing the cloned, validated parts.
 * @throws {TuvrenRuntimeError} With code `invalid_input_signal` when the parts
 *   do not normalize to a user-role message; the underlying message
 *   assertion throws for structurally invalid parts.
 */
export const normalizeInputSignal = (
  signal: InputSignal,
  label: string
): InputSignal => {
  const candidateMessage: unknown = {
    ...(signal.admissionKey === undefined
      ? {}
      : { admissionKey: signal.admissionKey }),
    parts: cloneValue(signal.parts),
    role: "user",
  };
  assertTuvrenMessage(candidateMessage, label);

  if (candidateMessage.role !== "user") {
    throw new TuvrenRuntimeError(
      "input signals must normalize to user messages",
      {
        code: "invalid_input_signal",
      }
    );
  }

  return {
    ...(candidateMessage.admissionKey === undefined
      ? {}
      : { admissionKey: candidateMessage.admissionKey }),
    parts: candidateMessage.parts,
  };
};

/**
 * Returns the event without its `source` attribution (or the event itself
 * when it carries none), revalidating the stripped shape before returning.
 */
export const stripEventSource = (
  event: TuvrenStreamEvent
): TuvrenStreamEvent => {
  if (event.source === undefined) {
    return event;
  }

  const { source: _source, ...rest } = event;
  assertTuvrenStreamEvent(rest, "stream event without source");
  return rest;
};
