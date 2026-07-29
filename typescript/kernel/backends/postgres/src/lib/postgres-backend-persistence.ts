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

import type { PhaseObserver } from "@tuvren/backend-shared";
import type { EpochMs, Scope } from "@tuvren/core";
import postgres, { type Sql } from "postgres";
import { persistenceError } from "./postgres-errors.js";

/**
 * Backend-owned schema name used when a host does not supply one (ADR-067 /
 * issue #110). See {@link normalizeSchemaName} for why this can never be
 * `"public"`.
 */
const DEFAULT_SCHEMA_NAME = "tuvren_kernel";
const VALID_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Connection and partition options for the PostgreSQL backend's persistence layer. */
export interface PostgresBackendPersistenceOptions {
  connectionString?: string;
  database?: string;
  host?: string;
  now?: () => EpochMs;
  password?: string;
  /**
   * Phase-attribution seam (issue #108) for the relational persistence
   * path's per-transaction costs (ADR-067), sharing the same
   * {@link PersistencePhase} vocabulary as the SQLite backend: `lock-wait`
   * covers both waiting on the in-process transaction queue and waiting on
   * the database-level same-scope advisory lock (there are no row locks to
   * wait on here — Postgres's MVCC readers never block on a writer); `load`
   * is the maintenance-path cost of reading a record family's rows into an
   * in-memory projection; the four named `validate-*` phases
   * (`validate-loaded`, `validate-lineage-index`, `validate-committed`,
   * `validate-write-set`) and `validate-reclaim-survivors` are the distinct
   * validation passes `loadValidatedState`, `transact`, and `reclaim` each
   * run, not one undifferentiated `validate` phase; and `write` covers both
   * `COMMIT` on the transaction path and the maintenance paths' bulk row
   * deletions. A one-time `blob-migration` phase also reports the cost of
   * exploding a legacy blob-per-scope snapshot into its relational rows the
   * first time a pre-#110 schema is opened. Defaults to
   * {@link NOOP_PHASE_OBSERVER}, so omitting it costs one shared frozen no-op
   * call per phase and never changes measured production bytes or behavior.
   * Benches/tests supply a recording observer instead.
   */
  phaseObserver?: PhaseObserver;
  port?: number;
  schemaName?: string;
  /**
   * Host-supplied partition identity bound at construction (ADR-048).
   *
   * Isolation is realized as a `scope` column on every family table's primary
   * and foreign keys (ADR-067's one-table-per-record-family relational
   * schema), giving row-level isolation in a shared schema (ADR-049). Two
   * backends sharing a schema (the same database) but bound to different
   * Scopes therefore read and write disjoint rows across every table and can
   * never observe each other's state, with no cross-scope dedup. When
   * omitted, the backend binds the default Scope, so existing single-scope
   * databases keep working unchanged. Must be a non-empty string.
   */
  scope?: Scope;
  username?: string;
}

/**
 * Creates a `postgres` client configured for single-connection,
 * non-prepared-statement use (`max: 1`, `prepare: false`). Prefers
 * `options.connectionString` when set, otherwise builds the connection from
 * the discrete fields.
 *
 * `max: 1` is load-bearing: the backend's in-process transaction queue
 * (ADR-067) already serializes every `transact`/`reclaim` call onto a single
 * logical writer, so a single physical connection is enough and avoids paying
 * for a pool the backend never uses concurrently. `prepare: false` keeps the
 * client compatible with transaction-mode connection poolers (which cannot
 * hold named prepared statements across pooled connections) and avoids
 * accumulating named-statement state on the one connection. Prepared
 * statements remain a candidate optimization if per-statement query planning
 * ever shows up as a bottleneck in write benches.
 */
export function createPostgresClient(
  options: PostgresBackendPersistenceOptions
): Sql {
  const configuration = {
    connect_timeout: 5,
    database: options.database,
    host: options.host,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    password: options.password,
    port: options.port,
    prepare: false,
    username: options.username,
  };

  if (options.connectionString !== undefined) {
    return postgres(options.connectionString, configuration);
  }

  return postgres(configuration);
}

/**
 * PostgreSQL's `NAMEDATALEN` is 64, leaving 63 bytes for an identifier before
 * it is silently truncated (e.g. by `CREATE SCHEMA`). A caller-supplied name
 * longer than that would be truncated at creation time while posture queries
 * that compare the untruncated string would then fail with a misleading
 * "missing schema" error, so length is rejected up front instead.
 */
const MAX_SCHEMA_NAME_BYTES = 63;

/**
 * Defaults an unset schema name to the backend-owned {@link DEFAULT_SCHEMA_NAME}
 * (`"tuvren_kernel"`) and validates it against {@link VALID_SCHEMA_NAME_PATTERN}
 * and {@link MAX_SCHEMA_NAME_BYTES} so it is safe to interpolate into
 * unparameterized DDL identifiers and will not be truncated by PostgreSQL's
 * `NAMEDATALEN` limit.
 *
 * The default is deliberately not `"public"`. This PR (ADR-067 / issue #110)
 * replaced the two well-namespaced blob-era tables with thirteen generic,
 * unprefixed family tables (`objects`, `schemas`, `threads`, `branches`,
 * `turns`, `runs`, `staged_results`, …) plus twenty-one `idx_*` indexes,
 * created with bare `CREATE TABLE`/`CREATE INDEX` and no package-specific
 * prefix. A default-constructed backend pointed at `"public"` would either
 * collide with an adopter's own `objects`/`runs`/`threads`-named tables or,
 * on a clean database, silently colonize the adopter's default namespace.
 * Worse, {@link destroyPostgresBackend} runs
 * `DROP SCHEMA IF EXISTS <schema> CASCADE` against the configured schema —
 * on `"public"` that cascades into dropping the adopter's entire default
 * schema, not just this backend's tables. Defaulting to a backend-owned name
 * keeps a default-constructed backend from ever touching a schema it does
 * not exclusively own.
 *
 * @throws TuvrenPersistenceError `postgres_backend_invalid_schema_name` when
 *   the name does not match the pattern or exceeds the byte-length limit.
 */
export function normalizeSchemaName(schemaName: string | undefined): string {
  const normalized = schemaName ?? DEFAULT_SCHEMA_NAME;

  if (!VALID_SCHEMA_NAME_PATTERN.test(normalized)) {
    throw persistenceError(
      `postgres backend schema "${normalized}" must match ${VALID_SCHEMA_NAME_PATTERN.source}`,
      "postgres_backend_invalid_schema_name",
      { schemaName: normalized }
    );
  }

  // The pattern is ASCII-only, so byte length already equals character
  // length here — but the byte-length check is kept explicit rather than
  // assumed, since it is the actual PostgreSQL-enforced limit.
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength > MAX_SCHEMA_NAME_BYTES) {
    throw persistenceError(
      `postgres backend schema "${normalized}" is ${byteLength} bytes, ` +
        `exceeding PostgreSQL's ${MAX_SCHEMA_NAME_BYTES}-byte identifier limit ` +
        "(NAMEDATALEN - 1); a longer name would be silently truncated",
      "postgres_backend_invalid_schema_name",
      { schemaName: normalized }
    );
  }

  return normalized;
}
