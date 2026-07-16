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
