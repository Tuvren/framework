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
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  assertHashString,
  assertKernelRecord,
  type EpochMs,
  type HashString,
  isTuvrenErrorCode,
  type KernelObject,
  type KernelRecord,
  TuvrenRuntimeError,
} from "@tuvren/core-types";
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
  type RuntimeKernel,
  type SetHeadResult,
  type StagedResult,
  type StagedResultStatus,
  type StepContext,
  type StepDeclaration,
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
import {
  BranchCreateResponseSchema,
  BranchGetResponseSchema,
  type BranchListResponse,
  BranchSetHeadResponseSchema,
  KernelBranchService,
  KernelNodeService,
  KernelRunService,
  KernelSchemaService,
  KernelStagingService,
  KernelStoreService,
  KernelThreadService,
  KernelTreeService,
  KernelTurnService,
  KernelVerdictsService,
  RunBeginStepResponseSchema,
  RunCreateResponseSchema,
  RunRecoverResponseSchema,
  SchemaGetResponseSchema,
  StagingStageResponseSchema,
  ThreadCreateResponseSchema,
  ThreadGetResponseSchema,
  type TreeManifestResponse,
  TreeResolveResponseSchema,
  TurnCreateResponseSchema,
  TurnGetResponseSchema,
  VerdictsComposeResponseSchema,
} from "./generated/kernel-interop/tuvren/kernel/interop/v1/kernel_services_pb";
import {
  KernelErrorPayloadSchema,
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

export interface GrpcRuntimeKernelOptions {
  baseUrl: string;
  defaultTimeoutMs?: number;
  interceptors?: Interceptor[];
}

export function createGrpcRuntimeKernel(
  options: GrpcRuntimeKernelOptions
): RuntimeKernel {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const transport = createGrpcTransport({
    baseUrl,
    defaultTimeoutMs: options.defaultTimeoutMs,
    interceptors: options.interceptors,
  });
  const storeClient = createClient(KernelStoreService, transport);
  const schemaClient = createClient(KernelSchemaService, transport);
  const treeClient = createClient(KernelTreeService, transport);
  const nodeClient = createClient(KernelNodeService, transport);
  const threadClient = createClient(KernelThreadService, transport);
  const branchClient = createClient(KernelBranchService, transport);
  const stagingClient = createClient(KernelStagingService, transport);
  const runClient = createClient(KernelRunService, transport);
  const turnClient = createClient(KernelTurnService, transport);
  const verdictsClient = createClient(KernelVerdictsService, transport);

  return {
    branch: {
      async create(branchId, threadId, fromTurnNodeHash) {
        try {
          const response = await branchClient.branchCreate({
            branchId,
            fromTurnNodeHash,
            threadId,
          });
          return requireBranchRecord(
            response.branch,
            BranchCreateResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "branch.create");
        }
      },
      async get(branchId) {
        try {
          const response = await branchClient.branchGet({ branchId });
          return response.found
            ? requireBranchRecord(
                response.branch,
                BranchGetResponseSchema.typeName
              )
            : null;
        } catch (error: unknown) {
          throw toTransportError(error, "branch.get");
        }
      },
      async list(threadId) {
        try {
          const response = await branchClient.branchList({ threadId });
          return fromBranchHeadListEntries(response, "branch.list");
        } catch (error: unknown) {
          throw toTransportError(error, "branch.list");
        }
      },
      async setHead(branchId, turnNodeHash) {
        try {
          const response = await branchClient.branchSetHead({
            branchId,
            turnNodeHash,
          });
          return requireSetHeadResult(
            response.result,
            BranchSetHeadResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "branch.setHead");
        }
      },
    },
    node: {
      async get(hash) {
        try {
          const response = await nodeClient.nodeGet({ hash });
          return response.found
            ? requireTurnNode(response.node, "node.get")
            : null;
        } catch (error: unknown) {
          throw toTransportError(error, "node.get");
        }
      },
      async *walkBack(fromHash) {
        let stream: AsyncIterable<{ node?: ProtoTurnNode }>;

        try {
          stream = nodeClient.nodeWalkBack({ fromHash });
        } catch (error: unknown) {
          throw toTransportError(error, "node.walkBack");
        }

        try {
          for await (const response of stream) {
            yield requireTurnNode(response.node, "node.walkBack");
          }
        } catch (error: unknown) {
          throw toTransportError(error, "node.walkBack");
        }
      },
    },
    run: {
      async beginStep(runId, stepId) {
        try {
          const response = await runClient.runBeginStep({ runId, stepId });
          return requireStepContext(
            response.context,
            RunBeginStepResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "run.beginStep");
        }
      },
      async complete(runId, status, eventHash) {
        try {
          const response = await runClient.runComplete({
            eventHash,
            runId,
            status: toProtoRunCompletionStatus(status),
          });
          return {
            turnNodeHash: response.turnNodeHash,
          };
        } catch (error: unknown) {
          throw toTransportError(error, "run.complete");
        }
      },
      async completeStep(runId, stepId, eventHash, observeResults, treeHash) {
        try {
          const response = await runClient.runCompleteStep({
            eventHash,
            observeResults: (observeResults ?? []).map((value, index) =>
              toProtoObserveResult(
                value,
                `run.completeStep.observeResults[${index}]`
              )
            ),
            runId,
            stepId,
            treeHash,
          });
          return {
            checkpointed: response.checkpointed,
            turnNodeHash: response.turnNodeHash,
          };
        } catch (error: unknown) {
          throw toTransportError(error, "run.completeStep");
        }
      },
      async create(
        runId,
        turnId,
        branchId,
        schemaId,
        startTurnNodeHash,
        steps
      ) {
        try {
          const response = await runClient.runCreate({
            branchId,
            runId,
            schemaId,
            startTurnNodeHash,
            steps: steps.map((step, index) =>
              toProtoStepDeclaration(step, `run.create.steps[${index}]`)
            ),
            turnId,
          });
          return requireRunRecord(
            response.run,
            RunCreateResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "run.create");
        }
      },
      async recover(runId) {
        try {
          const response = await runClient.runRecover({ runId });
          return requireRecoveryState(
            response.recoveryState,
            RunRecoverResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "run.recover");
        }
      },
    },
    schema: {
      async get(schemaId) {
        try {
          const response = await schemaClient.schemaGet({ schemaId });
          return response.found
            ? requireTurnTreeSchema(
                response.schema,
                SchemaGetResponseSchema.typeName
              )
            : null;
        } catch (error: unknown) {
          throw toTransportError(error, "schema.get");
        }
      },
      async register(schema) {
        try {
          const response = await schemaClient.schemaRegister({
            schema: toProtoTurnTreeSchema(schema, "schema.register"),
          });
          return response.schemaId;
        } catch (error: unknown) {
          throw toTransportError(error, "schema.register");
        }
      },
    },
    staging: {
      async current(runId) {
        try {
          const response = await stagingClient.stagingCurrent({ runId });
          return response.stagedResults.map((result, index) =>
            fromProtoStagedResult(
              result,
              `staging.current.stagedResults[${index}]`
            )
          );
        } catch (error: unknown) {
          throw toTransportError(error, "staging.current");
        }
      },
      async stage(runId, blob, taskId, objectType, status, interruptPayload) {
        try {
          const response = await stagingClient.stagingStage({
            blob,
            objectType,
            outcome: toProtoStagingOutcome(
              status,
              interruptPayload,
              "staging.stage"
            ),
            runId,
            taskId,
          });
          return {
            objectHash: response.objectHash,
            stagedResult: requireStagedResult(
              response.stagedResult,
              StagingStageResponseSchema.typeName
            ),
          };
        } catch (error: unknown) {
          throw toTransportError(error, "staging.stage");
        }
      },
    },
    store: {
      async get(hash) {
        try {
          const response = await storeClient.storeGet({ hash });
          return response.found ? response.blob : null;
        } catch (error: unknown) {
          throw toTransportError(error, "store.get");
        }
      },
      async has(hash) {
        try {
          const response = await storeClient.storeHas({ hash });
          return response.exists;
        } catch (error: unknown) {
          throw toTransportError(error, "store.has");
        }
      },
      async put(blob, mediaType) {
        try {
          const response = await storeClient.storePut({
            blob,
            mediaType,
          });
          return response.objectHash;
        } catch (error: unknown) {
          throw toTransportError(error, "store.put");
        }
      },
    },
    thread: {
      async create(threadId, schemaId, initialBranchId) {
        try {
          const response = await threadClient.threadCreate({
            initialBranchId,
            schemaId,
            threadId,
          });
          return requireThreadCreateResult(
            response.result,
            ThreadCreateResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "thread.create");
        }
      },
      async get(threadId) {
        try {
          const response = await threadClient.threadGet({ threadId });
          return response.found
            ? requireThreadRecord(
                response.thread,
                ThreadGetResponseSchema.typeName
              )
            : null;
        } catch (error: unknown) {
          throw toTransportError(error, "thread.get");
        }
      },
    },
    tree: {
      async create(schemaId, changes, baseTurnTreeHash) {
        try {
          const response = await treeClient.treeCreate({
            baseTurnTreeHash,
            changes: toProtoPathValueEntries(changes, "tree.create"),
            schemaId,
          });
          return response.treeHash;
        } catch (error: unknown) {
          throw toTransportError(error, "tree.create");
        }
      },
      async diff(treeHashA, treeHashB) {
        try {
          const response = await treeClient.treeDiff({ treeHashA, treeHashB });
          return [...response.paths];
        } catch (error: unknown) {
          throw toTransportError(error, "tree.diff");
        }
      },
      async incorporate(baseTurnTreeHash, stagedResults) {
        try {
          const response = await treeClient.treeIncorporate({
            baseTurnTreeHash,
            stagedResults: stagedResults.map((result, index) =>
              toProtoStagedResult(
                result,
                `tree.incorporate.stagedResults[${index}]`
              )
            ),
          });
          return response.treeHash;
        } catch (error: unknown) {
          throw toTransportError(error, "tree.incorporate");
        }
      },
      async manifest(treeHash) {
        try {
          const response = await treeClient.treeManifest({ treeHash });
          return fromProtoManifestEntries(response, "tree.manifest");
        } catch (error: unknown) {
          throw toTransportError(error, "tree.manifest");
        }
      },
      async resolve(treeHash, path) {
        try {
          const response = await treeClient.treeResolve({ path, treeHash });
          return requirePathValue(
            response.value,
            TreeResolveResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "tree.resolve");
        }
      },
    },
    turn: {
      async create(
        turnId,
        threadId,
        branchId,
        parentTurnId,
        startTurnNodeHash
      ) {
        try {
          const response = await turnClient.turnCreate({
            branchId,
            parentTurnId: parentTurnId ?? undefined,
            startTurnNodeHash,
            threadId,
            turnId,
          });
          return requireTurnRecord(
            response.turn,
            TurnCreateResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "turn.create");
        }
      },
      async get(turnId) {
        try {
          const response = await turnClient.turnGet({ turnId });
          return response.found
            ? requireTurnRecord(response.turn, TurnGetResponseSchema.typeName)
            : null;
        } catch (error: unknown) {
          throw toTransportError(error, "turn.get");
        }
      },
      async updateHead(turnId, headTurnNodeHash) {
        try {
          await turnClient.turnUpdateHead({ headTurnNodeHash, turnId });
        } catch (error: unknown) {
          throw toTransportError(error, "turn.updateHead");
        }
      },
    },
    verdicts: {
      async compose(verdicts) {
        try {
          const response = await verdictsClient.verdictsCompose({
            verdicts: verdicts.map((verdict, index) =>
              toProtoVerdict(verdict, `verdicts.compose.verdicts[${index}]`)
            ),
          });
          return requireComposedVerdict(
            response.verdict,
            VerdictsComposeResponseSchema.typeName
          );
        } catch (error: unknown) {
          throw toTransportError(error, "verdicts.compose");
        }
      },
    },
  };
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TuvrenRuntimeError("gRPC runtime kernel requires a base URL", {
      code: "invalid_runtime_options",
    });
  }

  return normalized;
}

function toTransportError(
  error: unknown,
  operation: string
): TuvrenRuntimeError {
  const connectError = ConnectError.from(error);
  const kernelPayload = connectError.findDetails(KernelErrorPayloadSchema)[0];
  const decodedDetails =
    kernelPayload?.detailsCbor === undefined
      ? undefined
      : decodeKernelRecordBytes(
          kernelPayload.detailsCbor,
          `${operation}.error.details`
        );
  const errorCode =
    kernelPayload !== undefined && isTuvrenErrorCode(kernelPayload.code)
      ? kernelPayload.code
      : "kernel_transport_error";

  return new TuvrenRuntimeError(
    kernelPayload?.message ?? connectError.rawMessage,
    {
      cause: error,
      code: errorCode,
      details: {
        connectCode: connectError.code,
        decodedDetails,
        metadata: Object.fromEntries(connectError.metadata.entries()),
        operation,
      },
    }
  );
}

function requireBranchRecord(
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

function requireBranchHeadListEntry(
  value: ProtoBranchHeadListEntry,
  label: string
): BranchHeadListEntry {
  const entry: BranchHeadListEntry = [value.branchId, value.headTurnNodeHash];
  assertBranchHeadListEntry(entry, label);
  return entry;
}

function requireComposedVerdict(
  value: ProtoVerdict | undefined,
  label: string
): ComposedVerdict {
  const verdict = requireVerdict(value, label);
  assertComposedVerdict(verdict, label);
  return verdict;
}

function requirePathValue(
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

function requireRecoveryState(
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

function requireRunRecord(
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

function requireSetHeadResult(
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

function requireStagedResult(
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

function requireStepContext(
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

function requireThreadCreateResult(
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

function requireThreadRecord(
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

function requireTurnNode(
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

function requireTurnRecord(
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

function requireTurnTreeSchema(
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

function requireVerdict(
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

function fromBranchHeadListEntries(
  response: BranchListResponse,
  label: string
): BranchHeadListEntry[] {
  return response.entries.map((entry, index) =>
    requireBranchHeadListEntry(entry, `${label}.entries[${index}]`)
  );
}

function fromProtoManifestEntries(
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

function toProtoObserveResult(value: ObserveResult, label: string) {
  return create(ObserveResultSchema, {
    annotationsCbor: value.annotations.map((annotation, index) =>
      encodeKernelObjectBytes(annotation, `${label}.annotations[${index}]`)
    ),
    signalsCbor: value.signals.map((signal, index) =>
      encodeKernelRecordBytes(signal, `${label}.signals[${index}]`)
    ),
  });
}

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

function toProtoPathValue(value: PathValue, label: string) {
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

function toProtoPathValueEntries(changes: TurnTreeChangeSet, label: string) {
  return Object.entries(changes).map(([path, value]) =>
    create(PathValueEntrySchema, {
      path,
      value: toProtoPathValue(value, `${label}.${path}`),
    })
  );
}

function toProtoRunCompletionStatus(
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

function toProtoStagedResult(value: StagedResult, label: string) {
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

function toProtoStagingOutcome(
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

function toProtoStepDeclaration(value: StepDeclaration, label: string) {
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

function toProtoTurnTreeSchema(value: TurnTreeSchema, label: string) {
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

function toProtoVerdict(value: Verdict, label: string) {
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

function decodeKernelRecordBytes(
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

function encodeKernelRecordBytes(
  value: KernelRecord,
  label: string
): Uint8Array {
  assertKernelRecord(value, label);
  return encodeDeterministicKernelRecord(value);
}

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

function createInvalidTransportResponseError(
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
