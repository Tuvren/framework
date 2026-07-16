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

// Backend is the runtime kernel's storage seam: pure content-addressed and
// keyed storage, with no structural, lineage, or execution semantics of its
// own. Kernel (kernel_runtime.go) is the only caller; it is the layer that
// enforces schema/tree/thread/branch/run semantics and raises the
// kernel_runtime_* errors. This mirrors the TypeScript kernel port's
// RuntimeBackend/RuntimeKernel split, scoped down to exactly what M2 needs.
//
// A Backend is constructed already bound to one scope; nothing in this
// interface takes a scope parameter. InMemoryBackend (memory_backend.go) is
// the only implementation this milestone ships, but the seam exists so a
// persistent backend can be added later without changing Kernel.
type Backend interface {
	// --- object store ---

	PutObject(mediaType string, data []byte) StoredObject
	GetObject(hash string) (StoredObject, bool)
	HasObject(hash string) bool

	// --- schema registry ---

	PutSchema(schema TurnTreeSchema) bool // false if schemaId already registered
	GetSchema(schemaID string) (TurnTreeSchema, bool)

	// --- turn trees ---

	// PutTurnTree stores tree, keyed by its own content-addressed Hash.
	// GetTurnTree returns a defensive copy: mutating the returned value's
	// Manifest (or any ordered PathValue within it) never affects the
	// stored state.
	PutTurnTree(tree TurnTree)
	GetTurnTree(hash string) (TurnTree, bool)

	// --- turn nodes ---

	// PutTurnNode stores node, keyed by its own content-addressed Hash, and
	// reports an error if the durable write could not be performed. A
	// returned error means the write did not happen — nothing about node is
	// visible to a later GetTurnNode call (this is the "before-commit" fault
	// point a FaultInjectingBackend targets: see fault_injecting_backend.go).
	// GetTurnNode returns a defensive copy: mutating the returned value
	// (including its ConsumedStagedResults slice) never affects the stored
	// state.
	PutTurnNode(node TurnNode) error
	GetTurnNode(hash string) (TurnNode, bool)

	// --- threads ---

	// PutThread stores thread, keyed by its ThreadID; false if threadId
	// already exists. Also records thread.RootTurnNodeHash as owned by
	// thread.ThreadID in the root-ownership index GetThreadByRootTurnNode
	// reads, so a later thread create that would mint a genesis node
	// already claimed by another thread can be rejected before it is ever
	// published (see Kernel.CreateThread's ErrThreadRootNotUnique guard).
	PutThread(thread Thread) bool
	GetThread(threadID string) (Thread, bool)
	// GetThreadByRootTurnNode returns the threadId that owns
	// rootTurnNodeHash as its thread root, if any thread has claimed it via
	// PutThread.
	GetThreadByRootTurnNode(rootTurnNodeHash string) (threadID string, ok bool)
	ListThreads() []Thread // unsorted; Kernel imposes deterministic order and paging

	// --- branches ---

	PutBranch(branch Branch) bool // false if branchId already exists
	GetBranch(branchID string) (Branch, bool)
	ListBranchesByThread(threadID string) []Branch
	// UpdateBranchHead moves branchID's head to headTurnNodeHash. The bool
	// result reports whether branchID exists (false otherwise, with no
	// error); the error result reports a durable-write failure on an
	// existing branch — the point a FaultInjectingBackend's "mid-commit"
	// fault point targets. Implementations that inject a "mid-commit" fault
	// still perform the write (the head does move) before returning the
	// error, modeling a crash that lands after the durable write completes
	// but before the caller is acknowledged success.
	UpdateBranchHead(branchID, headTurnNodeHash string, updatedAtMs int64) (bool, error)

	// --- runs ---

	PutRun(run Run) bool // false if runId already exists
	GetRun(runID string) (Run, bool)
	UpdateRun(run Run) bool
	ListRunsByBranch(branchID string) []Run
	// ListRuns returns every run this backend holds, unsorted; Kernel
	// imposes deterministic order where it matters (run-liveness expiry
	// listing).
	ListRuns() []Run

	// --- staged results ---

	// StageResult appends result to runID's uncommitted staging pool.
	StageResult(runID string, result StagedResult)
	// DrainStagedResults atomically returns and empties runID's uncommitted
	// staging pool: the runtime kernel calls this exactly once per step
	// completion, so "consumed at this checkpoint" is always "everything
	// staged since the previous checkpoint."
	DrainStagedResults(runID string) []StagedResult

	Clock() Clock
}
