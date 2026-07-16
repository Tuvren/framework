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

package kernel

import (
	"errors"
	"fmt"
)

// Runtime error codes. These are normative strings pinned by the M2
// conformance plan assertions (and, for kernel_runtime_tree_schema_mismatch,
// by docs/KrakenKernelSpecification.md §4); they must match byte-for-byte
// what the plan and the protocol-edge-validation probes expect.
const (
	// ErrDuplicateSchemaPath: a turn-tree-schema register call declared the
	// same path twice across its path definitions.
	ErrDuplicateSchemaPath = "duplicate_schema_path"

	// ErrMissingRequiredTreePath: a base-less turn tree create call omitted
	// a value for a path the schema declares.
	ErrMissingRequiredTreePath = "kernel_runtime_missing_required_tree_path"

	// ErrTreeSchemaMismatch: a turn tree modify call's base tree schemaId
	// does not match the schemaId supplied for the modification.
	ErrTreeSchemaMismatch = "kernel_runtime_tree_schema_mismatch"

	// ErrTreeSchemaMismatchDiff: a turn tree diff call's two trees were
	// built from different schemas.
	ErrTreeSchemaMismatchDiff = "kernel_runtime_tree_schema_mismatch_diff"

	// ErrLateralHeadMovement: a branch set-head call tried to move the
	// branch head to a turn node that is not a descendant of the branch's
	// current head (and is not the current head itself).
	ErrLateralHeadMovement = "kernel_runtime_lateral_head_movement"

	// ErrTurnNodeThreadMismatch: an operation tried to consume or attach a
	// turn node that belongs to a different thread than the one it was
	// invoked against.
	ErrTurnNodeThreadMismatch = "turn_node_thread_mismatch"

	// ErrBranchAlreadyActive: a run create call targeted a branch that
	// already has a running or paused run on it.
	ErrBranchAlreadyActive = "kernel_runtime_branch_already_active"

	// ErrUnexpectedStep: a begin-step or complete-step call named a step
	// that is not the run's next declared step.
	ErrUnexpectedStep = "kernel_runtime_unexpected_step"

	// ErrMissingEventObject: a step-completion or run-completion call
	// referenced an event object hash that is not present in the object
	// store.
	ErrMissingEventObject = "kernel_runtime_missing_event_object"

	// ErrCapabilityUnsupported: an operation was invoked against a backend
	// that does not declare the required capability.
	ErrCapabilityUnsupported = "kernel_capability_unsupported"

	// ErrThreadRootNotUnique: a thread create call minted a genesis turn
	// node hash that already belongs to another thread as its root. This
	// should be structurally unreachable once genesis turn nodes carry a
	// thread-unique bootstrap eventHash (see CreateThread), but the backend
	// still enforces it defensively, mirroring the TypeScript memory
	// backend's memory_backend_thread_root_not_unique invariant.
	ErrThreadRootNotUnique = "kernel_runtime_thread_root_not_unique"

	// ErrBranchHasActiveRun: a forward branch set-head call targeted a
	// branch that has a running or paused run on it. Unlike
	// ErrBranchAlreadyActive (run.create's guard), this fires on an
	// explicit external head movement, not run creation.
	ErrBranchHasActiveRun = "kernel_runtime_branch_has_active_run"

	// ErrRunBranchHeadMismatch: a run create call's startTurnNodeHash does
	// not match its target branch's current head.
	ErrRunBranchHeadMismatch = "kernel_runtime_run_branch_head_mismatch"

	// ErrDuplicateStepID: a run create call's declared step sequence
	// repeats the same step id more than once.
	ErrDuplicateStepID = "kernel_runtime_duplicate_step_id"

	// ErrMissingTree: a step-completion call supplied an explicit treeHash
	// that does not exist in the turn tree store.
	ErrMissingTree = "kernel_runtime_missing_tree"

	// ErrUnmatchedIncorporationRule: a checkpoint tried to incorporate a
	// staged result whose objectType has no incorporation rule in the run's
	// schema.
	ErrUnmatchedIncorporationRule = "kernel_runtime_unmatched_incorporation_rule"

	// ErrBackwardLineageMismatch: a backward branch set-head call's target
	// turn node is not actually an ancestor of the branch's current head
	// (should not occur given SetBranchHead classifies direction first, but
	// the archival-segment walk still guards against a race or a corrupted
	// chain).
	ErrBackwardLineageMismatch = "kernel_runtime_backward_lineage_mismatch"

	// ErrRunLeaseOwnerMismatch: a lease renewal call named an ownerId that
	// does not match the run's current lease owner (kernel spec §5.2 Run
	// Execution Leases). Unprefixed to byte-match the run-liveness
	// conformance plan's expected error code literal.
	ErrRunLeaseOwnerMismatch = "run_lease_owner_mismatch"

	// ErrRunLeaseTokenMismatch: a lease renewal call named the correct
	// ownerId but a stale or otherwise mismatched lease token. Unprefixed to
	// byte-match the run-liveness conformance plan's expected error code
	// literal.
	ErrRunLeaseTokenMismatch = "run_lease_token_mismatch"

	// ErrRunLeaseNotHeld: a lease renewal or preemption call targeted a run
	// that does not currently hold a lease at all (never acquired one, or
	// already preempted/released).
	ErrRunLeaseNotHeld = "kernel_runtime_run_lease_not_held"

	// ErrRunNotPreemptable: a stale-preemption call targeted a run that is
	// not both status "running" and lease-expired as of the supplied clock
	// reading.
	ErrRunNotPreemptable = "kernel_runtime_run_not_preemptable"

	// ErrCheckpointLateralConflict: a checkpoint commit's expected base
	// (the turn node its writer believed was the branch's current head) no
	// longer matches the branch's actual current head at commit time — a
	// second writer already committed a sibling checkpoint from the same
	// base first. This is the kernel's single-writer-per-checkpoint
	// enforcement (kernel spec §5 recovery protocol): the loser must get a
	// typed, distinguishable rejection rather than a generic failure.
	ErrCheckpointLateralConflict = "kernel_runtime_checkpoint_lateral_conflict"

	// ErrPersistenceFaultInjected: a FaultInjectingBackend fired its
	// configured fault, interrupting an otherwise-successful backend
	// operation to exercise crash-recovery behavior (docs/
	// KrakenKernelSpecification.md §5). Mirrors the TypeScript kernel
	// testkit's kernel_persistence_fault_injected code byte-for-byte.
	ErrPersistenceFaultInjected = "kernel_persistence_fault_injected"

	// ErrFaultPointUnsupported: a FaultPlan named a FaultPoint the target
	// FaultInjectingBackend cannot honor.
	ErrFaultPointUnsupported = "kernel_fault_point_unsupported"

	// ErrRunNotActive: a run-completion call targeted a run whose status is
	// neither "running" nor "paused" (already "completed" or "failed").
	// Mirrors the TypeScript reference's kernel_runtime_run_not_active
	// (typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts's complete
	// path) byte-for-byte.
	ErrRunNotActive = "kernel_runtime_run_not_active"

	// ErrInvalidPausedRunCompletion: a run-completion call targeted a
	// "paused" run but would complete it to a status other than "failed" —
	// a paused run's owner deliberately relinquished active execution, so
	// resuming it only ever ends in an explicit failure, never a normal
	// completion. Mirrors the TypeScript reference's
	// kernel_runtime_invalid_paused_run_completion (runtime-kernel-runs.ts's
	// complete path) byte-for-byte.
	ErrInvalidPausedRunCompletion = "kernel_runtime_invalid_paused_run_completion"

	// ErrInvalidDurableReadCursor: a durable-read enumeration call (for
	// example thread.list) was given a cursor that fails to decode as a
	// well-formed opaque cursor payload. Matches the TypeScript reference
	// (typescript/runtime/src/lib/durable-reads.ts,
	// typescript/kernel/runtime/src/lib/runtime-kernel.ts) and the other
	// ports' invalid_durable_read_cursor byte-for-byte.
	ErrInvalidDurableReadCursor = "invalid_durable_read_cursor"
)

// KernelError is the typed error every kernel-runtime operation returns for
// a recognized failure mode. Code is one of the Err* constants above (or a
// record-validation code from validate.go); Message is a human-readable
// detail suitable for adapter error envelopes and test failure output.
type KernelError struct {
	Code    string
	Message string
}

func (e *KernelError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func newKernelError(code, format string, args ...any) *KernelError {
	return &KernelError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsKernelError extracts a *KernelError from err, if err is (or wraps) one.
func AsKernelError(err error) (*KernelError, bool) {
	var kerr *KernelError
	if errors.As(err, &kerr) {
		return kerr, true
	}
	return nil, false
}
