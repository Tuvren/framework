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

import { createBackendInvariantRecordUtils } from "@tuvren/backend-shared";
// This module is a thin delegate to the shared kernel-backend invariant core
// (KRT-BK001) for: the nine `ensure*Exists` existence checks, twelve
// `cloneStored*` deep-copy helpers, eight `areStored*Equal` equality checks,
// four of the five `compareStored*` comparators (`compareStoredBranch`,
// `compareStoredRun`, `compareStoredStagedResult`, `compareStoredTurn`), and
// `areBytesEqual` — all identical to the memory and SQLite backends' copies
// modulo the `postgres_backend_*` error-code prefix and this backend's own
// injected `cloneEncodedBytes` (see @tuvren/backend-shared's
// `BackendInvariantRecordUtilsConfig`, which every `cloneStored*` helper
// carrying a CBOR byte field routes through). See @tuvren/backend-shared for
// the actual implementations.
//
// Backend-owned residue that stays local to this file (no shared
// counterpart, or diverging from one): the observe-annotation identity-key
// trio (`OBSERVE_ANNOTATION_KEY_SEPARATOR`, `keyObserveAnnotation`,
// `nextObserveAnnotationRecordKey`) and `compareStoredObserveAnnotation`,
// which — unlike its four `compareStored*` siblings above — does not
// delegate to the shared factory; see its own docblock below for why.
import type { StoredObserveAnnotation } from "@tuvren/kernel-protocol";
import { cloneEncodedBytes } from "./postgres-records.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";

const recordUtils = createBackendInvariantRecordUtils({
  cloneEncodedBytes,
  errorPrefix: "postgres",
});

// Kept private: this backend never exported `compareByTimestampAndKey`
// itself, only used it (previously via its own local copy) to implement
// `compareStoredObserveAnnotation` below.
const { compareByTimestampAndKey } = recordUtils;

export const {
  areBytesEqual,
  areStoredObjectsEqual,
  areStoredOrderedPathChunksEqual,
  areStoredSchemasEqual,
  areStoredStagedResultsEqual,
  areStoredThreadsEqual,
  areStoredTurnNodesEqual,
  areStoredTurnTreePathsEqual,
  areStoredTurnTreesEqual,
  cloneStoredBranch,
  cloneStoredObject,
  cloneStoredObserveAnnotation,
  cloneStoredOrderedPathChunk,
  cloneStoredRun,
  cloneStoredSchema,
  cloneStoredStagedResult,
  cloneStoredThread,
  cloneStoredTurn,
  cloneStoredTurnNode,
  cloneStoredTurnTree,
  cloneStoredTurnTreePath,
  compareStoredBranch,
  compareStoredRun,
  compareStoredStagedResult,
  compareStoredTurn,
  ensureBranchExists,
  ensureObjectExists,
  ensureOrderedPathChunkExists,
  ensureRunExists,
  ensureSchemaRecordExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
} = recordUtils;

/**
 * Separator between the identity fields of an observe annotation key and
 * between the identity key and its duplicate-count suffix. The SQLite
 * backend uses `"\0"` here, but PostgreSQL `text` cannot store U+0000
 * (`invalid byte sequence for encoding "UTF8": 0x00`), and this key is
 * persisted as the `observe_annotations.record_key` column — so this
 * backend uses the ASCII unit separator instead. Unambiguity does not
 * depend on the separator never appearing in a field: each field is
 * length-prefixed (see {@link keyObserveAnnotation}), so any field content,
 * including the separator itself, keys distinctly.
 */
export const OBSERVE_ANNOTATION_KEY_SEPARATOR = "\u001f";

/**
 * Derives an observe annotation's identity key from its logical fields
 * (`runId`, `createdAtMs`, `annotationHash`, `turnNodeHash`) — distinct from
 * its storage `record_key`, which additionally disambiguates repeats of the
 * same identity via {@link nextObserveAnnotationRecordKey}. Fields are
 * length-prefixed so the key is injective over field tuples regardless of
 * what characters the caller-supplied fields contain (identifiers are
 * contract-opaque strings; nothing forbids them containing the separator).
 */
export function keyObserveAnnotation(record: StoredObserveAnnotation): string {
  return [
    record.runId,
    String(record.createdAtMs),
    record.annotationHash,
    record.turnNodeHash ?? "",
  ]
    .map(
      (field) => `${field.length}${OBSERVE_ANNOTATION_KEY_SEPARATOR}${field}`
    )
    .join(OBSERVE_ANNOTATION_KEY_SEPARATOR);
}

/**
 * Computes the storage `record_key` for a new observe annotation: its
 * identity key (see {@link keyObserveAnnotation}) suffixed with the count of
 * rows already sharing that identity, so repeated annotations with identical
 * logical fields still get distinct primary keys instead of colliding.
 */
export async function nextObserveAnnotationRecordKey(
  sql: DbSql,
  schemaName: string,
  scope: string,
  record: StoredObserveAnnotation
): Promise<string> {
  const identityKey = keyObserveAnnotation(record);
  const table = qualifyIdentifier(schemaName, "observe_annotations");
  const rows = await sql.unsafe<Array<{ count: number | string | bigint }>>(
    `
        SELECT COUNT(*)::int AS count
        FROM ${table}
        WHERE scope = $1
          AND run_id = $2
          AND created_at_ms = $3
          AND annotation_hash = $4
          AND (
            (turn_node_hash IS NULL AND $5::text IS NULL) OR
            turn_node_hash = $5
          )
      `,
    [
      scope,
      record.runId,
      record.createdAtMs,
      record.annotationHash,
      record.turnNodeHash,
    ]
  );
  const count = Number(rows[0]?.count ?? 0);

  return `${identityKey}${OBSERVE_ANNOTATION_KEY_SEPARATOR}${count}`;
}

/**
 * Unlike its `compareStoredBranch`/`compareStoredRun`/`compareStoredTurn`/
 * `compareStoredStagedResult` siblings above (all sourced verbatim from
 * @tuvren/backend-shared), this comparator does not delegate to the shared
 * factory: the shared factory's `compareStoredObserveAnnotation` breaks
 * same-timestamp ties on `annotationHash` alone, but two annotations can
 * legitimately share an `annotationHash` (the same content hashed twice)
 * across different runs or turn nodes. This backend instead breaks ties on
 * the full observe-annotation identity key ({@link keyObserveAnnotation},
 * backend-owned above), which additionally folds in `runId`/`turnNodeHash`,
 * so ordering stays deterministic even across identity-hash collisions.
 */
export function compareStoredObserveAnnotation(
  left: StoredObserveAnnotation,
  right: StoredObserveAnnotation
): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    keyObserveAnnotation(left),
    keyObserveAnnotation(right)
  );
}
