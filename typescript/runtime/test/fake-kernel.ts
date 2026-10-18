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

import { assertKernelRecord, TuvrenRuntimeError } from "@tuvren/core";
import type { EpochMs, HashString } from "@tuvren/core";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
} from "@tuvren/kernel-protocol";
import type {
  BranchHeadListEntry,
  BranchRecord,
  ComposedVerdict,
  PathValue,
  RecoveryState,
  RunRecord,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  StagedResult,
  StepContext,
  StoredThread,
  TurnNode,
  TurnRecord,
  TurnTreeManifest,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";

import {
  createEmptyContextManifest,
  DEFAULT_AGENT_SCHEMA,
} from "../src/index.js";
import {
  fromSynchronousVariadicAwaited,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

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
  completeRunAsPreempted: (
    runId: string,
    reason: string,
    eventHash: HashString
  ) => ReturnType<RuntimeKernel["run"]["complete"]>;
  kernel: RuntimeKernel;
  readBranchManifest: (branchId: string) => Promise<TurnTreeManifest>;
  readBranchMessages: (branchId: string) => Promise<unknown[]>;
  readBranchRuns: (branchId: string) => Promise<RunRecord[]>;
  readBranchRuntimeStatus: (branchId: string) => Promise<unknown>;
  readRunningStagedMessages: (branchId: string) => Promise<unknown[]>;
  readTurnNodeManifest: (turnNodeHash: HashString) => Promise<TurnTreeManifest>;
  readTurnNodeMessages: (turnNodeHash: HashString) => Promise<unknown[]>;
}

export interface FakeRunLivenessKernelHarness {
  getPreemptCalls: () => number;
  getRenewLeaseCalls: () => number;
  kernel: RuntimeKernel & RuntimeKernelRunLiveness;
  leasedRuns: Map<string, FakeLeasedRunRecord>;
}

const requireThread = (
  state: FakeKernelState,
  threadId: string
): {
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
} => {
  const thread = state.threads.get(threadId);

  if (thread === undefined) {
    throw new Error(`missing thread "${threadId}"`);
  }

  return thread;
};

const requireTurnNode = (
  state: FakeKernelState,
  turnNodeHash: HashString
): TurnNode => {
  const turnNode = state.turnNodes.get(turnNodeHash);

  if (turnNode === undefined) {
    throw new Error(`missing turn node "${turnNodeHash}"`);
  }

  return turnNode;
};

const assertTurnNodeBelongsToThread = (
  state: FakeKernelState,
  turnNodeHash: HashString,
  rootTurnNodeHash: HashString
): void => {
  let currentHash: HashString | null = turnNodeHash;

  while (currentHash !== null) {
    if (currentHash === rootTurnNodeHash) {
      return;
    }

    currentHash = requireTurnNode(state, currentHash).previousTurnNodeHash;
  }

  throw new Error("turn node does not belong to thread");
};

const cloneBranch = (branch: BranchRecord): BranchRecord => ({ ...branch });

const requireBranch = (
  state: FakeKernelState,
  branchId: string
): BranchRecord => {
  const branch = state.branches.get(branchId);

  if (branch === undefined) {
    throw new Error(`missing branch "${branchId}"`);
  }

  return branch;
};

const cloneTurnNode = (turnNode: TurnNode): TurnNode => ({
  ...turnNode,
  consumedStagedResults: [...turnNode.consumedStagedResults],
});

const requireRun = (state: FakeKernelState, runId: string): FakeRunState => {
  const run = state.runs.get(runId);

  if (run === undefined) {
    throw new Error(`missing run "${runId}"`);
  }

  return run;
};

const requireSchema = (
  state: FakeKernelState,
  schemaId: string
): TurnTreeSchema => {
  const schema = state.schemas.get(schemaId);

  if (schema === undefined) {
    throw new Error(`missing schema "${schemaId}"`);
  }

  return schema;
};

const clonePathValue = (value: PathValue): PathValue =>
  Array.isArray(value) ? [...value] : value;

const cloneManifest = (manifest: TurnTreeManifest): TurnTreeManifest =>
  Object.fromEntries(
    Object.entries(manifest).map(([path, value]) => [
      path,
      clonePathValue(value),
    ])
  );

const requireTree = (
  state: FakeKernelState,
  treeHash: HashString
): StoredTreeState => {
  const tree = state.turnTrees.get(treeHash);

  if (tree === undefined) {
    throw new Error(`missing tree "${treeHash}"`);
  }

  return tree;
};

const createTree = async (
  state: FakeKernelState,
  manifest: TurnTreeManifest,
  schema: TurnTreeSchema
): Promise<HashString> => {
  const hash = await hashTurnTreeIdentity(schema.schemaId, manifest, schema);
  state.turnTrees.set(hash, {
    manifest: cloneManifest(manifest),
    schemaId: schema.schemaId,
  });
  return hash;
};

const incorporateTree = async (
  state: FakeKernelState,
  baseTurnTreeHash: HashString,
  stagedResults: StagedResult[],
  schemaId: string
): Promise<HashString> => {
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
};

const createTurnNode = async (
  state: FakeKernelState,
  previousTurnNodeHash: HashString | null,
  turnTreeHash: HashString,
  schemaId: string,
  consumedStagedResults: StagedResult[],
  eventHash: HashString | null
): Promise<HashString> => {
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
};

const checkpointRun = async (
  state: FakeKernelState,
  run: FakeRunState,
  _timestamp: number,
  eventHash: HashString | null
): Promise<HashString> => {
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
};

const findActiveRunForBranch = (
  state: FakeKernelState,
  branchId: string
): FakeRunState | undefined =>
  [...state.runs.values()].find(
    (run) =>
      run.branchId === branchId &&
      (run.status === "running" || run.status === "paused")
  );

const cloneRun = (run: RunRecord): RunRecord => ({
  ...run,
  createdTurnNodes: [...run.createdTurnNodes],
  stepSequence: run.stepSequence.map((step) => ({ ...step })),
});

const hashBytes = (value: Uint8Array): HashString =>
  createHash("sha256").update(value).digest("hex");

const createEmptyTreeManifest = (schema: TurnTreeSchema): TurnTreeManifest =>
  Object.fromEntries(
    schema.paths.map((pathDefinition) => [
      pathDefinition.path,
      pathDefinition.collection === "ordered" ? [] : null,
    ])
  );

const cloneTurn = (turn: TurnRecord): TurnRecord => ({ ...turn });

const requireTurn = (state: FakeKernelState, turnId: string): TurnRecord => {
  const turn = state.turns.get(turnId);

  if (turn === undefined) {
    throw new Error(`missing turn "${turnId}"`);
  }

  return turn;
};

const isHashString = (value: unknown): value is HashString =>
  typeof value === "string" && value.length > 0;

const parseThreadCursor = (
  cursor: string
): { lastCreatedAtMs: number; lastThreadId: string } => {
  const value = toOptionalRecord(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"))
  );
  const lastCreatedAtMs = value?.lastCreatedAtMs;
  const lastThreadId = value?.lastThreadId;

  if (typeof lastCreatedAtMs !== "number" || typeof lastThreadId !== "string") {
    throw new TypeError("invalid thread cursor");
  }

  return { lastCreatedAtMs, lastThreadId };
};

export const createFakeKernelHarness = (): FakeKernelHarness => {
  const state: FakeKernelState = {
    branches: new Map(),
    objects: new Map(),
    runs: new Map(),
    schemas: new Map([[DEFAULT_AGENT_SCHEMA.schemaId, DEFAULT_AGENT_SCHEMA]]),
    threads: new Map(),
    turnNodes: new Map(),
    turnTrees: new Map(),
    turns: new Map(),
  };
  let clock = 1;
  const nextClock = (): number => {
    const timestamp = clock;
    clock += 1;
    return timestamp;
  };

  const kernel: RuntimeKernel = {
    branch: {
      create: fromSynchronousVariadicAwaited(
        (branchId, threadId, fromTurnNodeHash) => {
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
        }
      ),
      get: fromSynchronousVariadicAwaited((branchId) => {
        const branch = state.branches.get(branchId);
        return branch === undefined ? null : cloneBranch(branch);
      }),
      list: fromSynchronousVariadicAwaited((threadId) => {
        const entries: BranchHeadListEntry[] = [];

        for (const branch of state.branches.values()) {
          if (branch.threadId === threadId) {
            entries.push([branch.branchId, branch.headTurnNodeHash]);
          }
        }

        return entries;
      }),
      setHead: fromSynchronousVariadicAwaited((branchId, turnNodeHash) => {
        const branch = requireBranch(state, branchId);
        branch.headTurnNodeHash = turnNodeHash;
        state.branches.set(branchId, branch);
        return {
          branch: cloneBranch(branch),
        };
      }),
    },
    maintenance: {
      reclaim: fromSynchronousVariadicAwaited(() => {
        // The fake kernel does not model reachability reclamation; framework
        // tests exercise the runtime against a real backend when they need it.
        throw new Error("fake kernel does not implement maintenance.reclaim");
      }),
    },
    node: {
      get: fromSynchronousVariadicAwaited((hash) => {
        const turnNode = state.turnNodes.get(hash);
        return turnNode === undefined ? null : cloneTurnNode(turnNode);
      }),
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
      beginStep: fromSynchronousVariadicAwaited((runId, stepId) => {
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
      }),
      async complete(runId, status, eventHash) {
        const run = requireRun(state, runId);
        run.status = status;
        state.runs.set(runId, run);

        if (run.stagedResults.length > 0 || eventHash !== undefined) {
          const turnNodeHash = await checkpointRun(
            state,
            run,
            nextClock(),
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
      create: fromSynchronousVariadicAwaited(
        (runId, turnId, branchId, schemaId, startTurnNodeHash, steps) => {
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
        }
      ),
      recover: fromSynchronousVariadicAwaited((runId) => {
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
      }),
    },
    schema: {
      get: fromSynchronousVariadicAwaited(
        (schemaId) => state.schemas.get(schemaId) ?? null
      ),
      register: fromSynchronousVariadicAwaited((schema) => {
        state.schemas.set(schema.schemaId, schema);
        return schema.schemaId;
      }),
    },
    staging: {
      current: fromSynchronousVariadicAwaited((runId) => [
        ...requireRun(state, runId).stagedResults,
      ]),
      stage: fromSynchronousVariadicAwaited(
        (runId, blob, taskId, objectType, status, interruptPayload) => {
          const run = requireRun(state, runId);
          const objectHash = hashBytes(blob);
          state.objects.set(objectHash, blob);
          let stagedResult: StagedResult;

          if (status === "interrupted") {
            if (interruptPayload === undefined) {
              throw new Error(
                "interrupted staging requires an interrupt payload"
              );
            }

            stagedResult = {
              interruptPayload,
              objectHash,
              objectType,
              status,
              taskId,
              timestamp: nextClock(),
            };
          } else {
            stagedResult = {
              objectHash,
              objectType,
              status,
              taskId,
              timestamp: nextClock(),
            };
          }
          run.stagedResults.push(stagedResult);
          state.runs.set(runId, run);
          return {
            objectHash,
            stagedResult,
          };
        }
      ),
    },
    store: {
      get: fromSynchronousVariadicAwaited(
        (hash) => state.objects.get(hash) ?? null
      ),
      has: fromSynchronousVariadicAwaited((hash) => state.objects.has(hash)),
      put: fromSynchronousVariadicAwaited((blob) => {
        const hash = hashBytes(blob);
        if (!state.objects.has(hash)) {
          state.objects.set(hash, blob);
        }
        return hash;
      }),
    },
    thread: {
      async create(threadId, schemaId, initialBranchId) {
        const schema = requireSchema(state, schemaId);
        const contextManifest: unknown = createEmptyContextManifest();
        assertKernelRecord(contextManifest, "fake kernel context manifest");
        const manifestHash = await kernel.store.put(
          encodeDeterministicKernelRecord(contextManifest)
        );
        const rootTreeHash = await createTree(
          state,
          {
            "context.manifest": manifestHash,
            messages: [],
            "runtime.status": null,
            "turn.lineage": null,
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
          createdAtMs: nextClock(),
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
      get: fromSynchronousVariadicAwaited(
        (threadId) => state.threads.get(threadId) ?? null
      ),
      list: fromSynchronousVariadicAwaited((options) => {
        let threads: StoredThread[] = [...state.threads.values()].map((t) => ({
          createdAtMs: t.createdAtMs,
          rootTurnNodeHash: t.rootTurnNodeHash,
          schemaId: t.schemaId,
          threadId: t.threadId,
        }));

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
          const { lastCreatedAtMs, lastThreadId } = parseThreadCursor(
            options.cursor
          );
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
              "utf-8"
            ).toString("base64url");
          }
        }

        return { nextCursor, threads };
      }),
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
      diff: fromSynchronousVariadicAwaited((treeHashA, treeHashB) => {
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
      }),
      async incorporate(baseTurnTreeHash, stagedResults) {
        const baseTree = requireTree(state, baseTurnTreeHash);
        return await incorporateTree(
          state,
          baseTurnTreeHash,
          stagedResults,
          baseTree.schemaId
        );
      },
      manifest: fromSynchronousVariadicAwaited((treeHash) =>
        cloneManifest(requireTree(state, treeHash).manifest)
      ),
      resolve: fromSynchronousVariadicAwaited((treeHash, path) =>
        clonePathValue(requireTree(state, treeHash).manifest[path])
      ),
    },
    turn: {
      create: fromSynchronousVariadicAwaited(
        (turnId, threadId, branchId, parentTurnId, startTurnNodeHash) => {
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
        }
      ),
      get: fromSynchronousVariadicAwaited((turnId) => {
        const turn = state.turns.get(turnId);
        return turn === undefined ? null : cloneTurn(turn);
      }),
      updateHead: fromSynchronousVariadicAwaited((turnId, headTurnNodeHash) => {
        const turn = requireTurn(state, turnId);
        turn.headTurnNodeHash = headTurnNodeHash;
        state.turns.set(turnId, turn);
      }),
    },
    verdicts: {
      compose: fromSynchronousVariadicAwaited((verdicts) => {
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
      }),
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
    async completeRunAsPreempted(runId, reason, eventHash) {
      const run = requireRun(state, runId);
      run.preemptionReason = reason;
      state.runs.set(runId, run);
      return await kernel.run.complete(runId, "failed", eventHash);
    },
    kernel,
    readBranchManifest: fromSynchronousVariadicAwaited((branchId) => {
      const branch = requireBranch(state, branchId);
      const turnNode = requireTurnNode(state, branch.headTurnNodeHash);
      return cloneManifest(requireTree(state, turnNode.turnTreeHash).manifest);
    }),
    async readBranchMessages(branchId) {
      const manifest = await this.readBranchManifest(branchId);
      return readMessagesFromManifest(manifest);
    },
    readBranchRuns: fromSynchronousVariadicAwaited((branchId) =>
      [...state.runs.values()]
        .filter((run) => run.branchId === branchId)
        .map(cloneRun)
    ),
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
    readRunningStagedMessages: fromSynchronousVariadicAwaited((branchId) => {
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
    }),
    readTurnNodeManifest: fromSynchronousVariadicAwaited((turnNodeHash) => {
      const turnNode = requireTurnNode(state, turnNodeHash);
      return cloneManifest(requireTree(state, turnNode.turnTreeHash).manifest);
    }),
    async readTurnNodeMessages(turnNodeHash) {
      const manifest = await this.readTurnNodeManifest(turnNodeHash);
      return readMessagesFromManifest(manifest);
    },
  };
};

export const createFakeRunLivenessKernelHarness = (
  harness: FakeKernelHarness,
  options?: {
    onRenewLease?: (
      runId: string,
      executionOwnerId: string,
      fencingToken: string,
      nextLeaseExpiresAtMs: EpochMs
    ) => Promise<{ fencingToken: string; leaseExpiresAtMs: EpochMs }>;
  }
): FakeRunLivenessKernelHarness => {
  let preemptCalls = 0;
  let renewLeaseCalls = 0;
  let tokenOrdinal = 0;
  const leasedRuns = new Map<string, FakeLeasedRunRecord>();
  const baseKernel = harness.kernel;
  const nextTokenOrdinal = (): number => {
    tokenOrdinal += 1;
    return tokenOrdinal;
  };

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
              fencingToken: `token-${nextTokenOrdinal()}`,
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
        listExpired: fromSynchronousVariadicAwaited((nowMs) =>
          [...leasedRuns.values()].filter(
            (run) => run.leaseExpiresAtMs <= nowMs
          )
        ),
        async preemptExpired(runId, preemptingOwnerId, _nowMs, reason) {
          const leasedRun = leasedRuns.get(runId);

          if (leasedRun === undefined) {
            throw new Error(`expected leased run "${runId}"`);
          }

          preemptCalls += 1;
          const eventHash = await baseKernel.store.put(
            encodeDeterministicKernelRecord({
              preemptingOwnerId,
              reason,
              runId,
              type: "stale_running_preempted",
            })
          );
          const completion = await harness.completeRunAsPreempted(
            runId,
            reason,
            eventHash
          );
          const recoveredBranch = await baseKernel.branch.get(
            leasedRun.branchId
          );

          if (recoveredBranch === null) {
            throw new Error(`expected branch "${leasedRun.branchId}"`);
          }

          leasedRuns.delete(runId);
          const recoveredTurnNode = await baseKernel.node.get(
            completion.turnNodeHash ?? recoveredBranch.headTurnNodeHash
          );

          return {
            consumedStagedResults:
              recoveredTurnNode?.consumedStagedResults ?? [],
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
    } satisfies RuntimeKernel & RuntimeKernelRunLiveness,
    leasedRuns,
  };
};
