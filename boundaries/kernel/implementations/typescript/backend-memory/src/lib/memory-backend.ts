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

import { AsyncLocalStorage } from "node:async_hooks";
import {
  assertHashString,
  type EpochMs,
  TuvrenPersistenceError,
} from "@tuvren/core-types";
import {
  assertStoredBranch,
  assertStoredObject,
  assertStoredObjectIdentity,
  assertStoredOrderedPathChunk,
  assertStoredOrderedPathChunkIdentity,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTree,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type RuntimeBackend as KrakenBackend,
  type RuntimeBackendTx as KrakenBackendTx,
  type StoredBranch,
  type StoredObject,
  type StoredOrderedPathChunk,
  type StoredRun,
  type StoredSchema,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";

const ORDERED_PATH_CHUNK_THRESHOLD = 32;
const ORDERED_PATH_CHUNK_SIZE = 32;

interface BackendState {
  branches: Map<string, StoredBranch>;
  objects: Map<string, StoredObject>;
  orderedPathChunks: Map<string, StoredOrderedPathChunk>;
  runs: Map<string, StoredRun>;
  schemas: Map<string, StoredSchema>;
  stagedResults: Map<string, Map<string, StoredStagedResult>>;
  threads: Map<string, StoredThread>;
  turnNodes: Map<string, StoredTurnNode>;
  turns: Map<string, StoredTurn>;
  turnTreePaths: Map<string, Map<string, StoredTurnTreePath>>;
  turnTrees: Map<string, StoredTurnTree>;
}

interface MutableRepositories extends KrakenBackendTx {
  readonly now: () => number;
}

export interface MemoryBackendOptions {
  now?: () => EpochMs;
}

class MemoryBackend implements KrakenBackend {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();
  private state: BackendState = createEmptyState();
  private readonly now: () => number;

  constructor(options?: MemoryBackendOptions) {
    this.now = options?.now ?? Date.now;
  }

  health(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  async transact<T>(work: (tx: KrakenBackendTx) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() === true) {
      throw persistenceError(
        "memory backend transactions must not be nested",
        "memory_backend_nested_transaction"
      );
    }

    const priorTransaction = this.transactionQueue;
    let releaseQueue: (() => void) | undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await priorTransaction;

    try {
      const draftState = cloneState(this.state);
      let active = true;
      const repositories = createRepositories(
        draftState,
        this.now,
        () => active && this.transactionContext.getStore() === true
      );
      let result: T;

      try {
        result = await this.transactionContext.run(true, () =>
          work(repositories)
        );
      } finally {
        active = false;
      }

      validateCommittedState(draftState, this.state);
      this.state = draftState;
      return result;
    } finally {
      releaseQueue?.();
    }
  }
}

export function createMemoryBackend(
  options?: MemoryBackendOptions
): KrakenBackend {
  return new MemoryBackend(options);
}

function createRepositories(
  state: BackendState,
  now: () => number,
  isTransactionActive: () => boolean
): MutableRepositories {
  const assertTransactionActive = (): void => {
    if (!isTransactionActive()) {
      throw persistenceError(
        "memory backend transaction handles must not outlive their transaction",
        "memory_backend_inactive_transaction_handle"
      );
    }
  };

  return {
    branches: {
      get(branchId) {
        assertTransactionActive();
        const branch = state.branches.get(branchId);
        return Promise.resolve(
          branch === undefined ? null : cloneStoredBranch(branch)
        );
      },
      listByThread(threadId) {
        assertTransactionActive();
        const branches: StoredBranch[] = [];

        for (const branch of state.branches.values()) {
          if (branch.threadId === threadId) {
            branches.push(cloneStoredBranch(branch));
          }
        }

        branches.sort(compareStoredBranch);
        return Promise.resolve(branches);
      },
      set(record) {
        assertTransactionActive();
        assertStoredBranch(record, "record");
        const thread = ensureThreadExists(
          state,
          record.threadId,
          "record.threadId"
        );
        ensureTurnNodeExists(
          state,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );
        assertTurnNodeBelongsToThread(
          state,
          record.headTurnNodeHash,
          thread,
          "record.headTurnNodeHash"
        );

        const existingBranch = state.branches.get(record.branchId);

        if (record.archivedFromBranchId !== undefined) {
          const sourceBranch = ensureBranchExists(
            state,
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );

          if (sourceBranch.threadId !== record.threadId) {
            throw persistenceError(
              "stored branches must archive only from branches in the same thread",
              "memory_backend_branch_archive_thread_mismatch",
              {
                archivedFromBranchId: sourceBranch.branchId,
                branchId: record.branchId,
                branchThreadId: record.threadId,
                sourceThreadId: sourceBranch.threadId,
              }
            );
          }
        }

        if (existingBranch !== undefined) {
          assertImmutableField(
            existingBranch.threadId,
            record.threadId,
            "record.threadId",
            "memory_backend_branch_thread_immutable"
          );
          assertImmutableField(
            existingBranch.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "memory_backend_branch_created_at_immutable"
          );
          assertImmutableOptionalField(
            existingBranch.archivedFromBranchId,
            record.archivedFromBranchId,
            "record.archivedFromBranchId",
            "memory_backend_branch_archive_source_immutable"
          );
          assertMonotonicUpdatedAtMs(
            existingBranch.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "memory_backend_branch_updated_at_regressed"
          );

          assertBranchHeadMoveIsLinear(
            state,
            existingBranch.headTurnNodeHash,
            record.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        state.branches.set(record.branchId, cloneStoredBranch(record));
        return Promise.resolve();
      },
    },
    now,
    objects: {
      get(hash) {
        assertTransactionActive();
        const record = state.objects.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredObject(record)
        );
      },
      has(hash) {
        assertTransactionActive();
        return Promise.resolve(state.objects.has(hash));
      },
      async put(record) {
        assertTransactionActive();
        assertStoredObject(record, "record");
        await assertStoredObjectIdentity(record, "record");
        putImmutableRecord(
          state.objects,
          record.hash,
          record,
          cloneStoredObject,
          areStoredObjectsEqual,
          "stored object"
        );
      },
    },
    orderedPathChunks: {
      get(chunkHash) {
        assertTransactionActive();
        const record = state.orderedPathChunks.get(chunkHash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredOrderedPathChunk(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredOrderedPathChunk(record, "record");
        await assertStoredOrderedPathChunkIdentity(record, "record");
        putImmutableRecord(
          state.orderedPathChunks,
          record.chunkHash,
          record,
          cloneStoredOrderedPathChunk,
          areStoredOrderedPathChunksEqual,
          "ordered path chunk"
        );
      },
    },
    runs: {
      get(runId) {
        assertTransactionActive();
        const record = state.runs.get(runId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredRun(record)
        );
      },
      listByBranch(branchId) {
        assertTransactionActive();
        const runs: StoredRun[] = [];

        for (const run of state.runs.values()) {
          if (run.branchId === branchId) {
            runs.push(cloneStoredRun(run));
          }
        }

        runs.sort(compareStoredRun);
        return Promise.resolve(runs);
      },
      set(record) {
        assertTransactionActive();
        assertStoredRun(record, "record");
        const branch = ensureBranchExists(
          state,
          record.branchId,
          "record.branchId"
        );
        const turn = ensureTurnExists(state, record.turnId, "record.turnId");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");
        const startTurnNode = ensureTurnNodeExists(
          state,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        const thread = ensureThreadExists(
          state,
          turn.threadId,
          "turn.threadId"
        );
        assertTurnNodeBelongsToThread(
          state,
          record.startTurnNodeHash,
          thread,
          "record.startTurnNodeHash"
        );

        if (turn.branchId !== branch.branchId) {
          throw persistenceError(
            "stored runs must reference a turn on the same branch",
            "memory_backend_run_branch_mismatch",
            { branchId: branch.branchId, turnId: turn.turnId }
          );
        }

        if (startTurnNode.schemaId !== record.schemaId) {
          throw persistenceError(
            "stored runs must use the schema of their start turn node",
            "memory_backend_run_schema_mismatch",
            {
              runId: record.runId,
              runSchemaId: record.schemaId,
              startTurnNodeHash: startTurnNode.hash,
              turnNodeSchemaId: startTurnNode.schemaId,
            }
          );
        }

        assertRunStartTurnNodeWithinTurnSpan(
          state,
          turn,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );

        const existingRun = state.runs.get(record.runId);
        if (existingRun === undefined) {
          if (record.status !== "running") {
            throw persistenceError(
              "stored runs must be created in the running state",
              "memory_backend_run_initial_status_invalid",
              {
                runId: record.runId,
                status: record.status,
              }
            );
          }

          if (branch.headTurnNodeHash !== record.startTurnNodeHash) {
            throw persistenceError(
              "stored runs must start from the current branch head when first created",
              "memory_backend_run_start_turn_node_mismatch",
              {
                branchHeadTurnNodeHash: branch.headTurnNodeHash,
                runId: record.runId,
                startTurnNodeHash: record.startTurnNodeHash,
              }
            );
          }
        } else {
          assertRunUpdateIsLegal(existingRun, record);
        }

        state.runs.set(record.runId, cloneStoredRun(record));
        return Promise.resolve();
      },
    },
    schemas: {
      get(schemaId) {
        assertTransactionActive();
        const record = state.schemas.get(schemaId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredSchema(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredSchema(record, "record");
        putImmutableRecord(
          state.schemas,
          record.schemaId,
          record,
          cloneStoredSchema,
          areStoredSchemasEqual,
          "stored schema"
        );
        return Promise.resolve();
      },
    },
    stagedResults: {
      clearRun(runId) {
        assertTransactionActive();
        state.stagedResults.delete(runId);
        return Promise.resolve();
      },
      get(runId, taskId) {
        assertTransactionActive();
        const runResults = state.stagedResults.get(runId);
        const record = runResults?.get(taskId);

        return Promise.resolve(
          record === undefined ? null : cloneStoredStagedResult(record)
        );
      },
      listByRun(runId) {
        assertTransactionActive();
        const runResults = state.stagedResults.get(runId);

        if (runResults === undefined) {
          return Promise.resolve([]);
        }

        const stagedResults = Array.from(
          runResults.values(),
          cloneStoredStagedResult
        );
        stagedResults.sort(compareStoredStagedResult);
        return Promise.resolve(stagedResults);
      },
      set(record) {
        assertTransactionActive();
        assertStoredStagedResult(record, "record");
        const run = ensureRunExists(state, record.runId, "record.runId");
        ensureObjectExists(state, record.objectHash, "record.objectHash");

        if (run.status !== "running") {
          throw persistenceError(
            "stored staged results may only be attached to running runs",
            "memory_backend_staged_result_run_not_running",
            {
              runId: run.runId,
              status: run.status,
            }
          );
        }

        const runResults =
          state.stagedResults.get(record.runId) ??
          new Map<string, StoredStagedResult>();
        const existingResult = runResults.get(record.taskId);

        if (existingResult === undefined) {
          runResults.set(record.taskId, cloneStoredStagedResult(record));
        } else {
          ensureImmutableRecordMatch(
            existingResult,
            record,
            areStoredStagedResultsEqual,
            "stored staged result"
          );
        }

        state.stagedResults.set(record.runId, runResults);
        return Promise.resolve();
      },
    },
    threads: {
      get(threadId) {
        assertTransactionActive();
        const record = state.threads.get(threadId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredThread(record)
        );
      },
      put(record) {
        assertTransactionActive();
        assertStoredThread(record, "record");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");
        const rootTurnNode = ensureTurnNodeExists(
          state,
          record.rootTurnNodeHash,
          "record.rootTurnNodeHash"
        );
        if (rootTurnNode.previousTurnNodeHash !== null) {
          throw persistenceError(
            "stored thread roots must be genesis turn nodes",
            "memory_backend_thread_root_not_genesis",
            {
              previousTurnNodeHash: rootTurnNode.previousTurnNodeHash,
              rootTurnNodeHash: rootTurnNode.hash,
              threadId: record.threadId,
            }
          );
        }
        putImmutableRecord(
          state.threads,
          record.threadId,
          record,
          cloneStoredThread,
          areStoredThreadsEqual,
          "stored thread"
        );
        return Promise.resolve();
      },
    },
    turnNodes: {
      get(hash) {
        assertTransactionActive();
        const record = state.turnNodes.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnNode(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        assertStoredTurnNode(record, "record");
        await assertStoredTurnNodeIdentity(record, "record");
        ensureTurnTreeExists(state, record.turnTreeHash, "record.turnTreeHash");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");

        if (record.eventHash !== null) {
          ensureObjectExists(state, record.eventHash, "record.eventHash");
        }

        for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
          record
        )) {
          ensureObjectExists(
            state,
            objectHash,
            "record.consumedStagedResultsCbor"
          );
        }

        if (record.previousTurnNodeHash !== null) {
          ensureTurnNodeExists(
            state,
            record.previousTurnNodeHash,
            "record.previousTurnNodeHash"
          );
        }

        putImmutableRecord(
          state.turnNodes,
          record.hash,
          record,
          cloneStoredTurnNode,
          areStoredTurnNodesEqual,
          "stored turn node"
        );
      },
    },
    turnTreePaths: {
      get(turnTreeHash, path) {
        assertTransactionActive();
        const treePaths = state.turnTreePaths.get(turnTreeHash);
        const record = treePaths?.get(path);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnTreePath(record)
        );
      },
      listByTurnTree(turnTreeHash) {
        assertTransactionActive();
        const treePaths = state.turnTreePaths.get(turnTreeHash);

        if (treePaths === undefined) {
          return Promise.resolve([]);
        }

        const records = Array.from(treePaths.values(), cloneStoredTurnTreePath);
        records.sort((left, right) => left.path.localeCompare(right.path));
        return Promise.resolve(records);
      },
      async putMany(records) {
        assertTransactionActive();
        const seenCompositeKeys = new Set<string>();

        for (const record of records) {
          const turnTree = ensureTurnTreeExists(
            state,
            record.turnTreeHash,
            "record.turnTreeHash"
          );
          const schema = getSchemaForTurnTree(state, turnTree);
          assertStoredTurnTreePath(record, schema, "record");

          const compositeKey = `${record.turnTreeHash}:${record.path}`;
          if (seenCompositeKeys.has(compositeKey)) {
            throw persistenceError(
              "turn tree path batches must not contain duplicate keys",
              "memory_backend_duplicate_turn_tree_path_batch_entry",
              { compositeKey }
            );
          }

          seenCompositeKeys.add(compositeKey);

          const normalizedRecord = await normalizeStoredTurnTreePath(
            state,
            record,
            now
          );
          const treePaths =
            state.turnTreePaths.get(normalizedRecord.turnTreeHash) ??
            new Map<string, StoredTurnTreePath>();
          const existing = treePaths.get(normalizedRecord.path);

          if (existing === undefined) {
            treePaths.set(
              normalizedRecord.path,
              cloneStoredTurnTreePath(normalizedRecord)
            );
          } else {
            ensureImmutableRecordMatch(
              existing,
              normalizedRecord,
              areStoredTurnTreePathsEqual,
              "stored turn tree path"
            );
          }

          state.turnTreePaths.set(normalizedRecord.turnTreeHash, treePaths);
        }
      },
    },
    turnTrees: {
      get(hash) {
        assertTransactionActive();
        const record = state.turnTrees.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnTree(record)
        );
      },
      async put(record) {
        assertTransactionActive();
        const schema = getSchemaForSchemaId(
          state,
          record.schemaId,
          "record.schemaId"
        );
        assertStoredTurnTree(record, schema, "record");
        await assertStoredTurnTreeIdentity(record, schema, "record");
        putImmutableRecord(
          state.turnTrees,
          record.hash,
          record,
          cloneStoredTurnTree,
          areStoredTurnTreesEqual,
          "stored turn tree"
        );
      },
    },
    turns: {
      get(turnId) {
        assertTransactionActive();
        const record = state.turns.get(turnId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurn(record)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredTurn(record, "record");
        const thread = ensureThreadExists(
          state,
          record.threadId,
          "record.threadId"
        );
        const branch = ensureBranchExists(
          state,
          record.branchId,
          "record.branchId"
        );
        ensureTurnNodeExists(
          state,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );
        ensureTurnNodeExists(
          state,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );

        if (branch.threadId !== thread.threadId) {
          throw persistenceError(
            "stored turns must reference a branch on the same thread",
            "memory_backend_turn_branch_thread_mismatch",
            { branchId: branch.branchId, threadId: thread.threadId }
          );
        }

        const existingTurn = state.turns.get(record.turnId);
        if (existingTurn !== undefined) {
          assertImmutableField(
            existingTurn.branchId,
            record.branchId,
            "record.branchId",
            "memory_backend_turn_branch_immutable"
          );
          assertImmutableField(
            existingTurn.threadId,
            record.threadId,
            "record.threadId",
            "memory_backend_turn_thread_immutable"
          );
          assertImmutableField(
            existingTurn.startTurnNodeHash,
            record.startTurnNodeHash,
            "record.startTurnNodeHash",
            "memory_backend_turn_start_immutable"
          );
          assertImmutableOptionalField(
            existingTurn.parentTurnId,
            record.parentTurnId,
            "record.parentTurnId",
            "memory_backend_turn_parent_immutable"
          );
          assertImmutableField(
            existingTurn.createdAtMs,
            record.createdAtMs,
            "record.createdAtMs",
            "memory_backend_turn_created_at_immutable"
          );
          assertMonotonicUpdatedAtMs(
            existingTurn.updatedAtMs,
            record.updatedAtMs,
            "record.updatedAtMs",
            "memory_backend_turn_updated_at_regressed"
          );
          assertTurnNodeDescendsFrom(
            state,
            record.headTurnNodeHash,
            existingTurn.headTurnNodeHash,
            "record.headTurnNodeHash"
          );
        }

        state.turns.set(record.turnId, cloneStoredTurn(record));
        return Promise.resolve();
      },
    },
  };
}

function createEmptyState(): BackendState {
  return {
    branches: new Map(),
    objects: new Map(),
    orderedPathChunks: new Map(),
    runs: new Map(),
    schemas: new Map(),
    stagedResults: new Map(),
    threads: new Map(),
    turnNodes: new Map(),
    turnTreePaths: new Map(),
    turnTrees: new Map(),
    turns: new Map(),
  };
}

function validateCommittedState(
  state: BackendState,
  baseState: BackendState
): void {
  validateThreadInvariants(state);
  validateBranchInvariants(state, baseState);
  validateTurnNodeInvariants(state);
  validateTurnInvariants(state);
  validateRunInvariants(state);
  validateTurnTreePathInvariants(state);
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
        "memory_backend_thread_schema_mismatch",
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
        "memory_backend_thread_root_not_genesis",
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
        "memory_backend_thread_root_not_unique",
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
  baseState: BackendState
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
        "memory_backend_branch_archive_thread_mismatch",
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
        "memory_backend_branch_archive_source_missing_before_transaction",
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
        "memory_backend_branch_archive_head_mismatch",
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
      classifyTurnNodeRelationship(
        state,
        sourceBranchBeforeTransaction.headTurnNodeHash,
        sourceBranch.headTurnNodeHash
      ) !== "backward"
    ) {
      throw persistenceError(
        "new archive branches must be paired with a backward move on their source branch",
        "memory_backend_branch_archive_without_backward_move",
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

    const headMoveDirection = classifyTurnNodeRelationship(
      state,
      previousBranch.headTurnNodeHash,
      branch.headTurnNodeHash
    );

    if (headMoveDirection !== "backward") {
      continue;
    }

    assertBackwardBranchMoveIsArchived(
      state,
      baseState,
      previousBranch,
      branch
    );
  }
}

function validateTurnNodeInvariants(state: BackendState): void {
  for (const turnNode of state.turnNodes.values()) {
    const turnTree = ensureTurnTreeExists(
      state,
      turnNode.turnTreeHash,
      "turnNode.turnTreeHash"
    );

    if (turnTree.schemaId !== turnNode.schemaId) {
      throw persistenceError(
        "stored turn nodes must use the schema of their referenced turn tree",
        "memory_backend_turn_node_schema_mismatch",
        {
          turnNodeHash: turnNode.hash,
          turnNodeSchemaId: turnNode.schemaId,
          turnTreeHash: turnTree.hash,
          turnTreeSchemaId: turnTree.schemaId,
        }
      );
    }

    for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
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

function validateTurnInvariants(state: BackendState): void {
  for (const turn of state.turns.values()) {
    const thread = ensureThreadExists(state, turn.threadId, "turn.threadId");
    const branch = ensureBranchExists(state, turn.branchId, "turn.branchId");

    if (branch.threadId !== thread.threadId) {
      throw persistenceError(
        "stored turns must reference a branch on the same thread",
        "memory_backend_turn_branch_thread_mismatch",
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

    assertTurnParentLink(state, turn, "turn.parentTurnId");
  }
}

function validateRunInvariants(state: BackendState): void {
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
        "memory_backend_run_branch_mismatch",
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
        "memory_backend_run_schema_mismatch",
        {
          runId: run.runId,
          runSchemaId: run.schemaId,
          startTurnNodeHash: startTurnNode.hash,
          turnNodeSchemaId: startTurnNode.schemaId,
        }
      );
    }

    assertRunStartTurnNodeWithinTurnSpan(
      state,
      turn,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );

    for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
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
      assertRunCreatedTurnNodeWithinTurnSpan(
        state,
        turn,
        createdTurnNode,
        "run.createdTurnNodesCbor"
      );
    }

    assertRunCreatedTurnNodesAreCanonical(state, run);

    if (run.status === "running" || run.status === "paused") {
      assertActiveRunHeadAlignment(run, branch, turn);
      const currentActiveCount = activeRunCounts.get(run.branchId) ?? 0;
      activeRunCounts.set(run.branchId, currentActiveCount + 1);
    }

    const stagedResultsForRun = state.stagedResults.get(run.runId);

    if (run.status !== "running" && stagedResultsForRun !== undefined) {
      throw persistenceError(
        "stored terminal or paused runs must not retain staged results",
        "memory_backend_run_has_terminal_staged_results",
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
        "memory_backend_multiple_active_runs",
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
        "memory_backend_staged_result_run_not_running",
        {
          runId,
          stagedResultCount: stagedResults.size,
          status: run.status,
        }
      );
    }
  }
}

function validateTurnTreePathInvariants(state: BackendState): void {
  for (const [turnTreeHash, storedPaths] of state.turnTreePaths.entries()) {
    ensureTurnTreeExists(state, turnTreeHash, "turnTreePath.turnTreeHash");

    if (storedPaths.size === 0) {
      throw persistenceError(
        "stored turn tree path collections must not be empty",
        "memory_backend_empty_turn_tree_path_collection",
        { turnTreeHash }
      );
    }
  }

  for (const turnTree of state.turnTrees.values()) {
    assertTurnTreeManifestMatchesStoredPaths(state, turnTree);
  }
}

function listTurnsByThread(
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

function cloneState(state: BackendState): BackendState {
  return {
    branches: new Map(state.branches),
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

async function normalizeStoredTurnTreePath(
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
        "memory_backend_chunked_turn_tree_path_below_threshold",
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
        "memory_backend_chunked_turn_tree_path_count_mismatch",
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
      cloneStoredOrderedPathChunk,
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

function getSchemaForSchemaId(
  state: BackendState,
  schemaId: string,
  label: string
): TurnTreeSchema {
  const schemaRecord = ensureSchemaRecordExists(state, schemaId, label);
  return decodeTurnTreeSchema(schemaRecord.schemaCbor, `${label} schema`);
}

function getSchemaForTurnTree(
  state: BackendState,
  turnTree: StoredTurnTree
): TurnTreeSchema {
  return getSchemaForSchemaId(state, turnTree.schemaId, "turnTree.schemaId");
}

function decodeTurnTreeSchema(
  bytes: Uint8Array,
  label: string
): TurnTreeSchema {
  const decodedValue = decodeDeterministicKernelRecord(bytes);
  assertTurnTreeSchema(decodedValue, label);
  return decodedValue;
}

function decodeHashStringArray(bytes: Uint8Array, label: string): string[] {
  const decodedValue = decodeDeterministicKernelRecord(bytes);

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      `${label} must decode to a HashString[]`,
      "memory_backend_invalid_hash_array_payload",
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
        "memory_backend_cyclic_turn_node_lineage",
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
    "memory_backend_thread_lineage_mismatch",
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
        "memory_backend_cyclic_turn_node_lineage",
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
    "memory_backend_turn_node_not_descendant",
    {
      ancestorTurnNodeHash,
      descendantTurnNodeHash,
    }
  );
}

function assertBranchHeadMoveIsLinear(
  state: BackendState,
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string,
  label: string
): void {
  const relationship = classifyTurnNodeRelationship(
    state,
    previousHeadTurnNodeHash,
    nextHeadTurnNodeHash
  );

  if (relationship === "lateral") {
    throw persistenceError(
      `${label} must remain on the same thread lineage as the current branch head`,
      "memory_backend_branch_head_lateral_move",
      {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      }
    );
  }
}

function assertTurnTreeManifestMatchesStoredPaths(
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
      "memory_backend_invalid_turn_tree_manifest",
      {
        turnTreeHash: turnTree.hash,
      }
    );
  }

  if (storedPaths === undefined) {
    throw persistenceError(
      "stored turn trees must have indexed path rows",
      "memory_backend_missing_turn_tree_paths",
      {
        turnTreeHash: turnTree.hash,
      }
    );
  }

  if (storedPaths.size !== schema.paths.length) {
    throw persistenceError(
      "stored turn tree paths must fully cover the schema-defined manifest",
      "memory_backend_turn_tree_path_count_mismatch",
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
        "memory_backend_missing_turn_tree_path",
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
        "memory_backend_turn_tree_manifest_path_mismatch",
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

function encodeHashStringArray(hashes: string[]): Uint8Array {
  return encodeDeterministicKernelRecord(
    hashes.map((hash) => validateHashString(hash))
  );
}

function assertRunUpdateIsLegal(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  assertImmutableField(
    existingRun.branchId,
    nextRun.branchId,
    "record.branchId",
    "memory_backend_run_branch_immutable"
  );
  assertImmutableField(
    existingRun.turnId,
    nextRun.turnId,
    "record.turnId",
    "memory_backend_run_turn_immutable"
  );
  assertImmutableField(
    existingRun.schemaId,
    nextRun.schemaId,
    "record.schemaId",
    "memory_backend_run_schema_immutable"
  );
  assertImmutableField(
    existingRun.startTurnNodeHash,
    nextRun.startTurnNodeHash,
    "record.startTurnNodeHash",
    "memory_backend_run_start_immutable"
  );
  assertImmutableField(
    existingRun.createdAtMs,
    nextRun.createdAtMs,
    "record.createdAtMs",
    "memory_backend_run_created_at_immutable"
  );
  assertImmutableBytes(
    existingRun.stepSequenceCbor,
    nextRun.stepSequenceCbor,
    "record.stepSequenceCbor",
    "memory_backend_run_step_sequence_immutable"
  );
  assertMonotonicUpdatedAtMs(
    existingRun.updatedAtMs,
    nextRun.updatedAtMs,
    "record.updatedAtMs",
    "memory_backend_run_updated_at_regressed"
  );

  if (
    existingRun.status === "running" ||
    (existingRun.status === "paused" && nextRun.status === "failed")
  ) {
    // Approval resume can surface a terminal failure after a paused run has
    // already durably recorded prior checkpoints. Keep the append-only and
    // monotonic checks active for that final transition instead of treating it
    // like a fully immutable halted record.
    assertMonotonicRunStepIndex(existingRun, nextRun);
    assertAppendOnlyRunCreatedTurnNodes(existingRun, nextRun);
  } else {
    assertImmutableField(
      existingRun.currentStepIndex,
      nextRun.currentStepIndex,
      "record.currentStepIndex",
      "memory_backend_run_step_index_immutable_after_halt"
    );
    assertImmutableBytes(
      existingRun.createdTurnNodesCbor,
      nextRun.createdTurnNodesCbor,
      "record.createdTurnNodesCbor",
      "memory_backend_run_created_turn_nodes_immutable_after_halt"
    );
  }

  assertRunStatusTransition(existingRun.status, nextRun.status);
}

function assertMonotonicRunStepIndex(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  if (nextRun.currentStepIndex < existingRun.currentStepIndex) {
    throw persistenceError(
      "stored runs must not move currentStepIndex backwards",
      "memory_backend_run_step_index_regressed",
      {
        nextCurrentStepIndex: nextRun.currentStepIndex,
        previousCurrentStepIndex: existingRun.currentStepIndex,
        runId: existingRun.runId,
      }
    );
  }
}

function assertMonotonicUpdatedAtMs(
  previousUpdatedAtMs: number,
  nextUpdatedAtMs: number,
  label: string,
  code: string
): void {
  if (nextUpdatedAtMs < previousUpdatedAtMs) {
    throw persistenceError(`${label} must not move backwards`, code, {
      nextUpdatedAtMs,
      previousUpdatedAtMs,
    });
  }
}

function assertAppendOnlyRunCreatedTurnNodes(
  existingRun: StoredRun,
  nextRun: StoredRun
): void {
  const existingTurnNodeHashes = decodeRunCreatedTurnNodeHashes(existingRun);
  const nextTurnNodeHashes = decodeRunCreatedTurnNodeHashes(nextRun);

  if (nextTurnNodeHashes.length < existingTurnNodeHashes.length) {
    throw persistenceError(
      "stored runs must keep createdTurnNodesCbor append-only",
      "memory_backend_run_created_turn_nodes_not_append_only",
      {
        nextCount: nextTurnNodeHashes.length,
        previousCount: existingTurnNodeHashes.length,
        runId: existingRun.runId,
      }
    );
  }

  for (const [index, turnNodeHash] of existingTurnNodeHashes.entries()) {
    if (nextTurnNodeHashes[index] !== turnNodeHash) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor append-only",
        "memory_backend_run_created_turn_nodes_not_append_only",
        {
          index,
          nextTurnNodeHash: nextTurnNodeHashes[index],
          previousTurnNodeHash: turnNodeHash,
          runId: existingRun.runId,
        }
      );
    }
  }
}

function assertRunStartTurnNodeWithinTurnSpan(
  state: BackendState,
  turn: StoredTurn,
  startTurnNodeHash: string,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationship(
    state,
    turn.startTurnNodeHash,
    startTurnNodeHash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} must lie within the referenced turn span`,
      "memory_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationship(
    state,
    startTurnNodeHash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} must not move past the referenced turn head`,
      "memory_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertRunCreatedTurnNodeWithinTurnSpan(
  state: BackendState,
  turn: StoredTurn,
  createdTurnNode: StoredTurnNode,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationship(
    state,
    turn.startTurnNodeHash,
    createdTurnNode.hash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must remain within the referenced turn span`,
      "memory_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationship(
    state,
    createdTurnNode.hash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must not move beyond the referenced turn head`,
      "memory_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertRunCreatedTurnNodesAreCanonical(
  state: BackendState,
  run: StoredRun
): void {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  const seenTurnNodeHashes = new Set<string>();
  let previousTurnNodeHash = run.startTurnNodeHash;

  for (const [index, turnNodeHash] of createdTurnNodeHashes.entries()) {
    if (seenTurnNodeHashes.has(turnNodeHash)) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor unique",
        "memory_backend_run_created_turn_nodes_duplicate",
        {
          duplicateTurnNodeHash: turnNodeHash,
          index,
          runId: run.runId,
        }
      );
    }

    const createdTurnNode = ensureTurnNodeExists(
      state,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    const isImmediateNextTurnNode =
      createdTurnNode.previousTurnNodeHash === previousTurnNodeHash;

    if (!isImmediateNextTurnNode) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor as a canonical contiguous lineage",
        "memory_backend_run_created_turn_nodes_not_contiguous",
        {
          createdTurnNodePreviousTurnNodeHash:
            createdTurnNode.previousTurnNodeHash,
          index,
          previousTurnNodeHash,
          runId: run.runId,
          turnNodeHash,
        }
      );
    }

    seenTurnNodeHashes.add(turnNodeHash);
    previousTurnNodeHash = turnNodeHash;
  }
}

function assertActiveRunHeadAlignment(
  run: StoredRun,
  branch: StoredBranch,
  turn: StoredTurn
): void {
  const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

  if (activeTurnNodeHash !== branch.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current branch head",
      "memory_backend_active_run_branch_head_mismatch",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: branch.headTurnNodeHash,
        branchId: branch.branchId,
        runId: run.runId,
        status: run.status,
      }
    );
  }

  if (activeTurnNodeHash !== turn.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current turn head",
      "memory_backend_active_run_turn_head_mismatch",
      {
        activeTurnNodeHash,
        runId: run.runId,
        status: run.status,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

function assertTurnParentLink(
  state: BackendState,
  turn: StoredTurn,
  label: string
): void {
  const candidateTurnsAtStart = listTurnsByThread(
    state,
    turn.threadId,
    turn.turnId
  ).filter(
    (candidateTurn) => candidateTurn.headTurnNodeHash === turn.startTurnNodeHash
  );
  const sameBranchCandidateTurns = candidateTurnsAtStart.filter(
    (candidateTurn) => candidateTurn.branchId === turn.branchId
  );
  const immediatelyPreviousSameBranchTurn = sameBranchCandidateTurns.at(-1);

  if (turn.parentTurnId === null) {
    if (candidateTurnsAtStart.length === 0) {
      return;
    }

    throw persistenceError(
      `${label} must reference the previous semantic turn when one exists`,
      "memory_backend_turn_parent_required",
      {
        candidateParentTurnIds: candidateTurnsAtStart.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  const parentTurn = ensureTurnExists(state, turn.parentTurnId, label);

  if (parentTurn.threadId !== turn.threadId) {
    throw persistenceError(
      "stored turns must reference a parent turn on the same thread",
      "memory_backend_turn_parent_thread_mismatch",
      {
        parentThreadId: parentTurn.threadId,
        threadId: turn.threadId,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.headTurnNodeHash !== turn.startTurnNodeHash) {
    throw persistenceError(
      `${label} must chain contiguously into record.startTurnNodeHash`,
      "memory_backend_turn_parent_start_turn_node_mismatch",
      {
        parentTurnHeadTurnNodeHash: parentTurn.headTurnNodeHash,
        parentTurnId: parentTurn.turnId,
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  if (parentTurn.branchId !== turn.branchId) {
    return;
  }

  if (
    immediatelyPreviousSameBranchTurn === undefined ||
    immediatelyPreviousSameBranchTurn.turnId !== parentTurn.turnId
  ) {
    throw persistenceError(
      `${label} must reference the immediately previous semantic turn at record.startTurnNodeHash`,
      "memory_backend_turn_parent_not_immediate_predecessor",
      {
        candidateParentTurnIds: sameBranchCandidateTurns.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        expectedParentTurnId: immediatelyPreviousSameBranchTurn?.turnId ?? null,
        parentTurnId: parentTurn.turnId,
        turnId: turn.turnId,
      }
    );
  }
}

function assertBackwardBranchMoveIsArchived(
  state: BackendState,
  baseState: BackendState,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch
): void {
  let archiveBranchFound = false;

  for (const branch of state.branches.values()) {
    if (branch.branchId === nextBranch.branchId) {
      continue;
    }

    const branchBeforeTransaction = baseState.branches.get(branch.branchId);

    if (
      branchBeforeTransaction === undefined &&
      branch.archivedFromBranchId === nextBranch.branchId &&
      branch.headTurnNodeHash === previousBranch.headTurnNodeHash
    ) {
      archiveBranchFound = true;
      break;
    }
  }

  if (!archiveBranchFound) {
    throw persistenceError(
      "stored backward branch moves must preserve the abandoned head as an archive branch",
      "memory_backend_backward_branch_move_missing_archive",
      {
        branchId: nextBranch.branchId,
        nextHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        previousHeadTurnNodeHash: previousBranch.headTurnNodeHash,
      }
    );
  }

  for (const run of state.runs.values()) {
    if (
      run.branchId !== nextBranch.branchId ||
      (run.status !== "running" && run.status !== "paused")
    ) {
      continue;
    }

    const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

    if (activeTurnNodeHash === nextBranch.headTurnNodeHash) {
      continue;
    }

    throw persistenceError(
      "stored backward branch moves must fail active runs from the abandoned segment",
      "memory_backend_backward_branch_move_active_run_not_failed",
      {
        activeTurnNodeHash,
        branchHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        branchId: nextBranch.branchId,
        runId: run.runId,
        startTurnNodeHash: run.startTurnNodeHash,
        status: run.status,
      }
    );
  }
}

type TurnNodeRelationship = "backward" | "forward" | "lateral" | "same";

function classifyTurnNodeRelationship(
  state: BackendState,
  sourceTurnNodeHash: string,
  targetTurnNodeHash: string
): TurnNodeRelationship {
  if (sourceTurnNodeHash === targetTurnNodeHash) {
    return "same";
  }

  if (isTurnNodeDescendantOf(state, targetTurnNodeHash, sourceTurnNodeHash)) {
    return "forward";
  }

  if (isTurnNodeDescendantOf(state, sourceTurnNodeHash, targetTurnNodeHash)) {
    return "backward";
  }

  return "lateral";
}

function isTurnNodeDescendantOf(
  state: BackendState,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string
): boolean {
  const visitedTurnNodes = new Set<string>();
  let currentTurnNodeHash: string | null = descendantTurnNodeHash;

  while (currentTurnNodeHash !== null) {
    if (visitedTurnNodes.has(currentTurnNodeHash)) {
      throw persistenceError(
        "turn node lineage must not contain cycles",
        "memory_backend_cyclic_turn_node_lineage",
        {
          ancestorTurnNodeHash,
          descendantTurnNodeHash,
        }
      );
    }

    if (currentTurnNodeHash === ancestorTurnNodeHash) {
      return true;
    }

    visitedTurnNodes.add(currentTurnNodeHash);
    currentTurnNodeHash = ensureTurnNodeExists(
      state,
      currentTurnNodeHash,
      "turnNodeHash"
    ).previousTurnNodeHash;
  }

  return false;
}

function decodeRunCreatedTurnNodeHashes(run: StoredRun): string[] {
  return decodeHashStringArray(
    run.createdTurnNodesCbor,
    "run.createdTurnNodesCbor"
  );
}

function getRunActiveTurnNodeHash(run: StoredRun): string {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  return createdTurnNodeHashes.at(-1) ?? run.startTurnNodeHash;
}

function assertChunkedTurnTreePathChunkLayout(
  chunk: StoredOrderedPathChunk,
  index: number,
  totalChunks: number
): void {
  if (chunk.itemCount < 1 || chunk.itemCount > ORDERED_PATH_CHUNK_SIZE) {
    throw persistenceError(
      "ordered path chunks must contain between one and the fixed chunk size number of items",
      "memory_backend_ordered_path_chunk_size_invalid",
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
      "memory_backend_ordered_path_chunk_not_fixed_size",
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

function decodeTurnNodeConsumedStagedResultObjectHashes(
  turnNode: StoredTurnNode
): string[] {
  const decodedValue = decodeDeterministicKernelRecord(
    turnNode.consumedStagedResultsCbor
  );

  if (!Array.isArray(decodedValue)) {
    throw persistenceError(
      "stored turn node consumedStagedResultsCbor must decode to an array",
      "memory_backend_invalid_consumed_staged_results_cbor",
      {
        turnNodeHash: turnNode.hash,
      }
    );
  }

  const objectHashes: string[] = [];

  for (const [index, value] of decodedValue.entries()) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Uint8Array
    ) {
      throw persistenceError(
        "stored turn node consumedStagedResultsCbor entries must decode to staged result objects",
        "memory_backend_invalid_consumed_staged_result_entry",
        {
          index,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    const objectHash = Reflect.get(value, "objectHash");

    if (typeof objectHash !== "string") {
      throw persistenceError(
        "stored turn node consumedStagedResultsCbor entries must include objectHash",
        "memory_backend_invalid_consumed_staged_result_entry",
        {
          index,
          turnNodeHash: turnNode.hash,
        }
      );
    }

    objectHashes.push(validateHashString(objectHash));
  }

  return objectHashes;
}

function assertRunStatusTransition(
  previousStatus: StoredRun["status"],
  nextStatus: StoredRun["status"]
): void {
  if (previousStatus === nextStatus) {
    return;
  }

  const isLegalTransition =
    (previousStatus === "running" &&
      (nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "paused")) ||
    // A paused run can still fail during resume reconciliation or approval
    // handling; Epic V relies on both local and remote kernels accepting that
    // terminal transition consistently.
    (previousStatus === "paused" && nextStatus === "failed");

  if (!isLegalTransition) {
    throw persistenceError(
      "stored runs must not use illegal status transitions",
      "memory_backend_run_status_transition_illegal",
      {
        nextStatus,
        previousStatus,
      }
    );
  }
}

function assertImmutableField<T>(
  previousValue: T,
  nextValue: T,
  label: string,
  code: string
): void {
  if (previousValue !== nextValue) {
    throw persistenceError(`${label} must remain immutable`, code, {
      nextValue,
      previousValue,
    });
  }
}

function assertImmutableOptionalField<T>(
  previousValue: T | undefined,
  nextValue: T | undefined,
  label: string,
  code: string
): void {
  if (previousValue !== nextValue) {
    throw persistenceError(`${label} must remain immutable`, code, {
      nextValue,
      previousValue,
    });
  }
}

function assertImmutableBytes(
  previousValue: Uint8Array,
  nextValue: Uint8Array,
  label: string,
  code: string
): void {
  if (!areBytesEqual(previousValue, nextValue)) {
    throw persistenceError(`${label} must remain immutable`, code, {
      label,
    });
  }
}

function validateHashString(hash: string): string {
  assertHashString(hash, "hash");
  return hash;
}

function putImmutableRecord<T>(
  records: Map<string, T>,
  key: string,
  record: T,
  cloneRecord: (record: T) => T,
  areEqual: (left: T, right: T) => boolean,
  label: string
): void {
  const existing = records.get(key);

  if (existing !== undefined) {
    ensureImmutableRecordMatch(existing, record, areEqual, label);
    return;
  }

  records.set(key, cloneRecord(record));
}

function ensureImmutableRecordMatch<T>(
  existing: T,
  incoming: T,
  areEqual: (left: T, right: T) => boolean,
  label: string
): void {
  if (!areEqual(existing, incoming)) {
    throw persistenceError(
      `${label} writes must be idempotent for the same identity key`,
      "memory_backend_immutable_record_conflict",
      { label }
    );
  }
}

function ensureObjectExists(
  state: BackendState,
  hash: string,
  label: string
): StoredObject {
  const record = state.objects.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing object`,
      "memory_backend_missing_object_reference",
      {
        hash,
        label,
      }
    );
  }

  return record;
}

function ensureSchemaRecordExists(
  state: BackendState,
  schemaId: string,
  label: string
): StoredSchema {
  const record = state.schemas.get(schemaId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing schema`,
      "memory_backend_missing_schema_reference",
      {
        label,
        schemaId,
      }
    );
  }

  return record;
}

function ensureTurnTreeExists(
  state: BackendState,
  hash: string,
  label: string
): StoredTurnTree {
  const record = state.turnTrees.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn tree`,
      "memory_backend_missing_turn_tree_reference",
      { hash, label }
    );
  }

  return record;
}

function ensureOrderedPathChunkExists(
  state: BackendState,
  chunkHash: string,
  label: string
): StoredOrderedPathChunk {
  const record = state.orderedPathChunks.get(chunkHash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing ordered path chunk`,
      "memory_backend_missing_ordered_path_chunk_reference",
      { chunkHash, label }
    );
  }

  return record;
}

function ensureTurnNodeExists(
  state: BackendState,
  hash: string,
  label: string
): StoredTurnNode {
  const record = state.turnNodes.get(hash);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn node`,
      "memory_backend_missing_turn_node_reference",
      { hash, label }
    );
  }

  return record;
}

function ensureThreadExists(
  state: BackendState,
  threadId: string,
  label: string
): StoredThread {
  const record = state.threads.get(threadId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing thread`,
      "memory_backend_missing_thread_reference",
      { label, threadId }
    );
  }

  return record;
}

function ensureBranchExists(
  state: BackendState,
  branchId: string,
  label: string
): StoredBranch {
  const record = state.branches.get(branchId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing branch`,
      "memory_backend_missing_branch_reference",
      { branchId, label }
    );
  }

  return record;
}

function ensureTurnExists(
  state: BackendState,
  turnId: string,
  label: string
): StoredTurn {
  const record = state.turns.get(turnId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing turn`,
      "memory_backend_missing_turn_reference",
      { label, turnId }
    );
  }

  return record;
}

function ensureRunExists(
  state: BackendState,
  runId: string,
  label: string
): StoredRun {
  const record = state.runs.get(runId);

  if (record === undefined) {
    throw persistenceError(
      `${label} must reference an existing run`,
      "memory_backend_missing_run_reference",
      { label, runId }
    );
  }

  return record;
}

function cloneStoredObject(record: StoredObject): StoredObject {
  return {
    ...record,
    bytes: cloneBytes(record.bytes),
  };
}

function cloneStoredSchema(record: StoredSchema): StoredSchema {
  return {
    ...record,
    schemaCbor: cloneBytes(record.schemaCbor),
  };
}

function cloneStoredTurnTree(record: StoredTurnTree): StoredTurnTree {
  return {
    ...record,
    manifestCbor: cloneBytes(record.manifestCbor),
  };
}

function cloneStoredOrderedPathChunk(
  record: StoredOrderedPathChunk
): StoredOrderedPathChunk {
  return {
    ...record,
    itemsCbor: cloneBytes(record.itemsCbor),
  };
}

function cloneStoredTurnNode(record: StoredTurnNode): StoredTurnNode {
  return {
    ...record,
    consumedStagedResultsCbor: cloneBytes(record.consumedStagedResultsCbor),
  };
}

function cloneStoredRun(record: StoredRun): StoredRun {
  return {
    ...record,
    createdTurnNodesCbor: cloneBytes(record.createdTurnNodesCbor),
    stepSequenceCbor: cloneBytes(record.stepSequenceCbor),
  };
}

function cloneStoredStagedResult(
  record: StoredStagedResult
): StoredStagedResult {
  if (record.status === "interrupted") {
    return {
      ...record,
      interruptPayloadCbor: cloneBytes(record.interruptPayloadCbor),
    };
  }

  return { ...record };
}

function cloneStoredThread(record: StoredThread): StoredThread {
  return { ...record };
}

function cloneStoredBranch(record: StoredBranch): StoredBranch {
  return { ...record };
}

function cloneStoredTurn(record: StoredTurn): StoredTurn {
  return { ...record };
}

function cloneStoredTurnTreePath(
  record: StoredTurnTreePath
): StoredTurnTreePath {
  if (record.collectionKind === "single") {
    return { ...record };
  }

  if (record.orderedEncoding === "flat") {
    return {
      ...record,
      orderedInlineCbor: cloneBytes(record.orderedInlineCbor),
    };
  }

  return {
    ...record,
    orderedChunkListCbor: cloneBytes(record.orderedChunkListCbor),
  };
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function areStoredObjectsEqual(
  left: StoredObject,
  right: StoredObject
): boolean {
  return (
    left.hash === right.hash &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.bytes, right.bytes)
  );
}

function areStoredSchemasEqual(
  left: StoredSchema,
  right: StoredSchema
): boolean {
  return (
    left.schemaId === right.schemaId &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.schemaCbor, right.schemaCbor)
  );
}

function areStoredTurnTreesEqual(
  left: StoredTurnTree,
  right: StoredTurnTree
): boolean {
  return (
    left.hash === right.hash &&
    left.schemaId === right.schemaId &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.manifestCbor, right.manifestCbor)
  );
}

function areStoredOrderedPathChunksEqual(
  left: StoredOrderedPathChunk,
  right: StoredOrderedPathChunk
): boolean {
  return (
    left.chunkHash === right.chunkHash &&
    left.itemCount === right.itemCount &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(left.itemsCbor, right.itemsCbor)
  );
}

function areStoredTurnNodesEqual(
  left: StoredTurnNode,
  right: StoredTurnNode
): boolean {
  return (
    left.hash === right.hash &&
    left.previousTurnNodeHash === right.previousTurnNodeHash &&
    left.turnTreeHash === right.turnTreeHash &&
    left.schemaId === right.schemaId &&
    left.eventHash === right.eventHash &&
    left.createdAtMs === right.createdAtMs &&
    areBytesEqual(
      left.consumedStagedResultsCbor,
      right.consumedStagedResultsCbor
    )
  );
}

function areStoredThreadsEqual(
  left: StoredThread,
  right: StoredThread
): boolean {
  return (
    left.threadId === right.threadId &&
    left.createdAtMs === right.createdAtMs &&
    left.schemaId === right.schemaId &&
    left.rootTurnNodeHash === right.rootTurnNodeHash
  );
}

function areStoredStagedResultsEqual(
  left: StoredStagedResult,
  right: StoredStagedResult
): boolean {
  if (
    left.runId !== right.runId ||
    left.taskId !== right.taskId ||
    left.objectHash !== right.objectHash ||
    left.objectType !== right.objectType ||
    left.status !== right.status ||
    left.createdAtMs !== right.createdAtMs
  ) {
    return false;
  }

  if (left.status === "interrupted" && right.status === "interrupted") {
    return areBytesEqual(left.interruptPayloadCbor, right.interruptPayloadCbor);
  }

  return left.status !== "interrupted" && right.status !== "interrupted";
}

function areStoredTurnTreePathsEqual(
  left: StoredTurnTreePath,
  right: StoredTurnTreePath
): boolean {
  if (
    left.turnTreeHash !== right.turnTreeHash ||
    left.path !== right.path ||
    left.collectionKind !== right.collectionKind
  ) {
    return false;
  }

  if (left.collectionKind === "single" && right.collectionKind === "single") {
    return left.singleHash === right.singleHash;
  }

  if (left.collectionKind === "ordered" && right.collectionKind === "ordered") {
    if (
      left.orderedEncoding !== right.orderedEncoding ||
      left.orderedCount !== right.orderedCount
    ) {
      return false;
    }

    if (left.orderedEncoding === "flat" && right.orderedEncoding === "flat") {
      return areBytesEqual(left.orderedInlineCbor, right.orderedInlineCbor);
    }

    if (
      left.orderedEncoding === "chunked" &&
      right.orderedEncoding === "chunked"
    ) {
      return areBytesEqual(
        left.orderedChunkListCbor,
        right.orderedChunkListCbor
      );
    }
  }

  return false;
}

function compareStoredBranch(left: StoredBranch, right: StoredBranch): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.branchId,
    right.branchId
  );
}

function compareStoredRun(left: StoredRun, right: StoredRun): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.runId,
    right.runId
  );
}

function compareStoredTurn(left: StoredTurn, right: StoredTurn): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.turnId,
    right.turnId
  );
}

function compareStoredStagedResult(
  left: StoredStagedResult,
  right: StoredStagedResult
): number {
  return compareByTimestampAndKey(
    left.createdAtMs,
    right.createdAtMs,
    left.taskId,
    right.taskId
  );
}

function compareByTimestampAndKey(
  leftTimestamp: number,
  rightTimestamp: number,
  leftKey: string,
  rightKey: string
): number {
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return leftKey.localeCompare(rightKey);
}

function areBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function persistenceError(
  message: string,
  code: string,
  details?: unknown
): TuvrenPersistenceError {
  return new TuvrenPersistenceError(message, { code, details });
}
