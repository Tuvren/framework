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
  assertStoredBranch,
  assertStoredObjectIdentity,
  assertStoredObserveAnnotation,
  assertStoredOrderedPathChunkIdentity,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  decodeDeterministicKernelRecord,
  type StoredBranch,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { persistenceError } from "./sqlite-errors.js";
import {
  type BackendState,
  decodeHashStringArray,
  decodeTurnTreeSchema,
} from "./sqlite-records.js";
import {
  compareStoredTurn,
  ensureBranchExists,
  ensureObjectExists,
  ensureOrderedPathChunkExists,
  ensureRunExists,
  ensureSchemaRecordExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
} from "./sqlite-state-utils.js";

interface ValidationHelpers {
  assertActiveRunHeadAlignment: (
    run: StoredRun,
    branch: StoredBranch,
    turn: StoredTurn
  ) => void;
  assertBackwardBranchMoveIsArchived: (
    state: BackendState,
    baseState: BackendState,
    previousBranch: StoredBranch,
    branch: StoredBranch
  ) => void;
  assertChunkedTurnTreePathChunkLayout: (
    chunk: StoredOrderedPathChunk,
    index: number,
    chunkCount: number
  ) => void;
  assertRunCreatedTurnNodesAreCanonical: (
    state: BackendState,
    run: StoredRun
  ) => void;
  assertRunCreatedTurnNodeWithinTurnSpan: (
    state: BackendState,
    turn: StoredTurn,
    createdTurnNode: StoredTurnNode,
    label: string
  ) => void;
  assertRunStartTurnNodeWithinTurnSpan: (
    state: BackendState,
    turn: StoredTurn,
    startTurnNodeHash: string,
    label: string
  ) => void;
  assertTurnParentLink: (
    state: BackendState,
    turn: StoredTurn,
    label: string
  ) => void;
  classifyTurnNodeRelationship: (
    state: BackendState,
    fromTurnNodeHash: string,
    toTurnNodeHash: string
  ) => "backward" | "forward" | "same" | "lateral";
  decodeRunCreatedTurnNodeHashes: (run: StoredRun) => string[];
  decodeTurnNodeConsumedStagedResultObjectHashes: (
    turnNode: StoredTurnNode
  ) => string[];
  validateHashString: (hash: string) => string;
}

export async function validateLoadedState(state: BackendState): Promise<void> {
  for (const objectRecord of state.objects.values()) {
    await assertStoredObjectIdentity(objectRecord, "stored object row");
  }

  for (const schemaRecord of state.schemas.values()) {
    assertStoredSchema(schemaRecord, "stored schema row");
  }

  for (const turnTree of state.turnTrees.values()) {
    const schema = getSchemaForSchemaId(
      state,
      turnTree.schemaId,
      "turnTree.schemaId"
    );
    await assertStoredTurnTreeIdentity(
      turnTree,
      schema,
      "stored turn tree row"
    );
  }

  for (const chunkRecord of state.orderedPathChunks.values()) {
    await assertStoredOrderedPathChunkIdentity(
      chunkRecord,
      "stored ordered path chunk row"
    );
  }

  for (const storedPaths of state.turnTreePaths.values()) {
    for (const storedPath of storedPaths.values()) {
      const turnTree = ensureTurnTreeExists(
        state,
        storedPath.turnTreeHash,
        "turnTreePath.turnTreeHash"
      );
      const schema = getSchemaForSchemaId(
        state,
        turnTree.schemaId,
        "turnTree.schemaId"
      );
      assertStoredTurnTreePath(storedPath, schema, "stored turn tree path row");
    }
  }

  for (const turnNode of state.turnNodes.values()) {
    await assertStoredTurnNodeIdentity(turnNode, "stored turn node row");
  }

  for (const thread of state.threads.values()) {
    assertStoredThread(thread, "stored thread row");
  }

  for (const branch of state.branches.values()) {
    assertStoredBranch(branch, "stored branch row");
  }

  for (const turn of state.turns.values()) {
    assertStoredTurn(turn, "stored turn row");
  }

  for (const run of state.runs.values()) {
    assertStoredRun(run, "stored run row");
  }

  for (const records of state.observeAnnotations.values()) {
    for (const record of records) {
      assertStoredObserveAnnotation(record, "stored observe annotation row");
    }
  }

  for (const stagedResults of state.stagedResults.values()) {
    for (const stagedResult of stagedResults.values()) {
      assertStoredStagedResult(stagedResult, "stored staged result row");
    }
  }
}

export function validateCommittedState(
  state: BackendState,
  baseState: BackendState,
  helpers: ValidationHelpers
): void {
  validateThreadInvariants(state);
  validateBranchInvariants(state, baseState, helpers);
  validateTurnNodeInvariants(state, helpers);
  validateTurnInvariants(state, helpers);
  validateRunInvariants(state, helpers);
  validateTurnTreePathInvariants(state, helpers);
}

function validateThreadInvariants(state: BackendState): void {
  const rootTurnNodeOwners = new Map<string, string>();

  for (const thread of state.threads.values()) {
    const rootTurnNode = ensureTurnNodeExists(
      state,
      thread.rootTurnNodeHash,
      "thread.rootTurnNodeHash"
    );

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

    const existingOwnerThreadId = rootTurnNodeOwners.get(
      thread.rootTurnNodeHash
    );
    if (
      existingOwnerThreadId !== undefined &&
      existingOwnerThreadId !== thread.threadId
    ) {
      throw persistenceError(
        "stored thread roots must be unique across threads",
        "sqlite_backend_thread_root_not_unique",
        {
          existingOwnerThreadId,
          rootTurnNodeHash: thread.rootTurnNodeHash,
          threadId: thread.threadId,
        }
      );
    }

    rootTurnNodeOwners.set(thread.rootTurnNodeHash, thread.threadId);
  }
}

function validateBranchInvariants(
  state: BackendState,
  baseState: BackendState,
  helpers: ValidationHelpers
): void {
  for (const branch of state.branches.values()) {
    const thread = ensureThreadExists(
      state,
      branch.threadId,
      "branch.threadId"
    );

    assertTurnNodeBelongsToThread(
      state,
      branch.headTurnNodeHash,
      thread,
      "branch.headTurnNodeHash"
    );

    if (branch.archivedFromBranchId === undefined) {
      continue;
    }

    const sourceBranch = ensureBranchExists(
      state,
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

    const existingBranch = baseState.branches.get(branch.branchId);
    const sourceBranchBeforeTransaction = baseState.branches.get(
      branch.archivedFromBranchId
    );

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction === undefined
    ) {
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
      existingBranch === undefined &&
      sourceBranchBeforeTransaction !== undefined &&
      branch.headTurnNodeHash !== sourceBranchBeforeTransaction.headTurnNodeHash
    ) {
      throw persistenceError(
        "new archive branches must preserve the pre-rollback source branch head",
        "sqlite_backend_branch_archive_head_mismatch",
        {
          archivedFromBranchId: branch.archivedFromBranchId,
          archiveHeadTurnNodeHash: branch.headTurnNodeHash,
          sourceHeadTurnNodeHash:
            sourceBranchBeforeTransaction.headTurnNodeHash,
        }
      );
    }

    if (
      existingBranch === undefined &&
      sourceBranchBeforeTransaction !== undefined &&
      helpers.classifyTurnNodeRelationship(
        state,
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

  for (const branch of state.branches.values()) {
    const previousBranch = baseState.branches.get(branch.branchId);

    if (previousBranch === undefined) {
      continue;
    }

    const headMoveDirection = helpers.classifyTurnNodeRelationship(
      state,
      previousBranch.headTurnNodeHash,
      branch.headTurnNodeHash
    );

    if (headMoveDirection !== "backward") {
      continue;
    }

    helpers.assertBackwardBranchMoveIsArchived(
      state,
      baseState,
      previousBranch,
      branch
    );
  }
}

function validateTurnNodeInvariants(
  state: BackendState,
  helpers: ValidationHelpers
): void {
  for (const turnNode of state.turnNodes.values()) {
    const turnTree = ensureTurnTreeExists(
      state,
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

    for (const objectHash of helpers.decodeTurnNodeConsumedStagedResultObjectHashes(
      turnNode
    )) {
      ensureObjectExists(
        state,
        objectHash,
        "turnNode.consumedStagedResultsCbor"
      );
    }
  }
}

function validateTurnInvariants(
  state: BackendState,
  helpers: ValidationHelpers
): void {
  for (const turn of state.turns.values()) {
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");
    const branch = ensureBranchExists(state, turn.branchId, "turn.branchId");

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

    assertTurnNodeBelongsToThread(
      state,
      turn.startTurnNodeHash,
      thread,
      "turn.startTurnNodeHash"
    );
    assertTurnNodeBelongsToThread(
      state,
      turn.headTurnNodeHash,
      thread,
      "turn.headTurnNodeHash"
    );
    assertTurnNodeDescendsFrom(
      state,
      turn.headTurnNodeHash,
      turn.startTurnNodeHash,
      "turn.headTurnNodeHash"
    );

    helpers.assertTurnParentLink(state, turn, "turn.parentTurnId");
  }
}

function validateRunInvariants(
  state: BackendState,
  helpers: ValidationHelpers
): void {
  const activeRunCounts = new Map<string, number>();

  for (const run of state.runs.values()) {
    const branch = ensureBranchExists(state, run.branchId, "run.branchId");
    const turn = ensureTurnExists(state, run.turnId, "run.turnId");
    const startTurnNode = ensureTurnNodeExists(
      state,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");

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

    assertTurnNodeBelongsToThread(
      state,
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

    helpers.assertRunStartTurnNodeWithinTurnSpan(
      state,
      turn,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );

    for (const turnNodeHash of helpers.decodeRunCreatedTurnNodeHashes(run)) {
      const createdTurnNode = ensureTurnNodeExists(
        state,
        turnNodeHash,
        "run.createdTurnNodesCbor"
      );
      assertTurnNodeBelongsToThread(
        state,
        turnNodeHash,
        thread,
        "run.createdTurnNodesCbor"
      );
      helpers.assertRunCreatedTurnNodeWithinTurnSpan(
        state,
        turn,
        createdTurnNode,
        "run.createdTurnNodesCbor"
      );
    }

    helpers.assertRunCreatedTurnNodesAreCanonical(state, run);

    if (run.status === "running" || run.status === "paused") {
      helpers.assertActiveRunHeadAlignment(run, branch, turn);
      const currentActiveCount = activeRunCounts.get(run.branchId) ?? 0;
      activeRunCounts.set(run.branchId, currentActiveCount + 1);
    }

    const stagedResultsForRun = state.stagedResults.get(run.runId);

    if (run.status !== "running" && stagedResultsForRun !== undefined) {
      throw persistenceError(
        "stored terminal or paused runs must not retain staged results",
        "sqlite_backend_run_has_terminal_staged_results",
        {
          runId: run.runId,
          stagedResultCount: stagedResultsForRun.size,
          status: run.status,
        }
      );
    }
  }

  for (const [branchId, activeRunCount] of activeRunCounts.entries()) {
    if (activeRunCount > 1) {
      throw persistenceError(
        "stored branches must not have more than one active run",
        "sqlite_backend_multiple_active_runs",
        {
          activeRunCount,
          branchId,
        }
      );
    }
  }

  for (const [runId, stagedResults] of state.stagedResults.entries()) {
    const run = ensureRunExists(state, runId, "stagedResults.runId");

    if (run.status !== "running") {
      throw persistenceError(
        "stored staged results may only exist for running runs",
        "sqlite_backend_staged_result_run_not_running",
        {
          runId,
          stagedResultCount: stagedResults.size,
          status: run.status,
        }
      );
    }
  }
}

export function validateTurnTreePathInvariants(
  state: BackendState,
  helpers: ValidationHelpers
): void {
  for (const [turnTreeHash, storedPaths] of state.turnTreePaths.entries()) {
    ensureTurnTreeExists(state, turnTreeHash, "turnTreePath.turnTreeHash");

    if (storedPaths.size === 0) {
      throw persistenceError(
        "stored turn tree path collections must not be empty",
        "sqlite_backend_empty_turn_tree_path_collection",
        { turnTreeHash }
      );
    }
  }

  validateTurnTreePathCardinalityMetadata(state, helpers);

  for (const turnTree of state.turnTrees.values()) {
    assertTurnTreeManifestMatchesStoredPaths(state, turnTree, helpers);
  }
}

function validateTurnTreePathCardinalityMetadata(
  state: BackendState,
  helpers: ValidationHelpers
): void {
  for (const storedPaths of state.turnTreePaths.values()) {
    for (const storedPath of storedPaths.values()) {
      if (storedPath.collectionKind === "single") {
        continue;
      }

      if (storedPath.orderedEncoding === "flat") {
        validateOrderedFlatPathCardinality(storedPath);
        continue;
      }

      validateOrderedChunkedPathCardinality(state, storedPath, helpers);
    }
  }
}

function validateOrderedFlatPathCardinality(
  storedPath: Extract<
    StoredTurnTreePath,
    { collectionKind: "ordered"; orderedEncoding: "flat" }
  >
): void {
  const hashes = decodeHashStringArray(
    storedPath.orderedInlineCbor,
    "storedPath.orderedInlineCbor"
  );

  if (storedPath.orderedCount !== hashes.length) {
    throw persistenceError(
      "stored ordered turn tree paths must keep orderedCount aligned with encoded hashes",
      "sqlite_backend_turn_tree_path_ordered_count_mismatch",
      {
        decodedCount: hashes.length,
        orderedCount: storedPath.orderedCount,
        path: storedPath.path,
        turnTreeHash: storedPath.turnTreeHash,
      }
    );
  }
}

function validateOrderedChunkedPathCardinality(
  state: BackendState,
  storedPath: Extract<
    StoredTurnTreePath,
    { collectionKind: "ordered"; orderedEncoding: "chunked" }
  >,
  helpers: ValidationHelpers
): void {
  const chunkHashes = decodeHashStringArray(
    storedPath.orderedChunkListCbor,
    "storedPath.orderedChunkListCbor"
  );
  let totalCount = 0;

  for (const [index, chunkHash] of chunkHashes.entries()) {
    const chunk = ensureOrderedPathChunkExists(
      state,
      chunkHash,
      "storedPath.orderedChunkListCbor"
    );
    const chunkItemHashes = decodeHashStringArray(
      chunk.itemsCbor,
      "chunk.itemsCbor"
    );

    if (chunk.itemCount !== chunkItemHashes.length) {
      throw persistenceError(
        "stored ordered path chunk rows must keep itemCount aligned with itemsCbor",
        "sqlite_backend_ordered_path_chunk_item_count_mismatch",
        {
          chunkHash: chunk.chunkHash,
          decodedCount: chunkItemHashes.length,
          itemCount: chunk.itemCount,
        }
      );
    }

    helpers.assertChunkedTurnTreePathChunkLayout(
      chunk,
      index,
      chunkHashes.length
    );
    totalCount += chunk.itemCount;
  }

  if (totalCount !== storedPath.orderedCount) {
    throw persistenceError(
      "stored ordered turn tree paths must keep orderedCount aligned with referenced chunk cardinality",
      "sqlite_backend_turn_tree_path_ordered_count_mismatch",
      {
        orderedCount: storedPath.orderedCount,
        path: storedPath.path,
        totalCount,
        turnTreeHash: storedPath.turnTreeHash,
      }
    );
  }
}

function _listTurnsByThread(
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

  turns.sort(compareStoredTurn);
  return turns;
}

function getSchemaForSchemaId(
  state: BackendState,
  schemaId: string,
  label: string
): TurnTreeSchema {
  const schemaRecord = ensureSchemaRecordExists(state, schemaId, label);
  return decodeSchemaRecord(schemaRecord.schemaCbor, `${label} schema`);
}

function getSchemaForTurnTree(
  state: BackendState,
  turnTree: StoredTurnTree
): TurnTreeSchema {
  return getSchemaForSchemaId(state, turnTree.schemaId, "turnTree.schemaId");
}

function assertTurnNodeBelongsToThread(
  state: BackendState,
  turnNodeHash: string,
  thread: StoredThread,
  label: string
): void {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = turnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        `${label} must not traverse a cyclic turn node lineage`,
        "sqlite_backend_cyclic_turn_node_lineage",
        {
          threadId: thread.threadId,
          turnNodeHash,
        }
      );
    }

    visitedTurnNodes.add(currentTurnNodeHash);

    if (currentTurnNodeHash === thread.rootTurnNodeHash) {
      return;
    }

    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      label
    ).previousTurnNodeHash;
  }

  throw persistenceError(
    `${label} must belong to the referenced thread by lineage walk`,
    "sqlite_backend_thread_lineage_mismatch",
    {
      threadId: thread.threadId,
      threadRootTurnNodeHash: thread.rootTurnNodeHash,
      turnNodeHash,
    }
  );
}

function assertTurnNodeDescendsFrom(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string
): void {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = descendantTurnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        `${label} must not traverse a cyclic turn node lineage`,
        "sqlite_backend_cyclic_turn_node_lineage",
        {
          ancestorTurnNodeHash,
          descendantTurnNodeHash,
        }
      );
    }

    if (currentTurnNodeHash === ancestorTurnNodeHash) {
      return;
    }

    visitedTurnNodes.add(currentTurnNodeHash);
    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      label
    ).previousTurnNodeHash;
  }

  throw persistenceError(
    `${label} must be a descendant of the referenced start turn node`,
    "sqlite_backend_turn_node_not_descendant",
    {
      ancestorTurnNodeHash,
      descendantTurnNodeHash,
    }
  );
}

function assertTurnTreeManifestMatchesStoredPaths(
  state: BackendState,
  turnTree: StoredTurnTree,
  helpers: ValidationHelpers
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
      "sqlite_backend_invalid_turn_tree_manifest",
      { turnTreeHash: turnTree.hash }
    );
  }

  if (storedPaths === undefined) {
    throw persistenceError(
      "stored turn trees must have indexed path rows",
      "sqlite_backend_missing_turn_tree_paths",
      { turnTreeHash: turnTree.hash }
    );
  }

  if (storedPaths.size !== schema.paths.length) {
    throw persistenceError(
      "stored turn tree paths must fully cover the schema-defined manifest",
      "sqlite_backend_turn_tree_path_count_mismatch",
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
        "sqlite_backend_missing_turn_tree_path",
        {
          path: pathDefinition.path,
          turnTreeHash: turnTree.hash,
        }
      );
    }

    const manifestPathValue = Reflect.get(manifestValue, pathDefinition.path);
    const storedPathValue = resolveStoredTurnTreePathValue(
      state,
      storedPath,
      helpers
    );

    if (!areManifestPathValuesEqual(manifestPathValue, storedPathValue)) {
      throw persistenceError(
        "stored turn tree paths must match the logical manifest",
        "sqlite_backend_turn_tree_manifest_path_mismatch",
        {
          path: pathDefinition.path,
          turnTreeHash: turnTree.hash,
        }
      );
    }
  }
}

function resolveStoredTurnTreePathValue(
  state: BackendState,
  storedPath: StoredTurnTreePath,
  _helpers: ValidationHelpers
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

function areManifestPathValuesEqual(
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

function decodeSchemaRecord(bytes: Uint8Array, label: string): TurnTreeSchema {
  return decodeTurnTreeSchema(bytes, label);
}
