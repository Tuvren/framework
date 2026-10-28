import type { RuntimeBackend, RuntimeBackendTx } from "@tuvren/kernel-protocol";

interface CommitFaultCallbacks {
  afterCommit: () => Promise<void>;
  beforeCommit: () => Promise<void>;
}

export const transactWithCommitFaults = async <T>(
  backend: RuntimeBackend,
  work: (tx: RuntimeBackendTx) => Promise<T>,
  callbacks: CommitFaultCallbacks
): Promise<T> => {
  const result = await backend.transact(async (tx) => {
    const value = await work(tx);
    await callbacks.beforeCommit();
    return value;
  });
  await callbacks.afterCommit();
  return result;
};
