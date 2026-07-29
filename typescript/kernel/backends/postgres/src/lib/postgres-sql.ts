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
import type { Sql, TransactionSql } from "postgres";
import { persistenceError } from "./postgres-errors.js";

/**
 * Connection or in-transaction handle accepted by relational Postgres modules.
 * Both shapes expose `.unsafe` for schema-qualified dynamic SQL.
 */
export type DbSql = Sql | TransactionSql<Record<string, never>>;

/** Conservative unquoted-identifier alphabet (letters, digits, `_`, `-`). */
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The one code point PostgreSQL `TEXT`/`VARCHAR` columns cannot encode. */
const NUL_CODE_POINT = "\u0000";

/**
 * Double-quotes a SQL identifier after rejecting characters outside the
 * conservative unquoted-identifier alphabet (letters, digits, `_`, `-`).
 * Schema names are already validated by {@link normalizeSchemaName}; this is
 * the last line of defense before interpolating into DDL/DML.
 */
export function quoteIdentifier(identifier: string): string {
  if (!SAFE_SQL_IDENTIFIER.test(identifier)) {
    throw persistenceError(
      `postgres backend refused to quote unsafe SQL identifier "${identifier}"`,
      "postgres_backend_unsafe_sql_identifier",
      { identifier }
    );
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Rejects a caller-supplied identifier/text value that contains U+0000
 * (NUL). Every affected field here now lands directly in a relational `TEXT`
 * column (ADR-067 moved it out of a CBOR blob, where an embedded NUL byte
 * round-tripped without complaint); PostgreSQL's wire protocol cannot encode
 * NUL in `text`/`varchar` and rejects it with SQLSTATE 22021
 * (`invalid_text_representation`) deep inside the driver. Calling this at the
 * repository boundary turns that into a typed, predictable
 * `postgres_backend_unstorable_text` error instead of a confusing
 * `postgres_backend_engine_error`.
 *
 * Only caller-supplied opaque strings need this (scope, thread/branch/turn/
 * run/task ids, schema ids, turn-tree paths, media types, lease/execution
 * fields). Kernel-derived content hashes never need it: they are hex/base
 * digests validated by kernel-protocol's own hash guards and cannot contain a
 * NUL byte.
 *
 * @throws TuvrenPersistenceError `postgres_backend_unstorable_text` when
 *   `value` contains U+0000.
 */
export function assertPostgresStorableText(value: string, label: string): void {
  if (value.includes(NUL_CODE_POINT)) {
    throw persistenceError(
      `postgres backend cannot store ${label}: PostgreSQL TEXT columns cannot encode a U+0000 (NUL) code point`,
      "postgres_backend_unstorable_text",
      { label }
    );
  }
}

/** Returns `"schema"."table"` for a validated schema name and table name. */
export function qualifyIdentifier(
  schemaName: string,
  tableName: string
): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

/**
 * Derives a PostgreSQL advisory-lock key (signed 64-bit, the single-argument
 * `pg_advisory_xact_lock(bigint)` form) from a domain tag plus identity
 * parts: the first 8 bytes of SHA-256 over the length-prefixed parts.
 *
 * Documented derivation instead of server-side `hashtext()`, which is an
 * undocumented internal whose algorithm carries no stability contract and
 * whose 32-bit output doubles the collision exposure. Collisions here are
 * safe (two unrelated partitions would merely serialize against each other,
 * never unlock each other) but a 64-bit auditable key space keeps them
 * negligible. Length-prefixing keeps `("ab","c")` and `("a","bc")` distinct.
 */
export function deriveAdvisoryLockKey(...parts: string[]): bigint {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${part.length}:`);
    hash.update(part);
  }

  return hash.digest().readBigInt64BE(0);
}
