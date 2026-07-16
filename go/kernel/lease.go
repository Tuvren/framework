// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This file implements the M3 run-liveness capability (kernel.run-liveness):
// run execution leases as described by docs/KrakenKernelSpecification.md
// §5.2 Run Execution Leases (ADR-050). The backend-authoritative clock
// requirement means every timestamp here comes from k.Clock (the same clock
// the Backend was constructed with), never from wall-clock time read
// directly — this is what lets a deterministic test clock (ManualClock,
// runtime.go) drive exact expiry arithmetic.
package kernel

import (
	"fmt"
	"sort"
)

// AcquireLease grants runID's execution lease to ownerID for ttlMs
// milliseconds from the current backend-authoritative clock reading. runID
// must exist; any prior lease state on the run is overwritten — the memory
// baseline is single-writer embedded (spec §5.2), so acquire-time cross-owner
// conflict rejection is not mandated here. CreateRun does not acquire a lease
// implicitly (a caller opts in), so the common sequence is CreateRun then
// AcquireLease. Returns the minted lease token and its absolute expiry
// (epoch ms).
func (k *Kernel) AcquireLease(runID, ownerID string, ttlMs int64) (token string, expiresAtMs int64, err error) {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return "", 0, newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}

	now := k.Clock.NowMs()
	k.leaseTokenOrdinal++
	token = fmt.Sprintf("lease_%s_%d", runID, k.leaseTokenOrdinal)
	expiresAtMs = now + ttlMs

	run.HasLease = true
	run.LeaseOwnerID = ownerID
	run.LeaseToken = token
	run.LeaseExpiresAtMs = expiresAtMs
	k.Backend.UpdateRun(run)

	return token, expiresAtMs, nil
}

// RenewLease extends runID's execution lease by ttlMs milliseconds from the
// current backend-authoritative clock reading, provided the run is still
// "running", its lease has not already expired, and ownerID and token both
// match the lease currently on record. This mirrors the TypeScript
// reference's renewLease guard ladder (runtime-kernel-runs.ts) in order:
// lease presence (ErrRunLeaseNotHeld), run status (ErrRunNotActive — the Go
// port reuses the general not-active code rather than TS's distinct
// not-running one), lease expiry (ErrRunLeaseExpired), owner
// (ErrRunLeaseOwnerMismatch), then token (ErrRunLeaseTokenMismatch). The Go
// port does not implement TS's renewal token rotation (an acknowledged,
// unpinned cross-port divergence); the caller-supplied token stays valid for
// the next renewal. Returns the lease's new absolute expiry (epoch ms).
func (k *Kernel) RenewLease(runID, ownerID, token string, ttlMs int64) (renewedExpiresAtMs int64, err error) {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return 0, newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	if !run.HasLease {
		return 0, newKernelError(ErrRunLeaseNotHeld, "run %q does not currently hold a lease", runID)
	}
	if run.Status != RunStatusRunning {
		return 0, newKernelError(ErrRunNotActive, "run %q's lease cannot be renewed (status: %s)", runID, run.Status)
	}

	now := k.Clock.NowMs()
	if run.LeaseExpiresAtMs <= now {
		return 0, newKernelError(ErrRunLeaseExpired, "run %q's lease expired at %d (now %d)", runID, run.LeaseExpiresAtMs, now)
	}
	if run.LeaseOwnerID != ownerID {
		return 0, newKernelError(ErrRunLeaseOwnerMismatch, "run %q's lease is owned by %q, not %q", runID, run.LeaseOwnerID, ownerID)
	}
	if run.LeaseToken != token {
		return 0, newKernelError(ErrRunLeaseTokenMismatch, "run %q's lease token does not match", runID)
	}

	renewedExpiresAtMs = now + ttlMs
	run.LeaseExpiresAtMs = renewedExpiresAtMs
	k.Backend.UpdateRun(run)

	return renewedExpiresAtMs, nil
}

// PauseRun marks runID paused. Paused runs are excluded from
// ListExpiredRuns and from stale preemption regardless of their lease
// state (kernel spec §5.2: only a "running" run can go stale — a paused
// run's owner deliberately relinquished active execution, which is not a
// crash). Only a "running" run can be paused (ErrRunNotActive otherwise):
// a run that already reached a terminal status ("completed" or "failed")
// must not be resurrected into the active set by pausing it — doing so
// would make activeRunOnBranch (kernel_runtime.go) treat the branch as
// still occupied, blocking CreateRun/forward SetBranchHead on it, and
// would pin the reclamation grace horizon on a run nothing will ever
// resume.
func (k *Kernel) PauseRun(runID string) error {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	if run.Status != RunStatusRunning {
		return newKernelError(ErrRunNotActive, "run %q cannot be paused (status: %s)", runID, run.Status)
	}
	run.Status = RunStatusPaused
	k.Backend.UpdateRun(run)
	return nil
}

// ListExpiredRuns returns the sorted run ids of every run whose status is
// "running", that holds a lease, and whose lease expiresAtMs is at or
// before nowMs. A "paused" run is never listed here even if its lease (if
// it still has one on record) has expired — kernel spec §5.2's stale
// window only ever applies to a run actively believed to be executing.
func (k *Kernel) ListExpiredRuns(nowMs int64) []string {
	var expired []string
	for _, run := range k.Backend.ListRuns() {
		if run.Status != RunStatusRunning {
			continue
		}
		if !run.HasLease {
			continue
		}
		if run.LeaseExpiresAtMs > nowMs {
			continue
		}
		expired = append(expired, run.RunID)
	}
	sort.Strings(expired)
	return expired
}

// preemptionEventMediaType is the media type PreemptStaleRun's minted
// preemption event object is stored under.
const preemptionEventMediaType = "application/cbor"

// preemptionEventRecord builds the canonical-record encoding of a stale-run
// preemption's reactive-checkpoint event: {runId, type}. This mirrors the
// shape threadBootstrapRecord (kernel_runtime.go) uses for a thread's
// genesis event — a small, backend-owned, content-addressed marker object
// pinned as the minted turn node's EventHash. The Go port does not need
// byte-identical encoding with the TypeScript or Rust ports' own
// stale-preemption event objects (see TypeScript's preemptExpired in
// typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts and Rust's
// run_liveness_preempt_expired in rust/kernel/src/memory.rs); only that the
// encoding is deterministic and preemption-shaped.
func preemptionEventRecord(runID string) RecordMap {
	return RecordMap{
		"runId": RecordText(runID),
		"type":  RecordText("kernel_runtime_run_preempted"),
	}
}

// PreemptStaleRun fails runID as a stale-recovery preemption (kernel spec
// §5.2 Preemption step 4): runID must be status "running" with a lease that
// has expired at or before nowMs (ErrRunNotPreemptable otherwise — this
// guards against preempting a live, non-expired, or already-inactive run).
//
// On success: any staged-but-uncommitted results are reactively
// checkpointed onto the run's active lineage exactly as a normal terminal
// completion (CompleteRun) would — a fresh preemption event object is
// minted and pinned as the checkpoint's EventHash, the staged results are
// incorporated into a new turn tree per the run's schema, a new turn node
// consuming them is chained onto the run's active turn node, and the
// run's branch head advances to it (via checkpointRun, the same primitive
// CompleteStep/CompleteRun use). Only once that checkpoint has durably
// committed does status become "failed", preemptionReason become
// "stale_running_recovery", the run's CreatedTurnNodes/staging bookkeeping
// reflect the new head, and the lease clear entirely (HasLease=false). A
// preempted run's dead owner does not lose unflushed work; it is preserved
// exactly where a live owner's own terminal completion would have placed
// it, and RecoveryState afterward reports zero uncommitted staged results
// and a last turn node that matches the branch head.
func (k *Kernel) PreemptStaleRun(runID string, nowMs int64) error {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	if run.Status != RunStatusRunning || !run.HasLease || run.LeaseExpiresAtMs > nowMs {
		return newKernelError(ErrRunNotPreemptable, "run %q is not a stale running run as of %d", runID, nowMs)
	}

	staged := k.Backend.DrainStagedResults(runID)

	eventBytes, err := EncodeCanonical(preemptionEventRecord(runID))
	if err != nil {
		return err
	}
	eventHash := k.Backend.PutObject(preemptionEventMediaType, eventBytes).Hash

	hash, updatedRun, err := k.checkpointRun(run, eventHash, "", staged, PendingCheckpointKindPreempt)
	if err != nil {
		if hash == "" {
			// The checkpoint never became durable: nothing consumed
			// committed anywhere, so restage it rather than silently
			// losing it, mirroring CompleteStep/CompleteRun's identical
			// restaging on this path — a later successful preemption
			// attempt (or a recovery replay) must still see it as
			// uncommitted work.
			for _, result := range staged {
				k.Backend.StageResult(runID, result)
			}
		}
		// hash != "" means the checkpoint's durable writes already
		// succeeded (a torn mid-commit checkpoint): the turn node and
		// branch head are real, but this run record is deliberately left
		// un-advanced here, with PendingCheckpointHash/Kind
		// (PendingCheckpointKindPreempt) durably marking it torn.
		// ReconcileRun (recovery.go) is what finishes the failure
		// transition — folding the pending node in, flipping status to
		// "failed" with preemptionReason "stale_running_recovery", and
		// clearing the lease. A naive retry of PreemptStaleRun on this run
		// before ReconcileRun runs is refused with ErrRunPendingCheckpoint
		// (checkpointRun's guard) rather than minting a second preemption
		// event node.
		return err
	}
	run = updatedRun

	run.Status = RunStatusFailed
	run.PreemptionReason = "stale_running_recovery"
	run.HasLease = false
	run.LeaseOwnerID = ""
	run.LeaseToken = ""
	run.LeaseExpiresAtMs = 0
	k.Backend.UpdateRun(run)

	return nil
}
