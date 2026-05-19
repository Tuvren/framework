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
  EpochMs,
  HashString,
  KernelObject,
  KernelRecord,
} from "@tuvren/core-types";

export type PathCollectionKind = "ordered" | "single";
export type PathValue = HashString[] | HashString | null;
export type TurnTreeManifest = Record<string, PathValue>;
export type TurnTreeChangeSet = Record<string, PathValue>;
export type StagedResultStatus = "completed" | "failed" | "interrupted";
export type RunStatus = "running" | "paused" | "completed" | "failed";
export type RunCompletionStatus = Extract<
  RunStatus,
  "paused" | "completed" | "failed"
>;
export type KernelSignal = KernelRecord;
export type VerdictDisposition = "HardFail" | "SoftFail" | "EndTurn";

export interface PathDefinition {
  collection: PathCollectionKind;
  metadata?: KernelRecord;
  path: string;
}

export interface IncorporationRule {
  objectType: string;
  targetPath: string;
}

export interface TurnTreeSchema {
  incorporationRules: IncorporationRule[];
  paths: PathDefinition[];
  schemaId: string;
}

export interface StepDeclaration {
  deterministic: boolean;
  id: string;
  metadata?: KernelRecord;
  sideEffects: boolean;
}

export interface ObserveResult {
  annotations: KernelObject[];
  signals: KernelSignal[];
}

export interface ProceedVerdict {
  kind: "proceed";
}

export interface AbortVerdict {
  disposition: VerdictDisposition;
  kind: "abort";
  reason: string;
}

export interface ModifyVerdict {
  kind: "modify";
  transform: KernelRecord;
}

export interface PauseVerdict {
  kind: "pause";
  reason: string;
  resumptionSchema: KernelRecord;
}

export interface RetryVerdict {
  adjustment: KernelRecord;
  kind: "retry";
}

export type Verdict =
  | AbortVerdict
  | ModifyVerdict
  | PauseVerdict
  | ProceedVerdict
  | RetryVerdict;

export type ComposedVerdict = Verdict;

interface BaseStagedResult {
  objectHash: HashString;
  objectType: string;
  taskId: string;
  timestamp: EpochMs;
}

export interface InterruptedStagedResult extends BaseStagedResult {
  interruptPayload: KernelRecord;
  status: "interrupted";
}

export interface SettledStagedResult extends BaseStagedResult {
  interruptPayload?: never;
  status: "completed" | "failed";
}

export type StagedResult = InterruptedStagedResult | SettledStagedResult;

export interface TurnNode {
  consumedStagedResults: StagedResult[];
  eventHash: HashString | null;
  hash: HashString;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnTreeHash: HashString;
}

export interface ThreadRecord {
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

export interface BranchRecord {
  branchId: string;
  headTurnNodeHash: HashString;
  threadId: string;
}

export interface TurnRecord {
  branchId: string;
  headTurnNodeHash: HashString;
  parentTurnId: string | null;
  startTurnNodeHash: HashString;
  threadId: string;
  turnId: string;
}

export interface RunRecord {
  branchId: string;
  createdTurnNodes: HashString[];
  currentStepIndex: number;
  executionOwnerId?: string;
  fencingToken?: string;
  leaseExpiresAtMs?: EpochMs;
  preemptionReason?: string;
  runId: string;
  schemaId: string;
  startTurnNodeHash: HashString;
  status: RunStatus;
  stepSequence: StepDeclaration[];
  turnId: string;
}

export interface StepContext {
  currentTurnNodeHash: HashString;
  schema: TurnTreeSchema;
  signals: KernelSignal[];
  step: StepDeclaration;
}

export interface RecoveryState {
  consumedStagedResults: StagedResult[];
  lastCompletedStepId: string | null;
  lastTurnNodeHash: HashString;
  stepSequence: StepDeclaration[];
  uncommittedStagedResults: StagedResult[];
}

export interface RunLeaseState {
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
}

export interface RunStepCompletion {
  checkpointed: boolean;
  lease?: RunLeaseState;
  turnNodeHash?: HashString;
}

export interface ThreadCreateResult {
  branchId: string;
  rootTurnNodeHash: HashString;
  rootTurnTreeHash: HashString;
  threadId: string;
}

export interface SetHeadResult {
  archiveBranch?: BranchRecord;
  branch: BranchRecord;
}

export type BranchHeadListEntry = [
  branchId: string,
  headTurnNodeHash: HashString,
];

export interface StoredObject {
  byteLength: number;
  bytes: Uint8Array;
  createdAtMs: EpochMs;
  hash: HashString;
  mediaType: string;
}

export interface StoredSchema {
  createdAtMs: EpochMs;
  schemaCbor: Uint8Array;
  schemaId: string;
}

export interface StoredTurnTree {
  createdAtMs: EpochMs;
  hash: HashString;
  manifestCbor: Uint8Array;
  schemaId: string;
}

interface BaseStoredTurnTreePath {
  path: string;
  turnTreeHash: HashString;
}

export interface StoredSingleTurnTreePath extends BaseStoredTurnTreePath {
  collectionKind: "single";
  orderedChunkListCbor?: never;
  orderedCount?: never;
  orderedEncoding?: never;
  orderedInlineCbor?: never;
  singleHash: HashString | null;
}

export interface StoredFlatOrderedTurnTreePath extends BaseStoredTurnTreePath {
  collectionKind: "ordered";
  orderedChunkListCbor?: never;
  orderedCount: number;
  orderedEncoding: "flat";
  orderedInlineCbor: Uint8Array;
  singleHash?: never;
}

export interface StoredChunkedOrderedTurnTreePath
  extends BaseStoredTurnTreePath {
  collectionKind: "ordered";
  orderedChunkListCbor: Uint8Array;
  orderedCount: number;
  orderedEncoding: "chunked";
  orderedInlineCbor?: never;
  singleHash?: never;
}

export type StoredTurnTreePath =
  | StoredChunkedOrderedTurnTreePath
  | StoredFlatOrderedTurnTreePath
  | StoredSingleTurnTreePath;

export interface StoredOrderedPathChunk {
  chunkHash: HashString;
  createdAtMs: EpochMs;
  itemCount: number;
  itemsCbor: Uint8Array;
}

export interface StoredTurnNode {
  consumedStagedResultsCbor: Uint8Array;
  createdAtMs: EpochMs;
  eventHash: HashString | null;
  hash: HashString;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnTreeHash: HashString;
}

export interface StoredObserveAnnotation {
  annotationCbor: Uint8Array;
  annotationHash: HashString;
  createdAtMs: EpochMs;
  runId: string;
  turnNodeHash: HashString | null;
}

export interface StoredThread {
  createdAtMs: EpochMs;
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

export interface StoredBranch {
  archivedFromBranchId?: string;
  branchId: string;
  createdAtMs: EpochMs;
  headTurnNodeHash: HashString;
  threadId: string;
  updatedAtMs: EpochMs;
}

export interface StoredTurn {
  branchId: string;
  createdAtMs: EpochMs;
  headTurnNodeHash: HashString;
  parentTurnId: string | null;
  startTurnNodeHash: HashString;
  threadId: string;
  turnId: string;
  updatedAtMs: EpochMs;
}

export interface StoredRun {
  branchId: string;
  createdAtMs: EpochMs;
  createdTurnNodesCbor: Uint8Array;
  currentStepIndex: number;
  executionOwnerId?: string;
  fencingToken?: string;
  leaseExpiresAtMs?: EpochMs;
  pendingSignalsCbor?: Uint8Array;
  preemptionReason?: string;
  runId: string;
  schemaId: string;
  startTurnNodeHash: HashString;
  status: RunStatus;
  stepSequenceCbor: Uint8Array;
  turnId: string;
  updatedAtMs: EpochMs;
}

interface BaseStoredStagedResult {
  createdAtMs: EpochMs;
  objectHash: HashString;
  objectType: string;
  runId: string;
  taskId: string;
}

export interface InterruptedStoredStagedResult extends BaseStoredStagedResult {
  interruptPayloadCbor: Uint8Array;
  status: "interrupted";
}

export interface SettledStoredStagedResult extends BaseStoredStagedResult {
  interruptPayloadCbor?: never;
  status: "completed" | "failed";
}

export type StoredStagedResult =
  | InterruptedStoredStagedResult
  | SettledStoredStagedResult;

export interface ObjectRepository {
  get(hash: HashString): Promise<StoredObject | null>;
  has(hash: HashString): Promise<boolean>;
  put(record: StoredObject): Promise<void>;
}

export interface SchemaRepository {
  get(schemaId: string): Promise<StoredSchema | null>;
  put(record: StoredSchema): Promise<void>;
}

export interface TurnTreeRepository {
  get(hash: HashString): Promise<StoredTurnTree | null>;
  put(record: StoredTurnTree): Promise<void>;
}

export interface TurnTreePathRepository {
  get(
    turnTreeHash: HashString,
    path: string
  ): Promise<StoredTurnTreePath | null>;
  listByTurnTree(turnTreeHash: HashString): Promise<StoredTurnTreePath[]>;
  putMany(records: StoredTurnTreePath[]): Promise<void>;
}

export interface OrderedPathChunkRepository {
  get(chunkHash: HashString): Promise<StoredOrderedPathChunk | null>;
  put(record: StoredOrderedPathChunk): Promise<void>;
}

export interface TurnNodeRepository {
  get(hash: HashString): Promise<StoredTurnNode | null>;
  put(record: StoredTurnNode): Promise<void>;
}

export interface ObserveAnnotationRepository {
  listByRun(runId: string): Promise<StoredObserveAnnotation[]>;
  set(record: StoredObserveAnnotation): Promise<void>;
}

/**
 * ADR-034: internal cursor payload shape for thread.list pagination.
 * Backends that implement ThreadRepository.list encode and decode this
 * structure. It is not exposed to kernel callers; callers see only the
 * opaque KernelThreadListCursor string.
 */
export interface ListThreadsCursorPayload {
  filter?: { schemaId?: string };
  kind: "list-threads";
  lastCreatedAtMs: EpochMs;
  lastThreadId: string;
  v: 1;
}

export interface ThreadRepository {
  get(threadId: string): Promise<StoredThread | null>;
  /**
   * ADR-034: optional per BackendCapability descriptor. Backends that
   * advertise thread.enumeration:true MUST implement this method. Ordering
   * is (createdAtMs ASC, threadId ASC). The cursor resumes strictly after
   * the (lastCreatedAtMs, lastThreadId) pair. filter.schemaId restricts
   * results to threads created with the matching schema id.
   */
  list?(options?: {
    limit?: number;
    cursor?: ListThreadsCursorPayload;
    filter?: { schemaId?: string };
  }): Promise<{
    threads: StoredThread[];
    nextCursor?: ListThreadsCursorPayload;
  }>;
  put(record: StoredThread): Promise<void>;
}

export interface BranchRepository {
  get(branchId: string): Promise<StoredBranch | null>;
  listByThread(threadId: string): Promise<StoredBranch[]>;
  set(record: StoredBranch): Promise<void>;
}

export interface TurnRepository {
  get(turnId: string): Promise<StoredTurn | null>;
  listByThread(threadId: string): Promise<StoredTurn[]>;
  set(record: StoredTurn): Promise<void>;
}

export interface RunRepository {
  get(runId: string): Promise<StoredRun | null>;
  listByBranch(branchId: string): Promise<StoredRun[]>;
  listExpired(nowMs: EpochMs): Promise<StoredRun[]>;
  set(record: StoredRun): Promise<void>;
}

export interface StagedResultRepository {
  clearRun(runId: string): Promise<void>;
  get(runId: string, taskId: string): Promise<StoredStagedResult | null>;
  listByRun(runId: string): Promise<StoredStagedResult[]>;
  set(record: StoredStagedResult): Promise<void>;
}

export interface RuntimeBackendTx {
  branches: BranchRepository;
  objects: ObjectRepository;
  observeAnnotations: ObserveAnnotationRepository;
  orderedPathChunks: OrderedPathChunkRepository;
  runs: RunRepository;
  schemas: SchemaRepository;
  stagedResults: StagedResultRepository;
  threads: ThreadRepository;
  turnNodes: TurnNodeRepository;
  turns: TurnRepository;
  turnTreePaths: TurnTreePathRepository;
  turnTrees: TurnTreeRepository;
}

/**
 * ADR-034: per-backend capability descriptor. Each backend advertises which
 * optional kernel-level structural enumerations it supports efficiently so
 * the kernel can reject unsupported syscalls with a typed error rather than
 * degrading silently. See KrakenKernelSpecification §9.
 */
export interface BackendCapability {
  /**
   * Backend supports efficient thread enumeration via ThreadRepository.list.
   * Required for hosts that consume TuvrenRuntime.listThreads.
   */
  readonly "thread.enumeration": boolean;
  /** Reserved for future capability bits. */
  readonly [extraCapability: string]: boolean | undefined;
}

export interface RuntimeBackend {
  capabilities(): BackendCapability;
  health(): Promise<{ ok: true } | { ok: false; reason: string }>;
  transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T>;
}

/**
 * ADR-034: opaque cursor token for thread.list pagination at the kernel
 * protocol level. Internally encodes (lastCreatedAtMs, lastThreadId) as a
 * URL-safe base64 JSON payload; callers treat it as an opaque string.
 */
export type KernelThreadListCursor = string;

export interface RuntimeKernel {
  branch: {
    create(
      branchId: string,
      threadId: string,
      fromTurnNodeHash: HashString
    ): Promise<BranchRecord>;
    get(branchId: string): Promise<BranchRecord | null>;
    setHead(branchId: string, turnNodeHash: HashString): Promise<SetHeadResult>;
    list(threadId: string): Promise<BranchHeadListEntry[]>;
  };
  node: {
    get(hash: HashString): Promise<TurnNode | null>;
    walkBack(fromHash: HashString): AsyncIterable<TurnNode>;
  };
  run: {
    create(
      runId: string,
      turnId: string,
      branchId: string,
      schemaId: string,
      startTurnNodeHash: HashString,
      steps: StepDeclaration[]
    ): Promise<RunRecord>;
    beginStep(runId: string, stepId: string): Promise<StepContext>;
    completeStep(
      runId: string,
      stepId: string,
      eventHash?: HashString,
      observeResults?: ObserveResult[],
      treeHash?: HashString
    ): Promise<RunStepCompletion>;
    complete(
      runId: string,
      status: RunCompletionStatus,
      eventHash?: HashString
    ): Promise<{ turnNodeHash?: HashString }>;
    recover(runId: string): Promise<RecoveryState>;
  };
  schema: {
    register(schema: TurnTreeSchema): Promise<string>;
    get(schemaId: string): Promise<TurnTreeSchema | null>;
  };
  staging: {
    stage(
      runId: string,
      blob: Uint8Array,
      taskId: string,
      objectType: string,
      status: StagedResultStatus,
      interruptPayload?: KernelRecord
    ): Promise<{ objectHash: HashString; stagedResult: StagedResult }>;
    current(runId: string): Promise<StagedResult[]>;
  };
  store: {
    put(blob: Uint8Array, mediaType?: string): Promise<HashString>;
    get(hash: HashString): Promise<Uint8Array | null>;
    has(hash: HashString): Promise<boolean>;
  };
  thread: {
    create(
      threadId: string,
      schemaId: string,
      initialBranchId: string
    ): Promise<ThreadCreateResult>;
    get(threadId: string): Promise<ThreadRecord | null>;
    /**
     * ADR-034: capability-gated thread enumeration. Rejects with
     * TuvrenPersistenceError code "kernel_capability_unsupported" when the
     * backend does not advertise thread.enumeration.
     */
    list(options?: {
      limit?: number;
      cursor?: KernelThreadListCursor;
      filter?: { schemaId?: string };
    }): Promise<{
      threads: StoredThread[];
      nextCursor?: KernelThreadListCursor;
    }>;
  };
  tree: {
    create(
      schemaId: string,
      changes: TurnTreeChangeSet,
      baseTurnTreeHash?: HashString
    ): Promise<HashString>;
    incorporate(
      baseTurnTreeHash: HashString,
      stagedResults: StagedResult[]
    ): Promise<HashString>;
    diff(treeHashA: HashString, treeHashB: HashString): Promise<string[]>;
    resolve(treeHash: HashString, path: string): Promise<PathValue>;
    manifest(treeHash: HashString): Promise<TurnTreeManifest>;
  };
  turn: {
    create(
      turnId: string,
      threadId: string,
      branchId: string,
      parentTurnId: string | null | undefined,
      startTurnNodeHash: HashString
    ): Promise<TurnRecord>;
    get(turnId: string): Promise<TurnRecord | null>;
    updateHead(turnId: string, headTurnNodeHash: HashString): Promise<void>;
  };
  verdicts: {
    compose(verdicts: Verdict[]): Promise<ComposedVerdict>;
  };
}

export interface RuntimeKernelRunLiveness {
  runLiveness: {
    createLeasedRun(input: {
      branchId: string;
      executionOwnerId: string;
      leaseExpiresAtMs: EpochMs;
      runId: string;
      schemaId: string;
      startTurnNodeHash: HashString;
      steps: StepDeclaration[];
      turnId: string;
    }): Promise<RunRecord>;
    listExpired(nowMs: EpochMs): Promise<RunRecord[]>;
    preemptExpired(
      runId: string,
      preemptingOwnerId: string,
      nowMs: EpochMs,
      reason: string
    ): Promise<RecoveryState>;
    renewLease(
      runId: string,
      executionOwnerId: string,
      fencingToken: string,
      nextLeaseExpiresAtMs: EpochMs
    ): Promise<{ fencingToken: string; leaseExpiresAtMs: EpochMs }>;
  };
}
