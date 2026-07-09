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

// KRT-BK003 — purge/transact serialization race fix. `MemoryScopeStore`
// previously let `dropScope` unconditionally delete whatever `runExclusive`
// queue entry happened to occupy a Scope's slot, with no check that the entry
// was still the purge's own. A third caller who chained onto the queue after
// the purge's `dropScope()` call but before the purge's own `finally`
// released the gate would see the slot wiped out from under it, read "no
// prior transaction," and run concurrently with the still-in-flight purge —
// bypassing the single-writer-per-scope guarantee the store exists to
// provide.
//
// This exercises `MemoryScopeStore#runExclusive` / `#dropScope` directly
// (the internal serialization primitive), not `MemoryBackend#purgeScope` /
// `#transact` (the black-box behavior `backend-memory.purge-scope.test.ts`
// already covers) — a different, narrower concern. The race is reproduced
// deterministically with manually-controlled deferred promises and
// microtask flushes, never real timers, so it reproduces reliably in CI
// instead of only probabilistically under `setTimeout`/sleep jitter.

import { describe, expect, test } from "bun:test";
import { createMemoryScopeStore } from "@tuvren/backend-memory";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return {
    promise,
    resolve: (value) => settle?.(value),
  };
}

/**
 * Drains the microtask queue, one tick per `await Promise.resolve()`, until
 * `condition` holds or the tick budget runs out. Every hop in this test's
 * race is a chain of native Promises with no timers involved, so repeated
 * microtask ticks advance every pending continuation deterministically —
 * there is nothing to "wait" for beyond letting already-scheduled
 * continuations run.
 */
async function flushMicrotasksUntil(
  condition: () => boolean,
  maxTicks = 200
): Promise<void> {
  for (let tick = 0; tick < maxTicks && !condition(); tick += 1) {
    await Promise.resolve();
  }
}

describe("@tuvren/backend-memory MemoryScopeStore purge/transact serialization (KRT-BK003)", () => {
  test("a transaction queued behind a purge's drop-then-release window never runs concurrently with the purge", async () => {
    const store = createMemoryScopeStore();
    const scope = "tenant-purge-race";
    const orderLog: string[] = [];
    const deferredA = createDeferred<void>();
    const deferredB = createDeferred<void>();

    // Actor A: an in-flight transaction already queued via runExclusive.
    const transactionA = store.runExclusive(scope, () => {
      orderLog.push("A-start");
      return deferredA.promise.then(() => {
        orderLog.push("A-done");
      });
    });

    // Actor B: a concurrent purge, queued immediately behind A (mirrors
    // MemoryBackend#purgeScope, which calls dropScope from inside
    // runExclusive's `work`).
    const transactionB = store.runExclusive(scope, () => {
      store.dropScope(scope);
      orderLog.push("drop-ran");
      return deferredB.promise.then(() => {
        orderLog.push("B-done");
      });
    });

    // A runs first; B must stay queued behind it and not touch the store yet.
    await flushMicrotasksUntil(() => orderLog.includes("A-start"));
    expect(orderLog).toEqual(["A-start"]);

    // Release A. B's runExclusive call is now free to run its `work`
    // (dropScope, then the "drop-ran" marker) and park on deferredB.
    deferredA.resolve();
    await flushMicrotasksUntil(() => orderLog.includes("drop-ran"));
    expect(orderLog).toEqual(["A-start", "A-done", "drop-ran"]);

    // Actor D: a third caller starting a brand-new transaction the instant
    // after B's dropScope() call ran, but before B's runExclusive `finally`
    // releases the queue — exactly the window the bug opened. Kick this off
    // without awaiting it yet: the fixed store must make D wait for B, so
    // awaiting D here (before B is released) would deadlock the test.
    const transactionD = store.runExclusive(scope, () => {
      orderLog.push("D-ran");
      return Promise.resolve();
    });

    // Release B. If the single-writer-per-scope guarantee holds, D is still
    // blocked on B at this point and can only run once B fully completes.
    deferredB.resolve();

    await Promise.all([transactionA, transactionB, transactionD]);

    // The load-bearing assertion: D's entry must land strictly after B's,
    // never interleaved with or ahead of it. Under the pre-fix store, B's
    // dropScope() blindly deletes the queue slot D later reads, so D sees
    // "no prior transaction" and runs immediately — "D-ran" lands before
    // "B-done" and this assertion fails.
    expect(orderLog).toEqual([
      "A-start",
      "A-done",
      "drop-ran",
      "B-done",
      "D-ran",
    ]);
  });
});
