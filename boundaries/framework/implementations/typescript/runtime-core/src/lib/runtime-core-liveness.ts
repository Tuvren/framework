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

import type { EpochMs, HashString, KernelRecord } from "@tuvren/core-types";
import type {
  RuntimeKernel as KrakenKernel,
  RunCompletionStatus,
  RunRecord,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";
import {
  createRunLeaseLostError,
  hasRunLivenessKernel,
  waitForDelay,
} from "./runtime-core-response.js";
import { detachPromise } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export interface ActiveRunLease {
  abortController: AbortController;
  executionOwnerId: string;
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
  runId: string;
}

export interface RuntimeCoreLivenessOptions {
  executionOwnerId: string;
  leaseDurationMs: number;
  renewBeforeMs: number;
}

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
  getRuntimeKernel(): KrakenKernel;
  rememberActiveLease(
    handle: RuntimeExecutionHandle,
    lease: ActiveRunLease
  ): void;
  rememberActiveRunId(handle: RuntimeExecutionHandle, runId: string): void;
  runPhase(handle: RuntimeExecutionHandle): string;
  setNoActiveRunId(handle: RuntimeExecutionHandle): void;
  storeEventRecord(event: KernelRecord): Promise<HashString>;
}

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

function resolveRunLivenessKernel(
  kernel: KrakenKernel
): (KrakenKernel & RuntimeKernelRunLiveness) | undefined {
  if (!hasRunLivenessKernel(kernel)) {
    return undefined;
  }

  return kernel;
}

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

async function runLeaseLoop(
  host: RuntimeCoreLivenessHost,
  input: {
    activeLease: ActiveRunLease;
    handle: RuntimeExecutionHandle;
    kernel: KrakenKernel & RuntimeKernelRunLiveness;
    runId: string;
    signal: AbortSignal;
  }
): Promise<void> {
  const livenessOptions = host.getRunLivenessOptions();

  if (livenessOptions === undefined) {
    return;
  }

  while (!input.signal.aborted) {
    const delayMs = Math.max(
      0,
      input.activeLease.leaseExpiresAtMs -
        host.getNow() -
        livenessOptions.renewBeforeMs
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
