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
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { isTuvrenErrorCode, TuvrenRuntimeError } from "@tuvren/core-types";
import type { RuntimeKernel } from "@tuvren/kernel-protocol";
import {
  BranchCreateResponseSchema,
  BranchGetResponseSchema,
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
  ThreadListResponseSchema,
  TreeResolveResponseSchema,
  TurnCreateResponseSchema,
  TurnGetResponseSchema,
  VerdictsComposeResponseSchema,
} from "./generated/kernel-interop/tuvren/kernel/interop/v1/kernel_services_pb";
import {
  KernelErrorPayloadSchema,
  type TurnNode as ProtoTurnNode,
} from "./generated/kernel-interop/tuvren/kernel/interop/v1/kernel_types_pb";
import {
  decodeKernelRecordBytes,
  fromBranchHeadListEntries,
  fromProtoManifestEntries,
  fromStoredThreadEntry,
  requireBranchRecord,
  requireComposedVerdict,
  requirePathValue,
  requireRecoveryState,
  requireRunRecord,
  requireSetHeadResult,
  requireStagedResult,
  requireStepContext,
  requireThreadCreateResult,
  requireThreadRecord,
  requireTurnNode,
  requireTurnRecord,
  requireTurnTreeSchema,
  toProtoObserveResult,
  toProtoPathValueEntries,
  toProtoRunCompletionStatus,
  toProtoStagedResult,
  toProtoStagingOutcome,
  toProtoStepDeclaration,
  toProtoTurnTreeSchema,
  toProtoVerdict,
} from "./runtime-kernel-grpc-codec.js";

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
            requireStagedResult(
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
      async list(options) {
        try {
          const response = await threadClient.threadList({
            limit: options?.limit === undefined ? undefined : options.limit,
            cursor: options?.cursor ?? undefined,
            filterSchemaId: options?.filter?.schemaId ?? undefined,
          });
          return {
            threads: response.entries.map((entry, index) =>
              fromStoredThreadEntry(
                entry,
                `${ThreadListResponseSchema.typeName}.entries[${index}]`
              )
            ),
            nextCursor:
              response.nextCursor === "" ? undefined : response.nextCursor,
          };
        } catch (error: unknown) {
          throw toTransportError(error, "thread.list");
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
