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

import { type EpochMs, TuvrenRuntimeError } from "@tuvren/core";
import type {
  RecoveryState,
  RuntimeBackend,
  RuntimeBackendTx,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  StoredRun,
} from "@tuvren/kernel-protocol";
import {
  assertEventHashInStore,
  assertTreeHashForRun,
  assertUniqueStepIds,
  checkpointAndClear,
  createObserveAnnotationRecords,
  encodeSignalsCborFromObserveResults,
  getLastRunTurnNodeHash,
  getLastRunTurnNodeHashFromStoredRun,
  isLeaseExpired,
  maybeCheckpoint,
  requireCurrentStep,
  requireRunningRun,
  stepRequiresCheckpoint,
  validateObserveResults,
} from "./runtime-kernel-lineage.js";
import {
  assertLeasedRunCreateInput,
  assertNoActiveRunOnBranch,
  assertNonEmptyString,
  assertRunIdAvailable,
  clearStoredRunLease,
  createRunningLeaseUpdate,
  decodeKernelRecordArray,
  decodeStoredRun,
  encodeRecord,
  isRunLeaseState,
  listStagedResults,
  putObject,
  requireBranch,
  requireLeasedRun,
  requireSchema,
  requireStoredRun,
  requireTurn,
  requireTurnNode,
} from "./runtime-kernel-storage.js";

interface RuntimeKernelRunsDependencies {
  backend: RuntimeBackend;
  createFencingToken(): string;
  now(): EpochMs;
}

/**
 * Resolves the clock the kernel uses for durable timestamp and lease-expiry
 * writes within a transaction. For a backend that advertises `shared-lease-clock`
 * (ADR-050, kernel spec §5.2) this is the backend's own per-transaction clock
 * (`tx.now`), so stamping and expiry comparison happen in backend time and stay
 * monotonic across execution owners. Every other backend keeps the kernel's
 * injected clock, preserving single-writer behavior exactly.
 */
function resolveTransactionClock(
  sharedLeaseClock: boolean,
  fallback: () => EpochMs,
  tx: RuntimeBackendTx
): () => EpochMs {
  const backendNow = tx.now;

  if (sharedLeaseClock && typeof backendNow === "function") {
    return () => backendNow.call(tx);
  }

  return fallback;
}

/**
 * Re-bases an owner-supplied absolute lease expiry into the backend clock for a
 * shared-lease-clock backend by preserving the owner's intended lease duration
 * (`suppliedExpiry - ownerNow`) and adding it to the backend clock (ADR-050).
 * When the owner clock and backend clock agree (single process, or no skew) this
 * is exactly `suppliedExpiry`, so existing behavior and conformance are
 * unchanged; under skew it translates the expiry into the authoritative clock.
 */
function rebaseLeaseExpiry(
  sharedLeaseClock: boolean,
  backendNow: () => EpochMs,
  ownerNow: () => EpochMs,
  suppliedExpiry: EpochMs
): EpochMs {
  if (!sharedLeaseClock) {
    return suppliedExpiry;
  }

  return (backendNow() + (suppliedExpiry - ownerNow())) as EpochMs;
}

export function createRuntimeKernelRunApi(
  dependencies: RuntimeKernelRunsDependencies
): RuntimeKernel["run"] {
  const { backend, now } = dependencies;
  const sharedLeaseClock =
    backend.capabilities()["shared-lease-clock"] === true;

  return {
    async beginStep(runId, stepId) {
      return await backend.transact(async (tx) => {
        const storedRun = await requireStoredRun(tx, runId);
        const run = decodeStoredRun(storedRun);

        requireRunningRun(run, runId);
        const step = requireCurrentStep(run, stepId);

        const branch = await requireBranch(tx, run.branchId);
        const schema = await requireSchema(tx, run.schemaId);

        const signals = storedRun.pendingSignalsCbor
          ? decodeKernelRecordArray(
              storedRun.pendingSignalsCbor,
              "pending signals"
            )
          : [];

        return {
          currentTurnNodeHash: branch.headTurnNodeHash,
          schema,
          signals,
          step,
        };
      });
    },

    async complete(runId, status, eventHash) {
      return await backend.transact(async (tx) => {
        const storedRun = await requireStoredRun(tx, runId);
        const run = decodeStoredRun(storedRun);

        if (run.status !== "running" && run.status !== "paused") {
          throw new TuvrenRuntimeError(
            `run "${runId}" cannot be completed (status: ${run.status})`,
            { code: "kernel_runtime_run_not_active" }
          );
        }

        if (run.status === "paused" && status !== "failed") {
          throw new TuvrenRuntimeError(
            `paused run "${runId}" can only be completed as failed`,
            { code: "kernel_runtime_invalid_paused_run_completion" }
          );
        }

        await assertEventHashInStore(tx, eventHash);

        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);
        const stagedResults = await listStagedResults(tx, runId);
        const turnNodeHash = await maybeCheckpoint(tx, run, stagedResults, {
          eventHash: eventHash ?? null,
          now: clock,
          treeHash: undefined,
        });

        const nextCreatedTurnNodes =
          turnNodeHash === undefined
            ? run.createdTurnNodes
            : [...run.createdTurnNodes, turnNodeHash];

        const { pendingSignalsCbor: _signals, ...runWithoutPendingSignals } =
          storedRun;
        await tx.runs.set({
          ...clearStoredRunLease(runWithoutPendingSignals),
          createdTurnNodesCbor: encodeRecord(nextCreatedTurnNodes),
          currentStepIndex:
            status === "completed"
              ? run.stepSequence.length
              : storedRun.currentStepIndex,
          status,
          updatedAtMs: clock(),
        });

        return turnNodeHash === undefined ? {} : { turnNodeHash };
      });
    },

    async completeStep(runId, stepId, eventHash, observeResults, treeHash) {
      return await backend.transact(async (tx) => {
        const storedRun = await requireStoredRun(tx, runId);
        const run = decodeStoredRun(storedRun);

        requireRunningRun(run, runId);
        const step = requireCurrentStep(run, stepId);

        await assertEventHashInStore(tx, eventHash);
        await assertTreeHashForRun(tx, treeHash, run.schemaId);
        validateObserveResults(observeResults);

        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);
        const nextPendingSignalsCbor =
          encodeSignalsCborFromObserveResults(observeResults);

        const stagedResults = await listStagedResults(tx, runId);
        const shouldCheckpoint = stepRequiresCheckpoint(
          step,
          stagedResults,
          treeHash
        );

        const turnNodeHash = shouldCheckpoint
          ? await checkpointAndClear(tx, run, stagedResults, {
              eventHash: eventHash ?? null,
              now: clock,
              treeHash,
            })
          : undefined;
        const annotationRecords = await createObserveAnnotationRecords({
          now: clock,
          observeResults,
          runId,
          turnNodeHash: turnNodeHash ?? null,
        });

        const nextCreatedTurnNodes =
          turnNodeHash === undefined
            ? run.createdTurnNodes
            : [...run.createdTurnNodes, turnNodeHash];

        const { pendingSignalsCbor: _signals, ...coreRun } = storedRun;
        const leaseUpdate = createRunningLeaseUpdate(
          storedRun,
          dependencies.createFencingToken
        );
        const updatedRun: StoredRun = {
          ...coreRun,
          ...leaseUpdate,
          createdTurnNodesCbor: encodeRecord(nextCreatedTurnNodes),
          currentStepIndex: Math.min(
            run.currentStepIndex + 1,
            run.stepSequence.length
          ),
          updatedAtMs: clock(),
          ...(nextPendingSignalsCbor === undefined
            ? {}
            : { pendingSignalsCbor: nextPendingSignalsCbor }),
        };

        await tx.runs.set(updatedRun);

        for (const annotationRecord of annotationRecords) {
          await tx.observeAnnotations.set(annotationRecord);
        }

        return {
          checkpointed: turnNodeHash !== undefined,
          ...(isRunLeaseState(leaseUpdate) ? { lease: leaseUpdate } : {}),
          turnNodeHash,
        };
      });
    },

    async create(runId, turnId, branchId, schemaId, startTurnNodeHash, steps) {
      return await backend.transact(async (tx) => {
        await assertRunIdAvailable(tx, runId);
        const turn = await requireTurn(tx, turnId);
        const branch = await requireBranch(tx, branchId);

        if (turn.branchId !== branchId || turn.threadId !== branch.threadId) {
          throw new TuvrenRuntimeError(
            "run turn must belong to the requested branch and thread",
            { code: "kernel_runtime_run_turn_mismatch" }
          );
        }

        if (branch.headTurnNodeHash !== startTurnNodeHash) {
          throw new TuvrenRuntimeError(
            "run start turn node must match branch head",
            { code: "kernel_runtime_run_branch_head_mismatch" }
          );
        }

        await requireSchema(tx, schemaId);
        assertUniqueStepIds(steps);
        await assertNoActiveRunOnBranch(tx, branchId);

        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);
        const record: StoredRun = {
          branchId,
          createdAtMs: clock(),
          createdTurnNodesCbor: encodeRecord([]),
          currentStepIndex: 0,
          runId,
          schemaId,
          startTurnNodeHash,
          status: "running",
          stepSequenceCbor: encodeRecord(steps),
          turnId,
          updatedAtMs: clock(),
        };
        await tx.runs.set(record);
        return decodeStoredRun(record);
      });
    },

    async recover(runId) {
      return await backend.transact(async (tx) => {
        const run = decodeStoredRun(await requireStoredRun(tx, runId));
        const lastTurnNodeHash = getLastRunTurnNodeHash(run);
        const lastTurnNode = await requireTurnNode(tx, lastTurnNodeHash);

        const recoveryState: RecoveryState = {
          consumedStagedResults: lastTurnNode.consumedStagedResults,
          lastCompletedStepId:
            run.currentStepIndex === 0
              ? null
              : (run.stepSequence[run.currentStepIndex - 1]?.id ?? null),
          lastTurnNodeHash,
          stepSequence: run.stepSequence,
          uncommittedStagedResults: await listStagedResults(tx, runId),
        };
        return recoveryState;
      });
    },
  };
}

export function createRuntimeKernelRunLivenessApi(
  dependencies: RuntimeKernelRunsDependencies
): RuntimeKernelRunLiveness["runLiveness"] {
  const { backend, createFencingToken, now } = dependencies;
  const sharedLeaseClock =
    backend.capabilities()["shared-lease-clock"] === true;

  return {
    async createLeasedRun(input) {
      return await backend.transact(async (tx) => {
        assertLeasedRunCreateInput(input);
        await assertRunIdAvailable(tx, input.runId);
        const turn = await requireTurn(tx, input.turnId);
        const branch = await requireBranch(tx, input.branchId);

        if (
          turn.branchId !== input.branchId ||
          turn.threadId !== branch.threadId
        ) {
          throw new TuvrenRuntimeError(
            "run turn must belong to the requested branch and thread",
            { code: "kernel_runtime_run_turn_mismatch" }
          );
        }

        if (branch.headTurnNodeHash !== input.startTurnNodeHash) {
          throw new TuvrenRuntimeError(
            "run start turn node must match branch head",
            { code: "kernel_runtime_run_branch_head_mismatch" }
          );
        }

        await requireSchema(tx, input.schemaId);
        assertUniqueStepIds(input.steps);
        await assertNoActiveRunOnBranch(tx, input.branchId);

        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);
        const record: StoredRun = {
          branchId: input.branchId,
          createdAtMs: clock(),
          createdTurnNodesCbor: encodeRecord([]),
          currentStepIndex: 0,
          executionOwnerId: input.executionOwnerId,
          fencingToken: createFencingToken(),
          leaseExpiresAtMs: rebaseLeaseExpiry(
            sharedLeaseClock,
            clock,
            now,
            input.leaseExpiresAtMs
          ),
          runId: input.runId,
          schemaId: input.schemaId,
          startTurnNodeHash: input.startTurnNodeHash,
          status: "running",
          stepSequenceCbor: encodeRecord(input.steps),
          turnId: input.turnId,
          updatedAtMs: clock(),
        };
        await tx.runs.set(record);
        return decodeStoredRun(record);
      });
    },

    async listExpired(nowMs) {
      return await backend.transact(async (tx) => {
        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);
        const effectiveNowMs = sharedLeaseClock ? clock() : nowMs;
        return (await tx.runs.listExpired(effectiveNowMs)).map(decodeStoredRun);
      });
    },

    async preemptExpired(runId, preemptingOwnerId, nowMs, reason) {
      return await backend.transact(async (tx) => {
        assertNonEmptyString(preemptingOwnerId, "preemptingOwnerId");
        assertNonEmptyString(reason, "reason");
        const storedRun = await requireStoredRun(tx, runId);
        const run = decodeStoredRun(storedRun);
        const lease = requireLeasedRun(storedRun, runId);

        if (run.status !== "running") {
          throw new TuvrenRuntimeError(
            `run "${runId}" cannot be preempted (status: ${run.status})`,
            { code: "kernel_runtime_run_not_running" }
          );
        }

        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);
        const effectiveNowMs = sharedLeaseClock ? clock() : nowMs;

        if (!isLeaseExpired(lease.leaseExpiresAtMs, effectiveNowMs)) {
          throw new TuvrenRuntimeError(`run "${runId}" lease has not expired`, {
            code: "kernel_runtime_run_lease_not_expired",
          });
        }

        const eventHash = await putObject(
          tx,
          encodeRecord({
            preemptingOwnerId,
            reason,
            runId,
            type: "stale_running_preempted",
          }),
          clock
        );
        const stagedResults = await listStagedResults(tx, runId);
        const turnNodeHash = await maybeCheckpoint(tx, run, stagedResults, {
          eventHash,
          now: clock,
          treeHash: undefined,
        });
        const nextCreatedTurnNodes =
          turnNodeHash === undefined
            ? run.createdTurnNodes
            : [...run.createdTurnNodes, turnNodeHash];
        const { pendingSignalsCbor: _signals, ...coreRun } = storedRun;
        await tx.runs.set({
          ...clearStoredRunLease(coreRun),
          createdTurnNodesCbor: encodeRecord(nextCreatedTurnNodes),
          preemptionReason: reason,
          status: "failed",
          updatedAtMs: clock(),
        });

        const lastTurnNodeHash =
          turnNodeHash ?? getLastRunTurnNodeHashFromStoredRun(storedRun);
        const lastTurnNode = await requireTurnNode(tx, lastTurnNodeHash);

        return {
          consumedStagedResults: lastTurnNode.consumedStagedResults,
          lastCompletedStepId:
            run.currentStepIndex === 0
              ? null
              : (run.stepSequence[run.currentStepIndex - 1]?.id ?? null),
          lastTurnNodeHash,
          stepSequence: run.stepSequence,
          uncommittedStagedResults:
            turnNodeHash === undefined ? stagedResults : [],
        } satisfies RecoveryState;
      });
    },

    async renewLease(
      runId,
      executionOwnerId,
      fencingToken,
      nextLeaseExpiresAtMs
    ) {
      return await backend.transact(async (tx) => {
        assertNonEmptyString(executionOwnerId, "executionOwnerId");
        assertNonEmptyString(fencingToken, "fencingToken");
        const storedRun = await requireStoredRun(tx, runId);
        const run = decodeStoredRun(storedRun);
        const lease = requireLeasedRun(storedRun, runId);

        if (run.status !== "running") {
          throw new TuvrenRuntimeError(
            `run "${runId}" lease cannot be renewed (status: ${run.status})`,
            { code: "kernel_runtime_run_not_running" }
          );
        }

        const clock = resolveTransactionClock(sharedLeaseClock, now, tx);

        if (isLeaseExpired(lease.leaseExpiresAtMs, clock())) {
          throw new TuvrenRuntimeError(`run "${runId}" lease has expired`, {
            code: "kernel_runtime_run_lease_expired",
          });
        }

        if (lease.executionOwnerId !== executionOwnerId) {
          throw new TuvrenRuntimeError(
            `run "${runId}" lease owner does not match`,
            { code: "kernel_runtime_run_lease_owner_mismatch" }
          );
        }

        if (lease.fencingToken !== fencingToken) {
          throw new TuvrenRuntimeError(
            `run "${runId}" lease fencing token is stale`,
            { code: "kernel_runtime_run_lease_token_mismatch" }
          );
        }

        const nextFencingToken = createFencingToken();
        const stampedLeaseExpiresAtMs = rebaseLeaseExpiry(
          sharedLeaseClock,
          clock,
          now,
          nextLeaseExpiresAtMs
        );
        await tx.runs.set({
          ...storedRun,
          fencingToken: nextFencingToken,
          leaseExpiresAtMs: stampedLeaseExpiresAtMs,
          updatedAtMs: clock(),
        });
        return {
          fencingToken: nextFencingToken,
          leaseExpiresAtMs: stampedLeaseExpiresAtMs,
        };
      });
    },
  };
}
