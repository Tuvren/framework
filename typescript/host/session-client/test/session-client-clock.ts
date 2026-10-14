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

import type { SessionClientClock } from "../src/index.js";

export class FakeClock implements SessionClientClock {
  private nextHandle = 1;
  private readonly pending = new Map<
    number,
    { callback: () => void; ms: number }
  >();

  scheduleTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, { callback, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.pending.delete(handle);
    }
  }

  /** Fires every currently-pending timer whose delay is `<= ms`, in insertion order. */
  advance(ms: number): void {
    const due = [...this.pending.entries()]
      .filter(([, entry]) => entry.ms <= ms)
      .toSorted((a, b) => a[0] - b[0]);
    for (const [handle, entry] of due) {
      this.pending.delete(handle);
      entry.callback();
    }
  }

  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }
}
