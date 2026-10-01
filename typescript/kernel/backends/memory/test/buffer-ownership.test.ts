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

// Buffer ownership contract (ADR-0074): every byte field a caller hands to the
// backend stays caller-owned, and every byte field the backend returns stays
// backend-owned. The deterministic CBOR decoder (`cbor-x`) attaches a
// `dataView` own property to the buffer it decodes, so a decoder or identity
// validator that runs on a caller-owned or stored buffer would mutate memory
// the caller still owns. These assertions use the public backend surface only.
import { describe, expect, test } from "bun:test";

import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  encodeDeterministicKernelRecord,
  type RuntimeBackendTx as KrakenBackendTx,
  type StoredBranch,
  type StoredObject,
  type StoredObserveAnnotation,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeManifest,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  createHashFromIndex,
  createHashSequence,
  createCanonicalKernelTestSchema as createSchema,
  createStoredObjectRecord as createStoredObject,
  createStoredOrderedPathChunkRecord as createStoredOrderedPathChunk,
  createStoredSchemaRecord as createStoredSchema,
  createStoredTurnNodeRecord as createStoredTurnNode,
  createStoredTurnTreeRecord as createStoredTurnTree,
} from "@tuvren/kernel-testkit";

import { createCanonicalTurnTreePaths } from "./backend-memory-test-helpers.js";

/**
 * One byte field handed to the backend, with the own-property fingerprint it
 * must keep: `cbor-x` leaves its `dataView` marker as an extra own property.
 */
interface ByteFieldProbe {
  readonly buffer: Uint8Array;
  readonly label: string;
  readonly ownKeys: (string | symbol)[];
}

/**
 * The caller-owned records every byte-carrying repository write accepts, plus
 * the schema the turn tree needs.
 */
interface CallerRecords {
  readonly annotation: StoredObserveAnnotation;
  readonly branch: StoredBranch;
  readonly eventObject: StoredObject;
  readonly interruptedResult: StoredStagedResult;
  readonly orderedPathChunk: StoredOrderedPathChunk;
  readonly run: StoredRun;
  readonly schema: TurnTreeSchema;
  readonly schemaRecord: StoredSchema;
  readonly thread: StoredThread;
  readonly turn: StoredTurn;
  readonly turnNode: StoredTurnNode;
  readonly turnTree: StoredTurnTree;
  readonly turnTreePaths: StoredTurnTreePath[];
}

/** The canonical manifest the memory test schema accepts. */
const emptyManifest: TurnTreeManifest = {
  "context.manifest": null,
  messages: [],
};

/** The identity-validator rejection a tampered turn tree must produce. */
const DETERMINISTIC_HASH_ERROR = /deterministic hash/u;

/**
 * Builds one caller-owned instance of every byte-carrying record family, so a
 * test can assert the backend never mutates or aliases the caller's buffers.
 */
async function createCallerRecords(): Promise<CallerRecords> {
  const schema = createSchema();
  const schemaRecord = createStoredSchema(schema, 100);
  const turnTree = await createStoredTurnTree(schema, emptyManifest, 101);
  const eventObject = await createStoredObject(new Uint8Array([9, 9, 9]), 102);
  const turnNode = await createStoredTurnNode({
    consumedStagedResults: [],
    createdAtMs: 103,
    eventHash: eventObject.hash,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 104,
    rootTurnNodeHash: turnNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_buffer_ownership",
  };
  const branch: StoredBranch = {
    branchId: "branch_buffer_ownership",
    createdAtMs: 105,
    headTurnNodeHash: turnNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 105,
  };
  const turn: StoredTurn = {
    branchId: branch.branchId,
    createdAtMs: 106,
    headTurnNodeHash: turnNode.hash,
    parentTurnId: null,
    startTurnNodeHash: turnNode.hash,
    threadId: thread.threadId,
    turnId: "turn_buffer_ownership",
    updatedAtMs: 106,
  };
  const run: StoredRun = {
    branchId: branch.branchId,
    createdAtMs: 107,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 0,
    runId: "run_buffer_ownership",
    schemaId: schema.schemaId,
    startTurnNodeHash: turnNode.hash,
    status: "running",
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ]),
    turnId: turn.turnId,
    updatedAtMs: 108,
  };
  const orderedPathChunk = await createStoredOrderedPathChunk(
    createHashSequence(3, 40),
    109
  );
  const interruptedResult: StoredStagedResult = {
    createdAtMs: 110,
    interruptPayloadCbor: encodeDeterministicKernelRecord({
      reason: "approval_required",
    }),
    objectHash: eventObject.hash,
    objectType: "message",
    runId: run.runId,
    status: "interrupted",
    taskId: "message_interrupted",
  };
  const annotation: StoredObserveAnnotation = {
    annotationCbor: encodeDeterministicKernelRecord({ note: "observed" }),
    annotationHash: createHashFromIndex(50),
    createdAtMs: 111,
    runId: run.runId,
    turnNodeHash: turnNode.hash,
  };

  return {
    annotation,
    branch,
    eventObject,
    interruptedResult,
    orderedPathChunk,
    run,
    schema,
    schemaRecord,
    thread,
    turn,
    turnNode,
    turnTree,
    turnTreePaths: createCanonicalTurnTreePaths(turnTree, []),
  };
}

/** Writes every caller record into the transaction's draft state. */
async function writeCallerRecords(
  tx: KrakenBackendTx,
  records: CallerRecords
): Promise<void> {
  await tx.schemas.put(records.schemaRecord);
  await tx.turnTrees.put(records.turnTree);
  await tx.turnTreePaths.putMany(records.turnTreePaths);
  await tx.objects.put(records.eventObject);
  await tx.orderedPathChunks.put(records.orderedPathChunk);
  await tx.turnNodes.put(records.turnNode);
  await tx.threads.put(records.thread);
  await tx.branches.set(records.branch);
  await tx.turns.set(records.turn);
  await tx.runs.set(records.run);
  await tx.stagedResults.set(records.interruptedResult);
  await tx.observeAnnotations.set(records.annotation);
}

/** Collects a fingerprint for every byte field reachable from `value`. */
function collectByteFieldProbes(
  value: unknown,
  label: string,
  probes: ByteFieldProbe[] = []
): ByteFieldProbe[] {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectByteFieldProbes(item, `${label}[${index}]`, probes);
    }

    return probes;
  }

  if (value === null || typeof value !== "object") {
    return probes;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (nested instanceof Uint8Array) {
      probes.push({
        buffer: nested,
        label: `${label}.${key}`,
        ownKeys: Reflect.ownKeys(nested),
      });
      continue;
    }

    collectByteFieldProbes(nested, `${label}.${key}`, probes);
  }

  return probes;
}

/**
 * Asserts that no decoded buffer gained own properties (the `dataView` marker
 * `cbor-x` attaches) and that every byte field still holds its original bytes.
 */
function expectByteFieldsUnmutated(
  probes: readonly ByteFieldProbe[],
  originals: ReadonlyMap<string, Uint8Array>
): void {
  expect(probes.length).toBeGreaterThan(0);

  for (const probe of probes) {
    expect({
      label: probe.label,
      ownKeys: Reflect.ownKeys(probe.buffer),
    }).toEqual({ label: probe.label, ownKeys: probe.ownKeys });
    expect({
      label: probe.label,
      content: Array.from(probe.buffer),
    }).toEqual({
      label: probe.label,
      content: Array.from(originals.get(probe.label) ?? probe.buffer),
    });
  }
}

/** Snapshots every probed byte field's content, keyed by probe label. */
function snapshotByteFields(
  probes: readonly ByteFieldProbe[]
): Map<string, Uint8Array> {
  return new Map(
    probes.map((probe) => [probe.label, Uint8Array.from(probe.buffer)])
  );
}

describe("@tuvren/backend-memory buffer ownership", () => {
  test("keeps caller byte fields untouched by writes and identity validation", async () => {
    const backend = createMemoryBackend();
    const records = await createCallerRecords();
    const probes = collectByteFieldProbes(records, "records");
    const originals = snapshotByteFields(probes);

    await backend.transact((tx) => writeCallerRecords(tx, records));
    expectByteFieldsUnmutated(probes, originals);

    // The updated run reuses the caller's byte fields, so the update path's
    // append-only lineage decode must not touch them either.
    await backend.transact(async (tx) => {
      await tx.stagedResults.clearRun(records.run.runId);
      await tx.runs.set({
        ...records.run,
        status: "failed",
        updatedAtMs: 120,
      });
    });
    expectByteFieldsUnmutated(probes, originals);

    await backend.transact(async (tx) => {
      await tx.runs.get(records.run.runId);
      await tx.turnNodes.get(records.turnNode.hash);
      await tx.turnTrees.get(records.turnTree.hash);
      await tx.turnTreePaths.listByTurnTree(records.turnTree.hash);
      await tx.observeAnnotations.listByRun(records.run.runId);
    });
    expectByteFieldsUnmutated(probes, originals);
  });

  test("keeps stored bytes owned by the backend after a write", async () => {
    const backend = createMemoryBackend();
    const records = await createCallerRecords();
    const probes = collectByteFieldProbes(records, "records");
    const originals = snapshotByteFields(probes);

    await backend.transact((tx) => writeCallerRecords(tx, records));

    for (const probe of probes) {
      probe.buffer.fill(0);
    }

    const stored = await backend.transact((tx) =>
      tx.runs.get(records.run.runId)
    );
    const storedNode = await backend.transact((tx) =>
      tx.turnNodes.get(records.turnNode.hash)
    );
    const storedTree = await backend.transact((tx) =>
      tx.turnTrees.get(records.turnTree.hash)
    );
    const storedSchema = await backend.transact((tx) =>
      tx.schemas.get(records.schemaRecord.schemaId)
    );

    expect(Array.from(stored?.stepSequenceCbor ?? [])).toEqual(
      Array.from(originals.get("records.run.stepSequenceCbor") ?? [])
    );
    expect(Array.from(stored?.createdTurnNodesCbor ?? [])).toEqual(
      Array.from(originals.get("records.run.createdTurnNodesCbor") ?? [])
    );
    expect(Array.from(storedNode?.consumedStagedResultsCbor ?? [])).toEqual(
      Array.from(
        originals.get("records.turnNode.consumedStagedResultsCbor") ?? []
      )
    );
    expect(Array.from(storedTree?.manifestCbor ?? [])).toEqual(
      Array.from(originals.get("records.turnTree.manifestCbor") ?? [])
    );
    expect(Array.from(storedSchema?.schemaCbor ?? [])).toEqual(
      Array.from(originals.get("records.schemaRecord.schemaCbor") ?? [])
    );
  });

  test("keeps bytes returned by a read detached from stored state", async () => {
    const backend = createMemoryBackend();
    const records = await createCallerRecords();
    const probes = collectByteFieldProbes(records, "records");
    const originals = snapshotByteFields(probes);

    await backend.transact((tx) => writeCallerRecords(tx, records));

    const first = await backend.transact((tx) =>
      tx.runs.get(records.run.runId)
    );
    const firstStepSequence = first?.stepSequenceCbor;

    expect(firstStepSequence).toBeInstanceOf(Uint8Array);
    expect(firstStepSequence).not.toBe(records.run.stepSequenceCbor);
    expect(Reflect.ownKeys(firstStepSequence ?? [])).toEqual(
      probes.find((probe) => probe.label === "records.run.stepSequenceCbor")
        ?.ownKeys ?? []
    );

    firstStepSequence?.fill(0);

    const second = await backend.transact((tx) =>
      tx.runs.get(records.run.runId)
    );

    expect(Array.from(second?.stepSequenceCbor ?? [])).toEqual(
      Array.from(originals.get("records.run.stepSequenceCbor") ?? [])
    );
    expect(second?.stepSequenceCbor).not.toBe(firstStepSequence);
    expectByteFieldsUnmutated(probes, originals);
  });

  test("keeps caller byte fields untouched when a write is rejected", async () => {
    const backend = createMemoryBackend();
    const records = await createCallerRecords();
    const tamperedTurnTree: StoredTurnTree = {
      ...records.turnTree,
      hash: createHashFromIndex(777),
    };
    const probes = collectByteFieldProbes(
      { tamperedTurnTree },
      "tamperedTurnTree"
    );
    const originals = snapshotByteFields(probes);

    await expect(
      backend.transact(async (tx) => {
        await tx.schemas.put(records.schemaRecord);
        await tx.turnTrees.put(tamperedTurnTree);
      })
    ).rejects.toThrow(DETERMINISTIC_HASH_ERROR);

    expectByteFieldsUnmutated(probes, originals);

    const storedTurnTree = await backend.transact((tx) =>
      tx.turnTrees.get(tamperedTurnTree.hash)
    );
    const storedSchema = await backend.transact((tx) =>
      tx.schemas.get(records.schemaRecord.schemaId)
    );

    expect(storedTurnTree).toBeNull();
    expect(storedSchema).toBeNull();
  });

  test("keeps caller byte fields untouched and committed state intact on rollback", async () => {
    const backend = createMemoryBackend();
    const records = await createCallerRecords();
    const probes = collectByteFieldProbes(records, "records");
    const originals = snapshotByteFields(probes);

    await backend.transact((tx) => writeCallerRecords(tx, records));
    expectByteFieldsUnmutated(probes, originals);

    await expect(
      backend.transact(async (tx) => {
        await tx.stagedResults.set({
          ...records.interruptedResult,
          taskId: "message_rolled_back",
        });
        await tx.runs.set({
          ...records.run,
          status: "failed",
          updatedAtMs: 200,
        });
        throw new Error("buffer ownership rollback probe");
      })
    ).rejects.toThrow("buffer ownership rollback probe");

    expectByteFieldsUnmutated(probes, originals);

    const stored = await backend.transact((tx) =>
      tx.runs.get(records.run.runId)
    );
    const stagedResults = await backend.transact((tx) =>
      tx.stagedResults.listByRun(records.run.runId)
    );

    expect(stored?.status).toBe("running");
    expect(stored?.updatedAtMs).toBe(records.run.updatedAtMs);
    expect(Array.from(stored?.stepSequenceCbor ?? [])).toEqual(
      Array.from(originals.get("records.run.stepSequenceCbor") ?? [])
    );
    expect(stagedResults.map((result) => result.taskId)).toEqual([
      records.interruptedResult.taskId,
    ]);
    expectByteFieldsUnmutated(probes, originals);
  });
});
