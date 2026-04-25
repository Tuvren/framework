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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type RuntimeBackend,
  type StagedResult,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";

const RETENTION_MESSAGE_COUNT = 40;

interface RetentionDryRunSummary {
  retainedObjectCount: number;
  retainedOrderedChunkCount: number;
  retainedRunCount: number;
  retainedSchemaCount: number;
  retainedStagedResultCount: number;
  retainedThreadCount: number;
  retainedTurnCount: number;
  retainedTurnNodeCount: number;
  retainedTurnTreeCount: number;
  retainedTurnTreePathCount: number;
}

interface TableCounts {
  branches: number;
  objects: number;
  orderedPathChunks: number;
  runs: number;
  schemas: number;
  stagedResults: number;
  threads: number;
  turnNodes: number;
  turns: number;
  turnTreePaths: number;
  turnTrees: number;
}

interface SqliteOrderedPathChunkRow {
  chunk_hash: string;
  items_cbor: Uint8Array;
}

interface SqliteRunRow {
  branch_id: string;
  created_turn_nodes_cbor: Uint8Array;
  run_id: string;
  schema_id: string;
  start_turn_node_hash: string;
  status: string;
  turn_id: string;
}

interface SqliteStagedResultRow {
  object_hash: string;
  run_id: string;
  task_id: string;
}

interface SqliteThreadRow {
  root_turn_node_hash: string;
  schema_id: string;
  thread_id: string;
}

interface SqliteTurnNodeRow {
  consumed_staged_results_cbor: Uint8Array;
  event_hash: string | null;
  hash: string;
  previous_turn_node_hash: string | null;
  schema_id: string;
  turn_tree_hash: string;
}

interface SqliteTurnRow {
  branch_id: string;
  head_turn_node_hash: string;
  start_turn_node_hash: string;
  thread_id: string;
  turn_id: string;
}

interface SqliteTurnTreePathRow {
  ordered_chunk_list_cbor: Uint8Array | null;
  ordered_encoding: string | null;
  ordered_inline_cbor: Uint8Array | null;
  path: string;
  single_hash: string | null;
  turn_tree_hash: string;
}

await main();

async function main(): Promise<void> {
  const tempDirectory = mkdtempSync(join(tmpdir(), "tuvren-sqlite-retention-"));

  try {
    const databasePath = join(tempDirectory, "kraken.db");
    const backend = createSqliteBackend({ databasePath });
    await seedRetentionProofDatabase(backend);

    const db = new Database(databasePath, { readonly: true });
    try {
      const beforeCounts = countTables(db);
      const summary = runRetentionDryRun(db);
      const afterCounts = countTables(db);

      assertTableCountsEqual(beforeCounts, afterCounts);
      assertExpectedSummary(summary);

      process.stdout.write("sqlite retention dry-run proof\n");
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun: "sqlite-retention-mark-only",
            generatedAt: new Date().toISOString(),
            rowCountsUnchanged: true,
            summary,
          },
          null,
          2
        )}\n`
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
}

async function seedRetentionProofDatabase(
  backend: RuntimeBackend
): Promise<void> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const messageObjects = await Promise.all(
    Array.from({ length: RETENTION_MESSAGE_COUNT }, (_, index) =>
      createStoredObjectRecord(new Uint8Array([index + 1]), 10 + index)
    )
  );
  const eventObject = await createStoredObjectRecord(
    new Uint8Array([201]),
    201
  );
  const consumedObject = await createStoredObjectRecord(
    new Uint8Array([202]),
    202
  );
  const stagedObject = await createStoredObjectRecord(
    new Uint8Array([203]),
    203
  );
  const messageHashes = messageObjects.map((objectRecord) => objectRecord.hash);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: messageHashes,
    },
    300
  );
  const rootTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 400,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const consumedResult: StagedResult = {
    objectHash: consumedObject.hash,
    objectType: "message",
    status: "completed",
    taskId: "consumed_message",
    timestamp: 401,
  };
  const headTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [consumedResult],
    createdAtMs: 402,
    eventHash: eventObject.hash,
    previousTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 500,
    rootTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_retention",
  };
  const branch: StoredBranch = {
    branchId: "branch_retention",
    createdAtMs: 501,
    headTurnNodeHash: headTurnNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 501,
  };
  const rootBranch: StoredBranch = {
    ...branch,
    headTurnNodeHash: rootTurnNode.hash,
  };
  const turn: StoredTurn = {
    branchId: branch.branchId,
    createdAtMs: 502,
    headTurnNodeHash: headTurnNode.hash,
    parentTurnId: null,
    startTurnNodeHash: rootTurnNode.hash,
    threadId: thread.threadId,
    turnId: "turn_retention",
    updatedAtMs: 502,
  };
  const run: StoredRun = {
    branchId: branch.branchId,
    createdAtMs: 503,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([headTurnNode.hash]),
    currentStepIndex: 0,
    runId: "run_retention",
    schemaId: schema.schemaId,
    startTurnNodeHash: rootTurnNode.hash,
    status: "running",
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "iterate",
        sideEffects: true,
      },
    ]),
    turnId: turn.turnId,
    updatedAtMs: 503,
  };
  const stagedResult: StoredStagedResult = {
    createdAtMs: 504,
    objectHash: stagedObject.hash,
    objectType: "message",
    runId: run.runId,
    status: "completed",
    taskId: "staged_message",
  };

  await backend.transact(async (tx) => {
    for (const objectRecord of [
      ...messageObjects,
      eventObject,
      consumedObject,
      stagedObject,
    ]) {
      await tx.objects.put(objectRecord);
    }

    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages: messageHashes,
      })
    );
    await tx.turnNodes.put(rootTurnNode);
    await tx.turnNodes.put(headTurnNode);
    await tx.threads.put(thread);
    await tx.branches.set(rootBranch);
    await tx.turns.set(turn);
    await tx.runs.set(run);
    await tx.stagedResults.set(stagedResult);
    await tx.branches.set(branch);
  });
}

function runRetentionDryRun(db: Database.Database): RetentionDryRunSummary {
  const retainedTurnNodeHashes = loadRetainedTurnNodeHashes(db);
  const retainedTurnNodes = selectTurnNodes(db, retainedTurnNodeHashes);
  const retainedTurnTreeHashes = new Set<string>();
  const retainedSchemaIds = new Set<string>();
  const retainedObjectHashes = new Set<string>();

  collectTurnNodeEdges(
    retainedTurnNodes,
    retainedTurnTreeHashes,
    retainedSchemaIds,
    retainedObjectHashes
  );

  const retainedTurns = selectRetainedTurns(db, retainedTurnNodeHashes);
  const retainedTurnIds = new Set(retainedTurns.map((turn) => turn.turn_id));
  const retainedRuns = selectRetainedRuns(db, retainedTurnIds);
  const retainedRunIds = collectRunEdges(
    retainedRuns,
    retainedTurnNodeHashes,
    retainedSchemaIds
  );
  collectTurnNodeEdges(
    selectTurnNodes(db, retainedTurnNodeHashes),
    retainedTurnTreeHashes,
    retainedSchemaIds,
    retainedObjectHashes
  );

  const { retainedOrderedChunkHashes, retainedTurnTreePaths } =
    collectTurnTreePathEdges(db, retainedTurnTreeHashes, retainedObjectHashes);
  collectOrderedChunkEdges(
    db,
    retainedOrderedChunkHashes,
    retainedObjectHashes
  );

  const retainedStagedResults = collectStagedResultEdges(
    db,
    retainedRunIds,
    retainedObjectHashes
  );
  const retainedThreads = collectThreadEdges(
    db,
    retainedTurnNodeHashes,
    retainedSchemaIds
  );

  return {
    retainedObjectCount: retainedObjectHashes.size,
    retainedOrderedChunkCount: retainedOrderedChunkHashes.size,
    retainedRunCount: retainedRunIds.size,
    retainedSchemaCount: retainedSchemaIds.size,
    retainedStagedResultCount: retainedStagedResults.length,
    retainedThreadCount: retainedThreads.length,
    retainedTurnCount: retainedTurnIds.size,
    retainedTurnNodeCount: retainedTurnNodeHashes.size,
    retainedTurnTreeCount: retainedTurnTreeHashes.size,
    retainedTurnTreePathCount: retainedTurnTreePaths.length,
  };
}

function collectTurnNodeEdges(
  retainedTurnNodes: readonly SqliteTurnNodeRow[],
  retainedTurnTreeHashes: Set<string>,
  retainedSchemaIds: Set<string>,
  retainedObjectHashes: Set<string>
): void {
  for (const turnNode of retainedTurnNodes) {
    retainedTurnTreeHashes.add(turnNode.turn_tree_hash);
    retainedSchemaIds.add(turnNode.schema_id);

    if (turnNode.event_hash !== null) {
      retainedObjectHashes.add(turnNode.event_hash);
    }

    for (const objectHash of decodeConsumedStagedResultObjectHashes(
      turnNode.consumed_staged_results_cbor
    )) {
      retainedObjectHashes.add(objectHash);
    }
  }
}

function collectTurnTreePathEdges(
  db: Database.Database,
  retainedTurnTreeHashes: ReadonlySet<string>,
  retainedObjectHashes: Set<string>
): {
  retainedOrderedChunkHashes: Set<string>;
  retainedTurnTreePaths: SqliteTurnTreePathRow[];
} {
  const retainedTurnTreePaths = selectTurnTreePaths(db, retainedTurnTreeHashes);
  const retainedOrderedChunkHashes = new Set<string>();

  for (const path of retainedTurnTreePaths) {
    collectSinglePathObjectEdge(path, retainedObjectHashes);
    collectOrderedInlineObjectEdges(path, retainedObjectHashes);
    collectOrderedChunkEdgesFromPath(path, retainedOrderedChunkHashes);
  }

  return { retainedOrderedChunkHashes, retainedTurnTreePaths };
}

function collectSinglePathObjectEdge(
  path: SqliteTurnTreePathRow,
  retainedObjectHashes: Set<string>
): void {
  if (path.single_hash !== null) {
    retainedObjectHashes.add(path.single_hash);
  }
}

function collectOrderedInlineObjectEdges(
  path: SqliteTurnTreePathRow,
  retainedObjectHashes: Set<string>
): void {
  if (path.ordered_encoding !== "flat" || path.ordered_inline_cbor === null) {
    return;
  }

  for (const objectHash of decodeHashStringArray(
    path.ordered_inline_cbor,
    "turn_tree_paths.ordered_inline_cbor"
  )) {
    retainedObjectHashes.add(objectHash);
  }
}

function collectOrderedChunkEdgesFromPath(
  path: SqliteTurnTreePathRow,
  retainedOrderedChunkHashes: Set<string>
): void {
  if (
    path.ordered_encoding !== "chunked" ||
    path.ordered_chunk_list_cbor === null
  ) {
    return;
  }

  for (const chunkHash of decodeHashStringArray(
    path.ordered_chunk_list_cbor,
    "turn_tree_paths.ordered_chunk_list_cbor"
  )) {
    retainedOrderedChunkHashes.add(chunkHash);
  }
}

function collectOrderedChunkEdges(
  db: Database.Database,
  retainedOrderedChunkHashes: ReadonlySet<string>,
  retainedObjectHashes: Set<string>
): void {
  for (const chunk of selectOrderedPathChunks(db, retainedOrderedChunkHashes)) {
    for (const objectHash of decodeHashStringArray(
      chunk.items_cbor,
      "ordered_path_chunks.items_cbor"
    )) {
      retainedObjectHashes.add(objectHash);
    }
  }
}

function collectRunEdges(
  retainedRuns: readonly SqliteRunRow[],
  retainedTurnNodeHashes: Set<string>,
  retainedSchemaIds: Set<string>
): Set<string> {
  const retainedRunIds = new Set<string>();

  for (const run of retainedRuns) {
    retainedRunIds.add(run.run_id);
    retainedSchemaIds.add(run.schema_id);

    for (const turnNodeHash of decodeHashStringArray(
      run.created_turn_nodes_cbor,
      "runs.created_turn_nodes_cbor"
    )) {
      retainedTurnNodeHashes.add(turnNodeHash);
    }
  }

  return retainedRunIds;
}

function collectStagedResultEdges(
  db: Database.Database,
  retainedRunIds: ReadonlySet<string>,
  retainedObjectHashes: Set<string>
): SqliteStagedResultRow[] {
  const retainedStagedResults = selectRetainedStagedResults(db, retainedRunIds);

  for (const stagedResult of retainedStagedResults) {
    retainedObjectHashes.add(stagedResult.object_hash);
  }

  return retainedStagedResults;
}

function collectThreadEdges(
  db: Database.Database,
  retainedTurnNodeHashes: ReadonlySet<string>,
  retainedSchemaIds: Set<string>
): SqliteThreadRow[] {
  const retainedThreads = selectRetainedThreads(db, retainedTurnNodeHashes);

  for (const thread of retainedThreads) {
    retainedSchemaIds.add(thread.schema_id);
  }

  return retainedThreads;
}

function loadRetainedTurnNodeHashes(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `
        WITH RECURSIVE roots(hash) AS (
          SELECT head_turn_node_hash FROM branches
          UNION
          SELECT root_turn_node_hash FROM threads
          UNION
          SELECT start_turn_node_hash FROM turns
          UNION
          SELECT head_turn_node_hash FROM turns
          UNION
          SELECT start_turn_node_hash
          FROM runs
          WHERE status IN ('running', 'paused')
        ),
        lineage(hash) AS (
          SELECT hash FROM roots
          UNION
          SELECT turn_nodes.previous_turn_node_hash
          FROM turn_nodes
          JOIN lineage ON turn_nodes.hash = lineage.hash
          WHERE turn_nodes.previous_turn_node_hash IS NOT NULL
        )
        SELECT hash
        FROM lineage
        ORDER BY hash
      `
    )
    .all() as Array<{ hash: string }>;
  return new Set(rows.map((row) => row.hash));
}

function selectTurnNodes(
  db: Database.Database,
  hashes: ReadonlySet<string>
): SqliteTurnNodeRow[] {
  return (
    db.prepare("SELECT * FROM turn_nodes").all() as SqliteTurnNodeRow[]
  ).filter((row) => hashes.has(row.hash));
}

function selectTurnTreePaths(
  db: Database.Database,
  hashes: ReadonlySet<string>
): SqliteTurnTreePathRow[] {
  return (
    db.prepare("SELECT * FROM turn_tree_paths").all() as SqliteTurnTreePathRow[]
  ).filter((row) => hashes.has(row.turn_tree_hash));
}

function selectOrderedPathChunks(
  db: Database.Database,
  hashes: ReadonlySet<string>
): SqliteOrderedPathChunkRow[] {
  return (
    db
      .prepare("SELECT * FROM ordered_path_chunks")
      .all() as SqliteOrderedPathChunkRow[]
  ).filter((row) => hashes.has(row.chunk_hash));
}

function selectRetainedTurns(
  db: Database.Database,
  turnNodeHashes: ReadonlySet<string>
): SqliteTurnRow[] {
  return (db.prepare("SELECT * FROM turns").all() as SqliteTurnRow[]).filter(
    (row) =>
      turnNodeHashes.has(row.start_turn_node_hash) ||
      turnNodeHashes.has(row.head_turn_node_hash)
  );
}

function selectRetainedRuns(
  db: Database.Database,
  turnIds: ReadonlySet<string>
): SqliteRunRow[] {
  return (db.prepare("SELECT * FROM runs").all() as SqliteRunRow[]).filter(
    (row) =>
      turnIds.has(row.turn_id) ||
      row.status === "running" ||
      row.status === "paused"
  );
}

function selectRetainedStagedResults(
  db: Database.Database,
  runIds: ReadonlySet<string>
): SqliteStagedResultRow[] {
  return (
    db.prepare("SELECT * FROM staged_results").all() as SqliteStagedResultRow[]
  ).filter((row) => runIds.has(row.run_id));
}

function selectRetainedThreads(
  db: Database.Database,
  turnNodeHashes: ReadonlySet<string>
): SqliteThreadRow[] {
  return (
    db.prepare("SELECT * FROM threads").all() as SqliteThreadRow[]
  ).filter((row) => turnNodeHashes.has(row.root_turn_node_hash));
}

function decodeConsumedStagedResultObjectHashes(bytes: Uint8Array): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw new Error(
      "turn node consumed staged results must decode to an array"
    );
  }

  const objectHashes: string[] = [];
  for (const item of decodedValue) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("objectHash" in item) ||
      typeof item.objectHash !== "string"
    ) {
      throw new Error("consumed staged result entry must include objectHash");
    }

    objectHashes.push(item.objectHash);
  }

  return objectHashes;
}

function decodeHashStringArray(bytes: Uint8Array, label: string): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw new Error(`${label} must decode to an array`);
  }

  const hashes: string[] = [];
  for (const item of decodedValue) {
    if (typeof item !== "string") {
      throw new Error(`${label} entries must be strings`);
    }

    hashes.push(item);
  }

  return hashes;
}

function countTables(db: Database.Database): TableCounts {
  return {
    branches: countTable(db, "branches"),
    objects: countTable(db, "objects"),
    orderedPathChunks: countTable(db, "ordered_path_chunks"),
    runs: countTable(db, "runs"),
    schemas: countTable(db, "schemas"),
    stagedResults: countTable(db, "staged_results"),
    threads: countTable(db, "threads"),
    turnNodes: countTable(db, "turn_nodes"),
    turnTreePaths: countTable(db, "turn_tree_paths"),
    turnTrees: countTable(db, "turn_trees"),
    turns: countTable(db, "turns"),
  };
}

function countTable(db: Database.Database, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function assertTableCountsEqual(left: TableCounts, right: TableCounts): void {
  for (const [tableName, leftCount] of Object.entries(left)) {
    const rightCount = right[tableName as keyof TableCounts];

    if (leftCount !== rightCount) {
      throw new Error(
        `retention dry-run changed row count for ${tableName}: ${leftCount} -> ${rightCount}`
      );
    }
  }
}

function assertExpectedSummary(summary: RetentionDryRunSummary): void {
  const expected: RetentionDryRunSummary = {
    retainedObjectCount: RETENTION_MESSAGE_COUNT + 3,
    retainedOrderedChunkCount: 2,
    retainedRunCount: 1,
    retainedSchemaCount: 1,
    retainedStagedResultCount: 1,
    retainedThreadCount: 1,
    retainedTurnCount: 1,
    retainedTurnNodeCount: 2,
    retainedTurnTreeCount: 1,
    retainedTurnTreePathCount: 2,
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = summary[key as keyof RetentionDryRunSummary];

    if (actualValue !== expectedValue) {
      throw new Error(
        `unexpected retention dry-run ${key}: expected ${expectedValue}, received ${actualValue}`
      );
    }
  }
}
