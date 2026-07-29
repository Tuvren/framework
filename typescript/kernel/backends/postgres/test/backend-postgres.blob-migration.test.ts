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

// Issue #110 / ADR-067 coverage gaps closed here:
//
// 1. The scope-isolation suite's blob-migration test seeds only a single
//    `objects` row, so it never proves the open-time migration explodes every
//    record family (and specifically the observe-annotation duplicate-count
//    suffix path, ASCII-unit-separator record keys) faithfully. This file
//    builds a realistic multi-family `BackendState` through a real kernel
//    over a real backend, encodes it with the legacy blob wire format, seeds
//    a fresh schema with that legacy shape, and proves the relational
//    migration reproduces it exactly.
// 2. The live (non-migration) write path for duplicate-identity observe
//    annotations — two annotations sharing (runId, createdAtMs,
//    annotationHash, turnNodeHash) — is exercised directly through
//    `backend.transact`/`tx.observeAnnotations.set`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_SCOPE } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type StoredObserveAnnotation,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createPostgresBackend,
  type PostgresBackendOptions,
} from "../src/index.js";
import { CURRENT_SNAPSHOT_VERSION } from "../src/lib/postgres-legacy-snapshot-decode.js";
import {
  type BackendState,
  createEmptyState,
  loadState,
} from "../src/lib/postgres-records.js";
import type { RelationalTableName } from "../src/lib/postgres-schema.js";
import { qualifyIdentifier, quoteIdentifier } from "../src/lib/postgres-sql.js";
import { areBytesEqual } from "../src/lib/postgres-state-utils.js";
import { encodeSnapshot } from "./legacy-snapshot-encoder.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createAdminClient,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_postgres_blob_migration",
} satisfies TurnTreeSchema;

// The ADR-011 chunk-aware ordered-path threshold (mirrors
// backend-postgres.turn-tree-chunk-aware-writes.test.ts): growing an ordered
// collection past this many entries flips its storage from a flat inline
// encoding to chunked `ordered_path_chunks` rows.
const CHUNK_THRESHOLD = 32;

function createMonotonicClock(start: number): () => number {
  let clock = start;
  return () => {
    clock += 1;
    return clock;
  };
}

async function seededHashes(count: number, seed: string): Promise<string[]> {
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    hashes.push(await hashKernelRecord(`${seed}-${index}`));
  }
  return hashes;
}

function countNestedValues<K, V>(outer: Map<K, Map<string, V>>): number {
  let total = 0;
  for (const inner of outer.values()) {
    total += inner.size;
  }
  return total;
}

// `loadState` (and the exported `encodeSnapshot`'s own internal
// `cloneStoredX`/`cloneEncodedBytes` helpers) attach a non-index `dataView`
// own property to every decoded CBOR-carrying `Uint8Array` field, so the
// deterministic decoder can re-view encoded payloads. That marker property
// makes those byte arrays fail the strict `KernelRecord` profile
// (`Uint8Array` values "must carry no extra own properties beyond their
// indices") that `encodeDeterministicKernelRecord` enforces on its whole
// input tree — so `encodeSnapshot` cannot itself encode a state that
// touches any family beyond `objects` (whose clone path uses plain
// `cloneBytes`, not `cloneEncodedBytes`). This local encoder mirrors
// `encodeSnapshot`'s exact field mapping but strips that marker via a plain
// `Uint8Array.from` copy first, so it can build a legacy snapshot blob
// spanning every record family for this test's seed data.
function plainBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function toPlainStoredRun(record: StoredRun): StoredRun {
  return {
    ...record,
    createdTurnNodesCbor: plainBytes(record.createdTurnNodesCbor),
    stepSequenceCbor: plainBytes(record.stepSequenceCbor),
    ...(record.pendingSignalsCbor === undefined
      ? {}
      : { pendingSignalsCbor: plainBytes(record.pendingSignalsCbor) }),
  };
}

function toPlainStoredStagedResult(
  record: StoredStagedResult
): StoredStagedResult {
  if (record.status === "interrupted") {
    return {
      ...record,
      interruptPayloadCbor: plainBytes(record.interruptPayloadCbor),
    };
  }
  return { ...record };
}

function toPlainStoredTurnTreePath(
  record: StoredTurnTreePath
): StoredTurnTreePath {
  if (record.collectionKind === "single") {
    return { ...record };
  }
  if (record.orderedEncoding === "flat") {
    return {
      ...record,
      orderedInlineCbor: plainBytes(record.orderedInlineCbor),
    };
  }
  return {
    ...record,
    orderedChunkListCbor: plainBytes(record.orderedChunkListCbor),
  };
}

function toPlainStoredTurnNode(record: StoredTurnNode): StoredTurnNode {
  return {
    ...record,
    consumedStagedResultsCbor: plainBytes(record.consumedStagedResultsCbor),
  };
}

function toPlainStoredSchema(record: StoredSchema): StoredSchema {
  return { ...record, schemaCbor: plainBytes(record.schemaCbor) };
}

function toPlainStoredTurnTree(record: StoredTurnTree): StoredTurnTree {
  return { ...record, manifestCbor: plainBytes(record.manifestCbor) };
}

function toPlainStoredOrderedPathChunk(
  record: StoredOrderedPathChunk
): StoredOrderedPathChunk {
  return { ...record, itemsCbor: plainBytes(record.itemsCbor) };
}

function toPlainStoredObserveAnnotation(
  record: StoredObserveAnnotation
): StoredObserveAnnotation {
  return { ...record, annotationCbor: plainBytes(record.annotationCbor) };
}

function encodeLegacySnapshotForTest(state: BackendState): Uint8Array {
  const snapshot = {
    branches: Array.from(state.branches.values(), (record) => ({
      ...record,
    })),
    objects: Array.from(state.objects.values(), (record) => ({
      ...record,
      bytes: plainBytes(record.bytes),
    })),
    observeAnnotations: Array.from(state.observeAnnotations.values())
      .flat()
      .map(toPlainStoredObserveAnnotation),
    orderedPathChunks: Array.from(
      state.orderedPathChunks.values(),
      toPlainStoredOrderedPathChunk
    ),
    runs: Array.from(state.runs.values(), toPlainStoredRun),
    schemas: Array.from(state.schemas.values(), toPlainStoredSchema),
    stagedResults: Array.from(state.stagedResults.values()).flatMap((byTask) =>
      Array.from(byTask.values(), toPlainStoredStagedResult)
    ),
    threads: Array.from(state.threads.values(), (record) => ({ ...record })),
    turnNodes: Array.from(state.turnNodes.values(), toPlainStoredTurnNode),
    turnTreePaths: Array.from(state.turnTreePaths.values()).flatMap((byPath) =>
      Array.from(byPath.values(), toPlainStoredTurnTreePath)
    ),
    turnTrees: Array.from(state.turnTrees.values(), toPlainStoredTurnTree),
    turns: Array.from(state.turns.values(), (record) => ({ ...record })),
    version: CURRENT_SNAPSHOT_VERSION,
  } satisfies Record<string, unknown>;

  return encodeDeterministicKernelRecord(
    snapshot as unknown as Parameters<typeof encodeDeterministicKernelRecord>[0]
  );
}

interface LegacySnapshotSeedRow {
  schemaVersion: number;
  scope: string;
  snapshotCbor: Uint8Array;
  /** Defaults to `1`, the only value the retired legacy writer ever wrote. */
  snapshotId?: number;
}

/**
 * Seeds a fresh schema with the pre-relational (blob-per-scope) shape: the
 * migrations ledger plus `backend_postgres_snapshots`, populated with one row
 * per entry in `rows`. Shared by every test below that needs to force the
 * open-time migration over a specific legacy shape (multi-scope, or a single
 * scope with a deliberately malformed row).
 */
async function seedLegacySnapshotSchema(
  options: PostgresBackendOptions,
  rows: LegacySnapshotSeedRow[]
): Promise<void> {
  const schemaName = options.schemaName ?? "public";
  const qSchema = quoteIdentifier(schemaName);
  const snapshotsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_snapshots"
  );
  const migrationsTable = qualifyIdentifier(
    schemaName,
    "backend_postgres_migrations"
  );

  const seedAdmin = createAdminClient(options);
  try {
    await seedAdmin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${qSchema}`);
    await seedAdmin.unsafe(
      `CREATE TABLE ${migrationsTable} (
         name TEXT PRIMARY KEY,
         applied_at_ms BIGINT NOT NULL
       )`
    );
    await seedAdmin.unsafe(
      `CREATE TABLE ${snapshotsTable} (
         snapshot_id SMALLINT NOT NULL,
         scope TEXT NOT NULL,
         schema_version INTEGER NOT NULL,
         snapshot_cbor BYTEA NOT NULL,
         updated_at_ms BIGINT NOT NULL,
         PRIMARY KEY (snapshot_id, scope)
       )`
    );
    await seedAdmin.unsafe(
      `INSERT INTO ${migrationsTable} (name, applied_at_ms)
       VALUES ('0001_initial_schema.sql', $1), ('0002_scope_partition.sql', $1)`,
      [Date.now()]
    );
    for (const row of rows) {
      await seedAdmin.unsafe(
        `INSERT INTO ${snapshotsTable} (
           snapshot_id, scope, schema_version, snapshot_cbor, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          row.snapshotId ?? 1,
          row.scope,
          row.schemaVersion,
          row.snapshotCbor,
          Date.now(),
        ]
      );
    }
  } finally {
    await seedAdmin.end({ timeout: 0 });
  }
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres blob->row migration full-family coverage (ADR-067)", () => {
  test("migrates a legacy blob snapshot spanning every record family, including duplicate observe-annotation identity and chunked ordered paths, without data loss", async () => {
    // --- Build a realistic multi-family scope through a real kernel over a
    // real backend, touching every persisted record family. ---
    const sourceOptions = createPostgresTestBackendOptions();
    const sourceBackend = createPostgresBackend(sourceOptions);
    const now = createMonotonicClock(1_700_000_000_000);
    const kernel = createRuntimeKernel({ backend: sourceBackend, now });

    const schemaId = await kernel.schema.register(TEST_SCHEMA);

    const threadId = "thread_migration_full";
    const branchId = "branch_migration_full";
    const thread = await kernel.thread.create(threadId, schemaId, branchId);

    const turnId = "turn_migration_full";
    const turn = await kernel.turn.create(
      turnId,
      threadId,
      branchId,
      null,
      thread.rootTurnNodeHash
    );

    const runId = "run_migration_full";
    await kernel.run.create(
      runId,
      turn.turnId,
      branchId,
      schemaId,
      thread.rootTurnNodeHash,
      [
        { deterministic: false, id: "step_1", sideEffects: false },
        { deterministic: false, id: "step_2", sideEffects: false },
        { deterministic: false, id: "step_3", sideEffects: false },
      ]
    );

    // Three checkpointing steps chain three turn nodes off the genesis node
    // (previousTurnNodeHash links), giving a parent chain of lineage depth 3.
    let lastTurnNodeHash = thread.rootTurnNodeHash;
    const stepIds = ["step_1", "step_2", "step_3"];
    for (const [index, stepId] of stepIds.entries()) {
      const eventHash = await kernel.store.put(
        new Uint8Array([10 + index, 20 + index, 30 + index]),
        "application/event"
      );
      const isLastStep = index === stepIds.length - 1;
      // The last step also emits two annotations with identical content, so
      // they land with identical (runId, createdAtMs, annotationHash,
      // turnNodeHash) — the duplicate-count record_key suffix path.
      const observeResults = isLastStep
        ? [
            {
              annotations: [
                { note: "duplicate-annotation" },
                { note: "duplicate-annotation" },
              ],
              signals: [],
            },
          ]
        : undefined;
      const completed = await kernel.run.completeStep(
        runId,
        stepId,
        eventHash,
        observeResults
      );
      if (completed.turnNodeHash === undefined) {
        throw new Error(`expected step "${stepId}" to checkpoint`);
      }
      lastTurnNodeHash = completed.turnNodeHash;
    }

    // staged_results across all three statuses, including an interrupted one
    // carrying a resume payload.
    await kernel.staging.stage(
      runId,
      new Uint8Array([91]),
      "task_completed",
      "note",
      "completed"
    );
    await kernel.staging.stage(
      runId,
      new Uint8Array([92, 92]),
      "task_failed",
      "note",
      "failed"
    );
    await kernel.staging.stage(
      runId,
      new Uint8Array([93, 93, 93]),
      "task_interrupted",
      "note",
      "interrupted",
      { resumeToken: "resume-abc" }
    );

    // A second thread whose ordered "messages" path is grown past the
    // ADR-011 chunking threshold, to cover ordered_path_chunks rows and a
    // chunked turn_tree_paths variant alongside the first thread's flat one.
    const threadId2 = "thread_migration_chunked";
    const branchId2 = "branch_migration_chunked";
    const thread2 = await kernel.thread.create(threadId2, schemaId, branchId2);
    const rootNode2 = await kernel.node.get(thread2.rootTurnNodeHash);
    if (rootNode2 === null) {
      throw new Error("expected the second thread's root turn node to exist");
    }
    let chunkedTreeHash = rootNode2.turnTreeHash;
    const chunkHashes = await seededHashes(
      CHUNK_THRESHOLD + 2,
      "migration-chunk"
    );
    for (const [index, hash] of chunkHashes.entries()) {
      chunkedTreeHash = await kernel.tree.incorporate(chunkedTreeHash, [
        {
          objectHash: hash,
          objectType: "message",
          status: "completed",
          taskId: `chunk_task_${index}`,
          timestamp: 1,
        },
      ]);
    }
    const chunkedPath = await sourceBackend.transact(async (tx) =>
      tx.turnTreePaths.get(chunkedTreeHash, "messages")
    );
    if (
      chunkedPath?.collectionKind !== "ordered" ||
      chunkedPath.orderedEncoding !== "chunked"
    ) {
      throw new Error(
        "expected the grown ordered path to have flipped to the chunked encoding"
      );
    }

    // --- Load the source scope's full committed state and encode it into the
    // retired legacy blob-per-scope wire format. ---
    const sourceSchemaName = sourceOptions.schemaName ?? "public";
    const sourceAdmin = createAdminClient(sourceOptions);
    let state: BackendState;
    try {
      state = await loadState(sourceAdmin, sourceSchemaName, DEFAULT_SCOPE);
    } finally {
      await sourceAdmin.end({ timeout: 0 });
    }
    await sourceBackend.destroy();

    // Sanity on the shape built above before round-tripping it: every family
    // has at least one row, the parent chain has depth (root + 3 checkpoints),
    // and the duplicate annotation pair is present under one run.
    expect(state.objects.size).toBeGreaterThanOrEqual(6);
    expect(state.schemas.size).toBeGreaterThanOrEqual(1);
    expect(state.turnTrees.size).toBeGreaterThan(CHUNK_THRESHOLD);
    expect(state.orderedPathChunks.size).toBeGreaterThan(0);
    expect(state.turnNodes.size).toBeGreaterThanOrEqual(5);
    expect(state.threads.size).toBe(2);
    expect(state.branches.size).toBe(2);
    expect(state.turns.size).toBe(1);
    expect(state.runs.size).toBe(1);
    expect(countNestedValues(state.stagedResults)).toBe(3);
    expect(state.observeAnnotations.get(runId)?.length).toBe(2);

    const snapshotBytes = encodeLegacySnapshotForTest(state);

    // --- Seed a fresh schema with the pre-relational (blob-per-scope) shape,
    // then open the relational backend over it, forcing the open-time
    // migration to explode the blob into every family table. ---
    const targetOptions = createPostgresTestBackendOptions();
    const targetSchemaName = targetOptions.schemaName ?? "public";
    const qSchema = quoteIdentifier(targetSchemaName);
    const snapshotsTable = qualifyIdentifier(
      targetSchemaName,
      "backend_postgres_snapshots"
    );
    const migrationsTable = qualifyIdentifier(
      targetSchemaName,
      "backend_postgres_migrations"
    );

    const seedAdmin = createAdminClient(targetOptions);
    try {
      await seedAdmin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${qSchema}`);
      await seedAdmin.unsafe(
        `CREATE TABLE ${migrationsTable} (
           name TEXT PRIMARY KEY,
           applied_at_ms BIGINT NOT NULL
         )`
      );
      await seedAdmin.unsafe(
        `CREATE TABLE ${snapshotsTable} (
           snapshot_id SMALLINT NOT NULL,
           scope TEXT NOT NULL,
           schema_version INTEGER NOT NULL,
           snapshot_cbor BYTEA NOT NULL,
           updated_at_ms BIGINT NOT NULL,
           PRIMARY KEY (snapshot_id, scope)
         )`
      );
      await seedAdmin.unsafe(
        `INSERT INTO ${migrationsTable} (name, applied_at_ms)
         VALUES ('0001_initial_schema.sql', $1), ('0002_scope_partition.sql', $1)`,
        [Date.now()]
      );
      await seedAdmin.unsafe(
        `INSERT INTO ${snapshotsTable} (
           snapshot_id, scope, schema_version, snapshot_cbor, updated_at_ms
         ) VALUES (1, $1, 1, $2, $3)`,
        [DEFAULT_SCOPE, snapshotBytes, Date.now()]
      );
    } finally {
      await seedAdmin.end({ timeout: 0 });
    }

    const migrated = createPostgresBackend(targetOptions);
    const fsckResult = await migrated.fsck();
    expect(fsckResult).toEqual({ ok: true });

    const verify = createAdminClient(targetOptions);
    try {
      // The legacy blob table is retired after migration.
      const snapshotTables = await verify.unsafe<Array<{ table_name: string }>>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = $1
            AND table_name = 'backend_postgres_snapshots'`,
        [targetSchemaName]
      );
      expect(snapshotTables.length).toBe(0);

      // Per-family row counts match the seeded state exactly.
      const simpleFamilyCounts: [RelationalTableName, number][] = [
        ["objects", state.objects.size],
        ["schemas", state.schemas.size],
        ["turn_trees", state.turnTrees.size],
        ["ordered_path_chunks", state.orderedPathChunks.size],
        ["turn_nodes", state.turnNodes.size],
        ["threads", state.threads.size],
        ["branches", state.branches.size],
        ["turns", state.turns.size],
        ["runs", state.runs.size],
        ["staged_results", countNestedValues(state.stagedResults)],
        ["turn_tree_paths", countNestedValues(state.turnTreePaths)],
      ];

      for (const [table, expectedCount] of simpleFamilyCounts) {
        const qualifiedTable = qualifyIdentifier(targetSchemaName, table);
        const rows = await verify.unsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count FROM ${qualifiedTable} WHERE scope = $1`,
          [DEFAULT_SCOPE]
        );
        expect(Number(rows[0]?.count ?? -1)).toBe(expectedCount);
      }

      // observe_annotations: total count, plus the duplicate-identity pair
      // specifically (distinct record_keys, no NUL byte, matching content).
      const expectedAnnotationCount = Array.from(
        state.observeAnnotations.values()
      ).reduce((total, records) => total + records.length, 0);
      const annotationTable = qualifyIdentifier(
        targetSchemaName,
        "observe_annotations"
      );
      const annotationRows = await verify.unsafe<
        Array<{
          annotation_cbor: Uint8Array;
          annotation_hash: string;
          created_at_ms: number;
          record_key: string;
          run_id: string;
          turn_node_hash: string | null;
        }>
      >(
        `SELECT record_key, run_id, annotation_hash, turn_node_hash, created_at_ms, annotation_cbor
           FROM ${annotationTable}
          WHERE scope = $1
          ORDER BY record_key`,
        [DEFAULT_SCOPE]
      );
      expect(annotationRows.length).toBe(expectedAnnotationCount);

      const duplicatePair = annotationRows.filter(
        (row) => row.run_id === runId
      );
      expect(duplicatePair.length).toBe(2);
      const [first, second] = duplicatePair;
      expect(first?.record_key).not.toBe(second?.record_key);
      expect(first?.record_key.includes("\0")).toBe(false);
      expect(second?.record_key.includes("\0")).toBe(false);
      expect(first?.created_at_ms).toBe(second?.created_at_ms);
      expect(first?.annotation_hash).toBe(second?.annotation_hash);
      expect(first?.turn_node_hash).toBe(second?.turn_node_hash);
      expect(first?.turn_node_hash).toBe(lastTurnNodeHash);
      expect(
        areBytesEqual(
          new Uint8Array(first?.annotation_cbor ?? []),
          new Uint8Array(second?.annotation_cbor ?? [])
        )
      ).toBe(true);

      // Spot-check content equality on at least one record per family.
      const runRow = await verify.unsafe<
        Array<{
          branch_id: string;
          current_step_index: number;
          schema_id: string;
          status: string;
        }>
      >(
        `SELECT branch_id, schema_id, status, current_step_index
           FROM ${qualifyIdentifier(targetSchemaName, "runs")}
          WHERE scope = $1 AND run_id = $2`,
        [DEFAULT_SCOPE, runId]
      );
      const expectedRun = state.runs.get(runId);
      if (expectedRun === undefined) {
        throw new Error("expected the seeded run to be present in state");
      }
      expect(runRow[0]?.status).toBe(expectedRun.status);
      expect(runRow[0]?.branch_id).toBe(expectedRun.branchId);
      expect(runRow[0]?.schema_id).toBe(expectedRun.schemaId);
      expect(Number(runRow[0]?.current_step_index)).toBe(
        expectedRun.currentStepIndex
      );

      const threadRow = await verify.unsafe<
        Array<{ root_turn_node_hash: string; schema_id: string }>
      >(
        `SELECT root_turn_node_hash, schema_id
           FROM ${qualifyIdentifier(targetSchemaName, "threads")}
          WHERE scope = $1 AND thread_id = $2`,
        [DEFAULT_SCOPE, threadId]
      );
      expect(threadRow[0]?.root_turn_node_hash).toBe(thread.rootTurnNodeHash);
      expect(threadRow[0]?.schema_id).toBe(schemaId);

      const branchRow = await verify.unsafe<
        Array<{ head_turn_node_hash: string }>
      >(
        `SELECT head_turn_node_hash
           FROM ${qualifyIdentifier(targetSchemaName, "branches")}
          WHERE scope = $1 AND branch_id = $2`,
        [DEFAULT_SCOPE, branchId]
      );
      expect(branchRow[0]?.head_turn_node_hash).toBe(lastTurnNodeHash);

      const turnRow = await verify.unsafe<
        Array<{ head_turn_node_hash: string; start_turn_node_hash: string }>
      >(
        `SELECT start_turn_node_hash, head_turn_node_hash
           FROM ${qualifyIdentifier(targetSchemaName, "turns")}
          WHERE scope = $1 AND turn_id = $2`,
        [DEFAULT_SCOPE, turnId]
      );
      expect(turnRow[0]?.start_turn_node_hash).toBe(thread.rootTurnNodeHash);
      expect(turnRow[0]?.head_turn_node_hash).toBe(lastTurnNodeHash);

      const turnNodeRow = await verify.unsafe<
        Array<{
          consumed_staged_results_cbor: Uint8Array;
          previous_turn_node_hash: string | null;
        }>
      >(
        `SELECT previous_turn_node_hash, consumed_staged_results_cbor
           FROM ${qualifyIdentifier(targetSchemaName, "turn_nodes")}
          WHERE scope = $1 AND hash = $2`,
        [DEFAULT_SCOPE, lastTurnNodeHash]
      );
      const expectedTurnNode = state.turnNodes.get(lastTurnNodeHash);
      if (expectedTurnNode === undefined) {
        throw new Error("expected the last checkpoint turn node in state");
      }
      expect(turnNodeRow[0]?.previous_turn_node_hash).toBe(
        expectedTurnNode.previousTurnNodeHash
      );
      expect(
        areBytesEqual(
          new Uint8Array(turnNodeRow[0]?.consumed_staged_results_cbor ?? []),
          expectedTurnNode.consumedStagedResultsCbor
        )
      ).toBe(true);

      const schemaRow = await verify.unsafe<Array<{ schema_cbor: Uint8Array }>>(
        `SELECT schema_cbor
           FROM ${qualifyIdentifier(targetSchemaName, "schemas")}
          WHERE scope = $1 AND schema_id = $2`,
        [DEFAULT_SCOPE, schemaId]
      );
      expect(
        areBytesEqual(
          new Uint8Array(schemaRow[0]?.schema_cbor ?? []),
          state.schemas.get(schemaId)?.schemaCbor ?? new Uint8Array()
        )
      ).toBe(true);

      const [sampleObjectHash, sampleObject] =
        [...state.objects.entries()][0] ?? [];
      if (sampleObjectHash === undefined || sampleObject === undefined) {
        throw new Error("expected at least one seeded object");
      }
      const objectRow = await verify.unsafe<
        Array<{
          byte_length: number;
          bytes: Uint8Array;
          created_at_ms: number;
          media_type: string;
        }>
      >(
        `SELECT media_type, bytes, byte_length, created_at_ms
           FROM ${qualifyIdentifier(targetSchemaName, "objects")}
          WHERE scope = $1 AND hash = $2`,
        [DEFAULT_SCOPE, sampleObjectHash]
      );
      expect(objectRow[0]?.media_type).toBe(sampleObject.mediaType);
      expect(Number(objectRow[0]?.byte_length)).toBe(sampleObject.byteLength);
      expect(Number(objectRow[0]?.created_at_ms)).toBe(
        sampleObject.createdAtMs
      );
      expect(
        areBytesEqual(
          new Uint8Array(objectRow[0]?.bytes ?? []),
          sampleObject.bytes
        )
      ).toBe(true);

      const [sampleChunkHash, sampleChunk] =
        [...state.orderedPathChunks.entries()][0] ?? [];
      if (sampleChunkHash === undefined || sampleChunk === undefined) {
        throw new Error("expected at least one seeded ordered path chunk");
      }
      const chunkRow = await verify.unsafe<
        Array<{ item_count: number; items_cbor: Uint8Array }>
      >(
        `SELECT item_count, items_cbor
           FROM ${qualifyIdentifier(targetSchemaName, "ordered_path_chunks")}
          WHERE scope = $1 AND chunk_hash = $2`,
        [DEFAULT_SCOPE, sampleChunkHash]
      );
      expect(Number(chunkRow[0]?.item_count)).toBe(sampleChunk.itemCount);
      expect(
        areBytesEqual(
          new Uint8Array(chunkRow[0]?.items_cbor ?? []),
          sampleChunk.itemsCbor
        )
      ).toBe(true);

      const chunkedPathRow = await verify.unsafe<
        Array<{ ordered_count: number; ordered_encoding: string | null }>
      >(
        `SELECT ordered_encoding, ordered_count
           FROM ${qualifyIdentifier(targetSchemaName, "turn_tree_paths")}
          WHERE scope = $1 AND turn_tree_hash = $2 AND path = 'messages'`,
        [DEFAULT_SCOPE, chunkedTreeHash]
      );
      expect(chunkedPathRow[0]?.ordered_encoding).toBe("chunked");
      expect(Number(chunkedPathRow[0]?.ordered_count)).toBe(
        CHUNK_THRESHOLD + 2
      );

      const stagedRow = await verify.unsafe<
        Array<{ interrupt_payload_cbor: Uint8Array | null; status: string }>
      >(
        `SELECT status, interrupt_payload_cbor
           FROM ${qualifyIdentifier(targetSchemaName, "staged_results")}
          WHERE scope = $1 AND run_id = $2 AND task_id = 'task_interrupted'`,
        [DEFAULT_SCOPE, runId]
      );
      expect(stagedRow[0]?.status).toBe("interrupted");
      expect(stagedRow[0]?.interrupt_payload_cbor).not.toBeNull();
      const expectedInterrupted = state.stagedResults
        .get(runId)
        ?.get("task_interrupted");
      expect(expectedInterrupted?.status).toBe("interrupted");
      if (expectedInterrupted?.status === "interrupted") {
        expect(
          areBytesEqual(
            new Uint8Array(stagedRow[0]?.interrupt_payload_cbor ?? []),
            expectedInterrupted.interruptPayloadCbor
          )
        ).toBe(true);
      }
    } finally {
      await verify.end({ timeout: 0 });
    }

    await migrated.destroy();
  }, 30_000);
});

describe("@tuvren/backend-postgres blob->row migration multi-scope coverage", () => {
  test("migrates two distinct scopes from the same legacy blob table without cross-scope leakage", async () => {
    // Two backend instances bound to different Scopes but sharing one
    // schema (ADR-048/049) build genuinely distinct family content: the
    // scope-isolation suite's original blob-migration coverage only ever
    // seeded one scope, so the per-scope loop, per-scope blob fetch, and
    // per-scope error attribution in `explodeLegacyBlobSnapshots` had no
    // automated check path.
    const sourceOptions = createPostgresTestBackendOptions();
    const scopeAlpha = "scope_migration_multi_alpha";
    const scopeBeta = "scope_migration_multi_beta";

    const backendAlpha = createPostgresBackend({
      ...sourceOptions,
      scope: scopeAlpha,
    });
    const kernelAlpha = createRuntimeKernel({
      backend: backendAlpha,
      now: createMonotonicClock(2_000_000_000_000),
    });
    const schemaIdAlpha = await kernelAlpha.schema.register(TEST_SCHEMA);
    const threadAlpha = await kernelAlpha.thread.create(
      "thread_multi_alpha",
      schemaIdAlpha,
      "branch_multi_alpha"
    );
    await kernelAlpha.turn.create(
      "turn_multi_alpha",
      "thread_multi_alpha",
      "branch_multi_alpha",
      null,
      threadAlpha.rootTurnNodeHash
    );

    const backendBeta = createPostgresBackend({
      ...sourceOptions,
      scope: scopeBeta,
    });
    const kernelBeta = createRuntimeKernel({
      backend: backendBeta,
      now: createMonotonicClock(2_100_000_000_000),
    });
    const schemaIdBeta = await kernelBeta.schema.register(TEST_SCHEMA);
    const threadBeta = await kernelBeta.thread.create(
      "thread_multi_beta",
      schemaIdBeta,
      "branch_multi_beta"
    );
    await kernelBeta.turn.create(
      "turn_multi_beta",
      "thread_multi_beta",
      "branch_multi_beta",
      null,
      threadBeta.rootTurnNodeHash
    );

    const sourceSchemaName = sourceOptions.schemaName ?? "public";
    const sourceAdmin = createAdminClient(sourceOptions);
    let stateAlpha: BackendState;
    let stateBeta: BackendState;
    try {
      stateAlpha = await loadState(sourceAdmin, sourceSchemaName, scopeAlpha);
      stateBeta = await loadState(sourceAdmin, sourceSchemaName, scopeBeta);
    } finally {
      await sourceAdmin.end({ timeout: 0 });
    }
    await backendAlpha.destroy();
    await backendBeta.destroy();

    // Sanity: each scope actually produced disjoint, non-empty content
    // before it is round-tripped through the legacy wire format.
    expect(stateAlpha.threads.size).toBe(1);
    expect(stateBeta.threads.size).toBe(1);
    expect(stateAlpha.threads.has("thread_multi_alpha")).toBe(true);
    expect(stateAlpha.threads.has("thread_multi_beta")).toBe(false);
    expect(stateBeta.threads.has("thread_multi_beta")).toBe(true);
    expect(stateBeta.threads.has("thread_multi_alpha")).toBe(false);

    const targetOptions = createPostgresTestBackendOptions();
    const targetSchemaName = targetOptions.schemaName ?? "public";
    await seedLegacySnapshotSchema(targetOptions, [
      {
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope: scopeAlpha,
        snapshotCbor: encodeLegacySnapshotForTest(stateAlpha),
      },
      {
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope: scopeBeta,
        snapshotCbor: encodeLegacySnapshotForTest(stateBeta),
      },
    ]);

    const migrated = createPostgresBackend(targetOptions);
    try {
      const fsckResult = await migrated.fsck();
      expect(fsckResult).toEqual({ ok: true });

      const verify = createAdminClient(targetOptions);
      try {
        const simpleFamilyCounts: [RelationalTableName, number, number][] = [
          ["threads", stateAlpha.threads.size, stateBeta.threads.size],
          ["branches", stateAlpha.branches.size, stateBeta.branches.size],
          ["turns", stateAlpha.turns.size, stateBeta.turns.size],
          ["turn_nodes", stateAlpha.turnNodes.size, stateBeta.turnNodes.size],
          ["turn_trees", stateAlpha.turnTrees.size, stateBeta.turnTrees.size],
          ["schemas", stateAlpha.schemas.size, stateBeta.schemas.size],
        ];

        for (const [
          table,
          expectedAlphaCount,
          expectedBetaCount,
        ] of simpleFamilyCounts) {
          const qualifiedTable = qualifyIdentifier(targetSchemaName, table);
          const alphaRows = await verify.unsafe<Array<{ count: number }>>(
            `SELECT COUNT(*)::int AS count FROM ${qualifiedTable} WHERE scope = $1`,
            [scopeAlpha]
          );
          expect(Number(alphaRows[0]?.count ?? -1)).toBe(expectedAlphaCount);

          const betaRows = await verify.unsafe<Array<{ count: number }>>(
            `SELECT COUNT(*)::int AS count FROM ${qualifiedTable} WHERE scope = $1`,
            [scopeBeta]
          );
          expect(Number(betaRows[0]?.count ?? -1)).toBe(expectedBetaCount);
        }

        // Distinguishing record per scope, plus an explicit cross-scope
        // leakage check: scope alpha's rows carry scope alpha's thread id,
        // never scope beta's, and vice versa.
        const threadsTable = qualifyIdentifier(targetSchemaName, "threads");
        const alphaThreadRows = await verify.unsafe<
          Array<{ thread_id: string }>
        >(`SELECT thread_id FROM ${threadsTable} WHERE scope = $1`, [
          scopeAlpha,
        ]);
        expect(alphaThreadRows.map((row) => row.thread_id)).toEqual([
          "thread_multi_alpha",
        ]);

        const betaThreadRows = await verify.unsafe<
          Array<{ thread_id: string }>
        >(`SELECT thread_id FROM ${threadsTable} WHERE scope = $1`, [
          scopeBeta,
        ]);
        expect(betaThreadRows.map((row) => row.thread_id)).toEqual([
          "thread_multi_beta",
        ]);

        const crossLeakAlpha = await verify.unsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count FROM ${threadsTable}
            WHERE scope = $1 AND thread_id = $2`,
          [scopeAlpha, "thread_multi_beta"]
        );
        expect(Number(crossLeakAlpha[0]?.count ?? -1)).toBe(0);

        const crossLeakBeta = await verify.unsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count FROM ${threadsTable}
            WHERE scope = $1 AND thread_id = $2`,
          [scopeBeta, "thread_multi_alpha"]
        );
        expect(Number(crossLeakBeta[0]?.count ?? -1)).toBe(0);
      } finally {
        await verify.end({ timeout: 0 });
      }
    } finally {
      await migrated.destroy();
    }
  }, 30_000);
});

describe("@tuvren/backend-postgres blob->row migration typed diagnosis", () => {
  test("throws postgres_backend_blob_migration_version_unsupported for a legacy row with an unsupported schema_version", async () => {
    const targetOptions = createPostgresTestBackendOptions();
    const scope = "scope_migration_version_unsupported";
    const unsupportedVersion = CURRENT_SNAPSHOT_VERSION + 41;

    await seedLegacySnapshotSchema(targetOptions, [
      {
        schemaVersion: unsupportedVersion,
        scope,
        // The version check runs before the blob is ever fetched or
        // decoded, so the payload bytes here are never touched.
        snapshotCbor: new Uint8Array([0]),
      },
    ]);

    const migrated = createPostgresBackend(targetOptions);
    try {
      let caughtError: unknown;
      try {
        await migrated.transact(async () => undefined);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      const normalizedError = caughtError as Error & {
        code?: string;
        details?: unknown;
      };
      expect(normalizedError.code).toBe(
        "postgres_backend_blob_migration_version_unsupported"
      );
      expect(normalizedError.details).toEqual({
        actualVersion: unsupportedVersion,
        expectedVersion: CURRENT_SNAPSHOT_VERSION,
        scope,
      });
    } finally {
      await migrated.destroy({ dropSchema: true });
    }
  });

  test("throws postgres_backend_blob_migration_decode_failed for a legacy row whose blob is not valid deterministic CBOR", async () => {
    const targetOptions = createPostgresTestBackendOptions();
    const scope = "scope_migration_decode_failed";

    await seedLegacySnapshotSchema(targetOptions, [
      {
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope,
        snapshotCbor: new Uint8Array([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]),
      },
    ]);

    const migrated = createPostgresBackend(targetOptions);
    try {
      let caughtError: unknown;
      try {
        await migrated.transact(async () => undefined);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      const normalizedError = caughtError as Error & {
        code?: string;
        details?: unknown;
        cause?: unknown;
      };
      expect(normalizedError.code).toBe(
        "postgres_backend_blob_migration_decode_failed"
      );
      expect(normalizedError.details).toEqual({
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope,
      });
      expect(normalizedError.cause).toBeDefined();
    } finally {
      await migrated.destroy({ dropSchema: true });
    }
  });

  test("throws postgres_backend_blob_migration_ambiguous_rows when more than one legacy row exists for a scope", async () => {
    const targetOptions = createPostgresTestBackendOptions();
    const scope = "scope_migration_ambiguous_rows";

    await seedLegacySnapshotSchema(targetOptions, [
      {
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope,
        snapshotCbor: new Uint8Array([1]),
        snapshotId: 1,
      },
      {
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope,
        snapshotCbor: new Uint8Array([2]),
        snapshotId: 2,
      },
    ]);

    const migrated = createPostgresBackend(targetOptions);
    try {
      let caughtError: unknown;
      try {
        await migrated.transact(async () => undefined);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      const normalizedError = caughtError as Error & {
        code?: string;
        details?: unknown;
      };
      expect(normalizedError.code).toBe(
        "postgres_backend_blob_migration_ambiguous_rows"
      );
      expect(normalizedError.details).toEqual({
        rowCount: 2,
        scope,
      });
    } finally {
      await migrated.destroy({ dropSchema: true });
    }
  });

  test("throws postgres_backend_unstorable_text, not the generic insert-failed wrapper, for a legacy blob whose decoded state carries a NUL code point in a text-bound field", async () => {
    // The blob era stored whole-state CBOR, so a NUL code point in a text
    // field was storable then; only the relational explode's TEXT columns
    // reject it. This proves the specific diagnosis from
    // insertRowsInBatches (postgres-state-persist.ts) survives
    // explodeLegacyBlobSnapshots' catch instead of being buried as
    // error.cause.code under postgres_backend_blob_migration_insert_failed.
    const targetOptions = createPostgresTestBackendOptions();
    const targetSchemaName = targetOptions.schemaName ?? "public";
    const scope = "scope_migration_unstorable_text";

    const state = createEmptyState();
    const objectHash = await hashKernelRecord(
      "migration-unstorable-text-object"
    );
    const bytes = new Uint8Array([1, 2, 3]);
    state.objects.set(objectHash, {
      byteLength: bytes.byteLength,
      bytes,
      createdAtMs: 1_700_000_000_000,
      hash: objectHash,
      // media_type is a TEXT column; a NUL code point in it is exactly the
      // shape PostgreSQL's TEXT type cannot encode (SQLSTATE 22021).
      mediaType: "text/plain\u0000nul",
    });

    await seedLegacySnapshotSchema(targetOptions, [
      {
        schemaVersion: CURRENT_SNAPSHOT_VERSION,
        scope,
        snapshotCbor: encodeSnapshot(state),
      },
    ]);

    const migrated = createPostgresBackend(targetOptions);
    try {
      let caughtError: unknown;
      try {
        await migrated.transact(async () => undefined);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      const normalizedError = caughtError as Error & {
        code?: string;
        details?: unknown;
      };
      expect(normalizedError.code).toBe("postgres_backend_unstorable_text");
      expect(normalizedError.code).not.toBe(
        "postgres_backend_blob_migration_insert_failed"
      );
      expect(normalizedError.details).toEqual({
        chunkOffset: 0,
        chunkRows: 1,
        table: qualifyIdentifier(targetSchemaName, "objects"),
        totalRows: 1,
      });
    } finally {
      await migrated.destroy({ dropSchema: true });
    }
  });
});

describe("@tuvren/backend-postgres observe annotation duplicate identity (live write path)", () => {
  test("two annotations sharing identity fields get distinct NUL-free record_keys and are both readable back", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);
    const schemaName = options.schemaName ?? "public";

    try {
      const now = createMonotonicClock(1_800_000_000_000);
      const kernel = createRuntimeKernel({ backend, now });

      const schemaId = await kernel.schema.register(TEST_SCHEMA);
      const threadId = "thread_duplicate_annotations_live";
      const branchId = "branch_duplicate_annotations_live";
      const thread = await kernel.thread.create(threadId, schemaId, branchId);
      const turn = await kernel.turn.create(
        "turn_duplicate_annotations_live",
        threadId,
        branchId,
        null,
        thread.rootTurnNodeHash
      );
      const runId = "run_duplicate_annotations_live";
      await kernel.run.create(
        runId,
        turn.turnId,
        branchId,
        schemaId,
        thread.rootTurnNodeHash,
        [{ deterministic: true, id: "noop", sideEffects: false }]
      );

      const identicalPayload = { note: "identical-identity-annotation" };
      const annotationHash = await hashKernelRecord(identicalPayload);
      const annotationCbor = encodeDeterministicKernelRecord(identicalPayload);
      const createdAtMs = 555;

      const record: StoredObserveAnnotation = {
        annotationCbor,
        annotationHash,
        createdAtMs,
        runId,
        turnNodeHash: null,
      };

      // Two separate transact() calls writing the identical identity tuple:
      // the second must be disambiguated by the duplicate-count suffix
      // rather than colliding on (scope, record_key).
      await backend.transact(async (tx) => {
        await tx.observeAnnotations.set(record);
      });
      await backend.transact(async (tx) => {
        await tx.observeAnnotations.set(record);
      });

      const readBack = await backend.transact(async (tx) =>
        tx.observeAnnotations.listByRun(runId)
      );
      expect(readBack.length).toBe(2);
      for (const annotation of readBack) {
        expect(annotation.annotationHash).toBe(annotationHash);
        expect(annotation.createdAtMs).toBe(createdAtMs);
        expect(annotation.turnNodeHash).toBeNull();
      }

      const admin = createAdminClient(options);
      try {
        const rows = await admin.unsafe<Array<{ record_key: string }>>(
          `SELECT record_key
             FROM ${qualifyIdentifier(schemaName, "observe_annotations")}
            WHERE scope = $1 AND run_id = $2
            ORDER BY record_key`,
          [DEFAULT_SCOPE, runId]
        );
        expect(rows.length).toBe(2);
        const recordKeys = rows.map((row) => row.record_key);
        expect(new Set(recordKeys).size).toBe(2);
        for (const recordKey of recordKeys) {
          expect(recordKey.includes("\0")).toBe(false);
        }
      } finally {
        await admin.end({ timeout: 0 });
      }
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
