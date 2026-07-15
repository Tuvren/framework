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

// InMemoryBackend is the M2 in-memory Backend implementation: everything
// lives in Go maps guarded by a single mutex. There is no persistence and
// no cross-process sharing; it exists to give Kernel a concrete storage
// implementation to run the M2 syscall surface against, matching the scope
// of typescript/kernel's in-memory backend and rust/kernel's memory module.
type InMemoryBackend struct {
	mu sync.Mutex

	clock Clock

	objects     map[string]StoredObject
	schemas     map[string]TurnTreeSchema
	trees       map[string]TurnTree
	nodes       map[string]TurnNode
	nodeThreads map[string]map[string]bool
	threads     map[string]Thread
	branches    map[string]Branch
	runs        map[string]Run

	stagedByRun map[string][]StagedResult
}

// NewInMemoryBackend constructs an empty in-memory backend using clock for
// every timestamp it records.
func NewInMemoryBackend(clock Clock) *InMemoryBackend {
	if clock == nil {
		clock = SystemClock{}
	}
	return &InMemoryBackend{
		clock:       clock,
		objects:     make(map[string]StoredObject),
		schemas:     make(map[string]TurnTreeSchema),
		trees:       make(map[string]TurnTree),
		nodes:       make(map[string]TurnNode),
		nodeThreads: make(map[string]map[string]bool),
		threads:     make(map[string]Thread),
		branches:    make(map[string]Branch),
		runs:        make(map[string]Run),
		stagedByRun: make(map[string][]StagedResult),
	}
}

func (b *InMemoryBackend) Clock() Clock { return b.clock }

func (b *InMemoryBackend) PutObject(mediaType string, data []byte) StoredObject {
	b.mu.Lock()
	defer b.mu.Unlock()

	hash := HashBytesToHex(data)
	if existing, ok := b.objects[hash]; ok {
		return existing
	}
	stored := StoredObject{
		Hash:        hash,
		MediaType:   mediaType,
		Bytes:       append([]byte(nil), data...),
		CreatedAtMs: b.clock.NowMs(),
	}
	b.objects[hash] = stored
	return stored
}

func (b *InMemoryBackend) GetObject(hash string) (StoredObject, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	obj, ok := b.objects[hash]
	return obj, ok
}

func (b *InMemoryBackend) HasObject(hash string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.objects[hash]
	return ok
}

func (b *InMemoryBackend) PutSchema(schema TurnTreeSchema) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.schemas[schema.SchemaID]; exists {
		return false
	}
	b.schemas[schema.SchemaID] = schema
	return true
}

func (b *InMemoryBackend) GetSchema(schemaID string) (TurnTreeSchema, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	schema, ok := b.schemas[schemaID]
	return schema, ok
}

func (b *InMemoryBackend) PutTurnTree(tree TurnTree) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.trees[tree.Hash] = tree
}

func (b *InMemoryBackend) GetTurnTree(hash string) (TurnTree, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	tree, ok := b.trees[hash]
	return tree, ok
}

func (b *InMemoryBackend) PutTurnNode(node TurnNode) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nodes[node.Hash] = node
}

func (b *InMemoryBackend) GetTurnNode(hash string) (TurnNode, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	node, ok := b.nodes[hash]
	return node, ok
}

func (b *InMemoryBackend) MarkTurnNodeThread(hash, threadID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	set, ok := b.nodeThreads[hash]
	if !ok {
		set = make(map[string]bool, 1)
		b.nodeThreads[hash] = set
	}
	set[threadID] = true
}

func (b *InMemoryBackend) TurnNodeBelongsToThread(hash, threadID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.nodeThreads[hash][threadID]
}

func (b *InMemoryBackend) PutThread(thread Thread) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.threads[thread.ThreadID]; exists {
		return false
	}
	b.threads[thread.ThreadID] = thread
	return true
}

func (b *InMemoryBackend) GetThread(threadID string) (Thread, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	thread, ok := b.threads[threadID]
	return thread, ok
}

func (b *InMemoryBackend) ListThreads() []Thread {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Thread, 0, len(b.threads))
	for _, thread := range b.threads {
		out = append(out, thread)
	}
	return out
}

func (b *InMemoryBackend) PutBranch(branch Branch) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.branches[branch.BranchID]; exists {
		return false
	}
	b.branches[branch.BranchID] = branch
	return true
}

func (b *InMemoryBackend) GetBranch(branchID string) (Branch, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	branch, ok := b.branches[branchID]
	return branch, ok
}

func (b *InMemoryBackend) ListBranchesByThread(threadID string) []Branch {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Branch
	for _, branch := range b.branches {
		if branch.ThreadID == threadID {
			out = append(out, branch)
		}
	}
	return out
}

func (b *InMemoryBackend) UpdateBranchHead(branchID, headTurnNodeHash string, updatedAtMs int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	branch, ok := b.branches[branchID]
	if !ok {
		return false
	}
	branch.HeadTurnNodeHash = headTurnNodeHash
	branch.UpdatedAtMs = updatedAtMs
	b.branches[branchID] = branch
	return true
}

func (b *InMemoryBackend) PutRun(run Run) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.runs[run.RunID]; exists {
		return false
	}
	b.runs[run.RunID] = run
	return true
}

func (b *InMemoryBackend) GetRun(runID string) (Run, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	run, ok := b.runs[runID]
	return run, ok
}

func (b *InMemoryBackend) UpdateRun(run Run) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.runs[run.RunID]; !exists {
		return false
	}
	b.runs[run.RunID] = run
	return true
}

func (b *InMemoryBackend) ListRunsByBranch(branchID string) []Run {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Run
	for _, run := range b.runs {
		if run.BranchID == branchID {
			out = append(out, run)
		}
	}
	return out
}

func (b *InMemoryBackend) StageResult(runID string, result StagedResult) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stagedByRun[runID] = append(b.stagedByRun[runID], result)
}

func (b *InMemoryBackend) DrainStagedResults(runID string) []StagedResult {
	b.mu.Lock()
	defer b.mu.Unlock()
	drained := b.stagedByRun[runID]
	delete(b.stagedByRun, runID)
	return drained
}

var _ Backend = (*InMemoryBackend)(nil)
