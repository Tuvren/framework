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

import type {
  StoredRun,
  StoredTurnNode,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import {
  type BackendInvariantRecordUtilsConfig,
  createBackendInvariantRecordUtils,
} from "./backend-invariant-record-utils.js";
import type { BackendState } from "./backend-invariant-state.js";
import {
  createTurnNodeLineageIndex,
  resolveTurnNodeLineagePosition,
} from "./backend-invariant-turn-node-lineage.js";

/**
 * Configuration for {@link createBackendInvariantReclamationValidation}: the
 * record-utils error-prefix config plus the backend-owned decoders/resolver
 * this surface needs.
 */
export interface BackendInvariantReclamationValidationConfig
  extends BackendInvariantRecordUtilsConfig {
  /** Decodes a deterministically-encoded hash array (e.g. an ordered path chunk's `itemsCbor`). */
  decodeHashStringArray(bytes: Uint8Array, label: string): string[];
  /** Decodes a stored run's `createdTurnNodesCbor` into its append-only turn node hash lineage. */
  decodeRunCreatedTurnNodeHashes(run: StoredRun): string[];
  /** Decodes a turn node's `consumedStagedResultsCbor` into the object hashes of the staged results it consumed. */
  decodeTurnNodeConsumedStagedResultObjectHashes(
    turnNode: StoredTurnNode
  ): string[];
  /** Resolves a stored turn tree path's logical value (single hash, flat hash array, or chunked hash array) against `state`. */
  resolveStoredTurnTreePathValue(
    state: BackendState,
    storedPath: StoredTurnTreePath
  ): string[] | string | null;
}

/**
 * The reclamation-survivor-invariant surface
 * `createBackendInvariantReclamationValidation` builds. Declared explicitly
 * (rather than inferred) for the same declaration-emit portability reason as
 * `BackendInvariantRecordUtils`.
 */
export interface BackendInvariantReclamationValidation {
  /**
   * Re-checks every surviving record's references after a reclamation sweep
   * has mutated a loaded state projection in place, catching any dangling
   * reference a defective sweep left behind before the caller commits the
   * deletions. See each backend's own shim for the full backend-specific
   * rationale (which references are additionally FK-backed, and which are
   * only covered by this check).
   *
   * @throws The injected persistence error with a `<prefix>_backend_*` code
   *   on the first invariant a defective sweep violated.
   */
  assertReclamationSurvivorInvariants(state: BackendState): void;
}

/**
 * Builds the reclamation-survivor-invariant surface shared by the SQLite and
 * PostgreSQL backends (issue #108 M6): a targeted, referential-only
 * re-validation of a state projection a reclamation sweep has already
 * mutated in place, replacing what used to be a second full
 * `loadValidatedState` pass. The only backend-specific behavior is the
 * error-code prefix (delegated to the record-utils factory built from the
 * same config) and the injected CBOR decoders/path resolver.
 */
export function createBackendInvariantReclamationValidation(
  config: BackendInvariantReclamationValidationConfig
): BackendInvariantReclamationValidation {
  const {
    ensureBranchExists,
    ensureObjectExists,
    ensureOrderedPathChunkExists,
    ensureRunExists,
    ensureThreadExists,
    ensureTurnExists,
    ensureTurnNodeExists,
    ensureTurnTreeExists,
    persistenceError,
  } = createBackendInvariantRecordUtils(config);

  function code(suffix: string): string {
    return `${config.errorPrefix}_backend_${suffix}`;
  }

  function assertReclamationSurvivorInvariants(state: BackendState): void {
    assertSurvivingRootReferences(state);
    assertSurvivingTurnNodeLineage(state);
    assertSurvivingTurnReferences(state);
    assertSurvivingRunReferences(state);
    assertSurvivingStagedResultReferences(state);
    assertSurvivingTurnTreePathReferences(state);
  }

  /** Branch heads and thread roots must still resolve to surviving turn nodes. */
  function assertSurvivingRootReferences(state: BackendState): void {
    for (const branch of state.branches.values()) {
      ensureTurnNodeExists(
        state,
        branch.headTurnNodeHash,
        "branch.headTurnNodeHash"
      );
      ensureThreadExists(state, branch.threadId, "branch.threadId");
    }

    for (const thread of state.threads.values()) {
      ensureTurnNodeExists(
        state,
        thread.rootTurnNodeHash,
        "thread.rootTurnNodeHash"
      );
    }
  }

  /**
   * Every surviving turn node's `previousTurnNodeHash` chain must resolve
   * entirely within the survivors, and its `consumedStagedResultsCbor`
   * object references must still exist. One shared `TurnNodeLineageIndex`
   * amortizes the ancestor walk to O(survivors) total, the same memoization
   * `validateCommittedState`/`validateTurnNodeLineageRootIndex` use.
   */
  function assertSurvivingTurnNodeLineage(state: BackendState): void {
    const lineageIndex = createTurnNodeLineageIndex();

    for (const turnNode of state.turnNodes.values()) {
      resolveTurnNodeLineagePosition(state.turnNodes, turnNode, lineageIndex, {
        onCycle: (): never => {
          throw persistenceError(
            "surviving turn node lineage must not contain cycles after reclamation",
            code("turn_node_lineage_cycle"),
            { turnNodeHash: turnNode.hash }
          );
        },
        onMissingPreviousTurnNode: (missingTurnNodeHash: string): never => {
          throw persistenceError(
            "surviving turn node lineage requires complete turn node parent links after reclamation",
            code("missing_turn_node_reference"),
            {
              previousTurnNodeHash: missingTurnNodeHash,
              turnNodeHash: turnNode.hash,
            }
          );
        },
      });

      for (const objectHash of config.decodeTurnNodeConsumedStagedResultObjectHashes(
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
   * Surviving turns must reference surviving branches, threads, and turn
   * nodes (`startTurnNodeHash`/`headTurnNodeHash` are FK-backed columns, so
   * this duplicates what the deferred FK will also verify at `COMMIT` — kept
   * for the same friendlier-error reasoning documented on each backend's
   * shim).
   */
  function assertSurvivingTurnReferences(state: BackendState): void {
    for (const turn of state.turns.values()) {
      ensureBranchExists(state, turn.branchId, "turn.branchId");
      ensureThreadExists(state, turn.threadId, "turn.threadId");
      ensureTurnNodeExists(
        state,
        turn.startTurnNodeHash,
        "turn.startTurnNodeHash"
      );
      ensureTurnNodeExists(
        state,
        turn.headTurnNodeHash,
        "turn.headTurnNodeHash"
      );
    }
  }

  /**
   * Surviving runs must reference surviving branches, turns, and turn
   * nodes — including the opaque `createdTurnNodesCbor` lineage no foreign
   * key covers.
   */
  function assertSurvivingRunReferences(state: BackendState): void {
    for (const run of state.runs.values()) {
      ensureBranchExists(state, run.branchId, "run.branchId");
      ensureTurnExists(state, run.turnId, "run.turnId");
      ensureTurnNodeExists(
        state,
        run.startTurnNodeHash,
        "run.startTurnNodeHash"
      );

      for (const turnNodeHash of config.decodeRunCreatedTurnNodeHashes(run)) {
        ensureTurnNodeExists(state, turnNodeHash, "run.createdTurnNodesCbor");
      }
    }
  }

  /**
   * Surviving staged results must reference surviving runs and objects
   * (structurally guaranteed for `runId` by the sweep's own logic, but
   * checked directly anyway).
   */
  function assertSurvivingStagedResultReferences(state: BackendState): void {
    for (const stagedResultsByRun of state.stagedResults.values()) {
      for (const stagedResult of stagedResultsByRun.values()) {
        ensureRunExists(state, stagedResult.runId, "stagedResult.runId");
        ensureObjectExists(
          state,
          stagedResult.objectHash,
          "stagedResult.objectHash"
        );
      }
    }
  }

  /**
   * Surviving turn-tree paths must resolve only to surviving objects/chunks —
   * the opaque `single_hash`/`ordered_inline_cbor`/`ordered_chunk_list_cbor`
   * references no foreign key covers, exactly what the sweep's own
   * `keepPathObjects` closure step promises to retain.
   */
  function assertSurvivingTurnTreePathReferences(state: BackendState): void {
    for (const [turnTreeHash, storedPaths] of state.turnTreePaths.entries()) {
      // Belt-and-suspenders, same as the staged-result/run check above: a
      // surviving path collection can only exist alongside its owning turn
      // tree (`sweepTurnTrees` deletes `state.turnTreePaths` in the same
      // iteration it deletes `state.turnTrees`), so this is structurally
      // guaranteed rather than a real gap, but it is free to re-check.
      ensureTurnTreeExists(state, turnTreeHash, "turnTreePath.turnTreeHash");

      for (const storedPath of storedPaths.values()) {
        assertTurnTreePathSurvivorReferences(state, storedPath);
      }
    }
  }

  function assertTurnTreePathSurvivorReferences(
    state: BackendState,
    storedPath: StoredTurnTreePath
  ): void {
    const resolved = config.resolveStoredTurnTreePathValue(state, storedPath);

    if (typeof resolved === "string") {
      ensureObjectExists(
        state,
        resolved,
        "turnTreePath resolved object reference"
      );
    } else if (Array.isArray(resolved)) {
      for (const objectHash of resolved) {
        ensureObjectExists(
          state,
          objectHash,
          "turnTreePath resolved object reference"
        );
      }
    }

    if (
      storedPath.collectionKind === "ordered" &&
      storedPath.orderedEncoding === "chunked"
    ) {
      for (const chunkHash of config.decodeHashStringArray(
        storedPath.orderedChunkListCbor,
        "storedPath.orderedChunkListCbor"
      )) {
        ensureOrderedPathChunkExists(
          state,
          chunkHash,
          "turnTreePath.orderedChunkListCbor"
        );
      }
    }
  }

  return {
    assertReclamationSurvivorInvariants,
  };
}
