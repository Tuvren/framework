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
