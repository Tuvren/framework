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
import type { RelationalTableName } from "./postgres-schema.js";

/**
 * Connection or in-transaction handle accepted by relational Postgres modules.
 * Both shapes expose `.unsafe` for schema-qualified dynamic SQL.
 */
export type DbSql = Sql | TransactionSql<Record<string, never>>;

/** Conservative unquoted-identifier alphabet (letters, digits, `_`, `-`). */
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The one well-formed Unicode code point PostgreSQL text cannot encode. */
const NUL_CODE_POINT = "\u0000";

/**
 * Double-quotes a SQL identifier after rejecting characters outside the
 * conservative unquoted-identifier alphabet (letters, digits, `_`, `-`).
 * Schema names are already validated by {@link normalizeSchemaName}; this is
 * the last line of defense before interpolating into DDL/DML. The SAFE
 * alphabet already excludes `"`, so escaping an embedded quote is
 * unreachable; the identifier is simply wrapped in double quotes.
 */
export function quoteIdentifier(identifier: string): string {
  if (!SAFE_SQL_IDENTIFIER.test(identifier)) {
    throw persistenceError(
      `postgres backend refused to quote unsafe SQL identifier "${identifier}"`,
      "postgres_backend_unsafe_sql_identifier",
      { identifier }
    );
  }

  return `"${identifier}"`;
}

/**
 * PostgreSQL btree indexes cap a single index tuple at 2704 bytes on the
 * default 8 KB page size (`ERROR: index row size ... exceeds btree version 4
 * maximum 2704`, SQLSTATE 54000) — a limit independent of, and far tighter
 * than, anything a `TEXT` column itself enforces (1 GB). Every family table
 * in migrations/0001_relational_schema.sql puts caller-supplied identifiers
 * directly into `(scope, ...)` primary keys and the 21 `idx_*` indexes, so an
 * incompressible, sufficiently long identifier can fail a write with an
 * untyped `postgres_backend_engine_error` while the memory and SQLite
 * backends — no btree index-row limit — accept the same value.
 *
 * `MAX_STORABLE_TEXT_BYTES` bounds every caller-supplied field this module
 * already guards, so no index row this schema builds can approach 2704
 * bytes. Worst composites across the schema at a per-field bound L = 512:
 *
 * - `idx_turns_scope_thread_branch_head_turn_node` (scope, thread_id,
 *   branch_id, head_turn_node_hash): three L-bounded columns (scope,
 *   thread_id, branch_id) plus one fixed 64-byte kernel content hash
 *   (head_turn_node_hash) = 3*512 + 64 = 1600 raw text bytes. Adding a
 *   generous 50-byte allowance for btree/varlena overhead (an 8-byte index
 *   tuple header, a 4-byte varlena header per long text column, alignment
 *   padding) lands at ~1650 — over 1000 bytes of headroom under the 2704
 *   limit, and the largest raw-byte composite in the schema.
 *
 * - `observe_annotations` primary key (scope, record_key): record_key (see
 *   `keyObserveAnnotation`/`nextObserveAnnotationRecordKey` in
 *   postgres-state-utils.ts) is the *densest single-column* composite,
 *   length-prefixing runId, String(createdAtMs), annotationHash, and
 *   turnNodeHash (or "") together, plus a trailing duplicate-count suffix.
 *   Only runId is an L-bounded caller-supplied field here — annotationHash
 *   and turnNodeHash are kernel content hashes fixed at exactly 64 lowercase
 *   hex characters (`assertHashString`), and createdAtMs is a numeric
 *   epoch-ms string. Worst case with L = 512, a generously over-estimated
 *   20-digit createdAtMs string, and a generously over-estimated 10-digit
 *   duplicate-count suffix:
 *     runId field           (3-digit length prefix + sep + 512 bytes) = 516
 *     createdAtMs field     (2-digit length prefix + sep + 20 bytes)  =  23
 *     annotationHash field  (2-digit length prefix + sep + 64 bytes)  =  67
 *     turnNodeHash field    (2-digit length prefix + sep + 64 bytes)  =  67
 *     3 separators joining the four fields                           =   3
 *     identityKey subtotal                                           = 676
 *     trailing separator + 10-digit duplicate-count suffix           =  11
 *     record_key total                                               = 687
 *   PK total = scope (512) + record_key (687) = 1199 raw bytes, safely
 *   below the turns-index worst case above — so
 *   `idx_turns_scope_thread_branch_head_turn_node` governs, not this one,
 *   even though this key packs the most distinct identity fields into a
 *   single column (the reason it is the *tightest per caller-controlled
 *   field* in the schema).
 *
 * L = 512 is not engineered to the 2704 ceiling: real kernel identifiers are
 * hashes/UUIDs well under 100 bytes, so this bound is a divergence-honesty
 * backstop against pathological caller input, not a constraint any
 * legitimate identifier is expected to approach.
 */
const MAX_STORABLE_TEXT_BYTES = 512;

/**
 * Rejects a caller-supplied identifier/text value that is not well-formed
 * UTF-16 or contains U+0000 (NUL). Every affected field here now lands
 * directly in a relational `TEXT`
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
 * Also rejects a value whose UTF-8 byte length exceeds
 * {@link MAX_STORABLE_TEXT_BYTES} (round 6 review P2): every field guarded
 * here lands directly in a `(scope, ...)` btree primary key or one of the 21
 * `idx_*` indexes in migrations/0001_relational_schema.sql, and PostgreSQL
 * caps a single btree index tuple at 2704 bytes regardless of the column's
 * own `TEXT` type limit — see {@link MAX_STORABLE_TEXT_BYTES}'s docblock for
 * the worst-composite arithmetic. This is a divergence-honesty backstop, not
 * a working constraint: real kernel identifiers are hashes/UUIDs well under
 * 100 bytes.
 *
 * The representability checks run before the byte-length check and keep their
 * own distinct error code: a value
 * that is both too long and NUL-containing is reported as unstorable text,
 * not as merely too long, since the NUL is the more fundamental encoding
 * failure (PostgreSQL cannot represent it at any length).
 *
 * @throws TuvrenPersistenceError `postgres_backend_unstorable_text` when
 *   `value` is not well-formed UTF-16 or contains U+0000.
 * @throws TuvrenPersistenceError `postgres_backend_text_too_long` when
 *   `value`'s UTF-8 byte length exceeds {@link MAX_STORABLE_TEXT_BYTES}.
 */
export function assertPostgresStorableText(value: string, label: string): void {
  // PostgreSQL stores Unicode scalar values, while JavaScript strings may
  // contain lone UTF-16 surrogates. The runtime/driver replacement-encodes
  // those invalid sequences as U+FFFD, which can collapse two distinct Scope
  // or record identities onto the same durable key. Reject before hashing or
  // binding instead of silently changing caller-supplied identity.
  if (!value.isWellFormed()) {
    throw persistenceError(
      `postgres backend cannot store ${label}: value is not a well-formed UTF-16 string`,
      "postgres_backend_unstorable_text",
      { label }
    );
  }

  if (value.includes(NUL_CODE_POINT)) {
    throw persistenceError(
      `postgres backend cannot store ${label}: PostgreSQL TEXT columns cannot encode a U+0000 (NUL) code point`,
      "postgres_backend_unstorable_text",
      { label }
    );
  }

  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_STORABLE_TEXT_BYTES) {
    throw persistenceError(
      `postgres backend cannot store ${label}: value is ${byteLength} UTF-8 bytes, ` +
        `exceeding the ${MAX_STORABLE_TEXT_BYTES}-byte bound kernel identifiers are ` +
        "held to so no btree index row built from it can approach PostgreSQL's " +
        "2704-byte btree index-row limit",
      "postgres_backend_text_too_long",
      { actualBytes: byteLength, label, maxBytes: MAX_STORABLE_TEXT_BYTES }
    );
  }
}

/** Returns `"schema"."table"` for a validated schema name and table name. */
export function qualifyIdentifier(
  schemaName: string,
  tableName: RelationalTableName
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
