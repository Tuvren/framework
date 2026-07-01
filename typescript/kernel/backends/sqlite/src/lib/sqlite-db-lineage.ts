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
import type Database from "better-sqlite3";
import { persistenceError } from "./sqlite-errors.js";
import {
  ensureTurnExistsInDatabase,
  ensureTurnNodeExistsInDatabase,
  ensureTurnNodeLineageMetadataInDatabase,
  selectBranchesByThread,
} from "./sqlite-lookups.js";
import {
  decodeUnknownTurnRow,
  type SqliteTurnNodeLineageProofRow,
  type TurnNodeLineageMetadata,
} from "./sqlite-records.js";
import {
  decodeRunCreatedTurnNodeHashes,
  getRunActiveTurnNodeHash,
  type TurnNodeRelationship,
} from "./sqlite-run-invariants.js";
import type { TransactionWriteTracker } from "./sqlite-write-tracker.js";

export function validateTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNode: StoredTurnNode,
  label = "turnNode.hash"
): TurnNodeLineageMetadata {
  const actualMetadata = ensureTurnNodeLineageMetadataInDatabase(
    db,
    turnNode.hash,
    label
  );
  const lineageProof = selectBoundedTurnNodeLineageProofInDatabase(
    db,
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
      "sqlite_backend_turn_node_lineage_metadata_mismatch",
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

function selectBoundedTurnNodeLineageProofInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  depth: number
): SqliteTurnNodeLineageProofRow | undefined {
  return db
    .prepare(
      `
        WITH RECURSIVE lineage(hash, previous_turn_node_hash, depth) AS (
          SELECT
            hash,
            previous_turn_node_hash,
            0 AS depth
          FROM turn_nodes
          WHERE hash = ?
          UNION ALL
          SELECT
            parent.hash,
            parent.previous_turn_node_hash,
            lineage.depth + 1
          FROM turn_nodes AS parent
          JOIN lineage ON parent.hash = lineage.previous_turn_node_hash
          WHERE lineage.depth < ?
        )
        SELECT hash, previous_turn_node_hash, depth
        FROM lineage
        ORDER BY depth DESC
        LIMIT 1
      `
    )
    .get(turnNodeHash, depth) as SqliteTurnNodeLineageProofRow | undefined;
}

export function insertTurnNodeLineageMetadata(
  db: Database.Database,
  record: StoredTurnNode
): void {
  const previousMetadata =
    record.previousTurnNodeHash === null
      ? null
      : getValidatedTurnNodeLineageMetadataInDatabase(
          db,
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

  db.prepare(
    `
      INSERT INTO turn_node_lineage_roots (
        turn_node_hash,
        root_turn_node_hash,
        depth
      ) VALUES (?, ?, ?)
    `
  ).run(metadata.turnNodeHash, metadata.rootTurnNodeHash, metadata.depth);
}

export function getValidatedTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNodeHash: string
): TurnNodeLineageMetadata {
  return ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    turnNodeHash,
    "record.previousTurnNodeHash"
  );
}

function ensureValidatedTurnNodeLineageMetadataInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  label: string
): TurnNodeLineageMetadata {
  const turnNode = ensureTurnNodeExistsInDatabase(db, turnNodeHash, label);
  return validateTurnNodeLineageMetadataInDatabase(db, turnNode, label);
}

export function assertBackwardBranchMoveIsArchivedInDatabase(
  db: Database.Database,
  writeTracker: TransactionWriteTracker,
  previousBranch: StoredBranch,
  nextBranch: StoredBranch
): void {
  let archiveBranchFound = false;

  for (const branch of selectBranchesByThread(db, nextBranch.threadId)) {
    if (branch.branchId === nextBranch.branchId) {
      continue;
    }

    const trackedBranch = writeTracker.branchWrites.get(branch.branchId);
    const branchBeforeTransaction =
      trackedBranch?.before ??
      writeTracker.captureBranchBaseline(db, branch.branchId);

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
      "sqlite_backend_backward_branch_move_missing_archive",
      {
        branchId: nextBranch.branchId,
        currentHeadTurnNodeHash: nextBranch.headTurnNodeHash,
        previousHeadTurnNodeHash: previousBranch.headTurnNodeHash,
      }
    );
  }
}

export function assertTurnNodeBelongsToThreadInDatabase(
  db: Database.Database,
  turnNodeHash: string,
  thread: StoredThread,
  label: string
): void {
  const rootMetadata = validateTurnNodeLineageMetadataInDatabase(
    db,
    ensureTurnNodeExistsInDatabase(db, turnNodeHash, label),
    label
  );

  if (rootMetadata.rootTurnNodeHash !== thread.rootTurnNodeHash) {
    throw persistenceError(
      `${label} must belong to the referenced thread by lineage root`,
      "sqlite_backend_thread_lineage_mismatch",
      {
        threadId: thread.threadId,
        threadRootTurnNodeHash: thread.rootTurnNodeHash,
        turnNodeHash,
        turnNodeRootTurnNodeHash: rootMetadata.rootTurnNodeHash,
      }
    );
  }
}

export function assertTurnNodeDescendsFromInDatabase(
  db: Database.Database,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string,
  label: string
): void {
  if (
    !isTurnNodeDescendantOfInDatabase(
      db,
      descendantTurnNodeHash,
      ancestorTurnNodeHash
    )
  ) {
    throw persistenceError(
      `${label} must be a descendant of the referenced start turn node`,
      "sqlite_backend_turn_node_not_descendant",
      {
        ancestorTurnNodeHash,
        descendantTurnNodeHash,
      }
    );
  }
}

export function assertTurnParentLinkInDatabase(
  db: Database.Database,
  turn: StoredTurn,
  label: string
): void {
  const candidateTurnsAtStart = selectCandidateParentTurns(db, turn);
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
      "sqlite_backend_turn_parent_required",
      {
        candidateParentTurnIds: candidateTurnsAtStart.map(
          (candidateTurn) => candidateTurn.turnId
        ),
        startTurnNodeHash: turn.startTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }

  const parentTurn = ensureTurnExistsInDatabase(db, turn.parentTurnId, label);

  if (parentTurn.threadId !== turn.threadId) {
    throw persistenceError(
      "stored turns must reference a parent turn on the same thread",
      "sqlite_backend_turn_parent_thread_mismatch",
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
      "sqlite_backend_turn_parent_start_turn_node_mismatch",
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
      "sqlite_backend_turn_parent_not_immediate_predecessor",
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

function selectCandidateParentTurns(
  db: Database.Database,
  turn: StoredTurn
): StoredTurn[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM turns
        WHERE thread_id = ?
          AND head_turn_node_hash = ?
          AND turn_id <> ?
        ORDER BY created_at_ms, turn_id
      `
    )
    .all(turn.threadId, turn.startTurnNodeHash, turn.turnId);
  return rows.map(decodeUnknownTurnRow);
}

export function assertRunStartTurnNodeWithinTurnSpanInDatabase(
  db: Database.Database,
  turn: StoredTurn,
  startTurnNodeHash: string,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationshipInDatabase(
    db,
    turn.startTurnNodeHash,
    startTurnNodeHash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} must lie within the referenced turn span`,
      "sqlite_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationshipInDatabase(
    db,
    startTurnNodeHash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} must not move past the referenced turn head`,
      "sqlite_backend_run_turn_span_mismatch",
      {
        startTurnNodeHash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

export function assertRunCreatedTurnNodeWithinTurnSpanInDatabase(
  db: Database.Database,
  turn: StoredTurn,
  createdTurnNode: StoredTurnNode,
  label: string
): void {
  const relationshipToTurnStart = classifyTurnNodeRelationshipInDatabase(
    db,
    turn.startTurnNodeHash,
    createdTurnNode.hash
  );

  if (
    relationshipToTurnStart !== "same" &&
    relationshipToTurnStart !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must remain within the referenced turn span`,
      "sqlite_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnId: turn.turnId,
        turnStartTurnNodeHash: turn.startTurnNodeHash,
      }
    );
  }

  const relationshipToTurnHead = classifyTurnNodeRelationshipInDatabase(
    db,
    createdTurnNode.hash,
    turn.headTurnNodeHash
  );

  if (
    relationshipToTurnHead !== "same" &&
    relationshipToTurnHead !== "forward"
  ) {
    throw persistenceError(
      `${label} entries must not move beyond the referenced turn head`,
      "sqlite_backend_run_created_turn_node_outside_turn_span",
      {
        createdTurnNodeHash: createdTurnNode.hash,
        turnHeadTurnNodeHash: turn.headTurnNodeHash,
        turnId: turn.turnId,
      }
    );
  }
}

export function assertRunCreatedTurnNodesAreCanonicalInDatabase(
  db: Database.Database,
  run: StoredRun
): void {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  const seenTurnNodeHashes = new Set<string>();
  let previousTurnNodeHash = run.startTurnNodeHash;

  for (const [index, turnNodeHash] of createdTurnNodeHashes.entries()) {
    if (seenTurnNodeHashes.has(turnNodeHash)) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor unique",
        "sqlite_backend_run_created_turn_nodes_duplicate",
        {
          duplicateTurnNodeHash: turnNodeHash,
          index,
          runId: run.runId,
        }
      );
    }

    const createdTurnNode = ensureTurnNodeExistsInDatabase(
      db,
      turnNodeHash,
      "run.createdTurnNodesCbor"
    );
    const isImmediateNextTurnNode =
      createdTurnNode.previousTurnNodeHash === previousTurnNodeHash;

    if (!isImmediateNextTurnNode) {
      throw persistenceError(
        "stored runs must keep createdTurnNodesCbor as a canonical contiguous lineage",
        "sqlite_backend_run_created_turn_nodes_not_contiguous",
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

export function assertActiveRunHeadAlignmentInDatabase(
  run: StoredRun,
  branch: StoredBranch,
  turn: StoredTurn
): void {
  const activeTurnNodeHash = getRunActiveTurnNodeHash(run);

  if (activeTurnNodeHash !== branch.headTurnNodeHash) {
    throw persistenceError(
      "stored active runs must stay aligned with the current branch head",
      "sqlite_backend_active_run_branch_head_mismatch",
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
      "sqlite_backend_active_run_turn_head_mismatch",
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

export function assertBranchHeadMoveIsLinearInDatabase(
  db: Database.Database,
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string,
  label: string
): void {
  const relationship = classifyTurnNodeRelationshipInDatabase(
    db,
    previousHeadTurnNodeHash,
    nextHeadTurnNodeHash
  );

  if (relationship === "lateral") {
    throw persistenceError(
      `${label} must remain on the same thread lineage as the current branch head`,
      "sqlite_backend_branch_head_lateral_move",
      {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      }
    );
  }
}

export function classifyTurnNodeRelationshipInDatabase(
  db: Database.Database,
  sourceTurnNodeHash: string,
  targetTurnNodeHash: string
): TurnNodeRelationship {
  if (sourceTurnNodeHash === targetTurnNodeHash) {
    return "same";
  }

  const sourceMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    sourceTurnNodeHash,
    "sourceTurnNodeHash"
  );
  const targetMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
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

    return isTurnNodeDescendantOfInDatabase(
      db,
      targetTurnNodeHash,
      sourceTurnNodeHash
    )
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

    return isTurnNodeDescendantOfInDatabase(
      db,
      sourceTurnNodeHash,
      targetTurnNodeHash
    )
      ? "backward"
      : "lateral";
  }

  return "lateral";
}

function isTurnNodeDescendantOfInDatabase(
  db: Database.Database,
  descendantTurnNodeHash: string,
  ancestorTurnNodeHash: string
): boolean {
  if (descendantTurnNodeHash === ancestorTurnNodeHash) {
    return true;
  }

  const descendantMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
    descendantTurnNodeHash,
    "descendantTurnNodeHash"
  );
  const ancestorMetadata = ensureValidatedTurnNodeLineageMetadataInDatabase(
    db,
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

  const row = db
    .prepare(
      `
        WITH RECURSIVE lineage(hash, previous_turn_node_hash, remaining_depth) AS (
          SELECT hash, previous_turn_node_hash, ? AS remaining_depth
          FROM turn_nodes
          WHERE hash = ?
          UNION ALL
          SELECT
            turn_nodes.hash,
            turn_nodes.previous_turn_node_hash,
            lineage.remaining_depth - 1
          FROM turn_nodes
          JOIN lineage ON turn_nodes.hash = lineage.previous_turn_node_hash
          WHERE lineage.remaining_depth > 0
        )
        SELECT 1 AS found
        FROM lineage
        WHERE hash = ?
        LIMIT 1
      `
    )
    .get(
      descendantMetadata.depth - ancestorMetadata.depth,
      descendantTurnNodeHash,
      ancestorTurnNodeHash
    ) as { found: number } | undefined;

  return row !== undefined;
}
