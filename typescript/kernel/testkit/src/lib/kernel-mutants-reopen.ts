import type { KernelRecord } from "@tuvren/core";
import type { RuntimeBackendTx, StoredTurnNode } from "@tuvren/kernel-protocol";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashTurnNodeIdentity,
} from "@tuvren/kernel-protocol";

import { decorateBackend } from "./kernel-mutant-backend.js";
import type { KernelMutantDefinition } from "./kernel-mutant-types.js";

type ReloadDefect =
  | "committed-state"
  | "checkpoint-lineage"
  | "recovery-head"
  | "completed-step";

const LOST_HASH = "0".repeat(64);

const loseManifestReferences = (bytes: Uint8Array): Uint8Array | undefined => {
  const manifest = decodeDeterministicKernelRecord(bytes);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return undefined;
  }
  let changed = false;
  const lost: Record<string, KernelRecord> = {};
  for (const [path, value] of Object.entries(manifest)) {
    if (Array.isArray(value)) {
      changed ||= value.some((hash) => hash !== LOST_HASH);
      lost[path] = value.map(() => LOST_HASH);
    } else {
      changed ||= value !== null && value !== LOST_HASH;
      lost[path] = value === null ? null : LOST_HASH;
    }
  }
  return changed ? encodeDeterministicKernelRecord(lost) : undefined;
};

const siblingCheckpoint = async (
  node: StoredTurnNode
): Promise<StoredTurnNode> => ({
  ...node,
  consumedStagedResultsCbor: encodeDeterministicKernelRecord([]),
  hash: await hashTurnNodeIdentity({
    consumedStagedResults: [],
    eventHash: node.eventHash,
    previousTurnNodeHash: node.previousTurnNodeHash,
    schemaId: node.schemaId,
    turnTreeHash: node.turnTreeHash,
  }),
});

const reloadMutant = (defect: ReloadDefect): KernelMutantDefinition => ({
  createSeams: () => ({
    backend: (inner, _context, activate) => {
      const localWrites = new Set<string>();
      return decorateBackend(inner, {
        transact: async <T>(
          work: (tx: RuntimeBackendTx) => Promise<T>
        ): Promise<T> => {
          const writes = new Set<string>();
          const local = (key: string): boolean =>
            localWrites.has(key) || writes.has(key);
          const result = await inner.transact(
            async (tx) =>
              await work({
                ...tx,
                runs: {
                  ...tx.runs,
                  async get(runId) {
                    const run = await tx.runs.get(runId);
                    if (run === null || local(`run:${runId}`)) {
                      return run;
                    }
                    if (
                      defect === "completed-step" &&
                      run.currentStepIndex > 0
                    ) {
                      activate();
                      return { ...run, currentStepIndex: 0 };
                    }
                    if (defect === "recovery-head") {
                      const nodes = decodeDeterministicKernelRecord(
                        run.createdTurnNodesCbor
                      );
                      const hash = Array.isArray(nodes)
                        ? nodes.at(-1)
                        : undefined;
                      if (typeof hash === "string") {
                        const node = await tx.turnNodes.get(hash);
                        if (node !== null) {
                          const sibling = await siblingCheckpoint(node);
                          if (
                            sibling.hash !== hash &&
                            (await tx.turnNodes.get(sibling.hash)) !== null &&
                            Array.isArray(nodes)
                          ) {
                            activate();
                            return {
                              ...run,
                              createdTurnNodesCbor:
                                encodeDeterministicKernelRecord([
                                  ...nodes.slice(0, -1),
                                  sibling.hash,
                                ]),
                            };
                          }
                        }
                      }
                    }
                    return run;
                  },
                  async set(record) {
                    await tx.runs.set(record);
                    writes.add(`run:${record.runId}`);
                  },
                },
                turnNodes: {
                  ...tx.turnNodes,
                  async get(hash) {
                    const node = await tx.turnNodes.get(hash);
                    if (
                      defect === "checkpoint-lineage" &&
                      node !== null &&
                      node.previousTurnNodeHash === null &&
                      node.hash !== LOST_HASH &&
                      !local(`node:${hash}`)
                    ) {
                      activate();
                      return { ...node, hash: LOST_HASH };
                    }
                    return node;
                  },
                  async put(record) {
                    await tx.turnNodes.put(record);
                    if (
                      defect === "recovery-head" &&
                      record.previousTurnNodeHash !== null
                    ) {
                      const sibling = await siblingCheckpoint(record);
                      if (sibling.hash !== record.hash) {
                        await tx.turnNodes.put(sibling);
                      }
                    }
                    writes.add(`node:${record.hash}`);
                  },
                },
                turnTrees: {
                  ...tx.turnTrees,
                  async get(hash) {
                    const tree = await tx.turnTrees.get(hash);
                    if (
                      defect === "committed-state" &&
                      tree !== null &&
                      !local(`tree:${hash}`)
                    ) {
                      const manifestCbor = loseManifestReferences(
                        tree.manifestCbor
                      );
                      if (manifestCbor !== undefined) {
                        activate();
                        return { ...tree, manifestCbor };
                      }
                    }
                    return tree;
                  },
                  async put(record) {
                    await tx.turnTrees.put(record);
                    writes.add(`tree:${record.hash}`);
                  },
                },
              })
          );
          for (const key of writes) {
            localWrites.add(key);
          }
          return result;
        },
      });
    },
  }),
  kind: "implementation",
  mutantId: `kernel.reload-loses-${defect}`,
  signal: `mutant.reload-loses-${defect}.entered`,
});

export const REOPEN_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  reloadMutant("committed-state"),
  reloadMutant("checkpoint-lineage"),
  reloadMutant("recovery-head"),
  reloadMutant("completed-step"),
];
