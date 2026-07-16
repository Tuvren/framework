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

// This file implements the M3 restart-recovery capability's reconciliation
// step (docs/KrakenKernelSpecification.md §5 recovery protocol) and the
// single-writer checkpoint-commit primitive concurrent checkpoint attempts
// use to detect a lateral conflict.
package kernel

// ReconcileRun repairs runID's in-memory run record forward when a
// checkpoint's durable writes (PutTurnNode, UpdateBranchHead) already
// succeeded but the caller that attempted the checkpoint never got to
// persist the run record's own advance — the observable aftermath of a
// FaultPointMidCommit or FaultPointAfterCommitBeforeAck fault (see
// fault_injecting_backend.go and Kernel.CompleteStep's error-handling
// comment). It reconciles from the run's own durably-recorded
// PendingCheckpointHash (Kernel.checkpointRun, kernel_runtime.go) — the
// exact node hash that checkpoint attempt was committing — rather than
// rediscovering a pending node by structure, since structural discovery
// (for example listing every child of the run's previously-active turn
// node) cannot distinguish this run's own pending commit from an unrelated
// sibling node a different run or branch wrote against the same base head.
// When a pending checkpoint is found, it appends the pending node hash to
// CreatedTurnNodes and finishes the transition per the marker's
// PendingCheckpointKind (Kernel.checkpointRun, kernel_runtime.go /
// runtime.go): PendingCheckpointKindStep advances CurrentStepIndex by one
// (capped at len(StepSequence), the historical behavior);
// PendingCheckpointKindComplete finishes the run to "completed" with
// CurrentStepIndex set to len(StepSequence) and the lease cleared;
// PendingCheckpointKindPreempt finishes the run to "failed" with
// preemptionReason "stale_running_recovery" and the lease cleared, without
// bumping CurrentStepIndex. Either way PendingCheckpointHash/Kind are
// cleared and the result persisted. This is also what makes
// Kernel.checkpointRun's own ErrRunPendingCheckpoint refusal meaningful
// rather than a permanent dead end: a caller that hits it must call
// ReconcileRun exactly once to fold the torn commit in, and can then retry
// (or move on) normally. A no-op (returns nil without writing) when the run
// has no pending checkpoint and the branch head already matches the run's
// active turn node — the common case, since only a fault-interrupted
// checkpoint ever leaves them disagreeing in the first place.
func (k *Kernel) ReconcileRun(runID string) error {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	branch, ok := k.Backend.GetBranch(run.BranchID)
	if !ok {
		return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", run.BranchID)
	}

	activeHash := k.activeTurnNodeHash(run)

	if run.PendingCheckpointHash != "" {
		pendingHash := run.PendingCheckpointHash
		pendingNode, ok := k.Backend.GetTurnNode(pendingHash)
		if !ok {
			return newKernelError("kernel_runtime_turn_node_not_found", "run %q's pending checkpoint turn node %q not found", runID, pendingHash)
		}

		if branch.HeadTurnNodeHash != pendingHash {
			// Genuine torn checkpoint (FaultPointMidCommit): the pending
			// node is durable, but the head move never happened. Move it
			// now, CAS'd from exactly the head the pending node was
			// minted against — never a blind unconditional write — so a
			// concurrent reconcile/retry racing this one is still safe.
			swapped, err := k.Backend.CompareAndSwapBranchHead(run.BranchID, pendingNode.PreviousTurnNodeHash, pendingHash, k.Clock.NowMs())
			if err != nil {
				return err
			}
			if swapped {
				branch.HeadTurnNodeHash = pendingHash
			} else {
				branch, ok = k.Backend.GetBranch(run.BranchID)
				if !ok {
					return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", run.BranchID)
				}
			}
		}

		// Either the head move above just succeeded, or
		// FaultPointAfterCommitBeforeAck already advanced it before this
		// call ever ran (both durable writes had already succeeded when
		// that fault fired) — in both cases the head is now genuinely at
		// the pending node, and the run's own bookkeeping can fold it in.
		// What "folding it in" finishes as depends on which
		// checkpoint-minting entry point the pending marker came from
		// (run.PendingCheckpointKind): a torn-then-reconciled transition
		// must end in exactly the state a non-torn one would have produced,
		// with exactly one event node on the lineage — never a second
		// checkpoint minted by a later retry of the same call, and never a
		// terminal (preempt/complete) node misattributed as a completed
		// step.
		if branch.HeadTurnNodeHash == pendingHash {
			run.CreatedTurnNodes = append(run.CreatedTurnNodes, pendingHash)
			switch run.PendingCheckpointKind {
			case PendingCheckpointKindComplete:
				// Mirrors CompleteRun's own non-torn success path: finish to
				// "completed" with CurrentStepIndex set (not incremented) to
				// len(StepSequence) and the lease cleared. No step-attribution
				// bookkeeping — a reactive completion checkpoint is not a
				// declared step.
				run.Status = RunStatusCompleted
				run.CurrentStepIndex = len(run.StepSequence)
				run.HasLease = false
				run.LeaseOwnerID = ""
				run.LeaseToken = ""
				run.LeaseExpiresAtMs = 0
			case PendingCheckpointKindPreempt:
				// Mirrors PreemptStaleRun's own non-torn success path:
				// finish to "failed" with the stale-preemption reason and
				// the lease cleared, WITHOUT bumping CurrentStepIndex — a
				// preemption's reactive checkpoint is not a completed step
				// either.
				run.Status = RunStatusFailed
				run.PreemptionReason = "stale_running_recovery"
				run.HasLease = false
				run.LeaseOwnerID = ""
				run.LeaseToken = ""
				run.LeaseExpiresAtMs = 0
			default:
				// PendingCheckpointKindStep (or, defensively, an unset/
				// unrecognized kind): today's ordinary step-advance
				// behavior.
				run.CurrentStepIndex++
				if run.CurrentStepIndex > len(run.StepSequence) {
					run.CurrentStepIndex = len(run.StepSequence)
				}
			}
			run.PendingCheckpointHash = ""
			run.PendingCheckpointKind = ""
			k.Backend.UpdateRun(run)
			return nil
		}
		// The branch head is neither the run's active node nor its
		// pending node (some other reconciliation path already moved it
		// past the pending node): fall through to the ordinary backward
		// walk below, which repairs from wherever the head actually is.
	}

	if branch.HeadTurnNodeHash == activeHash {
		return nil
	}

	// Invariant: the head-to-active backward walk below only ever
	// reconstructs *this* run's own missed checkpoint nodes when run is
	// still "running". The single-active-run-per-branch invariant
	// (activeRunOnBranch, kernel_runtime.go) guarantees that whenever a
	// run is "running" it is the only run on its branch that could have
	// checkpointed since its active turn node, so every node between the
	// branch head and that active node is provably this run's own. A
	// "completed" or "failed" run's active turn node, by contrast, is a
	// fixed point in that branch's history: the head is free to move past
	// it once a later run starts and checkpoints on the same branch, and
	// reconciling the older, terminal run must never misattribute that
	// later run's nodes to it. So a terminal run here means the branch
	// simply moved on without it — leave it untouched.
	if run.Status != RunStatusRunning {
		return nil
	}

	var chain []string
	cursor := branch.HeadTurnNodeHash
	for depth := 0; depth < maxLineageWalkDepth; depth++ {
		if cursor == activeHash {
			break
		}
		node, ok := k.Backend.GetTurnNode(cursor)
		if !ok {
			return newKernelError("kernel_runtime_turn_node_not_found", "turn node %q not found while reconciling run %q", cursor, runID)
		}
		chain = append(chain, cursor)
		if node.PreviousTurnNodeHash == "" {
			return newKernelError(ErrBackwardLineageMismatch, "run %q's active turn node %q is not an ancestor of branch %q's head %q", runID, activeHash, run.BranchID, branch.HeadTurnNodeHash)
		}
		cursor = node.PreviousTurnNodeHash
	}

	// chain was collected head-to-active; reverse it to active-to-head
	// (commit order) before appending.
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	run.CreatedTurnNodes = append(run.CreatedTurnNodes, chain...)
	run.CurrentStepIndex += len(chain)
	if run.CurrentStepIndex > len(run.StepSequence) {
		run.CurrentStepIndex = len(run.StepSequence)
	}
	k.Backend.UpdateRun(run)
	return nil
}

// CommitSiblingCheckpoint appends node (whose PreviousTurnNodeHash must
// already be set to expectedHead) onto branchID as a checkpoint, but only
// if branchID's current head still equals expectedHead at commit time —
// the kernel's single-writer-per-checkpoint compare-and-swap. When a second
// writer's CommitSiblingCheckpoint call loses this race (the branch head
// already moved because a first writer's call won), it is rejected with
// ErrCheckpointLateralConflict rather than silently overwriting or
// stacking behind the winner. On success, node.Hash is computed (must be
// the empty string on input — this function mints it), the node is
// persisted, and the branch head advances to it.
func (k *Kernel) CommitSiblingCheckpoint(branchID, expectedHead string, node TurnNode) (string, error) {
	branch, ok := k.Backend.GetBranch(branchID)
	if !ok {
		return "", newKernelError("kernel_runtime_branch_not_found", "branch %q not found", branchID)
	}
	if branch.HeadTurnNodeHash != expectedHead {
		return "", newKernelError(ErrCheckpointLateralConflict, "branch %q's head is %q, not the expected base %q: a concurrent checkpoint already committed", branchID, branch.HeadTurnNodeHash, expectedHead)
	}

	node.PreviousTurnNodeHash = expectedHead
	hash, err := HashRecord(turnNodeIdentityRecord(node))
	if err != nil {
		return "", err
	}
	node.Hash = hash

	if err := k.Backend.PutTurnNode(node); err != nil {
		return "", err
	}

	// Move the head atomically: CompareAndSwapBranchHead only succeeds if
	// branchID's head still equals expectedHead at the moment of the
	// write, closing the read/write race window a
	// GetBranch-then-UpdateBranchHead pair would otherwise leave open
	// between this call's initial read above and its own write.
	swapped, err := k.Backend.CompareAndSwapBranchHead(branchID, expectedHead, hash, k.Clock.NowMs())
	if err != nil {
		return hash, err
	}
	if !swapped {
		return "", newKernelError(ErrCheckpointLateralConflict, "branch %q's head is no longer %q: a concurrent checkpoint already committed", branchID, expectedHead)
	}
	return hash, nil
}
