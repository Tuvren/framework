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

import type { HashString } from "@tuvren/core";
import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type {
  ReclamationOptions,
  ReclamationSummary,
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
} from "@tuvren/kernel-protocol";

import {
  decorateBackend,
  decorateTransactions,
  listAllBranches,
  readErrorCode,
} from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantDefinition,
} from "./kernel-mutant-types.js";

type RecordedWrite = (tx: RuntimeBackendTx) => Promise<void>;

interface CheckpointRecording {
  cleared: boolean;
  nodeWritten: boolean;
  readonly writes: RecordedWrite[];
}

const recordCheckpointWrites = (
  tx: RuntimeBackendTx,
  recording: CheckpointRecording
): RuntimeBackendTx => ({
  ...tx,
  branches: {
    ...tx.branches,
    async set(record) {
      recording.writes.push(async (next) => {
        await next.branches.set(record);
      });
      await tx.branches.set(record);
    },
  },
  objects: {
    ...tx.objects,
    async put(record) {
      recording.writes.push(async (next) => {
        await next.objects.put(record);
      });
      await tx.objects.put(record);
    },
  },
  orderedPathChunks: {
    ...tx.orderedPathChunks,
    async put(record) {
      recording.writes.push(async (next) => {
        await next.orderedPathChunks.put(record);
      });
      await tx.orderedPathChunks.put(record);
    },
  },
  runs: {
    ...tx.runs,
    async set(record) {
      recording.writes.push(async (next) => {
        await next.runs.set(record);
      });
      await tx.runs.set(record);
    },
  },
  stagedResults: {
    ...tx.stagedResults,
    async clearRun(runId) {
      recording.cleared = true;
      await tx.stagedResults.clearRun(runId);
    },
  },
  turnNodes: {
    ...tx.turnNodes,
    async put(record) {
      recording.nodeWritten = true;
      recording.writes.push(async (next) => {
        await next.turnNodes.put(record);
      });
      await tx.turnNodes.put(record);
    },
  },
  turnTreePaths: {
    ...tx.turnTreePaths,
    async putMany(records) {
      recording.writes.push(async (next) => {
        await next.turnTreePaths.putMany(records);
      });
      await tx.turnTreePaths.putMany(records);
    },
  },
  turnTrees: {
    ...tx.turnTrees,
    async put(record) {
      recording.writes.push(async (next) => {
        await next.turnTrees.put(record);
      });
      await tx.turnTrees.put(record);
    },
  },
  turns: {
    ...tx.turns,
    async set(record) {
      recording.writes.push(async (next) => {
        await next.turns.set(record);
      });
      await tx.turns.set(record);
    },
  },
});

const applyWrites = async (
  tx: RuntimeBackendTx,
  writes: readonly RecordedWrite[],
  index = 0
): Promise<void> => {
  const write = writes[index];
  if (write === undefined) {
    return;
  }
  await write(tx);
  await applyWrites(tx, writes, index + 1);
};

// The checkpoint's writes escape its atomic unit: when the checkpoint fails
// to commit, its TurnNode, head move, and Run progress are still promoted
// before the next transaction reads, while the Run's staging stays uncleared.
const promoteStagedBeforeCheckpoint = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend => {
  let pending: readonly RecordedWrite[] | undefined;
  const promotePending = async (): Promise<void> => {
    const writes = pending;
    pending = undefined;
    if (writes === undefined) {
      return;
    }
    activate();
    await inner.transact(async (tx) => {
      await applyWrites(tx, writes);
    });
  };

  return decorateBackend(inner, {
    transact: async <T>(work: (tx: RuntimeBackendTx) => Promise<T>) => {
      await promotePending();
      const recording: CheckpointRecording = {
        cleared: false,
        nodeWritten: false,
        writes: [],
      };
      try {
        return await inner.transact(
          async (tx) => await work(recordCheckpointWrites(tx, recording))
        );
      } catch (error: unknown) {
        if (recording.nodeWritten && recording.cleared) {
          pending = recording.writes;
        }
        throw error;
      }
    },
  });
};

const isLateralHeadMove = (error: unknown): boolean =>
  readErrorCode(error)?.endsWith("_branch_head_lateral_move") === true;

// A head update computed from a stale read is accepted by rebasing the branch
// onto the stale writer's parent node instead of rejecting the lateral move.
const acceptStaleHeadUpdate = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend =>
  decorateTransactions(inner, (tx) => ({
    ...tx,
    branches: {
      ...tx.branches,
      async set(record: StoredBranch) {
        try {
          await tx.branches.set(record);
        } catch (error: unknown) {
          const target = isLateralHeadMove(error)
            ? await tx.turnNodes.get(record.headTurnNodeHash)
            : null;
          const base = target?.previousTurnNodeHash ?? null;
          if (base === null) {
            throw error;
          }
          await tx.branches.set({ ...record, headTurnNodeHash: base });
          await tx.branches.set(record);
          activate();
        }
      },
    },
  }));

const substrateBackends = (
  registry: WeakMap<object, Set<RuntimeBackend>>,
  substrate: object | undefined
): Set<RuntimeBackend> => {
  if (substrate === undefined) {
    return new Set();
  }
  const existing = registry.get(substrate);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Set<RuntimeBackend>();
  registry.set(substrate, created);
  return created;
};

const findInOtherScope = async <T>(
  siblings: readonly RuntimeBackend[],
  read: (tx: RuntimeBackendTx) => Promise<T | null>,
  index = 0
): Promise<T | null> => {
  const sibling = siblings[index];
  if (sibling === undefined) {
    return null;
  }
  const found = await sibling.transact(read);
  return found ?? (await findInOtherScope(siblings, read, index + 1));
};

// Hash resolution falls through to every other Scope bound to the same
// substrate when the constructing Scope misses.
const resolveObjectAcrossScopes = (
  registry: WeakMap<object, Set<RuntimeBackend>>,
  inner: RuntimeBackend,
  substrate: object | undefined,
  activate: KernelMutantActivate
): RuntimeBackend => {
  const backends = substrateBackends(registry, substrate);
  backends.add(inner);
  const resolveElsewhere = async <T>(
    read: (tx: RuntimeBackendTx) => Promise<T | null>
  ): Promise<T | null> => {
    const found = await findInOtherScope(
      [...backends].filter((backend) => backend !== inner),
      read
    );
    if (found !== null) {
      activate();
    }
    return found;
  };

  return decorateTransactions(inner, (tx) => ({
    ...tx,
    objects: {
      ...tx.objects,
      async get(hash) {
        return (
          (await tx.objects.get(hash)) ??
          (await resolveElsewhere(
            async (other) => await other.objects.get(hash)
          ))
        );
      },
      async has(hash) {
        return (
          (await tx.objects.has(hash)) ||
          (await resolveElsewhere(async (other) =>
            (await other.objects.has(hash)) ? true : null
          )) === true
        );
      },
    },
  }));
};

const collectLineage = async (
  tx: RuntimeBackendTx,
  hash: HashString | null,
  lineage = new Set<HashString>()
): Promise<Set<HashString>> => {
  if (hash === null || lineage.has(hash)) {
    return lineage;
  }
  lineage.add(hash);
  const node = await tx.turnNodes.get(hash);
  return await collectLineage(tx, node?.previousTurnNodeHash ?? null, lineage);
};

const findForkPoint = async (
  tx: RuntimeBackendTx,
  hash: HashString | null,
  live: ReadonlySet<HashString>
): Promise<HashString | null> => {
  if (hash === null || live.has(hash)) {
    return hash;
  }
  const node = await tx.turnNodes.get(hash);
  return await findForkPoint(tx, node?.previousTurnNodeHash ?? null, live);
};

const readConsumedObjectHashes = (cbor: Uint8Array): HashString[] => {
  const decoded = decodeDeterministicKernelRecord(cbor);
  return Array.isArray(decoded)
    ? decoded.flatMap((entry) => {
        const objectHash: unknown =
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
            ? Reflect.get(entry, "objectHash")
            : undefined;
        return typeof objectHash === "string" ? [objectHash] : [];
      })
    : [];
};

const archivedForkPointObjects = async (
  tx: RuntimeBackendTx,
  branches: readonly StoredBranch[],
  index = 0,
  objects: HashString[] = []
): Promise<HashString[]> => {
  const archived = branches[index];
  if (archived === undefined) {
    return objects;
  }
  const source = branches.find(
    (branch) => branch.branchId === archived.archivedFromBranchId
  );
  if (archived.archivedFromBranchId !== undefined && source !== undefined) {
    const live = await collectLineage(tx, source.headTurnNodeHash);
    const forkPoint = await findForkPoint(tx, archived.headTurnNodeHash, live);
    const node = forkPoint === null ? null : await tx.turnNodes.get(forkPoint);
    if (node !== null) {
      objects.push(...readConsumedObjectHashes(node.consumedStagedResultsCbor));
    }
  }
  return await archivedForkPointObjects(tx, branches, index + 1, objects);
};

const filterPresent = async (
  tx: RuntimeBackendTx,
  hashes: readonly HashString[],
  index = 0,
  present: HashString[] = []
): Promise<HashString[]> => {
  const hash = hashes[index];
  if (hash === undefined) {
    return present;
  }
  if (await tx.objects.has(hash)) {
    present.push(hash);
  }
  return await filterPresent(tx, hashes, index + 1, present);
};

// Exclusive-lineage release that also takes the fork point: an archived
// branch's release deletes the objects its shared ancestor consumed, even
// though the live branch head still reaches them.
const deleteObjectReachableThroughLiveRoot = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend => {
  const released = new Set<HashString>();
  const innerReclaim = inner.reclaim?.bind(inner);
  const reclaim =
    innerReclaim === undefined
      ? undefined
      : async (options?: ReclamationOptions): Promise<ReclamationSummary> => {
          const candidates = await inner.transact(
            async (tx) =>
              await archivedForkPointObjects(tx, await listAllBranches(tx))
          );
          const summary = await innerReclaim(options);
          const retained = await inner.transact(
            async (tx) => await filterPresent(tx, candidates)
          );
          for (const hash of retained) {
            released.add(hash);
            activate();
          }
          return {
            ...summary,
            releasedObjectCount: summary.releasedObjectCount + retained.length,
            retainedObjectCount: summary.retainedObjectCount - retained.length,
          };
        };

  return decorateTransactions(
    inner,
    (tx) => ({
      ...tx,
      objects: {
        ...tx.objects,
        async get(hash) {
          return released.has(hash) ? null : await tx.objects.get(hash);
        },
        async has(hash) {
          return !released.has(hash) && (await tx.objects.has(hash));
        },
      },
    }),
    reclaim === undefined ? {} : { reclaim }
  );
};

const hasRunningRun = async (
  tx: RuntimeBackendTx,
  branches: readonly StoredBranch[],
  index = 0
): Promise<boolean> => {
  const branch = branches[index];
  if (branch === undefined) {
    return false;
  }
  const runs = await tx.runs.listByBranch(branch.branchId);
  return (
    runs.some((run) => run.status === "running") ||
    (await hasRunningRun(tx, branches, index + 1))
  );
};

// The grace horizon is evaluated at a clock past every lease, so state the
// oldest active run should pin is swept.
const sweepInsideGraceWindow = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend => {
  const innerReclaim = inner.reclaim?.bind(inner);
  return decorateBackend(
    inner,
    innerReclaim === undefined
      ? {}
      : {
          reclaim: async (options?: ReclamationOptions) => {
            if (
              await inner.transact(
                async (tx) => await hasRunningRun(tx, await listAllBranches(tx))
              )
            ) {
              activate();
            }
            return await innerReclaim({
              ...options,
              nowMs: Number.MAX_SAFE_INTEGER,
            });
          },
        }
  );
};

const EMPTY_RECLAMATION: ReclamationSummary = {
  releasedArchivedBranchCount: 0,
  releasedObjectCount: 0,
  releasedOrderedPathChunkCount: 0,
  releasedRunCount: 0,
  releasedTurnCount: 0,
  releasedTurnNodeCount: 0,
  releasedTurnTreeCount: 0,
  retainedObjectCount: 0,
};

const neverSweepEligibleObjects = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend =>
  decorateBackend(
    inner,
    inner.reclaim === undefined
      ? {}
      : {
          reclaim: async () => {
            activate();
            return await Promise.resolve({ ...EMPTY_RECLAMATION });
          },
        }
  );

export const STORAGE_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        acceptStaleHeadUpdate(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.accept-stale-head-update",
    signal: "mutant.accept-stale-head-update.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        deleteObjectReachableThroughLiveRoot(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.delete-object-reachable-through-live-root",
    signal: "mutant.delete-object-reachable-through-live-root.entered",
  },
  {
    createSeams: () => ({
      faultInjection: (_factory, activate) => (inner) => {
        activate();
        return inner;
      },
    }),
    kind: "instrumentation",
    mutantId: "kernel.fault-seam-never-fires",
    signal: "mutant.fault-seam-never-fires.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        neverSweepEligibleObjects(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.never-sweep-eligible-objects",
    signal: "mutant.never-sweep-eligible-objects.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        promoteStagedBeforeCheckpoint(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.promote-staged-before-checkpoint",
    signal: "mutant.promote-staged-before-checkpoint.entered",
  },
  {
    createSeams: () => {
      const registry = new WeakMap<object, Set<RuntimeBackend>>();
      return {
        backend: (backend, context, activate) =>
          resolveObjectAcrossScopes(
            registry,
            backend,
            context.substrate,
            activate
          ),
      };
    },
    kind: "implementation",
    mutantId: "kernel.resolve-object-across-scopes",
    signal: "mutant.resolve-object-across-scopes.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        sweepInsideGraceWindow(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.sweep-inside-grace-window",
    signal: "mutant.sweep-inside-grace-window.entered",
  },
];
