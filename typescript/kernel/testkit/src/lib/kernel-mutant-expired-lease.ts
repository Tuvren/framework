import type { KernelMutantDefinition } from "./kernel-mutant-types.js";

export const EXPIRED_LEASE_KERNEL_MUTANT: KernelMutantDefinition = {
  createSeams: () => ({
    kernel: (kernel, backend, activate) => ({
      ...kernel,
      runLiveness: {
        ...kernel.runLiveness,
        async preemptExpired(runId, owner, nowMs, reason) {
          if (owner.trim().length === 0 || reason.trim().length === 0) {
            return await kernel.runLiveness.preemptExpired(
              runId,
              owner,
              nowMs,
              reason
            );
          }
          const expired =
            backend.capabilities()["shared-lease-clock"] === true &&
            (await backend.transact(async (tx) => {
              const run = await tx.runs.get(runId);
              const serverNow = tx.now?.();
              return (
                run !== null &&
                run.status === "running" &&
                run.executionOwnerId !== undefined &&
                run.fencingToken !== undefined &&
                run.leaseExpiresAtMs !== undefined &&
                serverNow !== undefined &&
                run.leaseExpiresAtMs <= serverNow
              );
            }));
          if (!expired) {
            return await kernel.runLiveness.preemptExpired(
              runId,
              owner,
              nowMs,
              reason
            );
          }
          const recovery = await kernel.run.recover(runId);
          activate();
          return recovery;
        },
      },
    }),
  }),
  kind: "implementation",
  mutantId: "kernel.ignore-expired-lease-preemption",
  signal: "mutant.ignore-expired-lease-preemption.entered",
};
