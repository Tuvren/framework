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
  StoredBranch,
  StoredRun,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";

import { persistenceError } from "./postgres-errors.js";
import {
  ensureTurnExistsInDatabase,
  ensureTurnNodeExistsInDatabase,
  ensureTurnNodeLineageMetadataInDatabase,
  selectBranchesByThread,
} from "./postgres-lookups.js";
import {
  decodeUnknownTurnRow,
  type PostgresTurnNodeLineageProofRow,
  type PostgresTurnRow,
  type TurnNodeLineageMetadata,
} from "./postgres-records.js";
import {
  decodeRunCreatedTurnNodeHashes,
  getRunActiveTurnNodeHash,
  type TurnNodeRelationship,
} from "./postgres-run-invariants.js";
import type { DbSql } from "./postgres-sql.js";
import { qualifyIdentifier } from "./postgres-sql.js";
import type { TransactionWriteTracker } from "./postgres-write-tracker.js";

// Database-backed counterpart to memory-backend-lineage.ts: the same lineage
// invariants (thread membership, descent, span, active-run alignment, parent
// linkage, backward-move archiving), evaluated against PostgreSQL rows instead of
// in-memory maps. Rather than walking `previous_turn_node_hash` one row at a
// time per call, this module leans on `turn_node_lineage_roots` — a
// denormalized index maintained by `insertTurnNodeLineageMetadata` on every
// turn node insert, carrying each node's thread-root hash and its depth below
// that root — and cross-checks it with a depth-bounded recursive CTE so a
// corrupted or stale index row cannot silently pass lineage checks.

/**
 * Validates a turn node's cached lineage metadata (root hash and depth in
 * `turn_node_lineage_roots`) against a fresh depth-bounded walk of the
 * `previous_turn_node_hash` chain, and returns the metadata once confirmed.
 * This is the trust boundary for every other lineage assertion in this
 * module: they read `turn_node_lineage_roots` for O(1) comparisons only
 * after (or via) this check, instead of re-walking the full chain each time.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_turn_node_lineage_metadata_mismatch` when the recomputed
 *   proof disagrees with the stored root hash or depth.
 */
export async function validateTurnNodeLineageMetadataInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNode: StoredTurnNode,
  label = "turnNode.hash"
): Promise<TurnNodeLineageMetadata> {
  const actualMetadata = await ensureTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    turnNode.hash,
    label
  );
  const lineageProof = await selectBoundedTurnNodeLineageProofInDatabase(
    sql,
    schemaName,
    scope,
    turnNode.hash,
    actualMetadata.depth
  );

  if (
    lineageProof === undefined ||
    lineageProof.depth !== actualMetadata.depth ||
    lineageProof.hash !== actualMetadata.rootTurnNodeHash ||
    lineageProof.previous_turn_node_hash !== null
  ) {
    throw persistenceError(
      "turn node lineage metadata must match the parent-linked turn node chain",
      "postgres_backend_turn_node_lineage_metadata_mismatch",
      {
        actualDepth: actualMetadata.depth,
        actualRootTurnNodeHash: actualMetadata.rootTurnNodeHash,
        expectedDepth: lineageProof?.depth ?? null,
        expectedRootHasParent:
          lineageProof === undefined
            ? null
            : lineageProof.previous_turn_node_hash !== null,
        expectedRootTurnNodeHash: lineageProof?.hash ?? null,
        turnNodeHash: turnNode.hash,
      }
    );
  }

  return actualMetadata;
}

/**
 * Walks up to `depth` steps of `previous_turn_node_hash` ancestry from
 * `turnNodeHash` via a recursive CTE and returns the row it terminates on
 * (the true root when `depth` matches the cached metadata's depth exactly).
 * Returns `undefined` only if `turnNodeHash` itself does not exist.
 */
async function selectBoundedTurnNodeLineageProofInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string,
  depth: number
): Promise<PostgresTurnNodeLineageProofRow | undefined> {
  const table = qualifyIdentifier(schemaName, "turn_nodes");
  const rows = await sql.unsafe<PostgresTurnNodeLineageProofRow[]>(
    `
      WITH RECURSIVE lineage(hash, previous_turn_node_hash, depth) AS (
        SELECT
          hash,
          previous_turn_node_hash,
          0 AS depth
        FROM ${table}
        WHERE scope = $1 AND hash = $2
        UNION ALL
        SELECT
          parent.hash,
          parent.previous_turn_node_hash,
          lineage.depth + 1
        FROM ${table} AS parent
        JOIN lineage ON parent.hash = lineage.previous_turn_node_hash
        WHERE parent.scope = $1 AND lineage.depth < $3
      )
      SELECT hash, previous_turn_node_hash, depth
      FROM lineage
      ORDER BY depth DESC
      LIMIT 1
    `,
    [scope, turnNodeHash, depth]
  );
  return rows[0];
}

/**
 * Derives and inserts a new turn node's lineage metadata row: depth 0 rooted
 * at itself for a genesis node, or its predecessor's depth + 1 and root hash
 * otherwise. Must run as part of the same transaction that inserts the turn
 * node row, since later lineage checks assume every stored turn node has a
 * matching `turn_node_lineage_roots` entry.
 */
export async function insertTurnNodeLineageMetadata(
  sql: DbSql,
  schemaName: string,
  scope: string,
  record: StoredTurnNode
): Promise<void> {
  const previousMetadata =
    record.previousTurnNodeHash === null
      ? null
      : await getValidatedTurnNodeLineageMetadataInDatabase(
          sql,
          schemaName,
          scope,
          record.previousTurnNodeHash
        );
  const metadata: TurnNodeLineageMetadata = {
    depth: previousMetadata === null ? 0 : previousMetadata.depth + 1,
    rootTurnNodeHash:
      previousMetadata === null
        ? record.hash
        : previousMetadata.rootTurnNodeHash,
    turnNodeHash: record.hash,
  };

  const table = qualifyIdentifier(schemaName, "turn_node_lineage_roots");
  await sql.unsafe(
    `
      INSERT INTO ${table} (
        scope,
        turn_node_hash,
        root_turn_node_hash,
        depth
      ) VALUES ($1, $2, $3, $4)
    `,
    [scope, metadata.turnNodeHash, metadata.rootTurnNodeHash, metadata.depth]
  );
}

/**
 * Loads and validates a turn node's lineage metadata by hash. Public
 * counterpart of {@link insertTurnNodeLineageMetadata} used by callers that
 * only have a hash (e.g. resolving `record.previousTurnNodeHash`) rather
 * than a full `StoredTurnNode`.
 */
export async function getValidatedTurnNodeLineageMetadataInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string
): Promise<TurnNodeLineageMetadata> {
  return await ensureValidatedTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    turnNodeHash,
    "record.previousTurnNodeHash"
  );
}

/**
 * Loads a turn node by hash and validates its lineage metadata in one step;
 * the shared entry point every lineage-relationship check in this module
 * uses to obtain a metadata row it can trust.
 *
 * @throws The injected persistence error when the turn node does not exist or
 *   its lineage metadata fails validation.
 */
async function ensureValidatedTurnNodeLineageMetadataInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string,
  label: string
): Promise<TurnNodeLineageMetadata> {
  const turnNode = await ensureTurnNodeExistsInDatabase(
    sql,
    schemaName,
    scope,
    turnNodeHash,
    label
  );
  return await validateTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    turnNode,
    label
  );
}

/**
 * Asserts that a backward branch-head move (rewind) preserved history: this
 * transaction must have created an archive branch pointing at the abandoned
 * head (`archivedFromBranchId` = the moved branch, head = the old head).
 * Mirrors `assertBackwardBranchMoveIsArchived` in the memory backend, using
 * `writeTracker.branchWrites` (falling back to a freshly captured baseline)
 * to identify branches this transaction newly created.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_backward_branch_move_missing_archive` when no matching
 *   archive branch is found.
 */
export async function assertBackwardBranchMoveIsArchivedInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  writeTracker: TransactionWriteTracker,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch
): Promise<void> {
  let archiveBranchFound = false;

  for (const branch of await selectBranchesByThread(
    sql,
    schemaName,
    scope,
    nextBranch.threadId
  )) {
    if (branch.branchId === nextBranch.branchId) {
      continue;
    }

    const trackedBranch = writeTracker.branchWrites.get(branch.branchId);
    const branchBeforeTransaction =
      trackedBranch?.before ??
      (await writeTracker.captureBranchBaseline(
        sql,
        schemaName,
        scope,
        branch.branchId
      ));

    if (
      branchBeforeTransaction === null &&
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
      "postgres_backend_backward_branch_move_missing_archive",
      {
        branchId: nextBranch.branchId,
        currentHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        previousHeadTurnNodeHash: previousBranch.headTurnNodeHash,
      }
    );
  }
}

/**
 * Asserts that a turn node's lineage root matches the thread's root turn
 * node — i.e. the node genuinely belongs to the thread rather than merely
 * existing in the database.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_thread_lineage_mismatch` when the roots disagree.
 */
export async function assertTurnNodeBelongsToThreadInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turnNodeHash: string,
  thread: StoredThread,
  label: string
): Promise<void> {
  const rootMetadata = await validateTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    await ensureTurnNodeExistsInDatabase(
      sql,
      schemaName,
      scope,
      turnNodeHash,
      label
    ),
    label
  );

  if (rootMetadata.rootTurnNodeHash !== thread.rootTurnNodeHash) {
    throw persistenceError(
      `${label} must belong to the referenced thread by lineage root`,
      "postgres_backend_thread_lineage_mismatch",
      {
        threadId: thread.threadId,
        threadRootTurnNodeHash: thread.rootTurnNodeHash,
        turnNodeHash,
        turnNodeRootTurnNodeHash: rootMetadata.rootTurnNodeHash,
      }
    );
  }
}

/**
 * Asserts that `descendantTurnNodeHash` is the ancestor itself or a
 * descendant of it along the `previousTurnNodeHash` chain. Used to keep turn
 * heads append-only: a turn's new head must extend its previous head.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_turn_node_not_descendant` when the ancestor is not on the
 *   descendant's lineage.
 */
export async function assertTurnNodeDescendsFromInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string
): Promise<void> {
  if (
    !(await isTurnNodeDescendantOfInDatabase(
      sql,
      schemaName,
      scope,
      descendantTurnNodeHash,
      ancestorTurnNodeHash
    ))
  ) {
    throw persistenceError(
      `${label} must be a descendant of the referenced start turn node`,
      "postgres_backend_turn_node_not_descendant",
      {
        ancestorTurnNodeHash,
        descendantTurnNodeHash,
      }
    );
  }
}

/**
 * Asserts a turn's semantic-parent link is canonical: a turn whose start node
 * is another turn's head must name a parent (`null` is only legal for a turn
 * with no predecessor at its start node); the parent must live on the same
 * thread and chain contiguously (parent head === child start); and when the
 * parent shares the branch it must be the immediately previous semantic turn,
 * not an earlier one.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_turn_parent_required`,
 *   `postgres_backend_turn_parent_thread_mismatch`,
 *   `postgres_backend_turn_parent_start_turn_node_mismatch`, or
 *   `postgres_backend_turn_parent_not_immediate_predecessor`.
 */
export async function assertTurnParentLinkInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turn: StoredTurn,
  label: string
): Promise<void> {
  const candidateTurnsAtStart = await selectCandidateParentTurns(
    sql,
    schemaName,
    scope,
    turn
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
      "postgres_backend_turn_parent_required",
      {
        candidateParentTurnIds: candidateTurnsAtStart.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  const parentTurn = await ensureTurnExistsInDatabase(
    sql,
    schemaName,
    scope,
    turn.parentTurnId,
    label
  );

  if (parentTurn.threadId !== turn.threadId) {
    throw persistenceError(
      "stored turns must reference a parent turn on the same thread",
      "postgres_backend_turn_parent_thread_mismatch",
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
      "postgres_backend_turn_parent_start_turn_node_mismatch",
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
      "postgres_backend_turn_parent_not_immediate_predecessor",
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

/**
 * Loads every other turn on the same thread whose head sits at `turn`'s start
 * node, ordered oldest-first — the candidate set
 * {@link assertTurnParentLinkInDatabase} checks `turn.parentTurnId` against.
 */
async function selectCandidateParentTurns(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turn: StoredTurn
): Promise<StoredTurn[]> {
  const table = qualifyIdentifier(schemaName, "turns");
  const rows = await sql.unsafe<PostgresTurnRow[]>(
    `
      SELECT *
      FROM ${table}
      WHERE scope = $1
        AND thread_id = $2
        AND head_turn_node_hash = $3
        AND turn_id <> $4
      ORDER BY created_at_ms, turn_id
    `,
    [scope, turn.threadId, turn.startTurnNodeHash, turn.turnId]
  );
  return rows.map(decodeUnknownTurnRow);
}

/**
 * Asserts that a run's start turn node lies within its turn's span: at or
 * after the turn's start node and at or before the turn's head node on the
 * same lineage.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_run_turn_span_mismatch`.
 */
export async function assertRunStartTurnNodeWithinTurnSpanInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turn: StoredTurn,
  startTurnNodeHash: string,
  label: string
): Promise<void> {
  const relationshipToTurnStart = await classifyTurnNodeRelationshipInDatabase(
    sql,
    schemaName,
    scope,
    turn.startTurnNodeHash,
    startTurnNodeHash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} must lie within the referenced turn span`,
      "postgres_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = await classifyTurnNodeRelationshipInDatabase(
    sql,
    schemaName,
    scope,
    startTurnNodeHash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} must not move past the referenced turn head`,
      "postgres_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

/**
 * Asserts that a turn node recorded in a run's `createdTurnNodesCbor` lineage
 * lies within the run's turn span (between the turn's start node and head
 * node, inclusive).
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_run_created_turn_node_outside_turn_span`.
 */
export async function assertRunCreatedTurnNodeWithinTurnSpanInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  turn: StoredTurn,
  createdTurnNode: StoredTurnNode,
  label: string
): Promise<void> {
  const relationshipToTurnStart = await classifyTurnNodeRelationshipInDatabase(
    sql,
    schemaName,
    scope,
    turn.startTurnNodeHash,
    createdTurnNode.hash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must remain within the referenced turn span`,
      "postgres_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = await classifyTurnNodeRelationshipInDatabase(
    sql,
    schemaName,
    scope,
    createdTurnNode.hash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must not move beyond the referenced turn head`,
      "postgres_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

/**
 * Asserts that a run's `createdTurnNodesCbor` decodes to a canonical lineage:
 * unique hashes forming a contiguous `previousTurnNodeHash` chain that starts
 * immediately after the run's start turn node.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_run_created_turn_nodes_duplicate` or
 *   `postgres_backend_run_created_turn_nodes_not_contiguous`.
 */
export async function assertRunCreatedTurnNodesAreCanonicalInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  run: StoredRun
): Promise<void> {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  const seenTurnNodeHashes = new Set<string>();
  let previousTurnNodeHash = run.startTurnNodeHash;

  for (const [index, turnNodeHash] of createdTurnNodeHashes.entries()) {
    if (seenTurnNodeHashes.has(turnNodeHash)) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor unique",
        "postgres_backend_run_created_turn_nodes_duplicate",
        {
          duplicateTurnNodeHash: turnNodeHash,
          index,
          runId: run.runId,
        }
      );
    }

    const createdTurnNode = await ensureTurnNodeExistsInDatabase(
      sql,
      schemaName,
      scope,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    const isImmediateNextTurnNode =
      createdTurnNode.previousTurnNodeHash === previousTurnNodeHash;

    if (!isImmediateNextTurnNode) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor as a canonical contiguous lineage",
        "postgres_backend_run_created_turn_nodes_not_contiguous",
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

/**
 * Asserts that an active (running/paused) run's active turn node — the last
 * created node, or the start node when none exist — is simultaneously the
 * branch head and the turn head, so an in-flight run can never drift from
 * the lineage position the branch and turn claim.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_active_run_branch_head_mismatch` or
 *   `postgres_backend_active_run_turn_head_mismatch`.
 */
export function assertActiveRunHeadAlignmentInDatabase(
  run: StoredRun,
  branch: StoredBranch,
  turn: StoredTurn
): void {
  const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

  if (activeTurnNodeHash !== branch.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current branch head",
      "postgres_backend_active_run_branch_head_mismatch",
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
      "postgres_backend_active_run_turn_head_mismatch",
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

/**
 * Asserts that a branch head move stays on one lineage line: the new head
 * must be the same node, a descendant (forward move), or an ancestor
 * (backward move, e.g. a rewind) of the current head. Lateral jumps onto an
 * unrelated lineage are rejected.
 *
 * @throws The injected persistence error with code
 *   `postgres_backend_branch_head_lateral_move`.
 */
export async function assertBranchHeadMoveIsLinearInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string,
  label: string
): Promise<void> {
  const relationship = await classifyTurnNodeRelationshipInDatabase(
    sql,
    schemaName,
    scope,
    previousHeadTurnNodeHash,
    nextHeadTurnNodeHash
  );

  if (relationship === "lateral") {
    throw persistenceError(
      `${label} must remain on the same thread lineage as the current branch head`,
      "postgres_backend_branch_head_lateral_move",
      {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      }
    );
  }
}

/**
 * Classifies the lineage relationship from `sourceTurnNodeHash` to
 * `targetTurnNodeHash`: `same`, `forward` (target descends from source),
 * `backward` (source descends from target), or `lateral` (neither lineage
 * contains the other). Uses each node's cached root hash and depth for an
 * O(1) same-lineage check, then a depth-bounded recursive CTE (via
 * {@link isTurnNodeDescendantOfInDatabase}) only to confirm direction when
 * depths alone do not already prove it (e.g. either node sits at the shared
 * lineage root).
 */
export async function classifyTurnNodeRelationshipInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  sourceTurnNodeHash: string,
  targetTurnNodeHash: string
): Promise<TurnNodeRelationship> {
  if (sourceTurnNodeHash === targetTurnNodeHash) {
    return "same";
  }

  const sourceMetadata = await ensureValidatedTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    sourceTurnNodeHash,
    "sourceTurnNodeHash"
  );
  const targetMetadata = await ensureValidatedTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    targetTurnNodeHash,
    "targetTurnNodeHash"
  );

  if (sourceMetadata.rootTurnNodeHash !== targetMetadata.rootTurnNodeHash) {
    return "lateral";
  }

  if (targetMetadata.depth > sourceMetadata.depth) {
    if (
      sourceMetadata.depth === 0 &&
      targetMetadata.rootTurnNodeHash === sourceTurnNodeHash
    ) {
      return "forward";
    }

    return (await isTurnNodeDescendantOfInDatabase(
      sql,
      schemaName,
      scope,
      targetTurnNodeHash,
      sourceTurnNodeHash
    ))
      ? "forward"
      : "lateral";
  }

  if (targetMetadata.depth < sourceMetadata.depth) {
    if (
      targetMetadata.depth === 0 &&
      sourceMetadata.rootTurnNodeHash === targetTurnNodeHash
    ) {
      return "backward";
    }

    return (await isTurnNodeDescendantOfInDatabase(
      sql,
      schemaName,
      scope,
      sourceTurnNodeHash,
      targetTurnNodeHash
    ))
      ? "backward"
      : "lateral";
  }

  return "lateral";
}

/**
 * Reports whether `ancestorTurnNodeHash` lies on `descendantTurnNodeHash`'s
 * lineage (a node is its own descendant). Rules out mismatched lineage roots
 * or a shallower descendant by depth alone before falling back to a
 * depth-bounded recursive CTE walk for the remaining ambiguous cases.
 */
async function isTurnNodeDescendantOfInDatabase(
  sql: DbSql,
  schemaName: string,
  scope: string,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string
): Promise<boolean> {
  if (descendantTurnNodeHash === ancestorTurnNodeHash) {
    return true;
  }

  const descendantMetadata =
    await ensureValidatedTurnNodeLineageMetadataInDatabase(
      sql,
      schemaName,
      scope,
      descendantTurnNodeHash,
      "descendantTurnNodeHash"
    );
  const ancestorMetadata = await ensureValidatedTurnNodeLineageMetadataInDatabase(
    sql,
    schemaName,
    scope,
    ancestorTurnNodeHash,
    "ancestorTurnNodeHash"
  );

  if (
    descendantMetadata.rootTurnNodeHash !== ancestorMetadata.rootTurnNodeHash ||
    descendantMetadata.depth < ancestorMetadata.depth
  ) {
    return false;
  }

  if (
    ancestorMetadata.depth === 0 &&
    descendantMetadata.rootTurnNodeHash === ancestorTurnNodeHash
  ) {
    return true;
  }

  const table = qualifyIdentifier(schemaName, "turn_nodes");
  const rows = await sql.unsafe<Array<{ found: number }>>(
    `
      WITH RECURSIVE lineage(hash, previous_turn_node_hash, remaining_depth) AS (
        SELECT hash, previous_turn_node_hash, $3::int AS remaining_depth
        FROM ${table}
        WHERE scope = $1 AND hash = $2
        UNION ALL
        SELECT
          turn_nodes.hash,
          turn_nodes.previous_turn_node_hash,
          lineage.remaining_depth - 1
        FROM ${table} AS turn_nodes
        JOIN lineage ON turn_nodes.hash = lineage.previous_turn_node_hash
        WHERE turn_nodes.scope = $1 AND lineage.remaining_depth > 0
      )
      SELECT 1 AS found
      FROM lineage
      WHERE hash = $4
      LIMIT 1
    `,
    [
      scope,
      descendantTurnNodeHash,
      descendantMetadata.depth - ancestorMetadata.depth,
      ancestorTurnNodeHash,
    ]
  );

  return rows[0] !== undefined;
}
