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

/**
 * True when the value is an enforceable timeout: defined, finite, and
 * strictly positive. Anything else means "no timeout".
 */
function hasTimeout(timeoutMilliseconds: number | undefined): boolean {
  return (
    timeoutMilliseconds !== undefined &&
    Number.isFinite(timeoutMilliseconds) &&
    timeoutMilliseconds > 0
  );
}

/**
 * Runs an action with an optional wall-clock timeout, used for tool
 * `execute` calls and `aroundTool` handler invocations in the tool-execution
 * gateway as well as extension hook invocations in extension-runtime.ts.
 *
 * When `timeoutMilliseconds` is undefined, non-finite, or not positive, the
 * action runs unbounded. Otherwise the action races a timer: on expiry,
 * `options.onTimeout` fires first with the created error (callers use it to
 * abort the signal handed to the action) and the returned promise then
 * rejects with that error. The race does not cancel the underlying action by
 * itself — cooperative cancellation happens only through the caller's
 * `onTimeout` abort. The timer is always cleared, win or lose.
 *
 * @param action - Work to run; may be synchronous or promise-returning.
 * @param timeoutMilliseconds - Timeout budget; see above for the values that
 *   disable it.
 * @param createTimeoutError - Factory for the rejection error, invoked only
 *   on expiry so messages can embed call-specific context.
 * @param options - Optional `onTimeout` hook invoked with the created error
 *   before rejection.
 * @returns The action's result when it settles before the deadline.
 * @throws The `createTimeoutError()` error on expiry, or whatever the action
 *   itself rejects with.
 */
export async function runWithTimeout<T>(
  action: () => Promise<T> | T,
  timeoutMilliseconds: number | undefined,
  createTimeoutError: () => Error,
  options?: {
    onTimeout?(error: Error): void;
  }
): Promise<T> {
  if (!hasTimeout(timeoutMilliseconds)) {
    return await action();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = createTimeoutError();
      options?.onTimeout?.(timeoutError);
      reject(timeoutError);
    }, timeoutMilliseconds);
  });

  try {
    return await Promise.race([Promise.resolve(action()), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
