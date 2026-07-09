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

// This module is a thin delegate to the shared kernel-backend invariant
// core (KRT-BK001): the record-utils behavior it exposes is identical to the
// PostgreSQL backend's copy modulo the `memory_backend_*` error-code prefix.
// See @tuvren/backend-shared for the actual implementation.
import { createBackendInvariantRecordUtils } from "@tuvren/backend-shared";

const recordUtils = createBackendInvariantRecordUtils({
  errorPrefix: "memory",
});

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
  assertImmutableBytes,
  assertImmutableField,
  assertImmutableOptionalField,
  assertRunStatusTransition,
  cloneBytes,
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
  compareByTimestampAndKey,
  compareStoredBranch,
  compareStoredObserveAnnotation,
  compareStoredRun,
  compareStoredStagedResult,
  compareStoredTurn,
  ensureBranchExists,
  ensureImmutableRecordMatch,
  ensureObjectExists,
  ensureOrderedPathChunkExists,
  ensureRunExists,
  ensureSchemaRecordExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
  isExpiredLeasedRunningRun,
  persistenceError,
  putImmutableRecord,
  validateHashString,
} = recordUtils;
