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

/**
 * Connection or in-transaction handle accepted by relational Postgres modules.
 * Both shapes expose `.unsafe` for schema-qualified dynamic SQL.
 */
export type DbSql = Sql | TransactionSql<Record<string, never>>;

/** Conservative unquoted-identifier alphabet (letters, digits, `_`, `-`). */
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Double-quotes a SQL identifier after rejecting characters outside the
 * conservative unquoted-identifier alphabet (letters, digits, `_`, `-`).
 * Schema names are already validated by {@link normalizeSchemaName}; this is
 * the last line of defense before interpolating into DDL/DML.
 */
export function quoteIdentifier(identifier: string): string {
  if (!SAFE_SQL_IDENTIFIER.test(identifier)) {
    throw new Error(
      `postgres backend refused to quote unsafe SQL identifier "${identifier}"`
    );
  }

  return `"${identifier.replaceAll('"', '""')}"`;
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
