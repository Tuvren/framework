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
 * SQLite-backed persistent backend for the Tuvren kernel.
 *
 * {@link createSqliteBackend} builds a `RuntimeBackend` that persists all
 * durable state in a WAL-mode SQLite database file, one file per Scope
 * (ADR-049 file-per-scope isolation). It is the embedded single-writer
 * persistence baseline: transactions serialize on a single connection under
 * `BEGIN IMMEDIATE`, checked-in migrations govern the schema, write-time
 * invariants run inside the repositories, and each transaction's write set is
 * re-validated against the database before commit.
 *
 * @packageDocumentation
 */

export type { SqliteBackendOptions } from "./lib/sqlite-backend.js";
// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export { createSqliteBackend } from "./lib/sqlite-backend.js";
