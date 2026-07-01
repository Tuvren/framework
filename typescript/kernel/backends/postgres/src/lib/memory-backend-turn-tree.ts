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

import { assertHashString } from "@tuvren/core";
import {
  assertStoredOrderedPathChunk,
  assertStoredOrderedPathChunkIdentity,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type StoredOrderedPathChunk,
  type StoredTurn,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  areStoredOrderedPathChunksEqual,
  cloneStoredObserveAnnotation,
  cloneStoredTurnTreePath,
  ensureOrderedPathChunkExists,
  ensureSchemaRecordExists,
  persistenceError,
  putImmutableRecord,
  validateHashString,
} from "./memory-backend-record-utils.js";
import type { BackendState } from "./memory-backend-types.js";

const ORDERED_PATH_CHUNK_THRESHOLD = 32;
export const ORDERED_PATH_CHUNK_SIZE = 32;

export function listTurnsByThread(
  state: BackendState,
  threadId: string,
  excludedTurnId?: string
): StoredTurn[] {
  const turns: StoredTurn[] = [];

  for (const turn of state.turns.values()) {
    if (turn.threadId !== threadId || turn.turnId === excludedTurnId) {
      continue;
    }

    turns.push(turn);
  }

  turns.sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) {
      return left.createdAtMs - right.createdAtMs;
    }

    return left.turnId.localeCompare(right.turnId);
  });

  return turns;
}

export function cloneState(state: BackendState): BackendState {
  return {
    branches: new Map(state.branches),
    observeAnnotations: new Map(
      Array.from(state.observeAnnotations, ([runId, records]) => [
        runId,
        records.map(cloneStoredObserveAnnotation),
      ])
    ),
    objects: new Map(state.objects),
    orderedPathChunks: new Map(state.orderedPathChunks),
    runs: new Map(state.runs),
    schemas: new Map(state.schemas),
    stagedResults: new Map(
      Array.from(state.stagedResults, ([runId, results]) => [
        runId,
        new Map(results),
      ])
    ),
    threads: new Map(state.threads),
    turnNodes: new Map(state.turnNodes),
    turnTreePaths: new Map(
      Array.from(state.turnTreePaths, ([turnTreeHash, paths]) => [
        turnTreeHash,
        new Map(paths),
      ])
    ),
    turnTrees: new Map(state.turnTrees),
    turns: new Map(state.turns),
  };
}

export async function normalizeStoredTurnTreePath(
  state: BackendState,
  record: StoredTurnTreePath,
  now: () => number
): Promise<StoredTurnTreePath> {
  if (record.collectionKind === "single") {
    return cloneStoredTurnTreePath(record);
  }

  if (record.orderedEncoding === "chunked") {
    const chunkHashes = decodeHashStringArray(
      record.orderedChunkListCbor,
      "record.orderedChunkListCbor"
    );

    if (record.orderedCount <= ORDERED_PATH_CHUNK_THRESHOLD) {
      throw persistenceError(
        "chunked ordered turn tree paths must only be used after crossing the promotion threshold",
        "postgres_backend_chunked_turn_tree_path_below_threshold",
        {
          orderedCount: record.orderedCount,
          threshold: ORDERED_PATH_CHUNK_THRESHOLD,
        }
      );
    }

    let totalCount = 0;
    for (const [index, chunkHash] of chunkHashes.entries()) {
      const chunk = ensureOrderedPathChunkExists(
        state,
        chunkHash,
        "record.orderedChunkListCbor"
      );
      assertChunkedTurnTreePathChunkLayout(chunk, index, chunkHashes.length);
      totalCount += chunk.itemCount;
    }

    if (totalCount !== record.orderedCount) {
      throw persistenceError(
        "chunked turn tree paths must agree with the stored chunk cardinality",
        "postgres_backend_chunked_turn_tree_path_count_mismatch",
        { orderedCount: record.orderedCount, totalCount }
      );
    }

    return cloneStoredTurnTreePath(record);
  }

  if (record.orderedCount <= ORDERED_PATH_CHUNK_THRESHOLD) {
    return cloneStoredTurnTreePath(record);
  }

  const orderedHashes = decodeHashStringArray(
    record.orderedInlineCbor,
    "record.orderedInlineCbor"
  );
  const chunkHashes: string[] = [];

  for (
    let index = 0;
    index < orderedHashes.length;
    index += ORDERED_PATH_CHUNK_SIZE
  ) {
    const chunkItems = orderedHashes.slice(
      index,
      index + ORDERED_PATH_CHUNK_SIZE
    );
    const itemsCbor = encodeHashStringArray(chunkItems);
    const chunkHash = await hashKernelRecord(chunkItems);
    const existingChunk = state.orderedPathChunks.get(chunkHash);
    const chunkRecord: StoredOrderedPathChunk = {
      chunkHash,
      createdAtMs: existingChunk?.createdAtMs ?? now(),
      itemCount: chunkItems.length,
      itemsCbor,
    };

    assertStoredOrderedPathChunk(chunkRecord, "chunkRecord");
    await assertStoredOrderedPathChunkIdentity(chunkRecord, "chunkRecord");
    putImmutableRecord(
      state.orderedPathChunks,
      chunkRecord.chunkHash,
      chunkRecord,
      (value) => ({
        ...value,
        itemsCbor: Uint8Array.from(value.itemsCbor),
      }),
      areStoredOrderedPathChunksEqual,
      "ordered path chunk"
    );
    chunkHashes.push(chunkHash);
  }

  return {
    collectionKind: "ordered",
    orderedChunkListCbor: encodeHashStringArray(chunkHashes),
    orderedCount: record.orderedCount,
    orderedEncoding: "chunked",
    path: record.path,
    turnTreeHash: record.turnTreeHash,
  };
}

export function getSchemaForSchemaId(
  state: BackendState,
  schemaId: string,
  label: string
): TurnTreeSchema {
  const schemaRecord = ensureSchemaRecordExists(state, schemaId, label);
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
}

export function getSchemaForTurnTree(
  state: BackendState,
  turnTree: StoredTurnTree
): TurnTreeSchema {
  return getSchemaForSchemaId(state, turnTree.schemaId, "turnTree.schemaId");
}

export function decodeTurnTreeSchema(
  bytes: Uint8Array,
  label: string
): TurnTreeSchema {
  const decodedValue = decodeDeterministicKernelRecord(bytes);
  assertTurnTreeSchema(decodedValue, label);
  return decodedValue;
}

export function decodeHashStringArray(
  bytes: Uint8Array,
  label: string
): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      `${label} must decode to a HashString[]`,
      "postgres_backend_invalid_hash_array_payload",
      { label }
    );
  }

  const hashes: string[] = [];

  for (const [index, item] of decodedValue.entries()) {
    assertHashString(item, `${label}[${index}]`);
    hashes.push(item);
  }

  return hashes;
}

export function assertTurnTreeManifestMatchesStoredPaths(
  state: BackendState,
  turnTree: StoredTurnTree
): void {
  const schema = getSchemaForTurnTree(state, turnTree);
  const manifestValue = decodeDeterministicKernelRecord(turnTree.manifestCbor);
  const storedPaths = state.turnTreePaths.get(turnTree.hash);

  if (
    manifestValue === null ||
    typeof manifestValue !== "object" ||
    Array.isArray(manifestValue) ||
    manifestValue instanceof Uint8Array
  ) {
    throw persistenceError(
      "stored turn trees must decode to a manifest object",
      "postgres_backend_invalid_turn_tree_manifest",
      {
        turnTreeHash: turnTree.hash,
      }
    );
  }

  if (storedPaths === undefined) {
    throw persistenceError(
      "stored turn trees must have indexed path rows",
      "postgres_backend_missing_turn_tree_paths",
      {
        turnTreeHash: turnTree.hash,
      }
    );
  }

  if (storedPaths.size !== schema.paths.length) {
    throw persistenceError(
      "stored turn tree paths must fully cover the schema-defined manifest",
      "postgres_backend_turn_tree_path_count_mismatch",
      {
        pathCount: storedPaths.size,
        schemaPathCount: schema.paths.length,
        turnTreeHash: turnTree.hash,
      }
    );
  }

  for (const pathDefinition of schema.paths) {
    const storedPath = storedPaths.get(pathDefinition.path);

    if (storedPath === undefined) {
      throw persistenceError(
        "stored turn tree paths must include every schema path",
        "postgres_backend_missing_turn_tree_path",
        {
          path: pathDefinition.path,
          turnTreeHash: turnTree.hash,
        }
      );
    }

    const manifestPathValue = Reflect.get(manifestValue, pathDefinition.path);
    const storedPathValue = resolveStoredTurnTreePathValue(state, storedPath);

    if (!areManifestPathValuesEqual(manifestPathValue, storedPathValue)) {
      throw persistenceError(
        "stored turn tree paths must match the logical manifest",
        "postgres_backend_turn_tree_manifest_path_mismatch",
        {
          path: pathDefinition.path,
          turnTreeHash: turnTree.hash,
        }
      );
    }
  }
}

export function resolveStoredTurnTreePathValue(
  state: BackendState,
  storedPath: StoredTurnTreePath
): string[] | string | null {
  if (storedPath.collectionKind === "single") {
    return storedPath.singleHash;
  }

  if (storedPath.orderedEncoding === "flat") {
    return decodeHashStringArray(
      storedPath.orderedInlineCbor,
      "storedPath.orderedInlineCbor"
    );
  }

  const resolvedHashes: string[] = [];
  const chunkHashes = decodeHashStringArray(
    storedPath.orderedChunkListCbor,
    "storedPath.orderedChunkListCbor"
  );

  for (const chunkHash of chunkHashes) {
    const chunk = ensureOrderedPathChunkExists(
      state,
      chunkHash,
      "storedPath.orderedChunkListCbor"
    );

    resolvedHashes.push(
      ...decodeHashStringArray(chunk.itemsCbor, "chunk.itemsCbor")
    );
  }

  return resolvedHashes;
}

export function areManifestPathValuesEqual(
  left: unknown,
  right: string[] | string | null
): boolean {
  if (left === null || typeof left === "string") {
    return left === right;
  }

  if (
    !(Array.isArray(left) && Array.isArray(right)) ||
    left.length !== right.length
  ) {
    return false;
  }

  for (const [index, item] of left.entries()) {
    if (item !== right[index]) {
      return false;
    }
  }

  return true;
}

export function encodeHashStringArray(hashes: string[]): Uint8Array {
  return encodeDeterministicKernelRecord(
    hashes.map((hash) => validateHashString(hash))
  );
}

export function assertChunkedTurnTreePathChunkLayout(
  chunk: StoredOrderedPathChunk,
  index: number,
  totalChunks: number
): void {
  if (chunk.itemCount < 1 || chunk.itemCount > ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "ordered path chunks must contain between one and the fixed chunk size number of items",
      "postgres_backend_ordered_path_chunk_size_invalid",
      {
        chunkHash: chunk.chunkHash,
        chunkItemCount: chunk.itemCount,
        chunkSize: ORDERED_PATH_CHUNK_SIZE,
      }
    );
  }

  if (index < totalChunks - 1 && chunk.itemCount !== ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "non-final ordered path chunks must use the fixed chunk size",
      "postgres_backend_ordered_path_chunk_not_fixed_size",
      {
        chunkHash: chunk.chunkHash,
        chunkIndex: index,
        chunkItemCount: chunk.itemCount,
        chunkSize: ORDERED_PATH_CHUNK_SIZE,
        totalChunks,
      }
    );
  }
}
