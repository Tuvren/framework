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
  ReclamationSummary,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import {
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./memory-backend-lineage.js";
import {
  decodeHashStringArray,
  resolveStoredTurnTreePathValue,
} from "./memory-backend-turn-tree.js";
import type { BackendState } from "./memory-backend-types.js";

/**
 * The reference closure of durable state that reclamation must retain: the
 * hash-addressed content reachable from live roots (or created within the grace
 * window). Every retained record only references members of these sets, so
 * deleting everything outside them leaves a referentially consistent state.
 */
interface KeepClosure {
  chunks: Set<string>;
  objects: Set<string>;
  turnNodes: Set<string>;
  turnTrees: Set<string>;
}

/**
 * Realizes the §9.4 reachability reclamation primitive over the in-memory
 * `BackendState` shared by the memory and PostgreSQL backends. It mutates
 * `state` in place, deleting only durable state that is unreachable from live
 * roots AND older than the grace horizon. The caller is responsible for running
 * this against a draft state inside a serialized transaction and validating the
 * committed result.
 *
 * The sweep is referentially closed by construction: the keep set is the
 * reference closure of (live roots ∪ everything created at/after the grace
 * horizon), so every retained record only references other retained records and
 * the committed-state invariants hold after deletion.
 */
export function reclaimBackendState(state: BackendState): ReclamationSummary {
  const graceHorizonMs = computeGraceHorizonMs(state);
  const keep = computeKeepClosure(state, graceHorizonMs);
  const keepTurnIds = collectKeptTurnIds(state, keep.turnNodes);
  return sweep(state, keep, keepTurnIds, graceHorizonMs);
}

/**
 * The grace horizon is the createdAtMs of the oldest active execution (running
 * or paused run) — the conservative in-flight write horizon. No durable state
 * created at or after this instant is released, so reclamation can never race a
 * live execution's checkpoint or recovery. With no active execution there is no
 * in-flight horizon, so everything unreachable is releasable.
 */
function computeGraceHorizonMs(state: BackendState): number {
  let graceHorizonMs = Number.POSITIVE_INFINITY;
  for (const run of state.runs.values()) {
    if (isActiveRun(run.status) && run.createdAtMs < graceHorizonMs) {
      graceHorizonMs = run.createdAtMs;
    }
  }
  return graceHorizonMs;
}

function computeKeepClosure(
  state: BackendState,
  graceHorizonMs: number
): KeepClosure {
  const keep: KeepClosure = {
    chunks: new Set(),
    objects: new Set(),
    turnNodes: new Set(),
    turnTrees: new Set(),
  };
  const turnNodeStack: string[] = [];
  const turnTreeStack: string[] = [];

  seedLiveRoots(state, turnNodeStack, keep);
  seedGraceRoots(state, graceHorizonMs, turnNodeStack, turnTreeStack, keep);
  closeTurnNodeReachability(state, keep, turnNodeStack, turnTreeStack);
  closeTurnTreeReachability(state, keep, turnTreeStack);

  return keep;
}

/** Live roots: non-archived branch heads, thread roots, active-run staged work. */
function seedLiveRoots(
  state: BackendState,
  turnNodeStack: string[],
  keep: KeepClosure
): void {
  for (const branch of state.branches.values()) {
    if (branch.archivedFromBranchId === undefined) {
      turnNodeStack.push(branch.headTurnNodeHash);
    }
  }
  for (const thread of state.threads.values()) {
    turnNodeStack.push(thread.rootTurnNodeHash);
  }
  for (const run of state.runs.values()) {
    if (isActiveRun(run.status)) {
      turnNodeStack.push(run.startTurnNodeHash);
      for (const hash of decodeRunCreatedTurnNodeHashes(run)) {
        turnNodeStack.push(hash);
      }
    }
  }
  for (const [runId, results] of state.stagedResults) {
    const run = state.runs.get(runId);
    if (run !== undefined && isActiveRun(run.status)) {
      for (const stagedResult of results.values()) {
        keep.objects.add(stagedResult.objectHash);
      }
    }
  }
}

/**
 * Grace-window roots: any durable state newer than the oldest active execution
 * lease is retained, and its reference closure is retained with it so a kept
 * record can never reference a swept one.
 */
function seedGraceRoots(
  state: BackendState,
  graceHorizonMs: number,
  turnNodeStack: string[],
  turnTreeStack: string[],
  keep: KeepClosure
): void {
  for (const [hash, turnNode] of state.turnNodes) {
    if (turnNode.createdAtMs >= graceHorizonMs) {
      turnNodeStack.push(hash);
    }
  }
  for (const [hash, turnTree] of state.turnTrees) {
    if (turnTree.createdAtMs >= graceHorizonMs) {
      turnTreeStack.push(hash);
    }
  }
  for (const [hash, object] of state.objects) {
    if (object.createdAtMs >= graceHorizonMs) {
      keep.objects.add(hash);
    }
  }
  for (const [hash, chunk] of state.orderedPathChunks) {
    if (chunk.createdAtMs >= graceHorizonMs) {
      keep.chunks.add(hash);
    }
  }
}

/** Closure over turn nodes (walk ancestors via previousTurnNodeHash). */
function closeTurnNodeReachability(
  state: BackendState,
  keep: KeepClosure,
  turnNodeStack: string[],
  turnTreeStack: string[]
): void {
  while (turnNodeStack.length > 0) {
    const hash = turnNodeStack.pop() as string;
    if (keep.turnNodes.has(hash)) {
      continue;
    }
    const turnNode = state.turnNodes.get(hash);
    if (turnNode === undefined) {
      continue;
    }
    keep.turnNodes.add(hash);
    if (turnNode.previousTurnNodeHash !== null) {
      turnNodeStack.push(turnNode.previousTurnNodeHash);
    }
    turnTreeStack.push(turnNode.turnTreeHash);
    if (turnNode.eventHash !== null) {
      keep.objects.add(turnNode.eventHash);
    }
    for (const objectHash of decodeTurnNodeConsumedStagedResultObjectHashes(
      turnNode
    )) {
      keep.objects.add(objectHash);
    }
  }
}

/** Closure over turn trees → manifest objects + ordered-path chunks. */
function closeTurnTreeReachability(
  state: BackendState,
  keep: KeepClosure,
  turnTreeStack: string[]
): void {
  while (turnTreeStack.length > 0) {
    const hash = turnTreeStack.pop() as string;
    if (keep.turnTrees.has(hash) || !state.turnTrees.has(hash)) {
      continue;
    }
    keep.turnTrees.add(hash);
    const storedPaths = state.turnTreePaths.get(hash);
    if (storedPaths === undefined) {
      continue;
    }
    for (const storedPath of storedPaths.values()) {
      keepPathObjects(state, storedPath, keep);
    }
  }
}

function keepPathObjects(
  state: BackendState,
  storedPath: StoredTurnTreePath,
  keep: KeepClosure
): void {
  const resolved = resolveStoredTurnTreePathValue(state, storedPath);
  if (typeof resolved === "string") {
    keep.objects.add(resolved);
  } else if (Array.isArray(resolved)) {
    for (const objectHash of resolved) {
      keep.objects.add(objectHash);
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
      keep.chunks.add(chunkHash);
    }
  }
}

/**
 * A turn is retained iff its head turn node is retained (its start node is an
 * ancestor of the head and therefore already in the kept closure).
 */
function collectKeptTurnIds(
  state: BackendState,
  keepTurnNodes: Set<string>
): Set<string> {
  const keptTurnIds = new Set<string>();
  for (const turn of state.turns.values()) {
    if (keepTurnNodes.has(turn.headTurnNodeHash)) {
      keptTurnIds.add(turn.turnId);
    }
  }
  return keptTurnIds;
}

/**
 * Releases every record outside the keep closure (and, for hash-addressed
 * content, older than the grace horizon). Decisions read the pre-computed keep
 * sets only, so deletion order is irrelevant.
 */
function sweep(
  state: BackendState,
  keep: KeepClosure,
  keepTurnIds: Set<string>,
  graceHorizonMs: number
): ReclamationSummary {
  return {
    releasedArchivedBranchCount: sweepArchivedBranches(state, keep.turnNodes),
    releasedObjectCount: sweepObjects(state, keep.objects, graceHorizonMs),
    releasedOrderedPathChunkCount: sweepChunks(
      state,
      keep.chunks,
      graceHorizonMs
    ),
    releasedRunCount: sweepRuns(state, keep.turnNodes, keepTurnIds),
    releasedTurnCount: sweepTurns(state, keepTurnIds),
    releasedTurnNodeCount: sweepTurnNodes(
      state,
      keep.turnNodes,
      graceHorizonMs
    ),
    releasedTurnTreeCount: sweepTurnTrees(
      state,
      keep.turnTrees,
      graceHorizonMs
    ),
    retainedObjectCount: state.objects.size,
  };
}

function sweepRuns(
  state: BackendState,
  keepTurnNodes: Set<string>,
  keepTurnIds: Set<string>
): number {
  let released = 0;
  for (const [runId, run] of [...state.runs]) {
    const runTurnNodeHashes = [
      run.startTurnNodeHash,
      ...decodeRunCreatedTurnNodeHashes(run),
    ];
    const retained =
      keepTurnIds.has(run.turnId) &&
      runTurnNodeHashes.every((hash) => keepTurnNodes.has(hash));
    if (!retained) {
      state.runs.delete(runId);
      state.stagedResults.delete(runId);
      state.observeAnnotations.delete(runId);
      released += 1;
    }
  }
  return released;
}

function sweepTurns(state: BackendState, keepTurnIds: Set<string>): number {
  let released = 0;
  for (const turnId of [...state.turns.keys()]) {
    if (!keepTurnIds.has(turnId)) {
      state.turns.delete(turnId);
      released += 1;
    }
  }
  return released;
}

function sweepArchivedBranches(
  state: BackendState,
  keepTurnNodes: Set<string>
): number {
  let released = 0;
  for (const [branchId, branch] of [...state.branches]) {
    if (
      branch.archivedFromBranchId !== undefined &&
      !keepTurnNodes.has(branch.headTurnNodeHash)
    ) {
      state.branches.delete(branchId);
      released += 1;
    }
  }
  return released;
}

function sweepTurnNodes(
  state: BackendState,
  keepTurnNodes: Set<string>,
  graceHorizonMs: number
): number {
  let released = 0;
  for (const [hash, turnNode] of [...state.turnNodes]) {
    if (!keepTurnNodes.has(hash) && turnNode.createdAtMs < graceHorizonMs) {
      state.turnNodes.delete(hash);
      released += 1;
    }
  }
  return released;
}

function sweepTurnTrees(
  state: BackendState,
  keepTurnTrees: Set<string>,
  graceHorizonMs: number
): number {
  let released = 0;
  for (const [hash, turnTree] of [...state.turnTrees]) {
    if (!keepTurnTrees.has(hash) && turnTree.createdAtMs < graceHorizonMs) {
      state.turnTrees.delete(hash);
      state.turnTreePaths.delete(hash);
      released += 1;
    }
  }
  return released;
}

function sweepChunks(
  state: BackendState,
  keepChunks: Set<string>,
  graceHorizonMs: number
): number {
  let released = 0;
  for (const [hash, chunk] of [...state.orderedPathChunks]) {
    if (!keepChunks.has(hash) && chunk.createdAtMs < graceHorizonMs) {
      state.orderedPathChunks.delete(hash);
      released += 1;
    }
  }
  return released;
}

function sweepObjects(
  state: BackendState,
  keepObjects: Set<string>,
  graceHorizonMs: number
): number {
  let released = 0;
  for (const [hash, object] of [...state.objects]) {
    if (!keepObjects.has(hash) && object.createdAtMs < graceHorizonMs) {
      state.objects.delete(hash);
      released += 1;
    }
  }
  return released;
}

function isActiveRun(status: string): boolean {
  return status === "running" || status === "paused";
}
