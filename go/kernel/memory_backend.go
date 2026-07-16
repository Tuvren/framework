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

import "sync"

// scopeState is everything InMemoryBackend used to hold directly: one
// Scope's independent, mutex-guarded partition of durable storage. Moving
// this into its own type is what lets MemoryScopeStore hold many
// partitions (one per Scope) behind one shared substrate, so two backend
// handles bound to different Scopes but the same store are structurally
// unable to observe each other's content (kernel spec §2.3 / M4
// kernel.scope-isolation), while two handles bound to the *same* Scope and
// store share that Scope's committed state.
type scopeState struct {
	mu sync.Mutex

	objects  map[string]StoredObject
	schemas  map[string]TurnTreeSchema
	trees    map[string]TurnTree
	nodes    map[string]TurnNode
	threads  map[string]Thread
	branches map[string]Branch
	runs     map[string]Run

	// rootOwners indexes thread-root turn node hash -> owning threadId, so
	// PutThread can populate it and Kernel.CreateThread can consult
	// GetThreadByRootTurnNode before publishing a thread whose genesis node
	// hash was already claimed.
	rootOwners map[string]string

	// childrenByPrevious indexes a turn node's PreviousTurnNodeHash -> the
	// hashes of every node stored with that previous hash, so
	// ListChildTurnNodes can find a durable node forward from its parent
	// even when no branch head references it yet. A raw inspection seam
	// for tests only — Kernel.ReconcileRun (recovery.go) reconciles from
	// the owning run's own PendingCheckpointHash instead.
	childrenByPrevious map[string][]string

	stagedByRun map[string][]StagedResult
}

func newScopeState() *scopeState {
	return &scopeState{
		objects:            make(map[string]StoredObject),
		schemas:            make(map[string]TurnTreeSchema),
		trees:              make(map[string]TurnTree),
		nodes:              make(map[string]TurnNode),
		threads:            make(map[string]Thread),
		branches:           make(map[string]Branch),
		runs:               make(map[string]Run),
		rootOwners:         make(map[string]string),
		childrenByPrevious: make(map[string][]string),
		stagedByRun:        make(map[string][]StagedResult),
	}
}

// MemoryScopeStore is a shared in-memory substrate keyed by Scope: each
// Scope owns an independent scopeState, created lazily on first use.
// Constructing several InMemoryBackend handles against one shared
// MemoryScopeStore with different scope strings gives each handle a
// structurally isolated partition (mirroring
// typescript/kernel/backends/memory's MemoryScopeStore, scoped down to
// this Go port's synchronous, single-process API — there is no
// per-Scope transaction queue to serialize here, since InMemoryBackend has
// no multi-call transaction boundary of its own).
type MemoryScopeStore struct {
	mu     sync.Mutex
	states map[string]*scopeState
}

// NewMemoryScopeStore constructs an empty shared substrate with no Scopes
// yet materialized.
func NewMemoryScopeStore() *MemoryScopeStore {
	return &MemoryScopeStore{states: make(map[string]*scopeState)}
}

// state returns scope's partition, creating an empty one on first use.
func (s *MemoryScopeStore) state(scope string) *scopeState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[scope]
	if !ok {
		st = newScopeState()
		s.states[scope] = st
	}
	return st
}

// InMemoryBackend is the M2 in-memory Backend implementation: a handle
// bound to one Scope's partition of a MemoryScopeStore. There is no
// persistence and no cross-process sharing; it exists to give Kernel a
// concrete storage implementation to run the M2 syscall surface against,
// matching the scope of typescript/kernel's in-memory backend and
// rust/kernel's memory module.
type InMemoryBackend struct {
	clock Clock
	store *MemoryScopeStore
	scope string
}

// defaultScope is the Scope an InMemoryBackend constructed via
// NewInMemoryBackend binds to: single-Scope callers (every M2/M3 caller,
// and every M4 caller that does not need cross-scope isolation) never see
// or reason about Scope identity at all.
const defaultScope = "tuvren.scope.default"

// NewInMemoryBackend constructs an empty in-memory backend, bound to its
// own private single-Scope store, using clock for every timestamp it
// records.
func NewInMemoryBackend(clock Clock) *InMemoryBackend {
	if clock == nil {
		clock = SystemClock{}
	}
	return &InMemoryBackend{clock: clock, store: NewMemoryScopeStore(), scope: defaultScope}
}

// NewScopedInMemoryBackend binds a backend handle to scope within store, a
// MemoryScopeStore possibly shared with other handles bound to other
// scopes. Two handles constructed this way against the same store but
// different scope strings are isolated by construction (kernel spec §2.3):
// neither can observe the other's objects, trees, nodes, schemas, threads,
// branches, runs, or staged results. Two handles bound to the same store
// and the same scope share that Scope's committed state.
func NewScopedInMemoryBackend(clock Clock, store *MemoryScopeStore, scope string) *InMemoryBackend {
	if clock == nil {
		clock = SystemClock{}
	}
	return &InMemoryBackend{clock: clock, store: store, scope: scope}
}

// state returns this backend's own Scope partition.
func (b *InMemoryBackend) state() *scopeState { return b.store.state(b.scope) }

func (b *InMemoryBackend) Clock() Clock { return b.clock }

func (b *InMemoryBackend) PutObject(mediaType string, data []byte) StoredObject {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()

	hash := HashBytesToHex(data)
	if existing, ok := st.objects[hash]; ok {
		return existing
	}
	stored := StoredObject{
		Hash:        hash,
		MediaType:   mediaType,
		Bytes:       append([]byte(nil), data...),
		CreatedAtMs: b.clock.NowMs(),
	}
	st.objects[hash] = stored
	return stored
}

func (b *InMemoryBackend) GetObject(hash string) (StoredObject, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	obj, ok := st.objects[hash]
	return obj, ok
}

func (b *InMemoryBackend) HasObject(hash string) bool {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	_, ok := st.objects[hash]
	return ok
}

func (b *InMemoryBackend) PutSchema(schema TurnTreeSchema) bool {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, exists := st.schemas[schema.SchemaID]; exists {
		return false
	}
	st.schemas[schema.SchemaID] = schema
	return true
}

func (b *InMemoryBackend) GetSchema(schemaID string) (TurnTreeSchema, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	schema, ok := st.schemas[schemaID]
	return schema, ok
}

func (b *InMemoryBackend) PutTurnTree(tree TurnTree) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	tree.CreatedAtMs = b.clock.NowMs()
	st.trees[tree.Hash] = tree
}

func (b *InMemoryBackend) GetTurnTree(hash string) (TurnTree, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	tree, ok := st.trees[hash]
	if !ok {
		return TurnTree{}, false
	}
	return cloneTurnTree(tree), true
}

// cloneTurnTree returns a deep-enough copy of tree that a caller mutating
// the returned Manifest map (or any ordered PathValue's backing slice
// within it) cannot corrupt the backend's stored state.
func cloneTurnTree(tree TurnTree) TurnTree {
	manifest := make(map[string]PathValue, len(tree.Manifest))
	for path, value := range tree.Manifest {
		if value.Kind == PathValueOrderedKind {
			ordered := make([]string, len(value.Ordered))
			copy(ordered, value.Ordered)
			value.Ordered = ordered
		}
		manifest[path] = value
	}
	tree.Manifest = manifest
	return tree
}

func (b *InMemoryBackend) PutTurnNode(node TurnNode) error {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	node.CreatedAtMs = b.clock.NowMs()
	st.nodes[node.Hash] = cloneTurnNode(node)
	st.childrenByPrevious[node.PreviousTurnNodeHash] = append(st.childrenByPrevious[node.PreviousTurnNodeHash], node.Hash)
	return nil
}

func (b *InMemoryBackend) ListChildTurnNodes(previousHash string) []TurnNode {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	hashes := st.childrenByPrevious[previousHash]
	out := make([]TurnNode, 0, len(hashes))
	for _, hash := range hashes {
		if node, ok := st.nodes[hash]; ok {
			out = append(out, cloneTurnNode(node))
		}
	}
	return out
}

func (b *InMemoryBackend) GetTurnNode(hash string) (TurnNode, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	node, ok := st.nodes[hash]
	if !ok {
		return TurnNode{}, false
	}
	return cloneTurnNode(node), true
}

// cloneTurnNode returns a copy of node whose ConsumedStagedResults slice is
// independent storage: a caller mutating a returned node's slice (append,
// index-assign) cannot corrupt the backend's stored state, and mutating a
// node passed into PutTurnNode after the call cannot retroactively corrupt
// it either.
func cloneTurnNode(node TurnNode) TurnNode {
	consumed := make([]StagedResult, len(node.ConsumedStagedResults))
	copy(consumed, node.ConsumedStagedResults)
	node.ConsumedStagedResults = consumed
	return node
}

func (b *InMemoryBackend) PutThread(thread Thread) bool {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, exists := st.threads[thread.ThreadID]; exists {
		return false
	}
	st.threads[thread.ThreadID] = thread
	st.rootOwners[thread.RootTurnNodeHash] = thread.ThreadID
	return true
}

func (b *InMemoryBackend) GetThread(threadID string) (Thread, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	thread, ok := st.threads[threadID]
	return thread, ok
}

func (b *InMemoryBackend) GetThreadByRootTurnNode(rootTurnNodeHash string) (string, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	threadID, ok := st.rootOwners[rootTurnNodeHash]
	return threadID, ok
}

func (b *InMemoryBackend) ListThreads() []Thread {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]Thread, 0, len(st.threads))
	for _, thread := range st.threads {
		out = append(out, thread)
	}
	return out
}

func (b *InMemoryBackend) PutBranch(branch Branch) bool {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, exists := st.branches[branch.BranchID]; exists {
		return false
	}
	st.branches[branch.BranchID] = branch
	return true
}

func (b *InMemoryBackend) GetBranch(branchID string) (Branch, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	branch, ok := st.branches[branchID]
	return branch, ok
}

func (b *InMemoryBackend) ListBranchesByThread(threadID string) []Branch {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	var out []Branch
	for _, branch := range st.branches {
		if branch.ThreadID == threadID {
			out = append(out, branch)
		}
	}
	return out
}

func (b *InMemoryBackend) UpdateBranchHead(branchID, headTurnNodeHash string, updatedAtMs int64) (bool, error) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	branch, ok := st.branches[branchID]
	if !ok {
		return false, nil
	}
	branch.HeadTurnNodeHash = headTurnNodeHash
	branch.UpdatedAtMs = updatedAtMs
	st.branches[branchID] = branch
	return true, nil
}

func (b *InMemoryBackend) CompareAndSwapBranchHead(branchID, expectedHead, newHead string, updatedAtMs int64) (bool, error) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	branch, ok := st.branches[branchID]
	if !ok {
		return false, nil
	}
	if branch.HeadTurnNodeHash != expectedHead {
		return false, nil
	}
	branch.HeadTurnNodeHash = newHead
	branch.UpdatedAtMs = updatedAtMs
	st.branches[branchID] = branch
	return true, nil
}

func (b *InMemoryBackend) PutRun(run Run) bool {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, exists := st.runs[run.RunID]; exists {
		return false
	}
	now := b.clock.NowMs()
	run.CreatedAtMs = now
	run.UpdatedAtMs = now
	st.runs[run.RunID] = run
	return true
}

// cloneRun returns a copy of run whose StepSequence and CreatedTurnNodes
// slices are independent storage: a caller mutating a returned run's
// slices cannot corrupt the backend's stored state.
func cloneRun(run Run) Run {
	steps := make([]StepDeclaration, len(run.StepSequence))
	copy(steps, run.StepSequence)
	run.StepSequence = steps

	created := make([]string, len(run.CreatedTurnNodes))
	copy(created, run.CreatedTurnNodes)
	run.CreatedTurnNodes = created

	return run
}

func (b *InMemoryBackend) GetRun(runID string) (Run, bool) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	run, ok := st.runs[runID]
	if !ok {
		return Run{}, false
	}
	return cloneRun(run), true
}

func (b *InMemoryBackend) UpdateRun(run Run) bool {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	existing, exists := st.runs[run.RunID]
	if !exists {
		return false
	}
	run.CreatedAtMs = existing.CreatedAtMs
	run.UpdatedAtMs = b.clock.NowMs()
	st.runs[run.RunID] = run
	return true
}

func (b *InMemoryBackend) ListRunsByBranch(branchID string) []Run {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	var out []Run
	for _, run := range st.runs {
		if run.BranchID == branchID {
			out = append(out, cloneRun(run))
		}
	}
	return out
}

func (b *InMemoryBackend) ListRuns() []Run {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]Run, 0, len(st.runs))
	for _, run := range st.runs {
		out = append(out, cloneRun(run))
	}
	return out
}

func (b *InMemoryBackend) StageResult(runID string, result StagedResult) {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	st.stagedByRun[runID] = append(st.stagedByRun[runID], result)
}

func (b *InMemoryBackend) DrainStagedResults(runID string) []StagedResult {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()
	drained := st.stagedByRun[runID]
	delete(st.stagedByRun, runID)
	return drained
}

var _ Backend = (*InMemoryBackend)(nil)
