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
import type { StoredTurnTreePath } from "@tuvren/kernel-protocol";
import { persistenceError } from "./sqlite-errors.js";
import { type BackendState, decodeHashStringArray } from "./sqlite-records.js";
import {
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./sqlite-run-invariants.js";
import {
  ensureBranchExists,
  ensureObjectExists,
  ensureOrderedPathChunkExists,
  ensureRunExists,
  ensureThreadExists,
  ensureTurnExists,
  ensureTurnNodeExists,
  ensureTurnTreeExists,
} from "./sqlite-state-utils.js";
import { resolveStoredTurnTreePathValue } from "./sqlite-state-validation.js";

/**
 * Issue #108 M6 — replaces `reclaim()`'s former second full
 * `loadValidatedState` pass (a fresh `loadState` from disk plus the entire
 * per-record identity re-hash / lineage-root-index / committed-state
 * validation suite). This function instead runs a *targeted* check directly
 * over the in-memory, already-swept `state` projection: the same object
 * `loadValidatedState`'s first call fully validated before
 * `reclaimBackendState` mutated it in place, so there is nothing left to
 * re-validate about record shape/identity (the sweep never edits a
 * surviving record's fields, only deletes whole entries) — only whether a
 * surviving record now references something the sweep deleted.
 *
 * Enumeration of what reclamation's deletion can actually break, and how
 * each is covered:
 *
 * 1. **Surviving turn nodes' `previousTurnNodeHash` ancestor chain,
 *    branches' `headTurnNodeHash`, threads' `rootTurnNodeHash`, turns'
 *    thread/branch references, and runs' turn/branch/start-turn-node
 *    references** are all backed by real SQL `FOREIGN KEY` constraints
 *    (`migrations/0001_initial_schema.sql`) that SQLite itself enforces at
 *    `COMMIT` under `defer_foreign_keys = ON` — the exact mechanism
 *    `reclaim()` already relies on to let its batched deletes run in any
 *    table order. A defective sweep that broke one of these would fail the
 *    real `COMMIT`, not silently persist. This function re-checks the same
 *    references anyway, in memory, before `COMMIT` ever runs: it is
 *    redundant with the deferred FK in the sense that both would catch the
 *    same defect, but it produces a friendly `sqlite_backend_*` error
 *    instead of a raw SQLite constraint-failure message, and it fails fast
 *    without a round trip through the database engine's own commit path.
 * 2. **Turn nodes' `consumedStagedResultsCbor` and runs'
 *    `createdTurnNodesCbor`** are opaque CBOR-encoded hash arrays, not real
 *    columns — SQLite has no foreign key to enforce on bytes inside a BLOB.
 *    This is the genuine gap the deferred FK cannot close by itself; this
 *    function decodes both and checks every referenced hash still exists
 *    among the survivors.
 * 3. **Turn-tree paths' resolved object/chunk references** (`single_hash`,
 *    `ordered_inline_cbor`, `ordered_chunk_list_cbor`) are the same kind of
 *    opaque, non-FK-backed reference. This function resolves every
 *    surviving path with the same `resolveStoredTurnTreePathValue` the
 *    sweep's own keep-closure computation (`keepPathObjects` in
 *    `backend-invariant-reclamation.ts`) uses to decide what to retain, and
 *    checks the resolved hash(es) still exist among the survivors.
 * 4. **Staged results' `objectHash`/`runId`, and turn-tree paths'
 *    `turnTreeHash`** are FK-backed columns, but both are additionally
 *    guaranteed by the sweep's own bookkeeping: a staged result can only
 *    ever survive alongside its owning run (`sweepRuns` deletes
 *    `state.stagedResults.get(runId)` in the same iteration it deletes
 *    `state.runs.get(runId)`), and a path collection can only ever survive
 *    alongside its owning turn tree (`sweepTurnTrees` deletes
 *    `state.turnTreePaths` in the same iteration it deletes
 *    `state.turnTrees`) — so both cross-references going stale is
 *    structurally impossible. This function still checks them, at
 *    negligible cost, as direct defense against a defect in that same sweep
 *    logic.
 * 5. **The derived `turn_node_lineage_roots` index table** is deleted using
 *    the exact same key list (`deletedTurnNodeHashes`, computed once in
 *    `sqlite-backend.ts`'s `applyReclamationDeletions`) as the `turn_nodes`
 *    rows themselves, so its surviving row set is provably identical to
 *    `turn_nodes`' surviving row set by construction. Nothing to re-check
 *    against the database for this table.
 * 6. **The cached `(rootTurnNodeHash, depth)` value inside each surviving
 *    `turn_node_lineage_roots` row** is left untouched by deletion (which
 *    only removes rows, never edits a surviving row's columns), and the
 *    sweep's keep-closure walk (`closeTurnNodeReachability` in
 *    `backend-invariant-reclamation.ts`) retains a kept turn node's *entire*
 *    ancestor chain back to genesis, never a partial prefix — so a
 *    surviving node's ancestor chain is exactly the same set of nodes it
 *    was before the sweep, and the cached value `loadValidatedState`'s first
 *    call already validated cannot have gone stale. This function's own
 *    lineage-chain walk (item 1 above) independently re-derives the same
 *    ancestor chain and would surface a broken link if that structural
 *    guarantee were ever violated by a defective sweep, so this is covered
 *    transitively rather than by a second read of the table.
 *
 * @throws TuvrenPersistenceError with a `sqlite_backend_*` code on the first
 *   invariant a defective sweep violated.
 */
export function assertReclamationSurvivorInvariants(state: BackendState): void {
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
 * entirely within the survivors, and its `consumedStagedResultsCbor` object
 * references must still exist. One shared `TurnNodeLineageIndex` amortizes
 * the ancestor walk to O(survivors) total, the same memoization
 * `validateCommittedState`/`validateTurnNodeLineageRootIndex` use.
 */
function assertSurvivingTurnNodeLineage(state: BackendState): void {
  const lineageIndex = createTurnNodeLineageIndex();

  for (const turnNode of state.turnNodes.values()) {
    resolveTurnNodeLineagePosition(state.turnNodes, turnNode, lineageIndex, {
      onCycle: (): never => {
        throw persistenceError(
          "surviving turn node lineage must not contain cycles after reclamation",
          "sqlite_backend_turn_node_lineage_cycle",
          { turnNodeHash: turnNode.hash }
        );
      },
      onMissingPreviousTurnNode: (missingTurnNodeHash: string): never => {
        throw persistenceError(
          "surviving turn node lineage requires complete turn node parent links after reclamation",
          "sqlite_backend_missing_turn_node_reference",
          {
            previousTurnNodeHash: missingTurnNodeHash,
            turnNodeHash: turnNode.hash,
          }
        );
      },
    });

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

/**
 * Surviving turns must reference surviving branches, threads, and turn
 * nodes (`startTurnNodeHash`/`headTurnNodeHash` are FK-backed columns, so
 * this duplicates what the deferred FK will also verify at `COMMIT` — kept
 * for the same friendlier-error reasoning as item 1 above).
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
    ensureTurnNodeExists(state, turn.headTurnNodeHash, "turn.headTurnNodeHash");
  }
}

/**
 * Surviving runs must reference surviving branches, turns, and turn nodes —
 * including the opaque `createdTurnNodesCbor` lineage no foreign key covers.
 */
function assertSurvivingRunReferences(state: BackendState): void {
  for (const run of state.runs.values()) {
    ensureBranchExists(state, run.branchId, "run.branchId");
    ensureTurnExists(state, run.turnId, "run.turnId");
    ensureTurnNodeExists(state, run.startTurnNodeHash, "run.startTurnNodeHash");

    for (const turnNodeHash of decodeRunCreatedTurnNodeHashes(run)) {
      ensureTurnNodeExists(state, turnNodeHash, "run.createdTurnNodesCbor");
    }
  }
}

/**
 * Surviving staged results must reference surviving runs and objects
 * (structurally guaranteed for `runId` by the sweep's own logic — see item 4
 * above — but checked directly anyway).
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
  const resolved = resolveStoredTurnTreePathValue(state, storedPath);

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
    for (const chunkHash of decodeHashStringArray(
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
