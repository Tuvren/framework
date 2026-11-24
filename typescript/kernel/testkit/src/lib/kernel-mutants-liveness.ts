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

import { AsyncLocalStorage } from "node:async_hooks";

import { createBackendInvariantRecordUtils } from "@tuvren/backend-shared";
import type { HashString } from "@tuvren/core";
import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type {
  ReclamationOptions,
  ReclamationSummary,
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
  StoredRun,
  StoredThread,
} from "@tuvren/kernel-protocol";

import {
  decorateTransactions,
  listAllBranches,
} from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantDefinition,
  KernelMutantKernel,
  KernelMutantSeams,
} from "./kernel-mutant-types.js";

const runRecordUtils = createBackendInvariantRecordUtils({
  errorPrefix: "testkit",
});

// Enumeration reports a member the Scope never created: every non-empty
// listing gains a phantom Thread cloned from its first real member.
const appendPhantomThreadMember = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  thread: {
    ...kernel.thread,
    async list(options) {
      const page = await kernel.thread.list(options);
      const [first] = page.threads;
      if (first === undefined) {
        return page;
      }
      activate();
      return {
        ...page,
        threads: [
          ...page.threads,
          { ...first, threadId: `${first.threadId}.foreign` },
        ],
      };
    },
  },
});

// Own-scope reads are corrupted on the way out: store.get returns the real
// content with an extra byte appended, the way a read-back path that
// rewrites the durable blob would.
const corruptOwnScopeStoreRead = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  store: {
    ...kernel.store,
    async get(hash) {
      const bytes = await kernel.store.get(hash);
      if (bytes === null) {
        return null;
      }
      activate();
      const corrupted = new Uint8Array(bytes.length + 1);
      corrupted.set(bytes);
      return corrupted;
    },
  },
});

const isLeasedRunningRun = (run: StoredRun): boolean =>
  run.status === "running" &&
  run.executionOwnerId !== undefined &&
  run.fencingToken !== undefined &&
  run.leaseExpiresAtMs !== undefined;

const collectScopeRuns = async (
  tx: RuntimeBackendTx,
  branches: readonly StoredBranch[],
  index = 0,
  runs = new Map<string, StoredRun>()
): Promise<StoredRun[]> => {
  const branch = branches[index];
  if (branch === undefined) {
    return [...runs.values()];
  }
  for (const record of await tx.runs.listByBranch(branch.branchId)) {
    runs.set(record.runId, record);
  }
  return await collectScopeRuns(tx, branches, index + 1, runs);
};

const listScopeRuns = async (tx: RuntimeBackendTx): Promise<StoredRun[]> =>
  await collectScopeRuns(tx, await listAllBranches(tx));

// The expiry membership predicate is inverted: the listing returns leased
// running runs whose lease has NOT expired and omits the expired members.
const invertExpiredRunMembership = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend =>
  decorateTransactions(inner, (tx) => ({
    ...tx,
    runs: {
      ...tx.runs,
      async listExpired(nowMs) {
        const expired = await tx.runs.listExpired(nowMs);
        const scopeRuns = await listScopeRuns(tx);
        const live = scopeRuns
          .filter(
            (record) =>
              isLeasedRunningRun(record) &&
              (record.leaseExpiresAtMs ?? 0) > nowMs
          )
          .toSorted((left, right) =>
            runRecordUtils.compareStoredRun(left, right)
          );
        const liveIds = new Set(live.map((record) => record.runId));
        if (
          expired.length !== live.length ||
          expired.some((record) => !liveIds.has(record.runId))
        ) {
          activate();
        }
        return live;
      },
    },
  }));

// Expiry listing treats paused runs as leased-and-expired members: every
// paused run joins the result with synthesized lease fields borrowed from a
// real expired member (or the caller's horizon when none exists).
const listPausedRunAsExpired = (
  inner: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend =>
  decorateTransactions(inner, (tx) => ({
    ...tx,
    runs: {
      ...tx.runs,
      async listExpired(nowMs) {
        const expired = await tx.runs.listExpired(nowMs);
        const scopeRuns = await listScopeRuns(tx);
        const paused = scopeRuns.filter((record) => record.status === "paused");
        if (paused.length === 0) {
          return expired;
        }
        activate();
        const [donor] = expired;
        const asExpired = paused.map((record) => ({
          ...record,
          executionOwnerId:
            record.executionOwnerId ??
            donor?.executionOwnerId ??
            "mutant-owner",
          fencingToken:
            record.fencingToken ?? donor?.fencingToken ?? "mutant-fence",
          leaseExpiresAtMs:
            record.leaseExpiresAtMs ?? donor?.leaseExpiresAtMs ?? nowMs,
        }));
        return [...expired, ...asExpired].toSorted((left, right) =>
          runRecordUtils.compareStoredRun(left, right)
        );
      },
    },
  }));

const substrateThreadRegistry = (
  registries: WeakMap<object, Map<string, StoredThread>>,
  substrate: object | undefined
): Map<string, StoredThread> => {
  if (substrate === undefined) {
    return new Map();
  }
  const existing = registries.get(substrate);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, StoredThread>();
  registries.set(substrate, created);
  return created;
};

// Thread enumeration ignores the Scope discriminator over the substrate:
// every thread recorded by any Scope sharing it joins the caller's listing,
// the way a scope-resolution layer that resolves records substrate-wide
// would leak them. Threads already in the caller's page are skipped.
const leakSiblingScopeThreads = (
  registries: WeakMap<object, Map<string, StoredThread>>,
  inner: RuntimeBackend,
  substrate: object | undefined,
  activate: KernelMutantActivate
): RuntimeBackend => {
  const recorded = substrateThreadRegistry(registries, substrate);

  return decorateTransactions(inner, (tx) => ({
    ...tx,
    threads: {
      ...tx.threads,
      async put(record) {
        recorded.set(record.threadId, record);
        await tx.threads.put(record);
      },
      ...(tx.threads.list === undefined
        ? {}
        : {
            async list(options) {
              const page = (await tx.threads.list?.(options)) ?? {
                threads: [] as StoredThread[],
              };
              const own = new Set(
                page.threads.map((thread) => thread.threadId)
              );
              const foreign = [...recorded.values()].filter(
                (thread) => !own.has(thread.threadId)
              );
              if (foreign.length === 0) {
                return page;
              }
              activate();
              return { ...page, threads: [...page.threads, ...foreign] };
            },
          }),
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

const collectConsumedObjectHashes = async (
  tx: RuntimeBackendTx,
  lineage: readonly HashString[],
  objects: Set<HashString>,
  index = 0
): Promise<void> => {
  const hash = lineage[index];
  if (hash === undefined) {
    return;
  }
  const node = await tx.turnNodes.get(hash);
  if (node !== null) {
    for (const objectHash of readConsumedObjectHashes(
      node.consumedStagedResultsCbor
    )) {
      objects.add(objectHash);
    }
  }
  await collectConsumedObjectHashes(tx, lineage, objects, index + 1);
};

const visitLiveBranches = async (
  tx: RuntimeBackendTx,
  branches: readonly StoredBranch[],
  objects: Set<HashString>,
  index = 0
): Promise<void> => {
  const branch = branches[index];
  if (branch === undefined) {
    return;
  }
  if (branch.archivedFromBranchId === undefined) {
    const lineage = await collectLineage(tx, branch.headTurnNodeHash);
    await collectConsumedObjectHashes(tx, [...lineage], objects);
  }
  await visitLiveBranches(tx, branches, objects, index + 1);
};

const liveLineageConsumedObjects = async (
  tx: RuntimeBackendTx,
  branches: readonly StoredBranch[],
  objects = new Set<HashString>()
): Promise<HashString[]> => {
  await visitLiveBranches(tx, branches, objects);
  return [...objects];
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

// Reclamation releases objects consumed by a non-archived branch head's
// lineage — ciphertext a live root still reaches is swept with the
// unreachable remainder, and later store reads observe it missing.
const releaseObjectConsumedByLiveLineage = (
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
              await liveLineageConsumedObjects(tx, await listAllBranches(tx))
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

// The staged result reports a timestamp shifted off the transaction clock
// the descriptor selects — one tick past the backend clock on
// shared-lease-clock backends, one tick past the worker clock elsewhere.
const shiftStagedResultTimestamp = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  staging: {
    ...kernel.staging,
    async stage(runId, blob, taskId, objectType, status, interruptPayload) {
      const result = await kernel.staging.stage(
        runId,
        blob,
        taskId,
        objectType,
        status,
        interruptPayload
      );
      activate();
      return {
        ...result,
        stagedResult: {
          ...result.stagedResult,
          timestamp: result.stagedResult.timestamp + 1,
        },
      };
    },
  },
});

interface PreemptStagingContext {
  hiding: boolean;
}

// Stale preemption checkpoints without consuming the run's staged work: the
// transaction listing runs empty while preemptExpired holds the flag, so the
// checkpoint anchors no staged results and the recovery state reports none.
const stalePreemptionEmptyCheckpointSeams = (): KernelMutantSeams => {
  const preemptStaging = new AsyncLocalStorage<PreemptStagingContext>();
  return {
    backend: (backend, _context, activate) =>
      decorateTransactions(backend, (tx) => ({
        ...tx,
        stagedResults: {
          ...tx.stagedResults,
          async listByRun(runId) {
            const stored = await tx.stagedResults.listByRun(runId);
            if (preemptStaging.getStore()?.hiding !== true) {
              return stored;
            }
            if (stored.length > 0) {
              activate();
            }
            return [];
          },
        },
      })),
    kernel: (kernel) => ({
      ...kernel,
      runLiveness: {
        ...kernel.runLiveness,
        async preemptExpired(runId, preemptingOwnerId, nowMs, reason) {
          return await preemptStaging.run(
            { hiding: true },
            async () =>
              await kernel.runLiveness.preemptExpired(
                runId,
                preemptingOwnerId,
                nowMs,
                reason
              )
          );
        },
      },
    }),
  };
};

export const LIVENESS_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        appendPhantomThreadMember(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.append-phantom-thread-member",
    signal: "mutant.append-phantom-thread-member.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        corruptOwnScopeStoreRead(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.corrupt-own-scope-store-read",
    signal: "mutant.corrupt-own-scope-store-read.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        invertExpiredRunMembership(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.invert-expired-run-membership",
    signal: "mutant.invert-expired-run-membership.entered",
  },
  {
    createSeams: () => {
      const registries = new WeakMap<object, Map<string, StoredThread>>();
      return {
        backend: (backend, context, activate) =>
          leakSiblingScopeThreads(
            registries,
            backend,
            context.substrate,
            activate
          ),
      };
    },
    kind: "implementation",
    mutantId: "kernel.leak-sibling-scope-threads",
    signal: "mutant.leak-sibling-scope-threads.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        listPausedRunAsExpired(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.list-paused-run-as-expired",
    signal: "mutant.list-paused-run-as-expired.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        releaseObjectConsumedByLiveLineage(backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.release-object-consumed-by-live-lineage",
    signal: "mutant.release-object-consumed-by-live-lineage.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        shiftStagedResultTimestamp(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.shift-staged-result-timestamp",
    signal: "mutant.shift-staged-result-timestamp.entered",
  },
  {
    createSeams: stalePreemptionEmptyCheckpointSeams,
    kind: "implementation",
    mutantId: "kernel.stale-preemption-empty-checkpoint",
    signal: "mutant.stale-preemption-empty-checkpoint.entered",
  },
];
