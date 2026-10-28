import { AsyncLocalStorage } from "node:async_hooks";

import { decorateTransactions } from "./kernel-mutant-backend.js";
import type { KernelMutantDefinition } from "./kernel-mutant-types.js";

interface ExpiryClockContext {
  nowMs: number;
  used: boolean;
}

export const CLOCK_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => {
      const clock = new AsyncLocalStorage<ExpiryClockContext>();
      return {
        backend: (backend, _context, activate) =>
          decorateTransactions(backend, (tx) => {
            const context = clock.getStore();
            if (context === undefined || tx.now === undefined) {
              return tx;
            }
            const backendNow = tx.now.bind(tx);
            return {
              ...tx,
              now: () => {
                if (context.used) {
                  return backendNow();
                }
                context.used = true;
                activate();
                return context.nowMs;
              },
            };
          }),
        kernel: (kernel) => ({
          ...kernel,
          runLiveness: {
            ...kernel.runLiveness,
            preemptExpired: async (runId, owner, nowMs, reason) =>
              await clock.run(
                { nowMs, used: false },
                async () =>
                  await kernel.runLiveness.preemptExpired(
                    runId,
                    owner,
                    nowMs,
                    reason
                  )
              ),
          },
        }),
      };
    },
    kind: "implementation",
    mutantId: "kernel.worker-clock-expiry",
    signal: "mutant.worker-clock-expiry.entered",
  },
];
