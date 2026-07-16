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

func TestReclamation_UnsupportedBackendRejectsWithCapabilityError(t *testing.T) {
	k, _ := newReclaimKernel(t, 0)
	baseBackend := k.Backend
	k.Backend = kernel.NewFaultInjectingBackend(baseBackend, kernel.FaultPlan{Point: kernel.FaultPointBeforeCommit, Policy: kernel.FaultPolicyOnce})
	_, err := k.Reclaim()
	requireErrCode(t, err, kernel.ErrCapabilityUnsupported)
}
