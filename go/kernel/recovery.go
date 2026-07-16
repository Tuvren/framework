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
// comment). It walks runID's branch head backward until it reaches the
// run's currently-recorded active turn node, appends every hash discovered
// along the way to CreatedTurnNodes (in commit order), advances
// CurrentStepIndex by that many steps (capped at len(StepSequence)), and
// persists the result. A no-op (returns nil without writing) when the
// branch head already matches the run's active turn node — the common
// case, since only a fault-interrupted checkpoint ever leaves them
// disagreeing in the first place.
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
	if branch.HeadTurnNodeHash == activeHash {
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

	// Re-check immediately before the head move: this narrows, but does not
	// eliminate, the race window between the read above and this write. A
	// production backend closes it with a real compare-and-swap primitive
	// (or a serializable transaction); this in-memory Go port's Backend
	// interface has no such primitive yet, so this is the best available
	// approximation for now — see the M3 report's friction notes.
	branch, ok = k.Backend.GetBranch(branchID)
	if !ok {
		return "", newKernelError("kernel_runtime_branch_not_found", "branch %q not found", branchID)
	}
	if branch.HeadTurnNodeHash != expectedHead {
		return "", newKernelError(ErrCheckpointLateralConflict, "branch %q's head is %q, not the expected base %q: a concurrent checkpoint already committed", branchID, branch.HeadTurnNodeHash, expectedHead)
	}

	if _, err := k.Backend.UpdateBranchHead(branchID, hash, k.Clock.NowMs()); err != nil {
		return hash, err
	}
	return hash, nil
}
