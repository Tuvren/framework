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
import type { BackendState } from "./postgres-records.js";

/**
 * Issue #108 M3 (`A3` content-hash memoization): a single-entry, per-instance
 * memo of `{ hash of the last snapshot_cbor bytes this instance itself
 * committed or decoded, that snapshot's already-decoded BackendState }`.
 *
 * The Git-native principle this realized: trust a hash you have already
 * seen. The blob-era load path (`loadPersistedStateForUpdate`, removed with
 * issue #110's relational redesign) hashed the loaded row bytes and asked
 * this cache whether it already knew the decoded state for exactly those
 * bytes before paying for a full `decodeSnapshot`. The relational write
 * path no longer consults it; the module survives only to type the
 * deprecated `snapshotCacheObserver` construction option.
 *
 * Single-entry by design (issue #108 M3 brief): one `PostgresBackend`
 * instance is bound to exactly one Scope (ADR-048/ADR-049), so it only ever
 * has one row worth remembering.
 */
export interface SnapshotStateCache {
  /** Drops the memoized entry, e.g. after the Scope's rows are purged. */
  clear(): void;
  /** Returns the memoized state when `hashHex` matches the memoized hash, else `undefined`. */
  get(hashHex: string): BackendState | undefined;
  /** Overwrites the single memoized entry. */
  set(hashHex: string, state: BackendState): void;
}

/**
 * Construction-time observability seam a bench or test can inject
 * (`PostgresBackendOptions.snapshotCacheObserver`) to count the {@link
 * SnapshotStateCache}'s hits and misses. It is a real option on
 * `PostgresBackendOptions`, deliberately kept outside the operational
 * `RuntimeBackend` contract rather than hidden from TypeScript, so it is
 * intended for benches, tests, and diagnostics rather than production call
 * sites. Supplying it in production is harmless (observation only, no
 * behavior or persisted-bytes change), and its absence costs nothing beyond
 * an `undefined` check per load.
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
