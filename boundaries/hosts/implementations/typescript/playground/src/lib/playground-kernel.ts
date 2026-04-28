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
} from "@tuvren/core-types";
import {
  assertStagedResult,
  assertStepDeclaration,
  assertTurnTreeSchema,
  type BranchHeadListEntry,
  type BranchRecord,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
  type PathValue,
  type RecoveryState,
  type RunRecord,
  type RuntimeBackend,
  type RuntimeBackendTx,
  type RuntimeKernel,
  type SetHeadResult,
  type StagedResult,
  type StagedResultStatus,
  type StepContext,
  type StepDeclaration,
  type StoredBranch,
  type StoredRun,
  type StoredStagedResult,
  type StoredTurn,
  type StoredTurnNode,
  type StoredTurnTreePath,
  type ThreadCreateResult,
  type ThreadRecord,
  type TurnNode,
  type TurnRecord,
  type TurnTreeChangeSet,
  type TurnTreeManifest,
  type TurnTreeSchema,
  type Verdict,
} from "@tuvren/kernel-protocol";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

export interface PlaygroundKernelHarness {
  kernel: RuntimeKernel;
  readBranchMessages(branchId: string): Promise<unknown[]>;
  readBranchStatus(branchId: string): Promise<unknown | null>;
}

export function createPlaygroundKernel(input: {
  backend: RuntimeBackend;
  now?: () => EpochMs;
}): PlaygroundKernelHarness {
  const now = input.now ?? Date.now;
  const backend = input.backend;

  const kernel: RuntimeKernel = {
    branch: {
      async create(branchId, threadId, fromTurnNodeHash) {
        return await backend.transact(async (tx) => {
          const thread = await requireThread(tx, threadId);
          await requireThreadTurnNode(tx, fromTurnNodeHash, thread);
          const record: StoredBranch = {
            branchId,
            createdAtMs: now(),
            headTurnNodeHash: fromTurnNodeHash,
            threadId,
            updatedAtMs: now(),
          };
          await tx.branches.set(record);
          return toBranchRecord(record);
        });
      },
      async get(branchId) {
        return await backend.transact(async (tx) => {
          const branch = await tx.branches.get(branchId);
          return branch === null ? null : toBranchRecord(branch);
        });
      },
      async list(threadId) {
        return await backend.transact(async (tx) => {
          const branches = await tx.branches.listByThread(threadId);
          return branches.map(
            (branch): BranchHeadListEntry => [
              branch.branchId,
              branch.headTurnNodeHash,
            ]
          );
        });
      },
      async setHead(branchId, turnNodeHash) {
        return await backend.transact(async (tx) => {
          const branch = await requireBranch(tx, branchId);
          const thread = await requireThread(tx, branch.threadId);
          await requireThreadTurnNode(tx, turnNodeHash, thread);
          const updated: StoredBranch = {
            ...branch,
            headTurnNodeHash: turnNodeHash,
            updatedAtMs: now(),
          };
          await tx.branches.set(updated);
          return {
            branch: toBranchRecord(updated),
          } satisfies SetHeadResult;
        });
      },
    },
    node: {
      async get(hash) {
        return await backend.transact(async (tx) => {
          const node = await tx.turnNodes.get(hash);
          return node === null ? null : decodeStoredTurnNode(node);
        });
      },
      walkBack(fromHash) {
        return walkBack(backend, fromHash);
      },
    },
    run: {
      async beginStep(runId, stepId) {
        return await backend.transact(async (tx) => {
          const run = await requireRun(tx, runId);
          const step = run.stepSequence[run.currentStepIndex];

          if (step === undefined || step.id !== stepId) {
            throw new TuvrenRuntimeError(`unexpected step "${stepId}"`, {
              code: "playground_kernel_unexpected_step",
            });
          }

          const branch = await requireBranch(tx, run.branchId);
          const schema = await requireSchema(tx, run.schemaId);

          return {
            currentTurnNodeHash: branch.headTurnNodeHash,
            schema,
            signals: [],
            step,
          } satisfies StepContext;
        });
      },
      async complete(runId, status, eventHash) {
        return await backend.transact(async (tx) => {
          const storedRun = await requireStoredRun(tx, runId);
          const run = decodeStoredRun(storedRun);
          const stagedResults = await listStagedResults(tx, runId);
          const nextRun = {
            ...storedRun,
            currentStepIndex:
              status === "completed"
                ? run.stepSequence.length
                : storedRun.currentStepIndex,
            status,
            updatedAtMs: now(),
          } satisfies StoredRun;
          await tx.runs.set(nextRun);

          if (stagedResults.length === 0) {
            return {};
          }

          const turnNodeHash = await checkpointRun(tx, {
            eventHash: eventHash ?? null,
            now,
            run,
            stagedResults,
          });
          await tx.stagedResults.clearRun(runId);
          return { turnNodeHash };
        });
      },
      async completeStep(runId, stepId, eventHash, _observeResults, treeHash) {
        return await backend.transact(async (tx) => {
          const storedRun = await requireStoredRun(tx, runId);
          const run = decodeStoredRun(storedRun);
          const step = run.stepSequence[run.currentStepIndex];

          if (step === undefined || step.id !== stepId) {
            throw new TuvrenRuntimeError(`unexpected step "${stepId}"`, {
              code: "playground_kernel_unexpected_step",
            });
          }

          const stagedResults = await listStagedResults(tx, runId);
          const shouldCheckpoint =
            treeHash !== undefined ||
            stagedResults.length > 0 ||
            !step.deterministic ||
            step.sideEffects;
          let turnNodeHash: HashString | undefined;

          if (shouldCheckpoint) {
            turnNodeHash = await checkpointRun(tx, {
              eventHash: eventHash ?? null,
              now,
              run,
              stagedResults,
              treeHash,
            });
            await tx.stagedResults.clearRun(runId);
          }

          const nextCreatedTurnNodes =
            turnNodeHash === undefined
              ? run.createdTurnNodes
              : [...run.createdTurnNodes, turnNodeHash];
          await tx.runs.set({
            ...storedRun,
            createdTurnNodesCbor: encodeRecord(nextCreatedTurnNodes),
            currentStepIndex: Math.min(
              run.currentStepIndex + 1,
              Math.max(run.stepSequence.length - 1, 0)
            ),
            updatedAtMs: now(),
          });

          return {
            checkpointed: turnNodeHash !== undefined,
            turnNodeHash,
          };
        });
      },
      async create(
        runId,
        turnId,
        branchId,
        schemaId,
        startTurnNodeHash,
        steps
      ) {
        return await backend.transact(async (tx) => {
          await requireTurn(tx, turnId);
          const branch = await requireBranch(tx, branchId);

          if (branch.headTurnNodeHash !== startTurnNodeHash) {
            throw new TuvrenRuntimeError(
              "run start turn node must match branch head",
              {
                code: "playground_kernel_run_branch_head_mismatch",
              }
            );
          }

          await requireSchema(tx, schemaId);
          const record: StoredRun = {
            branchId,
            createdAtMs: now(),
            createdTurnNodesCbor: encodeRecord([]),
            currentStepIndex: 0,
            runId,
            schemaId,
            startTurnNodeHash,
            status: "running",
            stepSequenceCbor: encodeRecord(steps),
            turnId,
            updatedAtMs: now(),
          };
          await tx.runs.set(record);
          return decodeStoredRun(record);
        });
      },
      async recover(runId) {
        return await backend.transact(async (tx) => {
          const run = decodeStoredRun(await requireStoredRun(tx, runId));
          const branch = await requireBranch(tx, run.branchId);
          const recoveryState: RecoveryState = {
            consumedStagedResults: [],
            lastCompletedStepId:
              run.currentStepIndex === 0
                ? null
                : (run.stepSequence[run.currentStepIndex - 1]?.id ?? null),
            lastTurnNodeHash: branch.headTurnNodeHash,
            stepSequence: run.stepSequence,
            uncommittedStagedResults: await listStagedResults(tx, runId),
          };
          return recoveryState;
        });
      },
    },
    schema: {
      async get(schemaId) {
        return await backend.transact(async (tx) => {
          const schema = await tx.schemas.get(schemaId);
          return schema === null ? null : decodeSchema(schema.schemaCbor);
        });
      },
      async register(schema) {
        return await backend.transact(async (tx) => {
          const existing = await tx.schemas.get(schema.schemaId);

          if (existing !== null) {
            return schema.schemaId;
          }

          await tx.schemas.put({
            createdAtMs: now(),
            schemaCbor: encodeRecord(schema),
            schemaId: schema.schemaId,
          });
          return schema.schemaId;
        });
      },
    },
    staging: {
      async current(runId) {
        return await backend.transact(async (tx) =>
          listStagedResults(tx, runId)
        );
      },
      async stage(runId, blob, taskId, objectType, status, interruptPayload) {
        return await backend.transact(async (tx) => {
          await requireRun(tx, runId);
          const objectHash = await putObject(tx, blob, now);
          const stagedResult = createStagedResult({
            objectHash,
            objectType,
            status,
            taskId,
            timestamp: now(),
            interruptPayload,
          });
          await tx.stagedResults.set(toStoredStagedResult(runId, stagedResult));
          return { objectHash, stagedResult };
        });
      },
    },
    store: {
      async get(hash) {
        return await backend.transact(async (tx) => {
          const object = await tx.objects.get(hash);
          return object === null ? null : object.bytes;
        });
      },
      async has(hash) {
        return await backend.transact(async (tx) => tx.objects.has(hash));
      },
      async put(blob, mediaType) {
        return await backend.transact(async (tx) =>
          putObject(tx, blob, now, mediaType)
        );
      },
    },
    thread: {
      async create(threadId, schemaId, initialBranchId) {
        return await backend.transact(async (tx) => {
          const schema = await requireSchema(tx, schemaId);
          const rootTurnTreeHash = await createTurnTree(tx, {
            changes: createEmptyManifest(schema),
            now,
            schema,
          });
          const rootEventHash = await putObject(
            tx,
            encodeRecord({
              threadId,
              type: "playground_thread_bootstrap",
            }),
            now
          );
          const rootTurnNodeHash = await createTurnNode(tx, {
            consumedStagedResults: [],
            eventHash: rootEventHash,
            now,
            previousTurnNodeHash: null,
            schemaId,
            turnTreeHash: rootTurnTreeHash,
          });
          await tx.threads.put({
            createdAtMs: now(),
            rootTurnNodeHash,
            schemaId,
            threadId,
          });
          await tx.branches.set({
            branchId: initialBranchId,
            createdAtMs: now(),
            headTurnNodeHash: rootTurnNodeHash,
            threadId,
            updatedAtMs: now(),
          });
          return {
            branchId: initialBranchId,
            rootTurnNodeHash,
            rootTurnTreeHash,
            threadId,
          } satisfies ThreadCreateResult;
        });
      },
      async get(threadId) {
        return await backend.transact(async (tx) => {
          const thread = await tx.threads.get(threadId);
          return thread === null
            ? null
            : {
                rootTurnNodeHash: thread.rootTurnNodeHash,
                schemaId: thread.schemaId,
                threadId: thread.threadId,
              };
        });
      },
    },
    tree: {
      async create(schemaId, changes, baseTurnTreeHash) {
        return await backend.transact(async (tx) => {
          const schema = await requireSchema(tx, schemaId);
          const baseManifest =
            baseTurnTreeHash === undefined
              ? createEmptyManifest(schema)
              : await requireTreeManifest(tx, baseTurnTreeHash);
          return await createTurnTree(tx, {
            changes: {
              ...baseManifest,
              ...changes,
            },
            now,
            schema,
          });
        });
      },
      async diff(treeHashA, treeHashB) {
        return await backend.transact(async (tx) => {
          const left = await requireTreeManifest(tx, treeHashA);
          const right = await requireTreeManifest(tx, treeHashB);
          return Object.keys({ ...left, ...right }).filter(
            (path) =>
              JSON.stringify(left[path] ?? null) !==
              JSON.stringify(right[path] ?? null)
          );
        });
      },
      async incorporate(baseTurnTreeHash, stagedResults) {
        return await backend.transact(async (tx) => {
          const baseTree = await requireTurnTree(tx, baseTurnTreeHash);
          const schema = await requireSchema(tx, baseTree.schemaId);
          const manifest = await requireTreeManifest(tx, baseTurnTreeHash);

          for (const stagedResult of stagedResults) {
            const rule = schema.incorporationRules.find(
              (candidate) => candidate.objectType === stagedResult.objectType
            );

            if (rule === undefined) {
              continue;
            }

            const pathDefinition = schema.paths.find(
              (path) => path.path === rule.targetPath
            );

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

          return await createTurnTree(tx, {
            changes: manifest,
            now,
            schema,
          });
        });
      },
      async manifest(treeHash) {
        return await backend.transact(async (tx) =>
          requireTreeManifest(tx, treeHash)
        );
      },
      async resolve(treeHash, path) {
        return await backend.transact(async (tx) => {
          const manifest = await requireTreeManifest(tx, treeHash);
          return manifest[path] ?? null;
        });
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
        return await backend.transact(async (tx) => {
          await requireThread(tx, threadId);
          const branch = await requireBranch(tx, branchId);

          if (branch.threadId !== threadId) {
            throw new TuvrenRuntimeError(
              "turn branch must belong to the requested thread",
              {
                code: "playground_kernel_turn_thread_mismatch",
              }
            );
          }

          const record: StoredTurn = {
            branchId,
            createdAtMs: now(),
            headTurnNodeHash: startTurnNodeHash,
            parentTurnId: parentTurnId ?? null,
            startTurnNodeHash,
            threadId,
            turnId,
            updatedAtMs: now(),
          };
          await tx.turns.set(record);
          return toTurnRecord(record);
        });
      },
      async get(turnId) {
        return await backend.transact(async (tx) => {
          const turn = await tx.turns.get(turnId);
          return turn === null ? null : toTurnRecord(turn);
        });
      },
      async updateHead(turnId, headTurnNodeHash) {
        await backend.transact(async (tx) => {
          const turn = await requireStoredTurn(tx, turnId);
          await tx.turns.set({
            ...turn,
            headTurnNodeHash,
            updatedAtMs: now(),
          });
        });
      },
    },
    verdicts: {
      compose(verdicts: Verdict[]) {
        return Promise.resolve(
          verdicts.find((verdict) => verdict.kind !== "proceed") ?? {
            kind: "proceed",
          }
        );
      },
    },
  };

  return {
    kernel,
    async readBranchMessages(branchId) {
      return await backend.transact(async (tx) => {
        const manifest = await readBranchManifest(tx, branchId);
        const messages = manifest.messages;

        if (!Array.isArray(messages)) {
          return [];
        }

        const output: unknown[] = [];

        for (const hash of messages) {
          const object = await tx.objects.get(hash);

          if (object !== null) {
            output.push(decodeDeterministicKernelRecord(object.bytes));
          }
        }

        return output;
      });
    },
    async readBranchStatus(branchId) {
      return await backend.transact(async (tx) => {
        const manifest = await readBranchManifest(tx, branchId);
        const statusHash = manifest["runtime.status"];

        if (typeof statusHash !== "string") {
          return null;
        }

        const object = await tx.objects.get(statusHash);
        return object === null
          ? null
          : decodeDeterministicKernelRecord(object.bytes);
      });
    },
  };
}

async function* walkBack(
  backend: RuntimeBackend,
  fromHash: HashString
): AsyncIterable<TurnNode> {
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

async function checkpointRun(
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

async function createIncorporatedTree(
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
  const manifest = await requireTreeManifest(tx, baseTree.hash);

  for (const stagedResult of input.stagedResults) {
    const rule = schema.incorporationRules.find(
      (candidate) => candidate.objectType === stagedResult.objectType
    );

    if (rule === undefined) {
      continue;
    }

    const pathDefinition = schema.paths.find(
      (path) => path.path === rule.targetPath
    );

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

  return await createTurnTree(tx, {
    changes: manifest,
    now: input.now,
    schema,
  });
}

async function createTurnTree(
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

async function createTurnNode(
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

async function putObject(
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

function createEmptyManifest(schema: TurnTreeSchema): TurnTreeManifest {
  const manifest: TurnTreeManifest = {};

  for (const path of schema.paths) {
    manifest[path.path] = path.collection === "ordered" ? [] : null;
  }

  return manifest;
}

function normalizeManifest(
  schema: TurnTreeSchema,
  changes: TurnTreeChangeSet
): TurnTreeManifest {
  const manifest = createEmptyManifest(schema);

  for (const path of schema.paths) {
    const value = changes[path.path];

    if (value !== undefined) {
      manifest[path.path] = value;
    }
  }

  return manifest;
}

function toStoredTurnTreePath(
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

async function readBranchManifest(
  tx: RuntimeBackendTx,
  branchId: string
): Promise<TurnTreeManifest> {
  const branch = await requireBranch(tx, branchId);
  const node = await requireTurnNode(tx, branch.headTurnNodeHash);
  return await requireTreeManifest(tx, node.turnTreeHash);
}

async function requireTreeManifest(
  tx: RuntimeBackendTx,
  treeHash: HashString
): Promise<TurnTreeManifest> {
  const tree = await requireTurnTree(tx, treeHash);
  return decodeManifest(tree.manifestCbor);
}

async function requireThreadTurnNode(
  tx: RuntimeBackendTx,
  hash: HashString,
  thread: ThreadRecord
): Promise<TurnNode> {
  for await (const node of walkBackFromTx(tx, hash)) {
    if (node.hash === thread.rootTurnNodeHash) {
      return await requireTurnNode(tx, hash);
    }
  }

  throw new TuvrenRuntimeError("turn node does not belong to thread", {
    code: "playground_kernel_lineage_mismatch",
  });
}

async function* walkBackFromTx(
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

async function listStagedResults(
  tx: RuntimeBackendTx,
  runId: string
): Promise<StagedResult[]> {
  const storedResults = await tx.stagedResults.listByRun(runId);
  return storedResults.map(decodeStoredStagedResult);
}

function createStagedResult(input: {
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

function toStoredStagedResult(
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

function decodeStoredStagedResult(record: StoredStagedResult): StagedResult {
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

function decodeStoredRun(record: StoredRun): RunRecord {
  return {
    branchId: record.branchId,
    createdTurnNodes: decodeHashArray(record.createdTurnNodesCbor),
    currentStepIndex: record.currentStepIndex,
    runId: record.runId,
    schemaId: record.schemaId,
    startTurnNodeHash: record.startTurnNodeHash,
    status: record.status,
    stepSequence: decodeSteps(record.stepSequenceCbor),
    turnId: record.turnId,
  };
}

function decodeStoredTurnNode(record: StoredTurnNode): TurnNode {
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

function toBranchRecord(record: StoredBranch): BranchRecord {
  return {
    branchId: record.branchId,
    headTurnNodeHash: record.headTurnNodeHash,
    threadId: record.threadId,
  };
}

function toTurnRecord(record: StoredTurn): TurnRecord {
  return {
    branchId: record.branchId,
    headTurnNodeHash: record.headTurnNodeHash,
    parentTurnId: record.parentTurnId,
    startTurnNodeHash: record.startTurnNodeHash,
    threadId: record.threadId,
    turnId: record.turnId,
  };
}

async function requireBranch(
  tx: RuntimeBackendTx,
  branchId: string
): Promise<StoredBranch> {
  const branch = await tx.branches.get(branchId);

  if (branch === null) {
    throw new TuvrenRuntimeError(`unknown branch "${branchId}"`, {
      code: "playground_kernel_missing_branch",
    });
  }

  return branch;
}

async function requireRun(
  tx: RuntimeBackendTx,
  runId: string
): Promise<RunRecord> {
  return decodeStoredRun(await requireStoredRun(tx, runId));
}

async function requireStoredRun(
  tx: RuntimeBackendTx,
  runId: string
): Promise<StoredRun> {
  const run = await tx.runs.get(runId);

  if (run === null) {
    throw new TuvrenRuntimeError(`unknown run "${runId}"`, {
      code: "playground_kernel_missing_run",
    });
  }

  return run;
}

async function requireStoredTurn(
  tx: RuntimeBackendTx,
  turnId: string
): Promise<StoredTurn> {
  const turn = await tx.turns.get(turnId);

  if (turn === null) {
    throw new TuvrenRuntimeError(`unknown turn "${turnId}"`, {
      code: "playground_kernel_missing_turn",
    });
  }

  return turn;
}

async function requireTurn(
  tx: RuntimeBackendTx,
  turnId: string
): Promise<TurnRecord> {
  return toTurnRecord(await requireStoredTurn(tx, turnId));
}

async function requireTurnNode(
  tx: RuntimeBackendTx,
  hash: HashString
): Promise<TurnNode> {
  const node = await tx.turnNodes.get(hash);

  if (node === null) {
    throw new TuvrenRuntimeError(`unknown turn node "${hash}"`, {
      code: "playground_kernel_missing_turn_node",
    });
  }

  return decodeStoredTurnNode(node);
}

async function requireTurnTree(
  tx: RuntimeBackendTx,
  hash: HashString
): Promise<{ hash: HashString; manifestCbor: Uint8Array; schemaId: string }> {
  const tree = await tx.turnTrees.get(hash);

  if (tree === null) {
    throw new TuvrenRuntimeError(`unknown turn tree "${hash}"`, {
      code: "playground_kernel_missing_turn_tree",
    });
  }

  return tree;
}

async function requireThread(
  tx: RuntimeBackendTx,
  threadId: string
): Promise<ThreadRecord> {
  const thread = await tx.threads.get(threadId);

  if (thread === null) {
    throw new TuvrenRuntimeError(`unknown thread "${threadId}"`, {
      code: "playground_kernel_missing_thread",
    });
  }

  return {
    rootTurnNodeHash: thread.rootTurnNodeHash,
    schemaId: thread.schemaId,
    threadId: thread.threadId,
  };
}

async function requireSchema(
  tx: RuntimeBackendTx,
  schemaId: string
): Promise<TurnTreeSchema> {
  const schema = await tx.schemas.get(schemaId);

  if (schema === null) {
    throw new TuvrenRuntimeError(`unknown schema "${schemaId}"`, {
      code: "playground_kernel_missing_schema",
    });
  }

  return decodeSchema(schema.schemaCbor);
}

function decodeKernelRecord(bytes: Uint8Array, label: string): KernelRecord {
  const decoded = decodeDeterministicKernelRecord(bytes);

  if (decoded === undefined) {
    throw new TuvrenRuntimeError(`${label} could not be decoded`, {
      code: "playground_kernel_invalid_record",
    });
  }

  return decoded;
}

function decodeSchema(bytes: Uint8Array): TurnTreeSchema {
  const decoded = decodeKernelRecord(bytes, "schema");
  assertTurnTreeSchema(decoded, "schema");
  return decoded;
}

function decodeSteps(bytes: Uint8Array): StepDeclaration[] {
  const decoded = decodeKernelRecord(bytes, "run steps");

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError("run steps must decode to an array", {
      code: "playground_kernel_invalid_record",
    });
  }

  const steps: StepDeclaration[] = [];

  for (const step of decoded) {
    assertStepDeclaration(step, "run step");
    steps.push(step);
  }

  return steps;
}

function decodeHashArray(bytes: Uint8Array): HashString[] {
  const decoded = decodeKernelRecord(bytes, "hash array");

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError("hash array must decode to an array", {
      code: "playground_kernel_invalid_record",
    });
  }

  const hashes: HashString[] = [];

  for (const item of decoded) {
    assertHashString(item, "hash array item");
    hashes.push(item);
  }

  return hashes;
}

function decodeStagedResults(bytes: Uint8Array): StagedResult[] {
  const decoded = decodeKernelRecord(bytes, "staged results");

  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError("staged results must decode to an array", {
      code: "playground_kernel_invalid_record",
    });
  }

  const results: StagedResult[] = [];

  for (const result of decoded) {
    assertStagedResult(result, "staged result");
    results.push(result);
  }

  return results;
}

function decodeManifest(bytes: Uint8Array): TurnTreeManifest {
  const decoded = decodeKernelRecord(bytes, "turn tree manifest");

  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new TuvrenRuntimeError(
      "turn tree manifest must decode to an object",
      {
        code: "playground_kernel_invalid_record",
      }
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
        {
          code: "playground_kernel_invalid_record",
        }
      );
    }
  }

  return manifest;
}

function encodeRecord(value: unknown): Uint8Array {
  return encodeDeterministicKernelRecord(toKernelRecord(value));
}

function toKernelRecord(value: unknown): KernelRecord {
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
    return value.map(toKernelRecord);
  }

  if (typeof value === "object") {
    const record: Record<string, KernelRecord> = {};

    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) {
        record[key] = toKernelRecord(nested);
      }
    }

    return record;
  }

  throw new TuvrenRuntimeError("value is not a kernel record", {
    code: "playground_kernel_invalid_record",
  });
}
