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

// biome-ignore-all lint/suspicious/useAwait: The fake kernel mirrors the async production protocol surface.
import { createHash } from "node:crypto";
import {
  type EpochMs,
  type HashString,
  type KernelRecord,
  TuvrenRuntimeError,
} from "@tuvren/core";
import {
  type BranchHeadListEntry,
  type BranchRecord,
  type ComposedVerdict,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
  type RuntimeKernel as KrakenKernel,
  type PathValue,
  type RecoveryState,
  type RunRecord,
  type RuntimeKernelRunLiveness,
  type StagedResult,
  type StepContext,
  type StoredThread,
  type TurnNode,
  type TurnRecord,
  type TurnTreeManifest,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  createEmptyContextManifest,
  DEFAULT_AGENT_SCHEMA,
} from "../src/index.js";

interface FakeRunState extends RunRecord {
  stagedResults: StagedResult[];
}

interface FakeLeasedRunRecord extends RunRecord {
  executionOwnerId: string;
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
}

interface StoredTreeState {
  manifest: TurnTreeManifest;
  schemaId: string;
}

interface FakeKernelState {
  branches: Map<string, BranchRecord>;
  objects: Map<HashString, Uint8Array>;
  runs: Map<string, FakeRunState>;
  schemas: Map<string, TurnTreeSchema>;
  threads: Map<
    string,
    {
      createdAtMs: EpochMs;
      rootTurnNodeHash: HashString;
      schemaId: string;
      threadId: string;
    }
  >;
  turnNodes: Map<HashString, TurnNode>;
  turns: Map<string, TurnRecord>;
  turnTrees: Map<HashString, StoredTreeState>;
}

export interface FakeKernelHarness {
  kernel: KrakenKernel;
  readBranchManifest(branchId: string): Promise<TurnTreeManifest>;
  readBranchMessages(branchId: string): Promise<unknown[]>;
  readBranchRuns(branchId: string): Promise<RunRecord[]>;
  readBranchRuntimeStatus(branchId: string): Promise<unknown | null>;
  readRunningStagedMessages(branchId: string): Promise<unknown[]>;
  readTurnNodeManifest(turnNodeHash: HashString): Promise<TurnTreeManifest>;
  readTurnNodeMessages(turnNodeHash: HashString): Promise<unknown[]>;
}

export interface FakeRunLivenessKernelHarness {
  getPreemptCalls(): number;
  getRenewLeaseCalls(): number;
  kernel: KrakenKernel & RuntimeKernelRunLiveness;
  leasedRuns: Map<string, FakeLeasedRunRecord>;
}

export function createFakeKernelHarness(): FakeKernelHarness {
  const state: FakeKernelState = {
    branches: new Map(),
    objects: new Map(),
    runs: new Map(),
    schemas: new Map([[DEFAULT_AGENT_SCHEMA.schemaId, DEFAULT_AGENT_SCHEMA]]),
    threads: new Map(),
    turnNodes: new Map(),
    turns: new Map(),
    turnTrees: new Map(),
  };
  let clock = 1;

  const kernel: KrakenKernel = {
    branch: {
      async create(branchId, threadId, fromTurnNodeHash) {
        const thread = requireThread(state, threadId);
        assertTurnNodeBelongsToThread(
          state,
          fromTurnNodeHash,
          thread.rootTurnNodeHash
        );
        const branch = {
          branchId,
          headTurnNodeHash: fromTurnNodeHash,
          threadId,
        } satisfies BranchRecord;
        state.branches.set(branchId, branch);
        return cloneBranch(branch);
      },
      async get(branchId) {
        const branch = state.branches.get(branchId);
        return branch === undefined ? null : cloneBranch(branch);
      },
      async list(threadId) {
        const entries: BranchHeadListEntry[] = [];

        for (const branch of state.branches.values()) {
          if (branch.threadId === threadId) {
            entries.push([branch.branchId, branch.headTurnNodeHash]);
          }
        }

        return entries;
      },
      async setHead(branchId, turnNodeHash) {
        const branch = requireBranch(state, branchId);
        branch.headTurnNodeHash = turnNodeHash;
        state.branches.set(branchId, branch);
        return {
          branch: cloneBranch(branch),
        };
      },
    },
    maintenance: {
      reclaim() {
        // The fake kernel does not model reachability reclamation; framework
        // tests exercise the runtime against a real backend when they need it.
        return Promise.reject(
          new Error("fake kernel does not implement maintenance.reclaim")
        );
      },
    },
    node: {
      async get(hash) {
        const turnNode = state.turnNodes.get(hash);
        return turnNode === undefined ? null : cloneTurnNode(turnNode);
      },
      async *walkBack(fromHash) {
        let currentHash: HashString | null = fromHash;

        while (currentHash !== null) {
          const node = state.turnNodes.get(currentHash);

          if (node === undefined) {
            return;
          }

          yield cloneTurnNode(node);
          currentHash = node.previousTurnNodeHash;
        }
      },
    },
    run: {
      async beginStep(runId, stepId) {
        const run = requireRun(state, runId);
        const step = run.stepSequence[run.currentStepIndex];

        if (step?.id !== stepId) {
          throw new Error(`unexpected step "${stepId}"`);
        }

        return {
          currentTurnNodeHash: requireBranch(state, run.branchId)
            .headTurnNodeHash,
          schema: requireSchema(state, run.schemaId),
          signals: [],
          step,
        } satisfies StepContext;
      },
      async complete(runId, status, eventHash) {
        const run = requireRun(state, runId);
        run.status = status;
        state.runs.set(runId, run);

        if (run.stagedResults.length > 0 || eventHash !== undefined) {
          const turnNodeHash = await checkpointRun(
            state,
            run,
            clock++,
            eventHash ?? null
          );
          run.stagedResults = [];
          state.runs.set(runId, run);
          return {
            turnNodeHash,
          };
        }

        return {};
      },
      async completeStep(runId, _stepId, eventHash, _observeResults, treeHash) {
        const run = requireRun(state, runId);
        const branch = requireBranch(state, run.branchId);
        const headNode = requireTurnNode(state, branch.headTurnNodeHash);
        const nextTreeHash =
          treeHash ??
          (await incorporateTree(
            state,
            headNode.turnTreeHash,
            run.stagedResults,
            run.schemaId
          ));
        const turnNodeHash = await createTurnNode(
          state,
          branch.headTurnNodeHash,
          nextTreeHash,
          run.schemaId,
          run.stagedResults,
          eventHash ?? null
        );
        branch.headTurnNodeHash = turnNodeHash;
        state.branches.set(branch.branchId, branch);
        run.createdTurnNodes.push(turnNodeHash);
        run.currentStepIndex += 1;
        run.stagedResults = [];
        state.runs.set(runId, run);
        return {
          checkpointed: true,
          turnNodeHash,
        };
      },
      async create(
        runId,
        turnId,
        branchId,
        schemaId,
        startTurnNodeHash,
        steps
      ) {
        const activeRun = findActiveRunForBranch(state, branchId);

        if (activeRun !== undefined) {
          throw new Error(
            `branch "${branchId}" already has an active run "${activeRun.runId}"`
          );
        }

        const run: FakeRunState = {
          branchId,
          createdTurnNodes: [],
          currentStepIndex: 0,
          runId,
          schemaId,
          stagedResults: [],
          startTurnNodeHash,
          status: "running",
          stepSequence: steps,
          turnId,
        };
        state.runs.set(runId, run);
        return cloneRun(run);
      },
      async recover(runId) {
        const run = requireRun(state, runId);
        return {
          consumedStagedResults: [],
          lastCompletedStepId:
            run.currentStepIndex === 0
              ? null
              : (run.stepSequence[run.currentStepIndex - 1]?.id ?? null),
          lastTurnNodeHash: requireBranch(state, run.branchId).headTurnNodeHash,
          stepSequence: run.stepSequence,
          uncommittedStagedResults: [...run.stagedResults],
        } satisfies RecoveryState;
      },
    },
    schema: {
      async get(schemaId) {
        return state.schemas.get(schemaId) ?? null;
      },
      async register(schema) {
        state.schemas.set(schema.schemaId, schema);
        return schema.schemaId;
      },
    },
    staging: {
      async current(runId) {
        return [...requireRun(state, runId).stagedResults];
      },
      async stage(runId, blob, taskId, objectType, status, interruptPayload) {
        const run = requireRun(state, runId);
        const objectHash = hashBytes(blob);
        state.objects.set(objectHash, blob);
        const stagedResult: StagedResult =
          status === "interrupted"
            ? {
                interruptPayload: interruptPayload as KernelRecord,
                objectHash,
                objectType,
                status,
                taskId,
                timestamp: clock++,
              }
            : {
                objectHash,
                objectType,
                status,
                taskId,
                timestamp: clock++,
              };
        run.stagedResults.push(stagedResult);
        state.runs.set(runId, run);
        return {
          objectHash,
          stagedResult,
        };
      },
    },
    store: {
      async get(hash) {
        return state.objects.get(hash) ?? null;
      },
      async has(hash) {
        return state.objects.has(hash);
      },
      async put(blob) {
        const hash = hashBytes(blob);
        if (!state.objects.has(hash)) {
          state.objects.set(hash, blob);
        }
        return hash;
      },
    },
    thread: {
      async create(threadId, schemaId, initialBranchId) {
        const schema = requireSchema(state, schemaId);
        const manifestHash = await kernel.store.put(
          encodeDeterministicKernelRecord(
            createEmptyContextManifest() as unknown as KernelRecord
          )
        );
        const rootTreeHash = await createTree(
          state,
          {
            "context.manifest": manifestHash,
            "runtime.status": null,
            "turn.lineage": null,
            messages: [],
          },
          schema
        );
        const rootTurnNodeHash = await createTurnNode(
          state,
          null,
          rootTreeHash,
          schemaId,
          [],
          null
        );
        state.threads.set(threadId, {
          createdAtMs: clock++ as EpochMs,
          rootTurnNodeHash,
          schemaId,
          threadId,
        });
        state.branches.set(initialBranchId, {
          branchId: initialBranchId,
          headTurnNodeHash: rootTurnNodeHash,
          threadId,
        });
        return {
          branchId: initialBranchId,
          rootTurnNodeHash,
          rootTurnTreeHash: rootTreeHash,
          threadId,
        };
      },
      async get(threadId) {
        return state.threads.get(threadId) ?? null;
      },
      async list(options) {
        let threads: StoredThread[] = Array.from(state.threads.values()).map(
          (t) => ({
            createdAtMs: t.createdAtMs,
            rootTurnNodeHash: t.rootTurnNodeHash,
            schemaId: t.schemaId,
            threadId: t.threadId,
          })
        );

        if (options?.filter?.schemaId !== undefined) {
          const filterSchemaId = options.filter.schemaId;
          threads = threads.filter((t) => t.schemaId === filterSchemaId);
        }

        threads.sort((a, b) =>
          a.createdAtMs === b.createdAtMs
            ? a.threadId.localeCompare(b.threadId)
            : a.createdAtMs - b.createdAtMs
        );

        if (options?.cursor !== undefined) {
          const { lastCreatedAtMs, lastThreadId } = JSON.parse(
            Buffer.from(options.cursor, "base64url").toString("utf8")
          ) as { lastCreatedAtMs: number; lastThreadId: string };
          threads = threads.filter(
            (t) =>
              t.createdAtMs > lastCreatedAtMs ||
              (t.createdAtMs === lastCreatedAtMs && t.threadId > lastThreadId)
          );
        }

        let nextCursor: string | undefined;
        if (options?.limit !== undefined && threads.length > options.limit) {
          threads = threads.slice(0, options.limit);
          const last = threads.at(-1);
          if (last !== undefined) {
            nextCursor = Buffer.from(
              JSON.stringify({
                lastCreatedAtMs: last.createdAtMs,
                lastThreadId: last.threadId,
              }),
              "utf8"
            ).toString("base64url");
          }
        }

        return { threads, nextCursor };
      },
    },
    tree: {
      async create(schemaId, changes, baseTurnTreeHash) {
        const schema = requireSchema(state, schemaId);
        const baseManifest =
          baseTurnTreeHash === undefined
            ? createEmptyTreeManifest(schema)
            : cloneManifest(requireTree(state, baseTurnTreeHash).manifest);

        for (const [path, value] of Object.entries(changes)) {
          baseManifest[path] = clonePathValue(value);
        }

        return await createTree(state, baseManifest, schema);
      },
      async diff(treeHashA, treeHashB) {
        const treeA = requireTree(state, treeHashA).manifest;
        const treeB = requireTree(state, treeHashB).manifest;
        const changedPaths: string[] = [];

        for (const path of new Set([
          ...Object.keys(treeA),
          ...Object.keys(treeB),
        ])) {
          if (JSON.stringify(treeA[path]) !== JSON.stringify(treeB[path])) {
            changedPaths.push(path);
          }
        }

        return changedPaths;
      },
      async incorporate(baseTurnTreeHash, stagedResults) {
        const baseTree = requireTree(state, baseTurnTreeHash);
        return await incorporateTree(
          state,
          baseTurnTreeHash,
          stagedResults,
          baseTree.schemaId
        );
      },
      async manifest(treeHash) {
        return cloneManifest(requireTree(state, treeHash).manifest);
      },
      async resolve(treeHash, path) {
        return clonePathValue(requireTree(state, treeHash).manifest[path]);
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
        const turn: TurnRecord = {
          branchId,
          headTurnNodeHash: startTurnNodeHash,
          parentTurnId: parentTurnId ?? null,
          startTurnNodeHash,
          threadId,
          turnId,
        };
        state.turns.set(turnId, turn);
        return cloneTurn(turn);
      },
      async get(turnId) {
        const turn = state.turns.get(turnId);
        return turn === undefined ? null : cloneTurn(turn);
      },
      async updateHead(turnId, headTurnNodeHash) {
        const turn = requireTurn(state, turnId);
        turn.headTurnNodeHash = headTurnNodeHash;
        state.turns.set(turnId, turn);
      },
    },
    verdicts: {
      async compose(verdicts) {
        const abort = verdicts.find((verdict) => verdict.kind === "abort");
        if (abort !== undefined) {
          return abort;
        }

        const pause = verdicts.find((verdict) => verdict.kind === "pause");
        if (pause !== undefined) {
          return pause;
        }

        const modifyTransforms = verdicts
          .filter((verdict) => verdict.kind === "modify")
          .map((verdict) => verdict.transform);
        if (modifyTransforms.length === 1) {
          return {
            kind: "modify",
            transform: modifyTransforms[0],
          } satisfies ComposedVerdict;
        }

        if (modifyTransforms.length > 1) {
          return {
            kind: "modify",
            transform: modifyTransforms,
          } satisfies ComposedVerdict;
        }

        return (verdicts.find((verdict) => verdict.kind === "retry") ?? {
          kind: "proceed",
        }) satisfies ComposedVerdict;
      },
    },
  };

  const readMessagesFromManifest = (manifest: TurnTreeManifest): unknown[] => {
    const hashes = manifest.messages;

    if (!Array.isArray(hashes)) {
      return [];
    }

    const messages: unknown[] = [];

    for (const hash of hashes) {
      if (!isHashString(hash)) {
        continue;
      }

      const payload = state.objects.get(hash);

      if (payload !== undefined) {
        messages.push(decodeDeterministicKernelRecord(payload));
      }
    }

    return messages;
  };

  return {
    kernel,
    async readBranchManifest(branchId) {
      const branch = requireBranch(state, branchId);
      const turnNode = requireTurnNode(state, branch.headTurnNodeHash);
      return cloneManifest(requireTree(state, turnNode.turnTreeHash).manifest);
    },
    async readBranchMessages(branchId) {
      const manifest = await this.readBranchManifest(branchId);
      return readMessagesFromManifest(manifest);
    },
    async readBranchRuntimeStatus(branchId) {
      const manifest = await this.readBranchManifest(branchId);
      const runtimeStatusHash = manifest["runtime.status"];

      if (!isHashString(runtimeStatusHash)) {
        return null;
      }

      const payload = state.objects.get(runtimeStatusHash);

      return payload === undefined
        ? null
        : decodeDeterministicKernelRecord(payload);
    },
    async readBranchRuns(branchId) {
      return [...state.runs.values()]
        .filter((run) => run.branchId === branchId)
        .map(cloneRun);
    },
    async readRunningStagedMessages(branchId) {
      const run = [...state.runs.values()].find(
        (candidate) =>
          candidate.branchId === branchId && candidate.status === "running"
      );

      if (run === undefined) {
        return [];
      }

      const messages: unknown[] = [];

      for (const stagedResult of run.stagedResults) {
        if (stagedResult.objectType !== "message") {
          continue;
        }

        const payload = state.objects.get(stagedResult.objectHash);

        if (payload !== undefined) {
          messages.push(decodeDeterministicKernelRecord(payload));
        }
      }

      return messages;
    },
    async readTurnNodeManifest(turnNodeHash) {
      const turnNode = requireTurnNode(state, turnNodeHash);
      return cloneManifest(requireTree(state, turnNode.turnTreeHash).manifest);
    },
    async readTurnNodeMessages(turnNodeHash) {
      const manifest = await this.readTurnNodeManifest(turnNodeHash);
      return readMessagesFromManifest(manifest);
    },
  };
}

export function createFakeRunLivenessKernelHarness(
  harness: FakeKernelHarness,
  options?: {
    onRenewLease?: (
      runId: string,
      executionOwnerId: string,
      fencingToken: string,
      nextLeaseExpiresAtMs: EpochMs
    ) => Promise<{ fencingToken: string; leaseExpiresAtMs: EpochMs }>;
  }
): FakeRunLivenessKernelHarness {
  let preemptCalls = 0;
  let renewLeaseCalls = 0;
  let tokenOrdinal = 0;
  const leasedRuns = new Map<string, FakeLeasedRunRecord>();
  const baseKernel = harness.kernel;

  return {
    getPreemptCalls() {
      return preemptCalls;
    },
    getRenewLeaseCalls() {
      return renewLeaseCalls;
    },
    kernel: {
      ...baseKernel,
      run: {
        ...baseKernel.run,
        async complete(runId, status, eventHash) {
          const completion = await baseKernel.run.complete(
            runId,
            status,
            eventHash
          );
          leasedRuns.delete(runId);
          return completion;
        },
      },
      runLiveness: {
        async createLeasedRun(input) {
          try {
            const run = await baseKernel.run.create(
              input.runId,
              input.turnId,
              input.branchId,
              input.schemaId,
              input.startTurnNodeHash,
              input.steps
            );
            const leasedRun: FakeLeasedRunRecord = {
              ...run,
              executionOwnerId: input.executionOwnerId,
              fencingToken: `token-${++tokenOrdinal}`,
              leaseExpiresAtMs: input.leaseExpiresAtMs,
            };
            leasedRuns.set(leasedRun.runId, leasedRun);
            return { ...leasedRun };
          } catch (error: unknown) {
            // The fake kernel only signals active-branch contention by message,
            // so the wrapper normalizes it into the real kernel error code that
            // runtime-core branches on for stale-run recovery.
            if (
              error instanceof Error &&
              error.message.includes("already has an active run")
            ) {
              throw new TuvrenRuntimeError(error.message, {
                code: "kernel_runtime_branch_already_active",
              });
            }

            throw error;
          }
        },
        async listExpired(nowMs) {
          return [...leasedRuns.values()].filter(
            (run) => run.leaseExpiresAtMs <= nowMs
          );
        },
        async preemptExpired(runId, _preemptingOwnerId, _nowMs, _reason) {
          const leasedRun = leasedRuns.get(runId);

          if (leasedRun === undefined) {
            throw new Error(`expected leased run "${runId}"`);
          }

          preemptCalls += 1;
          const completion = await baseKernel.run.complete(runId, "failed");
          const recoveredBranch = await baseKernel.branch.get(
            leasedRun.branchId
          );

          if (recoveredBranch === null) {
            throw new Error(`expected branch "${leasedRun.branchId}"`);
          }

          leasedRuns.delete(runId);
          return {
            consumedStagedResults: [],
            lastCompletedStepId: null,
            lastTurnNodeHash:
              completion.turnNodeHash ?? recoveredBranch.headTurnNodeHash,
            stepSequence: leasedRun.stepSequence,
            uncommittedStagedResults: [],
          } satisfies RecoveryState;
        },
        async renewLease(
          runId,
          executionOwnerId,
          fencingToken,
          nextLeaseExpiresAtMs
        ) {
          renewLeaseCalls += 1;

          if (options?.onRenewLease !== undefined) {
            return await options.onRenewLease(
              runId,
              executionOwnerId,
              fencingToken,
              nextLeaseExpiresAtMs
            );
          }

          const leasedRun = leasedRuns.get(runId);

          if (leasedRun === undefined) {
            throw new TuvrenRuntimeError(`run "${runId}" is not leased`, {
              code: "kernel_runtime_run_not_leased",
            });
          }

          leasedRun.fencingToken = `token-renewed-${renewLeaseCalls}`;
          leasedRun.leaseExpiresAtMs = nextLeaseExpiresAtMs;
          leasedRuns.set(runId, leasedRun);

          return {
            fencingToken: `token-renewed-${renewLeaseCalls}`,
            leaseExpiresAtMs: nextLeaseExpiresAtMs,
          };
        },
      },
    } satisfies KrakenKernel & RuntimeKernelRunLiveness,
    leasedRuns,
  };
}

async function checkpointRun(
  state: FakeKernelState,
  run: FakeRunState,
  _timestamp: number,
  eventHash: HashString | null
): Promise<HashString> {
  const branch = requireBranch(state, run.branchId);
  const headNode = requireTurnNode(state, branch.headTurnNodeHash);
  const turnTreeHash = await incorporateTree(
    state,
    headNode.turnTreeHash,
    run.stagedResults,
    run.schemaId
  );
  const turnNodeHash = await createTurnNode(
    state,
    branch.headTurnNodeHash,
    turnTreeHash,
    run.schemaId,
    run.stagedResults,
    eventHash
  );
  branch.headTurnNodeHash = turnNodeHash;
  state.branches.set(branch.branchId, branch);
  run.createdTurnNodes.push(turnNodeHash);
  run.currentStepIndex += 1;
  run.stagedResults = [];
  run.status = "failed";
  state.runs.set(run.runId, run);
  return turnNodeHash;
}

async function incorporateTree(
  state: FakeKernelState,
  baseTurnTreeHash: HashString,
  stagedResults: StagedResult[],
  schemaId: string
): Promise<HashString> {
  const schema = requireSchema(state, schemaId);
  const manifest = cloneManifest(requireTree(state, baseTurnTreeHash).manifest);

  for (const stagedResult of stagedResults) {
    const rule = schema.incorporationRules.find(
      (candidate) => candidate.objectType === stagedResult.objectType
    );

    if (rule === undefined) {
      continue;
    }

    const pathDefinition = schema.paths.find(
      (candidate) => candidate.path === rule.targetPath
    );

    if (pathDefinition?.collection === "ordered") {
      const currentValue = manifest[rule.targetPath];
      const hashes = Array.isArray(currentValue) ? [...currentValue] : [];
      hashes.push(stagedResult.objectHash);
      manifest[rule.targetPath] = hashes;
    } else {
      manifest[rule.targetPath] = stagedResult.objectHash;
    }
  }

  return await createTree(state, manifest, schema);
}

async function createTree(
  state: FakeKernelState,
  manifest: TurnTreeManifest,
  schema: TurnTreeSchema
): Promise<HashString> {
  const hash = await hashTurnTreeIdentity(schema.schemaId, manifest, schema);
  state.turnTrees.set(hash, {
    manifest: cloneManifest(manifest),
    schemaId: schema.schemaId,
  });
  return hash;
}

async function createTurnNode(
  state: FakeKernelState,
  previousTurnNodeHash: HashString | null,
  turnTreeHash: HashString,
  schemaId: string,
  consumedStagedResults: StagedResult[],
  eventHash: HashString | null
): Promise<HashString> {
  const hash = await hashTurnNodeIdentity({
    consumedStagedResults,
    eventHash,
    previousTurnNodeHash,
    schemaId,
    turnTreeHash,
  });
  state.turnNodes.set(hash, {
    consumedStagedResults: [...consumedStagedResults],
    eventHash,
    hash,
    previousTurnNodeHash,
    schemaId,
    turnTreeHash,
  });
  return hash;
}

function assertTurnNodeBelongsToThread(
  state: FakeKernelState,
  turnNodeHash: HashString,
  rootTurnNodeHash: HashString
): void {
  let currentHash: HashString | null = turnNodeHash;

  while (currentHash !== null) {
    if (currentHash === rootTurnNodeHash) {
      return;
    }

    currentHash = requireTurnNode(state, currentHash).previousTurnNodeHash;
  }

  throw new Error("turn node does not belong to thread");
}

function cloneBranch(branch: BranchRecord): BranchRecord {
  return { ...branch };
}

function cloneManifest(manifest: TurnTreeManifest): TurnTreeManifest {
  return Object.fromEntries(
    Object.entries(manifest).map(([path, value]) => [
      path,
      clonePathValue(value),
    ])
  );
}

function clonePathValue(value: PathValue): PathValue {
  return Array.isArray(value) ? [...value] : value;
}

function cloneRun(run: RunRecord): RunRecord {
  return {
    ...run,
    createdTurnNodes: [...run.createdTurnNodes],
    stepSequence: run.stepSequence.map((step) => ({ ...step })),
  };
}

function cloneTurn(turn: TurnRecord): TurnRecord {
  return { ...turn };
}

function cloneTurnNode(turnNode: TurnNode): TurnNode {
  return {
    ...turnNode,
    consumedStagedResults: [...turnNode.consumedStagedResults],
  };
}

function createEmptyTreeManifest(schema: TurnTreeSchema): TurnTreeManifest {
  return Object.fromEntries(
    schema.paths.map((pathDefinition) => [
      pathDefinition.path,
      pathDefinition.collection === "ordered" ? [] : null,
    ])
  );
}

function hashBytes(value: Uint8Array): HashString {
  return createHash("sha256").update(value).digest("hex");
}

function requireBranch(state: FakeKernelState, branchId: string): BranchRecord {
  const branch = state.branches.get(branchId);

  if (branch === undefined) {
    throw new Error(`missing branch "${branchId}"`);
  }

  return branch;
}

function requireRun(state: FakeKernelState, runId: string): FakeRunState {
  const run = state.runs.get(runId);

  if (run === undefined) {
    throw new Error(`missing run "${runId}"`);
  }

  return run;
}

function findActiveRunForBranch(
  state: FakeKernelState,
  branchId: string
): FakeRunState | undefined {
  return [...state.runs.values()].find(
    (run) =>
      run.branchId === branchId &&
      (run.status === "running" || run.status === "paused")
  );
}

function requireSchema(
  state: FakeKernelState,
  schemaId: string
): TurnTreeSchema {
  const schema = state.schemas.get(schemaId);

  if (schema === undefined) {
    throw new Error(`missing schema "${schemaId}"`);
  }

  return schema;
}

function requireThread(
  state: FakeKernelState,
  threadId: string
): {
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
} {
  const thread = state.threads.get(threadId);

  if (thread === undefined) {
    throw new Error(`missing thread "${threadId}"`);
  }

  return thread;
}

function requireTree(
  state: FakeKernelState,
  treeHash: HashString
): StoredTreeState {
  const tree = state.turnTrees.get(treeHash);

  if (tree === undefined) {
    throw new Error(`missing tree "${treeHash}"`);
  }

  return tree;
}

function requireTurn(state: FakeKernelState, turnId: string): TurnRecord {
  const turn = state.turns.get(turnId);

  if (turn === undefined) {
    throw new Error(`missing turn "${turnId}"`);
  }

  return turn;
}

function requireTurnNode(
  state: FakeKernelState,
  turnNodeHash: HashString
): TurnNode {
  const turnNode = state.turnNodes.get(turnNodeHash);

  if (turnNode === undefined) {
    throw new Error(`missing turn node "${turnNodeHash}"`);
  }

  return turnNode;
}

function isHashString(value: unknown): value is HashString {
  return typeof value === "string" && value.length > 0;
}
