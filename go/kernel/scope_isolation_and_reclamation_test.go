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
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

// --- kernel.scope-isolation ---

func newScopedKernelPair(t *testing.T) (*kernel.Kernel, *kernel.Kernel) {
	t.Helper()
	store := kernel.NewMemoryScopeStore()
	clock := &kernel.IncrementingClock{}
	backendA := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.test-a")
	backendB := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.test-b")
	return kernel.NewKernel("scope-a", clock, backendA), kernel.NewKernel("scope-b", clock, backendB)
}

func TestScopeIsolation_StoreHasIsScopeConfined(t *testing.T) {
	kernelA, kernelB := newScopedKernelPair(t)
	hash := kernelA.PutObject("application/json", []byte("scope-a content"))

	if !kernelA.HasObject(hash) {
		t.Fatalf("expected same-scope HasObject to observe own content")
	}
	if kernelB.HasObject(hash) {
		t.Fatalf("expected cross-scope HasObject to observe nothing")
	}
}

func TestScopeIsolation_StoreGetIsScopeConfined(t *testing.T) {
	kernelA, kernelB := newScopedKernelPair(t)
	hash := kernelA.PutObject("application/json", []byte("scope-a content"))

	if _, ok := kernelA.Backend.GetObject(hash); !ok {
		t.Fatalf("expected same-scope GetObject to return the object")
	}
	if _, ok := kernelB.Backend.GetObject(hash); ok {
		t.Fatalf("expected cross-scope GetObject to return nothing")
	}
}

func TestScopeIsolation_EnumerationIsScopeConfined(t *testing.T) {
	kernelA, kernelB := newScopedKernelPair(t)
	if err := kernelA.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	if _, err := kernelA.CreateThread("thread_scope_probe", "schema_main", "branch_scope_probe"); err != nil {
		t.Fatalf("create thread: %v", err)
	}

	threadsA, _, err := kernelA.ListThreads(0, "")
	if err != nil {
		t.Fatalf("list threads (A): %v", err)
	}
	sameScopeVisible := false
	for _, thread := range threadsA {
		if thread.ThreadID == "thread_scope_probe" {
			sameScopeVisible = true
		}
	}
	if !sameScopeVisible {
		t.Fatalf("expected same-scope thread enumeration to include the created thread")
	}

	threadsB, _, err := kernelB.ListThreads(0, "")
	if err != nil {
		t.Fatalf("list threads (B): %v", err)
	}
	for _, thread := range threadsB {
		if thread.ThreadID == "thread_scope_probe" {
			t.Fatalf("expected cross-scope thread enumeration to exclude the created thread")
		}
	}
}

func TestScopeIsolation_SameScopeSameStoreSharesState(t *testing.T) {
	store := kernel.NewMemoryScopeStore()
	clock := &kernel.IncrementingClock{}
	backend1 := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.shared")
	backend2 := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.shared")
	kernel1 := kernel.NewKernel("shared", clock, backend1)
	kernel2 := kernel.NewKernel("shared", clock, backend2)

	hash := kernel1.PutObject("application/json", []byte("shared content"))
	if !kernel2.HasObject(hash) {
		t.Fatalf("expected two handles bound to the same store and scope to share committed state")
	}
}

// --- kernel.reclamation ---

func newReclaimKernel(t *testing.T, startMs int64) (*kernel.Kernel, *kernel.ManualClock) {
	t.Helper()
	clock := kernel.NewManualClock(startMs)
	backend := kernel.NewInMemoryBackend(clock)
	k := kernel.NewKernel("reclaim-scope", clock, backend)
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema: %v", err)
	}
	return k, clock
}

func TestReclamation_UnreachablePastGraceReleased(t *testing.T) {
	k, _ := newReclaimKernel(t, 0)
	orphan := k.PutObject("application/octet-stream", []byte("unreachable-orphan"))

	if !k.HasObject(orphan) {
		t.Fatalf("expected orphan present before reclaim")
	}
	summary, err := k.Reclaim()
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if summary.ReleasedObjectCount < 1 {
		t.Fatalf("expected at least 1 released object, got %d", summary.ReleasedObjectCount)
	}
	if k.HasObject(orphan) {
		t.Fatalf("expected unreachable orphan (no active lease, past grace) to be released")
	}
}

func TestReclamation_ArchivedBranchExclusiveLineageReleased(t *testing.T) {
	k, _ := newReclaimKernel(t, 0)
	created, err := k.CreateThread("thread_reclaim_archive", "schema_main", "branch_reclaim_archive")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}

	sharedMessage := k.PutObject("application/json", []byte("shared-across-live-and-archived"))
	sharedTree, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{sharedMessage}},
	}, &created.RootTurnTreeHash)
	if err != nil {
		t.Fatalf("create shared turn tree: %v", err)
	}
	sharedNode, err := k.CommitSiblingCheckpoint("branch_reclaim_archive", created.RootTurnNodeHash, kernel.TurnNode{
		SchemaID:     "schema_main",
		TurnTreeHash: sharedTree,
	})
	if err != nil {
		t.Fatalf("commit shared checkpoint: %v", err)
	}

	archivedOnlyMessage := k.PutObject("application/json", []byte("archived-exclusive-payload"))
	archivedTree, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{sharedMessage, archivedOnlyMessage}},
	}, &sharedTree)
	if err != nil {
		t.Fatalf("create archived turn tree: %v", err)
	}
	archivedNode, err := k.CommitSiblingCheckpoint("branch_reclaim_archive", sharedNode, kernel.TurnNode{
		SchemaID:     "schema_main",
		TurnTreeHash: archivedTree,
	})
	if err != nil {
		t.Fatalf("commit archived checkpoint: %v", err)
	}

	// Roll the live head back to the shared ancestor: the forward segment
	// (archivedNode) is archived into an archive branch and becomes
	// unreferenced by any live root.
	if err := k.SetBranchHead("branch_reclaim_archive", sharedNode); err != nil {
		t.Fatalf("rollback set head: %v", err)
	}

	summary, err := k.Reclaim()
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if summary.ReleasedArchivedBranchCount < 1 {
		t.Fatalf("expected at least 1 released archived branch, got %d", summary.ReleasedArchivedBranchCount)
	}

	if !k.HasObject(sharedMessage) {
		t.Fatalf("expected shared object retained via the live branch head")
	}
	if k.HasObject(archivedOnlyMessage) {
		t.Fatalf("expected archive-exclusive object released")
	}
	if _, ok := k.Backend.GetTurnNode(archivedNode); ok {
		t.Fatalf("expected archived-exclusive turn node released")
	}
	if _, ok := k.Backend.GetTurnNode(sharedNode); !ok {
		t.Fatalf("expected shared (live-root-reachable) turn node retained")
	}
}

func TestReclamation_GraceWindowHeldUnderActiveLease(t *testing.T) {
	k, clock := newReclaimKernel(t, 0)

	clock.SetMs(10)
	orphanBeforeLease := k.PutObject("application/octet-stream", []byte{1})

	clock.SetMs(20)
	created, err := k.CreateThread("thread_reclaim_grace", "schema_main", "branch_reclaim_grace")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	// An active (running) run holds the oldest execution lease at t=20.
	if err := k.CreateRun("run_reclaim_grace", "turn_reclaim_grace", "branch_reclaim_grace", "schema_main", created.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "work", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run: %v", err)
	}

	clock.SetMs(30)
	orphanAfterLease := k.PutObject("application/octet-stream", []byte{2})

	clock.SetMs(40)
	if _, err := k.Reclaim(); err != nil {
		t.Fatalf("reclaim: %v", err)
	}

	if k.HasObject(orphanBeforeLease) {
		t.Fatalf("expected the older orphan (before the lease horizon) to be released")
	}
	if !k.HasObject(orphanAfterLease) {
		t.Fatalf("expected the newer orphan (after the lease horizon) to be retained despite being unreachable")
	}
}

func TestReclamation_LeaselessRunPastAdminExpiryDoesNotPinReclamation(t *testing.T) {
	k, clock := newReclaimKernel(t, 0)
	created, err := k.CreateThread("thread_leaseless_expired", "schema_main", "branch_leaseless_expired")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if err := k.CreateRun("run_leaseless_expired", "turn_leaseless_expired", "branch_leaseless_expired", "schema_main", created.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "work", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run: %v", err)
	}

	clock.SetMs(10)
	orphan := k.PutObject("application/octet-stream", []byte("leaseless-expiry-orphan"))

	// Past the run's UpdatedAtMs (t=0) by more than the 24h default
	// leaseless-expiry horizon: the run is excluded from pinning the grace
	// horizon, so this orphan (created after the run, at t=10) becomes
	// reclaimable.
	clock.SetMs(kernel.LeaselessRunExpiryMs + 5000)
	if _, err := k.Reclaim(); err != nil {
		t.Fatalf("reclaim: %v", err)
	}

	if k.HasObject(orphan) {
		t.Fatalf("expected a leaseless run past the 24h admin-expiry horizon to stop pinning reclamation")
	}
}

func TestReclamation_LeaselessRunWithinAdminExpiryStillPinsReclamation(t *testing.T) {
	k, clock := newReclaimKernel(t, 0)
	created, err := k.CreateThread("thread_leaseless_active", "schema_main", "branch_leaseless_active")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if err := k.CreateRun("run_leaseless_active", "turn_leaseless_active", "branch_leaseless_active", "schema_main", created.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "work", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run: %v", err)
	}

	clock.SetMs(10)
	orphan := k.PutObject("application/octet-stream", []byte("leaseless-active-orphan"))

	// Well under the 24h expiry horizon since run creation at t=0: the run
	// still pins the grace horizon, so this orphan stays retained.
	clock.SetMs(1000)
	if _, err := k.Reclaim(); err != nil {
		t.Fatalf("reclaim: %v", err)
	}

	if !k.HasObject(orphan) {
		t.Fatalf("expected a leaseless run within the 24h admin-expiry horizon to still pin reclamation")
	}
}

// TestReclamation_CrossScopeConfinement proves Reclaim() run on one scope
// of a MemoryScopeStore shared by two scopes never touches the other
// scope's durable state — not just via the reclaiming kernel's own
// scope-confined view (that would just repeat the scope-isolation tests
// above), but via raw same-store reads bound directly to the untouched
// scope, so a hypothetical Reclaim() that scanned or mutated the whole
// shared store instead of its own scope would be caught here.
func TestReclamation_CrossScopeConfinement(t *testing.T) {
	store := kernel.NewMemoryScopeStore()
	clock := kernel.NewManualClock(0)

	backendA := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.reclaim-a")
	backendB := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.reclaim-b")
	kernelA := kernel.NewKernel("reclaim-a", clock, backendA)
	kernelB := kernel.NewKernel("reclaim-b", clock, backendB)

	if err := kernelA.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema (A): %v", err)
	}
	if err := kernelB.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register schema (B): %v", err)
	}

	// Scope A: an unreachable, unleased orphan object — exactly the shape
	// Reclaim() releases within its own scope.
	orphanA := kernelA.PutObject("application/octet-stream", []byte("scope-a-orphan"))

	// Scope B: a live thread/branch/run plus an object reachable from that
	// run's turn tree, so scope B has real threads, branches, turn nodes,
	// and a run for the confinement check to observe.
	createdB, err := kernelB.CreateThread("thread_scope_b", "schema_main", "branch_scope_b")
	if err != nil {
		t.Fatalf("create thread (B): %v", err)
	}
	if err := kernelB.CreateRun("run_scope_b", "turn_scope_b", "branch_scope_b", "schema_main", createdB.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "work", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run (B): %v", err)
	}
	reachableB := kernelB.PutObject("application/json", []byte("scope-b-reachable"))
	treeB, err := kernelB.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{reachableB}},
	}, &createdB.RootTurnTreeHash)
	if err != nil {
		t.Fatalf("create turn tree (B): %v", err)
	}
	nodeB, err := kernelB.CommitSiblingCheckpoint("branch_scope_b", createdB.RootTurnNodeHash, kernel.TurnNode{
		SchemaID: "schema_main", TurnTreeHash: treeB,
	})
	if err != nil {
		t.Fatalf("commit checkpoint (B): %v", err)
	}
	// Also an unreachable orphan in scope B, so the confinement assertion
	// below is meaningful (scope B has its own reclaimable state that
	// Reclaim() on scope A must not touch either way).
	orphanB := kernelB.PutObject("application/octet-stream", []byte("scope-b-orphan"))

	// Snapshot scope B's durable state via a *second, independent* backend
	// handle bound to the same store and scope B — a raw read path that
	// does not go through kernelB at all — before reclaiming scope A.
	rawB := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.reclaim-b")
	branchBefore, ok := rawB.GetBranch("branch_scope_b")
	if !ok {
		t.Fatalf("raw read: branch_scope_b not found before scope-A reclaim")
	}
	runBefore, ok := rawB.GetRun("run_scope_b")
	if !ok {
		t.Fatalf("raw read: run_scope_b not found before scope-A reclaim")
	}
	nodeBefore, ok := rawB.GetTurnNode(nodeB)
	if !ok {
		t.Fatalf("raw read: turn node %q not found before scope-A reclaim", nodeB)
	}
	if !rawB.HasObject(reachableB) {
		t.Fatalf("raw read: reachable object not found before scope-A reclaim")
	}
	if !rawB.HasObject(orphanB) {
		t.Fatalf("raw read: orphan object not found before scope-A reclaim")
	}
	threadsBefore := rawB.ListThreads()

	clock.SetMs(1_000_000) // well past any grace horizon, so scope A's own orphan is genuinely reclaimable
	summary, err := kernelA.Reclaim()
	if err != nil {
		t.Fatalf("reclaim (A): %v", err)
	}
	if summary.ReleasedObjectCount < 1 {
		t.Fatalf("expected scope A's reclaim to release its own orphan, got summary %+v", summary)
	}
	if kernelA.HasObject(orphanA) {
		t.Fatalf("expected scope A's own orphan to be released by its own reclaim")
	}

	// --- scope B, read raw, must be byte-for-byte untouched ---

	branchAfter, ok := rawB.GetBranch("branch_scope_b")
	if !ok {
		t.Fatalf("raw read: branch_scope_b missing after scope-A reclaim")
	}
	if branchAfter.HeadTurnNodeHash != branchBefore.HeadTurnNodeHash {
		t.Fatalf("expected scope B's branch head untouched by scope-A reclaim, got %q (was %q)", branchAfter.HeadTurnNodeHash, branchBefore.HeadTurnNodeHash)
	}

	runAfter, ok := rawB.GetRun("run_scope_b")
	if !ok {
		t.Fatalf("raw read: run_scope_b missing after scope-A reclaim")
	}
	if runAfter.Status != runBefore.Status || runAfter.CurrentStepIndex != runBefore.CurrentStepIndex {
		t.Fatalf("expected scope B's run record untouched by scope-A reclaim, got %+v (was %+v)", runAfter, runBefore)
	}

	if _, ok := rawB.GetTurnNode(nodeB); !ok {
		t.Fatalf("expected scope B's turn node %q to remain present after scope-A reclaim", nodeB)
	}
	if nodeAfter, _ := rawB.GetTurnNode(nodeB); nodeAfter.TurnTreeHash != nodeBefore.TurnTreeHash {
		t.Fatalf("expected scope B's turn node content untouched by scope-A reclaim")
	}

	if !rawB.HasObject(reachableB) {
		t.Fatalf("expected scope B's reachable object to remain present after scope-A reclaim")
	}
	if !rawB.HasObject(orphanB) {
		t.Fatalf("expected scope B's own orphan to remain untouched by scope-A's reclaim (only scope B's own Reclaim() may release it)")
	}

	threadsAfter := rawB.ListThreads()
	if len(threadsAfter) != len(threadsBefore) {
		t.Fatalf("expected scope B's thread enumeration untouched by scope-A reclaim, got %d threads (was %d)", len(threadsAfter), len(threadsBefore))
	}

	// Finally, scope B's own object/thread/branch/run set must also still
	// be independently visible through kernelB itself.
	if !kernelB.HasObject(reachableB) {
		t.Fatalf("expected kernelB to still observe its own reachable object after scope-A reclaim")
	}
	if !kernelB.HasObject(orphanB) {
		t.Fatalf("expected kernelB to still observe its own orphan after scope-A reclaim (untouched by scope A's reclaim)")
	}
}

func TestReclamation_UnsupportedBackendRejectsWithCapabilityError(t *testing.T) {
	k, _ := newReclaimKernel(t, 0)
	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{Point: kernel.FaultPointBeforeCommit, Policy: kernel.FaultPolicyOnce})
	_, err := k.Reclaim()
	requireErrCode(t, err, kernel.ErrCapabilityUnsupported)
}
