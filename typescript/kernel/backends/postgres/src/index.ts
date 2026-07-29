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
 * durable state in a PostgreSQL database as a relational, row-per-record
 * schema (ADR-067 / issue #110): one table per record family, one row per
 * item, foreign keys deferred until commit, and Scope isolation via a
 * `scope` column on every key (ADR-048/049 row-level isolation in a shared
 * host schema). Transactions apply targeted SQL for only the rows they
 * touch and re-validate the write set before `COMMIT`.
 * {@link destroyPostgresBackend} drops a throwaway schema entirely, for
 * test/conformance teardown.
 *
 * Opening a pre-#110 database that still has the legacy
 * `backend_postgres_snapshots` blob table explodes each Scope into family
 * rows once and retires the blob table.
 *
 * @packageDocumentation
 */

export type { PostgresBackendOptions } from "./lib/postgres-backend.js";
// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export {
  createPostgresBackend,
  destroyPostgresBackend,
} from "./lib/postgres-backend.js";
