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

import { assertKernelRecord, TuvrenRuntimeError } from "@tuvren/core-types";
import type {
  ExecutionStatus,
  InputSignal,
  TuvrenErrorProjection,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import {
  assertTuvrenMessage,
  assertTuvrenStreamEvent,
} from "@tuvren/runtime-api";

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private readonly items: Array<{ value: T }> = [];
  private onClose?: () => void;
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];

  constructor(onClose?: () => void) {
    this.onClose = onClose;
  }

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

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
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
}

export function cloneExecutionStatus(status: ExecutionStatus): ExecutionStatus {
  return {
    activeAgent: status.activeAgent,
    approval: cloneValue(status.approval),
    iterationCount: status.iterationCount,
    manifest: cloneValue(status.manifest),
    pauseReason: status.pauseReason,
    phase: status.phase,
  };
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });

  return {
    promise,
    resolve(value: T) {
      resolveValue?.(value);
    },
  };
}

export function cloneValue<T>(value: T): T {
  return globalThis.structuredClone(value);
}

export function cloneSnapshotPreservingFunctions<T>(value: T): T {
  return cloneValuePreservingFunctions(value);
}

export function createFrozenSnapshot<T>(value: T): T {
  return freezeSnapshot(cloneValuePreservingFunctions(value));
}

export function detachPromise(task: Promise<unknown>): void {
  task.catch(() => undefined);
}

export function createExecutionCancelledError(): TuvrenRuntimeError {
  return new TuvrenRuntimeError("execution cancelled", {
    code: "runtime_execution_cancelled",
  });
}

export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function projectError(error: Error): TuvrenErrorProjection {
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
}

export function normalizeInputSignal(
  signal: InputSignal,
  label: string
): InputSignal {
  const candidateMessage: unknown = {
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
    parts: candidateMessage.parts,
  };
}

function sanitizeErrorDetails(details: unknown): unknown {
  if (details === undefined) {
    return undefined;
  }

  try {
    assertKernelRecord(details, "error details");
    return cloneValue(details);
  } catch {
    return undefined;
  }
}

function cloneValuePreservingFunctions<T>(
  value: T,
  seen = new Map<object, unknown>()
): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return value.slice() as T;
  }

  if (ArrayBuffer.isView(value)) {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
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

    return clone as T;
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);

    for (const entry of value.values()) {
      clone.add(cloneValuePreservingFunctions(entry, seen));
    }

    return clone as T;
  }

  const existing = seen.get(value);

  if (existing !== undefined) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);

    for (const entry of value) {
      clone.push(cloneValuePreservingFunctions(entry, seen));
    }

    return clone as T;
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<
    PropertyKey,
    unknown
  >;
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined) {
      continue;
    }

    if ("value" in descriptor) {
      descriptor.value = cloneValuePreservingFunctions(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone as T;
}

function freezeSnapshot<T>(value: T, seen = new Set<object>()): T {
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
}

export function stripEventSource(event: TuvrenStreamEvent): TuvrenStreamEvent {
  if (event.source === undefined) {
    return event;
  }

  const { source: _source, ...rest } = event;
  assertTuvrenStreamEvent(rest, "stream event without source");
  return rest;
}
