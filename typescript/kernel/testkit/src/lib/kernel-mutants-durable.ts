import type { RuntimeBackend } from "@tuvren/kernel-protocol";

import { decorateTransactions } from "./kernel-mutant-backend.js";
import type { KernelMutantDefinition } from "./kernel-mutant-types.js";

export const DURABLE_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      backend: (backend: RuntimeBackend, _context, activate) => {
        let checkpoints = 0;
        return decorateTransactions(backend, (tx) => ({
          ...tx,
          stagedResults: {
            ...tx.stagedResults,
            async clearRun(runId) {
              checkpoints += 1;
              if (checkpoints > 1) {
                activate();
                return;
              }
              await tx.stagedResults.clearRun(runId);
            },
          },
        }));
      },
    }),
    kind: "implementation",
    mutantId: "kernel.expose-incomplete-checkpoint",
    signal: "mutant.expose-incomplete-checkpoint.entered",
  },
];
