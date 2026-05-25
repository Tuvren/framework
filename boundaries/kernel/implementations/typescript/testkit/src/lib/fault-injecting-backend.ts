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

import { type TuvrenError, TuvrenPersistenceError } from "@tuvren/core";
import type {
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
  StoredTurn,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";
import {
  createStoredObjectRecord,
  createStoredTurnNodeRecord,
} from "./kernel-test-fixtures.js";

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
    operation?: "checkpoint";
  };
  point: FaultPoint;
  policy: "always" | "once";
}

type FaultOperation = "checkpoint" | "unknown";

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

interface ConcurrentWriterSnapshot {
  branch: StoredBranch;
  head: StoredTurnNode;
}

type TransactionOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { error: unknown; status: "rejected" };

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
      const concurrentWriterSnapshot =
        plan.concurrentWriter === undefined
          ? undefined
          : await readConcurrentWriterSnapshot(
              inner,
              plan.concurrentWriter.branchId
            );
      const recording = createTransactionRecording();
      let shouldRunConcurrentWriter = false;
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

      let outcome: TransactionOutcome<T>;

      try {
        outcome = {
          status: "fulfilled",
          value: await inner.transact(async (tx) => {
            const result = await work(
              createRecordingTransactionProxy(tx, recording)
            );
            shouldInject = matchesFaultPlan(plan, recording, consumed);
            shouldRunConcurrentWriter =
              shouldInject && concurrentWriterSnapshot !== undefined;

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
          }),
        };
      } catch (error: unknown) {
        outcome = {
          error,
          status: "rejected",
        };
      } finally {
        control?.setFaultHooks(null);
      }

      let concurrentWriterError: unknown;

      if (shouldRunConcurrentWriter && concurrentWriterSnapshot !== undefined) {
        try {
          await runConcurrentWriter(inner, concurrentWriterSnapshot);
        } catch (error: unknown) {
          concurrentWriterError = error;
        }
      }

      if (outcome.status === "rejected") {
        throw outcome.error;
      }

      if (concurrentWriterError !== undefined) {
        throw concurrentWriterError;
      }

      return outcome.value;
    },
  };

  const closeMethod = readOptionalMethod(inner, "close");
  const destroyMethod = readOptionalMethod(inner, "destroy");

  if (closeMethod !== undefined) {
    decorated.close = closeMethod.bind(inner);
  }

  if (destroyMethod !== undefined) {
    decorated.destroy = destroyMethod.bind(inner);
  }

  return decorated;
}

function readFaultInjectionControl(
  backend: RuntimeBackend
): BackendFaultInjectionControl | undefined {
  // Discover the backend-local seam by shape so production code does not get a
  // stable global symbol lookup key for the hidden test hook.
  for (const symbol of Object.getOwnPropertySymbols(backend)) {
    const value = Reflect.get(backend, symbol);

    if (isBackendFaultInjectionControl(value)) {
      return value;
    }
  }

  return undefined;
}

function isBackendFaultInjectionControl(
  value: unknown
): value is BackendFaultInjectionControl {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "setFaultHooks") === "function" &&
    typeof Reflect.get(value, "supportsFaultPoint") === "function"
  );
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
      get(branchId) {
        recording.branchIds.add(branchId);
        return tx.branches.get(branchId);
      },
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

async function readConcurrentWriterSnapshot(
  backend: RuntimeBackend,
  branchId: string
): Promise<ConcurrentWriterSnapshot | undefined> {
  return await backend.transact(async (tx) => {
    const branch = await tx.branches.get(branchId);

    if (branch === null) {
      return undefined;
    }

    const head = await tx.turnNodes.get(branch.headTurnNodeHash);

    if (head === null) {
      return undefined;
    }

    return { branch, head };
  });
}

async function runConcurrentWriter(
  backend: RuntimeBackend,
  snapshot: ConcurrentWriterSnapshot
): Promise<void> {
  const createdAtMs = Math.max(snapshot.head.createdAtMs + 1, Date.now());
  const siblingEvent = await createStoredObjectRecord(
    new Uint8Array([0x63, 0x77]),
    createdAtMs
  );
  const siblingNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs,
    eventHash: siblingEvent.hash,
    previousTurnNodeHash: snapshot.head.hash,
    schemaId: snapshot.head.schemaId,
    turnTreeHash: snapshot.head.turnTreeHash,
  });

  await backend.transact(async (tx) => {
    await tx.objects.put(siblingEvent);
    await tx.turnNodes.put(siblingNode);
    await tx.branches.set({
      ...snapshot.branch,
      headTurnNodeHash: siblingNode.hash,
      updatedAtMs: Math.max(snapshot.branch.updatedAtMs + 1, Date.now()),
    });
  });
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
  _operation: FaultOperation,
  point: FaultPoint
): TuvrenError {
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

function readOptionalMethod(
  value: object,
  key: "close" | "destroy"
): ((...args: unknown[]) => Promise<void>) | undefined {
  const method = Reflect.get(value, key);
  return typeof method === "function" ? method : undefined;
}
