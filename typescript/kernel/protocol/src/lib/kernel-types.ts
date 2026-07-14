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
} from "@tuvren/core";

/**
 * Collection kind of a TurnTree schema path (docs/KrakenKernelSpecification.md
 * §3.1).
 *
 * - `"ordered"` — the path holds an ordered list of Object hashes; incorporation
 *   appends, and semantic/execution order is preserved (never sorted by hash).
 * - `"single"` — the path holds at most one Object hash; incorporation replaces.
 */
export type PathCollectionKind = "ordered" | "single";
/**
 * Value stored at a TurnTree path (kernel spec §3.2): `HashString[]` for
 * `"ordered"` paths, `HashString | null` for `"single"` paths. An empty list or
 * `null` means the path is valid but currently holds no refs.
 */
export type PathValue = HashString[] | HashString | null;
/**
 * Complete dump of a TurnTree: every schema path mapped to its typed
 * {@link PathValue}. Returned by `tree.manifest` (kernel spec §3.2) and used for
 * serialization, debugging, and context assembly.
 */
export type TurnTreeManifest = Record<string, PathValue>;
/**
 * Set of path updates passed to `tree.create` (kernel spec §3.2). Without a base
 * tree every schema path must be present; with a base tree only changed paths
 * appear and unchanged paths inherit from the base by structural sharing.
 */
export type TurnTreeChangeSet = Record<string, PathValue>;
/**
 * Status of a {@link StagedResult} (kernel spec §3.4). `"interrupted"` results
 * carry an `interruptPayload` describing what is needed to resume the task.
 */
export type StagedResultStatus = "completed" | "failed" | "interrupted";
/**
 * Lifecycle status of a Run (kernel spec §5.2, Appendix A). Runs start
 * `"running"` via `run.create`; `"completed"` and `"failed"` are terminal;
 * `"paused"` blocks the Branch and may only be resolved to `"failed"` (resumption
 * creates a new Run from the pause point).
 */
export type RunStatus = "running" | "paused" | "completed" | "failed";
/**
 * Statuses accepted by `run.complete` (kernel spec §5.8): every
 * {@link RunStatus} except `"running"`, which is only entered through
 * `run.create`.
 */
export type RunCompletionStatus = Extract<
  RunStatus,
  "paused" | "completed" | "failed"
>;
/**
 * Ephemeral, run-scoped signal emitted by observe hooks (kernel spec §6.4).
 * Opaque to the kernel; carried forward and delivered to the framework in the
 * next {@link StepContext}.
 */
export type KernelSignal = KernelRecord;
/**
 * Severity of an {@link AbortVerdict} (kernel spec §6.1): `"HardFail"` propagates
 * as an error and stops the Run, `"SoftFail"` persists as an error event while
 * the Run continues, `"EndTurn"` terminates the Turn gracefully.
 */
export type VerdictDisposition = "HardFail" | "SoftFail" | "EndTurn";

/**
 * One path declared by a {@link TurnTreeSchema} (kernel spec §3.1).
 */
export interface PathDefinition {
  /**
   * Whether incorporation appends (`"ordered"`) or replaces (`"single"`).
   */
  collection: PathCollectionKind;
  /**
   * Opaque framework-attached metadata; the kernel ignores it.
   */
  metadata?: KernelRecord;
  /**
   * Dot-separated path name, e.g. `"tools.results"`. Unique within a schema.
   */
  path: string;
}

/**
 * Maps a StagedResult `objectType` to the schema path that receives it during
 * `tree.incorporate` (kernel spec §3.1). A StagedResult whose `objectType` has no
 * matching rule is an incorporation error; duplicate `objectType` mappings are
 * rejected at schema registration.
 */
export interface IncorporationRule {
  objectType: string;
  targetPath: string;
}

/**
 * Registered definition of what TurnTree state looks like (kernel spec §3.1).
 *
 * Registered write-once via `schema.register` and never modified; a new version
 * is a new schema with a new `schemaId` (schema evolution is a framework
 * concern). Registration validates: no duplicate paths, valid collection kinds,
 * every incorporation-rule `targetPath` exists in `paths`, and no duplicate
 * `objectType` mappings. `schemaId` is an opaque string — two schemas with
 * different ids are unrelated from the kernel's perspective.
 */
export interface TurnTreeSchema {
  incorporationRules: IncorporationRule[];
  paths: PathDefinition[];
  schemaId: string;
}

/**
 * Declaration of one step in a Run's step sequence (kernel spec §5.1).
 *
 * The kernel checkpoints after any step where `!deterministic || sideEffects`.
 * Steps are atomic from the kernel's perspective: a "sometimes deterministic"
 * step must either be declared non-deterministic (over-checkpoint) or be
 * decomposed. The sequence is immutable for the Run's lifetime.
 */
export interface StepDeclaration {
  /**
   * Whether the step's output can be re-derived from the same inputs.
   */
  deterministic: boolean;
  /**
   * Step identity, e.g. `"model_call"`; unique within the step sequence.
   */
  id: string;
  /**
   * Opaque framework-specific metadata; the kernel ignores it.
   */
  metadata?: KernelRecord;
  /**
   * Whether the step causes external state changes.
   */
  sideEffects: boolean;
}

/**
 * Output of a framework observe hook (kernel spec §6.4): `annotations` are
 * persisted durably by the kernel at `run.completeStep`, while `signals` remain
 * ephemeral within the Run and surface in the next {@link StepContext}.
 */
export interface ObserveResult {
  annotations: KernelObject[];
  signals: KernelSignal[];
}

/**
 * Verdict raising no objection; execution continues (kernel spec §6.1).
 */
export interface ProceedVerdict {
  kind: "proceed";
}

/**
 * Verdict stopping the Run with a {@link VerdictDisposition} and a
 * human-readable reason (kernel spec §6.1).
 */
export interface AbortVerdict {
  disposition: VerdictDisposition;
  kind: "abort";
  reason: string;
}

/**
 * Verdict carrying a declarative transform. The framework interprets the
 * transform; the kernel treats it as opaque data and composes multiple
 * transforms in registration order (kernel spec §6.1).
 */
export interface ModifyVerdict {
  kind: "modify";
  transform: KernelRecord;
}

/**
 * Verdict suspending the Run for out-of-band resolution (kernel spec §6.1).
 * `resumptionSchema` is an opaque description of what is needed to resume;
 * resumption starts a new Run from the pause-point TurnNode.
 */
export interface PauseVerdict {
  kind: "pause";
  reason: string;
  resumptionSchema: KernelRecord;
}

/**
 * Verdict requesting re-execution with an opaque adjustment the framework
 * interprets (kernel spec §6.1).
 */
export interface RetryVerdict {
  adjustment: KernelRecord;
  kind: "retry";
}

/**
 * Union of all hook verdicts (kernel spec §6.1), composed by `verdicts.compose`
 * under the fixed first-objection-wins priority
 * `Abort > Pause > Modify > Retry > Proceed` (§6.2).
 */
export type Verdict =
  | AbortVerdict
  | ModifyVerdict
  | PauseVerdict
  | ProceedVerdict
  | RetryVerdict;

/**
 * Result of `verdicts.compose` (kernel spec §6.5). Structurally a
 * {@link Verdict}; the alias marks values that already went through
 * first-objection-wins composition.
 */
export type ComposedVerdict = Verdict;

/**
 * Fields shared by every {@link StagedResult} variant (kernel spec §3.4).
 */
interface BaseStagedResult {
  objectHash: HashString;
  objectType: string;
  taskId: string;
  timestamp: EpochMs;
}

/**
 * StagedResult for interrupted work: carries the opaque payload needed to resume
 * the task (kernel spec §3.4).
 */
export interface InterruptedStagedResult extends BaseStagedResult {
  interruptPayload: KernelRecord;
  status: "interrupted";
}

/**
 * StagedResult for work that reached a settled status (`"completed"` or
 * `"failed"`); never carries an interrupt payload.
 */
export interface SettledStagedResult extends BaseStagedResult {
  interruptPayload?: never;
  status: "completed" | "failed";
}

/**
 * Durable, run-scoped record of work performed between TurnNodes (kernel spec
 * §3.4).
 *
 * Staged results survive process crashes (essential for parallel work within a
 * step) and are consumed — and recorded on the TurnNode — when a checkpoint
 * transaction commits. Identity is `taskId` within the owning Run; concurrent
 * Runs on different Branches have isolated staging.
 */
export type StagedResult = InterruptedStagedResult | SettledStagedResult;

/**
 * One durable point in the history DAG: links a transition to the state root it
 * produced (kernel spec §3.3).
 *
 * Identity is `hash`, computed from the canonical serialization of all fields
 * except `hash` itself (see `hashTurnNodeIdentity` in kernel-identity.ts).
 * TurnNodes are created only by the kernel during checkpoint transactions or
 * reactive checkpointing, and are never modified.
 */
export interface TurnNode {
  /**
   * StagedResults incorporated by the checkpoint that created this node.
   */
  consumedStagedResults: StagedResult[];
  /**
   * Optional opaque framework event Object recording what triggered this
   * checkpoint; `null` when none was provided (kernel spec §5.4).
   */
  eventHash: HashString | null;
  /**
   * Content-address identity of this node.
   */
  hash: HashString;
  /**
   * DAG parent link; `null` only for a Thread's genesis node.
   */
  previousTurnNodeHash: HashString | null;
  /**
   * Schema active when the node was created, so future reads can interpret the
   * TurnTree correctly after schema evolution.
   */
  schemaId: string;
  /**
   * Immutable state root produced by the transition.
   */
  turnTreeHash: HashString;
}

/**
 * Protocol view of a Thread (kernel spec §4.1): a write-once, long-lived
 * container whose `rootTurnNodeHash` anchors all lineage/membership proofs.
 */
export interface ThreadRecord {
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

/**
 * Protocol view of a Branch (kernel spec §4.2): a named, movable pointer to a
 * TurnNode within a Thread. Each Branch has exactly one head — a kernel-enforced
 * invariant.
 */
export interface BranchRecord {
  branchId: string;
  headTurnNodeHash: HashString;
  threadId: string;
}

/**
 * Protocol view of a Turn (kernel spec §5.3): one user-visible interaction unit
 * spanning the contiguous TurnNode segment from `startTurnNodeHash` to
 * `headTurnNodeHash`. A Turn may be served by multiple Runs when execution
 * pauses and resumes.
 */
export interface TurnRecord {
  branchId: string;
  headTurnNodeHash: HashString;
  parentTurnId: string | null;
  startTurnNodeHash: HashString;
  threadId: string;
  turnId: string;
}

/**
 * Protocol view of a Run (kernel spec §5.2): the concrete execution instance
 * that handles a Turn by executing a declared step sequence on a Branch.
 *
 * The optional lease fields (`executionOwnerId`, `fencingToken`,
 * `leaseExpiresAtMs`) are populated only for leased runs created through the
 * {@link RuntimeKernelRunLiveness} surface; they realize the stale-`running`
 * recovery mechanism of kernel spec §5.2 ("Run Execution Leases").
 * `preemptionReason` is recorded durably when an expired run is preempted.
 */
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

/**
 * Context returned by `run.beginStep` (kernel spec §5.8): the current TurnNode
 * hash, the active schema, the step declaration, and signals emitted by observe
 * hooks on earlier steps of the Run.
 */
export interface StepContext {
  currentTurnNodeHash: HashString;
  schema: TurnTreeSchema;
  signals: KernelSignal[];
  step: StepDeclaration;
}

/**
 * State returned by `run.recover` and by stale-run preemption (kernel spec
 * §5.8): everything a replacement execution needs to skip completed work and
 * resume only the unfinished remainder.
 */
export interface RecoveryState {
  /**
   * StagedResults already anchored by the last committed TurnNode.
   */
  consumedStagedResults: StagedResult[];
  /**
   * Identity of the last completed step, or `null` when no step finished.
   */
  lastCompletedStepId: string | null;
  /**
   * Last durably committed TurnNode.
   */
  lastTurnNodeHash: HashString;
  /**
   * The Run's declared step sequence.
   */
  stepSequence: StepDeclaration[];
  /**
   * Durable staged work not yet consumed by a checkpoint transaction.
   */
  uncommittedStagedResults: StagedResult[];
}

/**
 * Proof of current lease possession for a leased `running` Run: the fencing
 * token and the lease expiry timestamp (kernel spec §5.2, "Run Execution
 * Leases").
 */
export interface RunLeaseState {
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
}

/**
 * Result of `run.completeStep` (kernel spec §5.8). `checkpointed` reports
 * whether a checkpoint transaction ran (required when the step declared
 * `!deterministic || sideEffects`); `turnNodeHash` is the TurnNode it created
 * when it did. `lease` carries refreshed lease state for leased runs.
 */
export interface RunStepCompletion {
  checkpointed: boolean;
  lease?: RunLeaseState;
  turnNodeHash?: HashString;
}

/**
 * Result of the atomic Thread bootstrap (kernel spec §4.1): the new Thread, its
 * initial Branch, and the genesis TurnNode / root TurnTree hashes. There are no
 * intermediate invalid moments — the whole structure commits together.
 */
export interface ThreadCreateResult {
  branchId: string;
  rootTurnNodeHash: HashString;
  rootTurnTreeHash: HashString;
  threadId: string;
}

/**
 * Result of `branch.setHead` (kernel spec §4.2). `archiveBranch` is present only
 * for backward moves, where the kernel atomically archives the abandoned segment
 * under a new Branch so no TurnNodes are ever orphaned.
 */
export interface SetHeadResult {
  archiveBranch?: BranchRecord;
  branch: BranchRecord;
}

/**
 * One `branch.list` entry: a `[branchId, headTurnNodeHash]` pair (kernel spec
 * §4.2).
 */
export type BranchHeadListEntry = [
  branchId: string,
  headTurnNodeHash: HashString,
];

/**
 * Durable representation of a content-addressed Object (kernel spec §2.1).
 * Write-once: `hash` is computed from the canonical blob representation and the
 * record is never modified after creation.
 */
export interface StoredObject {
  byteLength: number;
  bytes: Uint8Array;
  createdAtMs: EpochMs;
  hash: HashString;
  mediaType: string;
}

/**
 * Durable representation of a registered {@link TurnTreeSchema} (kernel spec
 * §3.1). `schemaCbor` holds the canonical CBOR encoding of the schema body.
 */
export interface StoredSchema {
  createdAtMs: EpochMs;
  schemaCbor: Uint8Array;
  schemaId: string;
}

/**
 * Durable TurnTree root (kernel spec §3.2). `hash` is computed from the
 * canonical `{ schemaId, manifest }` identity tuple (see `hashTurnTreeIdentity`);
 * `manifestCbor` is the canonical CBOR encoding of the manifest.
 */
export interface StoredTurnTree {
  createdAtMs: EpochMs;
  hash: HashString;
  manifestCbor: Uint8Array;
  schemaId: string;
}

/**
 * Fields shared by every stored TurnTree path row.
 */
interface BaseStoredTurnTreePath {
  path: string;
  turnTreeHash: HashString;
}

/**
 * Stored value of a `"single"` collection path: at most one Object hash, `null`
 * when the path is empty.
 */
export interface StoredSingleTurnTreePath extends BaseStoredTurnTreePath {
  collectionKind: "single";
  orderedChunkListCbor?: never;
  orderedCount?: never;
  orderedEncoding?: never;
  orderedInlineCbor?: never;
  singleHash: HashString | null;
}

/**
 * Stored value of an `"ordered"` path whose hash list is inlined as a single
 * canonical CBOR array (`orderedEncoding: "flat"`).
 */
export interface StoredFlatOrderedTurnTreePath extends BaseStoredTurnTreePath {
  collectionKind: "ordered";
  orderedChunkListCbor?: never;
  orderedCount: number;
  orderedEncoding: "flat";
  orderedInlineCbor: Uint8Array;
  singleHash?: never;
}

/**
 * Stored value of an `"ordered"` path whose hash list is split into
 * content-addressed chunks (`orderedEncoding: "chunked"`).
 * `orderedChunkListCbor` records the ordered chunk hashes; each chunk row is a
 * {@link StoredOrderedPathChunk}.
 */
export interface StoredChunkedOrderedTurnTreePath
  extends BaseStoredTurnTreePath {
  collectionKind: "ordered";
  orderedChunkListCbor: Uint8Array;
  orderedCount: number;
  orderedEncoding: "chunked";
  orderedInlineCbor?: never;
  singleHash?: never;
}

/**
 * Discriminated union of stored TurnTree path encodings, keyed by
 * `collectionKind` and `orderedEncoding`.
 */
export type StoredTurnTreePath =
  | StoredChunkedOrderedTurnTreePath
  | StoredFlatOrderedTurnTreePath
  | StoredSingleTurnTreePath;

/**
 * Content-addressed chunk holding a contiguous slice of an ordered path's hash
 * list; `itemsCbor` is the canonical CBOR array of the slice and `chunkHash` its
 * content address, enabling structural sharing of unchanged prefixes.
 */
export interface StoredOrderedPathChunk {
  chunkHash: HashString;
  createdAtMs: EpochMs;
  itemCount: number;
  itemsCbor: Uint8Array;
}

/**
 * Durable representation of a {@link TurnNode} (kernel spec §3.3).
 * `consumedStagedResultsCbor` holds the canonical CBOR encoding of the consumed
 * StagedResults.
 */
export interface StoredTurnNode {
  consumedStagedResultsCbor: Uint8Array;
  createdAtMs: EpochMs;
  eventHash: HashString | null;
  hash: HashString;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnTreeHash: HashString;
}

/**
 * Durable observe-hook annotation persisted at `run.completeStep` (kernel spec
 * §6.4), identified by the annotation Object's content hash within its Run.
 * `turnNodeHash` links the annotation to the checkpoint TurnNode it was anchored
 * to, or is `null` when no checkpoint accompanied the step.
 */
export interface StoredObserveAnnotation {
  annotationCbor: Uint8Array;
  annotationHash: HashString;
  createdAtMs: EpochMs;
  runId: string;
  turnNodeHash: HashString | null;
}

/**
 * Durable representation of a Thread (kernel spec §4.1). Write-once.
 */
export interface StoredThread {
  createdAtMs: EpochMs;
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

/**
 * Durable representation of a Branch (kernel spec §4.2).
 * `archivedFromBranchId` is set only on archive Branches created by a backward
 * `branch.setHead`, naming the Branch whose abandoned segment they preserve.
 */
export interface StoredBranch {
  archivedFromBranchId?: string;
  branchId: string;
  createdAtMs: EpochMs;
  headTurnNodeHash: HashString;
  threadId: string;
  updatedAtMs: EpochMs;
}

/**
 * Durable representation of a Turn (kernel spec §5.3). `headTurnNodeHash`
 * advances via `turn.updateHead` as TurnNodes are created.
 */
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

/**
 * Durable representation of a Run (kernel spec §5.2). `stepSequenceCbor`,
 * `createdTurnNodesCbor`, and `pendingSignalsCbor` hold canonical CBOR encodings
 * of the step sequence, created TurnNode hashes, and observe signals pending
 * delivery to the next step. Lease fields mirror {@link RunRecord}.
 */
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

/**
 * Fields shared by every stored StagedResult variant (kernel spec §3.4).
 */
interface BaseStoredStagedResult {
  createdAtMs: EpochMs;
  objectHash: HashString;
  objectType: string;
  runId: string;
  taskId: string;
}

/**
 * Stored StagedResult for interrupted work; `interruptPayloadCbor` is the
 * canonical CBOR encoding of the resume payload.
 */
export interface InterruptedStoredStagedResult extends BaseStoredStagedResult {
  interruptPayloadCbor: Uint8Array;
  status: "interrupted";
}

/**
 * Stored StagedResult for settled work (`"completed"` or `"failed"`); never
 * carries an interrupt payload.
 */
export interface SettledStoredStagedResult extends BaseStoredStagedResult {
  interruptPayloadCbor?: never;
  status: "completed" | "failed";
}

/**
 * Durable representation of a {@link StagedResult}, keyed by `(runId, taskId)`
 * (kernel spec §3.4).
 */
export type StoredStagedResult =
  | InterruptedStoredStagedResult
  | SettledStoredStagedResult;

/**
 * Content-addressed Object storage (kernel spec §2.4, §8.1). `put` is write-once
 * and idempotent: storing identical content twice yields the same hash with no
 * conflict — load-bearing for crash recovery, where re-executing a step that
 * produces identical output is harmless.
 */
export interface ObjectRepository {
  get(hash: HashString): Promise<StoredObject | null>;
  has(hash: HashString): Promise<boolean>;
  put(record: StoredObject): Promise<void>;
}

/**
 * Durable storage for registered schemas, keyed by `schemaId` (kernel spec
 * §3.1). Schema records are write-once.
 */
export interface SchemaRepository {
  get(schemaId: string): Promise<StoredSchema | null>;
  put(record: StoredSchema): Promise<void>;
}

/**
 * Durable storage for TurnTree roots, keyed by content hash (kernel spec §3.2).
 */
export interface TurnTreeRepository {
  get(hash: HashString): Promise<StoredTurnTree | null>;
  put(record: StoredTurnTree): Promise<void>;
}

/**
 * Durable storage for per-tree path rows (kernel spec §3.2). `putMany` persists
 * all path rows of a TurnTree together; `listByTurnTree` returns every path row
 * of one tree.
 */
export interface TurnTreePathRepository {
  get(
    turnTreeHash: HashString,
    path: string
  ): Promise<StoredTurnTreePath | null>;
  listByTurnTree(turnTreeHash: HashString): Promise<StoredTurnTreePath[]>;
  putMany(records: StoredTurnTreePath[]): Promise<void>;
}

/**
 * Durable storage for ordered-path chunks, keyed by content hash.
 */
export interface OrderedPathChunkRepository {
  get(chunkHash: HashString): Promise<StoredOrderedPathChunk | null>;
  put(record: StoredOrderedPathChunk): Promise<void>;
}

/**
 * Durable storage for history-DAG nodes, keyed by content hash (kernel spec
 * §3.3).
 */
export interface TurnNodeRepository {
  get(hash: HashString): Promise<StoredTurnNode | null>;
  put(record: StoredTurnNode): Promise<void>;
}

/**
 * Durable storage for observe-hook annotations (kernel spec §6.4), listed per
 * Run.
 */
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

/**
 * Durable storage for Threads (kernel spec §4.1). Thread records are
 * write-once. `list` is optional and capability-gated — see its own
 * documentation.
 */
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

/**
 * Durable storage for Branches (kernel spec §4.2). `set` both creates Branch
 * records and moves heads; head movement legality is enforced by the kernel
 * above this repository.
 */
export interface BranchRepository {
  get(branchId: string): Promise<StoredBranch | null>;
  listByThread(threadId: string): Promise<StoredBranch[]>;
  set(record: StoredBranch): Promise<void>;
}

/**
 * Durable storage for Turns (kernel spec §5.3). `set` both creates Turn records
 * and advances `headTurnNodeHash`.
 */
export interface TurnRepository {
  get(turnId: string): Promise<StoredTurn | null>;
  listByThread(threadId: string): Promise<StoredTurn[]>;
  set(record: StoredTurn): Promise<void>;
}

/**
 * Durable storage for Runs (kernel spec §5.2). `listExpired` returns leased
 * `running` runs whose lease has expired as of `nowMs`, supporting
 * stale-running preemption.
 */
export interface RunRepository {
  get(runId: string): Promise<StoredRun | null>;
  listByBranch(branchId: string): Promise<StoredRun[]>;
  listExpired(nowMs: EpochMs): Promise<StoredRun[]>;
  set(record: StoredRun): Promise<void>;
}

/**
 * Durable run-scoped staging state (kernel spec §3.4), keyed by
 * `(runId, taskId)`. `clearRun` empties a Run's staging after a checkpoint
 * transaction consumes it.
 */
export interface StagedResultRepository {
  clearRun(runId: string): Promise<void>;
  get(runId: string, taskId: string): Promise<StoredStagedResult | null>;
  listByRun(runId: string): Promise<StoredStagedResult[]>;
  set(record: StoredStagedResult): Promise<void>;
}

/**
 * Repository bundle visible inside one backend transaction (kernel spec §8.1).
 *
 * The kernel performs every durable mutation through
 * {@link RuntimeBackend.transact}, which supplies this bundle; all writes made
 * through it become visible together on commit or not at all. That atomicity is
 * what realizes `staging.stage` and the checkpoint transaction of kernel spec
 * §5.5.
 */
export interface RuntimeBackendTx {
  branches: BranchRepository;
  /**
   * Per-transaction authoritative clock (epoch ms). Backends that advertise the
   * `shared-lease-clock` BackendCapability expose the backend's own clock here so
   * the kernel can stamp and compare run-lease expiry in backend time within the
   * transaction (ADR-050, kernel spec §5.2). Backends that do not advertise
   * shared-lease-clock MAY omit it; the kernel falls back to its injected clock
   * for those backends.
   */
  now?(): EpochMs;
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
   * Backend supports the capability-gated reachability reclamation primitive
   * (KrakenKernelSpecification §9.4). When `true`, the backend implements the
   * reclamation backing operation the kernel drives to mark durable state
   * reachable from live roots — non-archived branch heads, thread roots, and
   * active-run staged work — within the constructing Scope and sweep only the
   * unreachable remainder, grace-windowed against the oldest active execution
   * lease. When `false` or absent, the kernel rejects reclamation with
   * `TuvrenPersistenceError` code `kernel_capability_unsupported`. Object-store
   * substrates that reclaim out of band advertise non-support. Adding this bit
   * is a semver-minor change (§9.1).
   */
  readonly "maintenance.reclamation"?: boolean;
  /**
   * Backend can serve as the authoritative shared lease clock for a deployment
   * with more than one execution owner (ADR-050, KrakenKernelSpecification
   * §5.2). When `true`, the kernel stamps and compares run-lease expiry against
   * the backend's own per-transaction clock (exposed via `RuntimeBackendTx.now`)
   * instead of an execution owner's wall clock, eliminating split-brain
   * preemption under owner clock skew. Single-writer embedded backends advertise
   * `false` (or omit it) and keep the in-process clock because no cross-owner
   * contention exists. Adding this bit is a semver-minor change (§9.1).
   */
  readonly "shared-lease-clock"?: boolean;
  /**
   * Backend supports efficient thread enumeration via ThreadRepository.list.
   * Required for hosts that consume TuvrenRuntime.listThreads.
   */
  readonly "thread.enumeration": boolean;
  /** Reserved for future capability bits. */
  readonly [extraCapability: string]: boolean | undefined;
}

/**
 * Options for the capability-gated reachability reclamation primitive (§9.4).
 */
export interface ReclamationOptions {
  /**
   * Clock reference (epoch ms) a backend consults while evaluating the grace
   * window. The kernel supplies its own `now()` so any wall-clock comparison
   * stays consistent with the rest of the syscall surface. The grace horizon's
   * pinning value is still derived structurally from the constructing Scope's
   * own active runs (the oldest active execution lease / in-flight write
   * horizon): every reference backend retains everything at or after that
   * horizon. `nowMs` is consulted only to decide whether a leaseless running
   * run (no executionOwnerId/fencingToken/leaseExpiresAtMs) whose updatedAtMs
   * has gone quiet for at least the administrative leaseless-expiry horizon
   * (KRT-BK002, ADR-050/ADR-051) should be excluded from pinning the grace
   * horizon — treating it as abandoned by a crashed/disconnected creator so it
   * no longer blocks reclamation of state created after it. That run's own
   * reachable lineage stays fully protected regardless, via the independent
   * active-run live-root closure.
   */
  nowMs?: EpochMs;
}

/**
 * Result of a reclamation sweep (§9.4). Counts the durable state released and
 * retained within the constructing Scope. Released state is unreachable from
 * live roots (non-archived branch heads, thread roots, active-run staged work)
 * and older than the grace horizon; everything reachable or within the grace
 * window is retained.
 */
export interface ReclamationSummary {
  releasedArchivedBranchCount: number;
  releasedObjectCount: number;
  releasedOrderedPathChunkCount: number;
  releasedRunCount: number;
  releasedTurnCount: number;
  releasedTurnNodeCount: number;
  releasedTurnTreeCount: number;
  retainedObjectCount: number;
}

/**
 * Durable storage backend contract the kernel drives (kernel spec §8.1).
 *
 * A backend supplies transactional access to the kernel's repositories plus a
 * capability descriptor for the optional, capability-gated syscalls (§9). The
 * contract is behavioral, not technological: any substrate qualifies if atomic
 * single- and multi-entity writes, durable visibility, and read-after-write
 * consistency hold at this surface. Hash resolution is confined to the Scope the
 * backend was constructed against (§2.3) — the kernel can never observe content
 * outside the constructing Scope.
 */
export interface RuntimeBackend {
  /**
   * Returns the backend's capability descriptor, computed at construction and
   * consulted by the kernel on the dispatch path of every capability-gated
   * syscall (kernel spec §9.1). Must be honest: advertising a capability without
   * implementing its backing method correctly is a backend bug.
   */
  capabilities(): BackendCapability;
  /**
   * Probes the durable substrate. Returns `{ ok: true }` when the backend can
   * serve traffic, otherwise `{ ok: false }` with a human-readable reason.
   */
  health(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Optional substrate partition drop for full tenant offboarding (§9.4: "full
   * tenant offboarding is dropping the Scope partition ... a substrate/edge
   * concern outside the kernel"). Removes the constructing Scope's entire
   * durable partition — not only the unreachable remainder a reclamation sweep
   * releases. This is deliberately NOT a kernel syscall and has no
   * `RuntimeKernel` projection or operation-count contribution; the framework
   * maintenance surface invokes it directly against the durable backend.
   * Crypto-shredding erasure remains a separate host action (destroying the
   * Scope's payload keys); this drops the residual ciphertext partition.
   * After it resolves the backend instance MAY be unusable and callers MUST NOT
   * reuse it: a backend is free to release its substrate handle (the SQLite
   * backend closes its connection and removes the file) rather than re-create an
   * empty partition. Offboarding hosts discard the backend after the drop.
   * Backends that cannot drop a partition omit it.
   */
  purgeScope?(): Promise<void>;
  /**
   * Optional reachability reclamation backing operation (§9.4). Implemented
   * only by backends advertising `maintenance.reclamation: true`; backends that
   * advertise non-support must not implement it (§9.1). Marks durable state
   * reachable from live roots within the constructing Scope and atomically
   * sweeps only the unreachable remainder, grace-windowed against the oldest
   * active execution lease so reclamation can never race recovery. Never edits
   * committed lineage or alters a reachable Object.
   */
  reclaim?(options?: ReclamationOptions): Promise<ReclamationSummary>;
  /**
   * Runs `work` inside one atomic transaction. Every repository write performed
   * through the supplied {@link RuntimeBackendTx} becomes visible together on
   * commit, or not at all when `work` rejects (kernel spec §8.1).
   */
  transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T>;
}

/**
 * ADR-034: opaque cursor token for thread.list pagination at the kernel
 * protocol level. Internally encodes (lastCreatedAtMs, lastThreadId) as a
 * URL-safe base64 JSON payload; callers treat it as an opaque string.
 */
export type KernelThreadListCursor = string;

/**
 * The kernel syscall surface: 30 operations across 10 groups
 * (docs/KrakenKernelSpecification.md §7), plus the capability-gated
 * `maintenance` group (§9.4).
 *
 * This is the cross-language kernel boundary contract (§1.1): everything that
 * crosses it is data — serializable, schema-driven, inspectable. The kernel
 * never calls back into the framework, and every run-scoped operation carries an
 * explicit `runId`; there is no ambient execution state. Per-operation
 * preconditions and rejection rules are enumerated in kernel spec Appendix B.
 */
export interface RuntimeKernel {
  /**
   * Branch operations (kernel spec §4.2): creation from a lineage-validated
   * TurnNode, lookup, head movement with forward/backward/lateral direction rules
   * (lateral is rejected; backward archives the abandoned segment), and per-thread
   * head listing.
   */
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
  /**
   * Capability-gated maintenance operations (kernel spec §9.4).
   */
  maintenance: {
    /**
     * §9.4: capability-gated reachability reclamation. Rejects with
     * TuvrenPersistenceError code "kernel_capability_unsupported" when the
     * backend does not advertise maintenance.reclamation. Releases durable
     * state unreachable from live roots (non-archived branch heads, thread
     * roots, active-run staged work) within the constructing Scope, sweeping
     * only the unreachable remainder and never releasing state newer than the
     * oldest active execution lease.
     */
    reclaim(options?: ReclamationOptions): Promise<ReclamationSummary>;
  };
  /**
   * Read-only history-DAG access (kernel spec §3.3). `walkBack` follows
   * `previousTurnNodeHash` links linearly toward the Thread root; TurnNode
   * creation is kernel-internal via `run.completeStep` / `run.complete`.
   */
  node: {
    get(hash: HashString): Promise<TurnNode | null>;
    walkBack(fromHash: HashString): AsyncIterable<TurnNode>;
  };
  /**
   * Run lifecycle (kernel spec §5.8): creation with full legality validation
   * (Appendix A), step begin/complete with declarative checkpointing, terminal
   * completion with reactive checkpointing of un-anchored staged work, and crash
   * recovery via {@link RecoveryState}.
   */
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
  /**
   * TurnTreeSchema registration and lookup (kernel spec §3.1). Registration is
   * write-once and validated; schema evolution means a new `schemaId`.
   */
  schema: {
    register(schema: TurnTreeSchema): Promise<string>;
    get(schemaId: string): Promise<TurnTreeSchema | null>;
  };
  /**
   * Durable run-scoped staging (kernel spec §3.4). `stage` atomically writes the
   * Object to the content-addressed store AND appends the StagedResult to the
   * Run's durable staging state; `current` lists un-anchored results (empty after
   * a checkpoint or at Run start).
   */
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
  /**
   * Content-addressed Object store (kernel spec §2.4). `put` is write-once and
   * idempotent; `get`/`has` resolve only within the constructing Scope (§2.3).
   */
  store: {
    put(blob: Uint8Array, mediaType?: string): Promise<HashString>;
    get(hash: HashString): Promise<Uint8Array | null>;
    has(hash: HashString): Promise<boolean>;
  };
  /**
   * Thread bootstrap and lookup (kernel spec §4.1), plus capability-gated
   * enumeration (ADR-034, §9.2). `create` atomically registers the Thread, builds
   * the empty root TurnTree, creates the genesis TurnNode, and creates the initial
   * Branch pointing at it.
   */
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
  /**
   * TurnTree construction and inspection (kernel spec §3.2): schema-driven
   * `create` with base-tree inheritance and structural sharing, rule-driven
   * `incorporate` of staged results, structural `diff` (same-schema trees only),
   * per-path `resolve`, and full `manifest` dumps.
   */
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
  /**
   * Turn lifecycle (kernel spec §5.3). `updateHead` validates that the new head is
   * a descendant of the Turn's `startTurnNodeHash` by lineage walk.
   */
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
  /**
   * Pure verdict composition under the fixed priority
   * `Abort > Pause > Modify > Retry > Proceed` (kernel spec §6). Hook
   * registration, execution, and timeouts are framework concerns; the kernel only
   * composes.
   */
  verdicts: {
    compose(verdicts: Verdict[]): Promise<ComposedVerdict>;
  };
}

/**
 * Optional run-liveness extension of the kernel surface implementing execution
 * leases and stale-`running` preemption (kernel spec §5.2, "Run Execution
 * Leases" / "Stale Running Preemption").
 *
 * - `createLeasedRun` creates a `running` Run bound to an execution owner with a
 *   lease expiry and fencing token.
 * - `renewLease` extends possession only for the current owner/token pair and
 *   only while the Run remains `running`.
 * - `listExpired` enumerates `running` Runs whose lease has expired as of
 *   `nowMs`.
 * - `preemptExpired` atomically verifies expiry, fences the stale owner,
 *   preserves verifiably complete staged work via the reactive-checkpoint rule,
 *   marks the superseded Run `failed` with a durable reason, and returns
 *   {@link RecoveryState} for creating a replacement Run — reopening the stale
 *   Run is illegal.
 */
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
