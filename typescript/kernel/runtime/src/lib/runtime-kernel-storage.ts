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
  assertHashString,
  type EpochMs,
  type HashString,
  type KernelRecord,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
import {
  assertPathValueForCollectionKind,
  assertStagedResult,
  assertStepDeclaration,
  assertTurnTreeSchema,
  type BranchRecord,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  type PathValue,
  type RunRecord,
  type RuntimeBackendTx,
  type StagedResult,
  type StagedResultStatus,
  type StepDeclaration,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTreePath,
  type ThreadRecord,
  type TurnNode,
  type TurnRecord,
  type TurnTreeChangeSet,
  type TurnTreeManifest,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";

// ADR-011 frames the ordered-path chunking threshold/size as an
// implementation constant, not a protocol constant, so each storage-owning
// module (memory/postgres/sqlite backends, and this runtime caller) declares
// its own copy rather than importing a shared one. Kept in sync across all
// five declarations by the source-text agreement test in
// runtime-kernel-storage.chunk-constant-agreement.test.ts, not by import.
const RUNTIME_ORDERED_PATH_CHUNK_THRESHOLD = 32;
const RUNTIME_ORDERED_PATH_CHUNK_SIZE = 32;

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * Writes `blob` to the content-addressed object store (kernel spec §2.4),
 * hashing it first so a byte-identical write is idempotent — an existing
 * object with the same hash is left untouched and its hash returned as-is.
 */
export async function putObject(
  tx: RuntimeBackendTx,
  blob: Uint8Array,
  now: () => EpochMs,
  mediaType = DEFAULT_MEDIA_TYPE
): Promise<HashString> {
  const bytes = new Uint8Array(blob);
  const hash = await hashOpaqueObjectBytes(bytes);
  const existing = await tx.objects.get(hash);

  if (existing !== null) {
    return hash;
  }

  await tx.objects.put({
    byteLength: bytes.byteLength,
    bytes,
    createdAtMs: now(),
    hash,
    mediaType,
  });
  return hash;
}

/**
 * Builds the all-empty {@link TurnTreeManifest} for `schema`: every ordered
 * path starts as `[]` and every single path starts as `null` (kernel spec
 * §3.2). Used both for base-less `tree.create` and as the seed a thread's
 * genesis TurnTree is built from.
 */
export function createEmptyManifest(schema: TurnTreeSchema): TurnTreeManifest {
  const manifest: TurnTreeManifest = {};

  for (const path of schema.paths) {
    manifest[path.path] = path.collection === "ordered" ? [] : null;
  }

  return manifest;
}

/**
 * Merges `changes` onto {@link createEmptyManifest}'s empty baseline for
 * `schema`, validating each supplied path's value against its declared
 * collection kind. Paths absent from `changes` keep their empty default, so
 * the result is always a full manifest with every schema path present.
 */
export function normalizeManifest(
  schema: TurnTreeSchema,
  changes: TurnTreeChangeSet
): TurnTreeManifest {
  const manifest = createEmptyManifest(schema);

  for (const path of schema.paths) {
    const value = changes[path.path];

    if (value !== undefined) {
      assertPathValueForCollectionKind(
        value,
        path.collection,
        `manifest.${path.path}`
      );
      manifest[path.path] = value;
    }
  }

  return manifest;
}

/**
 * Projects one manifest path value into its flat {@link StoredTurnTreePath}
 * row: an ordered path is stored as an inline CBOR-encoded hash array, a
 * single path as a nullable hash. Always flattens the whole collection —
 * {@link toStoredTurnTreePathChunkAware} is the incremental counterpart used
 * once an ordered path grows past the chunking threshold.
 */
export function toStoredTurnTreePath(
  turnTreeHash: HashString,
  collectionKind: "ordered" | "single",
  path: string,
  value: PathValue
): StoredTurnTreePath {
  if (collectionKind === "ordered") {
    const items = Array.isArray(value) ? value : [];
    return {
      collectionKind,
      orderedCount: items.length,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeRecord(items),
      path,
      turnTreeHash,
    };
  }

  return {
    collectionKind,
    path,
    singleHash: typeof value === "string" ? value : null,
    turnTreeHash,
  };
}

/**
 * Chunk-aware counterpart to `toStoredTurnTreePath` (ADR-011, KRT-BK008).
 * Callers that can prove `value` is a strict append onto `priorTurnTreeHash`'s
 * already-chunked prior value for `path` reuse that prior's stable (full)
 * chunks verbatim and only hash/store the new tail, instead of re-flattening
 * and re-hashing the whole collection on every write past the threshold. Only
 * `createTurnTree` callers that are structurally guaranteed append-only may
 * pass `priorTurnTreeHash` (see the call-site comments in
 * runtime-kernel-lineage.ts and runtime-kernel.ts); every other combination of
 * inputs falls back to `toStoredTurnTreePath`'s exact flat behavior.
 */
export async function toStoredTurnTreePathChunkAware(
  tx: RuntimeBackendTx,
  turnTreeHash: HashString,
  collectionKind: "ordered" | "single",
  path: string,
  value: PathValue,
  priorTurnTreeHash: HashString | undefined,
  now: () => EpochMs
): Promise<StoredTurnTreePath> {
  if (collectionKind !== "ordered" || priorTurnTreeHash === undefined) {
    return toStoredTurnTreePath(turnTreeHash, collectionKind, path, value);
  }

  const items = Array.isArray(value) ? value : [];

  if (items.length <= RUNTIME_ORDERED_PATH_CHUNK_THRESHOLD) {
    return toStoredTurnTreePath(turnTreeHash, collectionKind, path, value);
  }

  const prior = await tx.turnTreePaths.get(priorTurnTreeHash, path);

  if (
    prior === null ||
    prior.collectionKind !== "ordered" ||
    prior.orderedEncoding !== "chunked" ||
    items.length < prior.orderedCount
  ) {
    return toStoredTurnTreePath(turnTreeHash, collectionKind, path, value);
  }

  const priorChunkHashes = decodeHashArray(prior.orderedChunkListCbor);
  const stableChunkCount = Math.floor(
    prior.orderedCount / RUNTIME_ORDERED_PATH_CHUNK_SIZE
  );
  const reusedChunkHashes = priorChunkHashes.slice(0, stableChunkCount);
  const newChunkHashes: HashString[] = [];

  for (
    let index = stableChunkCount * RUNTIME_ORDERED_PATH_CHUNK_SIZE;
    index < items.length;
    index += RUNTIME_ORDERED_PATH_CHUNK_SIZE
  ) {
    const chunkItems = items.slice(
      index,
      index + RUNTIME_ORDERED_PATH_CHUNK_SIZE
    );
    const chunkHash = await hashKernelRecord(chunkItems);
    // Chunk content is hash-addressed, so an identical chunk of items may
    // already exist under a different tree's history (e.g. divergent
    // branches sharing early lineage). Backends reject a put whose
    // createdAtMs differs from an existing record with the same key, so
    // preserve the original stamp instead of always using `now()` — mirrors
    // the memory/postgres/sqlite backends' own promotion-path behavior.
    const existingChunk = await tx.orderedPathChunks.get(chunkHash);
    await tx.orderedPathChunks.put({
      chunkHash,
      createdAtMs: existingChunk?.createdAtMs ?? now(),
      itemCount: chunkItems.length,
      itemsCbor: encodeRecord(chunkItems),
    });
    newChunkHashes.push(chunkHash);
  }

  return {
    collectionKind: "ordered",
    orderedChunkListCbor: encodeRecord([
      ...reusedChunkHashes,
      ...newChunkHashes,
    ]),
    orderedCount: items.length,
    orderedEncoding: "chunked",
    path,
    turnTreeHash,
  };
}

/**
 * Loads and decodes the full {@link TurnTreeManifest} for `treeHash`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn_tree`
 *   when no tree exists at `treeHash`.
 */
export async function requireTreeManifest(
  tx: RuntimeBackendTx,
  treeHash: HashString
): Promise<TurnTreeManifest> {
  const tree = await requireTurnTree(tx, treeHash);
  return decodeManifest(tree.manifestCbor);
}

/**
 * Walks back from `hash` toward the thread root, confirming it lies on the
 * thread's TurnNode lineage before returning the node at `hash`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_lineage_mismatch` when
 *   the lineage walk from `hash` reaches the thread genesis without ever
 *   encountering `thread.rootTurnNodeHash`.
 */
export async function requireThreadTurnNode(
  tx: RuntimeBackendTx,
  hash: HashString,
  thread: ThreadRecord
): Promise<TurnNode> {
  let currentHash: HashString | null = hash;

  while (currentHash !== null) {
    const node = await requireTurnNode(tx, currentHash);

    if (node.hash === thread.rootTurnNodeHash) {
      return await requireTurnNode(tx, hash);
    }

    currentHash = node.previousTurnNodeHash;
  }

  throw new TuvrenRuntimeError("turn node does not belong to thread", {
    code: "kernel_runtime_lineage_mismatch",
  });
}

/**
 * Lists a run's un-anchored {@link StagedResult}s (kernel spec §3.4), decoded
 * from their stored form. Empty right after a checkpoint or at run start.
 */
export async function listStagedResults(
  tx: RuntimeBackendTx,
  runId: string
): Promise<StagedResult[]> {
  const storedResults = await tx.stagedResults.listByRun(runId);
  return storedResults.map(decodeStoredStagedResult);
}

/**
 * Builds a {@link StagedResult} from its constituent fields, including
 * `interruptPayload` (defaulting to `null`) only when `status` is
 * `"interrupted"` — every other status omits the field entirely.
 */
export function createStagedResult(input: {
  interruptPayload?: KernelRecord;
  objectHash: HashString;
  objectType: string;
  status: StagedResultStatus;
  taskId: string;
  timestamp: EpochMs;
}): StagedResult {
  if (input.status === "interrupted") {
    return {
      interruptPayload: input.interruptPayload ?? null,
      objectHash: input.objectHash,
      objectType: input.objectType,
      status: input.status,
      taskId: input.taskId,
      timestamp: input.timestamp,
    };
  }

  return {
    objectHash: input.objectHash,
    objectType: input.objectType,
    status: input.status,
    taskId: input.taskId,
    timestamp: input.timestamp,
  };
}

/**
 * Projects a live {@link StagedResult} into its durable
 * {@link StoredStagedResult} row for `runId`, CBOR-encoding
 * `interruptPayload` when present.
 */
export function toStoredStagedResult(
  runId: string,
  stagedResult: StagedResult
): StoredStagedResult {
  if (stagedResult.status === "interrupted") {
    return {
      createdAtMs: stagedResult.timestamp,
      interruptPayloadCbor: encodeRecord(stagedResult.interruptPayload),
      objectHash: stagedResult.objectHash,
      objectType: stagedResult.objectType,
      runId,
      status: stagedResult.status,
      taskId: stagedResult.taskId,
    };
  }

  return {
    createdAtMs: stagedResult.timestamp,
    objectHash: stagedResult.objectHash,
    objectType: stagedResult.objectType,
    runId,
    status: stagedResult.status,
    taskId: stagedResult.taskId,
  };
}

/**
 * Inverse of {@link toStoredStagedResult}: decodes a durable
 * {@link StoredStagedResult} row back into a live {@link StagedResult}.
 */
export function decodeStoredStagedResult(
  record: StoredStagedResult
): StagedResult {
  if (record.status === "interrupted") {
    return {
      interruptPayload: decodeKernelRecord(
        record.interruptPayloadCbor,
        "staged interrupt payload"
      ),
      objectHash: record.objectHash,
      objectType: record.objectType,
      status: record.status,
      taskId: record.taskId,
      timestamp: record.createdAtMs,
    };
  }

  return {
    objectHash: record.objectHash,
    objectType: record.objectType,
    status: record.status,
    taskId: record.taskId,
    timestamp: record.createdAtMs,
  };
}

/**
 * Decodes a durable {@link StoredRun} row into a live {@link RunRecord},
 * decoding its CBOR-encoded fields and dropping optional lease fields
 * (`executionOwnerId`, `fencingToken`, `leaseExpiresAtMs`,
 * `preemptionReason`) that were never set.
 */
export function decodeStoredRun(record: StoredRun): RunRecord {
  return {
    branchId: record.branchId,
    createdTurnNodes: decodeHashArray(record.createdTurnNodesCbor),
    currentStepIndex: record.currentStepIndex,
    ...(record.executionOwnerId === undefined
      ? {}
      : {
          executionOwnerId: record.executionOwnerId,
        }),
    ...(record.fencingToken === undefined
      ? {}
      : {
          fencingToken: record.fencingToken,
        }),
    ...(record.leaseExpiresAtMs === undefined
      ? {}
      : {
          leaseExpiresAtMs: record.leaseExpiresAtMs,
        }),
    ...(record.preemptionReason === undefined
      ? {}
      : {
          preemptionReason: record.preemptionReason,
        }),
    runId: record.runId,
    schemaId: record.schemaId,
    startTurnNodeHash: record.startTurnNodeHash,
    status: record.status,
    stepSequence: decodeSteps(record.stepSequenceCbor),
    turnId: record.turnId,
  };
}

/**
 * Decodes a durable {@link StoredTurnNode} row into a live {@link TurnNode},
 * decoding its CBOR-encoded `consumedStagedResults`.
 */
export function decodeStoredTurnNode(record: StoredTurnNode): TurnNode {
  return {
    consumedStagedResults: decodeStagedResults(
      record.consumedStagedResultsCbor
    ),
    eventHash: record.eventHash,
    hash: record.hash,
    previousTurnNodeHash: record.previousTurnNodeHash,
    schemaId: record.schemaId,
    turnTreeHash: record.turnTreeHash,
  };
}

/**
 * Projects a durable {@link StoredBranch} row onto its public
 * {@link BranchRecord} shape.
 */
export function toBranchRecord(record: StoredBranch): BranchRecord {
  return {
    branchId: record.branchId,
    headTurnNodeHash: record.headTurnNodeHash,
    threadId: record.threadId,
  };
}

/**
 * Projects a durable {@link StoredTurn} row onto its public
 * {@link TurnRecord} shape.
 */
export function toTurnRecord(record: StoredTurn): TurnRecord {
  return {
    branchId: record.branchId,
    headTurnNodeHash: record.headTurnNodeHash,
    parentTurnId: record.parentTurnId,
    startTurnNodeHash: record.startTurnNodeHash,
    threadId: record.threadId,
    turnId: record.turnId,
  };
}

/**
 * Strips a run's lease fields (`executionOwnerId`, `fencingToken`,
 * `leaseExpiresAtMs`, `preemptionReason`) from a stored run record. Used when
 * a run transitions to a terminal status (`complete`, `preemptExpired`),
 * since a finished run no longer holds execution ownership.
 */
export function clearStoredRunLease(
  record: Omit<StoredRun, "pendingSignalsCbor">
): Omit<
  StoredRun,
  "executionOwnerId" | "fencingToken" | "leaseExpiresAtMs" | "preemptionReason"
> {
  const {
    executionOwnerId: _executionOwnerId,
    fencingToken: _fencingToken,
    leaseExpiresAtMs: _leaseExpiresAtMs,
    preemptionReason: _preemptionReason,
    ...coreRecord
  } = record;

  return coreRecord;
}

/**
 * Refreshes a leased run's fencing token on a step advance, preserving the
 * same `executionOwnerId` and `leaseExpiresAtMs` (kernel spec §5.2). Returns
 * an empty object when `run` holds no lease at all, so unleased runs are
 * unaffected.
 */
export function createRunningLeaseUpdate(
  run: StoredRun,
  createFencingToken: () => string
):
  | {
      executionOwnerId: string;
      fencingToken: string;
      leaseExpiresAtMs: EpochMs;
    }
  | Record<string, never> {
  if (
    run.executionOwnerId === undefined ||
    run.fencingToken === undefined ||
    run.leaseExpiresAtMs === undefined
  ) {
    return {};
  }

  return {
    executionOwnerId: run.executionOwnerId,
    fencingToken: createFencingToken(),
    leaseExpiresAtMs: run.leaseExpiresAtMs,
  };
}

/**
 * Narrows {@link createRunningLeaseUpdate}'s result to the populated-lease
 * variant, true only when all three lease fields are present.
 */
export function isRunLeaseState(
  value:
    | {
        executionOwnerId: string;
        fencingToken: string;
        leaseExpiresAtMs: EpochMs;
      }
    | Record<string, never>
): value is {
  executionOwnerId: string;
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
} {
  return (
    "executionOwnerId" in value &&
    "fencingToken" in value &&
    "leaseExpiresAtMs" in value
  );
}

/**
 * Validates `createLeasedRun` input shared fields before the run is created:
 * a non-empty `executionOwnerId` and a safe-integer epoch `leaseExpiresAtMs`.
 *
 * @throws TuvrenValidationError With code `kernel_runtime_invalid_string` or
 *   `kernel_runtime_invalid_lease_expiry`.
 */
export function assertLeasedRunCreateInput(input: {
  executionOwnerId: string;
  leaseExpiresAtMs: EpochMs;
}): void {
  assertNonEmptyString(input.executionOwnerId, "input.executionOwnerId");

  if (!Number.isSafeInteger(input.leaseExpiresAtMs)) {
    throw new TuvrenValidationError(
      "input.leaseExpiresAtMs must be a safe integer epoch timestamp",
      { code: "kernel_runtime_invalid_lease_expiry" }
    );
  }
}

/**
 * Asserts `value` is a non-empty string, throwing with `label` identifying
 * the field for a caller-facing error message.
 *
 * @throws TuvrenValidationError With code `kernel_runtime_invalid_string`.
 */
export function assertNonEmptyString(value: string, label: string): void {
  if (value.length === 0) {
    throw new TuvrenValidationError(`${label} must be a non-empty string`, {
      code: "kernel_runtime_invalid_string",
    });
  }
}

/**
 * Asserts neither `threadId` nor `initialBranchId` is already taken, so
 * `thread.create` fails fast before any writes when either identity
 * collides.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_thread_exists` or
 *   `kernel_runtime_branch_exists`.
 */
export async function assertThreadCreateIdsAvailable(
  tx: RuntimeBackendTx,
  threadId: string,
  initialBranchId: string
): Promise<void> {
  if ((await tx.threads.get(threadId)) !== null) {
    throw new TuvrenRuntimeError(`thread "${threadId}" already exists`, {
      code: "kernel_runtime_thread_exists",
    });
  }

  if ((await tx.branches.get(initialBranchId)) !== null) {
    throw new TuvrenRuntimeError(`branch "${initialBranchId}" already exists`, {
      code: "kernel_runtime_branch_exists",
    });
  }
}

/**
 * Asserts `branchId` is not already registered.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_branch_exists`.
 */
export async function assertBranchIdAvailable(
  tx: RuntimeBackendTx,
  branchId: string
): Promise<void> {
  if ((await tx.branches.get(branchId)) !== null) {
    throw new TuvrenRuntimeError(`branch "${branchId}" already exists`, {
      code: "kernel_runtime_branch_exists",
    });
  }
}

/**
 * Asserts `runId` is not already registered.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_run_exists`.
 */
export async function assertRunIdAvailable(
  tx: RuntimeBackendTx,
  runId: string
): Promise<void> {
  if ((await tx.runs.get(runId)) !== null) {
    throw new TuvrenRuntimeError(`run "${runId}" already exists`, {
      code: "kernel_runtime_run_exists",
    });
  }
}

/**
 * Asserts `turnId` is not already registered.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_turn_exists`.
 */
export async function assertTurnIdAvailable(
  tx: RuntimeBackendTx,
  turnId: string
): Promise<void> {
  if ((await tx.turns.get(turnId)) !== null) {
    throw new TuvrenRuntimeError(`turn "${turnId}" already exists`, {
      code: "kernel_runtime_turn_exists",
    });
  }
}

/**
 * Loads the durable {@link StoredBranch} for `branchId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_branch` when
 *   no branch exists at `branchId`.
 */
export async function requireBranch(
  tx: RuntimeBackendTx,
  branchId: string
): Promise<StoredBranch> {
  const branch = await tx.branches.get(branchId);

  if (branch === null) {
    throw new TuvrenRuntimeError(`unknown branch "${branchId}"`, {
      code: "kernel_runtime_missing_branch",
    });
  }

  return branch;
}

/**
 * Loads and decodes the live {@link RunRecord} for `runId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_run` when no
 *   run exists at `runId`.
 */
export async function requireRun(
  tx: RuntimeBackendTx,
  runId: string
): Promise<RunRecord> {
  return decodeStoredRun(await requireStoredRun(tx, runId));
}

/**
 * Asserts `branchId` has no `running` or `paused` run, so a new run's
 * single-active-run-per-branch invariant holds before it is created.
 *
 * @throws TuvrenRuntimeError With code
 *   `kernel_runtime_branch_already_active`.
 */
export async function assertNoActiveRunOnBranch(
  tx: RuntimeBackendTx,
  branchId: string
): Promise<void> {
  const existingRuns = await tx.runs.listByBranch(branchId);
  const activeRun = existingRuns.find(
    (run) => run.status === "running" || run.status === "paused"
  );

  if (activeRun !== undefined) {
    throw new TuvrenRuntimeError(
      `branch "${branchId}" already has an active run "${activeRun.runId}"`,
      { code: "kernel_runtime_branch_already_active" }
    );
  }
}

/**
 * Loads the durable {@link StoredRun} for `runId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_run` when no
 *   run exists at `runId`.
 */
export async function requireStoredRun(
  tx: RuntimeBackendTx,
  runId: string
): Promise<StoredRun> {
  const run = await tx.runs.get(runId);

  if (run === null) {
    throw new TuvrenRuntimeError(`unknown run "${runId}"`, {
      code: "kernel_runtime_missing_run",
    });
  }

  return run;
}

/**
 * Narrows a {@link StoredRun} to its populated lease fields, for callers
 * (lease renewal, preemption) that require the run to currently hold
 * execution ownership.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_run_not_leased` when
 *   `run` holds no lease.
 */
export function requireLeasedRun(
  run: StoredRun,
  runId: string
): {
  executionOwnerId: string;
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
} {
  if (
    run.executionOwnerId === undefined ||
    run.fencingToken === undefined ||
    run.leaseExpiresAtMs === undefined
  ) {
    throw new TuvrenRuntimeError(
      `run "${runId}" does not hold leased execution ownership`,
      { code: "kernel_runtime_run_not_leased" }
    );
  }

  return {
    executionOwnerId: run.executionOwnerId,
    fencingToken: run.fencingToken,
    leaseExpiresAtMs: run.leaseExpiresAtMs,
  };
}

/**
 * Loads the durable {@link StoredTurn} for `turnId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn` when no
 *   turn exists at `turnId`.
 */
export async function requireStoredTurn(
  tx: RuntimeBackendTx,
  turnId: string
): Promise<StoredTurn> {
  const turn = await tx.turns.get(turnId);

  if (turn === null) {
    throw new TuvrenRuntimeError(`unknown turn "${turnId}"`, {
      code: "kernel_runtime_missing_turn",
    });
  }

  return turn;
}

/**
 * Loads and projects the public {@link TurnRecord} for `turnId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn`.
 */
export async function requireTurn(
  tx: RuntimeBackendTx,
  turnId: string
): Promise<TurnRecord> {
  return toTurnRecord(await requireStoredTurn(tx, turnId));
}

/**
 * Loads and decodes the {@link TurnNode} at `hash`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn_node`
 *   when no node exists at `hash`.
 */
export async function requireTurnNode(
  tx: RuntimeBackendTx,
  hash: HashString
): Promise<TurnNode> {
  const node = await tx.turnNodes.get(hash);

  if (node === null) {
    throw new TuvrenRuntimeError(`unknown turn node "${hash}"`, {
      code: "kernel_runtime_missing_turn_node",
    });
  }

  return decodeStoredTurnNode(node);
}

/**
 * Loads the durable TurnTree row (hash, encoded manifest, schema id) for
 * `hash`, without decoding the manifest.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_turn_tree`
 *   when no tree exists at `hash`.
 */
export async function requireTurnTree(
  tx: RuntimeBackendTx,
  hash: HashString
): Promise<{ hash: HashString; manifestCbor: Uint8Array; schemaId: string }> {
  const tree = await tx.turnTrees.get(hash);

  if (tree === null) {
    throw new TuvrenRuntimeError(`unknown turn tree "${hash}"`, {
      code: "kernel_runtime_missing_turn_tree",
    });
  }

  return tree;
}

/**
 * Loads the public {@link ThreadRecord} for `threadId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_thread` when
 *   no thread exists at `threadId`.
 */
export async function requireThread(
  tx: RuntimeBackendTx,
  threadId: string
): Promise<ThreadRecord> {
  const thread = await tx.threads.get(threadId);

  if (thread === null) {
    throw new TuvrenRuntimeError(`unknown thread "${threadId}"`, {
      code: "kernel_runtime_missing_thread",
    });
  }

  return {
    rootTurnNodeHash: thread.rootTurnNodeHash,
    schemaId: thread.schemaId,
    threadId: thread.threadId,
  };
}

/**
 * Loads and decodes the {@link TurnTreeSchema} for `schemaId`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_missing_schema` when
 *   no schema exists at `schemaId`.
 */
export async function requireSchema(
  tx: RuntimeBackendTx,
  schemaId: string
): Promise<TurnTreeSchema> {
  const schema = await tx.schemas.get(schemaId);

  if (schema === null) {
    throw new TuvrenRuntimeError(`unknown schema "${schemaId}"`, {
      code: "kernel_runtime_missing_schema",
    });
  }

  return decodeSchema(schema.schemaCbor);
}

/**
 * Decodes deterministic CBOR `bytes` into a {@link KernelRecord}.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record` when
 *   `bytes` do not decode, using `label` to identify the field in the error
 *   message.
 */
export function decodeKernelRecord(
  bytes: Uint8Array,
  label: string
): KernelRecord {
  const decoded = decodeDeterministicKernelRecord(bytes);

  if (decoded === undefined) {
    throw new TuvrenRuntimeError(`${label} could not be decoded`, {
      code: "kernel_runtime_invalid_record",
    });
  }

  return decoded;
}

/**
 * {@link decodeKernelRecord}, additionally asserting the decoded value is an
 * array.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record`.
 */
export function decodeKernelRecordArray(
  bytes: Uint8Array,
  label: string
): KernelRecord[] {
  const decoded = decodeKernelRecord(bytes, label);

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError(`${label} must decode to an array`, {
      code: "kernel_runtime_invalid_record",
    });
  }

  return decoded as KernelRecord[];
}

/**
 * Decodes and validates a stored schema's CBOR bytes into a
 * {@link TurnTreeSchema}.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record` when
 *   the bytes do not decode.
 * @throws TuvrenValidationError When the decoded value is not a valid
 *   {@link TurnTreeSchema}.
 */
export function decodeSchema(bytes: Uint8Array): TurnTreeSchema {
  const decoded = decodeKernelRecord(bytes, "schema");
  assertTurnTreeSchema(decoded, "schema");
  return decoded;
}

/**
 * Decodes and validates a run's CBOR-encoded step sequence into
 * {@link StepDeclaration}s.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record` when
 *   the bytes do not decode to an array.
 * @throws TuvrenValidationError When an element is not a valid
 *   {@link StepDeclaration}.
 */
export function decodeSteps(bytes: Uint8Array): StepDeclaration[] {
  const decoded = decodeKernelRecord(bytes, "run steps");

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError("run steps must decode to an array", {
      code: "kernel_runtime_invalid_record",
    });
  }

  const steps: StepDeclaration[] = [];

  for (const step of decoded) {
    assertStepDeclaration(step, "run step");
    steps.push(step);
  }

  return steps;
}

/**
 * Decodes and validates a CBOR-encoded array of hash strings, e.g. a run's
 * `createdTurnNodesCbor` or a chunked ordered path's chunk-hash list.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record` when
 *   the bytes do not decode to an array of valid hash strings.
 */
export function decodeHashArray(bytes: Uint8Array): HashString[] {
  const decoded = decodeKernelRecord(bytes, "hash array");

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError("hash array must decode to an array", {
      code: "kernel_runtime_invalid_record",
    });
  }

  const hashes: HashString[] = [];

  for (const item of decoded) {
    assertHashString(item, "hash array item");
    hashes.push(item);
  }

  return hashes;
}

/**
 * Decodes and validates a CBOR-encoded array of {@link StagedResult}s, e.g. a
 * TurnNode's `consumedStagedResultsCbor`.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record` when
 *   the bytes do not decode to an array.
 * @throws TuvrenValidationError When an element is not a valid
 *   {@link StagedResult}.
 */
export function decodeStagedResults(bytes: Uint8Array): StagedResult[] {
  const decoded = decodeKernelRecord(bytes, "staged results");

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError("staged results must decode to an array", {
      code: "kernel_runtime_invalid_record",
    });
  }

  const results: StagedResult[] = [];

  for (const result of decoded) {
    assertStagedResult(result, "staged result");
    results.push(result);
  }

  return results;
}

/**
 * Decodes and validates a CBOR-encoded turn tree manifest into a
 * {@link TurnTreeManifest}, checking each path value is `null`, a hash
 * string, or an array of hash strings.
 *
 * @throws TuvrenRuntimeError With code `kernel_runtime_invalid_record` when
 *   the bytes do not decode to an object, or a path value has an invalid
 *   shape.
 */
export function decodeManifest(bytes: Uint8Array): TurnTreeManifest {
  const decoded = decodeKernelRecord(bytes, "turn tree manifest");

  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new TuvrenRuntimeError(
      "turn tree manifest must decode to an object",
      { code: "kernel_runtime_invalid_record" }
    );
  }

  const manifest: TurnTreeManifest = {};

  for (const [path, value] of Object.entries(decoded)) {
    if (value === null) {
      manifest[path] = null;
    } else if (typeof value === "string") {
      assertHashString(value, `manifest.${path}`);
      manifest[path] = value;
    } else if (Array.isArray(value)) {
      const hashes: HashString[] = [];

      for (const item of value) {
        assertHashString(item, `manifest.${path}[]`);
        hashes.push(item);
      }

      manifest[path] = hashes;
    } else {
      throw new TuvrenRuntimeError(
        `turn tree manifest path "${path}" has invalid value`,
        { code: "kernel_runtime_invalid_record" }
      );
    }
  }

  return manifest;
}

/**
 * Coerces `value` to a {@link KernelRecord} ({@link toKernelRecord}) and
 * encodes it as deterministic CBOR — the runtime's single write path for
 * every CBOR-encoded stored field.
 */
export function encodeRecord(value: unknown): Uint8Array {
  return encodeDeterministicKernelRecord(toKernelRecord(value));
}

/**
 * Recursively coerces a plain JavaScript value into a {@link KernelRecord}:
 * primitives, `Uint8Array`, arrays, and plain objects pass through
 * (recursing into their elements/values); anything else (e.g. `undefined`,
 * functions, non-safe-integer numbers) is rejected.
 *
 * @throws TuvrenValidationError With code `kernel_runtime_invalid_record`
 *   when `value` cannot be represented as a kernel record.
 */
export function toKernelRecord(value: unknown): KernelRecord {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toKernelRecord(item));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    const record: Record<string, KernelRecord> = {};

    for (const [key, entryValue] of entries) {
      record[key] = toKernelRecord(entryValue);
    }

    return record;
  }

  throw new TuvrenValidationError(
    "value cannot be represented as a kernel record",
    {
      code: "kernel_runtime_invalid_record",
    }
  );
}
