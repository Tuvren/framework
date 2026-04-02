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
  type KrakenBackend,
  type KrakenBackendTx,
  type MemoryBackendOptions,
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
} from "@kraken/kernel-contract-protocol";
import {
  assertHashString,
  KrakenPersistenceError,
} from "@kraken/shared-core-types";

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
      const repositories = createRepositories(draftState, this.now);
      const result = await this.transactionContext.run(true, () =>
        work(repositories)
      );

      validateCommittedState(draftState);
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
  now: () => number
): MutableRepositories {
  return {
    branches: {
      get(branchId) {
        const branch = state.branches.get(branchId);
        return Promise.resolve(
          branch === undefined ? null : cloneStoredBranch(branch)
        );
      },
      listByThread(threadId) {
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
        assertStoredBranch(record, "record");
        ensureThreadExists(state, record.threadId, "record.threadId");
        ensureTurnNodeExists(
          state,
          record.headTurnNodeHash,
          "record.headTurnNodeHash"
        );

        if (record.archivedFromBranchId !== undefined) {
          ensureBranchExists(
            state,
            record.archivedFromBranchId,
            "record.archivedFromBranchId"
          );
        }

        state.branches.set(record.branchId, cloneStoredBranch(record));
        return Promise.resolve();
      },
    },
    now,
    objects: {
      get(hash) {
        const record = state.objects.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredObject(record)
        );
      },
      has(hash) {
        return Promise.resolve(state.objects.has(hash));
      },
      async put(record) {
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
        const record = state.orderedPathChunks.get(chunkHash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredOrderedPathChunk(record)
        );
      },
      async put(record) {
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
        const record = state.runs.get(runId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredRun(record)
        );
      },
      listByBranch(branchId) {
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
        assertStoredRun(record, "record");
        const branch = ensureBranchExists(
          state,
          record.branchId,
          "record.branchId"
        );
        const turn = ensureTurnExists(state, record.turnId, "record.turnId");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");
        ensureTurnNodeExists(
          state,
          record.startTurnNodeHash,
          "record.startTurnNodeHash"
        );

        if (turn.branchId !== branch.branchId) {
          throw persistenceError(
            "stored runs must reference a turn on the same branch",
            "memory_backend_run_branch_mismatch",
            { branchId: branch.branchId, turnId: turn.turnId }
          );
        }

        state.runs.set(record.runId, cloneStoredRun(record));
        return Promise.resolve();
      },
    },
    schemas: {
      get(schemaId) {
        const record = state.schemas.get(schemaId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredSchema(record)
        );
      },
      put(record) {
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
        state.stagedResults.delete(runId);
        return Promise.resolve();
      },
      get(runId, taskId) {
        const runResults = state.stagedResults.get(runId);
        const record = runResults?.get(taskId);

        return Promise.resolve(
          record === undefined ? null : cloneStoredStagedResult(record)
        );
      },
      listByRun(runId) {
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
        assertStoredStagedResult(record, "record");
        ensureRunExists(state, record.runId, "record.runId");
        ensureObjectExists(state, record.objectHash, "record.objectHash");

        const runResults =
          state.stagedResults.get(record.runId) ??
          new Map<string, StoredStagedResult>();
        runResults.set(record.taskId, cloneStoredStagedResult(record));
        state.stagedResults.set(record.runId, runResults);
        return Promise.resolve();
      },
    },
    threads: {
      get(threadId) {
        const record = state.threads.get(threadId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredThread(record)
        );
      },
      put(record) {
        assertStoredThread(record, "record");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");
        ensureTurnNodeExists(
          state,
          record.rootTurnNodeHash,
          "record.rootTurnNodeHash"
        );
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
        const record = state.turnNodes.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnNode(record)
        );
      },
      async put(record) {
        assertStoredTurnNode(record, "record");
        await assertStoredTurnNodeIdentity(record, "record");
        ensureTurnTreeExists(state, record.turnTreeHash, "record.turnTreeHash");
        ensureSchemaRecordExists(state, record.schemaId, "record.schemaId");

        if (record.eventHash !== null) {
          ensureObjectExists(state, record.eventHash, "record.eventHash");
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
        const treePaths = state.turnTreePaths.get(turnTreeHash);
        const record = treePaths?.get(path);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnTreePath(record)
        );
      },
      listByTurnTree(turnTreeHash) {
        const treePaths = state.turnTreePaths.get(turnTreeHash);

        if (treePaths === undefined) {
          return Promise.resolve([]);
        }

        const records = Array.from(treePaths.values(), cloneStoredTurnTreePath);
        records.sort((left, right) => left.path.localeCompare(right.path));
        return Promise.resolve(records);
      },
      async putMany(records) {
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
        const record = state.turnTrees.get(hash);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurnTree(record)
        );
      },
      async put(record) {
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
        const record = state.turns.get(turnId);
        return Promise.resolve(
          record === undefined ? null : cloneStoredTurn(record)
        );
      },
      set(record) {
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

        if (record.parentTurnId !== null) {
          const parentTurn = ensureTurnExists(
            state,
            record.parentTurnId,
            "record.parentTurnId"
          );

          if (parentTurn.threadId !== thread.threadId) {
            throw persistenceError(
              "stored turns must reference a parent turn on the same thread",
              "memory_backend_turn_parent_thread_mismatch",
              { parentTurnId: parentTurn.turnId, threadId: thread.threadId }
            );
          }
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

function validateCommittedState(state: BackendState): void {
  validateThreadInvariants(state);
  validateBranchInvariants(state);
  validateTurnNodeInvariants(state);
  validateTurnInvariants(state);
  validateRunInvariants(state);
  validateTurnTreePathInvariants(state);
}

function validateThreadInvariants(state: BackendState): void {
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
  }
}

function validateBranchInvariants(state: BackendState): void {
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

    if (turn.parentTurnId === null) {
      continue;
    }

    const parentTurn = ensureTurnExists(
      state,
      turn.parentTurnId,
      "turn.parentTurnId"
    );

    if (parentTurn.threadId !== thread.threadId) {
      throw persistenceError(
        "stored turns must reference a parent turn on the same thread",
        "memory_backend_turn_parent_thread_mismatch",
        {
          parentThreadId: parentTurn.threadId,
          threadId: thread.threadId,
          turnId: turn.turnId,
        }
      );
    }
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

    if (branch.headTurnNodeHash !== run.startTurnNodeHash) {
      throw persistenceError(
        "stored runs must start from the current branch head",
        "memory_backend_run_start_turn_node_mismatch",
        {
          branchHeadTurnNodeHash: branch.headTurnNodeHash,
          runId: run.runId,
          startTurnNodeHash: run.startTurnNodeHash,
        }
      );
    }

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

    if (run.status === "running" || run.status === "paused") {
      const currentActiveCount = activeRunCounts.get(run.branchId) ?? 0;
      activeRunCounts.set(run.branchId, currentActiveCount + 1);
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

    let totalCount = 0;
    for (const chunkHash of chunkHashes) {
      const chunk = ensureOrderedPathChunkExists(
        state,
        chunkHash,
        "record.orderedChunkListCbor"
      );
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
    const chunkRecord: StoredOrderedPathChunk = {
      chunkHash,
      createdAtMs: now(),
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
    areBytesEqual(left.bytes, right.bytes)
  );
}

function areStoredSchemasEqual(
  left: StoredSchema,
  right: StoredSchema
): boolean {
  return (
    left.schemaId === right.schemaId &&
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
    left.schemaId === right.schemaId &&
    left.rootTurnNodeHash === right.rootTurnNodeHash
  );
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
): KrakenPersistenceError {
  return new KrakenPersistenceError(message, { code, details });
}
