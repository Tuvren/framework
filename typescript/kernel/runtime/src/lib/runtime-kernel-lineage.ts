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
  type EpochMs,
  type HashString,
  type KernelObject,
  type KernelRecord,
  TuvrenLineageError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
import {
  assertObserveResult,
  assertPathValueForCollectionKind,
  assertStagedResult,
  assertStepDeclaration,
  hashKernelRecord,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
  type ModifyVerdict,
  type RunRecord,
  type RuntimeBackend,
  type RuntimeBackendTx,
  type StagedResult,
  type StepDeclaration,
  type StoredBranch,
  type StoredRun,
  type TurnNode,
  type TurnRecord,
  type TurnTreeChangeSet,
  type TurnTreeManifest,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  decodeHashArray,
  decodeStoredRun,
  decodeStoredTurnNode,
  encodeRecord,
  normalizeManifest,
  requireBranch,
  requireSchema,
  requireStoredTurn,
  requireTreeManifest,
  requireTurnNode,
  requireTurnTree,
  toStoredTurnTreePathChunkAware,
} from "./runtime-kernel-storage.js";

/**
 * Merges the `"modify"` verdicts out of a hook-result set into a single
 * {@link ModifyVerdict} (kernel spec §6): zero modify verdicts return
 * `undefined`, exactly one is returned as-is, and more than one has its
 * transforms collected into an array in encounter order. Verdicts other
 * than `"modify"` are ignored — priority ordering against them is handled by
 * the `verdicts.compose` caller.
 */
export function composeModifyVerdict(
  verdicts: ReadonlyArray<{ kind: string; transform?: KernelRecord }>
): ModifyVerdict | undefined {
  const modifyTransforms = verdicts
    .filter(
      (verdict): verdict is { kind: "modify"; transform: KernelRecord } =>
        verdict.kind === "modify"
    )
    .map((verdict) => verdict.transform);

  if (modifyTransforms.length === 0) {
    return undefined;
  }

  if (modifyTransforms.length === 1) {
    return {
      kind: "modify",
      transform: modifyTransforms[0],
    };
  }

  return {
    kind: "modify",
    transform: modifyTransforms,
  };
}

/**
 * Backs the public `node.walkBack` syscall (kernel spec §3.3): yields
 * TurnNodes from `fromHash` back toward the thread root, following
 * `previousTurnNodeHash` links one transaction per step.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn_node`
 *   when no node exists at `fromHash`.
 */
export async function* walkBack(
  backend: RuntimeBackend,
  fromHash: HashString
): AsyncIterable<TurnNode> {
  const first = await backend.transact(async (tx) =>
    tx.turnNodes.get(fromHash)
  );

  if (first === null) {
    throw new TuvrenRuntimeError(`unknown turn node "${fromHash}"`, {
      code: "kernel_runtime_missing_turn_node",
    });
  }

  let currentHash: HashString | null = fromHash;

  while (currentHash !== null) {
    const hash = currentHash;
    const node = await backend.transact(async (tx) => {
      const stored = await tx.turnNodes.get(hash);
      return stored === null ? null : decodeStoredTurnNode(stored);
    });

    if (node === null) {
      return;
    }

    yield node;
    currentHash = node.previousTurnNodeHash;
  }
}

/**
 * In-transaction counterpart to {@link walkBack}: yields TurnNodes from
 * `fromHash` back toward the thread root using an already-open
 * {@link RuntimeBackendTx}, for callers that need the walk inside a larger
 * atomic operation (head movement classification, lineage checks).
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn_node`
 *   when the walk reaches a hash with no corresponding node.
 */
export async function* walkBackFromTx(
  tx: RuntimeBackendTx,
  fromHash: HashString
): AsyncIterable<TurnNode> {
  let currentHash: HashString | null = fromHash;

  while (currentHash !== null) {
    const node = await requireTurnNode(tx, currentHash);
    yield node;
    currentHash = node.previousTurnNodeHash;
  }
}

/**
 * Classifies a proposed `branch.setHead` move against the TurnNode DAG
 * (kernel spec §4.2): `"forward"` when `currentHead` is an ancestor of
 * `targetHash`, `"backward"` when `targetHash` is an ancestor of
 * `currentHead`, and `"lateral"` when neither walk finds the other — a
 * lateral move is always rejected by the caller.
 */
export async function classifyHeadMovement(
  tx: RuntimeBackendTx,
  currentHead: HashString,
  targetHash: HashString
): Promise<"forward" | "backward" | "lateral"> {
  for await (const node of walkBackFromTx(tx, targetHash)) {
    if (node.hash === currentHead) {
      return "forward";
    }
  }

  for await (const node of walkBackFromTx(tx, currentHead)) {
    if (node.hash === targetHash) {
      return "backward";
    }
  }

  return "lateral";
}

/**
 * Asserts `branch` has no `running` or `paused` run before its head is moved
 * forward — a forward move while a run is active would strand the run's
 * lineage assumptions.
 *
 * @throws TuvrenRuntimeError With code
 *   `kernel_runtime_branch_has_active_run`.
 */
export async function assertNoActiveBranchRunForForwardHeadMove(
  tx: RuntimeBackendTx,
  branch: StoredBranch
): Promise<void> {
  const branchRuns = await tx.runs.listByBranch(branch.branchId);
  const activeRun = branchRuns.find(
    (storedRun) =>
      storedRun.status === "running" || storedRun.status === "paused"
  );

  if (activeRun === undefined) {
    return;
  }

  throw new TuvrenRuntimeError(
    `branch "${branch.branchId}" cannot move head while run "${activeRun.runId}" is active`,
    { code: "kernel_runtime_branch_has_active_run" }
  );
}

/**
 * Collects the TurnNode hashes between `currentHead` and its ancestor
 * `targetHash` (exclusive of `targetHash`), the segment a backward
 * `branch.setHead` move abandons and archives.
 *
 * @throws TuvrenLineageError With code
 *   `kernel_runtime_backward_lineage_mismatch` when `targetHash` is not an
 *   ancestor of `currentHead`.
 */
export async function collectAbandonedSegmentHashes(
  tx: RuntimeBackendTx,
  currentHead: HashString,
  targetHash: HashString
): Promise<Set<HashString>> {
  const hashes = new Set<HashString>();

  for await (const node of walkBackFromTx(tx, currentHead)) {
    if (node.hash === targetHash) {
      return hashes;
    }

    hashes.add(node.hash);
  }

  throw new TuvrenLineageError(
    `target "${targetHash}" is not an ancestor of current head "${currentHead}"`,
    { code: "kernel_runtime_backward_lineage_mismatch" }
  );
}

/**
 * Allocates a fresh branch id for the archive branch a backward
 * `branch.setHead` move creates to preserve the abandoned segment, probing
 * `${branchId}-archive-${ordinal}-${currentHead prefix}` starting at
 * `input.initialOrdinal` and incrementing past any collision.
 */
export async function allocateArchiveBranchId(
  tx: RuntimeBackendTx,
  input: {
    branchId: string;
    currentHead: HashString;
    initialOrdinal: number;
  }
): Promise<string> {
  let ordinal = input.initialOrdinal;

  while (true) {
    const candidate = `${input.branchId}-archive-${ordinal}-${input.currentHead.slice(0, 16)}`;
    const existing = await tx.branches.get(candidate);

    if (existing === null) {
      return candidate;
    }

    ordinal += 1;
  }
}

/**
 * True when `run`'s start node or any TurnNode it created falls within
 * `segmentHashes` — used to find runs a backward `branch.setHead` move must
 * fail because they touch the abandoned segment.
 */
export function runTouchesSegment(
  run: StoredRun,
  segmentHashes: ReadonlySet<HashString>
): boolean {
  if (segmentHashes.has(run.startTurnNodeHash)) {
    return true;
  }

  for (const hash of decodeHashArray(run.createdTurnNodesCbor)) {
    if (segmentHashes.has(hash)) {
      return true;
    }
  }

  return false;
}

/**
 * The most recent TurnNode a run has produced: its last created TurnNode, or
 * its `startTurnNodeHash` if it has not yet checkpointed.
 */
export function getLastRunTurnNodeHash(run: RunRecord): HashString {
  return run.createdTurnNodes.at(-1) ?? run.startTurnNodeHash;
}

/**
 * {@link getLastRunTurnNodeHash}, operating on a durable {@link StoredRun}
 * row without first decoding it into a {@link RunRecord}.
 */
export function getLastRunTurnNodeHashFromStoredRun(
  run: StoredRun
): HashString {
  return (
    decodeHashArray(run.createdTurnNodesCbor).at(-1) ?? run.startTurnNodeHash
  );
}

/**
 * True when a lease expiring at `leaseExpiresAtMs` has expired as of
 * `nowMs` (kernel spec §5.2): expiry is inclusive, so a lease expires
 * exactly at its expiry timestamp.
 */
export function isLeaseExpired(
  leaseExpiresAtMs: EpochMs,
  nowMs: EpochMs
): boolean {
  return leaseExpiresAtMs <= nowMs;
}

/**
 * True when `candidateHash` descends from `ancestorHash` on the TurnNode
 * lineage DAG, walking back from `candidateHash`.
 */
export async function turnNodeDescendsFrom(
  tx: RuntimeBackendTx,
  candidateHash: HashString,
  ancestorHash: HashString
): Promise<boolean> {
  for await (const node of walkBackFromTx(tx, candidateHash)) {
    if (node.hash === ancestorHash) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a new turn's `parentTurnId` against `turn.create`'s legality
 * rules (kernel spec §5.3, Appendix A): a turn starting at a node no earlier
 * turn's head reaches needs no parent, while a turn starting where a previous
 * turn's head landed must name the immediately preceding turn on the same
 * branch as its parent.
 *
 * @throws TuvrenLineageError With code `kernel_runtime_turn_parent_required`,
 *   `kernel_runtime_turn_parent_thread_mismatch`,
 *   `kernel_runtime_turn_parent_start_mismatch`, or
 *   `kernel_runtime_turn_parent_not_immediate_predecessor` depending on
 *   which rule is violated.
 */
export async function validateTurnParent(
  tx: RuntimeBackendTx,
  threadId: string,
  branchId: string,
  parentTurnId: string | null,
  startTurnNodeHash: HashString
): Promise<void> {
  const candidateTurnsAtStart = (await tx.turns.listByThread(threadId)).filter(
    (candidateTurn) => candidateTurn.headTurnNodeHash === startTurnNodeHash
  );
  const sameBranchCandidateTurns = candidateTurnsAtStart.filter(
    (candidateTurn) => candidateTurn.branchId === branchId
  );
  const immediatelyPreviousSameBranchTurn = sameBranchCandidateTurns.at(-1);

  if (parentTurnId === null) {
    if (candidateTurnsAtStart.length === 0) {
      return;
    }

    throw new TuvrenLineageError(
      `turn on branch "${branchId}" must reference the previous semantic turn at "${startTurnNodeHash}"`,
      { code: "kernel_runtime_turn_parent_required" }
    );
  }

  const parentTurn = await requireStoredTurn(tx, parentTurnId);

  if (parentTurn.threadId !== threadId) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" does not belong to thread "${threadId}"`,
      { code: "kernel_runtime_turn_parent_thread_mismatch" }
    );
  }

  if (parentTurn.headTurnNodeHash !== startTurnNodeHash) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" does not chain into start node "${startTurnNodeHash}"`,
      { code: "kernel_runtime_turn_parent_start_mismatch" }
    );
  }

  if (sameBranchCandidateTurns.length === 0) {
    return;
  }

  if (parentTurn.branchId !== branchId) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" is not the immediately previous turn on branch "${branchId}"`,
      { code: "kernel_runtime_turn_parent_not_immediate_predecessor" }
    );
  }

  if (
    immediatelyPreviousSameBranchTurn === undefined ||
    immediatelyPreviousSameBranchTurn.turnId !== parentTurn.turnId
  ) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" is not the immediately previous turn on branch "${branchId}"`,
      { code: "kernel_runtime_turn_parent_not_immediate_predecessor" }
    );
  }
}

/**
 * Asserts a `turn.updateHead` rewrite does not strand dependents: no active
 * (`running`/`paused`) run on `turn` may sit at a different TurnNode than
 * `nextHeadTurnNodeHash`, and no other turn that names `turn` as its parent
 * may start anywhere but `nextHeadTurnNodeHash`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_turn_has_active_run`.
 * @throws TuvrenLineageError With code
 *   `kernel_runtime_turn_head_has_dependent_turns`.
 */
export async function assertTurnHeadRewritePreservesDependents(
  tx: RuntimeBackendTx,
  turn: TurnRecord,
  nextHeadTurnNodeHash: HashString
): Promise<void> {
  const branchRuns = await tx.runs.listByBranch(turn.branchId);

  for (const storedRun of branchRuns) {
    if (
      storedRun.turnId === turn.turnId &&
      (storedRun.status === "running" || storedRun.status === "paused")
    ) {
      const activeTurnNodeHash = getLastRunTurnNodeHash(
        decodeStoredRun(storedRun)
      );

      if (activeTurnNodeHash !== nextHeadTurnNodeHash) {
        throw new TuvrenRuntimeError(
          `turn "${turn.turnId}" cannot rewrite head while run "${storedRun.runId}" is active`,
          { code: "kernel_runtime_turn_has_active_run" }
        );
      }
    }
  }

  const turnsInThread = await tx.turns.listByThread(turn.threadId);

  for (const dependentTurn of turnsInThread) {
    if (
      dependentTurn.turnId !== turn.turnId &&
      dependentTurn.parentTurnId === turn.turnId &&
      dependentTurn.startTurnNodeHash !== nextHeadTurnNodeHash
    ) {
      throw new TuvrenLineageError(
        `turn "${turn.turnId}" cannot rewrite head past dependent turn "${dependentTurn.turnId}"`,
        { code: "kernel_runtime_turn_head_has_dependent_turns" }
      );
    }
  }
}

/**
 * Declarative checkpoint predicate for `run.completeStep` (kernel spec
 * §5.8): a step checkpoints when it produced a `treeHash` or staged results,
 * or when it is non-deterministic or has side effects — a plain
 * deterministic, side-effect-free step with nothing staged skips the
 * checkpoint.
 */
export function stepRequiresCheckpoint(
  step: StepDeclaration,
  stagedResults: StagedResult[],
  treeHash: HashString | undefined
): boolean {
  return (
    treeHash !== undefined ||
    stagedResults.length > 0 ||
    !step.deterministic ||
    step.sideEffects
  );
}

/**
 * Asserts `run` is in `"running"` status.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_run_not_running`.
 */
export function requireRunningRun(run: RunRecord, runId: string): void {
  if (run.status !== "running") {
    throw new TuvrenRuntimeError(
      `run "${runId}" is not in running state (status: ${run.status})`,
      { code: "kernel_runtime_run_not_running" }
    );
  }
}

/**
 * Looks up the run's step at `run.currentStepIndex` and asserts it matches
 * `stepId` — `beginStep`/`completeStep` must always target the run's next
 * declared step, never skip ahead or repeat.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_unexpected_step` when
 *   `stepId` does not match the current step.
 */
export function requireCurrentStep(
  run: RunRecord,
  stepId: string
): StepDeclaration {
  const step = run.stepSequence[run.currentStepIndex];

  if (step === undefined || step.id !== stepId) {
    throw new TuvrenRuntimeError(`unexpected step "${stepId}"`, {
      code: "kernel_runtime_unexpected_step",
    });
  }

  return step;
}

/**
 * Asserts an optional `eventHash` already exists in the object store; a
 * `run.completeStep`/`run.complete` caller must stage the event's bytes via
 * `store.put` or `staging.stage` before referencing them.
 *
 * @throws TuvrenValidationError With code
 *   `kernel_runtime_missing_event_object` when `eventHash` is set but not
 *   found.
 */
export async function assertEventHashInStore(
  tx: RuntimeBackendTx,
  eventHash: HashString | undefined
): Promise<void> {
  if (eventHash === undefined) {
    return;
  }

  const hasObject = await tx.objects.has(eventHash);

  if (!hasObject) {
    throw new TuvrenValidationError(
      `event hash "${eventHash}" does not exist in store`,
      { code: "kernel_runtime_missing_event_object" }
    );
  }
}

/**
 * Asserts an optional caller-supplied `treeHash` (from `run.completeStep`)
 * both exists and was built against `schemaId` — a step must not check
 * itself into a tree from a foreign schema.
 *
 * @throws TuvrenValidationError With code `kernel_runtime_missing_tree` when
 *   `treeHash` is set but not found, or
 *   `kernel_runtime_tree_schema_mismatch` when its schema differs.
 */
export async function assertTreeHashForRun(
  tx: RuntimeBackendTx,
  treeHash: HashString | undefined,
  schemaId: string
): Promise<void> {
  if (treeHash === undefined) {
    return;
  }

  const tree = await tx.turnTrees.get(treeHash);

  if (tree === null) {
    throw new TuvrenValidationError(`tree hash "${treeHash}" does not exist`, {
      code: "kernel_runtime_missing_tree",
    });
  }

  if (tree.schemaId !== schemaId) {
    throw new TuvrenValidationError(
      `tree hash "${treeHash}" uses schema "${tree.schemaId}" but run uses schema "${schemaId}"`,
      { code: "kernel_runtime_tree_schema_mismatch" }
    );
  }
}

/**
 * Flattens the `signals` arrays across a step's ObserveResults and
 * CBOR-encodes them for the run's `pendingSignalsCbor` field, or returns
 * `undefined` when there are no signals to persist (leaving any existing
 * pending signals untouched).
 */
export function encodeSignalsCborFromObserveResults(
  observeResults: { signals: KernelRecord[] }[] | undefined
): Uint8Array | undefined {
  const newSignals: KernelRecord[] =
    observeResults?.flatMap((result) => result.signals) ?? [];

  if (newSignals.length === 0) {
    return undefined;
  }

  return encodeRecord(newSignals);
}

/**
 * Builds durable observe-annotation records from a step's ObserveResults,
 * CBOR-encoding and hashing each annotation. Returns an empty array when
 * there are no annotations, so callers can unconditionally spread the
 * result into `tx.observeAnnotations.set` calls.
 */
export async function createObserveAnnotationRecords(input: {
  now: () => EpochMs;
  observeResults: { annotations: KernelObject[] }[] | undefined;
  runId: string;
  turnNodeHash: HashString | null;
}): Promise<
  Array<{
    annotationCbor: Uint8Array;
    annotationHash: HashString;
    createdAtMs: EpochMs;
    runId: string;
    turnNodeHash: HashString | null;
  }>
> {
  const annotations: KernelObject[] =
    input.observeResults?.flatMap((result) => result.annotations) ?? [];

  if (annotations.length === 0) {
    return [];
  }

  const createdAtMs = input.now();
  const records: Array<{
    annotationCbor: Uint8Array;
    annotationHash: HashString;
    createdAtMs: EpochMs;
    runId: string;
    turnNodeHash: HashString | null;
  }> = [];

  for (const annotation of annotations) {
    const annotationCbor = encodeRecord(annotation);
    records.push({
      annotationCbor,
      annotationHash: await hashKernelRecord(annotation),
      createdAtMs,
      runId: input.runId,
      turnNodeHash: input.turnNodeHash,
    });
  }

  return records;
}

/**
 * Validates each element of an optional `observeResults` array as a
 * structurally valid ObserveResult, a no-op when `observeResults` is
 * `undefined`.
 *
 * @throws TuvrenValidationError When an element is not a valid ObserveResult.
 */
export function validateObserveResults(
  observeResults: unknown[] | undefined
): void {
  if (observeResults === undefined) {
    return;
  }

  for (const [index, observeResult] of observeResults.entries()) {
    assertObserveResult(observeResult, `observeResults[${index}]`);
  }
}

/**
 * Validates each of `run.create`'s step declarations and asserts their `id`s
 * are unique within the sequence.
 *
 * @throws TuvrenValidationError With code `kernel_runtime_duplicate_step_id`
 *   when two steps share an `id`.
 */
export function assertUniqueStepIds(steps: StepDeclaration[]): void {
  const seen = new Set<string>();

  for (const [index, step] of steps.entries()) {
    assertStepDeclaration(step, `steps[${index}]`);

    if (seen.has(step.id)) {
      throw new TuvrenValidationError(
        `duplicate step id "${step.id}" in run step sequence`,
        { code: "kernel_runtime_duplicate_step_id" }
      );
    }

    seen.add(step.id);
  }
}

/**
 * Validates a caller-supplied {@link TurnTreeChangeSet} against `schema`:
 * every path in `changes` must be schema-declared, and each value must match
 * its path's collection kind.
 *
 * @throws TuvrenValidationError With code `kernel_runtime_unknown_tree_path`
 *   for an undeclared path, or `invalid_path_value_kind` (from
 *   {@link assertPathValueForCollectionKind}) for a mismatched value.
 */
export function validateTurnTreeChangeSet(
  schema: TurnTreeSchema,
  changes: TurnTreeChangeSet
): void {
  const pathsByName = new Map(
    schema.paths.map((pathDefinition) => [pathDefinition.path, pathDefinition])
  );

  for (const [path, value] of Object.entries(changes)) {
    const pathDefinition = pathsByName.get(path);

    if (pathDefinition === undefined) {
      throw new TuvrenValidationError(
        `unknown path "${path}" in schema "${schema.schemaId}"`,
        { code: "kernel_runtime_unknown_tree_path" }
      );
    }

    assertPathValueForCollectionKind(
      value,
      pathDefinition.collection,
      `changes.${path}`
    );
  }
}

/**
 * Validates each staged result and asserts its `objectType` has a matching
 * incorporation rule in `schema` (kernel spec Appendix B) — an unmatched
 * object type would have nowhere to land when incorporated into a tree.
 *
 * @throws TuvrenValidationError With code
 *   `kernel_runtime_unmatched_incorporation_rule` when a result's
 *   `objectType` has no rule.
 */
export function validateStagedResultsHaveRules(
  schema: TurnTreeSchema,
  stagedResults: StagedResult[]
): void {
  const objectTypesWithRules = new Set(
    schema.incorporationRules.map((rule) => rule.objectType)
  );

  for (const [index, stagedResult] of stagedResults.entries()) {
    assertStagedResult(stagedResult, `stagedResults[${index}]`);

    if (!objectTypesWithRules.has(stagedResult.objectType)) {
      throw new TuvrenValidationError(
        `no incorporation rule for objectType "${stagedResult.objectType}" in schema "${schema.schemaId}"`,
        { code: "kernel_runtime_unmatched_incorporation_rule" }
      );
    }
  }
}

/**
 * Applies staged results onto `manifest` in place, per `schema`'s
 * incorporation rules: an ordered target path appends the result's object
 * hash, a single target path replaces the value outright. Assumes
 * {@link validateStagedResultsHaveRules} already confirmed every result has
 * a rule; still throws defensively if one is missing.
 *
 * @throws TuvrenValidationError With code
 *   `kernel_runtime_unmatched_incorporation_rule`.
 */
export function applyStagedResultsToManifest(
  schema: TurnTreeSchema,
  manifest: TurnTreeManifest,
  stagedResults: StagedResult[]
): void {
  const rulesByObjectType = new Map(
    schema.incorporationRules.map((rule) => [rule.objectType, rule])
  );
  const pathsByName = new Map(
    schema.paths.map((pathDefinition) => [pathDefinition.path, pathDefinition])
  );

  for (const stagedResult of stagedResults) {
    const rule = rulesByObjectType.get(stagedResult.objectType);

    if (rule === undefined) {
      throw new TuvrenValidationError(
        `no incorporation rule for objectType "${stagedResult.objectType}" in schema "${schema.schemaId}"`,
        { code: "kernel_runtime_unmatched_incorporation_rule" }
      );
    }

    const pathDefinition = pathsByName.get(rule.targetPath);

    if (pathDefinition?.collection === "ordered") {
      const current = manifest[rule.targetPath];
      manifest[rule.targetPath] = [
        ...(Array.isArray(current) ? current : []),
        stagedResult.objectHash,
      ];
    } else {
      manifest[rule.targetPath] = stagedResult.objectHash;
    }
  }
}

/**
 * Reactive checkpoint for `run.complete` (kernel spec §5.8): checkpoints and
 * clears un-anchored staged work only when there is something to anchor
 * (staged results or an event), returning `undefined` and leaving durable
 * state untouched otherwise. Unlike {@link checkpointAndClear}, `treeHash`
 * is always `undefined` here — completion never accepts a caller-supplied
 * tree.
 */
export async function maybeCheckpoint(
  tx: RuntimeBackendTx,
  run: RunRecord,
  stagedResults: StagedResult[],
  input: {
    eventHash: HashString | null;
    now: () => EpochMs;
    treeHash: undefined;
  }
): Promise<HashString | undefined> {
  if (stagedResults.length === 0 && input.eventHash === null) {
    return undefined;
  }

  const hash = await checkpointRun(tx, { ...input, run, stagedResults });
  await tx.stagedResults.clearRun(run.runId);
  return hash;
}

/**
 * Declarative checkpoint for `run.completeStep` (kernel spec §5.8): always
 * checkpoints (see {@link stepRequiresCheckpoint} for the caller's decision
 * of when to invoke this) and clears the run's staged work. Unlike
 * {@link maybeCheckpoint}, `input.treeHash` may be supplied to check the run
 * into a caller-precomputed tree instead of one derived from its staged
 * results.
 */
export async function checkpointAndClear(
  tx: RuntimeBackendTx,
  run: RunRecord,
  stagedResults: StagedResult[],
  input: {
    eventHash: HashString | null;
    now: () => EpochMs;
    treeHash?: HashString;
  }
): Promise<HashString> {
  const hash = await checkpointRun(tx, { ...input, run, stagedResults });
  await tx.stagedResults.clearRun(run.runId);
  return hash;
}

/**
 * Shared checkpoint mechanics behind {@link maybeCheckpoint} and
 * {@link checkpointAndClear}: derives (or accepts) the checkpoint's turn
 * tree, creates a new TurnNode chained onto the branch's current head, and
 * advances both the branch head and the run's turn head to it. Does not
 * clear the run's staged work — callers are responsible for that.
 */
export async function checkpointRun(
  tx: RuntimeBackendTx,
  input: {
    eventHash: HashString | null;
    now: () => EpochMs;
    run: RunRecord;
    stagedResults: StagedResult[];
    treeHash?: HashString;
  }
): Promise<HashString> {
  const branch = await requireBranch(tx, input.run.branchId);
  const baseTurnNode = await requireTurnNode(tx, branch.headTurnNodeHash);
  const turnTreeHash =
    input.treeHash ??
    (await createIncorporatedTree(tx, baseTurnNode.turnTreeHash, input));
  const turnNodeHash = await createTurnNode(tx, {
    consumedStagedResults: input.stagedResults,
    eventHash: input.eventHash,
    now: input.now,
    previousTurnNodeHash: branch.headTurnNodeHash,
    schemaId: input.run.schemaId,
    turnTreeHash,
  });
  await tx.branches.set({
    ...branch,
    headTurnNodeHash: turnNodeHash,
    updatedAtMs: input.now(),
  });
  await tx.turns.set({
    ...(await requireStoredTurn(tx, input.run.turnId)),
    headTurnNodeHash: turnNodeHash,
    updatedAtMs: input.now(),
  });
  return turnNodeHash;
}

/**
 * Builds the turn tree a checkpoint anchors to: incorporates `input`'s
 * staged results onto `baseTurnTreeHash`'s manifest per the run's schema
 * incorporation rules, mirroring the public `tree.incorporate` syscall but
 * for the run's own schema and base tree.
 *
 * @throws TuvrenValidationError With code
 *   `kernel_runtime_tree_schema_mismatch` when the base tree's schema
 *   differs from the run's schema.
 */
export async function createIncorporatedTree(
  tx: RuntimeBackendTx,
  baseTurnTreeHash: HashString,
  input: {
    now: () => EpochMs;
    run: RunRecord;
    stagedResults: StagedResult[];
  }
): Promise<HashString> {
  const baseTree = await requireTurnTree(tx, baseTurnTreeHash);
  const schema = await requireSchema(tx, input.run.schemaId);

  if (baseTree.schemaId !== input.run.schemaId) {
    throw new TuvrenValidationError(
      `base tree schema "${baseTree.schemaId}" does not match run schema "${input.run.schemaId}"`,
      { code: "kernel_runtime_tree_schema_mismatch" }
    );
  }

  validateStagedResultsHaveRules(schema, input.stagedResults);
  const manifest = await requireTreeManifest(tx, baseTree.hash);
  applyStagedResultsToManifest(schema, manifest, input.stagedResults);

  return await createTurnTree(tx, {
    changes: manifest,
    now: input.now,
    priorTurnTreeHash: baseTurnTreeHash,
    schema,
  });
}

/**
 * Content-addressed TurnTree write (kernel spec §3.2): normalizes `changes`
 * against `input.schema`, computes the tree's identity hash, and returns the
 * existing hash unchanged if a tree with that identity is already stored
 * (deduplication), otherwise persisting the manifest and its per-path rows.
 */
export async function createTurnTree(
  tx: RuntimeBackendTx,
  input: {
    changes: TurnTreeChangeSet;
    now: () => EpochMs;
    /**
     * Base tree this write is a structurally-guaranteed append-only
     * extension of (KRT-BK008, ADR-011). Only pass this when `changes` was
     * produced by `applyStagedResultsToManifest` against the manifest at
     * this exact hash — an arbitrary/overwritten `changes` set must omit it,
     * since the chunk-aware caller trusts append-only-ness structurally
     * rather than re-verifying prefix content. See the call-site comment in
     * `runtime-kernel.ts`'s `tree.create` for the case that must NOT thread
     * this through.
     */
    priorTurnTreeHash?: HashString;
    schema: TurnTreeSchema;
  }
): Promise<HashString> {
  const manifest = normalizeManifest(input.schema, input.changes);
  const hash = await hashTurnTreeIdentity(
    input.schema.schemaId,
    manifest,
    input.schema
  );
  const existing = await tx.turnTrees.get(hash);

  if (existing !== null) {
    return hash;
  }

  await tx.turnTrees.put({
    createdAtMs: input.now(),
    hash,
    manifestCbor: encodeRecord(manifest),
    schemaId: input.schema.schemaId,
  });
  await tx.turnTreePaths.putMany(
    await Promise.all(
      input.schema.paths.map((path) =>
        toStoredTurnTreePathChunkAware(
          tx,
          hash,
          path.collection,
          path.path,
          manifest[path.path],
          input.priorTurnTreeHash,
          input.now
        )
      )
    )
  );
  return hash;
}

/**
 * Content-addressed TurnNode write (kernel spec §3.3): computes the node's
 * identity hash from its contract fields and returns the existing hash
 * unchanged if a node with that identity already exists, otherwise
 * persisting it with `previousTurnNodeHash` chaining it onto its
 * predecessor.
 */
export async function createTurnNode(
  tx: RuntimeBackendTx,
  input: {
    consumedStagedResults: StagedResult[];
    eventHash: HashString | null;
    now: () => EpochMs;
    previousTurnNodeHash: HashString | null;
    schemaId: string;
    turnTreeHash: HashString;
  }
): Promise<HashString> {
  const nodeWithoutHash: Omit<TurnNode, "hash"> = {
    consumedStagedResults: input.consumedStagedResults,
    eventHash: input.eventHash,
    previousTurnNodeHash: input.previousTurnNodeHash,
    schemaId: input.schemaId,
    turnTreeHash: input.turnTreeHash,
  };
  const hash = await hashTurnNodeIdentity(nodeWithoutHash);
  const existing = await tx.turnNodes.get(hash);

  if (existing !== null) {
    return hash;
  }

  await tx.turnNodes.put({
    consumedStagedResultsCbor: encodeRecord(input.consumedStagedResults),
    createdAtMs: input.now(),
    eventHash: input.eventHash,
    hash,
    previousTurnNodeHash: input.previousTurnNodeHash,
    schemaId: input.schemaId,
    turnTreeHash: input.turnTreeHash,
  });
  return hash;
}
