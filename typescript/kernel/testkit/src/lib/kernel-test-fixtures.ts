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

import type { KernelRecord } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
  type StagedResult,
  type StoredObject,
  type StoredOrderedPathChunk,
  type StoredSchema,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeManifest,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { canonicalKernelTestSchemaFixture } from "./kernel-conformance-fixtures.js";

/**
 * Returns a fresh deep clone of the canonical kernel test schema (a
 * `messages` ordered path plus a `context.manifest` single path) shared by
 * the conformance/invariant/recovery suites, so test cases can rely on a
 * consistent schema without accidentally sharing mutable state.
 */
export function createCanonicalKernelTestSchema(): TurnTreeSchema {
  return structuredClone(canonicalKernelTestSchemaFixture);
}

/** Builds a `StoredSchema` row encoding `schema`'s paths and incorporation rules. */
export function createStoredSchemaRecord(
  schema: TurnTreeSchema,
  createdAtMs: number
): StoredSchema {
  return {
    createdAtMs,
    schemaCbor: encodeDeterministicKernelRecord({
      incorporationRules: schema.incorporationRules.map((rule) => ({
        objectType: rule.objectType,
        targetPath: rule.targetPath,
      })),
      paths: schema.paths.map((path) => ({
        collection: path.collection,
        path: path.path,
      })),
      schemaId: schema.schemaId,
    }),
    schemaId: schema.schemaId,
  };
}

/** Builds a `StoredObject` row for `bytes`, hashing it as an opaque object. */
export async function createStoredObjectRecord(
  bytes: Uint8Array,
  createdAtMs: number
): Promise<StoredObject> {
  return {
    byteLength: bytes.byteLength,
    bytes: Uint8Array.from(bytes),
    createdAtMs,
    hash: await hashOpaqueObjectBytes(bytes),
    mediaType: "application/octet-stream",
  };
}

/** Builds a `StoredTurnTree` row for `manifest`, deriving its content-addressed hash. */
export async function createStoredTurnTreeRecord(
  schema: TurnTreeSchema,
  manifest: TurnTreeManifest,
  createdAtMs: number
): Promise<StoredTurnTree> {
  return {
    createdAtMs,
    hash: await hashTurnTreeIdentity(schema.schemaId, manifest, schema),
    manifestCbor: encodeDeterministicKernelRecord(manifest),
    schemaId: schema.schemaId,
  };
}

/** Builds a `StoredOrderedPathChunk` row for `hashes`, deriving its content-addressed hash. */
export async function createStoredOrderedPathChunkRecord(
  hashes: string[],
  createdAtMs: number
): Promise<StoredOrderedPathChunk> {
  return {
    chunkHash: await hashKernelRecord(hashes),
    createdAtMs,
    itemCount: hashes.length,
    itemsCbor: encodeDeterministicKernelRecord(hashes),
  };
}

/**
 * Builds a `StoredTurnNode` row from its logical identity fields, encoding
 * `consumedStagedResults` and deriving the node's content-addressed hash.
 */
export async function createStoredTurnNodeRecord(input: {
  consumedStagedResults: StagedResult[];
  createdAtMs: number;
  eventHash: string | null;
  previousTurnNodeHash: string | null;
  schemaId: string;
  turnTreeHash: string;
}): Promise<StoredTurnNode> {
  const encodedConsumedStagedResults: KernelRecord[] = [];

  for (const stagedResult of input.consumedStagedResults) {
    if (stagedResult.status === "interrupted") {
      encodedConsumedStagedResults.push({
        interruptPayload: stagedResult.interruptPayload,
        objectHash: stagedResult.objectHash,
        objectType: stagedResult.objectType,
        status: stagedResult.status,
        taskId: stagedResult.taskId,
        timestamp: stagedResult.timestamp,
      });
      continue;
    }

    encodedConsumedStagedResults.push({
      objectHash: stagedResult.objectHash,
      objectType: stagedResult.objectType,
      status: stagedResult.status,
      taskId: stagedResult.taskId,
      timestamp: stagedResult.timestamp,
    });
  }

  return {
    consumedStagedResultsCbor: encodeDeterministicKernelRecord(
      encodedConsumedStagedResults
    ),
    createdAtMs: input.createdAtMs,
    eventHash: input.eventHash,
    hash: await hashTurnNodeIdentity({
      consumedStagedResults: input.consumedStagedResults,
      eventHash: input.eventHash,
      previousTurnNodeHash: input.previousTurnNodeHash,
      schemaId: input.schemaId,
      turnTreeHash: input.turnTreeHash,
    }),
    previousTurnNodeHash: input.previousTurnNodeHash,
    schemaId: input.schemaId,
    turnTreeHash: input.turnTreeHash,
  };
}

/**
 * Builds `count` deterministic, distinct hash strings starting at
 * `offset`, via {@link createHashFromIndex}.
 */
export function createHashSequence(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) =>
    createHashFromIndex(index + offset)
  );
}

/**
 * Deterministically derives a 64-hex-character hash-shaped string from an
 * index — not a real content hash, just a distinct, readable placeholder
 * for fixtures that only need referential identity.
 */
export function createHashFromIndex(index: number): string {
  return index.toString(16).padStart(64, "0");
}

/**
 * Builds a clock function that returns `initialValue`, then a strictly
 * increasing integer on every call — useful for deterministic `createdAtMs`
 * sequencing in tests without depending on wall-clock time.
 */
export function createIncrementingClock(initialValue: number): () => number {
  let currentValue = initialValue;

  return () => {
    const nextValue = currentValue;
    currentValue += 1;
    return nextValue;
  };
}

/** Resolves after `durationMs` milliseconds — for timing-sensitive test scenarios. */
export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * Builds the indexed `StoredTurnTreePath` rows for `manifest`, matching the
 * canonical kernel test schema's two paths (`context.manifest` as `single`,
 * `messages` as a flat `ordered` collection) — the rows a `turnTreePaths.putMany`
 * call needs alongside a `turnTrees.put` of `turnTree`.
 *
 * @throws Error when `manifest` does not match the canonical test schema's
 *   shape (a `messages` array and a `context.manifest` hash-or-null).
 */
export function createCanonicalTurnTreePaths(
  turnTree: StoredTurnTree,
  manifest: TurnTreeManifest
): StoredTurnTreePath[] {
  const messageHashes = manifest.messages;
  const contextManifestHash = manifest["context.manifest"];

  if (!Array.isArray(messageHashes)) {
    throw new Error(
      "manifest.messages must be an ordered hash array for the canonical kernel test schema"
    );
  }

  if (typeof contextManifestHash !== "string" && contextManifestHash !== null) {
    throw new Error(
      'manifest["context.manifest"] must be a hash string or null for the canonical kernel test schema'
    );
  }

  return [
    {
      collectionKind: "single",
      path: "context.manifest",
      singleHash: contextManifestHash,
      turnTreeHash: turnTree.hash,
    },
    {
      collectionKind: "ordered",
      orderedCount: messageHashes.length,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeDeterministicKernelRecord(messageHashes),
      path: "messages",
      turnTreeHash: turnTree.hash,
    },
  ];
}
