import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { TuvrenPersistenceError } from "@tuvren/core";
import type { RuntimeBackend, RuntimeBackendTx } from "@tuvren/kernel-protocol";

import type { FaultPoint } from "./fault-injecting-backend.js";
import type { FaultInjectingBackendFactory } from "./kernel-mutant-types.js";

interface FaultSelector {
  branchId?: string;
  operation?: "checkpoint";
}

interface ArmedFault {
  count: number;
  mode: "block" | "throw";
  occurrence: number;
  point: FaultPoint;
  selector: FaultSelector;
  token: string;
}

const supported: ReadonlySet<string> = new Set([
  "before-commit",
  "after-turn-node-write-before-head",
  "after-head-move-before-staging-clear",
  "after-commit-before-ack",
]);

const isSupportedPoint = (point: unknown): point is FaultPoint =>
  typeof point === "string" && supported.has(point);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createDurableFaultControl = (
  inner: RuntimeBackend,
  reached: (receipt: { token: string; phase: FaultPoint }) => Promise<void>,
  wrapFactory?: (
    factory: FaultInjectingBackendFactory
  ) => FaultInjectingBackendFactory
) => {
  const checkpointContext = new AsyncLocalStorage<boolean>();
  let armed: ArmedFault | undefined;

  const activate = async (
    point: FaultPoint,
    branchId: string | undefined
  ): Promise<void> => {
    const plan = armed;
    if (
      plan === undefined ||
      plan.point !== point ||
      (plan.selector.branchId !== undefined &&
        plan.selector.branchId !== branchId)
    ) {
      return;
    }
    plan.count += 1;
    if (plan.count !== plan.occurrence) {
      return;
    }
    armed = undefined;
    if (plan.mode === "throw") {
      throw new TuvrenPersistenceError(
        `injected ${point} persistence fault interrupted verification`,
        {
          code: "kernel_persistence_fault_injected",
          details: { point, token: plan.token },
        }
      );
    }
    await reached({ phase: point, token: plan.token });
    await Promise.withResolvers<undefined>().promise;
  };

  const instrumented: RuntimeBackend = {
    capabilities: () => inner.capabilities(),
    health: async () => await inner.health(),
    ...(inner.reclaim === undefined
      ? {}
      : { reclaim: inner.reclaim.bind(inner) }),
    ...(inner.purgeScope === undefined
      ? {}
      : { purgeScope: inner.purgeScope.bind(inner) }),
    transact: async <T>(
      work: (tx: RuntimeBackendTx) => Promise<T>
    ): Promise<T> => {
      if (
        armed === undefined ||
        (armed.selector.operation === "checkpoint" &&
          checkpointContext.getStore() !== true)
      ) {
        return await inner.transact(work);
      }
      let runBranch: string | undefined;
      let checkpointBranch: string | undefined;
      const branches = new Set<string>();
      const value = await inner.transact(async (tx) => {
        const recording: RuntimeBackendTx = {
          ...tx,
          branches: {
            ...tx.branches,
            async get(branchId) {
              const branch = await tx.branches.get(branchId);
              branches.add(branchId);
              if (branch !== null && branchId === runBranch) {
                checkpointBranch = branchId;
                if (checkpointContext.getStore() === true) {
                  await activate("before-commit", branchId);
                }
              }
              return branch;
            },
            async set(branch) {
              branches.add(branch.branchId);
              await tx.branches.set(branch);
              if (checkpointBranch === branch.branchId) {
                await activate(
                  "after-head-move-before-staging-clear",
                  branch.branchId
                );
              }
            },
          },
          runs: {
            ...tx.runs,
            async get(runId) {
              const run = await tx.runs.get(runId);
              if (run !== null) {
                runBranch = run.branchId;
              }
              return run;
            },
          },
          turnNodes: {
            ...tx.turnNodes,
            async put(node) {
              await tx.turnNodes.put(node);
              if (checkpointBranch !== undefined) {
                await activate(
                  "after-turn-node-write-before-head",
                  checkpointBranch
                );
              }
            },
          },
          turns: {
            ...tx.turns,
            async set(turn) {
              branches.add(turn.branchId);
              await tx.turns.set(turn);
            },
          },
        };
        const result = await work(recording);
        if (armed?.selector.operation === undefined) {
          const branch = armed?.selector.branchId;
          if (branch === undefined || branches.has(branch)) {
            await activate("before-commit", branch);
          }
        }
        return result;
      });
      if (armed?.selector.operation === undefined) {
        const branch = armed?.selector.branchId;
        if (branch === undefined || branches.has(branch)) {
          await activate("after-commit-before-ack", branch);
        }
      } else if (checkpointBranch !== undefined) {
        await activate("after-commit-before-ack", checkpointBranch);
      }
      return value;
    },
  };
  let current = inner;
  const backend: RuntimeBackend = {
    capabilities: () => inner.capabilities(),
    health: async () => await inner.health(),
    ...(inner.reclaim === undefined
      ? {}
      : { reclaim: inner.reclaim.bind(inner) }),
    ...(inner.purgeScope === undefined
      ? {}
      : { purgeScope: inner.purgeScope.bind(inner) }),
    transact: async (work) => await current.transact(work),
  };
  const factory: FaultInjectingBackendFactory = () => instrumented;

  return {
    arm(
      point: unknown,
      selector: unknown,
      occurrence: unknown,
      mode: unknown
    ): { token: string } {
      if (!isSupportedPoint(point)) {
        throw new TuvrenPersistenceError(
          "storage boundary unsupported by this test seam",
          {
            code: "kernel_fault_point_unsupported",
            details: { point },
          }
        );
      }
      if (mode !== "throw" && mode !== "block") {
        throw new TypeError("invalid fault mode");
      }
      if (
        typeof occurrence !== "number" ||
        !Number.isSafeInteger(occurrence) ||
        occurrence < 1
      ) {
        throw new TypeError("fault occurrence must be a positive safe integer");
      }
      if (
        !isRecord(selector) ||
        Object.keys(selector).some(
          (key) => key !== "branchId" && key !== "operation"
        ) ||
        (selector.branchId !== undefined &&
          typeof selector.branchId !== "string") ||
        (selector.operation !== undefined &&
          selector.operation !== "checkpoint")
      ) {
        throw new TypeError("invalid fault selector");
      }
      const token = `fault-${randomUUID()}`;
      armed = {
        count: 0,
        mode,
        occurrence,
        point,
        selector: {
          ...(typeof selector.branchId === "string"
            ? { branchId: selector.branchId }
            : {}),
          ...(selector.operation === "checkpoint"
            ? { operation: "checkpoint" as const }
            : {}),
        },
        token,
      };
      current = (wrapFactory?.(factory) ?? factory)(inner, {
        match: armed.selector,
        occurrence,
        point,
        policy: "once",
        token,
      });
      return { token };
    },
    backend,
    runCheckpoint: async <T>(work: () => Promise<T>): Promise<T> =>
      await checkpointContext.run(true, work),
  };
};
