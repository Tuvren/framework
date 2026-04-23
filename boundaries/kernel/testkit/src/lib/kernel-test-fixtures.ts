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

import type { KernelRecord } from "@tuvren/core-types";
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

export function createCanonicalKernelTestSchema(): TurnTreeSchema {
  return {
    incorporationRules: [
      {
        objectType: "message",
        targetPath: "messages",
      },
      {
        objectType: "context_manifest",
        targetPath: "context.manifest",
      },
    ],
    paths: [
      {
        collection: "ordered",
        path: "messages",
      },
      {
        collection: "single",
        path: "context.manifest",
      },
    ],
    schemaId: "schema_main",
  };
}

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

export function createHashSequence(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) =>
    createHashFromIndex(index + offset)
  );
}

export function createHashFromIndex(index: number): string {
  return index.toString(16).padStart(64, "0");
}

export function createIncrementingClock(initialValue: number): () => number {
  let currentValue = initialValue;

  return () => {
    const nextValue = currentValue;
    currentValue += 1;
    return nextValue;
  };
}

export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

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
