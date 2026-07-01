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
  toStoredTurnTreePath,
} from "./runtime-kernel-storage.js";

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

export function getLastRunTurnNodeHash(run: RunRecord): HashString {
  return run.createdTurnNodes.at(-1) ?? run.startTurnNodeHash;
}

export function getLastRunTurnNodeHashFromStoredRun(
  run: StoredRun
): HashString {
  return (
    decodeHashArray(run.createdTurnNodesCbor).at(-1) ?? run.startTurnNodeHash
  );
}

export function isLeaseExpired(
  leaseExpiresAtMs: EpochMs,
  nowMs: EpochMs
): boolean {
  return leaseExpiresAtMs <= nowMs;
}

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

export function requireRunningRun(run: RunRecord, runId: string): void {
  if (run.status !== "running") {
    throw new TuvrenRuntimeError(
      `run "${runId}" is not in running state (status: ${run.status})`,
      { code: "kernel_runtime_run_not_running" }
    );
  }
}

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
    schema,
  });
}

export async function createTurnTree(
  tx: RuntimeBackendTx,
  input: {
    changes: TurnTreeChangeSet;
    now: () => EpochMs;
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
    input.schema.paths.map((path) =>
      toStoredTurnTreePath(
        hash,
        path.collection,
        path.path,
        manifest[path.path]
      )
    )
  );
  return hash;
}

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
