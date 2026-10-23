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

import { createProjection } from "./host-scenario-support.js";
import type { KernelAdapterConfig } from "./host-scenario-support.js";
import {
  createConformanceRuntimeKernel,
  loadCanonicalSchema,
  readErrorCode,
  withConfiguredBackend,
} from "./host-support.js";

export const createRunLivenessScenarios = (config: KernelAdapterConfig) => {
  const runLeaseRenewal = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();
    return await withConfiguredBackend(
      config,
      async (backend) => {
        const kernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => 10,
        });
        await kernel.schema.register(schema);
        const thread = await kernel.thread.create(
          "thread_liveness_renewal",
          schema.schemaId,
          "branch_liveness_renewal"
        );
        const turn = await kernel.turn.create(
          "turn_liveness_renewal",
          thread.threadId,
          thread.branchId,
          null,
          thread.rootTurnNodeHash
        );
        const leasedRun = await kernel.runLiveness.createLeasedRun({
          branchId: thread.branchId,
          executionOwnerId: "owner-primary",
          leaseExpiresAtMs: 20,
          runId: "run_liveness_renewal",
          schemaId: schema.schemaId,
          startTurnNodeHash: thread.rootTurnNodeHash,
          steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
          turnId: turn.turnId,
        });
        const staleToken = leasedRun.fencingToken ?? "";
        const renewed = await kernel.runLiveness.renewLease(
          leasedRun.runId,
          "owner-primary",
          staleToken,
          40
        );

        let ownerMismatchCode = "unexpected_success";
        try {
          await kernel.runLiveness.renewLease(
            leasedRun.runId,
            "owner-secondary",
            renewed.fencingToken,
            50
          );
        } catch (error: unknown) {
          ownerMismatchCode = readErrorCode(error);
        }

        let staleTokenCode = "unexpected_success";
        try {
          await kernel.runLiveness.renewLease(
            leasedRun.runId,
            "owner-primary",
            staleToken,
            50
          );
        } catch (error: unknown) {
          staleTokenCode = readErrorCode(error);
        }

        return createProjection({
          renewal: {
            ownerMismatchCode,
            renewedLeaseExpiresAtMs: renewed.leaseExpiresAtMs,
            staleTokenCode,
          },
        });
      },
      // Align the backend's authoritative lease clock with the kernel clock so the
      // backend-time re-base (ADR-0050) is a no-op for shared-lease-clock backends
      // and the deterministic expected lease values hold across all backends.
      { now: () => 10 }
    );
  };

  const runExpiredListing = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();
    return await withConfiguredBackend(
      config,
      async (backend) => {
        const kernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => 10,
        });
        await kernel.schema.register(schema);
        const expiredThread = await kernel.thread.create(
          "thread_liveness_listing_expired",
          schema.schemaId,
          "branch_liveness_listing_expired"
        );
        const freshThread = await kernel.thread.create(
          "thread_liveness_listing_fresh",
          schema.schemaId,
          "branch_liveness_listing_fresh"
        );
        const pausedThread = await kernel.thread.create(
          "thread_liveness_listing_paused",
          schema.schemaId,
          "branch_liveness_listing_paused"
        );
        const expiredTurn = await kernel.turn.create(
          "turn_liveness_listing_expired",
          expiredThread.threadId,
          expiredThread.branchId,
          null,
          expiredThread.rootTurnNodeHash
        );
        const freshTurn = await kernel.turn.create(
          "turn_liveness_listing_fresh",
          freshThread.threadId,
          freshThread.branchId,
          null,
          freshThread.rootTurnNodeHash
        );
        const pausedTurn = await kernel.turn.create(
          "turn_liveness_listing_paused",
          pausedThread.threadId,
          pausedThread.branchId,
          null,
          pausedThread.rootTurnNodeHash
        );
        await kernel.runLiveness.createLeasedRun({
          branchId: expiredThread.branchId,
          executionOwnerId: "owner-primary",
          leaseExpiresAtMs: 5,
          runId: "run_expired",
          schemaId: schema.schemaId,
          startTurnNodeHash: expiredThread.rootTurnNodeHash,
          steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
          turnId: expiredTurn.turnId,
        });
        const freshRun = await kernel.runLiveness.createLeasedRun({
          branchId: freshThread.branchId,
          executionOwnerId: "owner-primary",
          leaseExpiresAtMs: 50,
          runId: "run_fresh",
          schemaId: schema.schemaId,
          startTurnNodeHash: freshThread.rootTurnNodeHash,
          steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
          turnId: freshTurn.turnId,
        });
        const pausedRun = await kernel.runLiveness.createLeasedRun({
          branchId: pausedThread.branchId,
          executionOwnerId: "owner-primary",
          // This lease is already stale before the pause so the evidence proves that
          // paused status, not remaining lease time, keeps it out of expired listings.
          leaseExpiresAtMs: 5,
          runId: "run_paused",
          schemaId: schema.schemaId,
          startTurnNodeHash: pausedThread.rootTurnNodeHash,
          steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
          turnId: pausedTurn.turnId,
        });
        await kernel.run.complete(freshRun.runId, "failed");
        await kernel.run.complete(pausedRun.runId, "paused");
        const expiredRuns = await kernel.runLiveness.listExpired(10);
        const pausedStoredRun = await backend.transact(
          async (tx) => await tx.runs.get(pausedRun.runId)
        );

        if (pausedStoredRun === null) {
          throw new Error("expected paused stored run");
        }

        return createProjection({
          listing: {
            expiredRunIds: expiredRuns.map((run) => run.runId),
            pausedRunListed: expiredRuns.some(
              (run) => run.runId === pausedRun.runId
            ),
            pausedRunStatus: pausedStoredRun.status,
          },
        });
      },
      // Align the backend's authoritative lease clock with the kernel clock so the
      // backend-time re-base (ADR-0050) is a no-op for shared-lease-clock backends
      // and the deterministic expected lease values hold across all backends.
      { now: () => 10 }
    );
  };

  const runStalePreemption = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();
    return await withConfiguredBackend(
      config,
      async (backend) => {
        const storageKernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => 10,
        });
        await storageKernel.schema.register(schema);
        const thread = await storageKernel.thread.create(
          "thread_liveness_preemption",
          schema.schemaId,
          "branch_liveness_preemption"
        );
        const turn = await storageKernel.turn.create(
          "turn_liveness_preemption",
          thread.threadId,
          thread.branchId,
          null,
          thread.rootTurnNodeHash
        );
        const leasedRun = await storageKernel.runLiveness.createLeasedRun({
          branchId: thread.branchId,
          executionOwnerId: "owner-primary",
          leaseExpiresAtMs: 5,
          runId: "run_liveness_preemption",
          schemaId: schema.schemaId,
          startTurnNodeHash: thread.rootTurnNodeHash,
          steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
          turnId: turn.turnId,
        });
        await storageKernel.run.beginStep(leasedRun.runId, "iterate");
        await storageKernel.staging.stage(
          leasedRun.runId,
          new TextEncoder().encode("assistant"),
          "assistant_message",
          "message",
          "completed"
        );
        const recovery = await storageKernel.runLiveness.preemptExpired(
          leasedRun.runId,
          "owner-secondary",
          10,
          "stale_running_recovery"
        );

        const storedRun = await backend.transact(
          async (tx) => await tx.runs.get(leasedRun.runId)
        );

        if (storedRun === null) {
          throw new Error("expected preempted stored run");
        }
        const updatedBranch = await storageKernel.branch.get(thread.branchId);

        if (updatedBranch === null) {
          throw new Error("expected preempted branch");
        }

        return createProjection({
          preemption: {
            branchHeadTurnNodeHash: updatedBranch.headTurnNodeHash,
            leaseCleared:
              storedRun.executionOwnerId === undefined &&
              storedRun.fencingToken === undefined &&
              storedRun.leaseExpiresAtMs === undefined,
            preemptionReason: storedRun.preemptionReason ?? null,
            preservedStagedResultTaskIds: recovery.consumedStagedResults.map(
              (stagedResult) => stagedResult.taskId
            ),
            recoveryHeadMatchesBranchHead:
              recovery.lastTurnNodeHash === updatedBranch.headTurnNodeHash,
            recoveryLastTurnNodeHash: recovery.lastTurnNodeHash,
            runStatus: storedRun.status,
            uncommittedStagedResults: recovery.uncommittedStagedResults.length,
          },
        });
      },
      // Align the backend's authoritative lease clock with the kernel clock so the
      // backend-time re-base (ADR-0050) is a no-op for shared-lease-clock backends
      // and the deterministic expected lease values hold across all backends.
      { now: () => 10 }
    );
  };

  /**
   * Preemption under worker clock skew against a backend-authoritative lease clock
   * (KRT-BG005; ADR-0050 composed with ADR-0052 side-effect-once).
   *
   * Two execution owners share one backend. owner-secondary's wall clock runs
   * ahead of the backend's own clock, the scenario the SaaS-readiness lease model
   * must survive: a GC-paused or clock-skewed peer must not be able to preempt a
   * lease the *backend* still considers live, because backend-authoritative
   * clocking judges expiry by the backend's clock within the lease transaction,
   * not by either worker's wall clock.
   *
   * Phase 1 proves no split brain: although owner-secondary's local clock is well
   * past the lease expiry, the backend clock is the authority, so listExpired
   * (judged by tx.now()) does not surface the still-live lease and the peer cannot
   * preempt it. Phase 2 advances the backend's own clock past expiry and proves
   * that genuine preemption then recovers the run, that the completed,
   * durably-staged side-effecting tool call survives by its callId/taskId so a
   * resuming owner skips it (the external side effect is therefore driven at most
   * once, §4.9), and that recovery's reported head agrees with the durable branch
   * head read back independently. Preemption does incorporate the staged result in
   * one transaction (the head advances exactly once); at-most-once is enforced by
   * the failed run status and the cleared lease, which are asserted separately. The
   * dead owner's lease is cleared.
   */
  const runClockSkewPreemption = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();
    // Backend-authoritative clock (ADR-0050), mutable so the probe can advance the
    // backend's own clock between phases without relying on wall-clock sleeps.
    let backendClockMs = 1000;
    const backendNow = () => backendClockMs;
    // owner-secondary's wall clock is skewed 300ms ahead of the backend, so by its
    // own reading the lease (expiry 1100 in backend time) is already expired in
    // phase 1 — yet the backend clock (1000) says it is not.
    const secondaryNowMs = 1300;
    const leaseExpiresAtMs = 1100;

    return await withConfiguredBackend(
      config,
      async (backend) => {
        // owner-primary's wall clock is aligned with the backend at grant time, so
        // the ADR-0050 re-base is a no-op and the stored expiry is 1100 in backend
        // time (supplied 1100 - primary now 1000 = 100ms duration; 1000 + 100).
        const primaryKernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => 1000,
        });
        await primaryKernel.schema.register(schema);
        const thread = await primaryKernel.thread.create(
          "thread_clock_skew",
          schema.schemaId,
          "branch_clock_skew"
        );
        const turn = await primaryKernel.turn.create(
          "turn_clock_skew",
          thread.threadId,
          thread.branchId,
          null,
          thread.rootTurnNodeHash
        );
        const leasedRun = await primaryKernel.runLiveness.createLeasedRun({
          branchId: thread.branchId,
          executionOwnerId: "owner-primary",
          leaseExpiresAtMs,
          runId: "run_clock_skew",
          schemaId: schema.schemaId,
          startTurnNodeHash: thread.rootTurnNodeHash,
          steps: [
            { deterministic: false, id: "side_effect_call", sideEffects: true },
          ],
          turnId: turn.turnId,
        });
        await primaryKernel.run.beginStep(leasedRun.runId, "side_effect_call");
        // A completed, durably-staged side-effecting tool result committed as a
        // tool message and keyed by its callId (the staging taskId §4.9 keys on).
        // On recovery this completed call is incorporated into committed history,
        // so a resuming owner skips it by callId rather than re-driving it — the
        // external side effect happens at most once.
        await primaryKernel.staging.stage(
          leasedRun.runId,
          new TextEncoder().encode("side-effect-result"),
          "call_side_effect",
          "message",
          "completed"
        );

        const secondaryKernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => secondaryNowMs,
        });

        // Phase 1 — no split brain. The backend clock (1000) is still below the
        // lease expiry (1100), so the lease is not preemptable even though the
        // secondary's local clock (1300) is past it.
        const expiredBeforeBackendExpiry =
          await secondaryKernel.runLiveness.listExpired(secondaryNowMs);
        const splitBrainPreemptionBlocked = !expiredBeforeBackendExpiry.some(
          (run) => run.runId === leasedRun.runId
        );

        // Phase 2 — genuine expiry by the backend's own clock.
        backendClockMs = 1200;
        const expiredAfterBackendExpiry =
          await secondaryKernel.runLiveness.listExpired(secondaryNowMs);
        const preemptedAfterBackendExpiry = expiredAfterBackendExpiry.some(
          (run) => run.runId === leasedRun.runId
        );
        const recovery = await secondaryKernel.runLiveness.preemptExpired(
          leasedRun.runId,
          "owner-secondary",
          secondaryNowMs,
          "stale_running_recovery"
        );

        const storedRun = await backend.transact(
          async (tx) => await tx.runs.get(leasedRun.runId)
        );
        if (storedRun === null) {
          throw new Error("expected preempted stored run");
        }
        const updatedBranch = await primaryKernel.branch.get(thread.branchId);
        if (updatedBranch === null) {
          throw new Error("expected preempted branch");
        }

        return createProjection({
          clockSkew: {
            // The backend clock surfaces zero expired leases while it is still
            // below the expiry, even though the peer's skewed clock would expire it.
            backendClockExpiredCountBeforeExpiry:
              expiredBeforeBackendExpiry.length,
            leaseCleared:
              storedRun.executionOwnerId === undefined &&
              storedRun.fencingToken === undefined &&
              storedRun.leaseExpiresAtMs === undefined,
            preemptedAfterBackendExpiry,
            preemptionReason: storedRun.preemptionReason ?? null,
            // The completed side-effecting call is incorporated into committed
            // history during recovery, so a resuming owner skips it by callId and
            // drives the side effect at most once.
            recoveredStagedResultTaskIds: recovery.consumedStagedResults.map(
              (staged) => staged.taskId
            ),
            recoveryHeadMatchesBranchHead:
              recovery.lastTurnNodeHash === updatedBranch.headTurnNodeHash,
            runStatus: storedRun.status,
            splitBrainPreemptionBlocked,
            uncommittedStagedResultCount:
              recovery.uncommittedStagedResults.length,
            // The skew is real: by its own clock the peer would have expired the
            // lease in phase 1.
            workerClockWouldExpire: secondaryNowMs > leaseExpiresAtMs,
          },
        });
      },
      { now: backendNow }
    );
  };

  return Object.freeze({
    runClockSkewPreemption,
    runExpiredListing,
    runLeaseRenewal,
    runStalePreemption,
  });
};
