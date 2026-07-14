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

import { create } from "@bufbuild/protobuf";
import {
  assertHashString,
  assertKernelRecord,
  type EpochMs,
  type HashString,
  type KernelObject,
  type KernelRecord,
  TuvrenRuntimeError,
} from "@tuvren/core";
import {
  assertBranchHeadListEntry,
  assertBranchRecord,
  assertComposedVerdict,
  assertPathValue,
  assertRecoveryState,
  assertRunRecord,
  assertSetHeadResult,
  assertStagedResult,
  assertStepContext,
  assertStepDeclaration,
  assertThreadCreateResult,
  assertThreadRecord,
  assertTurnNode,
  assertTurnRecord,
  assertTurnTreeSchema,
  assertVerdict,
  type BranchHeadListEntry,
  type BranchRecord,
  type ComposedVerdict,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  type ObserveResult,
  type PathCollectionKind,
  type PathValue,
  type RecoveryState,
  type RunCompletionStatus,
  type RunRecord,
  type SetHeadResult,
  type StagedResult,
  type StagedResultStatus,
  type StepContext,
  type StepDeclaration,
  type StoredThread,
  type ThreadCreateResult,
  type ThreadRecord,
  type TurnNode,
  type TurnRecord,
  type TurnTreeChangeSet,
  type TurnTreeManifest,
  type TurnTreeSchema,
  type Verdict,
  type VerdictDisposition,
} from "@tuvren/kernel-protocol";
import type {
  BranchListResponse,
  TreeManifestResponse,
} from "./generated/kernel-interop/tuvren/kernel/interop/v1/kernel_services_pb";
import type { StoredThreadEntry as ProtoStoredThreadEntry } from "./generated/kernel-interop/tuvren/kernel/interop/v1/kernel_types_pb";
import {
  ObserveResultSchema,
  PathValueEntrySchema,
  PathValueSchema,
  type BranchHeadListEntry as ProtoBranchHeadListEntry,
  type BranchRecord as ProtoBranchRecord,
  PathCollectionKind as ProtoPathCollectionKind,
  type PathValue as ProtoPathValue,
  type RecoveryState as ProtoRecoveryState,
  RunCompletionStatus as ProtoRunCompletionStatus,
  type RunRecord as ProtoRunRecord,
  RunStatus as ProtoRunStatus,
  type SetHeadResult as ProtoSetHeadResult,
  type StagedResult as ProtoStagedResult,
  StagedResultStatus as ProtoStagedResultStatus,
  type StepContext as ProtoStepContext,
  type StepDeclaration as ProtoStepDeclaration,
  type ThreadCreateResult as ProtoThreadCreateResult,
  type ThreadRecord as ProtoThreadRecord,
  type TurnNode as ProtoTurnNode,
  type TurnRecord as ProtoTurnRecord,
  type TurnTreeSchema as ProtoTurnTreeSchema,
  type Verdict as ProtoVerdict,
  VerdictDisposition as ProtoVerdictDisposition,
  StagedResultSchema,
  StepDeclarationSchema,
  TurnTreeSchemaSchema,
  VerdictSchema,
} from "./generated/kernel-interop/tuvren/kernel/interop/v1/kernel_types_pb";

/**
 * Decodes a required protobuf `BranchRecord` field into its protocol
 * {@link BranchRecord} shape, validating the result.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   when `value` is `undefined` (from {@link createInvalidTransportResponseError}).
 */
export function requireBranchRecord(
  value: ProtoBranchRecord | undefined,
  label: string
): BranchRecord {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.branch`);
  }

  const record: BranchRecord = {
    branchId: value.branchId,
    headTurnNodeHash: value.headTurnNodeHash,
    threadId: value.threadId,
  };
  assertBranchRecord(record, label);
  return record;
}

/**
 * Decodes a protobuf branch head list entry into the tuple-shaped protocol
 * {@link BranchHeadListEntry}, validating the result.
 */
export function requireBranchHeadListEntry(
  value: ProtoBranchHeadListEntry,
  label: string
): BranchHeadListEntry {
  const entry: BranchHeadListEntry = [value.branchId, value.headTurnNodeHash];
  assertBranchHeadListEntry(entry, label);
  return entry;
}

/**
 * Decodes a required protobuf `Verdict` field and asserts it is a valid
 * {@link ComposedVerdict} — the shape `verdicts.compose` returns
 * (structurally identical to `Verdict`; composition does not narrow it).
 */
export function requireComposedVerdict(
  value: ProtoVerdict | undefined,
  label: string
): ComposedVerdict {
  const verdict = requireVerdict(value, label);
  assertComposedVerdict(verdict, label);
  return verdict;
}

/**
 * Decodes a required protobuf `PathValue` field into a protocol
 * {@link PathValue}, validating the result.
 */
export function requirePathValue(
  value: ProtoPathValue | undefined,
  label: string
): PathValue {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.value`);
  }

  const decoded = fromProtoPathValue(value, label);
  assertPathValue(decoded, label);
  return decoded;
}

/**
 * Decodes a required protobuf `RecoveryState` field into a protocol
 * {@link RecoveryState}, recursively decoding its staged results and step
 * sequence.
 */
export function requireRecoveryState(
  value: ProtoRecoveryState | undefined,
  label: string
): RecoveryState {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.recoveryState`);
  }

  const decoded: RecoveryState = {
    consumedStagedResults: value.consumedStagedResults.map((result, index) =>
      fromProtoStagedResult(result, `${label}.consumedStagedResults[${index}]`)
    ),
    lastCompletedStepId: value.lastCompletedStepId ?? null,
    lastTurnNodeHash: value.lastTurnNodeHash,
    stepSequence: value.stepSequence.map((step, index) =>
      fromProtoStepDeclaration(step, `${label}.stepSequence[${index}]`)
    ),
    uncommittedStagedResults: value.uncommittedStagedResults.map(
      (result, index) =>
        fromProtoStagedResult(
          result,
          `${label}.uncommittedStagedResults[${index}]`
        )
    ),
  };
  assertRecoveryState(decoded, label);
  return decoded;
}

/**
 * Decodes a required protobuf `RunRecord` field into a protocol
 * {@link RunRecord}, validating hash fields, `status`, and each declared
 * step.
 */
export function requireRunRecord(
  value: ProtoRunRecord | undefined,
  label: string
): RunRecord {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.run`);
  }

  const record: RunRecord = {
    branchId: value.branchId,
    createdTurnNodes: value.createdTurnNodes.map((hash, index) => {
      assertHashString(hash, `${label}.createdTurnNodes[${index}]`);
      return hash;
    }),
    currentStepIndex: value.currentStepIndex,
    runId: value.runId,
    schemaId: value.schemaId,
    startTurnNodeHash: value.startTurnNodeHash,
    status: fromProtoRunStatus(value.status, `${label}.status`),
    stepSequence: value.stepSequence.map((step, index) =>
      fromProtoStepDeclaration(step, `${label}.stepSequence[${index}]`)
    ),
    turnId: value.turnId,
  };
  assertRunRecord(record, label);
  return record;
}

/**
 * Decodes a required protobuf `SetHeadResult` field into a protocol
 * {@link SetHeadResult}, including the optional `archiveBranch` produced by
 * a backward head movement.
 */
export function requireSetHeadResult(
  value: ProtoSetHeadResult | undefined,
  label: string
): SetHeadResult {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.result`);
  }

  const result: SetHeadResult = {
    branch: requireBranchRecord(value.branch, `${label}.branch`),
    ...(value.archiveBranch === undefined
      ? {}
      : {
          archiveBranch: requireBranchRecord(
            value.archiveBranch,
            `${label}.archiveBranch`
          ),
        }),
  };
  assertSetHeadResult(result, label);
  return result;
}

/**
 * Decodes a required protobuf `StagedResult` field into a protocol
 * {@link StagedResult} ({@link fromProtoStagedResult}), validating the
 * result.
 */
export function requireStagedResult(
  value: ProtoStagedResult | undefined,
  label: string
): StagedResult {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.stagedResult`);
  }

  const result = fromProtoStagedResult(value, label);
  assertStagedResult(result, label);
  return result;
}

/**
 * Decodes a required protobuf `StepContext` field into a protocol
 * {@link StepContext}, decoding its schema, pending signals, and step
 * declaration.
 */
export function requireStepContext(
  value: ProtoStepContext | undefined,
  label: string
): StepContext {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.context`);
  }

  const context: StepContext = {
    currentTurnNodeHash: value.currentTurnNodeHash,
    schema: requireTurnTreeSchema(value.schema, `${label}.schema`),
    signals: value.signalsCbor.map((signal, index) =>
      decodeKernelRecordBytes(signal, `${label}.signals[${index}]`)
    ),
    step: fromProtoStepDeclaration(value.step, `${label}.step`),
  };
  assertStepContext(context, label);
  return context;
}

/**
 * Decodes a required protobuf `ThreadCreateResult` field into a protocol
 * {@link ThreadCreateResult}, validating the result.
 */
export function requireThreadCreateResult(
  value: ProtoThreadCreateResult | undefined,
  label: string
): ThreadCreateResult {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.result`);
  }

  const result: ThreadCreateResult = {
    branchId: value.branchId,
    rootTurnNodeHash: value.rootTurnNodeHash,
    rootTurnTreeHash: value.rootTurnTreeHash,
    threadId: value.threadId,
  };
  assertThreadCreateResult(result, label);
  return result;
}

/**
 * Decodes a required protobuf `ThreadRecord` field into a protocol
 * {@link ThreadRecord}, validating the result.
 */
export function requireThreadRecord(
  value: ProtoThreadRecord | undefined,
  label: string
): ThreadRecord {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.thread`);
  }

  const record: ThreadRecord = {
    rootTurnNodeHash: value.rootTurnNodeHash,
    schemaId: value.schemaId,
    threadId: value.threadId,
  };
  assertThreadRecord(record, label);
  return record;
}

/**
 * Decodes a protobuf stored-thread list entry (from a `thread.list` page)
 * into a protocol {@link StoredThread}. Unlike the `require*` decoders in
 * this file, does not assert the result — the stream/list transport shape
 * carries required fields non-optionally.
 */
export function fromStoredThreadEntry(
  value: ProtoStoredThreadEntry,
  label: string
): StoredThread {
  const createdAtMs = fromProtoEpochMs(
    value.createdAtMs,
    `${label}.createdAtMs`
  );
  const thread: StoredThread = {
    threadId: value.threadId,
    schemaId: value.schemaId,
    rootTurnNodeHash: value.rootTurnNodeHash,
    createdAtMs,
  };
  return thread;
}

/**
 * Decodes a required protobuf `TurnNode` field into a protocol
 * {@link TurnNode}, decoding its consumed staged results.
 */
export function requireTurnNode(
  value: ProtoTurnNode | undefined,
  label: string
): TurnNode {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.node`);
  }

  const node: TurnNode = {
    consumedStagedResults: value.consumedStagedResults.map((result, index) =>
      fromProtoStagedResult(result, `${label}.consumedStagedResults[${index}]`)
    ),
    eventHash: value.eventHash ?? null,
    hash: value.hash,
    previousTurnNodeHash: value.previousTurnNodeHash ?? null,
    schemaId: value.schemaId,
    turnTreeHash: value.turnTreeHash,
  };
  assertTurnNode(node, label);
  return node;
}

/**
 * Decodes a required protobuf `TurnRecord` field into a protocol
 * {@link TurnRecord}, validating the result.
 */
export function requireTurnRecord(
  value: ProtoTurnRecord | undefined,
  label: string
): TurnRecord {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.turn`);
  }

  const record: TurnRecord = {
    branchId: value.branchId,
    headTurnNodeHash: value.headTurnNodeHash,
    parentTurnId: value.parentTurnId ?? null,
    startTurnNodeHash: value.startTurnNodeHash,
    threadId: value.threadId,
    turnId: value.turnId,
  };
  assertTurnRecord(record, label);
  return record;
}

/**
 * Decodes a required protobuf `TurnTreeSchema` field into a protocol
 * {@link TurnTreeSchema} ({@link fromProtoTurnTreeSchema}), validating the
 * result.
 */
export function requireTurnTreeSchema(
  value: ProtoTurnTreeSchema | undefined,
  label: string
): TurnTreeSchema {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.schema`);
  }

  const schema = fromProtoTurnTreeSchema(value, label);
  assertTurnTreeSchema(schema, label);
  return schema;
}

/**
 * Decodes a required protobuf `Verdict` field into a protocol
 * {@link Verdict} ({@link fromProtoVerdict}), validating the result.
 */
export function requireVerdict(
  value: ProtoVerdict | undefined,
  label: string
): Verdict {
  if (value === undefined) {
    throw createInvalidTransportResponseError(`${label}.verdict`);
  }

  const verdict = fromProtoVerdict(value, label);
  assertVerdict(verdict, label);
  return verdict;
}

/**
 * Decodes a `branch.list` gRPC response into the protocol's
 * {@link BranchHeadListEntry} array.
 */
export function fromBranchHeadListEntries(
  response: BranchListResponse,
  label: string
): BranchHeadListEntry[] {
  return response.entries.map((entry, index) =>
    requireBranchHeadListEntry(entry, `${label}.entries[${index}]`)
  );
}

/**
 * Decodes a `tree.manifest` gRPC response's path/value entries into a
 * protocol {@link TurnTreeManifest}.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   when the response repeats the same manifest path.
 */
export function fromProtoManifestEntries(
  response: TreeManifestResponse,
  label: string
): TurnTreeManifest {
  const manifest: TurnTreeManifest = {};

  for (const [index, entry] of response.entries.entries()) {
    if (entry.path in manifest) {
      throw new TuvrenRuntimeError(
        `duplicate transport manifest path "${entry.path}"`,
        {
          code: "invalid_kernel_transport_response",
          details: { index, label, path: entry.path },
        }
      );
    }

    manifest[entry.path] = requirePathValue(
      entry.value,
      `${label}.entries[${index}]`
    );
  }

  return manifest;
}

/**
 * Decodes the protobuf `PathValue` oneof into a protocol {@link PathValue}:
 * `null`, a single hash string, or an ordered array of hash strings.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized oneof case.
 */
function fromProtoPathValue(value: ProtoPathValue, label: string): PathValue {
  switch (value.value.case) {
    case "nullValue":
      return null;
    case "orderedHashes": {
      const hashes: HashString[] = [];

      for (const [index, hash] of value.value.value.hashes.entries()) {
        assertHashString(hash, `${label}.orderedHashes[${index}]`);
        hashes.push(hash);
      }

      return hashes;
    }
    case "singleHash":
      assertHashString(value.value.value, `${label}.singleHash`);
      return value.value.value;
    default:
      throw createInvalidTransportResponseError(`${label}.value`);
  }
}

/**
 * Maps a protobuf `RunStatus` enum value to the protocol's string
 * `RunRecord["status"]` union.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized enum value.
 */
function fromProtoRunStatus(
  value: ProtoRunStatus,
  label: string
): RunRecord["status"] {
  switch (value) {
    case ProtoRunStatus.RUNNING:
      return "running";
    case ProtoRunStatus.PAUSED:
      return "paused";
    case ProtoRunStatus.COMPLETED:
      return "completed";
    case ProtoRunStatus.FAILED:
      return "failed";
    default:
      throw createInvalidTransportResponseError(label);
  }
}

/**
 * Decodes a protobuf `StagedResult`, discriminating on its `outcome` oneof
 * into the protocol's interrupted or settled {@link StagedResult} variant.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized `outcome` case.
 */
function fromProtoStagedResult(
  value: ProtoStagedResult,
  label: string
): StagedResult {
  const timestamp = fromProtoEpochMs(value.timestampMs, `${label}.timestampMs`);

  switch (value.outcome.case) {
    case "interrupted": {
      const result: StagedResult = {
        interruptPayload: decodeKernelRecordBytes(
          value.outcome.value.interruptPayloadCbor,
          `${label}.interruptPayload`
        ),
        objectHash: value.objectHash,
        objectType: value.objectType,
        status: "interrupted",
        taskId: value.taskId,
        timestamp,
      };
      assertStagedResult(result, label);
      return result;
    }
    case "settled": {
      const status = fromProtoStagedResultStatus(
        value.outcome.value.status,
        `${label}.status`
      );
      const result: StagedResult = {
        objectHash: value.objectHash,
        objectType: value.objectType,
        status,
        taskId: value.taskId,
        timestamp,
      };
      assertStagedResult(result, label);
      return result;
    }
    default:
      throw createInvalidTransportResponseError(`${label}.outcome`);
  }
}

/**
 * Maps a protobuf `StagedResultStatus` enum value to the non-`"interrupted"`
 * subset of the protocol's `StagedResultStatus` union.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized enum value.
 */
function fromProtoStagedResultStatus(
  value: ProtoStagedResultStatus,
  label: string
): Exclude<StagedResultStatus, "interrupted"> {
  switch (value) {
    case ProtoStagedResultStatus.COMPLETED:
      return "completed";
    case ProtoStagedResultStatus.FAILED:
      return "failed";
    default:
      throw createInvalidTransportResponseError(label);
  }
}

/**
 * Decodes a required protobuf `StepDeclaration` field into a protocol
 * {@link StepDeclaration}, decoding optional CBOR-encoded metadata.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   when `value` is `undefined`.
 */
function fromProtoStepDeclaration(
  value: ProtoStepDeclaration | undefined,
  label: string
): StepDeclaration {
  if (value === undefined) {
    throw createInvalidTransportResponseError(label);
  }

  const step: StepDeclaration = {
    deterministic: value.deterministic,
    id: value.id,
    sideEffects: value.sideEffects,
    ...(value.metadataCbor === undefined
      ? {}
      : {
          metadata: decodeKernelRecordBytes(
            value.metadataCbor,
            `${label}.metadata`
          ),
        }),
  };
  assertStepDeclaration(step, label);
  return step;
}

/**
 * Decodes a protobuf `TurnTreeSchema` message into a protocol
 * {@link TurnTreeSchema}, decoding each path's optional CBOR-encoded
 * metadata.
 */
function fromProtoTurnTreeSchema(
  value: ProtoTurnTreeSchema,
  label: string
): TurnTreeSchema {
  const schema: TurnTreeSchema = {
    incorporationRules: value.incorporationRules.map((rule) => ({
      objectType: rule.objectType,
      targetPath: rule.targetPath,
    })),
    paths: value.paths.map((path, index) => ({
      collection: fromProtoPathCollectionKind(
        path.collection,
        `${label}.paths[${index}].collection`
      ),
      path: path.path,
      ...(path.metadataCbor === undefined
        ? {}
        : {
            metadata: decodeKernelRecordBytes(
              path.metadataCbor,
              `${label}.paths[${index}].metadata`
            ),
          }),
    })),
    schemaId: value.schemaId,
  };
  assertTurnTreeSchema(schema, label);
  return schema;
}

/**
 * Decodes a protobuf `Verdict`, discriminating on its `verdict` oneof into
 * the matching protocol {@link Verdict} variant (`abort`, `modify`, `pause`,
 * `proceed`, or `retry`).
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized `verdict` case.
 */
function fromProtoVerdict(value: ProtoVerdict, label: string): Verdict {
  switch (value.verdict.case) {
    case "abort":
      return {
        disposition: fromProtoVerdictDisposition(
          value.verdict.value.disposition,
          `${label}.disposition`
        ),
        kind: "abort",
        reason: value.verdict.value.reason,
      };
    case "modify":
      return {
        kind: "modify",
        transform: decodeKernelRecordBytes(
          value.verdict.value.transformCbor,
          `${label}.transform`
        ),
      };
    case "pause":
      return {
        kind: "pause",
        reason: value.verdict.value.reason,
        resumptionSchema: decodeKernelRecordBytes(
          value.verdict.value.resumptionSchemaCbor,
          `${label}.resumptionSchema`
        ),
      };
    case "proceed":
      return {
        kind: "proceed",
      };
    case "retry":
      return {
        adjustment: decodeKernelRecordBytes(
          value.verdict.value.adjustmentCbor,
          `${label}.adjustment`
        ),
        kind: "retry",
      };
    default:
      throw createInvalidTransportResponseError(`${label}.verdict`);
  }
}

/**
 * Maps a protobuf `VerdictDisposition` enum value to the protocol's
 * `VerdictDisposition` string union.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized enum value.
 */
function fromProtoVerdictDisposition(
  value: ProtoVerdictDisposition,
  label: string
): VerdictDisposition {
  switch (value) {
    case ProtoVerdictDisposition.HARD_FAIL:
      return "HardFail";
    case ProtoVerdictDisposition.SOFT_FAIL:
      return "SoftFail";
    case ProtoVerdictDisposition.END_TURN:
      return "EndTurn";
    default:
      throw createInvalidTransportResponseError(label);
  }
}

/**
 * Encodes a protocol {@link ObserveResult} into its protobuf `ObserveResult`
 * message, CBOR-encoding annotations and signals.
 */
export function toProtoObserveResult(value: ObserveResult, label: string) {
  return create(ObserveResultSchema, {
    annotationsCbor: value.annotations.map((annotation, index) =>
      encodeKernelObjectBytes(annotation, `${label}.annotations[${index}]`)
    ),
    signalsCbor: value.signals.map((signal, index) =>
      encodeKernelRecordBytes(signal, `${label}.signals[${index}]`)
    ),
  });
}

/**
 * Maps a protocol {@link PathCollectionKind} to its protobuf
 * `PathCollectionKind` enum value.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized value.
 */
function toProtoPathCollectionKind(
  value: PathCollectionKind
): ProtoPathCollectionKind {
  switch (value) {
    case "ordered":
      return ProtoPathCollectionKind.ORDERED;
    case "single":
      return ProtoPathCollectionKind.SINGLE;
    default:
      throw createInvalidTransportResponseError("pathCollectionKind");
  }
}

/**
 * Encodes a protocol {@link PathValue} into its protobuf `PathValue` oneof
 * message (`nullValue`, `singleHash`, or `orderedHashes`).
 */
export function toProtoPathValue(value: PathValue, label: string) {
  if (value === null) {
    return create(PathValueSchema, {
      value: {
        case: "nullValue",
        value: {},
      },
    });
  }

  if (typeof value === "string") {
    assertHashString(value, `${label}.singleHash`);
    return create(PathValueSchema, {
      value: {
        case: "singleHash",
        value,
      },
    });
  }

  const hashes: HashString[] = [];

  for (const [index, hash] of value.entries()) {
    assertHashString(hash, `${label}.orderedHashes[${index}]`);
    hashes.push(hash);
  }

  return create(PathValueSchema, {
    value: {
      case: "orderedHashes",
      value: { hashes },
    },
  });
}

/**
 * Encodes a protocol {@link TurnTreeChangeSet} into the protobuf path/value
 * entry list `tree.create`/`tree.incorporate` transmit over the wire.
 */
export function toProtoPathValueEntries(
  changes: TurnTreeChangeSet,
  label: string
) {
  return Object.entries(changes).map(([path, value]) =>
    create(PathValueEntrySchema, {
      path,
      value: toProtoPathValue(value, `${label}.${path}`),
    })
  );
}

/**
 * Maps a protocol {@link RunCompletionStatus} to its protobuf
 * `RunCompletionStatus` enum value.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized value.
 */
export function toProtoRunCompletionStatus(
  value: RunCompletionStatus
): ProtoRunCompletionStatus {
  switch (value) {
    case "paused":
      return ProtoRunCompletionStatus.PAUSED;
    case "completed":
      return ProtoRunCompletionStatus.COMPLETED;
    case "failed":
      return ProtoRunCompletionStatus.FAILED;
    default:
      throw createInvalidTransportResponseError("runCompletionStatus");
  }
}

/**
 * Encodes a protocol {@link StagedResult} into its protobuf `StagedResult`
 * message, discriminating on `status` into the `interrupted` or `settled`
 * outcome oneof.
 */
export function toProtoStagedResult(value: StagedResult, label: string) {
  const base = {
    objectHash: value.objectHash,
    objectType: value.objectType,
    taskId: value.taskId,
    timestampMs: BigInt(value.timestamp),
  };

  if (value.status === "interrupted") {
    return create(StagedResultSchema, {
      ...base,
      outcome: {
        case: "interrupted",
        value: {
          interruptPayloadCbor: encodeKernelRecordBytes(
            value.interruptPayload,
            `${label}.interruptPayload`
          ),
        },
      },
    });
  }

  return create(StagedResultSchema, {
    ...base,
    outcome: {
      case: "settled",
      value: {
        status: toProtoStagedResultStatus(value.status),
      },
    },
  });
}

/**
 * Maps the non-`"interrupted"` subset of the protocol's
 * `StagedResultStatus` union to its protobuf `StagedResultStatus` enum
 * value.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized value.
 */
function toProtoStagedResultStatus(
  value: Exclude<StagedResultStatus, "interrupted">
): ProtoStagedResultStatus {
  switch (value) {
    case "completed":
      return ProtoStagedResultStatus.COMPLETED;
    case "failed":
      return ProtoStagedResultStatus.FAILED;
    default:
      throw createInvalidTransportResponseError("stagedResultStatus");
  }
}

/**
 * Encodes a `staging.stage` call's status and optional interrupt payload
 * into the protobuf staging outcome oneof, without a full
 * {@link StagedResult} to encode from ({@link toProtoStagedResult} is used
 * once the kernel has assigned the rest of the result's fields).
 */
export function toProtoStagingOutcome(
  status: StagedResultStatus,
  interruptPayload: KernelRecord | undefined,
  label: string
) {
  if (status === "interrupted") {
    return {
      case: "interrupted" as const,
      value: {
        interruptPayloadCbor: encodeKernelRecordBytes(
          interruptPayload ?? null,
          `${label}.interruptPayload`
        ),
      },
    };
  }

  return {
    case: "settled" as const,
    value: {
      status: toProtoStagedResultStatus(status),
    },
  };
}

/**
 * Validates and encodes a protocol {@link StepDeclaration} into its
 * protobuf `StepDeclaration` message, CBOR-encoding optional metadata.
 */
export function toProtoStepDeclaration(value: StepDeclaration, label: string) {
  assertStepDeclaration(value, label);
  return create(StepDeclarationSchema, {
    deterministic: value.deterministic,
    id: value.id,
    metadataCbor:
      value.metadata === undefined
        ? undefined
        : encodeKernelRecordBytes(value.metadata, `${label}.metadata`),
    sideEffects: value.sideEffects,
  });
}

/**
 * Validates and encodes a protocol {@link TurnTreeSchema} into its protobuf
 * `TurnTreeSchema` message, CBOR-encoding each path's optional metadata.
 */
export function toProtoTurnTreeSchema(value: TurnTreeSchema, label: string) {
  assertTurnTreeSchema(value, label);
  return create(TurnTreeSchemaSchema, {
    incorporationRules: value.incorporationRules.map((rule) => ({
      objectType: rule.objectType,
      targetPath: rule.targetPath,
    })),
    paths: value.paths.map((path) => ({
      collection: toProtoPathCollectionKind(path.collection),
      metadataCbor:
        path.metadata === undefined
          ? undefined
          : encodeKernelRecordBytes(
              path.metadata,
              `${label}.${path.path}.metadata`
            ),
      path: path.path,
    })),
    schemaId: value.schemaId,
  });
}

/**
 * Validates and encodes a protocol {@link Verdict} into its protobuf
 * `Verdict` message, discriminating on `kind` into the matching oneof case.
 */
export function toProtoVerdict(value: Verdict, label: string) {
  assertVerdict(value, label);

  switch (value.kind) {
    case "abort":
      return create(VerdictSchema, {
        verdict: {
          case: "abort",
          value: {
            disposition: toProtoVerdictDisposition(value.disposition),
            reason: value.reason,
          },
        },
      });
    case "modify":
      return create(VerdictSchema, {
        verdict: {
          case: "modify",
          value: {
            transformCbor: encodeKernelRecordBytes(
              value.transform,
              `${label}.transform`
            ),
          },
        },
      });
    case "pause":
      return create(VerdictSchema, {
        verdict: {
          case: "pause",
          value: {
            reason: value.reason,
            resumptionSchemaCbor: encodeKernelRecordBytes(
              value.resumptionSchema,
              `${label}.resumptionSchema`
            ),
          },
        },
      });
    case "proceed":
      return create(VerdictSchema, {
        verdict: {
          case: "proceed",
          value: {},
        },
      });
    case "retry":
      return create(VerdictSchema, {
        verdict: {
          case: "retry",
          value: {
            adjustmentCbor: encodeKernelRecordBytes(
              value.adjustment,
              `${label}.adjustment`
            ),
          },
        },
      });
    default:
      throw createInvalidTransportResponseError("verdict");
  }
}

/**
 * Maps a protocol {@link VerdictDisposition} to its protobuf
 * `VerdictDisposition` enum value.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized value.
 */
function toProtoVerdictDisposition(
  value: VerdictDisposition
): ProtoVerdictDisposition {
  switch (value) {
    case "HardFail":
      return ProtoVerdictDisposition.HARD_FAIL;
    case "SoftFail":
      return ProtoVerdictDisposition.SOFT_FAIL;
    case "EndTurn":
      return ProtoVerdictDisposition.END_TURN;
    default:
      throw createInvalidTransportResponseError("verdictDisposition");
  }
}

/**
 * Decodes deterministic CBOR `bytes` from a transport response into a
 * validated {@link KernelRecord}.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   when `bytes` do not decode.
 */
export function decodeKernelRecordBytes(
  bytes: Uint8Array,
  label: string
): KernelRecord {
  const decoded = decodeDeterministicKernelRecord(bytes);

  if (decoded === undefined) {
    throw new TuvrenRuntimeError(`${label} could not be decoded`, {
      code: "invalid_kernel_transport_response",
    });
  }

  assertKernelRecord(decoded, label);
  return decoded;
}

/**
 * Encodes an observe annotation as deterministic CBOR, additionally
 * asserting it is a {@link KernelObject} — an annotation's outer shape must
 * be a plain object/record, unlike an arbitrary {@link KernelRecord}.
 *
 * @throws TuvrenRuntimeError With code `invalid_runtime_options` when
 *   `value` is an array, `Uint8Array`, or `null`.
 */
function encodeKernelObjectBytes(
  value: KernelObject,
  label: string
): Uint8Array {
  const record = encodeKernelRecordBytes(value, label);
  if (Array.isArray(value) || value instanceof Uint8Array || value === null) {
    throw new TuvrenRuntimeError(`${label} must be a kernel object`, {
      code: "invalid_runtime_options",
      details: value,
    });
  }

  return record;
}

/**
 * Validates `value` as a {@link KernelRecord} and encodes it as
 * deterministic CBOR for transmission.
 */
export function encodeKernelRecordBytes(
  value: KernelRecord,
  label: string
): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
}

/**
 * Converts a protobuf `int64`/`uint64` millisecond timestamp (transmitted as
 * `bigint`) into an {@link EpochMs}.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   when `value` does not fit in a non-negative safe integer.
 */
function fromProtoEpochMs(value: bigint, label: string): EpochMs {
  const numberValue = Number(value);

  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new TuvrenRuntimeError(`${label} must be a safe integer epoch`, {
      code: "invalid_kernel_transport_response",
      details: {
        label,
        value: value.toString(),
      },
    });
  }

  return numberValue;
}

/**
 * Maps a protobuf `PathCollectionKind` enum value to the protocol's
 * `PathCollectionKind` string union.
 *
 * @throws TuvrenRuntimeError With code `invalid_kernel_transport_response`
 *   for an unrecognized enum value.
 */
function fromProtoPathCollectionKind(
  value: ProtoPathCollectionKind,
  label: string
): PathCollectionKind {
  switch (value) {
    case ProtoPathCollectionKind.ORDERED:
      return "ordered";
    case ProtoPathCollectionKind.SINGLE:
      return "single";
    default:
      throw createInvalidTransportResponseError(label);
  }
}

/**
 * Builds the standard error this codec throws for any missing, unrecognized,
 * or malformed field in a kernel transport response, with code
 * `invalid_kernel_transport_response` and `label` identifying the offending
 * field.
 */
export function createInvalidTransportResponseError(
  label: string
): TuvrenRuntimeError {
  return new TuvrenRuntimeError(
    `${label} is missing or invalid in the kernel transport response`,
    {
      code: "invalid_kernel_transport_response",
      details: {
        label,
      },
    }
  );
}
