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

/// Kernel error codes and the typed exception that carries them, mirroring
/// `go/kernel/errors.go`'s runtime error codes and `go/kernel/validate.go`'s
/// record-validation error codes byte-for-byte. Every `err*` constant below
/// is normative: it is pinned by the M2 conformance plan assertions and (for
/// [errTreeSchemaMismatch]) by `docs/KrakenKernelSpecification.md` §4, so it
/// must match the Go source's string literal exactly, including the
/// intentionally unprefixed outliers called out below.
library;

/// The typed error every kernel-record validation and runtime-protocol
/// failure mode throws. [code] is one of the `err*` string constants below;
/// [message] is a human-readable detail suitable for adapter error
/// envelopes and test failure output. Mirrors `go/kernel/errors.go`'s
/// `KernelError`.
class KernelException implements Exception {
  const KernelException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => '$code: $message';
}

// --- go/kernel/errors.go runtime error codes ---

/// A turn-tree-schema register call declared the same path twice across its
/// path definitions.
const String errDuplicateSchemaPath = 'duplicate_schema_path';

/// A base-less turn tree create call omitted a value for a path the schema
/// declares.
const String errMissingRequiredTreePath =
    'kernel_runtime_missing_required_tree_path';

/// A turn tree modify call's base tree schemaId does not match the
/// schemaId supplied for the modification.
const String errTreeSchemaMismatch = 'kernel_runtime_tree_schema_mismatch';

/// A turn tree diff call's two trees were built from different schemas.
const String errTreeSchemaMismatchDiff =
    'kernel_runtime_tree_schema_mismatch_diff';

/// A branch set-head call tried to move the branch head to a turn node
/// that is not a descendant of the branch's current head (and is not the
/// current head itself).
const String errLateralHeadMovement = 'kernel_runtime_lateral_head_movement';

/// An operation tried to consume or attach a turn node that belongs to a
/// different thread than the one it was invoked against. Intentionally
/// unprefixed to byte-match the conformance plan's expected error code
/// literal.
const String errTurnNodeThreadMismatch = 'turn_node_thread_mismatch';

/// A run create call targeted a branch that already has a running or
/// paused run on it.
const String errBranchAlreadyActive = 'kernel_runtime_branch_already_active';

/// A begin-step or complete-step call named a step that is not the run's
/// next declared step.
const String errUnexpectedStep = 'kernel_runtime_unexpected_step';

/// A step-completion or run-completion call referenced an event object
/// hash that is not present in the object store.
const String errMissingEventObject = 'kernel_runtime_missing_event_object';

/// An operation was invoked against a backend that does not declare the
/// required capability.
const String errCapabilityUnsupported = 'kernel_capability_unsupported';

/// A thread create call minted a genesis turn node hash that already
/// belongs to another thread as its root.
const String errThreadRootNotUnique = 'kernel_runtime_thread_root_not_unique';

/// A forward branch set-head call targeted a branch that has a running or
/// paused run on it.
const String errBranchHasActiveRun = 'kernel_runtime_branch_has_active_run';

/// A run create call's startTurnNodeHash does not match its target
/// branch's current head.
const String errRunBranchHeadMismatch =
    'kernel_runtime_run_branch_head_mismatch';

/// A run create call's declared step sequence repeats the same step id
/// more than once.
const String errDuplicateStepId = 'kernel_runtime_duplicate_step_id';

/// A step-completion call supplied an explicit treeHash that does not
/// exist in the turn tree store.
const String errMissingTree = 'kernel_runtime_missing_tree';

/// A checkpoint tried to incorporate a staged result whose objectType has
/// no incorporation rule in the run's schema.
const String errUnmatchedIncorporationRule =
    'kernel_runtime_unmatched_incorporation_rule';

/// A backward branch set-head call's target turn node is not actually an
/// ancestor of the branch's current head.
const String errBackwardLineageMismatch =
    'kernel_runtime_backward_lineage_mismatch';

/// A lease renewal call named an ownerId that does not match the run's
/// current lease owner. Intentionally unprefixed to byte-match the
/// run-liveness conformance plan's expected error code literal.
const String errRunLeaseOwnerMismatch = 'run_lease_owner_mismatch';

/// A lease renewal call named the correct ownerId but a stale or otherwise
/// mismatched lease token. Intentionally unprefixed to byte-match the
/// run-liveness conformance plan's expected error code literal.
const String errRunLeaseTokenMismatch = 'run_lease_token_mismatch';

/// A lease renewal or preemption call targeted a run that does not
/// currently hold a lease at all.
const String errRunLeaseNotHeld = 'kernel_runtime_run_lease_not_held';

/// A lease renewal call targeted a run whose lease is already expired as
/// of the backend-authoritative clock reading. Intentionally unprefixed to
/// match the `run_lease_*` code family alongside [errRunLeaseOwnerMismatch]
/// / [errRunLeaseTokenMismatch].
const String errRunLeaseExpired = 'run_lease_expired';

/// A stale-preemption call targeted a run that is not both status
/// "running" and lease-expired as of the supplied clock reading.
const String errRunNotPreemptable = 'kernel_runtime_run_not_preemptable';

/// A checkpoint commit's expected base no longer matches the branch's
/// actual current head at commit time -- a second writer already committed
/// a sibling checkpoint from the same base first.
const String errCheckpointLateralConflict =
    'kernel_runtime_checkpoint_lateral_conflict';

/// A `FaultInjectingBackend` fired its configured fault, interrupting an
/// otherwise-successful backend operation to exercise crash-recovery
/// behavior.
const String errPersistenceFaultInjected = 'kernel_persistence_fault_injected';

/// A FaultPlan named a FaultPoint the target FaultInjectingBackend cannot
/// honor.
const String errFaultPointUnsupported = 'kernel_fault_point_unsupported';

/// A run-completion call targeted a run whose status is neither "running"
/// nor "paused" (already "completed" or "failed").
const String errRunNotActive = 'kernel_runtime_run_not_active';

/// A run-completion call targeted a "paused" run but would complete it to
/// a status other than "failed".
const String errInvalidPausedRunCompletion =
    'kernel_runtime_invalid_paused_run_completion';

/// A checkpoint-minting call targeted a run that already has a
/// durably-recorded pending checkpoint (a torn checkpoint) that has not
/// been reconciled yet.
const String errRunPendingCheckpoint = 'kernel_runtime_run_pending_checkpoint';

/// A turn tree create call's changes map declared a path that the target
/// schema does not define.
const String errUnknownTreePath = 'kernel_runtime_unknown_tree_path';

/// A turn tree create call's changes map supplied a value whose shape does
/// not match its path's declared collection kind (an ordered path given a
/// non-array value, or a single path given an array value). Intentionally
/// unprefixed to byte-match the TypeScript reference; Go and Python emit
/// this same unprefixed string.
const String errInvalidPathValueKind = 'invalid_path_value_kind';

/// A durable-read enumeration call (for example thread.list) was given a
/// cursor that fails to decode as a well-formed opaque cursor payload.
const String errInvalidDurableReadCursor = 'invalid_durable_read_cursor';

// --- go/kernel/validate.go record-validation error codes ---

/// A record carried a field name absent from its CDDL grammar's closed-map
/// field set.
const String errUnknownRecordField = 'kernel_record_unknown_field';

/// A record was missing a field its CDDL grammar requires.
const String errMissingRecordField = 'kernel_record_missing_field';

/// A record field's value does not match the shape its CDDL grammar
/// declares.
const String errInvalidRecordField = 'kernel_record_invalid_field';

/// A record field whose CDDL type does not itself include `null` was set
/// to an explicit `null`.
const String errNullNotAllowedField = 'kernel_record_null_not_allowed';
