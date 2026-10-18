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

import { TuvrenRuntimeError } from "@tuvren/core";
import type { EpochMs } from "@tuvren/core";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type {
  RecoveryState,
  RunRecord,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";

import type { FakeKernelHarness } from "./fake-kernel.ts";
import { fromSynchronousVariadicAwaited } from "./runtime-core-test-helpers.ts";

interface FakeLeasedRunRecord extends RunRecord {
  executionOwnerId: string;
  fencingToken: string;
  leaseExpiresAtMs: EpochMs;
}

export interface FakeRunLivenessKernelHarness {
  getPreemptCalls: () => number;
  getRenewLeaseCalls: () => number;
  kernel: RuntimeKernel & RuntimeKernelRunLiveness;
  leasedRuns: Map<string, FakeLeasedRunRecord>;
}

export const createFakeRunLivenessKernelHarness = (
  harness: FakeKernelHarness,
  options?: {
    onRenewLease?: (
      runId: string,
      executionOwnerId: string,
      fencingToken: string,
      nextLeaseExpiresAtMs: EpochMs
    ) => Promise<{ fencingToken: string; leaseExpiresAtMs: EpochMs }>;
  }
): FakeRunLivenessKernelHarness => {
  let preemptCalls = 0;
  let renewLeaseCalls = 0;
  let tokenOrdinal = 0;
  const leasedRuns = new Map<string, FakeLeasedRunRecord>();
  const baseKernel = harness.kernel;
  const nextTokenOrdinal = (): number => {
    tokenOrdinal += 1;
    return tokenOrdinal;
  };

  return {
    getPreemptCalls() {
      return preemptCalls;
    },
    getRenewLeaseCalls() {
      return renewLeaseCalls;
    },
    kernel: {
      ...baseKernel,
      run: {
        ...baseKernel.run,
        async complete(runId, status, eventHash) {
          const completion = await baseKernel.run.complete(
            runId,
            status,
            eventHash
          );
          leasedRuns.delete(runId);
          return completion;
        },
      },
      runLiveness: {
        async createLeasedRun(input) {
          try {
            const run = await baseKernel.run.create(
              input.runId,
              input.turnId,
              input.branchId,
              input.schemaId,
              input.startTurnNodeHash,
              input.steps
            );
            const leasedRun: FakeLeasedRunRecord = {
              ...run,
              executionOwnerId: input.executionOwnerId,
              fencingToken: `token-${nextTokenOrdinal()}`,
              leaseExpiresAtMs: input.leaseExpiresAtMs,
            };
            leasedRuns.set(leasedRun.runId, leasedRun);
            return { ...leasedRun };
          } catch (error: unknown) {
            // The fake kernel only signals active-branch contention by message,
            // so the wrapper normalizes it into the real kernel error code that
            // runtime-core branches on for stale-run recovery.
            if (
              error instanceof Error &&
              error.message.includes("already has an active run")
            ) {
              throw new TuvrenRuntimeError(error.message, {
                code: "kernel_runtime_branch_already_active",
              });
            }

            throw error;
          }
        },
        listExpired: fromSynchronousVariadicAwaited((nowMs) =>
          [...leasedRuns.values()].filter(
            (run) => run.leaseExpiresAtMs <= nowMs
          )
        ),
        async preemptExpired(runId, preemptingOwnerId, _nowMs, reason) {
          const leasedRun = leasedRuns.get(runId);

          if (leasedRun === undefined) {
            throw new Error(`expected leased run "${runId}"`);
          }

          preemptCalls += 1;
          const eventHash = await baseKernel.store.put(
            encodeDeterministicKernelRecord({
              preemptingOwnerId,
              reason,
              runId,
              type: "stale_running_preempted",
            })
          );
          const completion = await harness.completeRunAsPreempted(
            runId,
            reason,
            eventHash
          );
          const recoveredBranch = await baseKernel.branch.get(
            leasedRun.branchId
          );

          if (recoveredBranch === null) {
            throw new Error(`expected branch "${leasedRun.branchId}"`);
          }

          leasedRuns.delete(runId);
          const recoveredTurnNode = await baseKernel.node.get(
            completion.turnNodeHash ?? recoveredBranch.headTurnNodeHash
          );

          return {
            consumedStagedResults:
              recoveredTurnNode?.consumedStagedResults ?? [],
            lastCompletedStepId: null,
            lastTurnNodeHash:
              completion.turnNodeHash ?? recoveredBranch.headTurnNodeHash,
            stepSequence: leasedRun.stepSequence,
            uncommittedStagedResults: [],
          } satisfies RecoveryState;
        },
        async renewLease(
          runId,
          executionOwnerId,
          fencingToken,
          nextLeaseExpiresAtMs
        ) {
          renewLeaseCalls += 1;

          if (options?.onRenewLease !== undefined) {
            return await options.onRenewLease(
              runId,
              executionOwnerId,
              fencingToken,
              nextLeaseExpiresAtMs
            );
          }

          const leasedRun = leasedRuns.get(runId);

          if (leasedRun === undefined) {
            throw new TuvrenRuntimeError(`run "${runId}" is not leased`, {
              code: "kernel_runtime_run_not_leased",
            });
          }

          leasedRun.fencingToken = `token-renewed-${renewLeaseCalls}`;
          leasedRun.leaseExpiresAtMs = nextLeaseExpiresAtMs;
          leasedRuns.set(runId, leasedRun);

          return {
            fencingToken: `token-renewed-${renewLeaseCalls}`,
            leaseExpiresAtMs: nextLeaseExpiresAtMs,
          };
        },
      },
    } satisfies RuntimeKernel & RuntimeKernelRunLiveness,
    leasedRuns,
  };
};
