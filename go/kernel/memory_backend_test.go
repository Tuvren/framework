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

// TestInMemoryBackend_GetTurnTree_ReturnsDefensiveCopy is the P2-2
// regression: mutating a manifest returned by GetTurnTree (including an
// ordered PathValue's backing slice within it) must not corrupt the
// backend's stored state.
func TestInMemoryBackend_GetTurnTree_ReturnsDefensiveCopy(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	treeHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{"a", "b"}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create tree: %v", err)
	}

	first, ok := k.Backend.GetTurnTree(treeHash)
	if !ok {
		t.Fatalf("expected tree %q to exist", treeHash)
	}

	// Mutate the returned manifest map itself...
	first.Manifest["messages"] = kernel.PathValue{Kind: kernel.PathValueSingleKind, Single: "corrupted"}
	// ...and the backing slice of an ordered value obtained before that
	// overwrite.
	second, ok := k.Backend.GetTurnTree(treeHash)
	if !ok {
		t.Fatalf("expected tree %q to exist", treeHash)
	}
	second.Manifest["messages"].Ordered[0] = "corrupted-in-place"

	third, ok := k.Backend.GetTurnTree(treeHash)
	if !ok {
		t.Fatalf("expected tree %q to exist", treeHash)
	}
	if third.Manifest["messages"].Kind != kernel.PathValueOrderedKind {
		t.Fatalf("expected messages to remain an ordered value, got %+v", third.Manifest["messages"])
	}
	got := third.Manifest["messages"].Ordered
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("expected the stored manifest to be unchanged by mutating returned copies, got %+v", got)
	}
}

// TestInMemoryBackend_GetTurnNode_ReturnsDefensiveCopy is the P2-2
// regression: mutating a ConsumedStagedResults slice returned by
// GetTurnNode must not corrupt the backend's stored state.
func TestInMemoryBackend_GetTurnNode_ReturnsDefensiveCopy(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_defensive", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	staged := kernel.StagedResult{
		TaskID: "task", ObjectHash: kernel.HashBytesToHex([]byte("message-defensive")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 1,
	}
	if err := k.StageResult("run_1", staged); err != nil {
		t.Fatalf("stage: %v", err)
	}
	nodeHash, err := k.CompleteStep("run_1", "only_step", "", "")
	if err != nil {
		t.Fatalf("complete step: %v", err)
	}

	first, ok := k.Backend.GetTurnNode(nodeHash)
	if !ok {
		t.Fatalf("expected turn node %q to exist", nodeHash)
	}
	if len(first.ConsumedStagedResults) != 1 {
		t.Fatalf("expected exactly one consumed staged result, got %d", len(first.ConsumedStagedResults))
	}

	// Mutate the returned slice's element in place, then append to it too.
	first.ConsumedStagedResults[0].TaskID = "corrupted"
	first.ConsumedStagedResults = append(first.ConsumedStagedResults, kernel.StagedResult{TaskID: "injected"})

	second, ok := k.Backend.GetTurnNode(nodeHash)
	if !ok {
		t.Fatalf("expected turn node %q to exist", nodeHash)
	}
	if len(second.ConsumedStagedResults) != 1 {
		t.Fatalf("expected the stored node to still have exactly one consumed staged result, got %d: %+v", len(second.ConsumedStagedResults), second.ConsumedStagedResults)
	}
	if second.ConsumedStagedResults[0].TaskID != "task" {
		t.Fatalf("expected the stored consumed staged result's taskId to be unchanged, got %q", second.ConsumedStagedResults[0].TaskID)
	}
}

// TestInMemoryBackend_ThreadRootOwnershipIndex proves PutThread /
// GetThreadByRootTurnNode's storage-level contract directly: the backend
// records which thread owns a given root turn node hash, independent of
// Kernel.CreateThread's own use of that index for the P0-1
// ErrThreadRootNotUnique guard.
func TestInMemoryBackend_ThreadRootOwnershipIndex(t *testing.T) {
	backend := kernel.NewInMemoryBackend(&kernel.FixedClock{Ms: 1})

	if _, ok := backend.GetThreadByRootTurnNode("unclaimed"); ok {
		t.Fatal("expected an unclaimed root hash to report no owner")
	}

	rootHash := kernel.HashBytesToHex([]byte("root-node"))
	if !backend.PutThread(kernel.Thread{ThreadID: "thread_owner", RootTurnNodeHash: rootHash, CreatedAtMs: 1}) {
		t.Fatal("expected PutThread to succeed for a fresh threadId")
	}
	owner, ok := backend.GetThreadByRootTurnNode(rootHash)
	if !ok || owner != "thread_owner" {
		t.Fatalf("expected thread_owner to own %q, got %q (ok=%v)", rootHash, owner, ok)
	}

	// Re-registering the same threadId is rejected regardless of root
	// ownership (PutThread's own "already exists" contract).
	if backend.PutThread(kernel.Thread{ThreadID: "thread_owner", RootTurnNodeHash: rootHash, CreatedAtMs: 2}) {
		t.Fatal("expected PutThread to reject a duplicate threadId")
	}
}

// TestAsKernelError_UnwrapsWrappedError is the P2-3 regression: AsKernelError
// must find a *KernelError through fmt.Errorf's %w wrapping (errors.As),
// not just a bare type assertion.
func TestAsKernelError_UnwrapsWrappedError(t *testing.T) {
	base := &kernel.KernelError{Code: "kernel_runtime_test_wrapped", Message: "wrapped"}
	wrapped := errorsJoinFmtWrap(base)

	kerr, ok := kernel.AsKernelError(wrapped)
	if !ok {
		t.Fatalf("expected AsKernelError to unwrap a wrapped *KernelError, got ok=false for %v", wrapped)
	}
	if kerr.Code != base.Code {
		t.Fatalf("expected code %q, got %q", base.Code, kerr.Code)
	}
}

// errorsJoinFmtWrap wraps err with fmt.Errorf's %w verb, isolated into a
// tiny helper so the test above reads as "wrap it" without importing fmt
// directly into the top-level test flow.
func errorsJoinFmtWrap(err error) error {
	return wrappedError{inner: err}
}

type wrappedError struct{ inner error }

func (w wrappedError) Error() string { return "wrapped: " + w.inner.Error() }
func (w wrappedError) Unwrap() error { return w.inner }

var _ error = wrappedError{}
