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

// This file wires the M3 kernel.run-liveness and kernel.restart-recovery
// operations into the adapter's dispatch table. Every handler builds its
// own fresh in-memory Kernel per dispatch call (and, where noted, a fresh
// Kernel per fault point within one dispatch call), matching every other
// operation in this adapter's per-check isolation.
package main

import (
	"encoding/json"
	"fmt"

	kernel "github.com/tuvren/framework/go/kernel"
)

// newManualClockRuntimeKernel builds a fresh Kernel over a fresh
// InMemoryBackend driven by a kernel.ManualClock pinned at startMs, so a
// run-liveness or restart-recovery scenario can advance the
// backend-authoritative clock to exact instants (kernel spec §5.2 ADR-050)
// instead of relying on wall-clock or auto-increment timing.
func newManualClockRuntimeKernel(startMs int64) (*kernel.Kernel, *kernel.ManualClock) {
	clock := kernel.NewManualClock(startMs)
	backend := kernel.NewInMemoryBackend(clock)
	return kernel.NewKernel("kernel-conformance-adapter", clock, backend), clock
}

const onlyStepID = "only_step"

func singleStepSequence() []kernel.StepDeclaration {
	return []kernel.StepDeclaration{{ID: onlyStepID, Deterministic: true, SideEffects: false}}
}

// codeOf reports the error code of err ("unexpected_success" if nil,
// "internal_error" if err is not a *kernel.KernelError), mirroring
// captureCode's convention in operations_runtime.go for calls that must run
// inline (not through a probe closure) because their success value is also
// needed.
func codeOf(err error) string {
	if err == nil {
		return "unexpected_success"
	}
	if kerr, ok := kernel.AsKernelError(err); ok {
		return kerr.Code
	}
	return "internal_error"
}

// --- kernel.run-liveness.lease-renewal ---

func runLeaseRenewal(json.RawMessage) operationOutcome {
	k, clock := newManualClockRuntimeKernel(10)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}
	created, err := k.CreateThread("thread_lease_renewal", "schema_main", "branch_lease_renewal")
	if err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.CreateRun("run_lease_renewal", "turn_lease_renewal", "branch_lease_renewal", "schema_main", created.RootTurnNodeHash, singleStepSequence()); err != nil {
		return errorOutcomeFor(err)
	}

	// Acquire at t=10, ttl=20 -> initial expiry 30.
	token, _, err := k.AcquireLease("run_lease_renewal", "owner_a", 20)
	if err != nil {
		return errorOutcomeFor(err)
	}

	// Renew at t=20, ttl=20 -> renewed expiry 40.
	clock.SetMs(20)
	renewedExpiresAtMs, err := k.RenewLease("run_lease_renewal", "owner_a", token, 20)
	if err != nil {
		return errorOutcomeFor(err)
	}

	_, ownerMismatchErr := k.RenewLease("run_lease_renewal", "owner_b", token, 20)
	ownerMismatchCode := codeOf(ownerMismatchErr)

	_, staleTokenErr := k.RenewLease("run_lease_renewal", "owner_a", "not-the-real-token", 20)
	staleTokenCode := codeOf(staleTokenErr)

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"renewal": map[string]any{
			"renewedLeaseExpiresAtMs": renewedExpiresAtMs,
			"ownerMismatchCode":       ownerMismatchCode,
			"staleTokenCode":          staleTokenCode,
		},
	})}
}

// --- kernel.run-liveness.expired-listing ---

func runExpiredListing(json.RawMessage) operationOutcome {
	k, clock := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}

	createdExpired, err := k.CreateThread("thread_run_expired", "schema_main", "branch_run_expired")
	if err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.CreateRun("run_expired", "turn_run_expired", "branch_run_expired", "schema_main", createdExpired.RootTurnNodeHash, singleStepSequence()); err != nil {
		return errorOutcomeFor(err)
	}
	if _, _, err := k.AcquireLease("run_expired", "owner_a", 5); err != nil {
		return errorOutcomeFor(err)
	}

	createdPaused, err := k.CreateThread("thread_run_paused", "schema_main", "branch_run_paused")
	if err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.CreateRun("run_paused", "turn_run_paused", "branch_run_paused", "schema_main", createdPaused.RootTurnNodeHash, singleStepSequence()); err != nil {
		return errorOutcomeFor(err)
	}
	if _, _, err := k.AcquireLease("run_paused", "owner_b", 5); err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.PauseRun("run_paused"); err != nil {
		return errorOutcomeFor(err)
	}

	clock.SetMs(100) // both ttl=5 leases acquired at t=0 are long expired

	expiredRunIDs := k.ListExpiredRuns(clock.NowMs())

	pausedRun, ok := k.Backend.GetRun("run_paused")
	if !ok {
		return errorOutcomeFor(fmt.Errorf("run_paused not found after listing"))
	}
	pausedRunListed := false
	for _, id := range expiredRunIDs {
		if id == "run_paused" {
			pausedRunListed = true
		}
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"listing": map[string]any{
			"expiredRunIds":   expiredRunIDs,
			"pausedRunStatus": string(pausedRun.Status),
			"pausedRunListed": pausedRunListed,
		},
	})}
}

// --- kernel.run-liveness.stale-preemption ---

func runStalePreemption(json.RawMessage) operationOutcome {
	k, clock := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}
	created, err := k.CreateThread("thread_run_stale", "schema_main", "branch_run_stale")
	if err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.CreateRun("run_stale", "turn_run_stale", "branch_run_stale", "schema_main", created.RootTurnNodeHash, singleStepSequence()); err != nil {
		return errorOutcomeFor(err)
	}
	if _, _, err := k.AcquireLease("run_stale", "owner_a", 5); err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.StageResult("run_stale", kernel.StagedResult{
		TaskID: "task_uncommitted", ObjectHash: kernel.HashBytesToHex([]byte("staged-before-preemption")),
		ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		return errorOutcomeFor(err)
	}

	clock.SetMs(100)
	if err := k.PreemptStaleRun("run_stale", clock.NowMs()); err != nil {
		return errorOutcomeFor(err)
	}

	run, ok := k.Backend.GetRun("run_stale")
	if !ok {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("kernel_runtime_run_not_found", "run_stale not found after preemption")}
	}
	branch, ok := k.Backend.GetBranch("branch_run_stale")
	if !ok {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("kernel_runtime_branch_not_found", "branch_run_stale not found after preemption")}
	}
	state, err := k.RecoveryState("run_stale")
	if err != nil {
		return errorOutcomeFor(err)
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"preemption": map[string]any{
			"branchHeadTurnNodeHash":        branch.HeadTurnNodeHash,
			"runStatus":                     string(run.Status),
			"preemptionReason":              run.PreemptionReason,
			"recoveryLastTurnNodeHash":      state.LastTurnNodeHash,
			"recoveryHeadMatchesBranchHead": state.LastTurnNodeHash == branch.HeadTurnNodeHash,
			"uncommittedStagedResults":      len(state.UncommittedStagedResults),
			"leaseCleared":                  !run.HasLease,
		},
	})}
}

// --- crash-recovery fault-point scenario shared by both restart-recovery
// operations below ---

// crashRecoveryFixture is one fully-built two-step run, checkpointed once
// (message_1 committed) with a second message (message_2) staged but not
// yet checkpointed — the common baseline every fault-point observation
// below faults a second, independent copy of.
type crashRecoveryFixture struct {
	k            *kernel.Kernel
	runID        string
	branchID     string
	message2Hash string
	baseHead     string // branch head immediately after message_1's checkpoint
}

func buildCrashRecoveryFixture() (*crashRecoveryFixture, error) {
	k, _ := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return nil, err
	}
	created, err := k.CreateThread("thread_crash_recovery", "schema_main", "branch_crash_recovery")
	if err != nil {
		return nil, err
	}
	steps := []kernel.StepDeclaration{
		{ID: "step_1", Deterministic: true, SideEffects: false},
		{ID: "step_2", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_crash_recovery", "turn_crash_recovery", "branch_crash_recovery", "schema_main", created.RootTurnNodeHash, steps); err != nil {
		return nil, err
	}

	message1Hash := k.PutObject("application/json", []byte("message-1"))
	if err := k.StageResult("run_crash_recovery", kernel.StagedResult{
		TaskID: "task_1", ObjectHash: message1Hash, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		return nil, err
	}
	if _, err := k.CompleteStep("run_crash_recovery", "step_1", "", ""); err != nil {
		return nil, err
	}

	branch, ok := k.Backend.GetBranch("branch_crash_recovery")
	if !ok {
		return nil, fmt.Errorf("branch_crash_recovery not found after checkpoint")
	}

	message2Hash := k.PutObject("application/json", []byte("message-2"))
	if err := k.StageResult("run_crash_recovery", kernel.StagedResult{
		TaskID: "task_2", ObjectHash: message2Hash, ObjectType: "message", Status: kernel.StagedResultCompleted,
	}); err != nil {
		return nil, err
	}

	return &crashRecoveryFixture{
		k:            k,
		runID:        "run_crash_recovery",
		branchID:     "branch_crash_recovery",
		message2Hash: message2Hash,
		baseHead:     branch.HeadTurnNodeHash,
	}, nil
}

// lineageIsConsistent walks head's PreviousTurnNodeHash chain backward,
// bounded, confirming every hash along the way resolves to a stored turn
// node (a broken or dangling link would mean the checkpoint commit left a
// half-written chain).
func lineageIsConsistent(k *kernel.Kernel, head string) bool {
	cursor := head
	for depth := 0; depth < 10_000; depth++ {
		node, ok := k.Backend.GetTurnNode(cursor)
		if !ok {
			return false
		}
		if node.PreviousTurnNodeHash == "" {
			return true
		}
		cursor = node.PreviousTurnNodeHash
	}
	return false
}

func messageCountAt(k *kernel.Kernel, head string) int {
	node, ok := k.Backend.GetTurnNode(head)
	if !ok {
		return 0
	}
	tree, ok := k.Backend.GetTurnTree(node.TurnTreeHash)
	if !ok {
		return 0
	}
	return len(tree.Manifest["messages"].Ordered)
}

func messageIsCommittedAt(k *kernel.Kernel, head, messageHash string) bool {
	node, ok := k.Backend.GetTurnNode(head)
	if !ok {
		return false
	}
	tree, ok := k.Backend.GetTurnTree(node.TurnTreeHash)
	if !ok {
		return false
	}
	for _, hash := range tree.Manifest["messages"].Ordered {
		if hash == messageHash {
			return true
		}
	}
	return false
}

// observeFaultPoint runs one fresh crashRecoveryFixture's second checkpoint
// (step_2, committing message_2) through a FaultInjectingBackend configured
// for point, and reports the atomicity contract's five observable outcomes
// (docs/KrakenKernelSpecification.md §5): whether the branch head lands
// where recovery expects, whether the turn node chain is unbroken, whether
// the staged message ended up durably committed, whether recovery state is
// self-consistent after reconciliation, and how many messages are visible
// in the committed tree.
func observeFaultPoint(point kernel.FaultPoint) (map[string]any, error) {
	fixture, err := buildCrashRecoveryFixture()
	if err != nil {
		return nil, err
	}
	k := fixture.k

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{Point: point, Policy: kernel.FaultPolicyOnce})
	_, stepErr := k.CompleteStep(fixture.runID, "step_2", "", "")
	k.Backend = baseBackend

	// expectedHead is captured independently of whatever the backend
	// reports afterward, so the comparison below is a genuine check
	// (headMatchesExpectedCheckpoint can actually be false if recovery
	// misbehaves) rather than comparing a value against itself.
	var expectedHead string
	if point == kernel.FaultPointBeforeCommit {
		// Nothing durable changed: the branch head must still be exactly
		// where message_1's checkpoint left it — fixture.baseHead, captured
		// when the fixture was built, before this fault-point attempt ever
		// ran.
		expectedHead = fixture.baseHead
	} else {
		// mid-commit leaves a durable turn node whose branch head move
		// never happened (a genuine torn checkpoint); after-commit-before-ack
		// fully commits including the head move despite reporting failure.
		// Either way, the durable turn node the torn checkpoint wrote is
		// the true expected outcome (kernel spec §5.5: "TurnNode exists →
		// checkpoint succeeded"). Read the run's own durably-recorded
		// PendingCheckpointHash (kernel_runtime.go's checkpointRun,
		// persisted before the branch-head move is even attempted) as
		// expectedHead *before* reconciling — that is the pending sibling
		// node hash the torn checkpoint durably wrote, independent of
		// whatever ReconcileRun does next.
		run, ok := k.Backend.GetRun(fixture.runID)
		if !ok {
			return nil, fmt.Errorf("run %q not found after fault-point %q attempt", fixture.runID, point)
		}
		if run.PendingCheckpointHash == "" {
			return nil, fmt.Errorf("run %q has no durably-recorded pending checkpoint after fault-point %q attempt", fixture.runID, point)
		}
		expectedHead = run.PendingCheckpointHash

		if err := k.ReconcileRun(fixture.runID); err != nil {
			return nil, err
		}
	}

	// actualHead is re-read from the backend after the fault attempt (and,
	// for mid-commit/after-commit-before-ack, after reconciliation) — the
	// genuinely-recovered state, not a value derived from expectedHead
	// itself.
	branch, ok := k.Backend.GetBranch(fixture.branchID)
	if !ok {
		return nil, fmt.Errorf("branch %q not found after fault-point %q attempt", fixture.branchID, point)
	}
	actualHead := branch.HeadTurnNodeHash

	state, stateErr := k.RecoveryState(fixture.runID)
	recoveryStateConsistent := stateErr == nil && state.LastTurnNodeHash == actualHead

	return map[string]any{
		"injectedErrorCode":             codeOf(stepErr),
		"headMatchesExpectedCheckpoint": actualHead == expectedHead,
		"lineageConsistent":             lineageIsConsistent(k, actualHead),
		"pendingMessageCommitted":       messageIsCommittedAt(k, actualHead, fixture.message2Hash),
		"recoveryStateConsistent":       recoveryStateConsistent,
		"visibleCommittedMessageCount":  messageCountAt(k, actualHead),
	}, nil
}

// --- kernel.restart-recovery.crash-recovery-in-process ---

func runCrashRecoveryInProcess(json.RawMessage) operationOutcome {
	beforeCommit, err := observeFaultPoint(kernel.FaultPointBeforeCommit)
	if err != nil {
		return errorOutcomeFor(err)
	}
	midCommit, err := observeFaultPoint(kernel.FaultPointMidCommit)
	if err != nil {
		return errorOutcomeFor(err)
	}
	afterCommitBeforeAck, err := observeFaultPoint(kernel.FaultPointAfterCommitBeforeAck)
	if err != nil {
		return errorOutcomeFor(err)
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"crashRecovery": map[string]any{
			"beforeCommit":         beforeCommit,
			"midCommit":            midCommit,
			"afterCommitBeforeAck": afterCommitBeforeAck,
		},
	})}
}

// --- kernel.restart-recovery.concurrent-writer ---

func runConcurrentWriter(json.RawMessage) operationOutcome {
	concurrency, err := observeConcurrentWriterCAS()
	if err != nil {
		return errorOutcomeFor(err)
	}
	faultPlan, err := observeConcurrentWriterFaultPlan()
	if err != nil {
		return errorOutcomeFor(err)
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"crashRecoveryConcurrency":  concurrency,
		"faultPlanConcurrentWriter": faultPlan,
	})}
}

// observeConcurrentWriterCAS races two independent writers' checkpoints
// from the same base turn node using Kernel.CommitSiblingCheckpoint's
// compare-and-swap: the first commit wins outright, the second is rejected
// with the typed lateral-conflict error, and a retry rebased onto the
// winner's head succeeds.
func observeConcurrentWriterCAS() (map[string]any, error) {
	k, _ := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return nil, err
	}
	created, err := k.CreateThread("thread_concurrent_writer", "schema_main", "branch_concurrent_writer")
	if err != nil {
		return nil, err
	}
	base := created.RootTurnNodeHash

	eventA := k.PutObject("application/json", []byte("writer-a"))
	nodeA := kernel.TurnNode{SchemaID: "schema_main", TurnTreeHash: created.RootTurnTreeHash, EventHash: eventA}
	winnerHash, err := k.CommitSiblingCheckpoint("branch_concurrent_writer", base, nodeA)
	if err != nil {
		return nil, err
	}

	eventB := k.PutObject("application/json", []byte("writer-b"))
	nodeB := kernel.TurnNode{SchemaID: "schema_main", TurnTreeHash: created.RootTurnTreeHash, EventHash: eventB}
	_, lossErr := k.CommitSiblingCheckpoint("branch_concurrent_writer", base, nodeB)
	losingErrorCode := codeOf(lossErr)

	// Read the final state produced by the race itself — winner committed,
	// loser rejected — before the loser's rebased retry does anything
	// further to the branch head. This is what "final head matches winner"
	// and "final head is a committed sibling of base" actually mean: the
	// outcome of the CAS race, not whatever the head happens to be after a
	// later, unrelated retry commit.
	branchAfterRace, ok := k.Backend.GetBranch("branch_concurrent_writer")
	if !ok {
		return nil, fmt.Errorf("branch_concurrent_writer not found after CAS scenario")
	}
	winnerNode, ok := k.Backend.GetTurnNode(winnerHash)
	if !ok {
		return nil, fmt.Errorf("winner turn node %q not found after CAS scenario", winnerHash)
	}
	finalHeadMatchesWinner := branchAfterRace.HeadTurnNodeHash == winnerHash
	finalHeadIsCommittedSibling := winnerNode.PreviousTurnNodeHash == base

	// The loser retries rebased onto the winner's head, and succeeds. This
	// exercises the rebase path but must not be read back into the
	// race-outcome fields above.
	nodeBRetry := kernel.TurnNode{SchemaID: "schema_main", TurnTreeHash: created.RootTurnTreeHash, EventHash: eventB}
	_, retryErr := k.CommitSiblingCheckpoint("branch_concurrent_writer", winnerHash, nodeBRetry)
	retryAfterLossErrorCode := codeOf(retryErr)

	return map[string]any{
		"singleWriterRejected":         lossErr != nil,
		"finalHeadIsCommittedSibling":  finalHeadIsCommittedSibling,
		"finalHeadMatchesWinner":       finalHeadMatchesWinner,
		"losingErrorCode":              losingErrorCode,
		"retryAfterLossErrorCode":      retryAfterLossErrorCode,
		"typedLateralConflictObserved": losingErrorCode == kernel.ErrCheckpointLateralConflict,
	}, nil
}

// observeConcurrentWriterFaultPlan runs a single writer's checkpoint
// through a "mid-commit" FaultInjectingBackend: the writer's durable turn
// node write lands, but the branch head is deliberately left un-advanced
// (a genuine torn checkpoint — see fault_injecting_backend.go), even
// though the writer itself observes kernel_persistence_fault_injected.
// Recovery (Kernel.ReconcileRun) then rolls that pending node forward: per
// kernel spec §5.5 ("TurnNode exists → checkpoint succeeded"), the durable
// write is the true outcome, so this operation reconciles before reading
// back state — the branch head does end up advanced to a sibling of the
// pre-attempt head, just via an explicit recovery step rather than
// silently within the faulted call itself.
func observeConcurrentWriterFaultPlan() (map[string]any, error) {
	fixture, err := buildCrashRecoveryFixture()
	if err != nil {
		return nil, err
	}
	k := fixture.k
	baseHeadBeforeAttempt := fixture.baseHead

	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{Point: kernel.FaultPointMidCommit, Policy: kernel.FaultPolicyOnce})
	_, stepErr := k.CompleteStep(fixture.runID, "step_2", "", "")
	k.Backend = baseBackend

	if err := k.ReconcileRun(fixture.runID); err != nil {
		return nil, err
	}

	branch, ok := k.Backend.GetBranch(fixture.branchID)
	if !ok {
		return nil, fmt.Errorf("branch_crash_recovery not found after fault-plan concurrent-writer attempt")
	}
	writerAdvancedHead := branch.HeadTurnNodeHash != baseHeadBeforeAttempt

	writerProducedSiblingHead := false
	if node, ok := k.Backend.GetTurnNode(branch.HeadTurnNodeHash); ok {
		writerProducedSiblingHead = node.PreviousTurnNodeHash == baseHeadBeforeAttempt
	}

	return map[string]any{
		"injectedErrorCode":         codeOf(stepErr),
		"writerAdvancedHead":        writerAdvancedHead,
		"writerProducedSiblingHead": writerProducedSiblingHead,
	}, nil
}
