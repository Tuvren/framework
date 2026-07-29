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
// `areBytesEqual` — all identical to the memory and PostgreSQL backends'
// copies modulo the `sqlite_backend_*` error-code prefix and this backend's
// own injected `cloneEncodedBytes` (see @tuvren/backend-shared's
// `BackendInvariantRecordUtilsConfig`, which every `cloneStored*` helper
// carrying a CBOR byte field routes through). See @tuvren/backend-shared for
// the actual implementations.
//
// Backend-owned residue that stays local to this file (no shared
// counterpart, or diverging from one): the observe-annotation identity-key
// trio (`keyObserveAnnotation`, `nextObserveAnnotationRecordKey`, which is
// synchronous here and uses `"\0"` as its field separator — unlike the
// PostgreSQL backend, SQLite `TEXT` has no trouble storing U+0000) and
// `compareStoredObserveAnnotation`, which — unlike its four
// `compareStored*` siblings above — does not delegate to the shared
// factory; see its own docblock below for why.
import type { StoredObserveAnnotation } from "@tuvren/kernel-protocol";
import type Database from "better-sqlite3";
import { cloneEncodedBytes } from "./sqlite-records.js";

const recordUtils = createBackendInvariantRecordUtils({
  cloneEncodedBytes,
  errorPrefix: "sqlite",
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
 * Derives an observe annotation's identity key from its logical fields
 * (`runId`, `createdAtMs`, `annotationHash`, `turnNodeHash`) — distinct from
 * its storage `record_key`, which additionally disambiguates repeats of the
 * same identity via {@link nextObserveAnnotationRecordKey}.
 *
 * The bare `"\0"` join below is a known theoretical ambiguity: without
 * length-prefixing, two different field splits can produce the same joined
 * string (e.g. `("a\0b", "c")` and `("a", "b\0c")` collapse to the same key
 * if a field itself happened to contain `"\0"`). This is deliberately not
 * fixed here: shipped SQLite databases already contain `record_key` values
 * derived with this exact bare-join format, and changing the derivation
 * would risk an old-format key colliding with a new-format key for a
 * different identity, silently corrupting existing data on upgrade. The
 * PostgreSQL backend's `keyObserveAnnotation` (in `postgres-state-utils.ts`)
 * is the greenfield fix for this class of ambiguity: it length-prefixes each
 * field before joining, so the key is injective over field tuples. That fix
 * was adopted there because that backend has no legacy bare-join format to
 * stay compatible with.
 */
export function keyObserveAnnotation(record: StoredObserveAnnotation): string {
  return [
    record.runId,
    String(record.createdAtMs),
    record.annotationHash,
    record.turnNodeHash ?? "",
  ].join("\0");
}

/**
 * Computes the storage `record_key` for a new observe annotation: its
 * identity key (see {@link keyObserveAnnotation}) suffixed with the count of
 * rows already sharing that identity, so repeated annotations with identical
 * logical fields still get distinct primary keys instead of colliding.
 */
export function nextObserveAnnotationRecordKey(
  db: Database.Database,
  record: StoredObserveAnnotation
): string {
  const identityKey = keyObserveAnnotation(record);
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM observe_annotations
        WHERE run_id = ?
          AND created_at_ms = ?
          AND annotation_hash = ?
          AND (
            (turn_node_hash IS NULL AND ? IS NULL) OR
            turn_node_hash = ?
          )
      `
    )
    .get(
      record.runId,
      record.createdAtMs,
      record.annotationHash,
      record.turnNodeHash,
      record.turnNodeHash
    ) as { count: number };

  return `${identityKey}\0${row.count}`;
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
