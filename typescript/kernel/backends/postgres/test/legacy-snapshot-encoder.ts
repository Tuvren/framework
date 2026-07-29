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

// Test-only legacy blob-per-scope snapshot encoder (ADR-067 / issue #110).
// `encodeSnapshot` used to live in production source (postgres-backend-
// persistence.ts) so the relational backend could write the same wire
// format it read; the relational rewrite retired every production writer
// of this format (there is no snapshot_cbor column left to populate) but
// the *reader*, `decodeSnapshot`, stays in production source because the
// one-time open-time migration (`postgres-blob-migration.ts`) still needs
// it to explode a pre-#110 database's legacy blob. This file keeps the
// writer half alive for tests that seed a legacy blob row directly (the
// scope-isolation suite's blob-migration coverage) without carrying a
// production-dead encoder in `src/`.

import type {
  StoredObject,
  StoredOrderedPathChunk,
  StoredSchema,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import { CURRENT_SNAPSHOT_VERSION } from "../src/lib/postgres-backend-persistence.js";
import type { BackendState } from "../src/lib/postgres-records.js";
import {
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
  compareStoredObserveAnnotation,
  compareStoredRun,
  compareStoredStagedResult,
} from "../src/lib/postgres-state-utils.js";

/**
 * Projects a `BackendState` into the legacy snapshot wire format: every
 * record family flattened to a deterministically sorted array (so the
 * encoding is stable regardless of `Map` iteration order) and CBOR-encoded
 * alongside the schema version. The counterpart to
 * `decodeSnapshot` (`src/lib/postgres-backend-persistence.ts`), which stays
 * in production source for the blob-migration reader path; this writer half
 * is test-only, used to seed a pre-#110 `backend_postgres_snapshots` blob
 * row so a test can exercise the open-time migration end-to-end.
 */
export function encodeSnapshot(state: BackendState): Uint8Array {
  const snapshot = {
    branches: Array.from(state.branches.values(), cloneStoredBranch).sort(
      compareStoredBranch
    ),
    objects: Array.from(state.objects.values(), cloneStoredObject).sort(
      compareStoredObject
    ),
    observeAnnotations: Array.from(
      state.observeAnnotations.values(),
      (records) => records.map(cloneStoredObserveAnnotation)
    )
      .flat()
      .sort(compareStoredObserveAnnotation),
    orderedPathChunks: Array.from(
      state.orderedPathChunks.values(),
      cloneStoredOrderedPathChunk
    ).sort(compareStoredOrderedPathChunk),
    runs: Array.from(state.runs.values(), cloneStoredRun).sort(
      compareStoredRun
    ),
    schemas: Array.from(state.schemas.values(), cloneStoredSchema).sort(
      compareStoredSchema
    ),
    stagedResults: Array.from(state.stagedResults.values(), (records) =>
      Array.from(records.values(), cloneStoredStagedResult)
    )
      .flat()
      .sort(compareStoredStagedResult),
    threads: Array.from(state.threads.values(), cloneStoredThread).sort(
      compareStoredThread
    ),
    turnNodes: Array.from(state.turnNodes.values(), cloneStoredTurnNode).sort(
      compareStoredTurnNode
    ),
    turnTreePaths: Array.from(state.turnTreePaths.values(), (records) =>
      Array.from(records.values(), cloneStoredTurnTreePath)
    )
      .flat()
      .sort(compareStoredTurnTreePath),
    turnTrees: Array.from(state.turnTrees.values(), cloneStoredTurnTree).sort(
      compareStoredTurnTree
    ),
    turns: Array.from(state.turns.values(), cloneStoredTurn).sort(
      compareStoredTurn
    ),
    version: CURRENT_SNAPSHOT_VERSION,
  } satisfies Record<string, unknown>;

  return encodeDeterministicKernelRecord(
    snapshot as unknown as Parameters<typeof encodeDeterministicKernelRecord>[0]
  );
}

// Comparators below give the encoded snapshot a deterministic element order
// per record family, by identity key, independent of `Map` iteration order.

function compareStoredObject(left: StoredObject, right: StoredObject): number {
  return left.hash.localeCompare(right.hash);
}

function compareStoredOrderedPathChunk(
  left: StoredOrderedPathChunk,
  right: StoredOrderedPathChunk
): number {
  return left.chunkHash.localeCompare(right.chunkHash);
}

function compareStoredSchema(left: StoredSchema, right: StoredSchema): number {
  return left.schemaId.localeCompare(right.schemaId);
}

function compareStoredThread(left: StoredThread, right: StoredThread): number {
  return left.threadId.localeCompare(right.threadId);
}

function compareStoredTurnNode(
  left: StoredTurnNode,
  right: StoredTurnNode
): number {
  return left.hash.localeCompare(right.hash);
}

function compareStoredTurnTree(
  left: StoredTurnTree,
  right: StoredTurnTree
): number {
  return left.hash.localeCompare(right.hash);
}

function compareStoredTurnTreePath(
  left: StoredTurnTreePath,
  right: StoredTurnTreePath
): number {
  const treeCompare = left.turnTreeHash.localeCompare(right.turnTreeHash);

  if (treeCompare !== 0) {
    return treeCompare;
  }

  return left.path.localeCompare(right.path);
}

function compareStoredTurn(left: StoredTurn, right: StoredTurn): number {
  return left.turnId.localeCompare(right.turnId);
}
