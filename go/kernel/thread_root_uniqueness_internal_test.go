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

// This file lives in package kernel (not kernel_test) specifically to reach
// the unexported identity-record helpers CreateThread itself uses
// (defaultManifestChanges, turnTreeIdentityRecord, threadBootstrapRecord,
// turnNodeIdentityRecord). That access lets this test precisely predict the
// exact genesis turn node hash a legitimate CreateThread("thread_victim", ...)
// call is about to mint, and seed the backend so a *different* thread
// already claims that hash as its own root before CreateThread runs — the
// only way to exercise the ErrThreadRootNotUnique guard given that a
// thread-unique bootstrap eventHash (P0-1) makes an organic collision
// between two honestly-created threads unreachable by construction.
package kernel

import "testing"

func TestCreateThread_RejectsGenesisHashAlreadyClaimedByAnotherThread(t *testing.T) {
	schema := TurnTreeSchema{
		SchemaID: "schema_root_uniqueness",
		Paths: []PathDefinition{
			{Path: "messages", Collection: PathCollectionOrdered},
		},
	}

	clock := &IncrementingClock{}
	backend := NewInMemoryBackend(clock)
	k := NewKernel("test-scope", clock, backend)
	if err := k.RegisterSchema(schema); err != nil {
		t.Fatalf("register schema: %v", err)
	}

	// Predict the exact root turn node hash a legitimate
	// CreateThread("thread_victim", ...) call is about to mint, using the
	// same unexported helpers CreateThread itself uses.
	rootTreeHash, err := HashRecord(turnTreeIdentityRecord(schema.SchemaID, defaultManifestChanges(schema)))
	if err != nil {
		t.Fatalf("predict root tree hash: %v", err)
	}
	bootstrapBytes, err := EncodeCanonical(threadBootstrapRecord("thread_victim"))
	if err != nil {
		t.Fatalf("encode bootstrap record: %v", err)
	}
	predictedRootNodeHash, err := HashRecord(turnNodeIdentityRecord(TurnNode{
		SchemaID:     schema.SchemaID,
		TurnTreeHash: rootTreeHash,
		EventHash:    HashBytesToHex(bootstrapBytes),
	}))
	if err != nil {
		t.Fatalf("predict root turn node hash: %v", err)
	}

	// Seed the backend so "thread_attacker" already claims that exact hash
	// as its own root, simulating a corrupted or adversarial backend state
	// (kernel_runtime.go's own doc comment on this guard: "should be
	// structurally unreachable... but the backend still enforces it
	// defensively").
	if !backend.PutThread(Thread{
		ThreadID:         "thread_attacker",
		SchemaID:         schema.SchemaID,
		RootTurnNodeHash: predictedRootNodeHash,
		CreatedAtMs:      0,
	}) {
		t.Fatal("expected seeding thread_attacker to succeed")
	}
	if owner, ok := backend.GetThreadByRootTurnNode(predictedRootNodeHash); !ok || owner != "thread_attacker" {
		t.Fatalf("expected the backend's root-ownership index to report thread_attacker, got %q (ok=%v)", owner, ok)
	}

	_, err = k.CreateThread("thread_victim", schema.SchemaID, "branch_victim")
	if err == nil {
		t.Fatal("expected CreateThread to reject a genesis hash already claimed by another thread")
	}
	kerr, ok := AsKernelError(err)
	if !ok {
		t.Fatalf("expected a *KernelError, got %T: %v", err, err)
	}
	if kerr.Code != ErrThreadRootNotUnique {
		t.Fatalf("expected error code %q, got %q (%v)", ErrThreadRootNotUnique, kerr.Code, err)
	}

	// thread_victim must not have been published: neither the thread nor
	// its branch should exist after the rejected create.
	if _, ok := backend.GetThread("thread_victim"); ok {
		t.Fatal("expected thread_victim to not exist after a rejected create")
	}
	if _, ok := backend.GetBranch("branch_victim"); ok {
		t.Fatal("expected branch_victim to not exist after a rejected create")
	}
}
