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

import type { StoredBranch, StoredTurnNode } from "@tuvren/kernel-protocol";
import type Database from "better-sqlite3";
import {
  assertActiveRunHeadAlignmentInDatabase,
  assertBackwardBranchMoveIsArchivedInDatabase,
  assertRunCreatedTurnNodesAreCanonicalInDatabase,
  assertRunCreatedTurnNodeWithinTurnSpanInDatabase,
  assertRunStartTurnNodeWithinTurnSpanInDatabase,
  assertTurnNodeBelongsToThreadInDatabase,
  assertTurnNodeDescendsFromInDatabase,
  assertTurnParentLinkInDatabase,
  classifyTurnNodeRelationshipInDatabase,
  validateTurnNodeLineageMetadataInDatabase,
} from "./sqlite-db-lineage.js";
import { persistenceError } from "./sqlite-errors.js";
import {
  assertBackwardBranchMoveIsArchived,
  assertChunkedTurnTreePathChunkLayout,
  assertTurnParentLink,
} from "./sqlite-integrity-assertions.js";
import {
  countStagedResultsByRun,
  ensureBranchExistsInDatabase,
  ensureObjectExistsInDatabase,
  ensureOrderedPathChunkExistsInDatabase,
  ensureRunExistsInDatabase,
  ensureSchemaExistsInDatabase,
  ensureThreadExistsInDatabase,
  ensureTurnExistsInDatabase,
  ensureTurnNodeExistsInDatabase,
  ensureTurnTreeExistsInDatabase,
  selectActiveRunsByBranch,
  selectBranch,
  selectRun,
  selectRunsByTurn,
  selectThread,
  selectTurn,
  selectTurnNode,
  selectTurnsByParentTurnId,
  selectTurnTree,
  selectTurnTreePathsByTurnTree,
} from "./sqlite-lookups.js";
import type {
  BackendState,
  SqliteTurnNodeLineageRootRow,
  TurnNodeLineageMetadata,
} from "./sqlite-records.js";
import {
  createEmptyState,
  decodeHashStringArray,
  decodeTurnNodeLineageMetadataRow,
} from "./sqlite-records.js";
import {
  assertActiveRunHeadAlignment,
  classifyTurnNodeRelationship,
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
  validateHashString,
} from "./sqlite-run-invariants.js";
import { validateTurnTreePathInvariants } from "./sqlite-state-validation.js";
import type { TransactionWriteTracker } from "./sqlite-write-tracker.js";

export function validateTransactionWriteSet(
  db: Database.Database,
  writeTracker: TransactionWriteTracker
): void {
  for (const threadId of writeTracker.threadIds) {
    validateThreadInDatabase(db, threadId);
  }

  for (const turnTreeHash of writeTracker.turnTreeHashes) {
    validateTurnTreePathsInDatabase(db, turnTreeHash);
  }

  for (const turnNodeHash of writeTracker.turnNodeHashes) {
    validateTurnNodeInDatabase(db, turnNodeHash);
  }

  for (const turnId of writeTracker.turnIds) {
    validateTurnInDatabase(db, turnId);
  }

  for (const turnId of writeTracker.turnIdsForDependentValidation) {
    validateTurnDependentsInDatabase(db, turnId);
  }

  for (const [branchId] of writeTracker.branchWrites) {
    validateBranchInDatabase(db, writeTracker, branchId);
  }

  for (const runId of writeTracker.runIds) {
    validateRunInDatabase(db, runId);
  }

  for (const runId of writeTracker.stagedResultRunIds) {
    validateStagedResultsForRunInDatabase(db, runId);
  }

  for (const branchId of writeTracker.branchIdsForActiveRunValidation) {
    validateActiveRunsForBranchInDatabase(db, branchId);
  }
}

export function validateTurnNodeLineageRootIndex(
  db: Database.Database,
  state: BackendState
): void {
  const actualMetadataByTurnNodeHash = new Map<
    string,
    TurnNodeLineageMetadata
  >();

  for (const row of db
    .prepare("SELECT * FROM turn_node_lineage_roots")
    .all() as SqliteTurnNodeLineageRootRow[]) {
    const metadata = decodeTurnNodeLineageMetadataRow(row);
    setUniqueLoadedRecord(
      actualMetadataByTurnNodeHash,
      metadata.turnNodeHash,
      metadata,
      "turn node lineage metadata",
      { turnNodeHash: metadata.turnNodeHash }
    );
  }

  for (const metadata of actualMetadataByTurnNodeHash.values()) {
    if (!state.turnNodes.has(metadata.turnNodeHash)) {
      throw persistenceError(
        "turn node lineage metadata must reference an existing turn node",
        "sqlite_backend_orphan_turn_node_lineage_metadata",
        { turnNodeHash: metadata.turnNodeHash }
      );
    }

    if (!state.turnNodes.has(metadata.rootTurnNodeHash)) {
      throw persistenceError(
        "turn node lineage metadata must reference an existing root turn node",
        "sqlite_backend_orphan_turn_node_lineage_metadata",
        {
          rootTurnNodeHash: metadata.rootTurnNodeHash,
          turnNodeHash: metadata.turnNodeHash,
        }
      );
    }
  }

  for (const turnNode of state.turnNodes.values()) {
    const actualMetadata = actualMetadataByTurnNodeHash.get(turnNode.hash);

    if (actualMetadata === undefined) {
      throw persistenceError(
        "turn nodes must have lineage root metadata",
        "sqlite_backend_missing_turn_node_lineage_metadata",
        { turnNodeHash: turnNode.hash }
      );
    }

    const expectedMetadata = computeExpectedTurnNodeLineageMetadata(
      state,
      turnNode
    );

    if (
      actualMetadata.rootTurnNodeHash !== expectedMetadata.rootTurnNodeHash ||
      actualMetadata.depth !== expectedMetadata.depth
    ) {
      throw persistenceError(
        "turn node lineage metadata must match the parent-linked turn node chain",
        "sqlite_backend_turn_node_lineage_metadata_mismatch",
        {
          actualDepth: actualMetadata.depth,
          actualRootTurnNodeHash: actualMetadata.rootTurnNodeHash,
          expectedDepth: expectedMetadata.depth,
          expectedRootTurnNodeHash: expectedMetadata.rootTurnNodeHash,
          turnNodeHash: turnNode.hash,
        }
      );
    }
  }
}

function validateThreadInDatabase(
  db: Database.Database,
  threadId: string
): void {
  const thread = selectThread(db, threadId);

  if (thread === null) {
    return;
  }

  const rootTurnNode = ensureTurnNodeExistsInDatabase(
    db,
    thread.rootTurnNodeHash,
    "thread.rootTurnNodeHash"
  );
  validateTurnNodeLineageMetadataInDatabase(db, rootTurnNode);

  if (rootTurnNode.schemaId !== thread.schemaId) {
    throw persistenceError(
      "stored threads must use the schema of their root turn node",
      "sqlite_backend_thread_schema_mismatch",
      {
        rootTurnNodeHash: thread.rootTurnNodeHash,
        threadId: thread.threadId,
        threadSchemaId: thread.schemaId,
        turnNodeSchemaId: rootTurnNode.schemaId,
      }
    );
  }

  if (rootTurnNode.previousTurnNodeHash !== null) {
    throw persistenceError(
      "stored thread roots must be genesis turn nodes",
      "sqlite_backend_thread_root_not_genesis",
      {
        previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
        rootTurnNodeHash: rootTurnNode.hash,
        threadId: thread.threadId,
      }
    );
  }

  const duplicateRootThread = db
    .prepare(
      `
        SELECT thread_id
        FROM threads
        WHERE root_turn_node_hash = ? AND thread_id <> ?
        LIMIT 1
      `
    )
    .get(thread.rootTurnNodeHash, thread.threadId) as
    | { thread_id: string }
    | undefined;

  if (duplicateRootThread !== undefined) {
    throw persistenceError(
      "stored thread roots must be unique across threads",
      "sqlite_backend_thread_root_not_unique",
      {
        existingOwnerThreadId: duplicateRootThread.thread_id,
        rootTurnNodeHash: thread.rootTurnNodeHash,
        threadId: thread.threadId,
      }
    );
  }
}

function validateBranchInDatabase(
  db: Database.Database,
  writeTracker: TransactionWriteTracker,
  branchId: string
): void {
  const branch = selectBranch(db, branchId);

  if (branch === null) {
    return;
  }

  const thread = ensureThreadExistsInDatabase(
    db,
    branch.threadId,
    "branch.threadId"
  );
  assertTurnNodeBelongsToThreadInDatabase(
    db,
    branch.headTurnNodeHash,
    thread,
    "branch.headTurnNodeHash"
  );

  if (branch.archivedFromBranchId !== undefined) {
    validateArchiveBranchInDatabase(db, writeTracker, branch);
  }

  const trackedBranch = writeTracker.branchWrites.get(branch.branchId);

  if (trackedBranch?.before === null || trackedBranch?.before === undefined) {
    return;
  }

  const headMoveDirection = classifyTurnNodeRelationshipInDatabase(
    db,
    trackedBranch.before.headTurnNodeHash,
    branch.headTurnNodeHash
  );

  if (headMoveDirection === "backward") {
    assertBackwardBranchMoveIsArchivedInDatabase(
      db,
      writeTracker,
      trackedBranch.before,
      branch
    );
  }
}

function validateArchiveBranchInDatabase(
  db: Database.Database,
  writeTracker: TransactionWriteTracker,
  branch: StoredBranch
): void {
  if (branch.archivedFromBranchId === undefined) {
    return;
  }

  const sourceBranch = ensureBranchExistsInDatabase(
    db,
    branch.archivedFromBranchId,
    "branch.archivedFromBranchId"
  );

  if (sourceBranch.threadId !== branch.threadId) {
    throw persistenceError(
      "stored branches must archive only from branches in the same thread",
      "sqlite_backend_branch_archive_thread_mismatch",
      {
        archivedFromBranchId: sourceBranch.branchId,
        branchId: branch.branchId,
        branchThreadId: branch.threadId,
        sourceThreadId: sourceBranch.threadId,
      }
    );
  }

  const trackedArchive = writeTracker.branchWrites.get(branch.branchId);

  if (trackedArchive?.before !== null) {
    return;
  }

  const trackedSource = writeTracker.branchWrites.get(
    branch.archivedFromBranchId
  );
  const sourceBranchBeforeTransaction =
    trackedSource?.before ??
    writeTracker.captureBranchBaseline(db, branch.archivedFromBranchId);

  if (sourceBranchBeforeTransaction === null) {
    throw persistenceError(
      "new archive branches must reference a source branch that existed before the transaction",
      "sqlite_backend_branch_archive_source_missing_before_transaction",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        branchId: branch.branchId,
      }
    );
  }

  if (
    branch.headTurnNodeHash !== sourceBranchBeforeTransaction.headTurnNodeHash
  ) {
    throw persistenceError(
      "new archive branches must preserve the pre-rollback source branch head",
      "sqlite_backend_branch_archive_head_mismatch",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        archiveHeadTurnNodeHash: branch.headTurnNodeHash,
        sourceHeadTurnNodeHash: sourceBranchBeforeTransaction.headTurnNodeHash,
      }
    );
  }

  if (
    classifyTurnNodeRelationshipInDatabase(
      db,
      sourceBranchBeforeTransaction.headTurnNodeHash,
      sourceBranch.headTurnNodeHash
    ) !== "backward"
  ) {
    throw persistenceError(
      "new archive branches must be paired with a backward move on their source branch",
      "sqlite_backend_branch_archive_without_backward_move",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        branchId: branch.branchId,
        sourceBranchHeadTurnNodeHash: sourceBranch.headTurnNodeHash,
        sourceBranchPreviousHeadTurnNodeHash:
          sourceBranchBeforeTransaction.headTurnNodeHash,
      }
    );
  }
}

function validateTurnNodeInDatabase(
  db: Database.Database,
  turnNodeHash: string
): void {
  const turnNode = selectTurnNode(db, turnNodeHash);

  if (turnNode === null) {
    return;
  }

  const turnTree = ensureTurnTreeExistsInDatabase(
    db,
    turnNode.turnTreeHash,
    "turnNode.turnTreeHash"
  );

  if (turnTree.schemaId !== turnNode.schemaId) {
    throw persistenceError(
      "stored turn nodes must use the schema of their referenced turn tree",
      "sqlite_backend_turn_node_schema_mismatch",
      {
        turnNodeHash: turnNode.hash,
        turnNodeSchemaId: turnNode.schemaId,
        turnTreeHash: turnTree.hash,
        turnTreeSchemaId: turnTree.schemaId,
      }
    );
  }

  validateTurnNodeLineageMetadataInDatabase(db, turnNode);

  for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
    turnNode
  )) {
    ensureObjectExistsInDatabase(
      db,
      objectHash,
      "turnNode.consumedStagedResultsCbor"
    );
  }
}

function validateTurnInDatabase(db: Database.Database, turnId: string): void {
  const turn = selectTurn(db, turnId);

  if (turn === null) {
    return;
  }

  const thread = ensureThreadExistsInDatabase(
    db,
    turn.threadId,
    "turn.threadId"
  );
  const branch = ensureBranchExistsInDatabase(
    db,
    turn.branchId,
    "turn.branchId"
  );

  if (branch.threadId !== thread.threadId) {
    throw persistenceError(
      "stored turns must reference a branch on the same thread",
      "sqlite_backend_turn_branch_thread_mismatch",
      {
        branchId: branch.branchId,
        branchThreadId: branch.threadId,
        threadId: thread.threadId,
        turnId: turn.turnId,
      }
    );
  }

  assertTurnNodeBelongsToThreadInDatabase(
    db,
    turn.startTurnNodeHash,
    thread,
    "turn.startTurnNodeHash"
  );
  assertTurnNodeBelongsToThreadInDatabase(
    db,
    turn.headTurnNodeHash,
    thread,
    "turn.headTurnNodeHash"
  );
  assertTurnNodeDescendsFromInDatabase(
    db,
    turn.headTurnNodeHash,
    turn.startTurnNodeHash,
    "turn.headTurnNodeHash"
  );
  assertTurnParentLinkInDatabase(db, turn, "turn.parentTurnId");
}

function validateTurnDependentsInDatabase(
  db: Database.Database,
  turnId: string
): void {
  for (const dependentTurn of selectTurnsByParentTurnId(db, turnId)) {
    validateTurnInDatabase(db, dependentTurn.turnId);
  }

  for (const run of selectRunsByTurn(db, turnId)) {
    validateRunInDatabase(db, run.runId);
  }
}

function validateRunInDatabase(db: Database.Database, runId: string): void {
  const run = selectRun(db, runId);

  if (run === null) {
    return;
  }

  const branch = ensureBranchExistsInDatabase(db, run.branchId, "run.branchId");
  const turn = ensureTurnExistsInDatabase(db, run.turnId, "run.turnId");
  const startTurnNode = ensureTurnNodeExistsInDatabase(
    db,
    run.startTurnNodeHash,
    "run.startTurnNodeHash"
  );
  const thread = ensureThreadExistsInDatabase(
    db,
    turn.threadId,
    "turn.threadId"
  );

  if (turn.branchId !== branch.branchId) {
    throw persistenceError(
      "stored runs must reference a turn on the same branch",
      "sqlite_backend_run_branch_mismatch",
      {
        branchId: branch.branchId,
        runId: run.runId,
        turnBranchId: turn.branchId,
        turnId: turn.turnId,
      }
    );
  }

  assertTurnNodeBelongsToThreadInDatabase(
    db,
    run.startTurnNodeHash,
    thread,
    "run.startTurnNodeHash"
  );

  if (startTurnNode.schemaId !== run.schemaId) {
    throw persistenceError(
      "stored runs must use the schema of their start turn node",
      "sqlite_backend_run_schema_mismatch",
      {
        runId: run.runId,
        runSchemaId: run.schemaId,
        startTurnNodeHash: startTurnNode.hash,
        turnNodeSchemaId: startTurnNode.schemaId,
      }
    );
  }

  assertRunStartTurnNodeWithinTurnSpanInDatabase(
    db,
    turn,
    run.startTurnNodeHash,
    "run.startTurnNodeHash"
  );

  for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
    const createdTurnNode = ensureTurnNodeExistsInDatabase(
      db,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    assertTurnNodeBelongsToThreadInDatabase(
      db,
      turnNodeHash,
      thread,
      "run.createdTurnNodesCbor"
    );
    assertRunCreatedTurnNodeWithinTurnSpanInDatabase(
      db,
      turn,
      createdTurnNode,
      "run.createdTurnNodesCbor"
    );
  }

  assertRunCreatedTurnNodesAreCanonicalInDatabase(db, run);

  if (run.status === "running" || run.status === "paused") {
    assertActiveRunHeadAlignmentInDatabase(run, branch, turn);
  }
}

function validateStagedResultsForRunInDatabase(
  db: Database.Database,
  runId: string
): void {
  const run = ensureRunExistsInDatabase(db, runId, "stagedResults.runId");
  const stagedResultCount = countStagedResultsByRun(db, runId);

  if (run.status !== "running" && stagedResultCount > 0) {
    throw persistenceError(
      "stored terminal or paused runs must not retain staged results",
      "sqlite_backend_run_has_terminal_staged_results",
      {
        runId: run.runId,
        stagedResultCount,
        status: run.status,
      }
    );
  }
}

function validateActiveRunsForBranchInDatabase(
  db: Database.Database,
  branchId: string
): void {
  const branch = selectBranch(db, branchId);

  if (branch === null) {
    return;
  }

  const activeRuns = selectActiveRunsByBranch(db, branch.branchId);

  if (activeRuns.length > 1) {
    throw persistenceError(
      "stored branches must not have more than one active run",
      "sqlite_backend_multiple_active_runs",
      {
        activeRunCount: activeRuns.length,
        branchId: branch.branchId,
      }
    );
  }

  for (const run of activeRuns) {
    const turn = ensureTurnExistsInDatabase(db, run.turnId, "run.turnId");
    assertActiveRunHeadAlignmentInDatabase(run, branch, turn);
  }
}

function validateTurnTreePathsInDatabase(
  db: Database.Database,
  turnTreeHash: string
): void {
  const turnTree = selectTurnTree(db, turnTreeHash);

  if (turnTree === null) {
    return;
  }

  const state = createEmptyState();
  const schemaRecord = ensureSchemaExistsInDatabase(
    db,
    turnTree.schemaId,
    "turnTree.schemaId"
  );
  const storedPaths = selectTurnTreePathsByTurnTree(db, turnTree.hash);
  const pathMap = new Map<
    string,
    ReturnType<typeof selectTurnTreePathsByTurnTree>[number]
  >();

  state.schemas.set(schemaRecord.schemaId, schemaRecord);
  state.turnTrees.set(turnTree.hash, turnTree);

  for (const storedPath of storedPaths) {
    pathMap.set(storedPath.path, storedPath);

    if (storedPath.collectionKind !== "ordered") {
      continue;
    }

    if (storedPath.orderedEncoding !== "chunked") {
      continue;
    }

    for (const chunkHash of decodeHashStringArray(
      storedPath.orderedChunkListCbor,
      "storedPath.orderedChunkListCbor"
    )) {
      const chunk = ensureOrderedPathChunkExistsInDatabase(
        db,
        chunkHash,
        "storedPath.orderedChunkListCbor"
      );
      state.orderedPathChunks.set(chunk.chunkHash, chunk);
    }
  }

  if (pathMap.size > 0) {
    state.turnTreePaths.set(turnTree.hash, pathMap);
  }

  validateTurnTreePathInvariants(state, {
    assertActiveRunHeadAlignment,
    assertBackwardBranchMoveIsArchived,
    assertChunkedTurnTreePathChunkLayout,
    assertRunCreatedTurnNodeWithinTurnSpan: (
      _state,
      _turn,
      _turnNode,
      _label
    ) => {
      throw new Error("unexpected direct call");
    },
    assertRunCreatedTurnNodesAreCanonical: (_state, _run) => {
      throw new Error("unexpected direct call");
    },
    assertRunStartTurnNodeWithinTurnSpan: (
      _state,
      _turn,
      _startTurnNodeHash,
      _label
    ) => {
      throw new Error("unexpected direct call");
    },
    assertTurnParentLink,
    classifyTurnNodeRelationship,
    decodeRunCreatedTurnNodeHashes,
    decodeTurnNodeConsumedStagedResultObjectHashes,
    validateHashString,
  });
}

function computeExpectedTurnNodeLineageMetadata(
  state: BackendState,
  turnNode: StoredTurnNode
): TurnNodeLineageMetadata {
  const visitedTurnNodeHashes = new Set<string>();
  let currentTurnNode = turnNode;
  let depth = 0;

  while (currentTurnNode.previousTurnNodeHash !== null) {
    if (visitedTurnNodeHashes.has(currentTurnNode.hash)) {
      throw persistenceError(
        "turn node lineage must not contain cycles",
        "sqlite_backend_turn_node_lineage_cycle",
        { turnNodeHash: turnNode.hash }
      );
    }

    visitedTurnNodeHashes.add(currentTurnNode.hash);
    const previousTurnNode = state.turnNodes.get(
      currentTurnNode.previousTurnNodeHash
    );

    if (previousTurnNode === undefined) {
      throw persistenceError(
        "turn node lineage metadata requires complete turn node parent links",
        "sqlite_backend_missing_turn_node_reference",
        {
          previousTurnNodeHash: currentTurnNode.previousTurnNodeHash,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    currentTurnNode = previousTurnNode;
    depth += 1;
  }

  return {
    depth,
    rootTurnNodeHash: currentTurnNode.hash,
    turnNodeHash: turnNode.hash,
  };
}

function setUniqueLoadedRecord<T>(
  records: Map<string, T>,
  key: string,
  value: T,
  recordType: string,
  details: Record<string, string>
): void {
  if (records.has(key)) {
    throw persistenceError(
      `sqlite backend found duplicate ${recordType} rows while loading persisted state`,
      "sqlite_backend_duplicate_loaded_record",
      { key, recordType, ...details }
    );
  }

  records.set(key, value);
}
