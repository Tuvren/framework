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
import type { EpochMs } from "@tuvren/core-types";
import {
  assertStoredBranch,
  assertStoredObject,
  assertStoredObjectIdentity,
  assertStoredObserveAnnotation,
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
  type BackendCapability,
  type RuntimeBackend as KrakenBackend,
  type RuntimeBackendTx as KrakenBackendTx,
  type ListThreadsCursorPayload,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredThread,
  type StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import {
  assertBranchHeadMoveIsLinear,
  assertRunStartTurnNodeWithinTurnSpan,
  assertTurnNodeBelongsToThread,
  assertTurnNodeDescendsFrom,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./memory-backend-lineage.js";
import {
  areStoredObjectsEqual,
  areStoredOrderedPathChunksEqual,
  areStoredSchemasEqual,
  areStoredStagedResultsEqual,
  areStoredThreadsEqual,
  areStoredTurnNodesEqual,
  areStoredTurnTreePathsEqual,
  areStoredTurnTreesEqual,
  assertImmutableField,
  assertImmutableOptionalField,
  cloneStoredBranch,
  cloneStoredObject,
  cloneStoredObserveAnnotation,
  cloneStoredOrderedPathChunk,
  cloneStoredRun,
  cloneStoredSchema,
  cloneStoredStagedResult,
  cloneStoredThread,
  cloneStoredTurn,
  cloneStoredTurnNode,
  cloneStoredTurnTree,
  cloneStoredTurnTreePath,
  compareStoredBranch,
  compareStoredObserveAnnotation,
  compareStoredRun,
  compareStoredStagedResult,
  ensureBranchExists,
  ensureImmutableRecordMatch,
  ensureObjectExists,
  ensureRunExists,
  ensureSchemaRecordExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
  isExpiredLeasedRunningRun,
  persistenceError,
  putImmutableRecord,
} from "./memory-backend-record-utils.js";
import {
  assertMonotonicUpdatedAtMs,
  assertRunUpdateIsLegal,
} from "./memory-backend-run-logic.js";
import {
  createEmptyState,
  validateCommittedState,
} from "./memory-backend-state.js";
import {
  cloneState,
  getSchemaForSchemaId,
  getSchemaForTurnTree,
  listTurnsByThread,
  normalizeStoredTurnTreePath,
} from "./memory-backend-turn-tree.js";
import type { BackendState } from "./memory-backend-types.js";

interface MutableRepositories extends KrakenBackendTx {
  readonly now: () => number;
}

export interface MemoryBackendOptions {
  now?: () => EpochMs;
}

const MEMORY_BACKEND_CAPABILITIES: BackendCapability = {
  "thread.enumeration": true,
};

class MemoryBackend implements KrakenBackend {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();
  private state: BackendState = createEmptyState();
  private readonly now: () => number;

  constructor(options?: MemoryBackendOptions) {
    this.now = options?.now ?? Date.now;
  }

  capabilities(): BackendCapability {
    return MEMORY_BACKEND_CAPABILITIES;
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
    observeAnnotations: {
      listByRun(runId) {
        assertTransactionActive();
        const records = state.observeAnnotations.get(runId) ?? [];
        return Promise.resolve(
          records
            .map(cloneStoredObserveAnnotation)
            .sort(compareStoredObserveAnnotation)
        );
      },
      set(record) {
        assertTransactionActive();
        assertStoredObserveAnnotation(record, "record");
        ensureRunExists(state, record.runId, "record.runId");

        if (record.turnNodeHash !== null) {
          ensureTurnNodeExists(
            state,
            record.turnNodeHash,
            "record.turnNodeHash"
          );
        }

        const records = state.observeAnnotations.get(record.runId) ?? [];
        // Observe annotations are append-only evidence, so identical payloads
        // must survive as distinct records instead of being deduplicated.
        records.push(cloneStoredObserveAnnotation(record));
        state.observeAnnotations.set(record.runId, records);
        return Promise.resolve();
      },
    },
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
      listExpired(nowMs) {
        assertTransactionActive();
        const runs: StoredRun[] = [];

        for (const run of state.runs.values()) {
          if (isExpiredLeasedRunningRun(run, nowMs)) {
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
      list(options) {
        assertTransactionActive();
        let threads: StoredThread[] = Array.from(
          state.threads.values(),
          cloneStoredThread
        );

        if (options?.filter?.schemaId !== undefined) {
          const { schemaId } = options.filter;
          threads = threads.filter((t) => t.schemaId === schemaId);
        }

        threads.sort((a, b) => {
          if (a.createdAtMs !== b.createdAtMs) {
            return a.createdAtMs < b.createdAtMs ? -1 : 1;
          }
          return a.threadId.localeCompare(b.threadId);
        });

        if (options?.cursor !== undefined) {
          const { lastCreatedAtMs, lastThreadId } = options.cursor;
          const idx = threads.findIndex(
            (t) =>
              t.createdAtMs > lastCreatedAtMs ||
              (t.createdAtMs === lastCreatedAtMs && t.threadId > lastThreadId)
          );
          threads = idx === -1 ? [] : threads.slice(idx);
        }

        const limit = options?.limit;
        let nextCursor: ListThreadsCursorPayload | undefined;

        if (limit !== undefined && threads.length > limit) {
          threads = threads.slice(0, limit);
          const last = threads.at(-1);
          if (last !== undefined) {
            nextCursor = {
              v: 1,
              kind: "list-threads",
              lastThreadId: last.threadId,
              lastCreatedAtMs: last.createdAtMs,
              filter: options?.filter,
            };
          }
        }

        return Promise.resolve({ threads, nextCursor });
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
      listByThread(threadId) {
        assertTransactionActive();
        return Promise.resolve(
          listTurnsByThread(state, threadId).map(cloneStoredTurn)
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
