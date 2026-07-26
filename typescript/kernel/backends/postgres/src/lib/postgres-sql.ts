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
 * Narrows a connection or transaction handle to {@link DbSql} for helpers that
 * accept either shape.
 */
export function asTxSql(sql: DbSql): DbSql {
  return sql;
}
