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

import "fmt"

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
	kerr, ok := err.(*KernelError)
	return kerr, ok
}
