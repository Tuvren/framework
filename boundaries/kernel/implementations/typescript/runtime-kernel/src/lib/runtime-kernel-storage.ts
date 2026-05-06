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
} from "@tuvren/core-types";
import {
  assertPathValueForCollectionKind,
  assertStagedResult,
  assertStepDeclaration,
  assertTurnTreeSchema,
  type BranchRecord,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
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

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

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

export function createEmptyManifest(schema: TurnTreeSchema): TurnTreeManifest {
  const manifest: TurnTreeManifest = {};

  for (const path of schema.paths) {
    manifest[path.path] = path.collection === "ordered" ? [] : null;
  }

  return manifest;
}

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

export async function requireTreeManifest(
  tx: RuntimeBackendTx,
  treeHash: HashString
): Promise<TurnTreeManifest> {
  const tree = await requireTurnTree(tx, treeHash);
  return decodeManifest(tree.manifestCbor);
}

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

export async function listStagedResults(
  tx: RuntimeBackendTx,
  runId: string
): Promise<StagedResult[]> {
  const storedResults = await tx.stagedResults.listByRun(runId);
  return storedResults.map(decodeStoredStagedResult);
}

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

export function toBranchRecord(record: StoredBranch): BranchRecord {
  return {
    branchId: record.branchId,
    headTurnNodeHash: record.headTurnNodeHash,
    threadId: record.threadId,
  };
}

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

export function assertNonEmptyString(value: string, label: string): void {
  if (value.length === 0) {
    throw new TuvrenValidationError(`${label} must be a non-empty string`, {
      code: "kernel_runtime_invalid_string",
    });
  }
}

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

export async function requireRun(
  tx: RuntimeBackendTx,
  runId: string
): Promise<RunRecord> {
  return decodeStoredRun(await requireStoredRun(tx, runId));
}

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

export async function requireTurn(
  tx: RuntimeBackendTx,
  turnId: string
): Promise<TurnRecord> {
  return toTurnRecord(await requireStoredTurn(tx, turnId));
}

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

export function decodeSchema(bytes: Uint8Array): TurnTreeSchema {
  const decoded = decodeKernelRecord(bytes, "schema");
  assertTurnTreeSchema(decoded, "schema");
  return decoded;
}

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

export function encodeRecord(value: unknown): Uint8Array {
  return encodeDeterministicKernelRecord(toKernelRecord(value));
}

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
