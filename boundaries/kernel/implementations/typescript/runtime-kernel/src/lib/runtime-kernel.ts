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
  type KernelObject,
  type KernelRecord,
  TuvrenLineageError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core-types";
import {
  assertObserveResult,
  assertPathValueForCollectionKind,
  assertStagedResult,
  assertStepDeclaration,
  assertTurnTreeSchema,
  type BranchHeadListEntry,
  type BranchRecord,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
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
} from "@tuvren/kernel-protocol";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

export interface RuntimeKernelOptions {
  backend: RuntimeBackend;
  now?: () => EpochMs;
}

export function createRuntimeKernel(
  options: RuntimeKernelOptions
): RuntimeKernel {
  const now = options.now ?? (() => Date.now() as EpochMs);
  const backend = options.backend;

  return {
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
          await requireThread(tx, threadId);
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

          const currentHead = branch.headTurnNodeHash;

          if (currentHead === turnNodeHash) {
            return { branch: toBranchRecord(branch) } satisfies SetHeadResult;
          }

          const direction = await classifyHeadMovement(
            tx,
            currentHead,
            turnNodeHash
          );

          if (direction === "lateral") {
            throw new TuvrenLineageError(
              `branch.setHead cannot move laterally: "${currentHead}" and "${turnNodeHash}" share no lineage`,
              { code: "kernel_runtime_lateral_head_movement" }
            );
          }

          if (direction === "forward") {
            const updated: StoredBranch = {
              ...branch,
              headTurnNodeHash: turnNodeHash,
              updatedAtMs: now(),
            };
            await tx.branches.set(updated);
            return { branch: toBranchRecord(updated) } satisfies SetHeadResult;
          }

          // Backward: atomic archival rollback
          const abandonedSegmentHashes = await collectAbandonedSegmentHashes(
            tx,
            currentHead,
            turnNodeHash
          );
          const archiveOrdinal =
            (await tx.branches.listByThread(branch.threadId)).filter(
              (candidate) => candidate.archivedFromBranchId === branchId
            ).length + 1;
          const archiveBranchId = `${branchId}-archive-${archiveOrdinal}-${currentHead.slice(0, 16)}`;
          const archiveBranch: StoredBranch = {
            archivedFromBranchId: branchId,
            branchId: archiveBranchId,
            createdAtMs: now(),
            headTurnNodeHash: currentHead,
            threadId: branch.threadId,
            updatedAtMs: now(),
          };
          await tx.branches.set(archiveBranch);

          // Fail all running/paused runs on the abandoned segment
          const branchRuns = await tx.runs.listByBranch(branchId);
          for (const storedRun of branchRuns) {
            if (
              (storedRun.status === "running" ||
                storedRun.status === "paused") &&
              runTouchesSegment(storedRun, abandonedSegmentHashes)
            ) {
              await tx.runs.set({
                ...storedRun,
                status: "failed",
                updatedAtMs: now(),
              });
            }
          }

          const updated: StoredBranch = {
            ...branch,
            headTurnNodeHash: turnNodeHash,
            updatedAtMs: now(),
          };
          await tx.branches.set(updated);

          return {
            archiveBranch: toBranchRecord(archiveBranch),
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
          const storedRun = await requireStoredRun(tx, runId);
          const run = decodeStoredRun(storedRun);

          requireRunningRun(run, runId);
          const step = requireCurrentStep(run, stepId);

          const branch = await requireBranch(tx, run.branchId);
          const schema = await requireSchema(tx, run.schemaId);

          // Return pending signals and clear them
          const signals: KernelRecord[] = storedRun.pendingSignalsCbor
            ? decodeKernelRecordArray(
                storedRun.pendingSignalsCbor,
                "pending signals"
              )
            : [];

          if (storedRun.pendingSignalsCbor !== undefined) {
            const { pendingSignalsCbor: _s, ...runWithoutPendingSignals } =
              storedRun;
            await tx.runs.set({
              ...runWithoutPendingSignals,
              updatedAtMs: now(),
            });
          }

          return {
            currentTurnNodeHash: branch.headTurnNodeHash,
            schema,
            signals,
            step,
          } satisfies StepContext;
        });
      },

      async complete(runId, status, eventHash) {
        return await backend.transact(async (tx) => {
          const storedRun = await requireStoredRun(tx, runId);
          const run = decodeStoredRun(storedRun);

          if (run.status !== "running" && run.status !== "paused") {
            throw new TuvrenRuntimeError(
              `run "${runId}" cannot be completed (status: ${run.status})`,
              { code: "kernel_runtime_run_not_active" }
            );
          }

          if (run.status === "paused" && status !== "failed") {
            throw new TuvrenRuntimeError(
              `paused run "${runId}" can only be completed as failed`,
              { code: "kernel_runtime_invalid_paused_run_completion" }
            );
          }

          await assertEventHashInStore(tx, eventHash);

          const stagedResults = await listStagedResults(tx, runId);
          const turnNodeHash = await maybeCheckpoint(tx, run, stagedResults, {
            eventHash: eventHash ?? null,
            now,
            treeHash: undefined,
          });

          const nextCreatedTurnNodes =
            turnNodeHash === undefined
              ? run.createdTurnNodes
              : [...run.createdTurnNodes, turnNodeHash];

          const { pendingSignalsCbor: _s, ...runWithoutPendingSignals } =
            storedRun;
          await tx.runs.set({
            ...runWithoutPendingSignals,
            createdTurnNodesCbor: encodeRecord(nextCreatedTurnNodes),
            currentStepIndex:
              status === "completed"
                ? run.stepSequence.length
                : storedRun.currentStepIndex,
            status,
            updatedAtMs: now(),
          });

          return turnNodeHash === undefined ? {} : { turnNodeHash };
        });
      },

      async completeStep(runId, stepId, eventHash, observeResults, treeHash) {
        return await backend.transact(async (tx) => {
          const storedRun = await requireStoredRun(tx, runId);
          const run = decodeStoredRun(storedRun);

          requireRunningRun(run, runId);
          const step = requireCurrentStep(run, stepId);

          await assertEventHashInStore(tx, eventHash);
          await assertTreeHashForRun(tx, treeHash, run.schemaId);
          validateObserveResults(observeResults);

          const nextPendingSignalsCbor = accumulateSignalsCbor(
            storedRun.pendingSignalsCbor,
            observeResults
          );

          const stagedResults = await listStagedResults(tx, runId);
          const shouldCheckpoint = stepRequiresCheckpoint(
            step,
            stagedResults,
            treeHash
          );

          const turnNodeHash = shouldCheckpoint
            ? await checkpointAndClear(tx, run, stagedResults, {
                eventHash: eventHash ?? null,
                now,
                treeHash,
              })
            : undefined;
          const nextAnnotationsCbor = await accumulateAnnotationsCbor(
            storedRun.lastStepAnnotationsCbor,
            {
              now,
              observeResults,
              runId,
              stepId,
              turnNodeHash: turnNodeHash ?? null,
            }
          );

          const nextCreatedTurnNodes =
            turnNodeHash === undefined
              ? run.createdTurnNodes
              : [...run.createdTurnNodes, turnNodeHash];

          const {
            lastStepAnnotationsCbor: _a,
            pendingSignalsCbor: _s,
            ...coreRun
          } = storedRun;
          const updatedRun: StoredRun = {
            ...coreRun,
            createdTurnNodesCbor: encodeRecord(nextCreatedTurnNodes),
            currentStepIndex: Math.min(
              run.currentStepIndex + 1,
              run.stepSequence.length
            ),
            updatedAtMs: now(),
            ...(nextPendingSignalsCbor === undefined
              ? {}
              : { pendingSignalsCbor: nextPendingSignalsCbor }),
            ...(nextAnnotationsCbor === undefined
              ? {}
              : { lastStepAnnotationsCbor: nextAnnotationsCbor }),
          };

          await tx.runs.set(updatedRun);

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
          const turn = await requireTurn(tx, turnId);
          const branch = await requireBranch(tx, branchId);

          if (turn.branchId !== branchId || turn.threadId !== branch.threadId) {
            throw new TuvrenRuntimeError(
              "run turn must belong to the requested branch and thread",
              { code: "kernel_runtime_run_turn_mismatch" }
            );
          }

          if (branch.headTurnNodeHash !== startTurnNodeHash) {
            throw new TuvrenRuntimeError(
              "run start turn node must match branch head",
              { code: "kernel_runtime_run_branch_head_mismatch" }
            );
          }

          await requireSchema(tx, schemaId);
          assertUniqueStepIds(steps);

          // Reject if branch already has an active run
          const existingRuns = await tx.runs.listByBranch(branchId);
          const activeRun = existingRuns.find(
            (r) => r.status === "running" || r.status === "paused"
          );
          if (activeRun !== undefined) {
            throw new TuvrenRuntimeError(
              `branch "${branchId}" already has an active run "${activeRun.runId}"`,
              { code: "kernel_runtime_branch_already_active" }
            );
          }

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
          const lastTurnNode = await requireTurnNode(
            tx,
            branch.headTurnNodeHash
          );

          const recoveryState: RecoveryState = {
            consumedStagedResults: lastTurnNode.consumedStagedResults,
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
          assertTurnTreeSchema(schema, "schema");
          const existing = await tx.schemas.get(schema.schemaId);

          if (existing !== null) {
            throw new TuvrenValidationError(
              `schema "${schema.schemaId}" is already registered`,
              { code: "kernel_runtime_duplicate_schema" }
            );
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
        return await backend.transact(async (tx) => {
          await requireRun(tx, runId);
          return await listStagedResults(tx, runId);
        });
      },

      async stage(runId, blob, taskId, objectType, status, interruptPayload) {
        return await backend.transact(async (tx) => {
          const run = await requireRun(tx, runId);

          if (run.status !== "running") {
            throw new TuvrenRuntimeError(
              `run "${runId}" is not in running state (status: ${run.status})`,
              { code: "kernel_runtime_run_not_running" }
            );
          }

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
          await assertThreadCreateIdsAvailable(tx, threadId, initialBranchId);
          const schema = await requireSchema(tx, schemaId);
          const rootTurnTreeHash = await createTurnTree(tx, {
            changes: createEmptyManifest(schema),
            now,
            schema,
          });
          const rootEventHash = await putObject(
            tx,
            encodeRecord({ threadId, type: "kernel_runtime_thread_bootstrap" }),
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
          validateTurnTreeChangeSet(schema, changes);

          let baseManifest: TurnTreeManifest;

          if (baseTurnTreeHash === undefined) {
            // Base-less create: all schema paths must be provided
            for (const pathDef of schema.paths) {
              if (!Object.hasOwn(changes, pathDef.path)) {
                throw new TuvrenValidationError(
                  `path "${pathDef.path}" is required when creating a tree without a base`,
                  { code: "kernel_runtime_missing_required_tree_path" }
                );
              }
            }
            baseManifest = createEmptyManifest(schema);
          } else {
            const baseTree = await requireTurnTree(tx, baseTurnTreeHash);

            if (baseTree.schemaId !== schemaId) {
              throw new TuvrenValidationError(
                `base tree schema "${baseTree.schemaId}" does not match requested schema "${schemaId}"`,
                { code: "kernel_runtime_tree_schema_mismatch" }
              );
            }

            baseManifest = await requireTreeManifest(tx, baseTurnTreeHash);
          }

          return await createTurnTree(tx, {
            changes: { ...baseManifest, ...changes },
            now,
            schema,
          });
        });
      },

      async diff(treeHashA, treeHashB) {
        return await backend.transact(async (tx) => {
          const treeA = await requireTurnTree(tx, treeHashA);
          const treeB = await requireTurnTree(tx, treeHashB);

          if (treeA.schemaId !== treeB.schemaId) {
            throw new TuvrenValidationError(
              `cannot diff trees with different schemas: "${treeA.schemaId}" vs "${treeB.schemaId}"`,
              { code: "kernel_runtime_tree_schema_mismatch_diff" }
            );
          }

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

          // Reject unmatched staged object types (spec Appendix B)
          validateStagedResultsHaveRules(schema, stagedResults);

          const manifest = await requireTreeManifest(tx, baseTurnTreeHash);
          applyStagedResultsToManifest(schema, manifest, stagedResults);

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
          const tree = await requireTurnTree(tx, treeHash);
          const schema = await requireSchema(tx, tree.schemaId);
          const isKnownPath = schema.paths.some((p) => p.path === path);

          if (!isKnownPath) {
            throw new TuvrenValidationError(
              `unknown path "${path}" in schema "${tree.schemaId}"`,
              { code: "kernel_runtime_unknown_tree_path" }
            );
          }

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
          const thread = await requireThread(tx, threadId);
          const branch = await requireBranch(tx, branchId);

          if (branch.threadId !== threadId) {
            throw new TuvrenRuntimeError(
              "turn branch must belong to the requested thread",
              { code: "kernel_runtime_turn_thread_mismatch" }
            );
          }

          await requireThreadTurnNode(tx, startTurnNodeHash, thread);
          await validateTurnParent(
            tx,
            threadId,
            branchId,
            parentTurnId ?? null,
            startTurnNodeHash
          );

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
          const thread = await requireThread(tx, turn.threadId);
          await requireThreadTurnNode(tx, headTurnNodeHash, thread);

          if (
            !(await turnNodeDescendsFrom(
              tx,
              headTurnNodeHash,
              turn.startTurnNodeHash
            ))
          ) {
            throw new TuvrenLineageError(
              `turn head "${headTurnNodeHash}" does not descend from start node "${turn.startTurnNodeHash}"`,
              { code: "kernel_runtime_turn_head_lineage_mismatch" }
            );
          }

          await tx.turns.set({
            ...turn,
            headTurnNodeHash,
            updatedAtMs: now(),
          });
        });
      },
    },

    verdicts: {
      compose(verdicts) {
        const priorityOrder = ["abort", "pause", "modify", "retry"] as const;

        for (const kind of priorityOrder) {
          const match = verdicts.find((v) => v.kind === kind);
          if (match !== undefined) {
            return Promise.resolve(match);
          }
        }

        return Promise.resolve({ kind: "proceed" });
      },
    },
  };
}

async function* walkBack(
  backend: RuntimeBackend,
  fromHash: HashString
): AsyncIterable<TurnNode> {
  // Validate initial hash exists
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

async function classifyHeadMovement(
  tx: RuntimeBackendTx,
  currentHead: HashString,
  targetHash: HashString
): Promise<"forward" | "backward" | "lateral"> {
  // Forward: current head reachable by walking back from target
  for await (const node of walkBackFromTx(tx, targetHash)) {
    if (node.hash === currentHead) {
      return "forward";
    }
  }

  // Backward: target reachable by walking back from current head
  for await (const node of walkBackFromTx(tx, currentHead)) {
    if (node.hash === targetHash) {
      return "backward";
    }
  }

  return "lateral";
}

async function collectAbandonedSegmentHashes(
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

function runTouchesSegment(
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

async function turnNodeDescendsFrom(
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

async function validateTurnParent(
  tx: RuntimeBackendTx,
  threadId: string,
  branchId: string,
  parentTurnId: string | null,
  startTurnNodeHash: HashString
): Promise<void> {
  if (parentTurnId === null) {
    return;
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

  if (parentTurn.branchId !== branchId) {
    return;
  }
}

function stepRequiresCheckpoint(
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

function requireRunningRun(run: RunRecord, runId: string): void {
  if (run.status !== "running") {
    throw new TuvrenRuntimeError(
      `run "${runId}" is not in running state (status: ${run.status})`,
      { code: "kernel_runtime_run_not_running" }
    );
  }
}

function requireCurrentStep(run: RunRecord, stepId: string): StepDeclaration {
  const step = run.stepSequence[run.currentStepIndex];

  if (step === undefined || step.id !== stepId) {
    throw new TuvrenRuntimeError(`unexpected step "${stepId}"`, {
      code: "kernel_runtime_unexpected_step",
    });
  }

  return step;
}

async function assertEventHashInStore(
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

async function assertTreeHashForRun(
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

async function assertThreadCreateIdsAvailable(
  tx: RuntimeBackendTx,
  threadId: string,
  initialBranchId: string
): Promise<void> {
  const existingThread = await tx.threads.get(threadId);

  if (existingThread !== null) {
    throw new TuvrenValidationError(`thread "${threadId}" already exists`, {
      code: "kernel_runtime_duplicate_thread",
    });
  }

  const existingBranch = await tx.branches.get(initialBranchId);

  if (existingBranch !== null) {
    throw new TuvrenValidationError(
      `branch "${initialBranchId}" already exists`,
      { code: "kernel_runtime_duplicate_branch" }
    );
  }
}

function accumulateSignalsCbor(
  existing: Uint8Array | undefined,
  observeResults: { signals: KernelRecord[] }[] | undefined
): Uint8Array | undefined {
  const newSignals: KernelRecord[] =
    observeResults?.flatMap((r) => r.signals) ?? [];

  if (newSignals.length === 0) {
    return existing;
  }

  const existingSignals: KernelRecord[] = existing
    ? decodeKernelRecordArray(existing, "pending signals")
    : [];

  return encodeRecord([...existingSignals, ...newSignals]);
}

async function accumulateAnnotationsCbor(
  existing: Uint8Array | undefined,
  input: {
    now: () => EpochMs;
    observeResults: { annotations: KernelObject[] }[] | undefined;
    runId: string;
    stepId: string;
    turnNodeHash: HashString | null;
  }
): Promise<Uint8Array | undefined> {
  const annotations: KernelObject[] =
    input.observeResults?.flatMap((result) => result.annotations) ?? [];

  if (annotations.length === 0) {
    return existing;
  }

  const records: KernelRecord[] =
    existing === undefined
      ? []
      : decodeKernelRecordArray(existing, "observe annotations");
  const createdAtMs = input.now();

  for (const annotation of annotations) {
    records.push({
      annotation,
      annotationHash: await hashKernelRecord(annotation),
      createdAtMs,
      runId: input.runId,
      stepId: input.stepId,
      turnNodeHash: input.turnNodeHash,
    });
  }

  return encodeRecord(records);
}

function validateObserveResults(observeResults: unknown[] | undefined): void {
  if (observeResults === undefined) {
    return;
  }

  for (const [index, observeResult] of observeResults.entries()) {
    assertObserveResult(observeResult, `observeResults[${index}]`);
  }
}

function assertUniqueStepIds(steps: StepDeclaration[]): void {
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

function validateTurnTreeChangeSet(
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

function validateStagedResultsHaveRules(
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

function applyStagedResultsToManifest(
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

async function maybeCheckpoint(
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

async function checkpointAndClear(
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

  throw new TuvrenLineageError("turn node does not belong to thread", {
    code: "kernel_runtime_lineage_mismatch",
  });
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
      code: "kernel_runtime_missing_branch",
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
      code: "kernel_runtime_missing_run",
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
      code: "kernel_runtime_missing_turn",
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
      code: "kernel_runtime_missing_turn_node",
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
      code: "kernel_runtime_missing_turn_tree",
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
      code: "kernel_runtime_missing_thread",
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
      code: "kernel_runtime_missing_schema",
    });
  }

  return decodeSchema(schema.schemaCbor);
}

function decodeKernelRecord(bytes: Uint8Array, label: string): KernelRecord {
  const decoded = decodeDeterministicKernelRecord(bytes);

  if (decoded === undefined) {
    throw new TuvrenRuntimeError(`${label} could not be decoded`, {
      code: "kernel_runtime_invalid_record",
    });
  }

  return decoded;
}

function decodeKernelRecordArray(
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

function decodeSchema(bytes: Uint8Array): TurnTreeSchema {
  const decoded = decodeKernelRecord(bytes, "schema");
  assertTurnTreeSchema(decoded, "schema");
  return decoded;
}

function decodeSteps(bytes: Uint8Array): StepDeclaration[] {
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

function decodeHashArray(bytes: Uint8Array): HashString[] {
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

function decodeStagedResults(bytes: Uint8Array): StagedResult[] {
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

function decodeManifest(bytes: Uint8Array): TurnTreeManifest {
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
    code: "kernel_runtime_invalid_record",
  });
}
