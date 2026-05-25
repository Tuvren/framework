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

import {
  type TuvrenError,
  TuvrenPersistenceError,
  TuvrenRecoveryError,
} from "@tuvren/core";
import type {
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
  StoredTurn,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";

export type FaultPoint =
  | "before-commit"
  | "mid-commit"
  | "after-commit-before-ack";

export interface FaultPlan {
  concurrentWriter?: {
    branchId: string;
  };
  match?: {
    branchId?: string;
    operation?: "checkpoint" | "recovery";
  };
  point: FaultPoint;
  policy: "always" | "once";
}

type FaultOperation = "checkpoint" | "recovery" | "unknown";

interface BackendFaultHooks {
  afterCommitBeforeAck?(): Promise<void>;
  beforeCommit?(): Promise<void>;
  midCommit?(commit: () => Promise<void>): Promise<void>;
}

interface BackendFaultInjectionControl {
  setFaultHooks(hooks: BackendFaultHooks | null): void;
  supportsFaultPoint(point: FaultPoint): boolean;
}

interface TransactionRecording {
  branchIds: Set<string>;
  operation: FaultOperation;
}

const FAULT_INJECTION_CONTROL = Symbol.for(
  "tuvren.kernel.testkit.fault-injection-control"
);

export function createFaultInjectingBackend(
  inner: RuntimeBackend,
  plan: FaultPlan
): RuntimeBackend {
  const control = readFaultInjectionControl(inner);
  let consumed = false;

  const decorated: RuntimeBackend & {
    close?: () => Promise<void>;
    destroy?: (options?: { dropSchema?: boolean }) => Promise<void>;
  } = {
    capabilities() {
      return inner.capabilities();
    },
    health() {
      return inner.health();
    },
    async transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T> {
      const recording = createTransactionRecording();
      let shouldInject = false;

      const hooks =
        control === undefined
          ? null
          : createFaultHooks(
              control,
              plan,
              () => recording.operation,
              () => shouldInject,
              () => {
                consumed = true;
              }
            );

      if (hooks !== null && control !== undefined) {
        control.setFaultHooks(hooks);
      }

      try {
        return await inner.transact(async (tx) => {
          const result = await work(
            createRecordingTransactionProxy(tx, recording)
          );
          shouldInject = matchesFaultPlan(plan, recording, consumed);

          if (
            shouldInject &&
            control === undefined &&
            plan.point === "before-commit"
          ) {
            consumed = true;
            throw createInjectedFaultError(recording.operation, plan.point);
          }

          if (shouldInject && control === undefined) {
            throw createUnsupportedFaultPointError(plan.point);
          }

          return result;
        });
      } finally {
        control?.setFaultHooks(null);
      }
    },
  };

  const closable = inner as {
    close?: () => Promise<void>;
    destroy?: (options?: { dropSchema?: boolean }) => Promise<void>;
  };

  if (typeof closable.close === "function") {
    decorated.close = closable.close.bind(inner);
  }

  if (typeof closable.destroy === "function") {
    decorated.destroy = closable.destroy.bind(inner);
  }

  return decorated;
}

function readFaultInjectionControl(
  backend: RuntimeBackend
): BackendFaultInjectionControl | undefined {
  const value = Reflect.get(
    backend as object,
    FAULT_INJECTION_CONTROL
  ) as unknown;

  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "setFaultHooks") !== "function" ||
    typeof Reflect.get(value, "supportsFaultPoint") !== "function"
  ) {
    return undefined;
  }

  return value as BackendFaultInjectionControl;
}

function createFaultHooks(
  control: BackendFaultInjectionControl,
  plan: FaultPlan,
  getOperation: () => FaultOperation,
  shouldInject: () => boolean,
  markConsumed: () => void
): BackendFaultHooks {
  return {
    afterCommitBeforeAck: () => {
      if (!shouldInject()) {
        return Promise.resolve();
      }

      if (plan.point !== "after-commit-before-ack") {
        return Promise.resolve();
      }

      markConsumed();
      throw createInjectedFaultError(getOperation(), plan.point);
    },
    beforeCommit: () => {
      if (!shouldInject()) {
        return Promise.resolve();
      }

      if (!control.supportsFaultPoint(plan.point)) {
        throw createUnsupportedFaultPointError(plan.point);
      }

      if (plan.point !== "before-commit") {
        return Promise.resolve();
      }

      markConsumed();
      throw createInjectedFaultError(getOperation(), plan.point);
    },
    midCommit: async (commit) => {
      if (!shouldInject()) {
        await commit();
        return;
      }

      if (plan.point !== "mid-commit") {
        await commit();
        return;
      }

      if (!control.supportsFaultPoint(plan.point)) {
        throw createUnsupportedFaultPointError(plan.point);
      }

      markConsumed();
      await commit();
      throw createInjectedFaultError(getOperation(), plan.point);
    },
  };
}

function createTransactionRecording(): TransactionRecording {
  return {
    branchIds: new Set<string>(),
    operation: "unknown",
  };
}

function createRecordingTransactionProxy(
  tx: RuntimeBackendTx,
  recording: TransactionRecording
): RuntimeBackendTx {
  return {
    ...tx,
    branches: {
      ...tx.branches,
      set(record: StoredBranch) {
        recording.branchIds.add(record.branchId);
        return tx.branches.set(record);
      },
    },
    stagedResults: {
      ...tx.stagedResults,
      clearRun(runId) {
        recording.operation =
          recording.operation === "checkpoint" ? "checkpoint" : "unknown";
        return tx.stagedResults.clearRun(runId);
      },
    },
    turnNodes: {
      ...tx.turnNodes,
      put(record: StoredTurnNode) {
        recording.operation = "checkpoint";
        return tx.turnNodes.put(record);
      },
    },
    turns: {
      ...tx.turns,
      set(record: StoredTurn) {
        recording.branchIds.add(record.branchId);
        recording.operation =
          recording.operation === "checkpoint" ? "checkpoint" : "unknown";
        return tx.turns.set(record);
      },
    },
  };
}

function matchesFaultPlan(
  plan: FaultPlan,
  recording: TransactionRecording,
  consumed: boolean
): boolean {
  if (plan.policy === "once" && consumed) {
    return false;
  }

  if (
    plan.match?.branchId !== undefined &&
    !recording.branchIds.has(plan.match.branchId)
  ) {
    return false;
  }

  if (
    plan.match?.operation !== undefined &&
    recording.operation !== plan.match.operation
  ) {
    return false;
  }

  return true;
}

function createInjectedFaultError(
  operation: FaultOperation,
  point: FaultPoint
): TuvrenError {
  if (operation === "recovery") {
    return new TuvrenRecoveryError(
      `injected ${point} recovery fault interrupted verification`,
      {
        code: "kernel_recovery_fault_injected",
        details: { point },
      }
    );
  }

  return new TuvrenPersistenceError(
    `injected ${point} persistence fault interrupted verification`,
    {
      code: "kernel_persistence_fault_injected",
      details: { point },
    }
  );
}

function createUnsupportedFaultPointError(
  point: FaultPoint
): TuvrenPersistenceError {
  return new TuvrenPersistenceError(
    `fault point "${point}" requires backend-local test hooks`,
    {
      code: "kernel_fault_point_unsupported",
      details: { point },
    }
  );
}
