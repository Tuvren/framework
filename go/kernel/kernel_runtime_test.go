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

package kernel_test

import (
	"reflect"
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

func newTestKernel() *kernel.Kernel {
	clock := &kernel.IncrementingClock{}
	backend := kernel.NewInMemoryBackend(clock)
	return kernel.NewKernel("test-scope", clock, backend)
}

func canonicalSchema() kernel.TurnTreeSchema {
	return kernel.TurnTreeSchema{
		SchemaID: "schema_main",
		Paths: []kernel.PathDefinition{
			{Path: "messages", Collection: kernel.PathCollectionOrdered},
			{Path: "context.manifest", Collection: kernel.PathCollectionSingle},
		},
		IncorporationRules: []kernel.IncorporationRule{
			{ObjectType: "message", TargetPath: "messages"},
			{ObjectType: "context_manifest", TargetPath: "context.manifest"},
		},
	}
}

func requireErrCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %q, got nil", code)
	}
	kerr, ok := kernel.AsKernelError(err)
	if !ok {
		t.Fatalf("expected a *KernelError, got %T: %v", err, err)
	}
	if kerr.Code != code {
		t.Fatalf("expected error code %q, got %q (%v)", code, kerr.Code, err)
	}
}

// --- schema registry ---

func TestRegisterSchema_DuplicatePathRejected(t *testing.T) {
	schema := kernel.TurnTreeSchema{
		SchemaID: "schema_dup",
		Paths: []kernel.PathDefinition{
			{Path: "messages", Collection: kernel.PathCollectionOrdered},
			{Path: "messages", Collection: kernel.PathCollectionOrdered},
		},
	}
	record, err := recordFromSchema(schema)
	if err != nil {
		t.Fatalf("build record: %v", err)
	}
	_, err = kernel.ValidateTurnTreeSchema(record)
	requireErrCode(t, err, kernel.ErrDuplicateSchemaPath)
}

func TestRegisterSchema_Succeeds(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
}

// --- turn tree create/diff ---

func TestCreateTurnTree_MissingRequiredPath(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	changes := map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		// context.manifest intentionally omitted
	}
	_, err := k.CreateTurnTree("schema_main", changes, nil)
	requireErrCode(t, err, kernel.ErrMissingRequiredTreePath)
}

func TestCreateTurnTree_MissingSingleCollectionPathExplicitCase(t *testing.T) {
	// Adversarial regression: only the ordered path is supplied, exactly
	// like the protocol edge-validation probe.
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	_, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
	}, nil)
	requireErrCode(t, err, kernel.ErrMissingRequiredTreePath)
}

func TestCreateTurnTree_ModifyProducesNewHashWithStructuralSharing(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	baseHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create base: %v", err)
	}

	manifestHash := kernel.HashBytesToHex([]byte("manifest-object"))
	modifiedHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"context.manifest": {Kind: kernel.PathValueSingleKind, Single: manifestHash},
	}, &baseHash)
	if err != nil {
		t.Fatalf("modify: %v", err)
	}
	if modifiedHash == baseHash {
		t.Fatal("expected modify to produce a new tree hash")
	}

	changed, err := k.DiffTurnTrees(baseHash, modifiedHash)
	if err != nil {
		t.Fatalf("diff: %v", err)
	}
	if !reflect.DeepEqual(changed, []string{"context.manifest"}) {
		t.Fatalf("expected only context.manifest to have changed, got %v", changed)
	}
}

func TestCreateTurnTree_ModifyWrongSchemaMismatch(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	otherSchema := kernel.TurnTreeSchema{SchemaID: "schema_other", Paths: []kernel.PathDefinition{
		{Path: "solo", Collection: kernel.PathCollectionSingle},
	}}
	if err := k.RegisterSchema(otherSchema); err != nil {
		t.Fatalf("register other: %v", err)
	}

	baseHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create base: %v", err)
	}

	_, err = k.CreateTurnTree("schema_other", map[string]kernel.PathValue{"solo": {Kind: kernel.PathValueNull}}, &baseHash)
	requireErrCode(t, err, kernel.ErrTreeSchemaMismatch)
}

func TestDiffTurnTrees_SchemaMismatch(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	otherSchema := kernel.TurnTreeSchema{SchemaID: "schema_other", Paths: []kernel.PathDefinition{
		{Path: "solo", Collection: kernel.PathCollectionSingle},
	}}
	if err := k.RegisterSchema(otherSchema); err != nil {
		t.Fatalf("register other: %v", err)
	}

	treeA, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	treeB, err := k.CreateTurnTree("schema_other", map[string]kernel.PathValue{"solo": {Kind: kernel.PathValueNull}}, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	_, err = k.DiffTurnTrees(treeA, treeB)
	requireErrCode(t, err, kernel.ErrTreeSchemaMismatchDiff)
}

// --- thread / branch ---

func TestCreateThread_CreatesRootNodeAndMainBranch(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if result.ThreadID != "thread_a" || result.BranchID != "branch_main" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.RootTurnNodeHash == "" || result.RootTurnTreeHash == "" {
		t.Fatalf("expected non-empty hashes: %+v", result)
	}

	heads, err := k.ListBranchHeads("thread_a")
	if err != nil {
		t.Fatalf("list branch heads: %v", err)
	}
	if len(heads) != 1 || heads[0][0] != "branch_main" || heads[0][1] != result.RootTurnNodeHash {
		t.Fatalf("unexpected branch heads: %v", heads)
	}
}

func TestCreateBranch_CrossThreadRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	resultA, err := k.CreateThread("thread_a", "schema_main", "branch_a_main")
	if err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_b", "schema_main", "branch_b_main"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	// Genesis (root) turn nodes are already thread-unique (CreateThread
	// pins a thread-scoped bootstrap object as the root's eventHash — see
	// TestCreateThread_GenesisHashesAreThreadUnique), but this test exists
	// to prove the membership guard also holds for a *non-root* node deep
	// in a thread's lineage: advancing thread_a's branch with a step
	// tagged to a distinct event object mints a node no other thread could
	// legitimately have produced, and CreateBranch must still reject
	// attaching it to thread_b.
	distinguishingEventHash := k.PutObject("application/json", []byte("thread-a-only-event"))
	if err := k.CreateRun("run_a", "turn_a", "branch_a_main", "schema_main", resultA.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run a: %v", err)
	}
	nodeA, err := k.CompleteStep("run_a", "only_step", distinguishingEventHash, "")
	if err != nil {
		t.Fatalf("complete step a: %v", err)
	}

	err = k.CreateBranch("branch_cross_thread", "thread_b", nodeA)
	requireErrCode(t, err, kernel.ErrTurnNodeThreadMismatch)
}

// TestCreateThread_GenesisHashesAreThreadUnique is the P0-1 regression: two
// threads created back to back on the *same* schema (so their default root
// turn tree manifests are byte-identical) must still mint different root
// turn node hashes, because CreateThread pins a thread-scoped bootstrap
// object as the root node's eventHash. Before this fix, two such threads'
// genesis nodes were byte-identical and therefore hash-identical.
func TestCreateThread_GenesisHashesAreThreadUnique(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	resultA, err := k.CreateThread("thread_genesis_a", "schema_main", "branch_genesis_a")
	if err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	resultB, err := k.CreateThread("thread_genesis_b", "schema_main", "branch_genesis_b")
	if err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	if resultA.RootTurnNodeHash == "" || resultB.RootTurnNodeHash == "" {
		t.Fatalf("expected non-empty root turn node hashes: a=%q b=%q", resultA.RootTurnNodeHash, resultB.RootTurnNodeHash)
	}
	if resultA.RootTurnNodeHash == resultB.RootTurnNodeHash {
		t.Fatalf("expected thread_genesis_a and thread_genesis_b to mint different genesis turn node hashes sharing schema %q, both got %q", "schema_main", resultA.RootTurnNodeHash)
	}
	// The two threads' root turn *trees* are still byte-identical (same
	// schema, same defaulted manifest) — only the turn node identity (which
	// folds in the thread-scoped bootstrap eventHash) diverges.
	if resultA.RootTurnTreeHash != resultB.RootTurnTreeHash {
		t.Fatalf("expected both threads' default root turn trees to share a hash, got %q and %q", resultA.RootTurnTreeHash, resultB.RootTurnTreeHash)
	}
}

// TestCreateBranch_CrossThreadGenesisRejected is the P0-1 headline
// regression the reviewer identified: forking a branch on thread_b directly
// from thread_a's *genesis* (root) turn node must be rejected exactly like
// any other cross-thread node consumption. Before this fix, two threads
// sharing a schema minted byte-identical (and therefore hash-identical)
// root nodes, so this exact call was incorrectly accepted.
func TestCreateBranch_CrossThreadGenesisRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	resultA, err := k.CreateThread("thread_genesis_x", "schema_main", "branch_genesis_x")
	if err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_genesis_y", "schema_main", "branch_genesis_y"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	err = k.CreateBranch("branch_cross_thread_genesis", "thread_genesis_y", resultA.RootTurnNodeHash)
	requireErrCode(t, err, kernel.ErrTurnNodeThreadMismatch)
}

func TestSetBranchHead_LateralMovementRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}

	// Advance branch_main itself with its own step first, so its current
	// head is no longer the shared root.
	mainEventHash := k.PutObject("application/json", []byte("main-branch-event"))
	if err := k.CreateRun("run_main", "turn_main", "branch_main", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create main run: %v", err)
	}
	if _, err := k.CompleteStep("run_main", "only_step", mainEventHash, ""); err != nil {
		t.Fatalf("complete main step: %v", err)
	}

	// Fork a sibling branch from the same root, then advance the sibling
	// with its own run (tagged to a distinct event object so its node
	// doesn't collide with branch_main's) so it has a node the main
	// branch's head chain never passes through.
	if err := k.CreateBranch("branch_fork", "thread_a", result.RootTurnNodeHash); err != nil {
		t.Fatalf("fork: %v", err)
	}
	forkEventHash := k.PutObject("application/json", []byte("fork-branch-event"))
	if err := k.CreateRun("run_fork", "turn_fork", "branch_fork", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create fork run: %v", err)
	}
	forkNodeHash, err := k.CompleteStep("run_fork", "only_step", forkEventHash, "")
	if err != nil {
		t.Fatalf("complete fork step: %v", err)
	}

	err = k.SetBranchHead("branch_main", forkNodeHash)
	requireErrCode(t, err, kernel.ErrLateralHeadMovement)
}

func TestSetBranchHead_ForwardMovementAccepted(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if err := k.CreateRun("run_main", "turn_main", "branch_main", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run: %v", err)
	}
	nodeHash, err := k.CompleteStep("run_main", "only_step", "", "")
	if err != nil {
		t.Fatalf("complete step: %v", err)
	}
	if err := k.SetBranchHead("branch_main", nodeHash); err != nil {
		t.Fatalf("forward move: %v", err)
	}
}

func TestSetBranchHead_CrossThreadNodeRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	resultA, err := k.CreateThread("thread_a", "schema_main", "branch_a_main")
	if err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_b", "schema_main", "branch_b_main"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	distinguishingEventHash := k.PutObject("application/json", []byte("thread-a-only-event-2"))
	if err := k.CreateRun("run_a", "turn_a", "branch_a_main", "schema_main", resultA.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run a: %v", err)
	}
	nodeA, err := k.CompleteStep("run_a", "only_step", distinguishingEventHash, "")
	if err != nil {
		t.Fatalf("complete step a: %v", err)
	}

	err = k.SetBranchHead("branch_b_main", nodeA)
	requireErrCode(t, err, kernel.ErrTurnNodeThreadMismatch)
}

// TestSetBranchHead_BackwardMovementArchivesLineage is the P1-3 regression:
// a backward SetBranchHead move (moving to a strict ancestor of the
// branch's current head) must be treated as a distinct movement kind from
// lateral — an atomic archival rollback — rather than being rejected the
// same way a genuinely unrelated lateral move is. It must mint an archive
// branch preserving the abandoned head's lineage tip, fail any
// running/paused run on the branch that touches the abandoned segment, and
// only then move the branch head backward.
func TestSetBranchHead_BackwardMovementArchivesLineage(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_backward", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}

	steps := []kernel.StepDeclaration{
		{ID: "first", Deterministic: true, SideEffects: false},
		{ID: "second", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	nodeN1, err := k.CompleteStep("run_1", "first", "", "")
	if err != nil {
		t.Fatalf("complete first: %v", err)
	}
	nodeN2, err := k.CompleteStep("run_1", "second", "", "")
	if err != nil {
		t.Fatalf("complete second: %v", err)
	}

	// run_1 is still "running" (CompleteRun was never called) and its
	// CreatedTurnNodes [N1, N2] both fall inside the segment a rollback to
	// the root abandons.
	if err := k.SetBranchHead("branch_main", result.RootTurnNodeHash); err != nil {
		t.Fatalf("backward move: %v", err)
	}

	branch, ok := k.Backend.GetBranch("branch_main")
	if !ok || branch.HeadTurnNodeHash != result.RootTurnNodeHash {
		t.Fatalf("expected branch_main head to move back to the root, got %+v (ok=%v)", branch, ok)
	}

	var archive *kernel.Branch
	for _, candidate := range k.Backend.ListBranchesByThread("thread_backward") {
		candidate := candidate
		if candidate.ArchivedFromBranchID == "branch_main" {
			archive = &candidate
		}
	}
	if archive == nil {
		t.Fatal("expected a branch archived from branch_main")
	}
	if archive.HeadTurnNodeHash != nodeN2 {
		t.Fatalf("expected the archive branch to preserve the abandoned head %q, got %q", nodeN2, archive.HeadTurnNodeHash)
	}

	run, ok := k.Backend.GetRun("run_1")
	if !ok || run.Status != kernel.RunStatusFailed {
		t.Fatalf("expected run_1 to be failed after its lineage was rolled back, got %+v (ok=%v)", run, ok)
	}

	_ = nodeN1 // referenced only to document the abandoned segment's shape
}

// TestSetBranchHead_ForwardMovementWithActiveRunRejected is the P1-5
// regression: an explicit external forward head movement (not the implicit
// advance CompleteStep performs for its own run) must be rejected with
// ErrBranchHasActiveRun when the target branch has a running or paused run,
// even though the destination node is a legitimate descendant reachable
// through the thread's own lineage.
func TestSetBranchHead_ForwardMovementWithActiveRunRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_forward_active", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}

	steps := []kernel.StepDeclaration{
		{ID: "first", Deterministic: true, SideEffects: false},
		{ID: "second", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_main", "turn_main", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create main run: %v", err)
	}
	nodeN1, err := k.CompleteStep("run_main", "first", "", "")
	if err != nil {
		t.Fatalf("complete first: %v", err)
	}
	// run_main is still active (step "second" pending), and branch_main's
	// head is now N1.

	// Fork a sibling branch from N1 and advance it independently, minting
	// N2 as a legitimate child of N1 that branch_main's own head has not
	// yet reached.
	if err := k.CreateBranch("branch_side", "thread_forward_active", nodeN1); err != nil {
		t.Fatalf("fork: %v", err)
	}
	if err := k.CreateRun("run_side", "turn_side", "branch_side", "schema_main", nodeN1, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create side run: %v", err)
	}
	nodeN2, err := k.CompleteStep("run_side", "only_step", "", "")
	if err != nil {
		t.Fatalf("complete side step: %v", err)
	}

	// N2 is a strict descendant of branch_main's current head (N1), so this
	// is a genuine forward move — but branch_main still has run_main active.
	err = k.SetBranchHead("branch_main", nodeN2)
	requireErrCode(t, err, kernel.ErrBranchHasActiveRun)
}

// --- run lifecycle ---

func TestCreateRun_SecondActiveRunOnBranchRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run 1: %v", err)
	}
	err = k.CreateRun("run_2", "turn_2", "branch_main", "schema_main", result.RootTurnNodeHash, steps)
	requireErrCode(t, err, kernel.ErrBranchAlreadyActive)
}

func TestBeginStep_OutOfOrderRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "first", Deterministic: true, SideEffects: false},
		{ID: "second", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	err = k.BeginStep("run_1", "second")
	requireErrCode(t, err, kernel.ErrUnexpectedStep)
}

func TestCompleteStep_MissingEventObjectRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	missingEventHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	_, err = k.CompleteStep("run_1", "only_step", missingEventHash, "")
	requireErrCode(t, err, kernel.ErrMissingEventObject)
}

func TestCompleteStep_ExistingEventObjectAccepted(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	eventHash := k.PutObject("application/json", []byte("event-payload"))

	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := k.CompleteStep("run_1", "only_step", eventHash, ""); err != nil {
		t.Fatalf("complete step: %v", err)
	}
}

func TestCompleteRun_MissingEventObjectRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := k.CompleteStep("run_1", "only_step", "", ""); err != nil {
		t.Fatalf("complete step: %v", err)
	}

	err = k.CompleteRun("run_1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	requireErrCode(t, err, kernel.ErrMissingEventObject)
}

// TestCreateRun_BranchHeadMismatchRejected is the P1-4 regression: a run's
// declared startTurnNodeHash must equal its target branch's *current* head.
func TestCreateRun_BranchHeadMismatchRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := k.CreateThread("thread_a", "schema_main", "branch_main"); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	staleHash := kernel.HashBytesToHex([]byte("stale-turn-node"))
	err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", staleHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	})
	requireErrCode(t, err, kernel.ErrRunBranchHeadMismatch)
}

// TestCreateRun_DuplicateStepIDRejected is the P1-4 regression: a run's
// declared step sequence must not repeat a step id.
func TestCreateRun_DuplicateStepIDRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}

	err = k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "dup", Deterministic: true, SideEffects: false},
		{ID: "dup", Deterministic: true, SideEffects: false},
	})
	requireErrCode(t, err, kernel.ErrDuplicateStepID)
}

// TestCompleteStep_EvolvesTurnTreeAcrossCheckpoints is the P1-1 regression:
// CompleteStep must incorporate staged results into the turn tree per the
// schema's incorporation rules when no explicit treeHash is supplied, and
// each checkpoint that stages new results must produce a distinct turn
// tree hash reflecting the accumulated state.
func TestCompleteStep_EvolvesTurnTreeAcrossCheckpoints(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_evolve", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "first", Deterministic: true, SideEffects: false},
		{ID: "second", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	message1 := kernel.StagedResult{
		TaskID: "m1", ObjectHash: kernel.HashBytesToHex([]byte("message-1")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 1,
	}
	if err := k.StageResult("run_1", message1); err != nil {
		t.Fatalf("stage message1: %v", err)
	}
	nodeN1, err := k.CompleteStep("run_1", "first", "", "")
	if err != nil {
		t.Fatalf("complete first: %v", err)
	}

	nodeAfterFirst, ok := k.Backend.GetTurnNode(nodeN1)
	if !ok {
		t.Fatalf("expected turn node %q to exist", nodeN1)
	}
	if nodeAfterFirst.TurnTreeHash == result.RootTurnTreeHash {
		t.Fatalf("expected the first checkpoint's tree to differ from the root tree once a message was incorporated")
	}
	treeAfterFirst, ok := k.Backend.GetTurnTree(nodeAfterFirst.TurnTreeHash)
	if !ok {
		t.Fatalf("expected turn tree %q to exist", nodeAfterFirst.TurnTreeHash)
	}
	if treeAfterFirst.Manifest["messages"].Kind != kernel.PathValueOrderedKind || len(treeAfterFirst.Manifest["messages"].Ordered) != 1 || treeAfterFirst.Manifest["messages"].Ordered[0] != message1.ObjectHash {
		t.Fatalf("expected messages to contain exactly [%q], got %+v", message1.ObjectHash, treeAfterFirst.Manifest["messages"])
	}

	message2 := kernel.StagedResult{
		TaskID: "m2", ObjectHash: kernel.HashBytesToHex([]byte("message-2")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 2,
	}
	if err := k.StageResult("run_1", message2); err != nil {
		t.Fatalf("stage message2: %v", err)
	}
	nodeN2, err := k.CompleteStep("run_1", "second", "", "")
	if err != nil {
		t.Fatalf("complete second: %v", err)
	}

	nodeAfterSecond, ok := k.Backend.GetTurnNode(nodeN2)
	if !ok {
		t.Fatalf("expected turn node %q to exist", nodeN2)
	}
	if nodeAfterSecond.TurnTreeHash == nodeAfterFirst.TurnTreeHash {
		t.Fatalf("expected the second checkpoint's tree to differ from the first once a second message was incorporated")
	}
	treeAfterSecond, ok := k.Backend.GetTurnTree(nodeAfterSecond.TurnTreeHash)
	if !ok {
		t.Fatalf("expected turn tree %q to exist", nodeAfterSecond.TurnTreeHash)
	}
	got := treeAfterSecond.Manifest["messages"].Ordered
	if len(got) != 2 || got[0] != message1.ObjectHash || got[1] != message2.ObjectHash {
		t.Fatalf("expected messages to accumulate to [%q, %q], got %+v", message1.ObjectHash, message2.ObjectHash, got)
	}
}

// TestCompleteStep_ExplicitTreeHashHonored is the P1-1 regression covering
// the explicit-treeHash path: when a caller supplies treeHash, CompleteStep
// must check the run into that tree instead of deriving one from staged
// results, and must reject a treeHash from a foreign schema.
func TestCompleteStep_ExplicitTreeHashHonored(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_explicit_tree", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	precomputedHash := kernel.HashBytesToHex([]byte("precomputed-manifest-value"))
	explicitTreeHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"context.manifest": {Kind: kernel.PathValueSingleKind, Single: precomputedHash},
	}, &result.RootTurnTreeHash)
	if err != nil {
		t.Fatalf("create explicit tree: %v", err)
	}

	nodeHash, err := k.CompleteStep("run_1", "only_step", "", explicitTreeHash)
	if err != nil {
		t.Fatalf("complete step with explicit tree: %v", err)
	}
	node, ok := k.Backend.GetTurnNode(nodeHash)
	if !ok || node.TurnTreeHash != explicitTreeHash {
		t.Fatalf("expected the checkpoint to use the explicit tree %q, got %+v (ok=%v)", explicitTreeHash, node, ok)
	}
	if err := k.CompleteRun("run_1", ""); err != nil {
		t.Fatalf("complete run 1: %v", err)
	}

	// A treeHash built against a different schema must be rejected.
	otherSchema := kernel.TurnTreeSchema{SchemaID: "schema_explicit_other", Paths: []kernel.PathDefinition{
		{Path: "solo", Collection: kernel.PathCollectionSingle},
	}}
	if err := k.RegisterSchema(otherSchema); err != nil {
		t.Fatalf("register other schema: %v", err)
	}
	foreignTreeHash, err := k.CreateTurnTree("schema_explicit_other", map[string]kernel.PathValue{"solo": {Kind: kernel.PathValueNull}}, nil)
	if err != nil {
		t.Fatalf("create foreign tree: %v", err)
	}

	if err := k.CreateRun("run_2", "turn_2", "branch_main", "schema_main", nodeHash, []kernel.StepDeclaration{
		{ID: "only_step_2", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run 2: %v", err)
	}
	_, err = k.CompleteStep("run_2", "only_step_2", "", foreignTreeHash)
	requireErrCode(t, err, kernel.ErrTreeSchemaMismatch)
}

// TestCompleteRun_ReactiveCheckpointAnchorsUncommittedWork is the P1-2
// regression: CompleteRun must reactively checkpoint (and incorporate) any
// staged results left un-anchored since the run's last step boundary,
// rather than silently abandoning them.
func TestCompleteRun_ReactiveCheckpointAnchorsUncommittedWork(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_reactive", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := k.CompleteStep("run_1", "only_step", "", ""); err != nil {
		t.Fatalf("complete step: %v", err)
	}

	// Stage work *after* the last declared step's checkpoint — this is
	// exactly the "un-anchored since the last step boundary" work §5.6
	// requires CompleteRun to reactively checkpoint before completing.
	trailingMessage := kernel.StagedResult{
		TaskID: "trailing", ObjectHash: kernel.HashBytesToHex([]byte("trailing-message")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 1,
	}
	if err := k.StageResult("run_1", trailingMessage); err != nil {
		t.Fatalf("stage trailing: %v", err)
	}

	branchBefore, ok := k.Backend.GetBranch("branch_main")
	if !ok {
		t.Fatal("expected branch_main to exist")
	}

	if err := k.CompleteRun("run_1", ""); err != nil {
		t.Fatalf("complete run: %v", err)
	}

	run, ok := k.Backend.GetRun("run_1")
	if !ok || run.Status != kernel.RunStatusCompleted {
		t.Fatalf("expected run_1 to be completed, got %+v (ok=%v)", run, ok)
	}
	if len(run.CreatedTurnNodes) != 2 {
		t.Fatalf("expected CompleteRun to have minted a reactive checkpoint turn node, got %d created turn nodes", len(run.CreatedTurnNodes))
	}

	branchAfter, ok := k.Backend.GetBranch("branch_main")
	if !ok {
		t.Fatal("expected branch_main to exist")
	}
	if branchAfter.HeadTurnNodeHash == branchBefore.HeadTurnNodeHash {
		t.Fatal("expected the reactive checkpoint to advance branch_main's head")
	}

	finalNode, ok := k.Backend.GetTurnNode(branchAfter.HeadTurnNodeHash)
	if !ok {
		t.Fatalf("expected turn node %q to exist", branchAfter.HeadTurnNodeHash)
	}
	tree, ok := k.Backend.GetTurnTree(finalNode.TurnTreeHash)
	if !ok {
		t.Fatalf("expected turn tree %q to exist", finalNode.TurnTreeHash)
	}
	got := tree.Manifest["messages"].Ordered
	if len(got) != 1 || got[0] != trailingMessage.ObjectHash {
		t.Fatalf("expected messages to contain the reactively checkpointed trailing message [%q], got %+v", trailingMessage.ObjectHash, got)
	}
	if len(finalNode.ConsumedStagedResults) != 1 || finalNode.ConsumedStagedResults[0].TaskID != "trailing" {
		t.Fatalf("expected the reactive checkpoint's node to record the trailing staged result as consumed, got %+v", finalNode.ConsumedStagedResults)
	}
}

// TestCompleteRun_NoOpWhenNothingStaged proves CompleteRun's reactive
// checkpoint is conditional: a run with nothing staged and no eventHash
// since its last step boundary completes without minting an extra turn
// node.
func TestCompleteRun_NoOpWhenNothingStaged(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_reactive_noop", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := k.CompleteStep("run_1", "only_step", "", ""); err != nil {
		t.Fatalf("complete step: %v", err)
	}

	branchBefore, ok := k.Backend.GetBranch("branch_main")
	if !ok {
		t.Fatal("expected branch_main to exist")
	}

	if err := k.CompleteRun("run_1", ""); err != nil {
		t.Fatalf("complete run: %v", err)
	}

	branchAfter, ok := k.Backend.GetBranch("branch_main")
	if !ok {
		t.Fatal("expected branch_main to exist")
	}
	if branchAfter.HeadTurnNodeHash != branchBefore.HeadTurnNodeHash {
		t.Fatal("expected branch_main's head to stay put when CompleteRun had nothing to reactively checkpoint")
	}

	run, ok := k.Backend.GetRun("run_1")
	if !ok || len(run.CreatedTurnNodes) != 1 {
		t.Fatalf("expected exactly the one turn node CompleteStep created, got %+v (ok=%v)", run, ok)
	}
}

// --- staged results / recovery state ---

func TestRecoveryState_MatchesRustReferenceScenario(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_recovery", "schema_main", "branch_recovery")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "model_call", Deterministic: false, SideEffects: false},
		{ID: "tool_execution", Deterministic: false, SideEffects: true},
	}
	if err := k.CreateRun("run_recovery", "turn_recovery", "branch_recovery", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	preFixture := kernel.StagedResult{
		TaskID: "pre_fixture_consumed", ObjectHash: kernel.HashBytesToHex([]byte("pre")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 1,
	}
	if err := k.StageResult("run_recovery", preFixture); err != nil {
		t.Fatalf("stage pre-fixture: %v", err)
	}
	if _, err := k.CompleteStep("run_recovery", "model_call", "", ""); err != nil {
		t.Fatalf("complete model_call: %v", err)
	}

	// objectType "message" (not "tool_result"): CompleteStep now evolves the
	// turn tree by incorporating consumed staged results per the schema's
	// incorporation rules (P1-1), and canonicalSchema only declares rules
	// for "message" and "context_manifest" — matching how the shared
	// kernel-protocol-logical fixture only ever completes a step with
	// "message"-typed staged results, leaving "tool_result" data
	// permanently uncommitted.
	consumed := kernel.StagedResult{
		TaskID: "consumed", ObjectHash: kernel.HashBytesToHex([]byte("consumed")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 2,
	}
	if err := k.StageResult("run_recovery", consumed); err != nil {
		t.Fatalf("stage consumed: %v", err)
	}
	if _, err := k.CompleteStep("run_recovery", "tool_execution", "", ""); err != nil {
		t.Fatalf("complete tool_execution: %v", err)
	}

	uncommitted := kernel.StagedResult{
		TaskID: "uncommitted", ObjectHash: kernel.HashBytesToHex([]byte("uncommitted")),
		ObjectType: "tool_result", Status: kernel.StagedResultInterrupted, Timestamp: 3,
		InterruptPayload: kernel.RecordText("paused"),
	}
	if err := k.StageResult("run_recovery", uncommitted); err != nil {
		t.Fatalf("stage uncommitted: %v", err)
	}

	state, err := k.RecoveryState("run_recovery")
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if !state.HasLastCompletedStepID || state.LastCompletedStepID != "tool_execution" {
		t.Fatalf("expected lastCompletedStepId tool_execution, got %+v", state)
	}
	if len(state.ConsumedStagedResults) != 1 || state.ConsumedStagedResults[0].TaskID != "consumed" {
		t.Fatalf("expected exactly the tool_execution checkpoint's consumed result, got %+v", state.ConsumedStagedResults)
	}
	if len(state.UncommittedStagedResults) != 1 || state.UncommittedStagedResults[0].TaskID != "uncommitted" {
		t.Fatalf("expected exactly one uncommitted staged result, got %+v", state.UncommittedStagedResults)
	}
}

// --- thread enumeration ---

func TestListThreads_DeterministicOrderAndCursorPaging(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := k.CreateThread("thread_enum_a", "schema_main", "branch_enum_a"); err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_enum_b", "schema_main", "branch_enum_b"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	all, cursor, err := k.ListThreads(0, "")
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 2 || cursor != "" {
		t.Fatalf("expected 2 threads and no cursor, got %d threads, cursor=%q", len(all), cursor)
	}
	if all[0].ThreadID != "thread_enum_a" {
		t.Fatalf("expected thread_enum_a first, got %q", all[0].ThreadID)
	}

	page, nextCursor, err := k.ListThreads(1, "")
	if err != nil {
		t.Fatalf("list page: %v", err)
	}
	if len(page) != 1 || page[0].ThreadID != "thread_enum_a" {
		t.Fatalf("expected a 1-item page starting at thread_enum_a, got %+v", page)
	}
	if nextCursor == "" {
		t.Fatal("expected a non-empty next cursor when the page was truncated")
	}

	rest, restCursor, err := k.ListThreads(10, nextCursor)
	if err != nil {
		t.Fatalf("list rest: %v", err)
	}
	if len(rest) != 1 || rest[0].ThreadID != "thread_enum_b" {
		t.Fatalf("expected thread_enum_b to be the only remaining thread, got %+v", rest)
	}
	if restCursor != "" {
		t.Fatalf("expected no further cursor, got %q", restCursor)
	}
}

// recordFromSchema builds a kernel.Record for a TurnTreeSchema so
// validate_test-style scenarios can exercise ValidateTurnTreeSchema
// directly without going through JSON.
func recordFromSchema(schema kernel.TurnTreeSchema) (kernel.Record, error) {
	paths := make(kernel.RecordArray, 0, len(schema.Paths))
	for _, p := range schema.Paths {
		paths = append(paths, kernel.RecordMap{
			"path":       kernel.RecordText(p.Path),
			"collection": kernel.RecordText(string(p.Collection)),
		})
	}
	rules := make(kernel.RecordArray, 0, len(schema.IncorporationRules))
	for _, r := range schema.IncorporationRules {
		rules = append(rules, kernel.RecordMap{
			"objectType": kernel.RecordText(r.ObjectType),
			"targetPath": kernel.RecordText(r.TargetPath),
		})
	}
	return kernel.RecordMap{
		"schemaId":           kernel.RecordText(schema.SchemaID),
		"paths":              paths,
		"incorporationRules": rules,
	}, nil
}
