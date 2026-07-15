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

// Package kernel: this file is the M2 runtime kernel host. Kernel is pure
// logic over a Backend (backend.go): it enforces schema/tree/thread/branch/
// run structural and lineage rules from docs/KrakenKernelSpecification.md
// §§3-5 and §7, and raises the kernel_runtime_* error codes (errors.go)
// when a caller violates them. Kernel itself holds no storage state beyond
// the Backend it wraps and the scope identity / clock it was constructed
// with.
package kernel

import (
	"encoding/base64"
	"encoding/json"
	"sort"
)

// maxLineageWalkDepth bounds the ancestor walk SetBranchHead performs when
// classifying a head movement. It exists for the same reason
// maxDecodeDepth exists in cbor.go: adversarial or accidentally cyclic
// previousTurnNodeHash chains must degrade into a normal kernel error
// instead of an unbounded loop.
const maxLineageWalkDepth = 100_000

// Kernel is the M2 runtime kernel host: scope identity and a clock are
// injected at construction (used by this milestone for createdAtMs/
// updatedAtMs bookkeeping, and reserved for later milestones such as
// lease expiry and reclamation windows), and every operation is executed
// against the injected Backend.
type Kernel struct {
	ScopeID string
	Clock   Clock
	Backend Backend
}

// NewKernel constructs a Kernel bound to one scope, clock, and backend.
func NewKernel(scopeID string, clock Clock, backend Backend) *Kernel {
	if clock == nil {
		clock = backend.Clock()
	}
	return &Kernel{ScopeID: scopeID, Clock: clock, Backend: backend}
}

// --- object store ---

// PutObject stores raw bytes content-addressed by their SHA-256 hash and
// returns that hash.
func (k *Kernel) PutObject(mediaType string, data []byte) string {
	return k.Backend.PutObject(mediaType, data).Hash
}

// HasObject reports whether hash is present in the object store.
func (k *Kernel) HasObject(hash string) bool {
	return k.Backend.HasObject(hash)
}

// --- schema registry ---

// RegisterSchema validates and registers a turn-tree-schema. Duplicate path
// definitions within the schema are rejected by ValidateTurnTreeSchema
// (ErrDuplicateSchemaPath) before this ever reaches the backend.
func (k *Kernel) RegisterSchema(schema TurnTreeSchema) error {
	if !k.Backend.PutSchema(schema) {
		return newKernelError("kernel_runtime_schema_already_registered", "schema %q is already registered", schema.SchemaID)
	}
	return nil
}

func (k *Kernel) getSchema(schemaID string) (TurnTreeSchema, error) {
	schema, ok := k.Backend.GetSchema(schemaID)
	if !ok {
		return TurnTreeSchema{}, newKernelError("kernel_runtime_schema_not_found", "schema %q is not registered", schemaID)
	}
	return schema, nil
}

// --- turn trees ---

// CreateTurnTree builds a turn tree from schemaId and changes. When base is
// nil, changes must supply a value (possibly PathValueNull) for every path
// the schema declares; a missing path key is
// ErrMissingRequiredTreePath. When base is non-nil, the base tree's schema
// must match schemaId (ErrTreeSchemaMismatch) and the result is the base
// manifest with changes applied on top — a new map with only the changed
// path keys replaced, giving the two trees structural sharing at the value
// level.
func (k *Kernel) CreateTurnTree(schemaID string, changes map[string]PathValue, base *string) (string, error) {
	schema, err := k.getSchema(schemaID)
	if err != nil {
		return "", err
	}

	var manifest map[string]PathValue
	if base == nil {
		for _, path := range schema.Paths {
			if _, ok := changes[path.Path]; !ok {
				return "", newKernelError(ErrMissingRequiredTreePath, "turn tree create for schema %q is missing required path %q", schemaID, path.Path)
			}
		}
		manifest = make(map[string]PathValue, len(changes))
		for path, value := range changes {
			manifest[path] = value
		}
	} else {
		baseTree, ok := k.Backend.GetTurnTree(*base)
		if !ok {
			return "", newKernelError("kernel_runtime_tree_not_found", "base turn tree %q not found", *base)
		}
		if baseTree.SchemaID != schemaID {
			return "", newKernelError(ErrTreeSchemaMismatch, "base turn tree %q has schema %q, expected %q", *base, baseTree.SchemaID, schemaID)
		}
		manifest = make(map[string]PathValue, len(baseTree.Manifest)+len(changes))
		for path, value := range baseTree.Manifest {
			manifest[path] = value
		}
		for path, value := range changes {
			manifest[path] = value
		}
	}

	hash, err := HashRecord(turnTreeIdentityRecord(schemaID, manifest))
	if err != nil {
		return "", err
	}
	k.Backend.PutTurnTree(TurnTree{Hash: hash, SchemaID: schemaID, Manifest: manifest})
	return hash, nil
}

// DiffTurnTrees returns the sorted list of manifest path names whose value
// differs between the two named trees. Both trees must share the same
// schema (ErrTreeSchemaMismatchDiff otherwise); a path present in only one
// tree's manifest is compared against PathValueNull for the other.
func (k *Kernel) DiffTurnTrees(hashA, hashB string) ([]string, error) {
	treeA, ok := k.Backend.GetTurnTree(hashA)
	if !ok {
		return nil, newKernelError("kernel_runtime_tree_not_found", "turn tree %q not found", hashA)
	}
	treeB, ok := k.Backend.GetTurnTree(hashB)
	if !ok {
		return nil, newKernelError("kernel_runtime_tree_not_found", "turn tree %q not found", hashB)
	}
	if treeA.SchemaID != treeB.SchemaID {
		return nil, newKernelError(ErrTreeSchemaMismatchDiff, "turn trees %q and %q have different schemas (%q vs %q)", hashA, hashB, treeA.SchemaID, treeB.SchemaID)
	}

	seen := make(map[string]bool, len(treeA.Manifest)+len(treeB.Manifest))
	var changed []string
	for path := range treeA.Manifest {
		seen[path] = true
	}
	for path := range treeB.Manifest {
		seen[path] = true
	}
	for path := range seen {
		left, leftOK := treeA.Manifest[path]
		right, rightOK := treeB.Manifest[path]
		if !leftOK {
			left = PathValue{Kind: PathValueNull}
		}
		if !rightOK {
			right = PathValue{Kind: PathValueNull}
		}
		if !pathValuesEqual(left, right) {
			changed = append(changed, path)
		}
	}
	sort.Strings(changed)
	return changed, nil
}

func pathValuesEqual(a, b PathValue) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case PathValueSingleKind:
		return a.Single == b.Single
	case PathValueOrderedKind:
		if len(a.Ordered) != len(b.Ordered) {
			return false
		}
		for i := range a.Ordered {
			if a.Ordered[i] != b.Ordered[i] {
				return false
			}
		}
		return true
	default:
		return true
	}
}

// --- threads / branches ---

// defaultManifestChanges builds the "every path present" changes map a
// fresh thread's root turn tree needs: ordered-collection paths default to
// an empty ordered value, single-collection paths default to null.
func defaultManifestChanges(schema TurnTreeSchema) map[string]PathValue {
	changes := make(map[string]PathValue, len(schema.Paths))
	for _, path := range schema.Paths {
		if path.Collection == PathCollectionOrdered {
			changes[path.Path] = PathValue{Kind: PathValueOrderedKind, Ordered: []string{}}
		} else {
			changes[path.Path] = PathValue{Kind: PathValueNull}
		}
	}
	return changes
}

// CreateThread creates a new thread on schemaID: a root turn tree (every
// schema path defaulted), a root turn node, and a main branch (branchID)
// whose head is that root turn node.
func (k *Kernel) CreateThread(threadID, schemaID, branchID string) (ThreadCreateResult, error) {
	schema, err := k.getSchema(schemaID)
	if err != nil {
		return ThreadCreateResult{}, err
	}

	rootTreeHash, err := k.CreateTurnTree(schemaID, defaultManifestChanges(schema), nil)
	if err != nil {
		return ThreadCreateResult{}, err
	}

	rootNode := TurnNode{
		SchemaID:     schemaID,
		TurnTreeHash: rootTreeHash,
	}
	rootNodeHash, err := HashRecord(turnNodeIdentityRecord(rootNode))
	if err != nil {
		return ThreadCreateResult{}, err
	}
	rootNode.Hash = rootNodeHash
	k.Backend.PutTurnNode(rootNode)
	k.Backend.MarkTurnNodeThread(rootNodeHash, threadID)

	now := k.Clock.NowMs()
	if !k.Backend.PutThread(Thread{ThreadID: threadID, SchemaID: schemaID, RootTurnNodeHash: rootNodeHash, CreatedAtMs: now}) {
		return ThreadCreateResult{}, newKernelError("kernel_runtime_thread_already_exists", "thread %q already exists", threadID)
	}
	if !k.Backend.PutBranch(Branch{BranchID: branchID, ThreadID: threadID, HeadTurnNodeHash: rootNodeHash, CreatedAtMs: now, UpdatedAtMs: now}) {
		return ThreadCreateResult{}, newKernelError("kernel_runtime_branch_already_exists", "branch %q already exists", branchID)
	}

	return ThreadCreateResult{
		BranchID:         branchID,
		RootTurnNodeHash: rootNodeHash,
		RootTurnTreeHash: rootTreeHash,
		ThreadID:         threadID,
	}, nil
}

// CreateBranch forks a new branch on threadID whose head is fromTurnNodeHash.
// fromTurnNodeHash must be a turn node that belongs to threadID
// (ErrTurnNodeThreadMismatch otherwise) — this is the cross-thread
// consumption guard: a caller must not attach a turn node minted on one
// thread to a branch on another thread.
func (k *Kernel) CreateBranch(branchID, threadID, fromTurnNodeHash string) error {
	if _, ok := k.Backend.GetThread(threadID); !ok {
		return newKernelError("kernel_runtime_thread_not_found", "thread %q not found", threadID)
	}
	if _, ok := k.Backend.GetTurnNode(fromTurnNodeHash); !ok {
		return newKernelError("kernel_runtime_turn_node_not_found", "turn node %q not found", fromTurnNodeHash)
	}
	if !k.Backend.TurnNodeBelongsToThread(fromTurnNodeHash, threadID) {
		return newKernelError(ErrTurnNodeThreadMismatch, "turn node %q does not belong to thread %q", fromTurnNodeHash, threadID)
	}

	now := k.Clock.NowMs()
	if !k.Backend.PutBranch(Branch{BranchID: branchID, ThreadID: threadID, HeadTurnNodeHash: fromTurnNodeHash, CreatedAtMs: now, UpdatedAtMs: now}) {
		return newKernelError("kernel_runtime_branch_already_exists", "branch %q already exists", branchID)
	}
	return nil
}

// ListBranchHeads returns [branchId, headTurnNodeHash] tuples for every
// branch on threadID, sorted by branchId for a deterministic result.
func (k *Kernel) ListBranchHeads(threadID string) ([][2]string, error) {
	if _, ok := k.Backend.GetThread(threadID); !ok {
		return nil, newKernelError("kernel_runtime_thread_not_found", "thread %q not found", threadID)
	}
	branches := k.Backend.ListBranchesByThread(threadID)
	sort.Slice(branches, func(i, j int) bool { return branches[i].BranchID < branches[j].BranchID })
	out := make([][2]string, 0, len(branches))
	for _, branch := range branches {
		out = append(out, [2]string{branch.BranchID, branch.HeadTurnNodeHash})
	}
	return out, nil
}

// headMovement classifies how newHead relates to a branch's currentHead by
// walking newHead's previousTurnNodeHash chain looking for currentHead.
type headMovement int

const (
	headMovementLateral headMovement = iota
	headMovementSame
	headMovementForward
)

func (k *Kernel) classifyHeadMovement(currentHead, newHead string) (headMovement, error) {
	if newHead == currentHead {
		return headMovementSame, nil
	}

	cursor := newHead
	for depth := 0; depth < maxLineageWalkDepth; depth++ {
		node, ok := k.Backend.GetTurnNode(cursor)
		if !ok {
			return headMovementLateral, nil
		}
		if node.PreviousTurnNodeHash == "" {
			return headMovementLateral, nil
		}
		if node.PreviousTurnNodeHash == currentHead {
			return headMovementForward, nil
		}
		cursor = node.PreviousTurnNodeHash
	}
	return headMovementLateral, nil
}

// SetBranchHead moves branchID's head to newHead. newHead must belong to
// the branch's thread (ErrTurnNodeThreadMismatch otherwise) and must be a
// descendant of the branch's current head, reached by following
// previousTurnNodeHash links backward from newHead (ErrLateralHeadMovement
// otherwise — this also covers the backward-rewind case, which M2 does not
// support as a distinct movement kind: an ancestor of the current head is,
// by this same-or-descendant rule, "not a descendant of the current head").
func (k *Kernel) SetBranchHead(branchID, newHead string) error {
	branch, ok := k.Backend.GetBranch(branchID)
	if !ok {
		return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", branchID)
	}
	if _, ok := k.Backend.GetTurnNode(newHead); !ok {
		return newKernelError("kernel_runtime_turn_node_not_found", "turn node %q not found", newHead)
	}
	if !k.Backend.TurnNodeBelongsToThread(newHead, branch.ThreadID) {
		return newKernelError(ErrTurnNodeThreadMismatch, "turn node %q does not belong to thread %q", newHead, branch.ThreadID)
	}

	movement, err := k.classifyHeadMovement(branch.HeadTurnNodeHash, newHead)
	if err != nil {
		return err
	}
	if movement == headMovementLateral {
		return newKernelError(ErrLateralHeadMovement, "turn node %q is not a descendant of branch %q's current head %q", newHead, branchID, branch.HeadTurnNodeHash)
	}

	k.Backend.UpdateBranchHead(branchID, newHead, k.Clock.NowMs())
	return nil
}

// --- run lifecycle ---

// CreateRun creates a run on branchID. A branch may have at most one
// running-or-paused run at a time (ErrBranchAlreadyActive otherwise).
func (k *Kernel) CreateRun(runID, turnID, branchID, schemaID, startTurnNodeHash string, stepSequence []StepDeclaration) error {
	branch, ok := k.Backend.GetBranch(branchID)
	if !ok {
		return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", branchID)
	}

	for _, existing := range k.Backend.ListRunsByBranch(branchID) {
		if existing.Status == RunStatusRunning || existing.Status == RunStatusPaused {
			return newKernelError(ErrBranchAlreadyActive, "branch %q already has an active run (%q)", branchID, existing.RunID)
		}
	}

	run := Run{
		RunID:             runID,
		TurnID:            turnID,
		BranchID:          branchID,
		SchemaID:          schemaID,
		StartTurnNodeHash: startTurnNodeHash,
		Status:            RunStatusRunning,
		CurrentStepIndex:  0,
		StepSequence:      stepSequence,
		ThreadID:          branch.ThreadID,
	}
	if !k.Backend.PutRun(run) {
		return newKernelError("kernel_runtime_run_already_exists", "run %q already exists", runID)
	}
	return nil
}

func (k *Kernel) requireExpectedStep(run Run, stepID string) error {
	if run.CurrentStepIndex >= len(run.StepSequence) || run.StepSequence[run.CurrentStepIndex].ID != stepID {
		return newKernelError(ErrUnexpectedStep, "run %q expected a different step than %q at index %d", run.RunID, stepID, run.CurrentStepIndex)
	}
	return nil
}

// BeginStep validates that stepID is the run's next declared step.
func (k *Kernel) BeginStep(runID, stepID string) error {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	return k.requireExpectedStep(run, stepID)
}

func (k *Kernel) activeTurnNodeHash(run Run) string {
	if len(run.CreatedTurnNodes) > 0 {
		return run.CreatedTurnNodes[len(run.CreatedTurnNodes)-1]
	}
	return run.StartTurnNodeHash
}

// CompleteStep validates that stepID is the run's next declared step,
// checks eventHash (if non-empty) exists in the object store
// (ErrMissingEventObject otherwise), mints a new turn node whose
// consumedStagedResults is everything staged since the previous checkpoint,
// advances the run's step index, and returns the new turn node's hash.
func (k *Kernel) CompleteStep(runID, stepID, eventHash string) (string, error) {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return "", newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	if err := k.requireExpectedStep(run, stepID); err != nil {
		return "", err
	}
	if eventHash != "" && !k.Backend.HasObject(eventHash) {
		return "", newKernelError(ErrMissingEventObject, "event object %q is not present in the object store", eventHash)
	}

	activeNode, ok := k.Backend.GetTurnNode(k.activeTurnNodeHash(run))
	if !ok {
		return "", newKernelError("kernel_runtime_turn_node_not_found", "run %q's active turn node %q not found", runID, k.activeTurnNodeHash(run))
	}

	consumed := k.Backend.DrainStagedResults(runID)
	newNode := TurnNode{
		SchemaID:              run.SchemaID,
		TurnTreeHash:          activeNode.TurnTreeHash,
		PreviousTurnNodeHash:  activeNode.Hash,
		EventHash:             eventHash,
		ConsumedStagedResults: consumed,
	}
	hash, err := HashRecord(turnNodeIdentityRecord(newNode))
	if err != nil {
		return "", err
	}
	newNode.Hash = hash
	k.Backend.PutTurnNode(newNode)
	k.Backend.MarkTurnNodeThread(hash, run.ThreadID)

	run.CreatedTurnNodes = append(run.CreatedTurnNodes, hash)
	run.CurrentStepIndex++
	k.Backend.UpdateRun(run)

	// A run's steps advance its branch's turn head as they complete: the
	// branch that hosts a live run always tracks that run's most recent
	// turn node. This is always a same-or-forward movement by
	// construction (the new node's previousTurnNodeHash is the branch's
	// current head), so it can never fail the lineage check SetBranchHead
	// itself enforces for externally requested head movements.
	k.Backend.UpdateBranchHead(run.BranchID, hash, k.Clock.NowMs())

	return hash, nil
}

// CompleteRun validates eventHash (if non-empty) exists in the object store
// (ErrMissingEventObject otherwise) and marks the run completed.
func (k *Kernel) CompleteRun(runID, eventHash string) error {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	if eventHash != "" && !k.Backend.HasObject(eventHash) {
		return newKernelError(ErrMissingEventObject, "event object %q is not present in the object store", eventHash)
	}
	run.Status = RunStatusCompleted
	k.Backend.UpdateRun(run)
	return nil
}

// StageResult adds result to runID's uncommitted staging pool.
func (k *Kernel) StageResult(runID string, result StagedResult) error {
	if _, ok := k.Backend.GetRun(runID); !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	k.Backend.StageResult(runID, result)
	return nil
}

// RecoveryState reports runID's recovery-state (CDDL recovery-state): the
// run's active turn node hash, the id of its last completed step (if any),
// its declared step sequence, the staged results consumed at its last
// checkpoint (its active turn node's consumedStagedResults), and whatever
// remains staged but uncommitted since that checkpoint.
func (k *Kernel) RecoveryState(runID string) (RecoveryState, error) {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return RecoveryState{}, newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}

	activeHash := k.activeTurnNodeHash(run)
	activeNode, ok := k.Backend.GetTurnNode(activeHash)
	if !ok {
		return RecoveryState{}, newKernelError("kernel_runtime_turn_node_not_found", "run %q's active turn node %q not found", runID, activeHash)
	}

	state := RecoveryState{
		LastTurnNodeHash:         activeHash,
		StepSequence:             run.StepSequence,
		ConsumedStagedResults:    activeNode.ConsumedStagedResults,
		UncommittedStagedResults: peekStagedResults(k.Backend, runID),
	}
	if run.CurrentStepIndex > 0 {
		state.LastCompletedStepID = run.StepSequence[run.CurrentStepIndex-1].ID
		state.HasLastCompletedStepID = true
	}
	return state, nil
}

// peekStagedResults reads a run's uncommitted staging pool without
// draining it (RecoveryState is a read-only query).
func peekStagedResults(backend Backend, runID string) []StagedResult {
	drained := backend.DrainStagedResults(runID)
	for _, result := range drained {
		backend.StageResult(runID, result)
	}
	return drained
}

// --- thread enumeration (capability kernel-protocol.thread.enumeration) ---

// threadListCursor is the opaque cursor payload this Kernel encodes as an
// unpadded base64 JSON string, resuming strictly after
// (LastCreatedAtMs, LastThreadID) in the (createdAtMs ASC, threadId ASC)
// enumeration order.
type threadListCursor struct {
	LastCreatedAtMs int64  `json:"lastCreatedAtMs"`
	LastThreadID    string `json:"lastThreadId"`
}

func encodeThreadListCursor(c threadListCursor) (string, error) {
	data, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func decodeThreadListCursor(cursor string) (threadListCursor, error) {
	data, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return threadListCursor{}, newKernelError("kernel_runtime_invalid_cursor", "malformed thread list cursor: %v", err)
	}
	var decoded threadListCursor
	if err := json.Unmarshal(data, &decoded); err != nil {
		return threadListCursor{}, newKernelError("kernel_runtime_invalid_cursor", "malformed thread list cursor: %v", err)
	}
	return decoded, nil
}

// ListThreads enumerates threads in deterministic (createdAtMs ASC,
// threadId ASC) order. limit <= 0 means "no limit." When the result is
// truncated by limit, nextCursor is non-empty and resuming with it (as the
// cursor argument to a later ListThreads call) continues strictly after
// the last returned thread.
func (k *Kernel) ListThreads(limit int, cursor string) (threads []Thread, nextCursor string, err error) {
	all := k.Backend.ListThreads()
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAtMs != all[j].CreatedAtMs {
			return all[i].CreatedAtMs < all[j].CreatedAtMs
		}
		return all[i].ThreadID < all[j].ThreadID
	})

	start := 0
	if cursor != "" {
		decoded, err := decodeThreadListCursor(cursor)
		if err != nil {
			return nil, "", err
		}
		start = sort.Search(len(all), func(i int) bool {
			if all[i].CreatedAtMs != decoded.LastCreatedAtMs {
				return all[i].CreatedAtMs > decoded.LastCreatedAtMs
			}
			return all[i].ThreadID > decoded.LastThreadID
		})
	}

	remaining := all[start:]
	if limit <= 0 || limit >= len(remaining) {
		return remaining, "", nil
	}

	page := remaining[:limit]
	last := page[len(page)-1]
	next, err := encodeThreadListCursor(threadListCursor{LastCreatedAtMs: last.CreatedAtMs, LastThreadID: last.ThreadID})
	if err != nil {
		return nil, "", err
	}
	return page, next, nil
}
