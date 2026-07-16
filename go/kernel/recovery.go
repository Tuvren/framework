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

	// A torn checkpoint (FaultPointMidCommit) leaves a turn node durably
	// written but the branch head never moved to it, so the branch head
	// still equals the run's active turn node even though a pending
	// commit exists past it. Roll forward through any such pending
	// children (by construction there is at most one per run, since
	// nothing else observes success until the head itself moves) before
	// falling back to the ordinary "nothing to reconcile" no-op.
	pendingCursor := activeHash
	var pendingChain []string
	for depth := 0; depth < maxLineageWalkDepth; depth++ {
		children := k.Backend.ListChildTurnNodes(pendingCursor)
		if len(children) != 1 {
			break
		}
		pendingChain = append(pendingChain, children[0].Hash)
		pendingCursor = children[0].Hash
	}
	if len(pendingChain) > 0 {
		swapped, err := k.Backend.CompareAndSwapBranchHead(run.BranchID, branch.HeadTurnNodeHash, pendingCursor, k.Clock.NowMs())
		if err != nil {
			return err
		}
		if swapped {
			run.CreatedTurnNodes = append(run.CreatedTurnNodes, pendingChain...)
			run.CurrentStepIndex += len(pendingChain)
			if run.CurrentStepIndex > len(run.StepSequence) {
				run.CurrentStepIndex = len(run.StepSequence)
			}
			k.Backend.UpdateRun(run)
			return nil
		}
		// Lost the CAS to a concurrent reconcile/retry: fall through and
		// re-read branch state below via the ordinary backward walk.
		branch, ok = k.Backend.GetBranch(run.BranchID)
		if !ok {
			return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", run.BranchID)
		}
	}

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
