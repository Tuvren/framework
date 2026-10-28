import type { RuntimeBackend, RuntimeBackendTx } from "@tuvren/kernel-protocol";

import { decorateBackend } from "./kernel-mutant-backend.js";
import type { KernelMutantDefinition } from "./kernel-mutant-types.js";

const clearPending = async (
  tx: RuntimeBackendTx,
  runIds: readonly string[],
  index = 0
): Promise<void> => {
  const runId = runIds[index];
  if (runId === undefined) {
    return;
  }
  await tx.stagedResults.clearRun(runId);
  await clearPending(tx, runIds, index + 1);
};

export const DURABLE_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      backend: (backend: RuntimeBackend, _context, activate) => {
        let pending: string[] = [];
        const flushPending = async (): Promise<void> => {
          if (pending.length === 0) {
            return;
          }
          const clears = pending;
          await backend.transact(async (tx) => {
            await clearPending(tx, clears);
          });
          pending = [];
        };
        const close: unknown = Reflect.get(backend, "close");
        if (typeof close === "function") {
          const closeWithFlush = async (...args: unknown[]): Promise<void> => {
            await flushPending();
            await Reflect.apply(close, backend, args);
          };
          if (!Reflect.set(backend, "close", closeWithFlush)) {
            throw new Error("cannot wrap durable mutant backend close");
          }
        }
        return decorateBackend(backend, {
          transact: async <T>(work: (tx: RuntimeBackendTx) => Promise<T>) => {
            await flushPending();
            const deferred: string[] = [];
            const value = await backend.transact(
              async (tx) =>
                await work({
                  ...tx,
                  stagedResults: {
                    ...tx.stagedResults,
                    async clearRun(runId) {
                      activate();
                      await Promise.resolve(deferred.push(runId));
                    },
                  },
                })
            );
            pending = deferred;
            return value;
          },
        });
      },
    }),
    kind: "implementation",
    mutantId: "kernel.expose-incomplete-checkpoint",
    signal: "mutant.expose-incomplete-checkpoint.entered",
  },
];
