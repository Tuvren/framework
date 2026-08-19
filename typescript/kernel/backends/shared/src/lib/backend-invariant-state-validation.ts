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
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTree,
  type StoredTurnTreePath,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  type BackendInvariantRecordUtils,
  type BackendInvariantRecordUtilsConfig,
  compareStoredTurn,
  createBackendInvariantRecordUtils,
} from "./backend-invariant-record-utils.js";
import type { BackendState } from "./backend-invariant-state.js";
import {
  type BackendInvariantTurnNodeLineage,
  createBackendInvariantTurnNodeLineage,
  createTurnNodeLineageIndex,
  type TurnNodeLineageIndex,
} from "./backend-invariant-turn-node-lineage.js";

// Shared committed-state invariant suite for the database-backed backends
// (SQLite, PostgreSQL): the same suite the memory backend enforces directly
// against its live maps, evaluated here against a `BackendState` projection
// loaded from that backend's own rows. `ValidationHelpers` injects the
// lineage-relationship assertions each backend keeps in its own integrity-
// assertions module, so this module stays free of a direct dependency on any
// single backend's lineage/SQL-query layer.

// Issue #108 M2: thread-membership/descent lineage walks
// (`assertTurnNodeBelongsToThread`, `assertTurnNodeDescendsFrom`) are the
// same shared, memoized algorithm every database-backed backend uses
// (this package's `createBackendInvariantTurnNodeLineage`), so a
// `validateCommittedState` pass touching many turns/runs amortizes each
// shared ancestor prefix's walk cost to O(n) total instead of O(depth) per
// call.

/** Builds a fully-formed `<prefix>_backend_<reason>` error code. */
function errorCode(errorPrefix: string, suffix: string): string {
  return `${errorPrefix}_backend_${suffix}`;
}

/**
 * Configuration for {@link createBackendInvariantStateValidation}: the
 * record-utils error-prefix config plus the backend-owned CBOR decoders this
 * surface needs.
 */
export interface BackendInvariantStateValidationConfig
  extends BackendInvariantRecordUtilsConfig {
  /**
   * Decodes deterministic-CBOR bytes into a `HashString[]`, validating every
   * element. This stays backend-owned (each backend has its own records
   * module) and is injected here rather than imported.
   */
  decodeHashStringArray(bytes: Uint8Array, label: string): string[];
  /**
   * Decodes deterministic-CBOR bytes into a validated `TurnTreeSchema`. This
   * stays backend-owned (each backend has its own records module) and is
   * injected here rather than imported.
   */
  decodeTurnTreeSchema(bytes: Uint8Array, label: string): TurnTreeSchema;
}

/**
 * Backend-owned lineage and decoding helpers injected into
 * {@link BackendInvariantStateValidation.validateCommittedState} and
 * {@link BackendInvariantStateValidation.validateTurnTreePathInvariants},
 * mirroring the corresponding imports in memory-backend-state.ts. Exported
 * (rather than kept module-private, as it was pre-extraction) because a
 * shim in another package now re-exports functions typed with it, and
 * cross-module declaration emit can only name an external type that is
 * itself exported.
 */
export interface ValidationHelpers {
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

/**
 * The committed-state validation invariant surface
 * `createBackendInvariantStateValidation` builds. Declared explicitly
 * (rather than inferred) for the same declaration-emit portability reason as
 * `BackendInvariantRecordUtils`.
 */
export interface BackendInvariantStateValidation {
  /**
   * Resolves a stored turn-tree path to its logical value: the single hash
   * (or `null`) for `single` paths, the inline hash array for `flat`
   * ordered paths, or the concatenation of all referenced chunks' items for
   * `chunked` ordered paths.
   */
  resolveStoredTurnTreePathValue(
    state: BackendState,
    storedPath: StoredTurnTreePath
  ): string[] | string | null;
  /**
   * Validates the full committed-state invariant suite over a loaded state
   * projection before it may be persisted: thread roots are unique genesis
   * nodes, branch heads and archives are lineage-legal, turn nodes/turns/runs
   * are referentially and schema-consistent, and turn-tree manifests match
   * their stored paths.
   *
   * @param state - The loaded (post-transaction) state projection to
   *   validate.
   * @param baseState - The state projection loaded before the transaction;
   *   used for cross-transaction invariants such as backward branch moves
   *   requiring an archive branch created in the same transaction.
   * @throws The injected persistence error with a `<prefix>_backend_*` code
   *   on the first violated invariant; the caller must then abort the
   *   transaction.
   */
  validateCommittedState(
    state: BackendState,
    baseState: BackendState,
    helpers: ValidationHelpers
  ): void;
  /**
   * Re-validates every record in a loaded state projection against the
   * kernel-protocol schema/identity assertions (`assertStored*`), the same
   * checks each record passed on its original write. Guards against a
   * database mutated outside this backend (manual SQL, a restored backup)
   * ever being accepted as valid without first re-proving every row is
   * well-formed and, for content-addressed families, that its identity still
   * matches its content.
   */
  validateLoadedState(state: BackendState): Promise<void>;
  /**
   * Validates every stored turn-tree path collection: no turn tree
   * references an empty path collection, every ordered path's
   * `orderedCount` agrees with its decoded (inline or chunked) hash count,
   * and every turn tree's decoded manifest matches its indexed path rows
   * exactly.
   *
   * @throws The injected persistence error with a `<prefix>_backend_*` code
   *   on the first violated invariant.
   */
  validateTurnTreePathInvariants(
    state: BackendState,
    helpers: ValidationHelpers
  ): void;
}

/**
 * Re-validates every record in a loaded state projection against the
 * kernel-protocol schema/identity assertions (`assertStored*`). Defined at
 * module scope (rather than nested inside
 * {@link createBackendInvariantStateValidation}) so its many independent
 * per-family loops do not each accrue an extra nesting-depth penalty toward
 * cognitive-complexity limits; its dependencies are passed explicitly
 * instead of closed over.
 */
async function validateLoadedStateCore(
  state: BackendState,
  recordUtils: BackendInvariantRecordUtils,
  getSchemaForSchemaId: (
    state: BackendState,
    schemaId: string,
    label: string
  ) => TurnTreeSchema
): Promise<void> {
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
      const turnTree = recordUtils.ensureTurnTreeExists(
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

/**
 * Every stored branch head belongs to its thread; every archive branch
 * references a same-thread source branch that existed (with a matching
 * head) before the transaction and was paired with a backward move; and
 * every backward head move on a pre-existing branch is paired with an
 * archive branch preserving the abandoned head.
 *
 * Defined at module scope for the same cognitive-complexity reason as
 * {@link validateLoadedStateCore}.
 */
function validateBranchInvariantsCore(
  state: BackendState,
  baseState: BackendState,
  helpers: ValidationHelpers,
  lineageIndex: TurnNodeLineageIndex,
  errorPrefix: string,
  recordUtils: BackendInvariantRecordUtils,
  turnNodeLineage: BackendInvariantTurnNodeLineage
): void {
  for (const branch of state.branches.values()) {
    const thread = recordUtils.ensureThreadExists(
      state,
      branch.threadId,
      "branch.threadId"
    );

    turnNodeLineage.assertTurnNodeBelongsToThread(
      state,
      branch.headTurnNodeHash,
      thread,
      "branch.headTurnNodeHash",
      lineageIndex
    );

    if (branch.archivedFromBranchId === undefined) {
      continue;
    }

    const sourceBranch = recordUtils.ensureBranchExists(
      state,
      branch.archivedFromBranchId,
      "branch.archivedFromBranchId"
    );

    if (sourceBranch.threadId !== branch.threadId) {
      throw recordUtils.persistenceError(
        "stored branches must archive only from branches in the same thread",
        errorCode(errorPrefix, "branch_archive_thread_mismatch"),
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
      throw recordUtils.persistenceError(
        "new archive branches must reference a source branch that existed before the transaction",
        errorCode(
          errorPrefix,
          "branch_archive_source_missing_before_transaction"
        ),
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
      throw recordUtils.persistenceError(
        "new archive branches must preserve the pre-rollback source branch head",
        errorCode(errorPrefix, "branch_archive_head_mismatch"),
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
      throw recordUtils.persistenceError(
        "new archive branches must be paired with a backward move on their source branch",
        errorCode(errorPrefix, "branch_archive_without_backward_move"),
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

/**
 * Every stored run references consistent turn/branch/schema identity, its
 * start and created turn nodes lie within its turn's span in canonical
 * contiguous order, an active run's position matches its branch and turn
 * heads, at most one run per branch is active, and staged results exist
 * only for runs still `running`.
 *
 * Defined at module scope for the same cognitive-complexity reason as
 * {@link validateLoadedStateCore}.
 */
function validateRunInvariantsCore(
  state: BackendState,
  helpers: ValidationHelpers,
  lineageIndex: TurnNodeLineageIndex,
  errorPrefix: string,
  recordUtils: BackendInvariantRecordUtils,
  turnNodeLineage: BackendInvariantTurnNodeLineage
): void {
  const activeRunCounts = new Map<string, number>();

  for (const run of state.runs.values()) {
    const branch = recordUtils.ensureBranchExists(
      state,
      run.branchId,
      "run.branchId"
    );
    const turn = recordUtils.ensureTurnExists(state, run.turnId, "run.turnId");
    const startTurnNode = recordUtils.ensureTurnNodeExists(
      state,
      run.startTurnNodeHash,
      "run.startTurnNodeHash"
    );
    const thread = recordUtils.ensureThreadExists(
      state,
      turn.threadId,
      "turn.threadId"
    );

    if (turn.branchId !== branch.branchId) {
      throw recordUtils.persistenceError(
        "stored runs must reference a turn on the same branch",
        errorCode(errorPrefix, "run_branch_mismatch"),
        {
          branchId: branch.branchId,
          runId: run.runId,
          turnBranchId: turn.branchId,
          turnId: turn.turnId,
        }
      );
    }

    turnNodeLineage.assertTurnNodeBelongsToThread(
      state,
      run.startTurnNodeHash,
      thread,
      "run.startTurnNodeHash",
      lineageIndex
    );

    if (startTurnNode.schemaId !== run.schemaId) {
      throw recordUtils.persistenceError(
        "stored runs must use the schema of their start turn node",
        errorCode(errorPrefix, "run_schema_mismatch"),
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
      const createdTurnNode = recordUtils.ensureTurnNodeExists(
        state,
        turnNodeHash,
        "run.createdTurnNodesCbor"
      );
      turnNodeLineage.assertTurnNodeBelongsToThread(
        state,
        turnNodeHash,
        thread,
        "run.createdTurnNodesCbor",
        lineageIndex
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
      throw recordUtils.persistenceError(
        "stored terminal or paused runs must not retain staged results",
        errorCode(errorPrefix, "run_has_terminal_staged_results"),
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
      throw recordUtils.persistenceError(
        "stored branches must not have more than one active run",
        errorCode(errorPrefix, "multiple_active_runs"),
        {
          activeRunCount,
          branchId,
        }
      );
    }
  }

  for (const [runId, stagedResults] of state.stagedResults.entries()) {
    const run = recordUtils.ensureRunExists(
      state,
      runId,
      "stagedResults.runId"
    );

    if (run.status !== "running") {
      throw recordUtils.persistenceError(
        "stored staged results may only exist for running runs",
        errorCode(errorPrefix, "staged_result_run_not_running"),
        {
          runId,
          stagedResultCount: stagedResults.size,
          status: run.status,
        }
      );
    }
  }
}

/**
 * Builds the committed-state validation invariant surface shared by the
 * SQLite and PostgreSQL backends: `validateLoadedState`, `validateCommittedState`,
 * `validateTurnTreePathInvariants`, and `resolveStoredTurnTreePathValue`. The
 * only backend-specific behavior is the error-code prefix (delegated to the
 * record-utils factory built from the same config) and the injected
 * `decodeHashStringArray`/`decodeTurnTreeSchema` CBOR decoders.
 */
export function createBackendInvariantStateValidation(
  config: BackendInvariantStateValidationConfig
): BackendInvariantStateValidation {
  const recordUtils = createBackendInvariantRecordUtils(config);
  const {
    ensureObjectExists,
    ensureOrderedPathChunkExists,
    ensureRunExists,
    ensureSchemaRecordExists,
    ensureTurnNodeExists,
    ensureTurnTreeExists,
    persistenceError,
  } = recordUtils;

  function code(suffix: string): string {
    return errorCode(config.errorPrefix, suffix);
  }

  // One memoized root+depth index shared across every thread-membership/
  // descent check this pass runs (issue #108 M2): a shared ancestor prefix
  // (e.g. a long turn node chain many turns/runs all reference) is walked
  // at most once instead of once per referencing turn/run.
  const turnNodeLineage = createBackendInvariantTurnNodeLineage({
    errorPrefix: config.errorPrefix,
  });

  function validateLoadedState(state: BackendState): Promise<void> {
    return validateLoadedStateCore(state, recordUtils, getSchemaForSchemaId);
  }

  function validateCommittedState(
    state: BackendState,
    baseState: BackendState,
    helpers: ValidationHelpers
  ): void {
    const lineageIndex = createTurnNodeLineageIndex();

    validateThreadInvariants(state);
    validateBranchInvariants(state, baseState, helpers, lineageIndex);
    validateTurnNodeInvariants(state, helpers);
    validateTurnInvariants(state, helpers, lineageIndex);
    validateRunInvariants(state, helpers, lineageIndex);
    validateTurnTreePathInvariants(state, helpers);
    validateObserveAnnotationInvariants(state);
  }

  /** Every annotation must reference its owning run and optional turn node. */
  function validateObserveAnnotationInvariants(state: BackendState): void {
    for (const [runId, annotations] of state.observeAnnotations) {
      ensureRunExists(state, runId, "observeAnnotation.runId");

      for (const annotation of annotations) {
        if (annotation.turnNodeHash !== null) {
          ensureTurnNodeExists(
            state,
            annotation.turnNodeHash,
            "observeAnnotation.turnNodeHash"
          );
        }
      }
    }
  }

  /** Every stored thread's root turn node is a genesis node and unique. */
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
          code("thread_schema_mismatch"),
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
          code("thread_root_not_genesis"),
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
          code("thread_root_not_unique"),
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
    helpers: ValidationHelpers,
    lineageIndex: TurnNodeLineageIndex
  ): void {
    validateBranchInvariantsCore(
      state,
      baseState,
      helpers,
      lineageIndex,
      config.errorPrefix,
      recordUtils,
      turnNodeLineage
    );
  }

  /**
   * Every stored turn node uses its turn tree's schema, and every staged
   * result it consumed exists as an object.
   */
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
          code("turn_node_schema_mismatch"),
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

  /**
   * Every stored turn references a branch on its own thread, its start and
   * head turn nodes belong to that thread with the head descending from the
   * start, and its semantic-parent link is canonical.
   */
  function validateTurnInvariants(
    state: BackendState,
    helpers: ValidationHelpers,
    lineageIndex: TurnNodeLineageIndex
  ): void {
    for (const turn of state.turns.values()) {
      const thread = recordUtils.ensureThreadExists(
        state,
        turn.threadId,
        "turn.threadId"
      );
      const branch = recordUtils.ensureBranchExists(
        state,
        turn.branchId,
        "turn.branchId"
      );

      if (branch.threadId !== thread.threadId) {
        throw persistenceError(
          "stored turns must reference a branch on the same thread",
          code("turn_branch_thread_mismatch"),
          {
            branchId: branch.branchId,
            branchThreadId: branch.threadId,
            threadId: thread.threadId,
            turnId: turn.turnId,
          }
        );
      }

      turnNodeLineage.assertTurnNodeBelongsToThread(
        state,
        turn.startTurnNodeHash,
        thread,
        "turn.startTurnNodeHash",
        lineageIndex
      );
      turnNodeLineage.assertTurnNodeBelongsToThread(
        state,
        turn.headTurnNodeHash,
        thread,
        "turn.headTurnNodeHash",
        lineageIndex
      );
      turnNodeLineage.assertTurnNodeDescendsFrom(
        state,
        turn.headTurnNodeHash,
        turn.startTurnNodeHash,
        "turn.headTurnNodeHash",
        lineageIndex
      );

      helpers.assertTurnParentLink(state, turn, "turn.parentTurnId");
    }
  }

  function validateRunInvariants(
    state: BackendState,
    helpers: ValidationHelpers,
    lineageIndex: TurnNodeLineageIndex
  ): void {
    validateRunInvariantsCore(
      state,
      helpers,
      lineageIndex,
      config.errorPrefix,
      recordUtils,
      turnNodeLineage
    );
  }

  function validateTurnTreePathInvariants(
    state: BackendState,
    helpers: ValidationHelpers
  ): void {
    for (const [turnTreeHash, storedPaths] of state.turnTreePaths.entries()) {
      ensureTurnTreeExists(state, turnTreeHash, "turnTreePath.turnTreeHash");

      if (storedPaths.size === 0) {
        throw persistenceError(
          "stored turn tree path collections must not be empty",
          code("empty_turn_tree_path_collection"),
          { turnTreeHash }
        );
      }
    }

    validateTurnTreePathCardinalityMetadata(state, helpers);

    for (const turnTree of state.turnTrees.values()) {
      assertTurnTreeManifestMatchesStoredPaths(state, turnTree);
    }
  }

  /** Dispatches each stored turn-tree path to its encoding-specific cardinality check. */
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

  /**
   * Asserts a `flat` ordered path's `orderedCount` matches its decoded
   * inline hash array length.
   *
   * @throws The injected persistence error with code
   *   `<prefix>_backend_turn_tree_path_ordered_count_mismatch`.
   */
  function validateOrderedFlatPathCardinality(
    storedPath: Extract<
      StoredTurnTreePath,
      { collectionKind: "ordered"; orderedEncoding: "flat" }
    >
  ): void {
    const hashes = config.decodeHashStringArray(
      storedPath.orderedInlineCbor,
      "storedPath.orderedInlineCbor"
    );

    if (storedPath.orderedCount !== hashes.length) {
      throw persistenceError(
        "stored ordered turn tree paths must keep orderedCount aligned with encoded hashes",
        code("turn_tree_path_ordered_count_mismatch"),
        {
          decodedCount: hashes.length,
          orderedCount: storedPath.orderedCount,
          path: storedPath.path,
          turnTreeHash: storedPath.turnTreeHash,
        }
      );
    }
  }

  /**
   * Asserts a `chunked` ordered path's referenced chunks are canonically
   * laid out (via {@link ValidationHelpers.assertChunkedTurnTreePathChunkLayout}),
   * each chunk's `itemCount` matches its decoded items, and the chunks'
   * summed item count matches the path's `orderedCount`.
   *
   * @throws The injected persistence error with code
   *   `<prefix>_backend_ordered_path_chunk_item_count_mismatch` or
   *   `<prefix>_backend_turn_tree_path_ordered_count_mismatch`.
   */
  function validateOrderedChunkedPathCardinality(
    state: BackendState,
    storedPath: Extract<
      StoredTurnTreePath,
      { collectionKind: "ordered"; orderedEncoding: "chunked" }
    >,
    helpers: ValidationHelpers
  ): void {
    const chunkHashes = config.decodeHashStringArray(
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
      const chunkItemHashes = config.decodeHashStringArray(
        chunk.itemsCbor,
        "chunk.itemsCbor"
      );

      if (chunk.itemCount !== chunkItemHashes.length) {
        throw persistenceError(
          "stored ordered path chunk rows must keep itemCount aligned with itemsCbor",
          code("ordered_path_chunk_item_count_mismatch"),
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
        code("turn_tree_path_ordered_count_mismatch"),
        {
          orderedCount: storedPath.orderedCount,
          path: storedPath.path,
          totalCount,
          turnTreeHash: storedPath.turnTreeHash,
        }
      );
    }
  }

  /** Loads and decodes the turn-tree schema stored under `schemaId`. */
  function getSchemaForSchemaId(
    state: BackendState,
    schemaId: string,
    label: string
  ): TurnTreeSchema {
    const schemaRecord = ensureSchemaRecordExists(state, schemaId, label);
    return decodeSchemaRecord(schemaRecord.schemaCbor, `${label} schema`);
  }

  /** Loads and decodes the turn-tree schema a stored turn tree references. */
  function getSchemaForTurnTree(
    state: BackendState,
    turnTree: StoredTurnTree
  ): TurnTreeSchema {
    return getSchemaForSchemaId(state, turnTree.schemaId, "turnTree.schemaId");
  }

  /**
   * Asserts that a turn tree's decoded manifest and its indexed path rows
   * agree exactly: the stored paths cover every schema-defined path, no more
   * and no fewer, and each stored path resolves to the same logical value
   * the manifest records for that path.
   *
   * @throws The injected persistence error with code
   *   `<prefix>_backend_invalid_turn_tree_manifest`,
   *   `<prefix>_backend_missing_turn_tree_paths`,
   *   `<prefix>_backend_turn_tree_path_count_mismatch`,
   *   `<prefix>_backend_missing_turn_tree_path`, or
   *   `<prefix>_backend_turn_tree_manifest_path_mismatch`.
   */
  function assertTurnTreeManifestMatchesStoredPaths(
    state: BackendState,
    turnTree: StoredTurnTree
  ): void {
    const schema = getSchemaForTurnTree(state, turnTree);
    const manifestValue = decodeDeterministicKernelRecord(
      turnTree.manifestCbor
    );
    const storedPaths = state.turnTreePaths.get(turnTree.hash);

    if (
      manifestValue === null ||
      typeof manifestValue !== "object" ||
      Array.isArray(manifestValue) ||
      manifestValue instanceof Uint8Array
    ) {
      throw persistenceError(
        "stored turn trees must decode to a manifest object",
        code("invalid_turn_tree_manifest"),
        { turnTreeHash: turnTree.hash }
      );
    }

    if (storedPaths === undefined) {
      throw persistenceError(
        "stored turn trees must have indexed path rows",
        code("missing_turn_tree_paths"),
        { turnTreeHash: turnTree.hash }
      );
    }

    if (storedPaths.size !== schema.paths.length) {
      throw persistenceError(
        "stored turn tree paths must fully cover the schema-defined manifest",
        code("turn_tree_path_count_mismatch"),
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
          code("missing_turn_tree_path"),
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
          code("turn_tree_manifest_path_mismatch"),
          {
            path: pathDefinition.path,
            turnTreeHash: turnTree.hash,
          }
        );
      }
    }
  }

  /**
   * Resolves a stored turn-tree path to its logical value: the single hash
   * (or `null`) for `single` paths, the inline hash array for `flat`
   * ordered paths, or the concatenation of all referenced chunks' items for
   * `chunked` ordered paths.
   */
  function resolveStoredTurnTreePathValue(
    state: BackendState,
    storedPath: StoredTurnTreePath
  ): string[] | string | null {
    if (storedPath.collectionKind === "single") {
      return storedPath.singleHash;
    }

    if (storedPath.orderedEncoding === "flat") {
      return config.decodeHashStringArray(
        storedPath.orderedInlineCbor,
        "storedPath.orderedInlineCbor"
      );
    }

    const resolvedHashes: string[] = [];
    const chunkHashes = config.decodeHashStringArray(
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
        ...config.decodeHashStringArray(chunk.itemsCbor, "chunk.itemsCbor")
      );
    }

    return resolvedHashes;
  }

  /** Decodes a schema record's CBOR bytes into a validated `TurnTreeSchema`. */
  function decodeSchemaRecord(
    bytes: Uint8Array,
    label: string
  ): TurnTreeSchema {
    return config.decodeTurnTreeSchema(bytes, label);
  }

  return {
    resolveStoredTurnTreePathValue,
    validateCommittedState,
    validateLoadedState,
    validateTurnTreePathInvariants,
  };
}

/**
 * Compares a decoded manifest path value against a resolved stored-path
 * value: strict equality for `null`/string values, element-wise equality for
 * hash arrays. Pure and backend-independent, so it lives outside the
 * factory closure.
 */
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

// Unused; retained only as documented dead code pending removal (superseded
// by listTurnsByThread in backend-invariant-integrity-assertions.js).
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
