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

/**
 * A point in a backend transaction's commit sequence where a fault can be
 * injected: `before-commit` (durable write not yet attempted),
 * `mid-commit` (the durable write itself, wrapped so the fault fires after
 * the write completes but before the transaction is acknowledged
 * successful — simulating a crash after a partial commit), or
 * `after-commit-before-ack` (the write fully committed, fault fires before
 * the caller observes success).
 */
export type FaultPoint =
  | "before-commit"
  | "mid-commit"
  | "after-commit-before-ack";

/**
 * Describes when and how {@link createFaultInjectingBackend} should inject a
 * fault.
 */
export interface FaultPlan {
  /**
   * When set, runs a second, independent transaction that moves the named
   * branch's head to a sibling turn node immediately after the faulted
   * transaction finishes — simulating a concurrent writer racing the
   * interrupted transaction. Only runs when the fault actually fires.
   */
  concurrentWriter?: {
    branchId: string;
  };
  /**
   * Narrows which transaction the fault applies to: `branchId` requires the
   * transaction to have touched that branch (via `branches.get`/`set` or
   * `turns.set`), `operation: "checkpoint"` requires the transaction to have
   * called `turnNodes.put` (the sole action that marks a transaction as a
   * checkpoint; `turns.set`/`stagedResults.clearRun` only preserve that
   * classification if already set). Omitted fields match any transaction.
   */
  match?: {
    branchId?: string;
    operation?: "checkpoint";
  };
  /** Which commit-sequence point the fault fires at. */
  point: FaultPoint;
  /**
   * `"always"` injects the fault on every matching transaction; `"once"`
   * injects it only on the first match and lets every later matching
   * transaction proceed normally.
   */
  policy: "always" | "once";
}

/** Coarse classification of what a transaction did, for `plan.match.operation`. */
type FaultOperation = "checkpoint" | "unknown";

/**
 * Mirrors a backend's own internal fault-hook shape (see e.g. the
 * `postgres-backend.ts` / `sqlite-backend.ts` `BackendFaultHooks`), used to
 * install this module's injected-fault logic into a backend's real commit
 * sequence.
 */
interface BackendFaultHooks {
  afterCommitBeforeAck?(): Promise<void>;
  beforeCommit?(): Promise<void>;
  midCommit?(commit: () => Promise<void>): Promise<void>;
}

/** The hidden per-backend seam {@link readFaultInjectionControl} looks for. */
interface BackendFaultInjectionControl {
  setFaultHooks(hooks: BackendFaultHooks | null): void;
  supportsFaultPoint(point: FaultPoint): boolean;
}

/** What one in-flight transaction has done so far, for fault-plan matching. */
interface TransactionRecording {
  branchIds: Set<string>;
  operation: FaultOperation;
}

/** A branch's head turn node as observed before the faulted transaction ran. */
interface ConcurrentWriterSnapshot {
  branch: StoredBranch;
  head: StoredTurnNode;
}

/** Captures a `transact` call's result without re-throwing, so cleanup can run first. */
type TransactionOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { error: unknown; status: "rejected" };

/**
 * Wraps a `RuntimeBackend` so its next matching `transact` call (per
 * `plan`) fails at a chosen point in the commit sequence, for exercising a
 * backend's crash-recovery behavior. `capabilities`/`health`/`reclaim`/
 * `purgeScope`/`close`/`destroy` pass straight through to `inner`
 * unmodified; only `transact` is instrumented.
 *
 * Requires the wrapped backend to expose a hidden fault-injection control
 * surface (found by shape via `Object.getOwnPropertySymbols`, not a public
 * API) for `mid-commit` and `before-commit` points; backends that do not
 * expose it can still use `before-commit` by throwing before the real
 * commit is attempted, but `mid-commit` and `after-commit-before-ack`
 * always require the control surface.
 *
 * @throws TuvrenPersistenceError `kernel_fault_point_unsupported` when the
 *   plan's point fires but the wrapped backend has no matching control
 *   surface, or `kernel_persistence_fault_injected` for the fault itself.
 */
export function createFaultInjectingBackend(
  inner: RuntimeBackend,
  plan: FaultPlan
): RuntimeBackend {
  const control = readFaultInjectionControl(inner);
  const innerReclaim = inner.reclaim?.bind(inner);
  const innerPurgeScope = inner.purgeScope?.bind(inner);
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
    // Forward the optional maintenance operations so a wrapped backend that
    // advertises maintenance.reclamation (reclaim) or supports tenant
    // offboarding (purgeScope) stays faithful through the decorator; fault
    // injection targets transactions, not maintenance sweeps or partition drops.
    ...(innerReclaim === undefined ? {} : { reclaim: innerReclaim }),
    ...(innerPurgeScope === undefined ? {} : { purgeScope: innerPurgeScope }),
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

/** Locates a backend's hidden fault-injection control surface, if it exposes one. */
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

/** Structural check for the hidden `BackendFaultInjectionControl` shape. */
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

/**
 * Builds the backend-local commit hooks that fire the injected fault at
 * `plan.point` once `shouldInject()` reports the current transaction
 * matches, marking the plan consumed and throwing
 * {@link createInjectedFaultError}; a mismatched point on a matching
 * transaction throws {@link createUnsupportedFaultPointError} instead of
 * silently no-op-ing.
 */
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

/** Fresh, empty recording for one `transact` call. */
function createTransactionRecording(): TransactionRecording {
  return {
    branchIds: new Set<string>(),
    operation: "unknown",
  };
}

/**
 * Wraps a transaction handle so touched branch IDs and a coarse
 * `"checkpoint"` vs `"unknown"` operation classification are captured into
 * `recording` as `work` calls the repositories, for {@link matchesFaultPlan}
 * to later evaluate `plan.match` against.
 */
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

/**
 * Captures a branch's current head turn node before the faulted
 * transaction runs, as the basis {@link runConcurrentWriter} extends from.
 * Returns `undefined` if the branch or its head does not (yet) exist.
 */
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

/**
 * Runs an independent transaction that appends a sibling turn node after
 * `snapshot.head` and moves `snapshot.branch`'s head onto it — simulating a
 * second writer that raced ahead while the faulted transaction was
 * interrupted.
 */
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

/** Evaluates whether a completed transaction's recording satisfies `plan`. */
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

/** Builds the error thrown when a planned fault fires. */
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

/** Builds the error thrown when a plan targets a point the backend cannot honor. */
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

/** Reads an optional method off `value` if present and callable. */
function readOptionalMethod(
  value: object,
  key: "close" | "destroy"
): ((...args: unknown[]) => Promise<void>) | undefined {
  const method = Reflect.get(value, key);
  return typeof method === "function" ? method : undefined;
}
