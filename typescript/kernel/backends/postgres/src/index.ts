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
 * PostgreSQL-backed persistent backend for the Tuvren kernel.
 *
 * {@link createPostgresBackend} builds a `RuntimeBackend` that persists all
 * durable state in a PostgreSQL database, one row-level-isolated snapshot
 * per Scope (ADR-049). Unlike the SQLite backend's relational schema, the
 * whole `BackendState` for a Scope is kept as a single deterministic-CBOR
 * blob in `backend_postgres_snapshots`; a transaction loads that snapshot
 * under `SELECT ... FOR UPDATE`, mutates an in-memory copy-on-write draft
 * using the same invariant logic as the memory backend, then re-encodes and
 * writes the whole snapshot back. {@link destroyPostgresBackend} drops a
 * throwaway schema entirely, for test/conformance teardown.
 *
 * @packageDocumentation
 */

export type { PostgresBackendOptions } from "./lib/postgres-backend.js";
// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export {
  createPostgresBackend,
  destroyPostgresBackend,
} from "./lib/postgres-backend.js";
// Issue #108 M3: `SnapshotCacheObserver` is the non-public-surface testkit
// seam `PostgresBackendOptions.snapshotCacheObserver` accepts to observe the
// single-entry content-hash memo's hit/miss behavior. Exported as a type
// only (never constructed by this package) so a bench/test can type-check
// the observer it hands to `createPostgresBackend` without a deep import.
export type { SnapshotCacheObserver } from "./lib/postgres-backend-snapshot-cache.js";
