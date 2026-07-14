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

import type { EpochMs, HashString, KernelRecord } from "@tuvren/core";
import type {
  RunCompletionStatus,
  RunRecord,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";
import {
  createRunLeaseLostError,
  hasRunLivenessKernel,
  waitForDelay,
} from "./runtime-core-response.js";
import { detachPromise } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Mutable state of the lease this owner currently holds on a kernel run.
 *
 * `fencingToken` and `leaseExpiresAtMs` are updated in place on every
 * successful renewal and on lease data piggybacked on step results (see
 * {@link syncRunLeaseStateFromStepResult}).
 */
export interface ActiveRunLease {
  /** Aborting this controller stops the background renewal loop. */
  abortController: AbortController;
  /** Identity of the execution owner holding the lease. */
  executionOwnerId: string;
  /** Current fencing token; rotates on each renewal. */
  fencingToken: string;
  /** Backend-time lease expiry of the most recent grant or renewal. */
  leaseExpiresAtMs: EpochMs;
  /** Kernel run the lease belongs to. */
  runId: string;
}

/**
 * Configuration enabling leased (liveness-tracked) runs.
 *
 * When absent — or when the kernel lacks the run-liveness surface — runs are
 * created untracked and no renewal loop is started.
 */
export interface RuntimeCoreLivenessOptions {
  /** Stable identity of this execution owner, stamped on every lease. */
  executionOwnerId: string;
  /** Duration of each lease grant/renewal, in milliseconds. */
  leaseDurationMs: number;
  /**
   * Safety margin before the local lease window elapses at which renewal is
   * attempted; must stay above the expected renewal-commit latency plus
   * tolerated owner-clock drift (see the renewal-loop comment).
   */
  renewBeforeMs: number;
}

/**
 * Capability surface the run-liveness helpers require from the runtime core:
 * kernel access, run creation/completion, per-handle active-run and lease
 * bookkeeping, clock access, and event-record storage.
 */
export interface RuntimeCoreLivenessHost {
  clearActiveLease(handle: RuntimeExecutionHandle): void;
  completeKernelRun(
    runId: string,
    status: RunCompletionStatus,
    eventHash?: HashString
  ): Promise<{ turnNodeHash?: HashString }>;
  createKernelRun(
    runId: string,
    turnId: string,
    branchId: string,
    schemaId: string,
    startTurnNodeHash: HashString,
    steps: Array<{
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }>
  ): Promise<void>;
  getActiveLease(handle: RuntimeExecutionHandle): ActiveRunLease | undefined;
  getActiveRunId(handle: RuntimeExecutionHandle): string | undefined;
  getNow(): EpochMs;
  getRunLivenessOptions(): RuntimeCoreLivenessOptions | undefined;
  getRuntimeKernel(): RuntimeKernel;
  rememberActiveLease(
    handle: RuntimeExecutionHandle,
    lease: ActiveRunLease
  ): void;
  rememberActiveRunId(handle: RuntimeExecutionHandle, runId: string): void;
  runPhase(handle: RuntimeExecutionHandle): string;
  setNoActiveRunId(handle: RuntimeExecutionHandle): void;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
}

/**
 * Create a kernel run for this handle and remember it as the active run.
 *
 * Any previous lease renewal loop is stopped first. When the kernel exposes
 * run liveness and liveness options are configured, the run is created as a
 * leased run and a background renewal loop is started for it; otherwise a
 * plain (untracked) kernel run is created.
 *
 * @param steps - Declared run steps (id, determinism, side-effect flags)
 *   registered with the kernel run.
 */
export async function createTrackedRun(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  turnId: string,
  branchId: string,
  schemaId: string,
  startTurnNodeHash: HashString,
  steps: Array<{
    deterministic: boolean;
    id: string;
    sideEffects: boolean;
  }>
): Promise<void> {
  stopRunLeaseLoop(host, handle);
  const leasedRun = await createTrackedRunOnce(host, {
    branchId,
    runId,
    schemaId,
    startTurnNodeHash,
    steps,
    turnId,
  });
  host.rememberActiveRunId(handle, runId);

  if (leasedRun !== undefined) {
    startRunLeaseLoop(host, handle, leasedRun);
  }
}

/**
 * Complete a tracked kernel run and release its bookkeeping.
 *
 * Stops the renewal loop for this run (only if it is the leased one), stores
 * the optional completion event record first so its hash can be attached to
 * the completion, and clears the handle's active-run id when it still points
 * at this run.
 *
 * @returns The kernel completion result, including the advanced turn node
 *   hash when the run moved the turn forward.
 */
export async function completeTrackedRun(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  status: RunCompletionStatus,
  event?: KernelRecord
): Promise<{ turnNodeHash?: HashString }> {
  stopRunLeaseLoop(host, handle, runId);
  const eventHash =
    event === undefined ? undefined : await host.storeEventRecord(event);
  const completion = await host.completeKernelRun(runId, status, eventHash);

  if (host.getActiveRunId(handle) === runId) {
    host.setNoActiveRunId(handle);
  }

  return completion;
}

/**
 * Fold lease data piggybacked on a step-completion result into the handle's
 * active lease.
 *
 * A step completion may renew the lease server-side; adopting the returned
 * fencing token and expiry keeps the background renewal loop from renewing
 * with a stale token. No-op when there is no active lease, the lease belongs
 * to a different run, or the step result carries no lease.
 */
export function syncRunLeaseStateFromStepResult(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId: string,
  stepResult: { lease?: { fencingToken: string; leaseExpiresAtMs: EpochMs } }
): void {
  const activeLease = host.getActiveLease(handle);

  if (
    activeLease === undefined ||
    activeLease.runId !== runId ||
    stepResult.lease === undefined
  ) {
    return;
  }

  activeLease.fencingToken = stepResult.lease.fencingToken;
  activeLease.leaseExpiresAtMs = stepResult.lease.leaseExpiresAtMs;
}

/**
 * Narrow the kernel to its run-liveness-capable type, or `undefined` when the
 * optional `runLiveness` surface is absent.
 */
function resolveRunLivenessKernel(
  kernel: RuntimeKernel
): (RuntimeKernel & RuntimeKernelRunLiveness) | undefined {
  if (!hasRunLivenessKernel(kernel)) {
    return undefined;
  }

  return kernel;
}

/**
 * Create the kernel run, preferring a leased run when both the liveness
 * kernel surface and liveness options exist; falls back to a plain kernel
 * run and returns `undefined` (no lease) in that case.
 */
async function createTrackedRunOnce(
  host: RuntimeCoreLivenessHost,
  input: {
    branchId: string;
    runId: string;
    schemaId: string;
    startTurnNodeHash: HashString;
    steps: Array<{
      deterministic: boolean;
      id: string;
      sideEffects: boolean;
    }>;
    turnId: string;
  }
): Promise<RunRecord | undefined> {
  const kernel = host.getRuntimeKernel();
  const livenessKernel = resolveRunLivenessKernel(kernel);
  const livenessOptions = host.getRunLivenessOptions();
  const leasedRun =
    livenessKernel === undefined || livenessOptions === undefined
      ? undefined
      : await livenessKernel.runLiveness.createLeasedRun({
          branchId: input.branchId,
          executionOwnerId: livenessOptions.executionOwnerId,
          leaseExpiresAtMs: (host.getNow() +
            livenessOptions.leaseDurationMs) as EpochMs,
          runId: input.runId,
          schemaId: input.schemaId,
          startTurnNodeHash: input.startTurnNodeHash,
          steps: input.steps,
          turnId: input.turnId,
        });

  if (leasedRun === undefined) {
    await host.createKernelRun(
      input.runId,
      input.turnId,
      input.branchId,
      input.schemaId,
      input.startTurnNodeHash,
      input.steps
    );
  }

  return leasedRun;
}

/**
 * Register the run's lease as the handle's active lease and start the
 * detached background renewal loop; no-op unless liveness is configured and
 * the run record carries full lease data.
 */
function startRunLeaseLoop(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  run: RunRecord
): void {
  const livenessOptions = host.getRunLivenessOptions();
  const livenessKernel = resolveRunLivenessKernel(host.getRuntimeKernel());

  if (
    livenessOptions === undefined ||
    livenessKernel === undefined ||
    run.executionOwnerId === undefined ||
    run.fencingToken === undefined ||
    run.leaseExpiresAtMs === undefined
  ) {
    return;
  }

  stopRunLeaseLoop(host, handle);
  const abortController = new AbortController();
  const activeLease = {
    abortController,
    executionOwnerId: run.executionOwnerId,
    fencingToken: run.fencingToken,
    leaseExpiresAtMs: run.leaseExpiresAtMs,
    runId: run.runId,
  } satisfies ActiveRunLease;
  host.rememberActiveLease(handle, activeLease);
  detachPromise(
    runLeaseLoop(host, {
      activeLease,
      handle,
      kernel: livenessKernel,
      runId: run.runId,
      signal: abortController.signal,
    })
  );
}

/**
 * Stop the handle's background lease-renewal loop and clear its active
 * lease.
 *
 * @param runId - When given, only stops the loop if the active lease belongs
 *   to this run; otherwise any active lease is stopped.
 */
export function stopRunLeaseLoop(
  host: RuntimeCoreLivenessHost,
  handle: RuntimeExecutionHandle,
  runId?: string
): void {
  const activeLease = host.getActiveLease(handle);

  if (activeLease === undefined) {
    return;
  }

  if (runId !== undefined && activeLease.runId !== runId) {
    return;
  }

  activeLease.abortController.abort();
  host.clearActiveLease(handle);
}

/**
 * Background lease-renewal loop (see the ADR-050 comment inside for the
 * clock-skew reasoning).
 *
 * Each cycle waits out the local lease window (`leaseDurationMs -
 * renewBeforeMs`), exits quietly when the loop was aborted, the run is no
 * longer the handle's active run, or the run left the `running` phase, and
 * otherwise renews the lease, adopting the new fencing token and expiry. A
 * renewal failure while still live aborts the handle with a
 * `runtime_execution_lease_lost` error.
 */
async function runLeaseLoop(
  host: RuntimeCoreLivenessHost,
  input: {
    activeLease: ActiveRunLease;
    handle: RuntimeExecutionHandle;
    kernel: RuntimeKernel & RuntimeKernelRunLiveness;
    runId: string;
    signal: AbortSignal;
  }
): Promise<void> {
  const livenessOptions = host.getRunLivenessOptions();

  if (livenessOptions === undefined) {
    return;
  }

  while (!input.signal.aborted) {
    // Backend-authoritative lease clock (ADR-050): schedule renewal by the
    // elapsed local lease window (leaseDurationMs - renewBeforeMs) rather than by
    // comparing a backend-time lease expiry against this worker's wall clock.
    // The window is a clock-agnostic duration, so the owner relinquishes
    // execution authority before the backend deems the lease preemptable
    // regardless of owner/backend clock skew. For single-writer backends this is
    // equivalent to the previous wall-clock margin, because the lease was stamped
    // from this same clock.
    //
    // The renewBeforeMs margin is the safety budget that, in backend time, must
    // absorb both the renewal-commit latency (a fresh leaseDurationMs only begins
    // once renewLease commits, not when this window elapses) and any owner-clock-
    // slow drift relative to the backend clock. The default renewBeforeMs =
    // leaseDurationMs/2 keeps this comfortably positive; a deployment that tightens
    // it must keep renewBeforeMs above the expected renewal latency plus the
    // tolerated owner-clock-slow drift, or the backend-time lease could lapse
    // mid-renewal.
    const delayMs = Math.max(
      0,
      livenessOptions.leaseDurationMs - livenessOptions.renewBeforeMs
    );
    await waitForDelay(delayMs, input.signal);

    if (
      input.signal.aborted ||
      host.getActiveRunId(input.handle) !== input.runId ||
      host.runPhase(input.handle) !== "running"
    ) {
      return;
    }

    try {
      const renewed = await input.kernel.runLiveness.renewLease(
        input.runId,
        input.activeLease.executionOwnerId,
        input.activeLease.fencingToken,
        (host.getNow() + livenessOptions.leaseDurationMs) as EpochMs
      );
      input.activeLease.fencingToken = renewed.fencingToken;
      input.activeLease.leaseExpiresAtMs = renewed.leaseExpiresAtMs;
    } catch (error: unknown) {
      if (input.signal.aborted) {
        return;
      }

      input.handle.abortWithError(createRunLeaseLostError(error));
      return;
    }
  }
}
