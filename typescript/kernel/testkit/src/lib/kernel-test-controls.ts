import { randomUUID } from "node:crypto";

import { TuvrenPersistenceError } from "@tuvren/core";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";

import { createFaultInjectingBackend } from "./fault-injecting-backend.js";
import type { FaultPoint } from "./fault-injecting-backend.js";
import type { FaultInjectingBackendFactory } from "./kernel-mutant-types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createKernelTestClock = () => {
  const values = new Map<"backend" | "worker", number>();
  const read = (domain: "backend" | "worker"): number => {
    const value = values.get(domain);
    if (value === undefined) {
      if (values.size === 0) {
        return Date.now();
      }
      throw new Error(`setClock required for ${domain} domain`);
    }
    return value;
  };
  return {
    backendNow: () => read("backend"),
    set: (domain: unknown, nowMs: unknown): void => {
      if (
        (domain !== "backend" && domain !== "worker") ||
        typeof nowMs !== "number" ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        Object.is(nowMs, -0)
      ) {
        throw new TypeError(
          "setClock requires a clock domain and nonnegative safe integer nowMs"
        );
      }
      values.set(domain, nowMs);
    },
    workerNow: () => read("worker"),
  };
};

const supportedPoints: ReadonlySet<string> = new Set([
  "before-commit",
  "after-commit-before-ack",
]);

export const createKernelFaultControl = (
  inner: RuntimeBackend,
  factory: FaultInjectingBackendFactory = createFaultInjectingBackend
) => {
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
  return {
    arm: (
      point: unknown,
      selector: unknown,
      occurrence: unknown,
      mode: unknown
    ): { token: string } => {
      if (typeof point !== "string" || !supportedPoints.has(point)) {
        throw new TuvrenPersistenceError(
          "storage boundary unsupported by this test seam",
          { code: "kernel_fault_point_unsupported", details: { point } }
        );
      }
      if (mode !== "throw") {
        throw new TypeError("only throw fault mode is supported");
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
      const token = randomUUID();
      const boundary: FaultPoint =
        point === "before-commit" ? "before-commit" : "after-commit-before-ack";
      current = factory(inner, {
        match: {
          ...(typeof selector.branchId === "string"
            ? { branchId: selector.branchId }
            : {}),
          ...(selector.operation === "checkpoint"
            ? { operation: "checkpoint" as const }
            : {}),
        },
        occurrence,
        point: boundary,
        policy: "once",
        token,
      });
      return { token };
    },
    backend,
  };
};
