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

import { createHash } from "node:crypto";
import type { BackendState } from "./memory-backend-types.js";

/**
 * Issue #108 M3 (`A3` content-hash memoization): a single-entry, per-instance
 * memo of `{ hash of the last snapshot_cbor bytes this instance itself
 * committed or decoded, that snapshot's already-decoded BackendState }`.
 *
 * The Git-native principle this realizes: trust a hash you have already
 * seen. `loadPersistedStateForUpdate` still always runs `SELECT ... FOR
 * UPDATE` (the row lock and `schema_version` check are untouched) but, once
 * it has the row's raw bytes in hand, hashes them and asks this cache
 * whether it already knows the decoded state for exactly those bytes before
 * paying for a full `decodeSnapshot`. A hit is only possible when nothing
 * else wrote a different snapshot to this Scope's row since this instance
 * last saw it — a different writer's bytes hash differently and fall
 * straight through to a full decode, which also refreshes the memo.
 *
 * Single-entry by design (issue #108 M3 brief): one `PostgresBackend`
 * instance is bound to exactly one Scope (ADR-048/ADR-049), so it only ever
 * has one row worth remembering.
 */
export interface SnapshotStateCache {
  /** Drops the memoized entry, e.g. after {@link deletePersistedStateSnapshot} makes it meaningless. */
  clear(): void;
  /** Returns the memoized state when `hashHex` matches the memoized hash, else `undefined`. */
  get(hashHex: string): BackendState | undefined;
  /** Overwrites the single memoized entry. */
  set(hashHex: string, state: BackendState): void;
}

/**
 * Testkit-only, non-public seam a bench or test can inject at backend
 * construction (`PostgresBackendOptions.snapshotCacheObserver`) to count the
 * {@link SnapshotStateCache}'s hits and misses. Intentionally not part of
 * the public `RuntimeBackend` surface — production callers never supply
 * one, and its absence costs nothing beyond an `undefined` check per load.
 */
export interface SnapshotCacheObserver {
  /** Called when a load's hash matched the memoized entry and decoding was skipped. */
  recordHit(): void;
  /** Called when a load's hash did not match (or nothing was memoized yet) and a full decode ran. */
  recordMiss(): void;
}

/** Creates a fresh, empty {@link SnapshotStateCache}. */
export function createSnapshotStateCache(): SnapshotStateCache {
  let entry: { hashHex: string; state: BackendState } | undefined;

  return {
    clear(): void {
      entry = undefined;
    },
    get(hashHex: string): BackendState | undefined {
      return entry !== undefined && entry.hashHex === hashHex
        ? entry.state
        : undefined;
    },
    set(hashHex: string, state: BackendState): void {
      entry = { hashHex, state };
    },
  };
}

/**
 * Lowercase hex SHA-256 digest of `bytes`, computed with `node:crypto`
 * (synchronous — this runs on the postgres backend's hot load/write path,
 * so it deliberately avoids the async WebCrypto round trip the
 * kernel-protocol `hashOpaqueObjectBytes` helper uses for content-addressed
 * Object identity). This digest is purely an internal cache-validity key
 * for {@link SnapshotStateCache}: it is never persisted, never compared
 * across processes, and unrelated to any ADR-008 canonical content-address.
 */
export function hashSnapshotBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
