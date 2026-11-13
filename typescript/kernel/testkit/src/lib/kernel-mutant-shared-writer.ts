import type { HashString } from "@tuvren/core";
import type { RuntimeBackendTx, StoredBranch } from "@tuvren/kernel-protocol";

import { decorateBackend, readErrorCode } from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantDefinition,
} from "./kernel-mutant-types.js";

const acceptStaleSibling = (
  tx: RuntimeBackendTx,
  activate: KernelMutantActivate
): RuntimeBackendTx => ({
  ...tx,
  branches: {
    ...tx.branches,
    async set(record: StoredBranch) {
      try {
        await tx.branches.set(record);
      } catch (error: unknown) {
        if (
          readErrorCode(error)?.endsWith("_branch_head_lateral_move") !== true
        ) {
          throw error;
        }
        const branch = await tx.branches.get(record.branchId);
        const target = await tx.turnNodes.get(record.headTurnNodeHash);
        const current =
          branch === null
            ? null
            : await tx.turnNodes.get(branch.headTurnNodeHash);
        const parent = target?.previousTurnNodeHash ?? null;
        if (
          parent === null ||
          current?.previousTurnNodeHash !== parent ||
          branch?.threadId !== record.threadId
        ) {
          throw error;
        }
        await tx.branches.set({ ...record, headTurnNodeHash: parent });
        await tx.branches.set(record);
        activate();
      }
    },
  },
});

export const SHARED_WRITER_KERNEL_MUTANT: KernelMutantDefinition = {
  createSeams: () => {
    const committedHeads = new WeakMap<
      RuntimeBackendTx,
      ReadonlyMap<string, HashString>
    >();
    return {
      backend: (inner, _context, activate) => {
        const localHeads = new Map<string, HashString>();
        return decorateBackend(inner, {
          transact: async <T>(work: (tx: RuntimeBackendTx) => Promise<T>) => {
            const writes = new Map<string, HashString>();
            const result = await inner.transact(async (tx) => {
              const stale = acceptStaleSibling(tx, activate);
              const wrapped: RuntimeBackendTx = {
                ...stale,
                branches: {
                  ...stale.branches,
                  async set(record) {
                    await stale.branches.set(record);
                    writes.set(record.branchId, record.headTurnNodeHash);
                  },
                },
              };
              committedHeads.set(wrapped, localHeads);
              return await work(wrapped);
            });
            for (const [branchId, hash] of writes) {
              localHeads.set(branchId, hash);
            }
            return result;
          },
        });
      },
      kernel: (kernel, backend, activate) => ({
        ...kernel,
        branch: {
          ...kernel.branch,
          async setHead(branchId, turnNodeHash) {
            try {
              return await kernel.branch.setHead(branchId, turnNodeHash);
            } catch (error: unknown) {
              if (
                readErrorCode(error) !== "kernel_runtime_lateral_head_movement"
              ) {
                throw error;
              }
              return await backend.transact(async (tx) => {
                const branch = await tx.branches.get(branchId);
                const target = await tx.turnNodes.get(turnNodeHash);
                const localHeads = committedHeads.get(tx);
                if (
                  branch === null ||
                  target === null ||
                  localHeads === undefined ||
                  localHeads.get(branchId) === branch.headTurnNodeHash
                ) {
                  throw error;
                }
                activate("guard-bypass");
                await tx.branches.set({
                  ...branch,
                  headTurnNodeHash: turnNodeHash,
                  updatedAtMs: tx.now?.() ?? branch.updatedAtMs,
                });
                return {
                  branch: {
                    branchId: branch.branchId,
                    headTurnNodeHash: turnNodeHash,
                    threadId: branch.threadId,
                  },
                };
              });
            }
          },
        },
      }),
    };
  },
  kind: "implementation",
  mutantId: "kernel.accept-stale-shared-writer",
  signal: "mutant.accept-stale-shared-writer.entered",
};
