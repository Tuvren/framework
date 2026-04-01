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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  EpochMs,
  HashString,
  KernelRecord,
} from "@kraken/shared-core-types";

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
  annotations: KernelRecord[];
  signals: KernelRecord[];
}

export interface StagedResult {
  interruptPayload?: KernelRecord;
  objectHash: HashString;
  objectType: string;
  status: StagedResultStatus;
  taskId: string;
  timestamp: EpochMs;
}

export interface TurnNode {
  consumedStagedResults: StagedResult[];
  createdAtMs?: EpochMs;
  eventHash: HashString | null;
  hash: HashString;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnTreeHash: HashString;
}

export interface ThreadRecord {
  createdAtMs?: EpochMs;
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

export interface BranchRecord {
  archivedFromBranchId?: string;
  branchId: string;
  createdAtMs?: EpochMs;
  headTurnNodeHash: HashString;
  threadId: string;
  updatedAtMs?: EpochMs;
}

export interface TurnRecord {
  branchId: string;
  createdAtMs?: EpochMs;
  headTurnNodeHash: HashString;
  parentTurnId: string | null;
  startTurnNodeHash: HashString;
  threadId: string;
  turnId: string;
  updatedAtMs?: EpochMs;
}

export interface RunRecord {
  branchId: string;
  createdAtMs?: EpochMs;
  createdTurnNodes: HashString[];
  currentStepIndex: number;
  runId: string;
  schemaId: string;
  startTurnNodeHash: HashString;
  status: RunStatus;
  stepSequence: StepDeclaration[];
  turnId: string;
  updatedAtMs?: EpochMs;
}

export interface StepContext {
  currentTurnNodeHash: HashString;
  schema: TurnTreeSchema;
  signals: KernelRecord[];
  step: StepDeclaration;
}

export interface RecoveryState {
  consumedStagedResults: StagedResult[];
  lastCompletedStepId: string | null;
  lastTurnNodeHash: HashString;
  stepSequence: StepDeclaration[];
  uncommittedStagedResults: StagedResult[];
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

export interface StoredTurnTreePath {
  collectionKind: PathCollectionKind;
  orderedChunkListCbor?: Uint8Array;
  orderedCount?: number;
  orderedEncoding?: "flat" | "chunked";
  orderedInlineCbor?: Uint8Array;
  path: string;
  singleHash?: HashString | null;
  turnTreeHash: HashString;
}

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
  runId: string;
  schemaId: string;
  startTurnNodeHash: HashString;
  status: RunStatus;
  stepSequenceCbor: Uint8Array;
  turnId: string;
  updatedAtMs: EpochMs;
}

export interface StoredStagedResult {
  createdAtMs: EpochMs;
  interruptPayloadCbor?: Uint8Array;
  objectHash: HashString;
  objectType: string;
  runId: string;
  status: StagedResultStatus;
  taskId: string;
}

export interface KrakenKernel {
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
    ): Promise<{ checkpointed: boolean; turnNodeHash?: HashString }>;
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
}
