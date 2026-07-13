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

import type { EpochMs } from "@tuvren/core";
import type {
  ReclamationSummary,
  StoredRun,
  StoredTurnNode,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import {
  isExpiredLeaselessRunningRun,
  LEASELESS_RUN_EXPIRY_MS,
} from "./backend-invariant-record-utils.js";
import type { BackendState } from "./backend-invariant-state.js";

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
 * Backend-owned hash/lineage decode helpers the reclamation algorithm below
 * depends on. These stay local to each backend (they are not part of this
 * extraction, since they live in each backend's own lineage/turn-tree
 * modules) and are threaded through explicitly rather than imported, because
 * this shared module has no access to any single backend's lineage file.
 *
 * This module raises no backend-prefixed errors of its own, so — unlike
 * record-utils and run-logic — it needs no error-code parameterization and
 * is exported as plain functions taking `deps` explicitly instead of as a
 * `create...` factory.
 */
export interface BackendInvariantReclamationDeps {
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
 * Realizes the §9.4 reachability reclamation primitive shared by the
 * memory, SQLite, and PostgreSQL backends. It mutates `state` in place,
 * deleting only durable state that is unreachable from live roots AND
 * older than the grace horizon. The caller is responsible for running this
 * against a draft state inside a serialized transaction and validating the
 * committed result.
 *
 * The sweep is referentially closed by construction: the keep set is the
 * reference closure of (live roots ∪ everything created at/after the grace
 * horizon), so every retained record only references other retained records
 * and the committed-state invariants hold after deletion.
 *
 * `nowMs` is the caller-supplied wall-clock reference (ADR-050/ADR-051,
 * KRT-BK002) used only to decide whether a leaseless running run has gone
 * quiet long enough to be excluded from pinning the grace horizon; it never
 * changes which records are reachable.
 */
export function reclaimBackendState(
  state: BackendState,
  deps: BackendInvariantReclamationDeps,
  nowMs: EpochMs,
  leaselessRunExpiryMs: number = LEASELESS_RUN_EXPIRY_MS
): ReclamationSummary {
  const graceHorizonMs = computeGraceHorizonMs(
    state,
    nowMs,
    leaselessRunExpiryMs
  );
  const keep = computeKeepClosure(state, graceHorizonMs, deps);
  const keepTurnIds = collectKeptTurnIds(state, keep.turnNodes);
  return sweep(state, keep, keepTurnIds, graceHorizonMs, deps);
}

/**
 * The grace horizon is the createdAtMs of the oldest active execution (running
 * or paused run) — the conservative in-flight write horizon. No durable state
 * created at or after this instant is released, so reclamation can never race a
 * live execution's checkpoint or recovery. With no active execution there is no
 * in-flight horizon, so everything unreachable is releasable.
 *
 * A leaseless running run (no executionOwnerId/fencingToken/leaseExpiresAtMs)
 * whose updatedAtMs has gone quiet for at least leaselessRunExpiryMs is
 * excluded from pinning this horizon: it is treated as abandoned by a
 * crashed/disconnected creator, so it no longer blocks reclamation of state
 * created after it. The run's own reachable lineage stays fully protected
 * regardless, via seedActiveRunRoots's independent isActiveRun(status) check —
 * excluding a run from the horizon pin never affects that run's own retained
 * state, only whether *other*, unrelated state created after it is releasable.
 */
function computeGraceHorizonMs(
  state: BackendState,
  nowMs: EpochMs,
  leaselessRunExpiryMs: number
): number {
  let graceHorizonMs = Number.POSITIVE_INFINITY;
  for (const run of state.runs.values()) {
    if (
      isActiveRun(run.status) &&
      !isExpiredLeaselessRunningRun(run, nowMs, leaselessRunExpiryMs) &&
      run.createdAtMs < graceHorizonMs
    ) {
      graceHorizonMs = run.createdAtMs;
    }
  }
  return graceHorizonMs;
}

/**
 * Builds the full keep set: seed live roots and grace-window roots, then close
 * over turn-node ancestry and turn-tree manifests so the set is referentially
 * complete before any deletion decision is made.
 */
function computeKeepClosure(
  state: BackendState,
  graceHorizonMs: number,
  deps: BackendInvariantReclamationDeps
): KeepClosure {
  const keep: KeepClosure = {
    chunks: new Set(),
    objects: new Set(),
    turnNodes: new Set(),
    turnTrees: new Set(),
  };
  const turnNodeStack: string[] = [];
  const turnTreeStack: string[] = [];

  seedLiveRoots(state, turnNodeStack, keep, deps);
  seedGraceRoots(state, graceHorizonMs, turnNodeStack, turnTreeStack, keep);
  closeTurnNodeReachability(state, keep, turnNodeStack, turnTreeStack, deps);
  closeTurnTreeReachability(state, keep, turnTreeStack, deps);

  return keep;
}

/** Live roots: non-archived branch heads, thread roots, active-run staged work. */
function seedLiveRoots(
  state: BackendState,
  turnNodeStack: string[],
  keep: KeepClosure,
  deps: BackendInvariantReclamationDeps
): void {
  for (const branch of state.branches.values()) {
    if (branch.archivedFromBranchId === undefined) {
      turnNodeStack.push(branch.headTurnNodeHash);
    }
  }
  for (const thread of state.threads.values()) {
    turnNodeStack.push(thread.rootTurnNodeHash);
  }
  seedActiveRunRoots(state, turnNodeStack, keep, deps);
}

/** Active-run roots: start/created turn nodes and staged results for running or paused runs. */
function seedActiveRunRoots(
  state: BackendState,
  turnNodeStack: string[],
  keep: KeepClosure,
  deps: BackendInvariantReclamationDeps
): void {
  for (const run of state.runs.values()) {
    if (isActiveRun(run.status)) {
      turnNodeStack.push(run.startTurnNodeHash);
      for (const hash of deps.decodeRunCreatedTurnNodeHashes(run)) {
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
 * Grace-window roots: any durable state newer than the oldest active
 * execution lease is retained, and its reference closure is retained with it
 * so a kept record can never reference a swept one.
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
  turnTreeStack: string[],
  deps: BackendInvariantReclamationDeps
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
    for (const objectHash of deps.decodeTurnNodeConsumedStagedResultObjectHashes(
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
  turnTreeStack: string[],
  deps: BackendInvariantReclamationDeps
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
      keepPathObjects(state, storedPath, keep, deps);
    }
  }
}

/**
 * Retains every object hash a turn-tree path resolves to, plus the chunk
 * hashes backing a chunked ordered path's chunk list.
 */
function keepPathObjects(
  state: BackendState,
  storedPath: StoredTurnTreePath,
  keep: KeepClosure,
  deps: BackendInvariantReclamationDeps
): void {
  const resolved = deps.resolveStoredTurnTreePathValue(state, storedPath);
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
    for (const chunkHash of deps.decodeHashStringArray(
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
  graceHorizonMs: number,
  deps: BackendInvariantReclamationDeps
): ReclamationSummary {
  return {
    releasedArchivedBranchCount: sweepArchivedBranches(state, keep.turnNodes),
    releasedObjectCount: sweepObjects(state, keep.objects, graceHorizonMs),
    releasedOrderedPathChunkCount: sweepChunks(
      state,
      keep.chunks,
      graceHorizonMs
    ),
    releasedRunCount: sweepRuns(state, keep.turnNodes, keepTurnIds, deps),
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

/**
 * A run is retained iff its turn is retained AND every turn node it references
 * (start node plus created lineage) is retained; releasing a run also drops
 * its staged results and observe annotations.
 */
function sweepRuns(
  state: BackendState,
  keepTurnNodes: Set<string>,
  keepTurnIds: Set<string>,
  deps: BackendInvariantReclamationDeps
): number {
  let released = 0;
  for (const [runId, run] of [...state.runs]) {
    const runTurnNodeHashes = [
      run.startTurnNodeHash,
      ...deps.decodeRunCreatedTurnNodeHashes(run),
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

/**
 * Only archived branches are ever swept (live branch heads are keep-closure
 * roots), and only when their head turn node was not retained.
 */
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

/** Running and paused runs are the active executions that pin reclamation. */
function isActiveRun(status: string): boolean {
  return status === "running" || status === "paused";
}
