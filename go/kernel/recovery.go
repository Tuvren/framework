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
// CreatedTurnNodes, advances CurrentStepIndex by one (capped at
// len(StepSequence)), clears PendingCheckpointHash, and persists the
// result. A no-op (returns nil without writing) when the run has no
// pending checkpoint and the branch head already matches the run's active
// turn node — the common case, since only a fault-interrupted checkpoint
// ever leaves them disagreeing in the first place.
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
		if branch.HeadTurnNodeHash == pendingHash {
			run.CreatedTurnNodes = append(run.CreatedTurnNodes, pendingHash)
			run.CurrentStepIndex++
			if run.CurrentStepIndex > len(run.StepSequence) {
				run.CurrentStepIndex = len(run.StepSequence)
			}
			run.PendingCheckpointHash = ""
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
