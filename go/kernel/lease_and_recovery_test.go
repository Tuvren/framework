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

package kernel_test

import (
	"reflect"
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

func newManualClockKernel(startMs int64) (*kernel.Kernel, *kernel.ManualClock) {
	clock := kernel.NewManualClock(startMs)
	backend := kernel.NewInMemoryBackend(clock)
	return kernel.NewKernel("test-scope", clock, backend), clock
}

func createSingleStepRun(t *testing.T, k *kernel.Kernel, threadID, branchID, runID string) string {
	t.Helper()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	created, err := k.CreateThread(threadID, "schema_main", branchID)
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun(runID, "turn_"+runID, branchID, "schema_main", created.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	return created.RootTurnNodeHash
}

// --- run execution leases (kernel.run-liveness) ---

func TestLease_AcquireAndRenew(t *testing.T) {
	k, clock := newManualClockKernel(10)
	createSingleStepRun(t, k, "thread_lease", "branch_lease", "run_lease")

	token, expiresAt, err := k.AcquireLease("run_lease", "owner_a", 20)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if expiresAt != 30 {
		t.Fatalf("expected initial expiry 30, got %d", expiresAt)
	}

	clock.SetMs(20)
	renewed, err := k.RenewLease("run_lease", "owner_a", token, 20)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if renewed != 40 {
		t.Fatalf("expected renewed expiry 40, got %d", renewed)
	}
}

func TestLease_RenewOwnerMismatch(t *testing.T) {
	k, _ := newManualClockKernel(10)
	createSingleStepRun(t, k, "thread_lease_owner", "branch_lease_owner", "run_lease_owner")
	token, _, err := k.AcquireLease("run_lease_owner", "owner_a", 20)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	_, err = k.RenewLease("run_lease_owner", "owner_b", token, 20)
	requireErrCode(t, err, kernel.ErrRunLeaseOwnerMismatch)
}

func TestLease_RenewStaleToken(t *testing.T) {
	k, _ := newManualClockKernel(10)
	createSingleStepRun(t, k, "thread_lease_token", "branch_lease_token", "run_lease_token")
	if _, _, err := k.AcquireLease("run_lease_token", "owner_a", 20); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	_, err := k.RenewLease("run_lease_token", "owner_a", "not-the-real-token", 20)
	requireErrCode(t, err, kernel.ErrRunLeaseTokenMismatch)
}

// TestLease_RenewExpiredRejected is a regression for the gap where
// RenewLease had no expiry guard at all: mirroring the TypeScript
// reference's renewLease (runtime-kernel-runs.ts), a lease that has already
// expired as of the backend-authoritative clock must be rejected with
// ErrRunLeaseExpired rather than silently renewed.
func TestLease_RenewExpiredRejected(t *testing.T) {
	k, clock := newManualClockKernel(0)
	createSingleStepRun(t, k, "thread_lease_expired", "branch_lease_expired", "run_lease_expired")
	token, expiresAt, err := k.AcquireLease("run_lease_expired", "owner_a", 10)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	clock.SetMs(expiresAt) // expiry is inclusive (isLeaseExpired: leaseExpiresAtMs <= nowMs)

	_, err = k.RenewLease("run_lease_expired", "owner_a", token, 10)
	requireErrCode(t, err, kernel.ErrRunLeaseExpired)
}

// TestLease_RenewNonRunningStatusRejected proves the RenewLease status guard
// itself fires (ErrRunNotActive) for a non-"running" run, distinct from the
// lease-presence guard: PauseRun (unlike CompleteRun) leaves the lease
// fields untouched, so a paused run still holds its lease when RenewLease is
// called and the rejection must come from the status check, not
// ErrRunLeaseNotHeld. (A completed run is covered separately by
// TestCompleteRun_ClearsLeaseAndAdvancesStepIndex in
// kernel_runtime_test.go, where CompleteRun's own lease-clearing effect
// means a *subsequent* renewal is rejected earlier, by ErrRunLeaseNotHeld.)
func TestLease_RenewNonRunningStatusRejected(t *testing.T) {
	k, _ := newManualClockKernel(0)
	createSingleStepRun(t, k, "thread_lease_paused", "branch_lease_paused", "run_lease_paused")
	token, _, err := k.AcquireLease("run_lease_paused", "owner_a", 1000)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := k.PauseRun("run_lease_paused"); err != nil {
		t.Fatalf("pause: %v", err)
	}

	run, ok := k.Backend.GetRun("run_lease_paused")
	if !ok || !run.HasLease {
		t.Fatalf("expected paused run to still hold its lease before renewal is attempted")
	}

	_, err = k.RenewLease("run_lease_paused", "owner_a", token, 10)
	requireErrCode(t, err, kernel.ErrRunNotActive)
}

// TestAcquireLease_CompletedRunRejectedAndDoesNotMutateLeaseState is a
// regression for the gap where AcquireLease had no status guard at all: a
// completed run must not end up with HasLease=true, which would bypass
// RenewLease's entire guard ladder for a run nothing will ever resume.
func TestAcquireLease_CompletedRunRejectedAndDoesNotMutateLeaseState(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_acquire_completed", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if err := k.CompleteRun("run_1", ""); err != nil {
		t.Fatalf("complete run: %v", err)
	}

	_, _, err = k.AcquireLease("run_1", "owner_a", 1000)
	requireErrCode(t, err, kernel.ErrRunNotActive)

	run, ok := k.Backend.GetRun("run_1")
	if !ok {
		t.Fatalf("run_1 not found")
	}
	if run.HasLease {
		t.Fatalf("expected a rejected acquire against a completed run to leave HasLease false, got true")
	}
	if run.Status != kernel.RunStatusCompleted {
		t.Fatalf("expected run_1 to remain completed, got %q", run.Status)
	}
}

// TestAcquireLease_FailedRunRejectedAndDoesNotMutateLeaseState is the same
// regression as TestAcquireLease_CompletedRunRejectedAndDoesNotMutateLeaseState
// but for a preemption-failed run instead of a normally-completed one.
func TestAcquireLease_FailedRunRejectedAndDoesNotMutateLeaseState(t *testing.T) {
	k, clock := newManualClockKernel(0)
	createSingleStepRun(t, k, "thread_acquire_failed", "branch_acquire_failed", "run_failed")
	if _, _, err := k.AcquireLease("run_failed", "owner_a", 5); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	clock.SetMs(100)
	if err := k.PreemptStaleRun("run_failed", clock.NowMs()); err != nil {
		t.Fatalf("preempt: %v", err)
	}

	_, _, err := k.AcquireLease("run_failed", "owner_b", 1000)
	requireErrCode(t, err, kernel.ErrRunNotActive)

	run, ok := k.Backend.GetRun("run_failed")
	if !ok {
		t.Fatalf("run_failed not found")
	}
	if run.HasLease {
		t.Fatalf("expected a rejected acquire against a failed run to leave HasLease false, got true")
	}
	if run.LeaseOwnerID != "" {
		t.Fatalf("expected a rejected acquire to leave LeaseOwnerID empty, got %q", run.LeaseOwnerID)
	}
	if run.Status != kernel.RunStatusFailed {
		t.Fatalf("expected run_failed to remain failed, got %q", run.Status)
	}
}

// TestAcquireLease_PausedRunRejectedAndDoesNotMutateLeaseState is the same
// regression again for a paused run: PauseRun leaves the lease fields
// untouched, so this proves the AcquireLease status guard itself fires
// rather than some other side effect of pausing clearing the lease first.
func TestAcquireLease_PausedRunRejectedAndDoesNotMutateLeaseState(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_acquire_paused", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if err := k.PauseRun("run_1"); err != nil {
		t.Fatalf("pause: %v", err)
	}

	_, _, err = k.AcquireLease("run_1", "owner_a", 1000)
	requireErrCode(t, err, kernel.ErrRunNotActive)

	run, ok := k.Backend.GetRun("run_1")
	if !ok {
		t.Fatalf("run_1 not found")
	}
	if run.HasLease {
		t.Fatalf("expected a rejected acquire against a paused run to leave HasLease false, got true")
	}
	if run.Status != kernel.RunStatusPaused {
		t.Fatalf("expected run_1 to remain paused, got %q", run.Status)
	}
}

func TestLease_TokensAreUniquePerAcquisitionUnderAFrozenClock(t *testing.T) {
	// Spec §5.2 requires a monotonically changing fencing token. A
	// clock-derived token repeats when two acquisitions land on the same
	// backend-clock millisecond — the norm under ManualClock — letting a
	// stale owner's old token stay valid after a re-acquisition.
	k, _ := newManualClockKernel(10)
	createSingleStepRun(t, k, "thread_lease_uniq", "branch_lease_uniq", "run_lease_uniq")
	first, _, err := k.AcquireLease("run_lease_uniq", "owner_a", 20)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	second, _, err := k.AcquireLease("run_lease_uniq", "owner_b", 20)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if first == second {
		t.Fatalf("expected distinct lease tokens for same-instant acquisitions, both were %q", first)
	}
	if _, err := k.RenewLease("run_lease_uniq", "owner_a", first, 20); err == nil {
		t.Fatalf("expected the pre-reacquisition token to be rejected")
	}
}

func TestLease_ExpiredListingExcludesPausedRuns(t *testing.T) {
	k, clock := newManualClockKernel(0)
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}

	createdExpired, err := k.CreateThread("thread_expired", "schema_main", "branch_expired")
	if err != nil {
		t.Fatalf("create thread expired: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_expired", "turn_expired", "branch_expired", "schema_main", createdExpired.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run expired: %v", err)
	}
	if _, _, err := k.AcquireLease("run_expired", "owner_a", 5); err != nil {
		t.Fatalf("acquire lease expired: %v", err)
	}

	createdPaused, err := k.CreateThread("thread_paused", "schema_main", "branch_paused")
	if err != nil {
		t.Fatalf("create thread paused: %v", err)
	}
	if err := k.CreateRun("run_paused", "turn_paused", "branch_paused", "schema_main", createdPaused.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run paused: %v", err)
	}
	if _, _, err := k.AcquireLease("run_paused", "owner_b", 5); err != nil {
		t.Fatalf("acquire lease paused: %v", err)
	}
	if err := k.PauseRun("run_paused"); err != nil {
		t.Fatalf("pause run: %v", err)
	}

	clock.SetMs(100) // both leases (ttl=5, acquired at t=0) are long expired now

	expired := k.ListExpiredRuns(clock.NowMs())
	if len(expired) != 1 || expired[0] != "run_expired" {
		t.Fatalf("expected only run_expired listed, got %v", expired)
	}

	pausedRun, ok := k.Backend.GetRun("run_paused")
	if !ok {
		t.Fatalf("run_paused not found")
	}
	if pausedRun.Status != kernel.RunStatusPaused {
		t.Fatalf("expected run_paused status paused, got %q", pausedRun.Status)
	}
}

// TestPauseRun_CompletedRunRejectedAndDoesNotResurrect is a regression for
// the gap where PauseRun unconditionally set status "paused" regardless of
// the run's current status: pausing an already-"completed" run must be
// rejected, and — critically — must not resurrect the run into the active
// set (activeRunOnBranch treats "running"/"paused" as active), which would
// otherwise block all future CreateRun/forward SetBranchHead calls on the
// branch and pin the reclamation grace horizon on a run nothing will ever
// resume.
func TestPauseRun_CompletedRunRejectedAndDoesNotResurrect(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_pause_completed", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if err := k.CompleteRun("run_1", ""); err != nil {
		t.Fatalf("complete run: %v", err)
	}

	err = k.PauseRun("run_1")
	requireErrCode(t, err, kernel.ErrRunNotActive)

	run, ok := k.Backend.GetRun("run_1")
	if !ok {
		t.Fatalf("run_1 not found")
	}
	if run.Status != kernel.RunStatusCompleted {
		t.Fatalf("expected run_1 to remain completed after a rejected pause, got %q", run.Status)
	}

	// The branch must not appear occupied by a resurrected run_1: a new run
	// on the same branch (from its current head) must succeed.
	branch, ok := k.Backend.GetBranch("branch_main")
	if !ok {
		t.Fatalf("branch_main not found")
	}
	if err := k.CreateRun("run_2", "turn_2", "branch_main", "schema_main", branch.HeadTurnNodeHash, steps); err != nil {
		t.Fatalf("expected branch_main to remain free for a new run after the rejected pause, got: %v", err)
	}
}

// TestPauseRun_FailedRunRejectedAndDoesNotResurrect is the same regression
// as TestPauseRun_CompletedRunRejectedAndDoesNotResurrect but for a
// preemption-failed run instead of a normally-completed one.
func TestPauseRun_FailedRunRejectedAndDoesNotResurrect(t *testing.T) {
	k, clock := newManualClockKernel(0)
	createSingleStepRun(t, k, "thread_pause_failed", "branch_pause_failed", "run_failed")
	if _, _, err := k.AcquireLease("run_failed", "owner_a", 5); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	clock.SetMs(100)
	if err := k.PreemptStaleRun("run_failed", clock.NowMs()); err != nil {
		t.Fatalf("preempt: %v", err)
	}

	err := k.PauseRun("run_failed")
	requireErrCode(t, err, kernel.ErrRunNotActive)

	run, ok := k.Backend.GetRun("run_failed")
	if !ok {
		t.Fatalf("run_failed not found")
	}
	if run.Status != kernel.RunStatusFailed {
		t.Fatalf("expected run_failed to remain failed after a rejected pause, got %q", run.Status)
	}

	branch, ok := k.Backend.GetBranch("branch_pause_failed")
	if !ok {
		t.Fatalf("branch_pause_failed not found")
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_after", "turn_after", "branch_pause_failed", "schema_main", branch.HeadTurnNodeHash, steps); err != nil {
		t.Fatalf("expected branch_pause_failed to remain free for a new run after the rejected pause, got: %v", err)
	}
}

func TestLease_StalePreemption(t *testing.T) {
	k, clock := newManualClockKernel(0)
	createSingleStepRun(t, k, "thread_stale", "branch_stale", "run_stale")
	if _, _, err := k.AcquireLease("run_stale", "owner_a", 5); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := k.StageResult("run_stale", kernel.StagedResult{
		TaskID: "task_1", ObjectHash: kernel.HashBytesToHex([]byte("staged")), ObjectType: "message",
		Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage: %v", err)
	}

	// Preempting before expiry must be rejected.
	if err := k.PreemptStaleRun("run_stale", clock.NowMs()); err == nil {
		t.Fatalf("expected preemption before expiry to be rejected")
	}

	clock.SetMs(100)
	if err := k.PreemptStaleRun("run_stale", clock.NowMs()); err != nil {
		t.Fatalf("preempt: %v", err)
	}

	run, ok := k.Backend.GetRun("run_stale")
	if !ok {
		t.Fatalf("run_stale not found")
	}
	if run.Status != kernel.RunStatusFailed {
		t.Fatalf("expected status failed, got %q", run.Status)
	}
	if run.PreemptionReason != "stale_running_recovery" {
		t.Fatalf("expected preemption reason stale_running_recovery, got %q", run.PreemptionReason)
	}
	if run.HasLease {
		t.Fatalf("expected lease cleared")
	}

	state, err := k.RecoveryState("run_stale")
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if len(state.UncommittedStagedResults) != 0 {
		t.Fatalf("expected uncommitted staged results cleared, got %d", len(state.UncommittedStagedResults))
	}
	branch, ok := k.Backend.GetBranch("branch_stale")
	if !ok {
		t.Fatalf("branch_stale not found")
	}
	if state.LastTurnNodeHash != branch.HeadTurnNodeHash {
		t.Fatalf("expected recovery head to match branch head: %q vs %q", state.LastTurnNodeHash, branch.HeadTurnNodeHash)
	}

	// Preemption step 4 (kernel spec §5.2) requires that staged-but-
	// uncommitted work survive preemption via a reactive checkpoint, not be
	// discarded: the staged task must appear as the new head turn node's
	// own consumed staged results.
	if len(state.ConsumedStagedResults) != 1 || state.ConsumedStagedResults[0].TaskID != "task_1" {
		t.Fatalf("expected preemption to preserve staged task_1 as consumed staged results, got %+v", state.ConsumedStagedResults)
	}
}

// TestLease_StalePreemptionPreservesStagedWork proves staged-but-uncommitted
// work survives a stale preemption instead of being silently discarded
// (kernel spec §5.2 Preemption step 4): the staged result's task id must
// appear in the preempted run's new head turn node's own
// ConsumedStagedResults, the branch head must have advanced to that new
// node, and the run's staging pool must be empty afterward.
func TestLease_StalePreemptionPreservesStagedWork(t *testing.T) {
	k, clock := newManualClockKernel(0)
	rootHash := createSingleStepRun(t, k, "thread_stale_preserve", "branch_stale_preserve", "run_stale_preserve")
	if _, _, err := k.AcquireLease("run_stale_preserve", "owner_a", 5); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := k.StageResult("run_stale_preserve", kernel.StagedResult{
		TaskID: "assistant_message", ObjectHash: kernel.HashBytesToHex([]byte("staged-before-preemption")),
		ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage: %v", err)
	}

	clock.SetMs(100)
	if err := k.PreemptStaleRun("run_stale_preserve", clock.NowMs()); err != nil {
		t.Fatalf("preempt: %v", err)
	}

	branch, ok := k.Backend.GetBranch("branch_stale_preserve")
	if !ok {
		t.Fatalf("branch_stale_preserve not found")
	}
	if branch.HeadTurnNodeHash == rootHash {
		t.Fatalf("expected branch head to advance past root on preemption checkpoint")
	}
	headNode, ok := k.Backend.GetTurnNode(branch.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("preempted head turn node %q not found", branch.HeadTurnNodeHash)
	}
	if len(headNode.ConsumedStagedResults) != 1 || headNode.ConsumedStagedResults[0].TaskID != "assistant_message" {
		t.Fatalf("expected head turn node to consume staged task assistant_message, got %+v", headNode.ConsumedStagedResults)
	}

	state, err := k.RecoveryState("run_stale_preserve")
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if len(state.UncommittedStagedResults) != 0 {
		t.Fatalf("expected staging pool empty after preemption checkpoint, got %d", len(state.UncommittedStagedResults))
	}
	if state.LastTurnNodeHash != branch.HeadTurnNodeHash {
		t.Fatalf("expected recovery head to match advanced branch head: %q vs %q", state.LastTurnNodeHash, branch.HeadTurnNodeHash)
	}
}

// --- fault-injecting backend / crash recovery (kernel.restart-recovery) ---

// setUpFirstCheckpoint creates a two-step run and completes its first step,
// committing message_1, so the fault-point tests below have a stable
// pre-fault baseline (visibleCommittedMessageCount 1) to fault a second
// checkpoint against.
func setUpFirstCheckpoint(t *testing.T, k *kernel.Kernel) (runID string, message2Hash string) {
	t.Helper()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	created, err := k.CreateThread("thread_crash", "schema_main", "branch_crash")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "step_1", Deterministic: true, SideEffects: false},
		{ID: "step_2", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_crash", "turn_crash", "branch_crash", "schema_main", created.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	message1Hash := k.PutObject("application/json", []byte("message-1"))
	if err := k.StageResult("run_crash", kernel.StagedResult{
		TaskID: "task_1", ObjectHash: message1Hash, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage message 1: %v", err)
	}
	if _, err := k.CompleteStep("run_crash", "step_1", "", ""); err != nil {
		t.Fatalf("complete step 1: %v", err)
	}

	message2Hash = k.PutObject("application/json", []byte("message-2"))
	if err := k.StageResult("run_crash", kernel.StagedResult{
		TaskID: "task_2", ObjectHash: message2Hash, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage message 2: %v", err)
	}

	return "run_crash", message2Hash
}

func messageCount(t *testing.T, k *kernel.Kernel, branchID string) int {
	t.Helper()
	branch, ok := k.Backend.GetBranch(branchID)
	if !ok {
		t.Fatalf("branch %q not found", branchID)
	}
	node, ok := k.Backend.GetTurnNode(branch.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("head turn node %q not found", branch.HeadTurnNodeHash)
	}
	tree, ok := k.Backend.GetTurnTree(node.TurnTreeHash)
	if !ok {
		t.Fatalf("turn tree %q not found", node.TurnTreeHash)
	}
	value := tree.Manifest["messages"]
	return len(value.Ordered)
}

func TestFaultInjectingBackend_BeforeCommit(t *testing.T) {
	k, _ := newManualClockKernel(0)
	runID, _ := setUpFirstCheckpoint(t, k)

	baseBackend := k.Backend
	beforeHead, _ := k.Backend.GetBranch("branch_crash")

	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: kernel.FaultPointBeforeCommit, Policy: kernel.FaultPolicyOnce,
	})
	_, err := k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	afterHead, _ := k.Backend.GetBranch("branch_crash")
	if afterHead.HeadTurnNodeHash != beforeHead.HeadTurnNodeHash {
		t.Fatalf("expected branch head unchanged after before-commit fault")
	}
	if got := messageCount(t, k, "branch_crash"); got != 1 {
		t.Fatalf("expected visible committed message count 1, got %d", got)
	}

	// The staged message must have been restaged, not lost.
	state, err := k.RecoveryState(runID)
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if len(state.UncommittedStagedResults) != 1 {
		t.Fatalf("expected 1 uncommitted staged result restaged after before-commit fault, got %d", len(state.UncommittedStagedResults))
	}
	if state.LastTurnNodeHash != afterHead.HeadTurnNodeHash {
		t.Fatalf("expected recovery state head to match branch head")
	}
}

func testFaultPointCommitsDespiteError(t *testing.T, point kernel.FaultPoint) {
	k, _ := newManualClockKernel(0)
	runID, message2Hash := setUpFirstCheckpoint(t, k)

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: point, Policy: kernel.FaultPolicyOnce,
	})
	_, err := k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	if got := messageCount(t, k, "branch_crash"); got != 2 {
		t.Fatalf("expected visible committed message count 2 despite the injected error, got %d", got)
	}

	branch, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found")
	}
	node, ok := k.Backend.GetTurnNode(branch.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("head node not found")
	}
	tree, ok := k.Backend.GetTurnTree(node.TurnTreeHash)
	if !ok {
		t.Fatalf("head turn tree not found")
	}
	found := false
	for _, hash := range tree.Manifest["messages"].Ordered {
		if hash == message2Hash {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected message 2 (%q) to be committed despite the injected error", message2Hash)
	}

	// Before reconciliation the run record is deliberately stale.
	staleRun, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found")
	}
	if staleRun.CurrentStepIndex != 1 {
		t.Fatalf("expected run record to still show only step 1 completed before reconciliation, got index %d", staleRun.CurrentStepIndex)
	}

	if err := k.ReconcileRun(runID); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	reconciled, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found after reconcile")
	}
	if reconciled.CurrentStepIndex != 2 {
		t.Fatalf("expected reconciled run to show step 2 completed, got index %d", reconciled.CurrentStepIndex)
	}

	state, err := k.RecoveryState(runID)
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if state.LastTurnNodeHash != branch.HeadTurnNodeHash {
		t.Fatalf("expected reconciled recovery state head to match branch head")
	}
	if len(state.UncommittedStagedResults) != 0 {
		t.Fatalf("expected no uncommitted staged results after a fully committed fault point, got %d", len(state.UncommittedStagedResults))
	}
}

func TestFaultInjectingBackend_AfterCommitBeforeAckCommitsDespiteError(t *testing.T) {
	testFaultPointCommitsDespiteError(t, kernel.FaultPointAfterCommitBeforeAck)
}

// TestFaultInjectingBackend_MidCommitTornCheckpoint proves the genuine
// torn-checkpoint state a FaultPointMidCommit plan now models
// (fault_injecting_backend.go): the checkpoint's turn node is durably
// written (PutTurnNode succeeded) but the branch head is left exactly
// where it was — unlike FaultPointAfterCommitBeforeAck, where the head
// really does move. This is kernel spec §5.5's "TurnNode exists →
// checkpoint succeeded" case: recovery must discover the
// durable-but-unreferenced node and roll the branch head, run bookkeeping,
// and staging forward to it without losing the staged results the
// torn commit consumed.
func TestReconcileRun_LostCASRetiresStaleMarkerWithoutMisattribution(t *testing.T) {
	// A torn mid-commit checkpoint leaves a durable pending node and marker,
	// with the head still at the pre-tear position. If the head then
	// legitimately advances somewhere ELSE (a foreign winner — modeled here
	// with a direct head write, the state a CommitSiblingCheckpoint victory
	// leaves behind), ReconcileRun's CAS from the pending node's predecessor
	// must lose, and reconcile must retire the stale marker WITHOUT adopting
	// the foreign lineage into the run and WITHOUT leaving the marker set
	// (which would refuse every future checkpoint forever). Mirrors the
	// Python port's lost-CAS marker-retire regression test.
	k, _ := newManualClockKernel(0)
	runID, _ := setUpFirstCheckpoint(t, k)

	beforeHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found")
	}
	headNode, ok := k.Backend.GetTurnNode(beforeHead.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("pre-tear head node not found")
	}

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: kernel.FaultPointMidCommit, Policy: kernel.FaultPolicyOnce,
	})
	_, err := k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	tornRun, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found")
	}
	if tornRun.PendingCheckpointHash == "" {
		t.Fatalf("expected a durable pending checkpoint marker after the tear")
	}
	createdBefore := len(tornRun.CreatedTurnNodes)
	stepIndexBefore := tornRun.CurrentStepIndex

	// Move the head to a foreign sibling minted off the same pre-tear head —
	// exactly the durable state a CommitSiblingCheckpoint winner produces.
	foreignEvent := k.PutObject("application/json", []byte("foreign-winner"))
	foreignNode, err := k.CommitSiblingCheckpoint("branch_crash", beforeHead.HeadTurnNodeHash, kernel.TurnNode{
		SchemaID: headNode.SchemaID, TurnTreeHash: headNode.TurnTreeHash, EventHash: foreignEvent,
	})
	if err != nil {
		t.Fatalf("commit foreign sibling: %v", err)
	}

	if err := k.ReconcileRun(runID); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	branch, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found")
	}
	if branch.HeadTurnNodeHash != foreignNode {
		t.Fatalf("expected the foreign head to be left alone, got %q", branch.HeadTurnNodeHash)
	}
	reconciled, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found")
	}
	if reconciled.PendingCheckpointHash != "" || reconciled.PendingCheckpointKind != "" {
		t.Fatalf("expected the stale pending marker to be retired, got hash=%q kind=%q", reconciled.PendingCheckpointHash, reconciled.PendingCheckpointKind)
	}
	if len(reconciled.CreatedTurnNodes) != createdBefore {
		t.Fatalf("expected no foreign nodes adopted into CreatedTurnNodes, got %d (was %d)", len(reconciled.CreatedTurnNodes), createdBefore)
	}
	if reconciled.CurrentStepIndex != stepIndexBefore {
		t.Fatalf("expected CurrentStepIndex unchanged, got %d (was %d)", reconciled.CurrentStepIndex, stepIndexBefore)
	}
}

func TestFaultInjectingBackend_MidCommitTornCheckpoint(t *testing.T) {
	k, _ := newManualClockKernel(0)
	runID, message2Hash := setUpFirstCheckpoint(t, k)

	beforeHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found")
	}

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: kernel.FaultPointMidCommit, Policy: kernel.FaultPolicyOnce,
	})
	_, err := k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	// --- raw backend state immediately after the torn commit ---

	afterFaultHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found")
	}
	if afterFaultHead.HeadTurnNodeHash != beforeHead.HeadTurnNodeHash {
		t.Fatalf("expected branch head unchanged immediately after a mid-commit fault, got %q (was %q)", afterFaultHead.HeadTurnNodeHash, beforeHead.HeadTurnNodeHash)
	}
	if got := messageCount(t, k, "branch_crash"); got != 1 {
		t.Fatalf("expected visible committed message count 1 before recovery, got %d", got)
	}

	pending := k.Backend.ListChildTurnNodes(beforeHead.HeadTurnNodeHash)
	if len(pending) != 1 {
		t.Fatalf("expected exactly one durable pending child turn node past the un-advanced head, got %d", len(pending))
	}
	pendingNode := pending[0]
	pendingTree, ok := k.Backend.GetTurnTree(pendingNode.TurnTreeHash)
	if !ok {
		t.Fatalf("pending node's turn tree %q not found", pendingNode.TurnTreeHash)
	}
	pendingHasMessage2 := false
	for _, hash := range pendingTree.Manifest["messages"].Ordered {
		if hash == message2Hash {
			pendingHasMessage2 = true
		}
	}
	if !pendingHasMessage2 {
		t.Fatalf("expected the durable pending node to already have consumed message 2 (%q)", message2Hash)
	}
	if len(pendingNode.ConsumedStagedResults) != 1 {
		t.Fatalf("expected the pending node to have embedded exactly 1 consumed staged result, got %d", len(pendingNode.ConsumedStagedResults))
	}

	// The staged message must not be lost: it is durably embedded in the
	// pending node's ConsumedStagedResults (proven above), so it must not
	// also still sit in the uncommitted staging pool.
	state, err := k.RecoveryState(runID)
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if len(state.UncommittedStagedResults) != 0 {
		t.Fatalf("expected no uncommitted staged results after a mid-commit fault (embedded in the pending node instead), got %d", len(state.UncommittedStagedResults))
	}

	staleRun, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found")
	}
	if staleRun.CurrentStepIndex != 1 {
		t.Fatalf("expected run record to still show only step 1 completed before reconciliation, got index %d", staleRun.CurrentStepIndex)
	}

	// --- reconcile rolls the pending node forward ---

	if err := k.ReconcileRun(runID); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	afterReconcileHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found after reconcile")
	}
	if afterReconcileHead.HeadTurnNodeHash != pendingNode.Hash {
		t.Fatalf("expected reconcile to advance the branch head to the pending node %q, got %q", pendingNode.Hash, afterReconcileHead.HeadTurnNodeHash)
	}
	if got := messageCount(t, k, "branch_crash"); got != 2 {
		t.Fatalf("expected visible committed message count 2 after reconcile, got %d", got)
	}

	reconciled, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found after reconcile")
	}
	if reconciled.CurrentStepIndex != 2 {
		t.Fatalf("expected reconciled run to show step 2 completed, got index %d", reconciled.CurrentStepIndex)
	}
	if len(reconciled.CreatedTurnNodes) == 0 || reconciled.CreatedTurnNodes[len(reconciled.CreatedTurnNodes)-1] != pendingNode.Hash {
		t.Fatalf("expected reconciled run's CreatedTurnNodes to end with the pending node %q, got %v", pendingNode.Hash, reconciled.CreatedTurnNodes)
	}

	postState, err := k.RecoveryState(runID)
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if postState.LastTurnNodeHash != pendingNode.Hash {
		t.Fatalf("expected reconciled recovery state head to match the pending node")
	}
	if len(postState.UncommittedStagedResults) != 0 {
		t.Fatalf("expected no uncommitted staged results after reconcile, got %d", len(postState.UncommittedStagedResults))
	}
}

// TestReconcileRun_TerminalRunFallbackGuard is a regression for the
// misattribution gap in ReconcileRun's fallback backward walk: when the
// branch head has legitimately advanced past a *terminal* run's active turn
// node because a later run on the same branch checkpointed, reconciling the
// older, already-"completed" run must be a no-op — it must not walk the
// head-to-active chain and append the newer run's own nodes to the older
// run's CreatedTurnNodes / CurrentStepIndex.
func TestReconcileRun_TerminalRunFallbackGuard(t *testing.T) {
	k, _ := newManualClockKernel(0)
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	created, err := k.CreateThread("thread_reconcile_terminal", "schema_main", "branch_reconcile_terminal")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}

	// Run A: create, checkpoint its one step (minting a real turn node), and
	// complete it normally — nothing left staged, so CompleteRun mints no
	// further node.
	if err := k.CreateRun("run_a", "turn_a", "branch_reconcile_terminal", "schema_main", created.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run a: %v", err)
	}
	message1 := k.PutObject("application/json", []byte("message-a"))
	if err := k.StageResult("run_a", kernel.StagedResult{
		TaskID: "task_a", ObjectHash: message1, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage for run a: %v", err)
	}
	if _, err := k.CompleteStep("run_a", "only_step", "", ""); err != nil {
		t.Fatalf("complete step for run a: %v", err)
	}
	if err := k.CompleteRun("run_a", ""); err != nil {
		t.Fatalf("complete run a: %v", err)
	}

	runABefore, ok := k.Backend.GetRun("run_a")
	if !ok {
		t.Fatalf("run_a not found")
	}
	if runABefore.Status != kernel.RunStatusCompleted {
		t.Fatalf("expected run_a completed, got %q", runABefore.Status)
	}
	createdBefore := append([]string(nil), runABefore.CreatedTurnNodes...)
	stepIndexBefore := runABefore.CurrentStepIndex

	branchAfterA, ok := k.Backend.GetBranch("branch_reconcile_terminal")
	if !ok {
		t.Fatalf("branch not found after run a")
	}

	// Run B: starts from run A's completed head and checkpoints its own
	// step, advancing the branch head further past run A's (now stale)
	// active turn node.
	if err := k.CreateRun("run_b", "turn_b", "branch_reconcile_terminal", "schema_main", branchAfterA.HeadTurnNodeHash, steps); err != nil {
		t.Fatalf("create run b: %v", err)
	}
	message2 := k.PutObject("application/json", []byte("message-b"))
	if err := k.StageResult("run_b", kernel.StagedResult{
		TaskID: "task_b", ObjectHash: message2, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage for run b: %v", err)
	}
	if _, err := k.CompleteStep("run_b", "only_step", "", ""); err != nil {
		t.Fatalf("complete step for run b: %v", err)
	}

	branchAfterB, ok := k.Backend.GetBranch("branch_reconcile_terminal")
	if !ok {
		t.Fatalf("branch not found after run b")
	}
	if branchAfterB.HeadTurnNodeHash == branchAfterA.HeadTurnNodeHash {
		t.Fatalf("expected run b's checkpoint to advance the branch head past run a's")
	}

	// Reconciling the older, terminal run_a must be a no-op: it must not
	// adopt run_b's freshly-minted node into its own CreatedTurnNodes.
	if err := k.ReconcileRun("run_a"); err != nil {
		t.Fatalf("reconcile run a: %v", err)
	}

	runAAfter, ok := k.Backend.GetRun("run_a")
	if !ok {
		t.Fatalf("run_a not found after reconcile")
	}
	if runAAfter.CurrentStepIndex != stepIndexBefore {
		t.Fatalf("expected run_a's CurrentStepIndex unchanged by reconciling a terminal run, was %d, now %d", stepIndexBefore, runAAfter.CurrentStepIndex)
	}
	if !reflect.DeepEqual(runAAfter.CreatedTurnNodes, createdBefore) {
		t.Fatalf("expected run_a's CreatedTurnNodes unchanged by reconciling a terminal run, was %v, now %v", createdBefore, runAAfter.CreatedTurnNodes)
	}
}

// --- single-writer checkpoint commit (concurrent writer) ---

func TestCommitSiblingCheckpoint_FirstWriterWinsSecondLoses(t *testing.T) {
	k, _ := newManualClockKernel(0)
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	created, err := k.CreateThread("thread_concurrent", "schema_main", "branch_concurrent")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	base := created.RootTurnNodeHash

	eventA := k.PutObject("application/json", []byte("writer-a"))
	nodeA := kernel.TurnNode{SchemaID: "schema_main", TurnTreeHash: created.RootTurnTreeHash, EventHash: eventA}
	winnerHash, err := k.CommitSiblingCheckpoint("branch_concurrent", base, nodeA)
	if err != nil {
		t.Fatalf("writer A commit: %v", err)
	}

	eventB := k.PutObject("application/json", []byte("writer-b"))
	nodeB := kernel.TurnNode{SchemaID: "schema_main", TurnTreeHash: created.RootTurnTreeHash, EventHash: eventB}
	_, err = k.CommitSiblingCheckpoint("branch_concurrent", base, nodeB)
	requireErrCode(t, err, kernel.ErrCheckpointLateralConflict)

	branch, ok := k.Backend.GetBranch("branch_concurrent")
	if !ok {
		t.Fatalf("branch not found")
	}
	if branch.HeadTurnNodeHash != winnerHash {
		t.Fatalf("expected final head to be the committed sibling %q, got %q", winnerHash, branch.HeadTurnNodeHash)
	}
}

// --- pending-checkpoint refusal (P1: silent staged-result loss on naive
// retry after a torn checkpoint) ---

// TestCompleteStep_NaiveRetryAfterTornCheckpointRejectedUntilReconciled is a
// regression for a P1 where a naive CompleteStep retry after a torn
// mid-commit checkpoint — without calling ReconcileRun first — silently
// overwrote the durable PendingCheckpointHash marker, minted a *second*
// checkpoint node consuming nothing (the staging pool was already drained
// and embedded in the first, orphaned node), and advanced the branch head
// to it: the first torn node's consumed staged results became permanently
// unreachable with no error ever surfacing. checkpointRun must instead
// refuse every checkpoint-minting call with ErrRunPendingCheckpoint while a
// prior checkpoint on this run is still unreconciled, leaving the marker,
// branch head, and staging pool exactly as the torn commit left them, and
// ReconcileRun must be the only way to fold the torn node onto the live
// lineage before any new checkpoint is attempted.
func TestCompleteStep_NaiveRetryAfterTornCheckpointRejectedUntilReconciled(t *testing.T) {
	k, _ := newManualClockKernel(0)
	runID, message2Hash := setUpFirstCheckpoint(t, k)

	beforeTornHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found")
	}

	// Tear the checkpoint mid-commit: the pending node becomes durable
	// (with message 2 embedded as its ConsumedStagedResults, draining the
	// staging pool), but the branch head is never moved to it.
	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: kernel.FaultPointMidCommit, Policy: kernel.FaultPolicyOnce,
	})
	_, err := k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	tornRun, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found")
	}
	if tornRun.PendingCheckpointHash == "" {
		t.Fatalf("expected a durable pending checkpoint marker after the torn mid-commit fault")
	}
	if tornRun.PendingCheckpointKind != kernel.PendingCheckpointKindStep {
		t.Fatalf("expected pending checkpoint kind %q, got %q", kernel.PendingCheckpointKindStep, tornRun.PendingCheckpointKind)
	}

	pendingChildrenBeforeRetry := k.Backend.ListChildTurnNodes(beforeTornHead.HeadTurnNodeHash)
	if len(pendingChildrenBeforeRetry) != 1 {
		t.Fatalf("expected exactly one durable pending child turn node after the torn commit, got %d", len(pendingChildrenBeforeRetry))
	}
	pendingHash := pendingChildrenBeforeRetry[0].Hash

	// The caller retries the same step WITHOUT reconciling first —
	// requireExpectedStep alone would accept this (CurrentStepIndex never
	// advanced), so only checkpointRun's own pending-checkpoint guard can
	// catch it.
	_, err = k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrRunPendingCheckpoint)

	// The marker, branch head, and staging pool must be exactly as the
	// torn commit left them: the naive retry must not have overwritten the
	// marker or minted a second checkpoint node.
	afterRetryRun, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found after rejected retry")
	}
	if afterRetryRun.PendingCheckpointHash != tornRun.PendingCheckpointHash {
		t.Fatalf("expected pending checkpoint marker unchanged by the rejected retry, was %q, now %q", tornRun.PendingCheckpointHash, afterRetryRun.PendingCheckpointHash)
	}
	if afterRetryRun.CurrentStepIndex != tornRun.CurrentStepIndex {
		t.Fatalf("expected CurrentStepIndex unchanged by the rejected retry, was %d, now %d", tornRun.CurrentStepIndex, afterRetryRun.CurrentStepIndex)
	}
	afterRetryHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found after rejected retry")
	}
	if afterRetryHead.HeadTurnNodeHash != beforeTornHead.HeadTurnNodeHash {
		t.Fatalf("expected branch head unchanged by the rejected retry, was %q, now %q", beforeTornHead.HeadTurnNodeHash, afterRetryHead.HeadTurnNodeHash)
	}
	pendingChildrenAfterRetry := k.Backend.ListChildTurnNodes(beforeTornHead.HeadTurnNodeHash)
	if len(pendingChildrenAfterRetry) != 1 {
		t.Fatalf("expected the rejected retry to mint no second checkpoint node, still exactly 1 pending child, got %d", len(pendingChildrenAfterRetry))
	}
	state, err := k.RecoveryState(runID)
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if len(state.UncommittedStagedResults) != 0 {
		t.Fatalf("expected no uncommitted staged results after the rejected retry (message 2 stays embedded in the torn node, not restaged), got %d", len(state.UncommittedStagedResults))
	}

	// ReconcileRun folds the torn node onto the live lineage: the staged
	// results it already consumed become reachable via the new head.
	if err := k.ReconcileRun(runID); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	reconciledHead, ok := k.Backend.GetBranch("branch_crash")
	if !ok {
		t.Fatalf("branch not found after reconcile")
	}
	if reconciledHead.HeadTurnNodeHash != pendingHash {
		t.Fatalf("expected reconcile to advance the branch head to the pending node %q, got %q", pendingHash, reconciledHead.HeadTurnNodeHash)
	}
	headNode, ok := k.Backend.GetTurnNode(reconciledHead.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("head turn node not found after reconcile")
	}
	foundMessage2 := false
	for _, result := range headNode.ConsumedStagedResults {
		if result.ObjectHash == message2Hash {
			foundMessage2 = true
		}
	}
	if !foundMessage2 {
		t.Fatalf("expected the reconciled head node's ConsumedStagedResults to carry message 2 (%q)", message2Hash)
	}

	reconciledRun, ok := k.Backend.GetRun(runID)
	if !ok {
		t.Fatalf("run not found after reconcile")
	}
	if reconciledRun.CurrentStepIndex != 2 {
		t.Fatalf("expected reconciled run to show step 2 completed, got index %d", reconciledRun.CurrentStepIndex)
	}
	if reconciledRun.PendingCheckpointHash != "" {
		t.Fatalf("expected pending checkpoint marker cleared after reconcile")
	}

	// The step retry path behaves per the reconcile contract: the run's
	// declared steps are now exhausted, so retrying step_2 again is a
	// distinct, ordinary ErrUnexpectedStep — not a second silent
	// checkpoint and not another pending-checkpoint refusal.
	_, err = k.CompleteStep(runID, "step_2", "", "")
	requireErrCode(t, err, kernel.ErrUnexpectedStep)
}

// --- torn TERMINAL transitions reconcile to their terminal status (P2) ---

// TestPreemptStaleRun_TornCheckpointReconcilesToFailedWithSingleEventNode is
// a regression for the P2 where a torn PreemptStaleRun checkpoint, once
// reconciled, left the run "running" with its lease intact instead of
// finishing the preemption's failed/lease-cleared terminal transition, and
// where a naive retry would have minted a *second* preemption event node
// before the status ever flipped. It also guards against ReconcileRun's
// unconditional CurrentStepIndex++ misattributing the preemption's reactive
// checkpoint node as a completed step.
func TestPreemptStaleRun_TornCheckpointReconcilesToFailedWithSingleEventNode(t *testing.T) {
	k, clock := newManualClockKernel(0)
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	created, err := k.CreateThread("thread_preempt_torn", "schema_main", "branch_preempt_torn")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "step_1", Deterministic: true, SideEffects: false},
		{ID: "step_2", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_preempt_torn", "turn_preempt_torn", "branch_preempt_torn", "schema_main", created.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	message1 := k.PutObject("application/json", []byte("preempt-message-1"))
	if err := k.StageResult("run_preempt_torn", kernel.StagedResult{
		TaskID: "task_1", ObjectHash: message1, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage message 1: %v", err)
	}
	if _, err := k.CompleteStep("run_preempt_torn", "step_1", "", ""); err != nil {
		t.Fatalf("complete step 1: %v", err)
	}

	if _, _, err := k.AcquireLease("run_preempt_torn", "owner_a", 5); err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	message2 := k.PutObject("application/json", []byte("preempt-message-2"))
	if err := k.StageResult("run_preempt_torn", kernel.StagedResult{
		TaskID: "task_2", ObjectHash: message2, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage message 2: %v", err)
	}
	clock.SetMs(100) // expire the lease

	beforeTornHead, ok := k.Backend.GetBranch("branch_preempt_torn")
	if !ok {
		t.Fatalf("branch not found")
	}

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: kernel.FaultPointMidCommit, Policy: kernel.FaultPolicyOnce,
	})
	err = k.PreemptStaleRun("run_preempt_torn", clock.NowMs())
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	tornRun, ok := k.Backend.GetRun("run_preempt_torn")
	if !ok {
		t.Fatalf("run not found")
	}
	if tornRun.Status != kernel.RunStatusRunning {
		t.Fatalf("expected run still running immediately after a torn preemption checkpoint, got %q", tornRun.Status)
	}
	if tornRun.PendingCheckpointHash == "" {
		t.Fatalf("expected a durable pending checkpoint marker after the torn mid-commit fault")
	}
	if tornRun.PendingCheckpointKind != kernel.PendingCheckpointKindPreempt {
		t.Fatalf("expected pending checkpoint kind %q, got %q", kernel.PendingCheckpointKindPreempt, tornRun.PendingCheckpointKind)
	}
	if tornRun.CurrentStepIndex != 1 {
		t.Fatalf("expected CurrentStepIndex still 1 (only step_1) immediately after the torn preemption, got %d", tornRun.CurrentStepIndex)
	}

	// A naive retry before reconciling must be rejected, not mint a second
	// preemption event node.
	err = k.PreemptStaleRun("run_preempt_torn", clock.NowMs())
	requireErrCode(t, err, kernel.ErrRunPendingCheckpoint)

	pendingChildren := k.Backend.ListChildTurnNodes(beforeTornHead.HeadTurnNodeHash)
	if len(pendingChildren) != 1 {
		t.Fatalf("expected exactly one durable pending child turn node after the torn commit and rejected retry, got %d", len(pendingChildren))
	}
	pendingHash := pendingChildren[0].Hash

	if err := k.ReconcileRun("run_preempt_torn"); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	reconciledRun, ok := k.Backend.GetRun("run_preempt_torn")
	if !ok {
		t.Fatalf("run not found after reconcile")
	}
	if reconciledRun.Status != kernel.RunStatusFailed {
		t.Fatalf("expected reconciled run status failed, got %q", reconciledRun.Status)
	}
	if reconciledRun.PreemptionReason != "stale_running_recovery" {
		t.Fatalf("expected reconciled preemption reason stale_running_recovery, got %q", reconciledRun.PreemptionReason)
	}
	if reconciledRun.HasLease {
		t.Fatalf("expected reconciled run's lease cleared")
	}
	if reconciledRun.LeaseOwnerID != "" || reconciledRun.LeaseToken != "" || reconciledRun.LeaseExpiresAtMs != 0 {
		t.Fatalf("expected reconciled run's lease fields fully cleared, got %+v", reconciledRun)
	}
	if reconciledRun.CurrentStepIndex != 1 {
		t.Fatalf("expected reconciled run's CurrentStepIndex to remain 1 (the preemption checkpoint is not a completed step), got %d", reconciledRun.CurrentStepIndex)
	}
	if reconciledRun.PendingCheckpointHash != "" || reconciledRun.PendingCheckpointKind != "" {
		t.Fatalf("expected pending checkpoint marker/kind cleared after reconcile")
	}

	reconciledBranch, ok := k.Backend.GetBranch("branch_preempt_torn")
	if !ok {
		t.Fatalf("branch not found after reconcile")
	}
	if reconciledBranch.HeadTurnNodeHash != pendingHash {
		t.Fatalf("expected reconcile to advance the branch head to the pending node %q, got %q", pendingHash, reconciledBranch.HeadTurnNodeHash)
	}

	// Exactly one event node landed on the lineage past the pre-torn head:
	// the torn commit's own node, never a second one from the rejected
	// retry.
	finalChildren := k.Backend.ListChildTurnNodes(beforeTornHead.HeadTurnNodeHash)
	if len(finalChildren) != 1 {
		t.Fatalf("expected exactly one event node on the lineage after reconcile, got %d", len(finalChildren))
	}

	headNode, ok := k.Backend.GetTurnNode(reconciledBranch.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("head turn node not found")
	}
	if len(headNode.ConsumedStagedResults) != 1 || headNode.ConsumedStagedResults[0].TaskID != "task_2" {
		t.Fatalf("expected the preemption's reactive checkpoint to preserve staged task_2, got %+v", headNode.ConsumedStagedResults)
	}
}

// TestCompleteRun_TornCheckpointReconcilesToCompletedWithSingleEventNode is
// a regression for the P2's CompleteRun-shaped counterpart: a torn
// CompleteRun checkpoint, once reconciled, must finish the run to
// "completed" with CurrentStepIndex == len(StepSequence) — never the
// step-attribution CurrentStepIndex++ bookkeeping ReconcileRun's "step" kind
// uses, which would misattribute the reactive completion checkpoint as an
// ordinary completed step and leave CurrentStepIndex short of the run's
// full declared step count.
func TestCompleteRun_TornCheckpointReconcilesToCompletedWithSingleEventNode(t *testing.T) {
	k, _ := newManualClockKernel(0)
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	created, err := k.CreateThread("thread_complete_torn", "schema_main", "branch_complete_torn")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "step_1", Deterministic: true, SideEffects: false},
		{ID: "step_2", Deterministic: true, SideEffects: false},
		{ID: "step_3", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_complete_torn", "turn_complete_torn", "branch_complete_torn", "schema_main", created.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	message1 := k.PutObject("application/json", []byte("complete-message-1"))
	if err := k.StageResult("run_complete_torn", kernel.StagedResult{
		TaskID: "task_1", ObjectHash: message1, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage message 1: %v", err)
	}
	if _, err := k.CompleteStep("run_complete_torn", "step_1", "", ""); err != nil {
		t.Fatalf("complete step 1: %v", err)
	}

	// Only step_1 of 3 is complete when the caller reactively completes the
	// run early with a second, uncommitted staged result.
	message2 := k.PutObject("application/json", []byte("complete-message-2"))
	if err := k.StageResult("run_complete_torn", kernel.StagedResult{
		TaskID: "task_2", ObjectHash: message2, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		t.Fatalf("stage message 2: %v", err)
	}

	beforeTornHead, ok := k.Backend.GetBranch("branch_complete_torn")
	if !ok {
		t.Fatalf("branch not found")
	}

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{
		Point: kernel.FaultPointMidCommit, Policy: kernel.FaultPolicyOnce,
	})
	err = k.CompleteRun("run_complete_torn", "")
	requireErrCode(t, err, kernel.ErrPersistenceFaultInjected)
	k.Backend = baseBackend

	tornRun, ok := k.Backend.GetRun("run_complete_torn")
	if !ok {
		t.Fatalf("run not found")
	}
	if tornRun.Status != kernel.RunStatusRunning {
		t.Fatalf("expected run still running immediately after a torn completion checkpoint, got %q", tornRun.Status)
	}
	if tornRun.PendingCheckpointKind != kernel.PendingCheckpointKindComplete {
		t.Fatalf("expected pending checkpoint kind %q, got %q", kernel.PendingCheckpointKindComplete, tornRun.PendingCheckpointKind)
	}
	if tornRun.CurrentStepIndex != 1 {
		t.Fatalf("expected CurrentStepIndex still 1 immediately after the torn completion, got %d", tornRun.CurrentStepIndex)
	}

	// A naive retry before reconciling must be rejected, not mint a second
	// completion event node.
	err = k.CompleteRun("run_complete_torn", "")
	requireErrCode(t, err, kernel.ErrRunPendingCheckpoint)

	pendingChildren := k.Backend.ListChildTurnNodes(beforeTornHead.HeadTurnNodeHash)
	if len(pendingChildren) != 1 {
		t.Fatalf("expected exactly one durable pending child turn node after the torn commit and rejected retry, got %d", len(pendingChildren))
	}
	pendingHash := pendingChildren[0].Hash

	if err := k.ReconcileRun("run_complete_torn"); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	reconciledRun, ok := k.Backend.GetRun("run_complete_torn")
	if !ok {
		t.Fatalf("run not found after reconcile")
	}
	if reconciledRun.Status != kernel.RunStatusCompleted {
		t.Fatalf("expected reconciled run status completed, got %q", reconciledRun.Status)
	}
	if reconciledRun.CurrentStepIndex != len(steps) {
		t.Fatalf("expected reconciled run's CurrentStepIndex set to len(StepSequence)=%d, got %d (step-attribution bookkeeping would have produced 2)", len(steps), reconciledRun.CurrentStepIndex)
	}
	if reconciledRun.HasLease {
		t.Fatalf("expected reconciled run's lease cleared")
	}
	if reconciledRun.PendingCheckpointHash != "" || reconciledRun.PendingCheckpointKind != "" {
		t.Fatalf("expected pending checkpoint marker/kind cleared after reconcile")
	}

	reconciledBranch, ok := k.Backend.GetBranch("branch_complete_torn")
	if !ok {
		t.Fatalf("branch not found after reconcile")
	}
	if reconciledBranch.HeadTurnNodeHash != pendingHash {
		t.Fatalf("expected reconcile to advance the branch head to the pending node %q, got %q", pendingHash, reconciledBranch.HeadTurnNodeHash)
	}

	finalChildren := k.Backend.ListChildTurnNodes(beforeTornHead.HeadTurnNodeHash)
	if len(finalChildren) != 1 {
		t.Fatalf("expected exactly one event node on the lineage after reconcile, got %d", len(finalChildren))
	}

	headNode, ok := k.Backend.GetTurnNode(reconciledBranch.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("head turn node not found")
	}
	if len(headNode.ConsumedStagedResults) != 1 || headNode.ConsumedStagedResults[0].TaskID != "task_2" {
		t.Fatalf("expected the completion's reactive checkpoint to preserve staged task_2, got %+v", headNode.ConsumedStagedResults)
	}
}
