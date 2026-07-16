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

// This file defines the M2 runtime kernel's shared vocabulary: the Clock
// seam, the storage-shaped structs the Backend interface (backend.go)
// exchanges with the Kernel host (kernel_runtime.go), and the record
// conversions those structs need for content-addressed identity hashing.
// The split mirrors the TypeScript kernel port's decomposition
// (typescript/kernel/protocol's RuntimeBackend seam vs.
// typescript/kernel/runtime's RuntimeKernel host) rather than the Rust
// port's monolithic in-memory kernel: storage concerns live behind Backend,
// and structural/lineage/execution semantics live in Kernel.
package kernel

import "time"

// Clock supplies the current time in epoch milliseconds. It is injected at
// Kernel/Backend construction so later milestones (leases, reclamation,
// time-based recovery windows) can substitute deterministic clocks in
// tests without the runtime kernel depending on wall-clock time directly.
type Clock interface {
	NowMs() int64
}

// SystemClock is the production Clock: wall-clock time via time.Now.
type SystemClock struct{}

func (SystemClock) NowMs() int64 { return time.Now().UnixMilli() }

// FixedClock is a test Clock that always returns the same instant.
type FixedClock struct{ Ms int64 }

func (c FixedClock) NowMs() int64 { return c.Ms }

// IncrementingClock is a test Clock that advances by one millisecond on
// every call, so callers that need strictly-increasing timestamps (for
// example to exercise createdAtMs-ordered enumeration without relying on
// wall-clock granularity) get a deterministic, monotonically increasing
// sequence starting at Ms.
type IncrementingClock struct{ Ms int64 }

func (c *IncrementingClock) NowMs() int64 {
	c.Ms++
	return c.Ms
}

// ManualClock is a test Clock a caller advances explicitly via SetMs,
// letting a scenario pin exact timestamps (for example a lease's acquire and
// renew instants) instead of relying on wall-clock or auto-increment
// behavior. Not safe for concurrent use — conformance operations that need
// it build a fresh one per dispatch call like every other test seam here.
type ManualClock struct{ ms int64 }

// NewManualClock constructs a ManualClock starting at startMs.
func NewManualClock(startMs int64) *ManualClock { return &ManualClock{ms: startMs} }

func (c *ManualClock) NowMs() int64 { return c.ms }

// SetMs advances (or otherwise sets) the clock's current reading.
func (c *ManualClock) SetMs(ms int64) { c.ms = ms }

// RunStatus mirrors the CDDL run-status enum.
type RunStatus string

const (
	RunStatusRunning   RunStatus = "running"
	RunStatusPaused    RunStatus = "paused"
	RunStatusCompleted RunStatus = "completed"
	RunStatusFailed    RunStatus = "failed"
)

// StoredObject is the in-memory content-addressed object store's stored
// shape (spec/kernel/cddl/kernel-records.cddl's stored-object, minus the
// scope/backend-specific columns this Go port doesn't need yet).
type StoredObject struct {
	Hash        string
	MediaType   string
	Bytes       []byte
	CreatedAtMs int64
}

// TurnTree is the runtime kernel's in-memory turn tree: a schema-bound
// manifest addressed by its own identity hash.
type TurnTree struct {
	Hash     string
	SchemaID string
	Manifest map[string]PathValue

	// CreatedAtMs is backend bookkeeping only (not part of the CDDL
	// turn-tree identity shape, and excluded from turnTreeIdentityRecord):
	// reclamation's grace window (kernel spec §9.4) needs it to decide
	// whether a turn tree is new enough to be held regardless of
	// reachability.
	CreatedAtMs int64
}

// TurnNode is the runtime kernel's in-memory turn node. Because a turn
// node's hash is purely content-addressed (spec/kernel/cddl/kernel-records.cddl's
// turn-node carries no threadId field), a genesis (root) turn node must
// carry something thread-unique in its own identity fields, or two threads
// created on the same schema would mint byte-identical root nodes.
// CreateThread satisfies this by minting a backend-owned bootstrap object
// encoding the thread id and pinning it as the root node's EventHash (kernel
// spec §3.3), so every thread's genesis node hash is unique by
// construction. Thread ownership of a turn node is therefore never tracked
// as separate backend state: it is answered by walking a node's
// PreviousTurnNodeHash chain back to a thread's (now provably unique) root
// hash — see Kernel.turnNodeBelongsToThread — exactly the "which thread
// does this node belong to" answer the turn_node_thread_mismatch guard
// needs.
type TurnNode struct {
	Hash                  string
	SchemaID              string
	TurnTreeHash          string
	PreviousTurnNodeHash  string // "" means null (root node)
	EventHash             string // "" means null
	ConsumedStagedResults []StagedResult

	// CreatedAtMs is backend bookkeeping only (not part of the CDDL
	// turn-node identity shape, and excluded from turnNodeIdentityRecord):
	// reclamation's grace window (kernel spec §9.4) needs it to decide
	// whether a turn node is new enough to be held regardless of
	// reachability.
	CreatedAtMs int64
}

// Thread is the runtime kernel's in-memory thread record.
type Thread struct {
	ThreadID         string
	SchemaID         string
	RootTurnNodeHash string
	CreatedAtMs      int64
}

// Branch is the runtime kernel's in-memory branch record.
type Branch struct {
	BranchID         string
	ThreadID         string
	HeadTurnNodeHash string
	CreatedAtMs      int64
	UpdatedAtMs      int64
	// ArchivedFromBranchID is non-empty when this branch is an archive
	// branch a backward SetBranchHead rollback minted to preserve an
	// abandoned head lineage (kernel spec §4.2). "" means this is an
	// ordinary, non-archive branch.
	ArchivedFromBranchID string
}

// PendingCheckpointKind identifies which checkpoint-minting entry point a
// run's PendingCheckpointHash marker belongs to, so ReconcileRun
// (recovery.go) knows what "folding the pending node in" must finish as
// once a torn checkpoint is repaired: a plain step advance, or a terminal
// transition (completed / failed-by-preemption) that must not be
// misattributed as an ordinary completed step. Mirrors the Python port's
// equivalent pending-checkpoint kind discriminator.
type PendingCheckpointKind string

const (
	// PendingCheckpointKindStep: the pending checkpoint is an ordinary
	// CompleteStep advance. ReconcileRun's fold-in behavior for this kind
	// is unchanged from before this discriminator existed: append the
	// pending node, advance CurrentStepIndex by one (capped at
	// len(StepSequence)).
	PendingCheckpointKindStep PendingCheckpointKind = "step"

	// PendingCheckpointKindComplete: the pending checkpoint is CompleteRun's
	// reactive checkpoint. ReconcileRun's fold-in finishes the run to
	// "completed" with CurrentStepIndex set to len(StepSequence) (not
	// incremented) and the lease cleared — the same end state a non-torn
	// CompleteRun call would have produced.
	PendingCheckpointKindComplete PendingCheckpointKind = "complete"

	// PendingCheckpointKindPreempt: the pending checkpoint is
	// PreemptStaleRun's reactive checkpoint. ReconcileRun's fold-in
	// finishes the run to "failed" with PreemptionReason
	// "stale_running_recovery", CurrentStepIndex left untouched (a
	// preemption is never a completed step), and the lease cleared — the
	// same end state a non-torn PreemptStaleRun call would have produced.
	PendingCheckpointKindPreempt PendingCheckpointKind = "preempt"
)

// Run is the runtime kernel's in-memory run record. ThreadID is Kernel
// bookkeeping (resolved from the run's branch at creation time), not a
// CDDL run-record field; it is kept for diagnostic/debugging convenience so
// a run's thread is visible without an extra branch lookup.
type Run struct {
	RunID             string
	TurnID            string
	BranchID          string
	SchemaID          string
	StartTurnNodeHash string
	Status            RunStatus
	CurrentStepIndex  int
	StepSequence      []StepDeclaration
	CreatedTurnNodes  []string
	ThreadID          string

	// PendingCheckpointHash is the durable turn node hash a checkpoint
	// commit in progress is about to (or already did) move the branch
	// head to. Kernel.checkpointRun writes this to the run record
	// immediately after the checkpoint's turn node itself becomes durable
	// (PutTurnNode succeeds) but before attempting the branch-head move,
	// so a torn checkpoint (FaultPointMidCommit) or an
	// after-commit-before-ack interruption both leave a durable pointer
	// straight at the pending node on the run that owns it. ReconcileRun
	// (recovery.go) reconciles from this field rather than rediscovering
	// the pending node by listing a shared turn node's children, which
	// cannot distinguish this run's own pending commit from an unrelated
	// sibling node written by a different run or branch sharing the same
	// base head. Cleared back to "" once the checkpoint's own commit (or
	// a later ReconcileRun) has folded the pending node into
	// CreatedTurnNodes.
	PendingCheckpointHash string

	// PendingCheckpointKind identifies which checkpoint-minting entry
	// point PendingCheckpointHash belongs to (see PendingCheckpointKind).
	// "" whenever PendingCheckpointHash is "" — the two fields are always
	// set and cleared together.
	PendingCheckpointKind PendingCheckpointKind

	// --- run execution lease (kernel spec §5.2 Run Execution Leases,
	// ADR-050: backend-authoritative clock, lease tokens, renewal, expiry,
	// preemption; capability kernel.run-liveness) ---

	HasLease         bool
	LeaseOwnerID     string
	LeaseToken       string
	LeaseExpiresAtMs int64

	// PreemptionReason is set when a stale-preemption call fails this run
	// (kernel.run-liveness.stale-preemption); "" otherwise.
	PreemptionReason string

	// CreatedAtMs / UpdatedAtMs are backend bookkeeping: reclamation's
	// grace horizon (kernel spec §9.4) is the oldest active (running or
	// paused) run's CreatedAtMs, and a leaseless running run stops pinning
	// that horizon once nowMs - UpdatedAtMs crosses the 24h admin-expiry
	// window (ADR-050/ADR-051).
	CreatedAtMs int64
	UpdatedAtMs int64
}

// ThreadCreateResult mirrors the CDDL thread-create-result record.
type ThreadCreateResult struct {
	BranchID         string
	RootTurnNodeHash string
	RootTurnTreeHash string
	ThreadID         string
}

// RecoveryState mirrors the CDDL recovery-state record.
type RecoveryState struct {
	LastTurnNodeHash         string
	LastCompletedStepID      string
	HasLastCompletedStepID   bool
	StepSequence             []StepDeclaration
	ConsumedStagedResults    []StagedResult
	UncommittedStagedResults []StagedResult
}

// --- record conversions used for content-addressed identity hashing ---

func pathValueToRecord(value PathValue) Record {
	switch value.Kind {
	case PathValueSingleKind:
		return RecordText(value.Single)
	case PathValueOrderedKind:
		elements := make(RecordArray, 0, len(value.Ordered))
		for _, hash := range value.Ordered {
			elements = append(elements, RecordText(hash))
		}
		return elements
	default:
		return RecordNull{}
	}
}

func manifestToRecord(manifest map[string]PathValue) RecordMap {
	out := make(RecordMap, len(manifest))
	for path, value := range manifest {
		out[path] = pathValueToRecord(value)
	}
	return out
}

// turnTreeIdentityRecord builds the record hashed to produce a turn tree's
// content-addressed hash: SHA-256 of the canonical CBOR encoding of
// {manifest, schemaId} (kernel spec §2.3 / §3.2 identity rule).
func turnTreeIdentityRecord(schemaID string, manifest map[string]PathValue) RecordMap {
	return RecordMap{
		"manifest": manifestToRecord(manifest),
		"schemaId": RecordText(schemaID),
	}
}

// stagedResultToRecord projects a StagedResult onto the fields the CDDL
// staged-result union declares: interruptPayload is present iff the status
// is "interrupted".
func stagedResultToRecord(result StagedResult) RecordMap {
	out := RecordMap{
		"taskId":     RecordText(result.TaskID),
		"objectHash": RecordText(result.ObjectHash),
		"objectType": RecordText(result.ObjectType),
		"timestamp":  RecordInt(result.Timestamp),
		"status":     RecordText(string(result.Status)),
	}
	if result.Status == StagedResultInterrupted {
		payload := result.InterruptPayload
		if payload == nil {
			payload = RecordNull{}
		}
		out["interruptPayload"] = payload
	}
	return out
}

func nullableHashRecord(hash string) Record {
	if hash == "" {
		return RecordNull{}
	}
	return RecordText(hash)
}

// turnNodeIdentityRecord builds the record hashed to produce a turn node's
// content-addressed hash: SHA-256 of the canonical CBOR encoding of
// {consumedStagedResults, eventHash, previousTurnNodeHash, schemaId,
// turnTreeHash} (kernel spec §2.3 / §3.3 identity rule). The ThreadID
// bookkeeping field is intentionally excluded: it is not part of the CDDL
// turn-node identity shape.
func turnNodeIdentityRecord(node TurnNode) RecordMap {
	consumed := make(RecordArray, 0, len(node.ConsumedStagedResults))
	for _, result := range node.ConsumedStagedResults {
		consumed = append(consumed, stagedResultToRecord(result))
	}
	return RecordMap{
		"consumedStagedResults": consumed,
		"eventHash":             nullableHashRecord(node.EventHash),
		"previousTurnNodeHash":  nullableHashRecord(node.PreviousTurnNodeHash),
		"schemaId":              RecordText(node.SchemaID),
		"turnTreeHash":          RecordText(node.TurnTreeHash),
	}
}
