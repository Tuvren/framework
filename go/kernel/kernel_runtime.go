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
	"fmt"
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

	// leaseTokenOrdinal makes every minted lease token unique within this
	// Kernel regardless of clock granularity: spec §5.2 requires a
	// monotonically changing fencing token, and a purely clock-derived
	// token would repeat when two acquisitions land on the same
	// backend-clock millisecond (the norm under the deterministic
	// ManualClock this port's scenarios pin time with).
	leaseTokenOrdinal int64
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

// bootstrapThreadEventMediaType is the media type CreateThread's minted
// bootstrap object is stored under.
const bootstrapThreadEventMediaType = "application/cbor"

// threadBootstrapRecord builds the canonical-record encoding of a thread's
// genesis bootstrap event: {threadId, type: "kernel_runtime_thread_bootstrap"}.
// This mirrors the TypeScript runtime kernel's thread.create
// (typescript/kernel/runtime/src/lib/runtime-kernel.ts), which mints and
// stores the exact same shape as the object it pins to the root turn node's
// eventHash. The Go port does not need byte-identical encoding with any
// other port — only that the encoding is thread-unique and deterministic —
// but this shape is kept 1:1 with the TypeScript reference anyway since
// nothing about it is Go-specific.
func threadBootstrapRecord(threadID string) RecordMap {
	return RecordMap{
		"threadId": RecordText(threadID),
		"type":     RecordText("kernel_runtime_thread_bootstrap"),
	}
}

// CreateThread creates a new thread on schemaID: a root turn tree (every
// schema path defaulted), a root turn node, and a main branch (branchID)
// whose head is that root turn node.
//
// The root turn node's identity is not purely schema-derived: CreateThread
// mints a backend-owned bootstrap object encoding threadID (see
// threadBootstrapRecord) and pins its hash as the root node's EventHash
// before hashing the node. Because a turn node's content-addressed hash
// covers eventHash, this guarantees every thread's genesis node hash is
// unique to that thread even when two threads share a schema and would
// otherwise both default to an identical empty manifest (kernel spec §3.3).
// That uniqueness is what makes walking a node's PreviousTurnNodeHash chain
// back to a thread's root turn node hash (see turnNodeBelongsToThread) a
// sound thread-membership test: without it, two threads' root nodes could
// collide and either thread's descendants would appear to "belong" to the
// other.
func (k *Kernel) CreateThread(threadID, schemaID, branchID string) (ThreadCreateResult, error) {
	schema, err := k.getSchema(schemaID)
	if err != nil {
		return ThreadCreateResult{}, err
	}

	rootTreeHash, err := k.CreateTurnTree(schemaID, defaultManifestChanges(schema), nil)
	if err != nil {
		return ThreadCreateResult{}, err
	}

	bootstrapBytes, err := EncodeCanonical(threadBootstrapRecord(threadID))
	if err != nil {
		return ThreadCreateResult{}, err
	}
	bootstrapEventHash := k.Backend.PutObject(bootstrapThreadEventMediaType, bootstrapBytes).Hash

	rootNode := TurnNode{
		SchemaID:     schemaID,
		TurnTreeHash: rootTreeHash,
		EventHash:    bootstrapEventHash,
	}
	rootNodeHash, err := HashRecord(turnNodeIdentityRecord(rootNode))
	if err != nil {
		return ThreadCreateResult{}, err
	}
	rootNode.Hash = rootNodeHash

	// Defense in depth: with a thread-unique bootstrap eventHash this
	// should be structurally unreachable, but a corrupted or adversarial
	// backend state must still be rejected rather than silently letting a
	// second thread adopt another thread's genesis node as its own root
	// (mirrors the TypeScript memory backend's
	// memory_backend_thread_root_not_unique invariant).
	if existingThreadID, ok := k.Backend.GetThreadByRootTurnNode(rootNodeHash); ok {
		return ThreadCreateResult{}, newKernelError(ErrThreadRootNotUnique, "turn node %q is already the root of thread %q", rootNodeHash, existingThreadID)
	}

	if err := k.Backend.PutTurnNode(rootNode); err != nil {
		return ThreadCreateResult{}, err
	}

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

// turnNodeBelongsToThread reports whether the turn node at hash belongs to
// the thread whose (now provably unique, see CreateThread) root turn node
// hash is threadRootHash: it walks hash's PreviousTurnNodeHash chain
// backward looking for threadRootHash, capped at maxLineageWalkDepth for
// the same reason the head-movement walks below are capped — an
// adversarial or accidentally cyclic chain must degrade into "does not
// belong" rather than an unbounded loop.
func (k *Kernel) turnNodeBelongsToThread(hash, threadRootHash string) bool {
	cursor := hash
	for depth := 0; depth < maxLineageWalkDepth; depth++ {
		if cursor == threadRootHash {
			return true
		}
		node, ok := k.Backend.GetTurnNode(cursor)
		if !ok || node.PreviousTurnNodeHash == "" {
			return false
		}
		cursor = node.PreviousTurnNodeHash
	}
	return false
}

// CreateBranch forks a new branch on threadID whose head is fromTurnNodeHash.
// fromTurnNodeHash must be a turn node that belongs to threadID
// (ErrTurnNodeThreadMismatch otherwise) — this is the cross-thread
// consumption guard: a caller must not attach a turn node minted on one
// thread to a branch on another thread. Membership is decided by walking
// fromTurnNodeHash's ancestor chain back to threadID's root turn node hash
// (see turnNodeBelongsToThread), so this rejects a genesis (root) node from
// a foreign thread exactly the same way it rejects any other foreign node.
func (k *Kernel) CreateBranch(branchID, threadID, fromTurnNodeHash string) error {
	thread, ok := k.Backend.GetThread(threadID)
	if !ok {
		return newKernelError("kernel_runtime_thread_not_found", "thread %q not found", threadID)
	}
	if _, ok := k.Backend.GetTurnNode(fromTurnNodeHash); !ok {
		return newKernelError("kernel_runtime_turn_node_not_found", "turn node %q not found", fromTurnNodeHash)
	}
	if !k.turnNodeBelongsToThread(fromTurnNodeHash, thread.RootTurnNodeHash) {
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

// headMovement classifies how newHead relates to a branch's currentHead
// (kernel spec §4.2). SetBranchHead handles the "same node" case itself
// before ever calling classifyHeadMovement, so only three kinds remain
// here: forward (newHead is a strict descendant of currentHead), backward
// (newHead is a strict ancestor of currentHead — an archival rollback), and
// lateral (neither: no ancestor/descendant relationship exists between
// them).
type headMovement int

const (
	headMovementForward headMovement = iota
	headMovementBackward
	headMovementLateral
)

// isStrictAncestor reports whether targetHash appears in fromHash's
// PreviousTurnNodeHash chain, not counting fromHash itself, capped at
// maxLineageWalkDepth.
func (k *Kernel) isStrictAncestor(fromHash, targetHash string) bool {
	cursor := fromHash
	for depth := 0; depth < maxLineageWalkDepth; depth++ {
		node, ok := k.Backend.GetTurnNode(cursor)
		if !ok || node.PreviousTurnNodeHash == "" {
			return false
		}
		if node.PreviousTurnNodeHash == targetHash {
			return true
		}
		cursor = node.PreviousTurnNodeHash
	}
	return false
}

func (k *Kernel) classifyHeadMovement(currentHead, newHead string) headMovement {
	if k.isStrictAncestor(newHead, currentHead) {
		return headMovementForward
	}
	if k.isStrictAncestor(currentHead, newHead) {
		return headMovementBackward
	}
	return headMovementLateral
}

// activeRunOnBranch returns the branch's running-or-paused run, if any.
func (k *Kernel) activeRunOnBranch(branchID string) (Run, bool) {
	for _, run := range k.Backend.ListRunsByBranch(branchID) {
		if run.Status == RunStatusRunning || run.Status == RunStatusPaused {
			return run, true
		}
	}
	return Run{}, false
}

// collectAbandonedSegmentHashes walks currentHead's PreviousTurnNodeHash
// chain backward until it reaches targetHash, returning the set of hashes
// strictly between them (inclusive of currentHead, exclusive of
// targetHash) — the segment a backward SetBranchHead move abandons and
// archives. Returns ErrBackwardLineageMismatch if targetHash is never
// reached within maxLineageWalkDepth (should not happen: SetBranchHead only
// calls this after classifyHeadMovement has already confirmed targetHash is
// a strict ancestor of currentHead, but the walk still guards against a
// race or a corrupted chain).
func (k *Kernel) collectAbandonedSegmentHashes(currentHead, targetHash string) (map[string]bool, error) {
	hashes := make(map[string]bool)
	cursor := currentHead
	for depth := 0; depth < maxLineageWalkDepth; depth++ {
		if cursor == targetHash {
			return hashes, nil
		}
		hashes[cursor] = true
		node, ok := k.Backend.GetTurnNode(cursor)
		if !ok || node.PreviousTurnNodeHash == "" {
			return nil, newKernelError(ErrBackwardLineageMismatch, "target %q is not an ancestor of current head %q", targetHash, currentHead)
		}
		cursor = node.PreviousTurnNodeHash
	}
	return nil, newKernelError(ErrBackwardLineageMismatch, "target %q is not an ancestor of current head %q", targetHash, currentHead)
}

// allocateArchiveBranchID probes "{branchID}-archive-{ordinal}-{currentHead
// prefix}" starting at initialOrdinal and incrementing past any collision,
// mirroring the TypeScript runtime kernel's allocateArchiveBranchId.
func (k *Kernel) allocateArchiveBranchID(branchID, currentHead string, initialOrdinal int) string {
	prefixLen := 16
	if len(currentHead) < prefixLen {
		prefixLen = len(currentHead)
	}
	for ordinal := initialOrdinal; ; ordinal++ {
		candidate := fmt.Sprintf("%s-archive-%d-%s", branchID, ordinal, currentHead[:prefixLen])
		if _, ok := k.Backend.GetBranch(candidate); !ok {
			return candidate
		}
	}
}

// runTouchesSegment reports whether run's start node or any turn node it
// created falls within segmentHashes.
func runTouchesSegment(run Run, segmentHashes map[string]bool) bool {
	if segmentHashes[run.StartTurnNodeHash] {
		return true
	}
	for _, hash := range run.CreatedTurnNodes {
		if segmentHashes[hash] {
			return true
		}
	}
	return false
}

// rollbackBranchHead performs a backward SetBranchHead move (kernel spec
// §4.2): an atomic archival rollback. It mints a fresh archive branch
// (ArchivedFromBranchID == branchID) whose head preserves the abandoned
// lineage's tip (branch's current head), fails every running-or-paused run
// on branchID that touches the abandoned segment (clearing its staged
// results, mirroring the TypeScript reference's tx.stagedResults.clearRun),
// and only then moves branchID's own head to newHead.
func (k *Kernel) rollbackBranchHead(branchID string, branch Branch, newHead string) error {
	abandoned, err := k.collectAbandonedSegmentHashes(branch.HeadTurnNodeHash, newHead)
	if err != nil {
		return err
	}

	archiveOrdinal := 1
	for _, candidate := range k.Backend.ListBranchesByThread(branch.ThreadID) {
		if candidate.ArchivedFromBranchID == branchID {
			archiveOrdinal++
		}
	}
	archiveBranchID := k.allocateArchiveBranchID(branchID, branch.HeadTurnNodeHash, archiveOrdinal)

	now := k.Clock.NowMs()
	if !k.Backend.PutBranch(Branch{
		BranchID:             archiveBranchID,
		ThreadID:             branch.ThreadID,
		HeadTurnNodeHash:     branch.HeadTurnNodeHash,
		ArchivedFromBranchID: branchID,
		CreatedAtMs:          now,
		UpdatedAtMs:          now,
	}) {
		return newKernelError("kernel_runtime_branch_already_exists", "archive branch %q already exists", archiveBranchID)
	}

	for _, run := range k.Backend.ListRunsByBranch(branchID) {
		if (run.Status == RunStatusRunning || run.Status == RunStatusPaused) && runTouchesSegment(run, abandoned) {
			k.Backend.DrainStagedResults(run.RunID)
			run.Status = RunStatusFailed
			k.Backend.UpdateRun(run)
		}
	}

	if _, err := k.Backend.UpdateBranchHead(branchID, newHead, now); err != nil {
		return err
	}
	return nil
}

// SetBranchHead moves branchID's head to newHead. newHead must belong to
// the branch's thread (ErrTurnNodeThreadMismatch otherwise). Moving to the
// branch's own current head is a no-op success. Otherwise the move is
// classified as forward, backward, or lateral (kernel spec §4.2):
//
//   - forward: newHead is a strict descendant of the current head. Rejected
//     with ErrBranchHasActiveRun if branchID has a running or paused run
//     (an external caller must not alias a live run's head), otherwise the
//     branch head simply advances.
//   - backward: newHead is a strict ancestor of the current head. Handled
//     as an atomic archival rollback by rollbackBranchHead: unlike forward,
//     this is allowed even with an active run, but any run touching the
//     abandoned segment is failed as part of the same move.
//   - lateral: neither. Always rejected (ErrLateralHeadMovement) — M2 has
//     no notion of moving a branch head sideways onto unrelated history.
func (k *Kernel) SetBranchHead(branchID, newHead string) error {
	branch, ok := k.Backend.GetBranch(branchID)
	if !ok {
		return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", branchID)
	}
	thread, ok := k.Backend.GetThread(branch.ThreadID)
	if !ok {
		return newKernelError("kernel_runtime_thread_not_found", "thread %q not found", branch.ThreadID)
	}
	if _, ok := k.Backend.GetTurnNode(newHead); !ok {
		return newKernelError("kernel_runtime_turn_node_not_found", "turn node %q not found", newHead)
	}
	if !k.turnNodeBelongsToThread(newHead, thread.RootTurnNodeHash) {
		return newKernelError(ErrTurnNodeThreadMismatch, "turn node %q does not belong to thread %q", newHead, branch.ThreadID)
	}

	if newHead == branch.HeadTurnNodeHash {
		return nil
	}

	switch k.classifyHeadMovement(branch.HeadTurnNodeHash, newHead) {
	case headMovementLateral:
		return newKernelError(ErrLateralHeadMovement, "turn node %q is not a descendant of branch %q's current head %q", newHead, branchID, branch.HeadTurnNodeHash)
	case headMovementBackward:
		return k.rollbackBranchHead(branchID, branch, newHead)
	default: // headMovementForward
		if active, ok := k.activeRunOnBranch(branchID); ok {
			return newKernelError(ErrBranchHasActiveRun, "branch %q cannot move head while run %q is active", branchID, active.RunID)
		}
		if _, err := k.Backend.UpdateBranchHead(branchID, newHead, k.Clock.NowMs()); err != nil {
			return err
		}
		return nil
	}
}

// --- run lifecycle ---

// requireUniqueStepIDs rejects a declared step sequence that repeats the
// same step id more than once (ErrDuplicateStepID).
func requireUniqueStepIDs(steps []StepDeclaration) error {
	seen := make(map[string]bool, len(steps))
	for _, step := range steps {
		if seen[step.ID] {
			return newKernelError(ErrDuplicateStepID, "duplicate step id %q in run step sequence", step.ID)
		}
		seen[step.ID] = true
	}
	return nil
}

// CreateRun creates a run on branchID. startTurnNodeHash must match
// branchID's current head (ErrRunBranchHeadMismatch otherwise) — a run
// always starts from wherever its branch currently is, never from a stale
// or foreign turn node. stepSequence's step ids must be unique
// (ErrDuplicateStepID otherwise). A branch may have at most one
// running-or-paused run at a time (ErrBranchAlreadyActive otherwise).
func (k *Kernel) CreateRun(runID, turnID, branchID, schemaID, startTurnNodeHash string, stepSequence []StepDeclaration) error {
	branch, ok := k.Backend.GetBranch(branchID)
	if !ok {
		return newKernelError("kernel_runtime_branch_not_found", "branch %q not found", branchID)
	}
	if branch.HeadTurnNodeHash != startTurnNodeHash {
		return newKernelError(ErrRunBranchHeadMismatch, "run start turn node %q does not match branch %q's current head %q", startTurnNodeHash, branchID, branch.HeadTurnNodeHash)
	}
	if err := requireUniqueStepIDs(stepSequence); err != nil {
		return err
	}

	if active, ok := k.activeRunOnBranch(branchID); ok {
		return newKernelError(ErrBranchAlreadyActive, "branch %q already has an active run (%q)", branchID, active.RunID)
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

// incorporateStagedResults derives a new turn tree from baseTreeHash by
// applying consumed onto it per schema's incorporation rules (kernel spec
// §5.5): an ordered target path appends the staged result's object hash, a
// single target path replaces the value outright. Returns baseTreeHash
// unchanged when consumed is empty. Mirrors the TypeScript runtime kernel's
// applyStagedResultsToManifest + createIncorporatedTree.
func (k *Kernel) incorporateStagedResults(schema TurnTreeSchema, baseTreeHash string, consumed []StagedResult) (string, error) {
	if len(consumed) == 0 {
		return baseTreeHash, nil
	}

	baseTree, ok := k.Backend.GetTurnTree(baseTreeHash)
	if !ok {
		return "", newKernelError("kernel_runtime_tree_not_found", "turn tree %q not found", baseTreeHash)
	}

	rulesByObjectType := make(map[string]IncorporationRule, len(schema.IncorporationRules))
	for _, rule := range schema.IncorporationRules {
		rulesByObjectType[rule.ObjectType] = rule
	}
	pathsByName := make(map[string]PathDefinition, len(schema.Paths))
	for _, path := range schema.Paths {
		pathsByName[path.Path] = path
	}

	changes := make(map[string]PathValue, len(consumed))
	for _, result := range consumed {
		rule, ok := rulesByObjectType[result.ObjectType]
		if !ok {
			return "", newKernelError(ErrUnmatchedIncorporationRule, "no incorporation rule for objectType %q in schema %q", result.ObjectType, schema.SchemaID)
		}

		if pathsByName[rule.TargetPath].Collection == PathCollectionOrdered {
			current, alreadyChanged := changes[rule.TargetPath]
			if !alreadyChanged {
				current = baseTree.Manifest[rule.TargetPath]
			}
			ordered := make([]string, 0, len(current.Ordered)+1)
			if current.Kind == PathValueOrderedKind {
				ordered = append(ordered, current.Ordered...)
			}
			ordered = append(ordered, result.ObjectHash)
			changes[rule.TargetPath] = PathValue{Kind: PathValueOrderedKind, Ordered: ordered}
		} else {
			changes[rule.TargetPath] = PathValue{Kind: PathValueSingleKind, Single: result.ObjectHash}
		}
	}

	return k.CreateTurnTree(schema.SchemaID, changes, &baseTreeHash)
}

// checkpointRun mints a new turn node chained onto run's active turn node,
// advances run's branch head to it, and appends it to run's
// CreatedTurnNodes (returned, not yet persisted via UpdateRun — callers
// finish and persist run themselves so they can also update
// CurrentStepIndex/Status in the same write). When treeHash is "", the new
// node's turn tree is derived from the active node's tree by incorporating
// consumed per the run's schema (see incorporateStagedResults); otherwise
// treeHash is used as-is (the caller must have already validated it).
func (k *Kernel) checkpointRun(run Run, eventHash, treeHash string, consumed []StagedResult) (string, Run, error) {
	schema, err := k.getSchema(run.SchemaID)
	if err != nil {
		return "", run, err
	}

	activeHash := k.activeTurnNodeHash(run)
	activeNode, ok := k.Backend.GetTurnNode(activeHash)
	if !ok {
		return "", run, newKernelError("kernel_runtime_turn_node_not_found", "run %q's active turn node %q not found", run.RunID, activeHash)
	}

	newTreeHash := treeHash
	if newTreeHash == "" {
		newTreeHash, err = k.incorporateStagedResults(schema, activeNode.TurnTreeHash, consumed)
		if err != nil {
			return "", run, err
		}
	}

	newNode := TurnNode{
		SchemaID:              run.SchemaID,
		TurnTreeHash:          newTreeHash,
		PreviousTurnNodeHash:  activeNode.Hash,
		EventHash:             eventHash,
		ConsumedStagedResults: consumed,
	}
	hash, err := HashRecord(turnNodeIdentityRecord(newNode))
	if err != nil {
		return "", run, err
	}
	newNode.Hash = hash

	// PutTurnNode is the checkpoint commit sequence's first durable write.
	// A FaultInjectingBackend's "before-commit" fault point fires here: the
	// write never happens, run.CreatedTurnNodes is never extended, and the
	// branch head never moves — CompleteStep re-stages consumed on this
	// path so nothing consumed is lost (see CompleteStep).
	if err := k.Backend.PutTurnNode(newNode); err != nil {
		return "", run, err
	}

	// Durably record the pending checkpoint's node hash on the run itself,
	// now that the node is durable but before either the branch-head move
	// below or the after-commit-before-ack hook is attempted. This is the
	// run record's own commit-in-progress marker: a FaultPointMidCommit or
	// FaultPointAfterCommitBeforeAck interruption after this point leaves
	// it durably set to hash, and ReconcileRun (recovery.go) reconciles
	// from exactly this field rather than rediscovering the pending node
	// by listing children of the run's previously-active turn node.
	pendingMarker := run
	pendingMarker.PendingCheckpointHash = hash
	k.Backend.UpdateRun(pendingMarker)

	run.CreatedTurnNodes = append(run.CreatedTurnNodes, hash)

	// A run's checkpoints advance its branch's turn head directly: the
	// branch that hosts a live run always tracks that run's most recent
	// turn node. This is always a same-or-forward movement by
	// construction (the new node's previousTurnNodeHash is the branch's
	// current head), so it can never fail the lineage check SetBranchHead
	// itself enforces for externally requested head movements.
	//
	// UpdateBranchHead is the checkpoint commit sequence's second durable
	// write. A FaultInjectingBackend's "mid-commit" fault point fires here
	// without performing the move at all: the turn node written just above
	// is already durable (with consumed embedded as its
	// ConsumedStagedResults), but the branch head is left exactly where it
	// was, modeling a genuine torn checkpoint — a crash after the node
	// lands but before the head advance that would have made it live.
	// Kernel.CompleteStep / Kernel.CompleteRun return this error to their
	// caller without persisting the in-memory run record's
	// CreatedTurnNodes/CurrentStepIndex advance, so ReconcileRun
	// (recovery.go) is what later discovers the durable-but-unreferenced
	// node — via the run's own durably-recorded PendingCheckpointHash,
	// written just above — and rolls both the branch head and the run
	// record forward to it.
	if _, err := k.Backend.UpdateBranchHead(run.BranchID, hash, k.Clock.NowMs()); err != nil {
		return hash, run, err
	}

	// afterCommitBeforeAckHook, if the backend exposes one (see
	// fault_injecting_backend.go), fires after both durable writes above
	// have fully succeeded but before this call returns success to its
	// caller — the "after-commit-before-ack" fault point. Observably
	// identical to "mid-commit" (both writes are already durable), it exists
	// as a distinct hook only so a fault plan can target "the ack, not the
	// write" precisely, matching the TypeScript fault-injecting backend's
	// three-point vocabulary.
	if hook, ok := k.Backend.(afterCommitBeforeAckHook); ok {
		if err := hook.AfterCommitBeforeAck(); err != nil {
			return hash, run, err
		}
	}

	// The checkpoint fully committed and was acknowledged: clear the
	// pending marker on the run this function returns. The caller
	// (CompleteStep / CompleteRun) persists this cleared value as part of
	// its own subsequent UpdateRun, so the durable run record only ever
	// shows a non-empty PendingCheckpointHash while a commit is genuinely
	// in flight or was interrupted mid-flight.
	run.PendingCheckpointHash = ""

	return hash, run, nil
}

// afterCommitBeforeAckHook is the optional seam a Backend can implement to
// have Kernel.checkpointRun call it after both checkpoint-commit durable
// writes (PutTurnNode, UpdateBranchHead) have succeeded but before
// checkpointRun reports success to its own caller. InMemoryBackend does not
// implement it; FaultInjectingBackend does (fault_injecting_backend.go).
type afterCommitBeforeAckHook interface {
	AfterCommitBeforeAck() error
}

// CompleteStep validates that stepID is the run's next declared step,
// checks eventHash (if non-empty) exists in the object store
// (ErrMissingEventObject otherwise), and checkpoints: it mints a new turn
// node whose consumedStagedResults is everything staged since the previous
// checkpoint, evolves the turn tree by incorporating those staged results
// per the run's schema (kernel spec §5.5), advances the run's step index,
// and returns the new turn node's hash. When treeHash is non-empty, it is
// used as the checkpoint's turn tree instead of one derived from staged
// results — it must already exist and share the run's schemaId
// (ErrMissingTree / ErrTreeSchemaMismatch otherwise).
func (k *Kernel) CompleteStep(runID, stepID, eventHash, treeHash string) (string, error) {
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
	if treeHash != "" {
		tree, ok := k.Backend.GetTurnTree(treeHash)
		if !ok {
			return "", newKernelError(ErrMissingTree, "tree hash %q does not exist", treeHash)
		}
		if tree.SchemaID != run.SchemaID {
			return "", newKernelError(ErrTreeSchemaMismatch, "tree hash %q uses schema %q but run uses schema %q", treeHash, tree.SchemaID, run.SchemaID)
		}
	}

	consumed := k.Backend.DrainStagedResults(runID)
	hash, run, err := k.checkpointRun(run, eventHash, treeHash, consumed)
	if err != nil {
		if hash == "" {
			// The checkpoint never became durable (a "before-commit" fault
			// or an equivalent failure before the turn node was written):
			// nothing consumed committed anywhere, so restage it rather than
			// silently losing it — the next successful checkpoint attempt
			// (or a recovery replay) must still see it as uncommitted work.
			for _, result := range consumed {
				k.Backend.StageResult(runID, result)
			}
		}
		// hash != "" means the checkpoint's durable writes already
		// succeeded (a "mid-commit" or "after-commit-before-ack" fault):
		// the turn node and branch head are real, but this run record is
		// deliberately left un-advanced here. ReconcileRun (recovery.go)
		// repairs it forward to match the branch head that already moved.
		return "", err
	}

	run.CurrentStepIndex++
	k.Backend.UpdateRun(run)

	return hash, nil
}

// CompleteRun validates eventHash (if non-empty) exists in the object store
// (ErrMissingEventObject otherwise), reactively checkpoints any staged
// results (or a non-empty eventHash) left un-anchored since the run's last
// step boundary (kernel spec §5.6) exactly like CompleteStep's checkpoint,
// and marks the run completed. A run with nothing staged and no eventHash
// completes without minting an extra turn node.
func (k *Kernel) CompleteRun(runID, eventHash string) error {
	run, ok := k.Backend.GetRun(runID)
	if !ok {
		return newKernelError("kernel_runtime_run_not_found", "run %q not found", runID)
	}
	if eventHash != "" && !k.Backend.HasObject(eventHash) {
		return newKernelError(ErrMissingEventObject, "event object %q is not present in the object store", eventHash)
	}

	staged := k.Backend.DrainStagedResults(runID)
	if len(staged) > 0 || eventHash != "" {
		hash, updatedRun, err := k.checkpointRun(run, eventHash, "", staged)
		if err != nil {
			if hash == "" {
				// The checkpoint never became durable (a "before-commit"
				// fault or equivalent failure before the turn node was
				// written): nothing consumed committed anywhere, so
				// restage it rather than silently losing it, mirroring
				// CompleteStep's identical restaging on this path.
				for _, result := range staged {
					k.Backend.StageResult(runID, result)
				}
			}
			// hash != "" means the checkpoint's durable writes already
			// succeeded (a "mid-commit" fault): the turn node is real
			// (with staged embedded as its ConsumedStagedResults) even
			// though the branch head was never moved to it and this run
			// record is deliberately left un-advanced here. ReconcileRun
			// (recovery.go) repairs it forward.
			return err
		}
		run = updatedRun
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
