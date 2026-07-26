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

import {
  createTurnNodeLineageIndex,
  resolveTurnNodeLineagePosition,
} from "@tuvren/backend-shared";
import type { StoredBranch, StoredTurnTreePath } from "@tuvren/kernel-protocol";

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
} from "./postgres-db-lineage.js";
import { persistenceError } from "./postgres-errors.js";
import {
  assertBackwardBranchMoveIsArchived,
  assertChunkedTurnTreePathChunkLayout,
  assertTurnParentLink,
} from "./postgres-integrity-assertions.js";
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
} from "./postgres-lookups.js";
import type {
  BackendState,
  PostgresTurnNodeLineageRootRow,
  TurnNodeLineageMetadata,
} from "./postgres-records.js";
import {
  createEmptyState,
  decodeHashStringArray,
  decodeTurnNodeLineageMetadataRow,
} from "./postgres-records.js";
import {
  assertActiveRunHeadAlignment,
  classifyTurnNodeRelationship,
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
  validateHashString,
} from "./postgres-run-invariants.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";
import { validateTurnTreePathInvariants } from "./postgres-state-validation.js";
import type { TransactionWriteTracker } from "./postgres-write-tracker.js";

/**
 * Pre-commit gate: re-validates every record family the transaction's write
 * tracker recorded, directly against the database (targeted SQL lookups and
 * lineage-index checks rather than a full state reload). Covers threads,
 * turn-tree paths, turn nodes, turns and their dependents, branches
 * (including backward-move archiving), runs, staged results, and the
 * one-active-run-per-branch rule.
 *
 * @throws TuvrenPersistenceError with a `postgres_backend_*` code on the first
 *   violated invariant; the caller must roll the transaction back.
 */
export async function validateTransactionWriteSet(
  sql: DbSql,
  schemaName: string,
  scope: string,
  writeTracker: TransactionWriteTracker
): Promise<void> {
  for (const threadId of writeTracker.threadIds) {
    await validateThreadInDatabase(sql, schemaName, scope, threadId);
  }

  for (const turnTreeHash of writeTracker.turnTreeHashes) {
    await validateTurnTreePathsInDatabase(sql, schemaName, scope, turnTreeHash);
  }

  for (const turnNodeHash of writeTracker.turnNodeHashes) {
    await validateTurnNodeInDatabase(sql, schemaName, scope, turnNodeHash);
  }

  for (const turnId of writeTracker.turnIds) {
    await validateTurnInDatabase(sql, schemaName, scope, turnId);
  }

  for (const turnId of writeTracker.turnIdsForDependentValidation) {
    await validateTurnDependentsInDatabase(sql, schemaName, scope, turnId);
  }

  for (const [branchId] of writeTracker.branchWrites) {
    await validateBranchInDatabase(
      sql,
      schemaName,
      scope,
      writeTracker,
      branchId
    );
  }

  for (const runId of writeTracker.runIds) {
    await validateRunInDatabase(sql, schemaName, scope, runId);
  }

  for (const runId of writeTracker.stagedResultRunIds) {
    await validateStagedResultsForRunInDatabase(sql, schemaName, scope, runId);
  }

  for (const branchId of writeTracker.branchIdsForActiveRunValidation) {
    await validateActiveRunsForBranchInDatabase(
      sql,
      schemaName,
      scope,
      branchId
    );
  }
}

/**
 * Verifies the derived `turn_node_lineage_roots` index agrees exactly with
 * the loaded turn nodes: every entry references an existing node, every node
 * has an entry, and each entry's root hash and depth match a recomputed
 * ancestry walk.
 *
 * @throws TuvrenPersistenceError with a `postgres_backend_*` code describing
 *   the first index/lineage divergence.
 */
export async function validateTurnNodeLineageRootIndex(
  sql: DbSql,
  schemaName: string,
  scope: string,
  state: BackendState
): Promise<void> {
  const actualMetadataByTurnNodeHash = new Map<
    string,
    TurnNodeLineageMetadata
  >();

  const table = qualifyIdentifier(schemaName, "turn_node_lineage_roots");
  const lineageRows = await sql.unsafe<PostgresTurnNodeLineageRootRow[]>(
    `SELECT * FROM ${table} WHERE scope = $1`,
    [scope]
  );

  for (const row of lineageRows) {
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
        "postgres_backend_orphan_turn_node_lineage_metadata",
        { turnNodeHash: metadata.turnNodeHash }
      );
    }

    if (!state.turnNodes.has(metadata.rootTurnNodeHash)) {
      throw persistenceError(
        "turn node lineage metadata must reference an existing root turn node",
        "postgres_backend_orphan_turn_node_lineage_metadata",
        {
          rootTurnNodeHash: metadata.rootTurnNodeHash,
          turnNodeHash: metadata.turnNodeHash,
        }
      );
    }
  }

  // Issue #108 M2: `expectedPosition` used to be recomputed by walking
  // `previousTurnNodeHash` ancestry all the way to the thread root on every
  // single turn node (`computeExpectedTurnNodeLineageMetadata`), making this
  // loop O(n^2) on a long linear chain — the measured superlinear residual
  // in `loadValidatedState` (see the M2 section of
  // `.constitution/reports/108-git-faithful-blob-persistence.md`). One
  // `TurnNodeLineageIndex` shared across every iteration below memoizes each
  // node's root+depth the first time it is reached, so the whole loop is
  // O(n) total: a shared ancestor prefix (the common case on a chain) is
  // walked at most once no matter how many turn nodes reference it.
  const lineageIndex = createTurnNodeLineageIndex();

  for (const turnNode of state.turnNodes.values()) {
    const actualMetadata = actualMetadataByTurnNodeHash.get(turnNode.hash);

    if (actualMetadata === undefined) {
      throw persistenceError(
        "turn nodes must have lineage root metadata",
        "postgres_backend_missing_turn_node_lineage_metadata",
        { turnNodeHash: turnNode.hash }
      );
    }

    const expectedPosition = resolveTurnNodeLineagePosition(
      state.turnNodes,
      turnNode,
      lineageIndex,
      {
        onCycle: (): never => {
          throw persistenceError(
            "turn node lineage must not contain cycles",
            "postgres_backend_turn_node_lineage_cycle",
            { turnNodeHash: turnNode.hash }
          );
        },
        onMissingPreviousTurnNode: (missingTurnNodeHash: string): never => {
          throw persistenceError(
            "turn node lineage metadata requires complete turn node parent links",
            "postgres_backend_missing_turn_node_reference",
            {
              previousTurnNodeHash: missingTurnNodeHash,
              turnNodeHash: turnNode.hash,
            }
          );
        },
      }
    );

    if (
      actualMetadata.rootTurnNodeHash !== expectedPosition.rootTurnNodeHash ||
      actualMetadata.depth !== expectedPosition.depth
    ) {
      throw persistenceError(
        "turn node lineage metadata must match the parent-linked turn node chain",
        "postgres_backend_turn_node_lineage_metadata_mismatch",
        {
          actualDepth: actualMetadata.depth,
          actualRootTurnNodeHash: actualMetadata.rootTurnNodeHash,
          expectedDepth: expectedPosition.depth,
          expectedRootTurnNodeHash: expectedPosition.rootTurnNodeHash,
          turnNodeHash: turnNode.hash,
        }
      );
    }
  }
}

/**
 * Re-checks one written thread's schema/genesis/uniqueness invariants
 * directly against the database.
 */
async function validateThreadInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  threadId: string
): Promise<void> {
  const thread = await selectThread(sql, schemaName, scope, threadId);

  if (thread === null) {
    return;
  }

  const rootTurnNode = await ensureTurnNodeExistsInDatabase(
    sql,
    schemaName,
    scope,
    thread.rootTurnNodeHash,
    "thread.rootTurnNodeHash"
  );
  await validateTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    rootTurnNode
  );

  if (rootTurnNode.schemaId !== thread.schemaId) {
    throw persistenceError(
      "stored threads must use the schema of their root turn node",
      "postgres_backend_thread_schema_mismatch",
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
      "postgres_backend_thread_root_not_genesis",
      {
        previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
        rootTurnNodeHash: rootTurnNode.hash,
        threadId: thread.threadId,
      }
    );
  }

  const threadsTable = qualifyIdentifier(schemaName, "threads");
  const duplicateRootThreads = await sql.unsafe<Array<{ thread_id: string }>>(
    `
      SELECT thread_id
      FROM ${threadsTable}
      WHERE scope = $1
        AND root_turn_node_hash = $2
        AND thread_id <> $3
      LIMIT 1
    `,
    [scope, thread.rootTurnNodeHash, thread.threadId]
  );
  const duplicateRootThread = duplicateRootThreads[0];

  if (duplicateRootThread !== undefined) {
    throw persistenceError(
      "stored thread roots must be unique across threads",
      "postgres_backend_thread_root_not_unique",
      {
        existingOwnerThreadId: duplicateRootThread.thread_id,
        rootTurnNodeHash: thread.rootTurnNodeHash,
        threadId: thread.threadId,
      }
    );
  }
}

/**
 * Re-checks one written branch's thread-lineage, archive, and backward-move
 * invariants directly against the database.
 */
async function validateBranchInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  writeTracker: TransactionWriteTracker,
  branchId: string
): Promise<void> {
  const branch = await selectBranch(sql, schemaName, scope, branchId);

  if (branch === null) {
    return;
  }

  const thread = await ensureThreadExistsInDatabase(
    sql,
    schemaName,
    scope,
    branch.threadId,
    "branch.threadId"
  );
  await assertTurnNodeBelongsToThreadInDatabase(
    sql,
    schemaName,
    scope,
    branch.headTurnNodeHash,
    thread,
    "branch.headTurnNodeHash"
  );

  if (branch.archivedFromBranchId !== undefined) {
    await validateArchiveBranchInDatabase(
      sql,
      schemaName,
      scope,
      writeTracker,
      branch
    );
  }

  const trackedBranch = writeTracker.branchWrites.get(branch.branchId);

  if (trackedBranch?.before === null || trackedBranch?.before === undefined) {
    return;
  }

  const headMoveDirection = await classifyTurnNodeRelationshipInDatabase(
    sql,
    schemaName,
    scope,
    trackedBranch.before.headTurnNodeHash,
    branch.headTurnNodeHash
  );

  if (headMoveDirection === "backward") {
    await assertBackwardBranchMoveIsArchivedInDatabase(
      sql,
      schemaName,
      scope,
      writeTracker,
      trackedBranch.before,
      branch
    );
  }
}

/**
 * Re-checks one written archive branch's source-thread match, pre-transaction
 * source existence, preserved head, and paired backward move directly
 * against the database.
 */
async function validateArchiveBranchInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  writeTracker: TransactionWriteTracker,
  branch: StoredBranch
): Promise<void> {
  if (branch.archivedFromBranchId === undefined) {
    return;
  }

  const sourceBranch = await ensureBranchExistsInDatabase(
    sql,
    schemaName,
    scope,
    branch.archivedFromBranchId,
    "branch.archivedFromBranchId"
  );

  if (sourceBranch.threadId !== branch.threadId) {
    throw persistenceError(
      "stored branches must archive only from branches in the same thread",
      "postgres_backend_branch_archive_thread_mismatch",
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
    (await writeTracker.captureBranchBaseline(
      sql,
      schemaName,
      scope,
      branch.archivedFromBranchId
    ));

  if (sourceBranchBeforeTransaction === null) {
    throw persistenceError(
      "new archive branches must reference a source branch that existed before the transaction",
      "postgres_backend_branch_archive_source_missing_before_transaction",
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
      "postgres_backend_branch_archive_head_mismatch",
      {
        archivedFromBranchId: branch.archivedFromBranchId,
        archiveHeadTurnNodeHash: branch.headTurnNodeHash,
        sourceHeadTurnNodeHash: sourceBranchBeforeTransaction.headTurnNodeHash,
      }
    );
  }

  if (
    (await classifyTurnNodeRelationshipInDatabase(
      sql,
      schemaName,
      scope,
      sourceBranchBeforeTransaction.headTurnNodeHash,
      sourceBranch.headTurnNodeHash
    )) !== "backward"
  ) {
    throw persistenceError(
      "new archive branches must be paired with a backward move on their source branch",
      "postgres_backend_branch_archive_without_backward_move",
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

/**
 * Re-checks one written turn node's schema match, lineage metadata, and
 * consumed-staged-result references directly against the database.
 */
async function validateTurnNodeInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string
): Promise<void> {
  const turnNode = await selectTurnNode(sql, schemaName, scope, turnNodeHash);

  if (turnNode === null) {
    return;
  }

  const turnTree = await ensureTurnTreeExistsInDatabase(
    sql,
    schemaName,
    scope,
    turnNode.turnTreeHash,
    "turnNode.turnTreeHash"
  );

  if (turnTree.schemaId !== turnNode.schemaId) {
    throw persistenceError(
      "stored turn nodes must use the schema of their referenced turn tree",
      "postgres_backend_turn_node_schema_mismatch",
      {
        turnNodeHash: turnNode.hash,
        turnNodeSchemaId: turnNode.schemaId,
        turnTreeHash: turnTree.hash,
        turnTreeSchemaId: turnTree.schemaId,
      }
    );
  }

  await validateTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    turnNode
  );

  for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
    turnNode
  )) {
    await ensureObjectExistsInDatabase(
      sql,
      schemaName,
      scope,
      objectHash,
      "turnNode.consumedStagedResultsCbor"
    );
  }
}

/**
 * Re-checks one written turn's branch/thread consistency, lineage
 * membership, descent, and parent link directly against the database.
 */
async function validateTurnInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnId: string
): Promise<void> {
  const turn = await selectTurn(sql, schemaName, scope, turnId);

  if (turn === null) {
    return;
  }

  const thread = await ensureThreadExistsInDatabase(
    sql,
    schemaName,
    scope,
    turn.threadId,
    "turn.threadId"
  );
  const branch = await ensureBranchExistsInDatabase(
    sql,
    schemaName,
    scope,
    turn.branchId,
    "turn.branchId"
  );

  if (branch.threadId !== thread.threadId) {
    throw persistenceError(
      "stored turns must reference a branch on the same thread",
      "postgres_backend_turn_branch_thread_mismatch",
      {
        branchId: branch.branchId,
        branchThreadId: branch.threadId,
        threadId: thread.threadId,
        turnId: turn.turnId,
      }
    );
  }

  await assertTurnNodeBelongsToThreadInDatabase(
    sql,
    schemaName,
    scope,
    turn.startTurnNodeHash,
    thread,
    "turn.startTurnNodeHash"
  );
  await assertTurnNodeBelongsToThreadInDatabase(
    sql,
    schemaName,
    scope,
    turn.headTurnNodeHash,
    thread,
    "turn.headTurnNodeHash"
  );
  await assertTurnNodeDescendsFromInDatabase(
    sql,
    schemaName,
    scope,
    turn.headTurnNodeHash,
    turn.startTurnNodeHash,
    "turn.headTurnNodeHash"
  );
  await assertTurnParentLinkInDatabase(
    sql,
    schemaName,
    scope,
    turn,
    "turn.parentTurnId"
  );
}

/**
 * Re-validates every turn and run whose lineage position depends on a turn
 * whose head hash just changed — the child turns branching from it and the
 * runs it hosts.
 */
async function validateTurnDependentsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnId: string
): Promise<void> {
  for (const dependentTurn of await selectTurnsByParentTurnId(
    sql,
    schemaName,
    scope,
    turnId
  )) {
    await validateTurnInDatabase(
      sql,
      schemaName,
      scope,
      dependentTurn.turnId
    );
  }

  for (const run of await selectRunsByTurn(sql, schemaName, scope, turnId)) {
    await validateRunInDatabase(sql, schemaName, scope, run.runId);
  }
}

/**
 * Re-checks one written run's referential and schema consistency, turn-span
 * containment of its start and created turn nodes, canonical lineage, and
 * (when active) head alignment, directly against the database.
 */
async function validateRunInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string
): Promise<void> {
  const run = await selectRun(sql, schemaName, scope, runId);

  if (run === null) {
    return;
  }

  const branch = await ensureBranchExistsInDatabase(
    sql,
    schemaName,
    scope,
    run.branchId,
    "run.branchId"
  );
  const turn = await ensureTurnExistsInDatabase(
    sql,
    schemaName,
    scope,
    run.turnId,
    "run.turnId"
  );
  const startTurnNode = await ensureTurnNodeExistsInDatabase(
    sql,
    schemaName,
    scope,
    run.startTurnNodeHash,
    "run.startTurnNodeHash"
  );
  const thread = await ensureThreadExistsInDatabase(
    sql,
    schemaName,
    scope,
    turn.threadId,
    "turn.threadId"
  );

  if (turn.branchId !== branch.branchId) {
    throw persistenceError(
      "stored runs must reference a turn on the same branch",
      "postgres_backend_run_branch_mismatch",
      {
        branchId: branch.branchId,
        runId: run.runId,
        turnBranchId: turn.branchId,
        turnId: turn.turnId,
      }
    );
  }

  await assertTurnNodeBelongsToThreadInDatabase(
    sql,
    schemaName,
    scope,
    run.startTurnNodeHash,
    thread,
    "run.startTurnNodeHash"
  );

  if (startTurnNode.schemaId !== run.schemaId) {
    throw persistenceError(
      "stored runs must use the schema of their start turn node",
      "postgres_backend_run_schema_mismatch",
      {
        runId: run.runId,
        runSchemaId: run.schemaId,
        startTurnNodeHash: startTurnNode.hash,
        turnNodeSchemaId: startTurnNode.schemaId,
      }
    );
  }

  await assertRunStartTurnNodeWithinTurnSpanInDatabase(
    sql,
    schemaName,
    scope,
    turn,
    run.startTurnNodeHash,
    "run.startTurnNodeHash"
  );

  for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
    const createdTurnNode = await ensureTurnNodeExistsInDatabase(
      sql,
      schemaName,
      scope,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    await assertTurnNodeBelongsToThreadInDatabase(
      sql,
      schemaName,
      scope,
      turnNodeHash,
      thread,
      "run.createdTurnNodesCbor"
    );
    await assertRunCreatedTurnNodeWithinTurnSpanInDatabase(
      sql,
      schemaName,
      scope,
      turn,
      createdTurnNode,
      "run.createdTurnNodesCbor"
    );
  }

  await assertRunCreatedTurnNodesAreCanonicalInDatabase(
    sql,
    schemaName,
    scope,
    run
  );

  if (run.status === "running" || run.status === "paused") {
    await assertActiveRunHeadAlignmentInDatabase(run, branch, turn);
  }
}

/** Asserts a non-`running` run retains no staged results. */
async function validateStagedResultsForRunInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  runId: string
): Promise<void> {
  const run = await ensureRunExistsInDatabase(
    sql,
    schemaName,
    scope,
    runId,
    "stagedResults.runId"
  );
  const stagedResultCount = await countStagedResultsByRun(
    sql,
    schemaName,
    scope,
    runId
  );

  if (run.status !== "running" && stagedResultCount > 0) {
    throw persistenceError(
      "stored terminal or paused runs must not retain staged results",
      "postgres_backend_run_has_terminal_staged_results",
      {
        runId: run.runId,
        stagedResultCount,
        status: run.status,
      }
    );
  }
}

/**
 * Asserts a branch has at most one active run and that every active run on
 * it is head-aligned.
 */
async function validateActiveRunsForBranchInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  branchId: string
): Promise<void> {
  const branch = await selectBranch(sql, schemaName, scope, branchId);

  if (branch === null) {
    return;
  }

  const activeRuns = await selectActiveRunsByBranch(
    sql,
    schemaName,
    scope,
    branch.branchId
  );

  if (activeRuns.length > 1) {
    throw persistenceError(
      "stored branches must not have more than one active run",
      "postgres_backend_multiple_active_runs",
      {
        activeRunCount: activeRuns.length,
        branchId: branch.branchId,
      }
    );
  }

  for (const run of activeRuns) {
    const turn = await ensureTurnExistsInDatabase(
      sql,
      schemaName,
      scope,
      run.turnId,
      "run.turnId"
    );
    await assertActiveRunHeadAlignmentInDatabase(run, branch, turn);
  }
}

/**
 * Re-validates a written turn tree's path collection by projecting just the
 * relevant rows (schema, turn tree, its stored paths, and any referenced
 * chunks) into a minimal `BackendState` and delegating to
 * `validateTurnTreePathInvariants`. The lineage/run-related helpers in that
 * shared validator are stubbed to throw, since this code path never
 * exercises them (turn trees do not reference turns or runs).
 */
async function validateTurnTreePathsInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnTreeHash: string
): Promise<void> {
  const turnTree = await selectTurnTree(sql, schemaName, scope, turnTreeHash);

  if (turnTree === null) {
    return;
  }

  const state = createEmptyState();
  const schemaRecord = await ensureSchemaExistsInDatabase(
    sql,
    schemaName,
    scope,
    turnTree.schemaId,
    "turnTree.schemaId"
  );
  const storedPaths = await selectTurnTreePathsByTurnTree(
    sql,
    schemaName,
    scope,
    turnTree.hash
  );
  const pathMap = new Map<string, StoredTurnTreePath>();

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
      const chunk = await ensureOrderedPathChunkExistsInDatabase(
        sql,
        schemaName,
        scope,
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

/**
 * Inserts a keyed record into a loaded-record map, throwing
 * `postgres_backend_duplicate_loaded_record` if the key is already present —
 * used to catch a corrupted database with duplicate rows a primary key
 * should have prevented.
 */
function setUniqueLoadedRecord<T>(
  records: Map<string, T>,
  key: string,
  value: T,
  recordType: string,
  details: Record<string, string>
): void {
  if (records.has(key)) {
    throw persistenceError(
      `postgres backend found duplicate ${recordType} rows while loading persisted state`,
      "postgres_backend_duplicate_loaded_record",
      { key, recordType, ...details }
    );
  }

  records.set(key, value);
}
