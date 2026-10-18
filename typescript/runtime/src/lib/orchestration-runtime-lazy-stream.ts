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

import { AsyncEventQueue, detachPromise } from "./runtime-core-shared.js";

const createIteratorDoneResult = <T>(): IteratorResult<T, undefined> => ({
  done: true,
  value: undefined,
});

/**
 * Builds an `AsyncIterable` that may be claimed by exactly one consumer and
 * defers all side effects (claim, queue creation, `onStart`) to the first
 * `next()` call. Completion, early `return()`, or the queue closing all
 * funnel through a single idempotent `onClose`.
 *
 * @throws {TuvrenRuntimeError} With `input.alreadyConsumedCode` when a second
 *   consumer starts iterating while the stream is already claimed.
 */
export const createSingleConsumerLazyStream = <T>(input: {
  alreadyConsumedCode: string;
  alreadyConsumedMessage: string;
  isClaimed: () => boolean;
  onClaim: () => void;
  onClose: () => Promise<void> | void;
  onStart: (queue: AsyncEventQueue<T>) => void;
}): AsyncIterable<T> => ({
  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    let closed = false;
    let iterator: AsyncIterator<T> | undefined;
    let queue: AsyncEventQueue<T> | undefined;
    let started = false;

    const close = async (): Promise<void> => {
      if (!started || closed) {
        return;
      }

      closed = true;
      await input.onClose();
    };

    const start = (): void => {
      if (started) {
        return;
      }

      if (input.isClaimed()) {
        throw new TuvrenRuntimeError(input.alreadyConsumedMessage, {
          code: input.alreadyConsumedCode,
        });
      }

      try {
        input.onClaim();
        queue = new AsyncEventQueue<T>(() => {
          detachPromise(close());
        });
        iterator = queue[Symbol.asyncIterator]();
        started = true;
        input.onStart(queue);
      } catch (error: unknown) {
        queue?.close();
        throw error;
      }
    };

    return {
      next: async (): Promise<IteratorResult<T, undefined>> => {
        start();

        if (iterator === undefined) {
          return createIteratorDoneResult<T>();
        }

        const nextValue = await iterator.next();

        if (nextValue.done === true) {
          await close();
        }

        return nextValue;
      },
      return: async (): Promise<IteratorResult<T, undefined>> => {
        if (!started || iterator === undefined) {
          return createIteratorDoneResult<T>();
        }

        const result =
          iterator.return === undefined
            ? createIteratorDoneResult<T>()
            : await iterator.return();
        await close();
        return result;
      },
    };
  },
});
