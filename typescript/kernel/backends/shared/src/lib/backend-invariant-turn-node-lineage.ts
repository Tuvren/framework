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

import type { StoredThread, StoredTurnNode } from "@tuvren/kernel-protocol";
import {
  type BackendInvariantRecordUtilsConfig,
  createBackendInvariantRecordUtils,
} from "./backend-invariant-record-utils.js";
import type { BackendState } from "./backend-invariant-state.js";

// Issue #108 M2: a turn node's thread membership and turn-node lineage
// index both used to be re-proven by walking `previousTurnNodeHash`
// ancestry from scratch on every single call (`assertTurnNodeBelongsToThread`,
// `assertTurnNodeDescendsFrom`, and sqlite's `validateTurnNodeLineageRootIndex`
// each independently re-walked to the thread root). Across N turn nodes on
// one linear chain, re-walking per node made the committed-state and
// lineage-index validation passes O(n^2). This module factors the walk into
// a single memoized root+depth computation
// (`resolveTurnNodeLineagePosition`) that every caller sharing one
// `TurnNodeLineageIndex` for the duration of one validation pass amortizes
// to O(n) total: a shared ancestor prefix is walked at most once no matter
// how many turns/runs/lineage-index rows reference it.

/** A turn node's position in its thread lineage: which root it descends from, and how deep. */
export interface TurnNodeLineagePosition {
  readonly depth: number;
  readonly rootTurnNodeHash: string;
}

/**
 * Per-validation-pass memoized cache of {@link TurnNodeLineagePosition},
 * keyed by turn node hash. Create one fresh index per validation pass (via
 * {@link createTurnNodeLineageIndex}) and reuse it across every
 * {@link resolveTurnNodeLineagePosition} call in that pass — never across
 * passes, since the index caches positions for exactly the turn node set a
 * single loaded/draft state contained when the index was built.
 */
export type TurnNodeLineageIndex = Map<string, TurnNodeLineagePosition>;

/** Creates a fresh, empty {@link TurnNodeLineageIndex} for one validation pass. */
export function createTurnNodeLineageIndex(): TurnNodeLineageIndex {
  return new Map();
}

/**
 * Resolves `startTurnNode`'s {@link TurnNodeLineagePosition} — its thread
 * root hash and its depth from that root — walking `previousTurnNodeHash`
 * ancestry only as far as the first already-memoized ancestor (or the true
 * root) before recording every newly visited node's position in `index` and
 * returning.
 *
 * Amortized O(1) per call across a validation pass sharing one `index`: a
 * node is walked (and its position computed) at most once no matter how
 * many times its lineage is queried, because every hop this call discovers
 * gets cached before it returns, and future calls whose walk reaches a
 * cached ancestor stop there instead of continuing to the true root.
 *
 * Never throws directly; instead invokes exactly one of `hooks.onCycle`
 * (when the walk revisits a node still on its own in-progress path) or
 * `hooks.onMissingPreviousTurnNode` (when a `previousTurnNodeHash` does not
 * resolve to a loaded turn node), both typed to return `never` so callers
 * supply their own backend- and call-site-specific error codes/messages —
 * this module never bakes in a `*_backend_*` error code itself, since the
 * two production callers ({@link createBackendInvariantTurnNodeLineage} and
 * sqlite's `validateTurnNodeLineageRootIndex`) intentionally raise different
 * codes for what is structurally the same walk.
 */
export function resolveTurnNodeLineagePosition(
  turnNodes: ReadonlyMap<string, StoredTurnNode>,
  startTurnNode: StoredTurnNode,
  index: TurnNodeLineageIndex,
  hooks: {
    onCycle(): never;
    onMissingPreviousTurnNode(missingTurnNodeHash: string): never;
  }
): TurnNodeLineagePosition {
  const cached = index.get(startTurnNode.hash);

  if (cached !== undefined) {
    return cached;
  }

  const path: StoredTurnNode[] = [];
  const turnNodesOnPath = new Set<string>();
  let current = startTurnNode;

  while (true) {
    if (turnNodesOnPath.has(current.hash)) {
      hooks.onCycle();
    }

    turnNodesOnPath.add(current.hash);
    path.push(current);

    if (current.previousTurnNodeHash === null) {
      break;
    }

    if (index.has(current.previousTurnNodeHash)) {
      break;
    }

    const previous = turnNodes.get(current.previousTurnNodeHash);

    if (previous === undefined) {
      hooks.onMissingPreviousTurnNode(current.previousTurnNodeHash);
    }

    current = previous;
  }

  const last = path.at(-1);

  if (last === undefined) {
    throw new Error(
      "internal error: expected at least one turn node on a resolved lineage path"
    );
  }

  let rootTurnNodeHash: string;
  let depth: number;

  if (last.previousTurnNodeHash === null) {
    rootTurnNodeHash = last.hash;
    depth = 0;
  } else {
    const anchor = index.get(last.previousTurnNodeHash);

    if (anchor === undefined) {
      throw new Error(
        "internal error: expected a memoized ancestor position for a lineage path that stopped early"
      );
    }

    rootTurnNodeHash = anchor.rootTurnNodeHash;
    depth = anchor.depth + 1;
  }

  index.set(last.hash, { depth, rootTurnNodeHash });

  for (let position = path.length - 2; position >= 0; position -= 1) {
    const node = path[position];

    if (node === undefined) {
      throw new Error(
        "internal error: turn node lineage path index out of bounds"
      );
    }

    depth += 1;
    index.set(node.hash, { depth, rootTurnNodeHash });
  }

  const resolved = index.get(startTurnNode.hash);

  if (resolved === undefined) {
    throw new Error(
      "internal error: expected the queried turn node to be memoized after resolution"
    );
  }

  return resolved;
}

/** Configuration for {@link createBackendInvariantTurnNodeLineage}. */
export type BackendInvariantTurnNodeLineageConfig =
  BackendInvariantRecordUtilsConfig;

/**
 * The thread-membership/descent invariant surface
 * `createBackendInvariantTurnNodeLineage` builds, shared by the memory,
 * PostgreSQL, and SQLite backends' committed-state validation (issue #108
 * M2). Declared explicitly for the same declaration-emit portability reason
 * as {@link BackendInvariantRecordUtils}.
 */
export interface BackendInvariantTurnNodeLineage {
  /**
   * Asserts that the turn node named `turnNodeHash` reaches `thread`'s root
   * turn node by lineage — i.e. it genuinely belongs to the thread rather
   * than merely existing in the store. Reuses `index`'s memoized positions
   * across every call in the same validation pass.
   *
   * @throws TuvrenPersistenceError `<prefix>_backend_missing_turn_node_reference`
   *   when `turnNodeHash` or an ancestor along its lineage does not exist,
   *   `<prefix>_backend_cyclic_turn_node_lineage` on a lineage cycle, or
   *   `<prefix>_backend_thread_lineage_mismatch` when the walk reaches a
   *   different root than `thread.rootTurnNodeHash`.
   */
  assertTurnNodeBelongsToThread(
    state: BackendState,
    turnNodeHash: string,
    thread: StoredThread,
    label: string,
    index: TurnNodeLineageIndex
  ): void;
  /**
   * Asserts that `descendantTurnNodeHash` is `ancestorTurnNodeHash` itself
   * or a descendant of it along `previousTurnNodeHash` lineage. Used to keep
   * turn heads append-only: a turn's new head must extend its previous
   * head. Reuses `index`'s memoized positions to reject same-root-but-wrong
   * depth or different-root cases in O(1) before ever walking, and to bound
   * a genuine walk to exactly the depth difference between the two nodes
   * rather than continuing all the way to the thread root.
   *
   * @throws TuvrenPersistenceError `<prefix>_backend_missing_turn_node_reference`
   *   when either node or an ancestor along the walk does not exist,
   *   `<prefix>_backend_cyclic_turn_node_lineage` on a lineage cycle, or
   *   `<prefix>_backend_turn_node_not_descendant` when the ancestor is not
   *   on the descendant's lineage.
   */
  assertTurnNodeDescendsFrom(
    state: BackendState,
    descendantTurnNodeHash: string,
    ancestorTurnNodeHash: string,
    label: string,
    index: TurnNodeLineageIndex
  ): void;
}

/**
 * Builds the thread-membership/descent invariant surface shared by the
 * memory, PostgreSQL, and SQLite backends. The only backend-specific
 * behavior is the error-code prefix (delegated to the record-utils factory
 * built from the same config).
 */
export function createBackendInvariantTurnNodeLineage(
  config: BackendInvariantTurnNodeLineageConfig
): BackendInvariantTurnNodeLineage {
  const { ensureTurnNodeExists, persistenceError } =
    createBackendInvariantRecordUtils(config);

  function code(suffix: string): string {
    return `${config.errorPrefix}_backend_${suffix}`;
  }

  /**
   * Rethrows the exact `ensureTurnNodeExists` error for a hash already known
   * to be missing from `state.turnNodes` — reused as the
   * `onMissingPreviousTurnNode` hook so a broken lineage link raises the
   * same `<prefix>_backend_missing_turn_node_reference` error every other
   * "must reference an existing turn node" check in this backend raises.
   */
  function raiseMissingTurnNodeReference(
    state: BackendState,
    missingTurnNodeHash: string,
    label: string
  ): never {
    ensureTurnNodeExists(state, missingTurnNodeHash, label);
    throw new Error(
      "internal error: expected ensureTurnNodeExists to throw for an already-confirmed-missing turn node hash"
    );
  }

  function assertTurnNodeBelongsToThread(
    state: BackendState,
    turnNodeHash: string,
    thread: StoredThread,
    label: string,
    index: TurnNodeLineageIndex
  ): void {
    const turnNode = ensureTurnNodeExists(state, turnNodeHash, label);

    const position = resolveTurnNodeLineagePosition(
      state.turnNodes,
      turnNode,
      index,
      {
        onCycle: (): never => {
          throw persistenceError(
            `${label} must not traverse a cyclic turn node lineage`,
            code("cyclic_turn_node_lineage"),
            { threadId: thread.threadId, turnNodeHash }
          );
        },
        onMissingPreviousTurnNode: (missingTurnNodeHash: string): never =>
          raiseMissingTurnNodeReference(state, missingTurnNodeHash, label),
      }
    );

    if (position.rootTurnNodeHash !== thread.rootTurnNodeHash) {
      throw persistenceError(
        `${label} must belong to the referenced thread by lineage walk`,
        code("thread_lineage_mismatch"),
        {
          threadId: thread.threadId,
          threadRootTurnNodeHash: thread.rootTurnNodeHash,
          turnNodeHash,
        }
      );
    }
  }

  function assertTurnNodeDescendsFrom(
    state: BackendState,
    descendantTurnNodeHash: string,
    ancestorTurnNodeHash: string,
    label: string,
    index: TurnNodeLineageIndex
  ): void {
    if (descendantTurnNodeHash === ancestorTurnNodeHash) {
      return;
    }

    const descendantTurnNode = ensureTurnNodeExists(
      state,
      descendantTurnNodeHash,
      label
    );
    // The lone call site in every backend's `validateCommittedState`
    // (turn.headTurnNodeHash descending from turn.startTurnNodeHash) always
    // proves ancestorTurnNodeHash exists via a preceding
    // assertTurnNodeBelongsToThread(turn.startTurnNodeHash, ...) call, so
    // this is a defensive existence check rather than new behavior.
    const ancestorTurnNode = ensureTurnNodeExists(
      state,
      ancestorTurnNodeHash,
      label
    );

    const hooks = {
      onCycle: (): never => {
        throw persistenceError(
          `${label} must not traverse a cyclic turn node lineage`,
          code("cyclic_turn_node_lineage"),
          { ancestorTurnNodeHash, descendantTurnNodeHash }
        );
      },
      onMissingPreviousTurnNode: (missingTurnNodeHash: string): never =>
        raiseMissingTurnNodeReference(state, missingTurnNodeHash, label),
    };

    const raiseNotDescendant = (): never => {
      throw persistenceError(
        `${label} must be a descendant of the referenced start turn node`,
        code("turn_node_not_descendant"),
        { ancestorTurnNodeHash, descendantTurnNodeHash }
      );
    };

    const descendantPosition = resolveTurnNodeLineagePosition(
      state.turnNodes,
      descendantTurnNode,
      index,
      hooks
    );
    const ancestorPosition = resolveTurnNodeLineagePosition(
      state.turnNodes,
      ancestorTurnNode,
      index,
      hooks
    );

    if (
      descendantPosition.rootTurnNodeHash !==
        ancestorPosition.rootTurnNodeHash ||
      descendantPosition.depth < ancestorPosition.depth
    ) {
      raiseNotDescendant();
    }

    let current = descendantTurnNode;
    let stepsRemaining = descendantPosition.depth - ancestorPosition.depth;

    while (stepsRemaining > 0) {
      const previousTurnNodeHash: string | null = current.previousTurnNodeHash;

      if (previousTurnNodeHash === null) {
        raiseNotDescendant();
        return;
      }

      const previous = state.turnNodes.get(previousTurnNodeHash);

      if (previous === undefined) {
        raiseMissingTurnNodeReference(state, previousTurnNodeHash, label);
        return;
      }

      current = previous;
      stepsRemaining -= 1;
    }

    if (current.hash !== ancestorTurnNodeHash) {
      raiseNotDescendant();
    }
  }

  return { assertTurnNodeBelongsToThread, assertTurnNodeDescendsFrom };
}
