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

// This file wires the M4 kernel.scope-isolation and kernel.reclamation
// operations into the adapter's dispatch table. Every handler builds its
// own fresh in-memory Kernel(s) per dispatch call, matching every other
// operation in this adapter's per-check isolation. These handlers only
// project raw observations (see projection); the conformance plans
// (spec/conformance/kernel/plans/kernel-scope-isolation.json,
// kernel-reclamation.json) own every pass/fail assertion — nothing here
// grades, and nothing here maps a kernel/adapter failure into
// $.result.error.
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"

	kernel "github.com/tuvren/framework/go/kernel"
)

// --- kernel.scope-isolation.cross-scope-probe ---

// newScopedRuntimeKernelPair builds two Kernels sharing one
// MemoryScopeStore but bound to two distinct Scopes (mirroring
// typescript/kernel/conformance-adapter's createScopedBackendPair /
// createMemoryScopeStore over the memory backend), so a probe can prove a
// co-tenant Scope observes none of the constructing Scope's content.
func newScopedRuntimeKernelPair() (kernelA, kernelB *kernel.Kernel) {
	clock := &kernel.IncrementingClock{}
	store := kernel.NewMemoryScopeStore()
	backendA := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.conformance-a")
	backendB := kernel.NewScopedInMemoryBackend(clock, store, "tuvren.scope.conformance-b")
	return kernel.NewKernel("kernel-conformance-adapter-a", clock, backendA),
		kernel.NewKernel("kernel-conformance-adapter-b", clock, backendB)
}

// runCrossScopeProbe constructs two Kernels over two Scopes bound to one
// shared substrate, seeds content and an enumerable thread under scope A,
// then reports — as raw observations — what each Scope can see via
// store.has, store.get, and thread enumeration.
func runCrossScopeProbe(json.RawMessage) operationOutcome {
	kernelA, kernelB := newScopedRuntimeKernelPair()
	if err := kernelA.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}

	objectHash := kernelA.PutObject("application/json", []byte("scope-a cross-scope probe content"))
	const threadID = "scope_probe_thread"
	if _, err := kernelA.CreateThread(threadID, "schema_main", "scope_probe_branch"); err != nil {
		return errorOutcomeFor(err)
	}

	_, sameScopeStoreGetOk := kernelA.Backend.GetObject(objectHash)
	_, crossScopeStoreGetOk := kernelB.Backend.GetObject(objectHash)

	sameScopeThreads, _, err := kernelA.ListThreads(0, "")
	if err != nil {
		return errorOutcomeFor(err)
	}
	crossScopeThreads, _, err := kernelB.ListThreads(0, "")
	if err != nil {
		return errorOutcomeFor(err)
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"enumeration": map[string]any{
			"sameScopeThreadVisible":  threadVisible(sameScopeThreads, threadID),
			"crossScopeThreadVisible": threadVisible(crossScopeThreads, threadID),
		},
		"storeGet": map[string]any{
			"sameScopeReturnsObject": sameScopeStoreGetOk,
			"crossScopeReturnsNull":  !crossScopeStoreGetOk,
		},
		"storeHas": map[string]any{
			"sameScopeObservesOwnContent":    kernelA.HasObject(objectHash),
			"crossScopeObservesOtherContent": kernelB.HasObject(objectHash),
		},
	})}
}

func threadVisible(threads []kernel.Thread, threadID string) bool {
	for _, thread := range threads {
		if thread.ThreadID == threadID {
			return true
		}
	}
	return false
}

// --- kernel.reclamation.reclaim-probe ---

// runReclaimProbe constructs the decisive scenarios kernel spec §9.4's
// mark-and-sweep reclamation must satisfy and reports what it released and
// retained. Each scenario runs over its own fresh Kernel so one scenario's
// clock or lineage never perturbs another's.
func runReclaimProbe(json.RawMessage) operationOutcome {
	reachability, err := observeReclaimReachability()
	if err != nil {
		return errorOutcomeFor(err)
	}
	grace, err := observeReclaimGraceWindow()
	if err != nil {
		return errorOutcomeFor(err)
	}
	leaselessExpired, err := observeLeaselessRunPastAdminExpiry()
	if err != nil {
		return errorOutcomeFor(err)
	}
	leaselessActive, err := observeLeaselessRunWithinAdminExpiry()
	if err != nil {
		return errorOutcomeFor(err)
	}

	reclaim := map[string]any{}
	for _, part := range []map[string]any{reachability, grace, leaselessExpired, leaselessActive} {
		for key, value := range part {
			reclaim[key] = value
		}
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"reclaim": reclaim,
	})}
}

// observeReclaimReachability proves: (1) an object unreachable from any
// live root, with no active lease in play, is released past grace; (2) an
// archive-rollback's exclusive lineage (the abandoned forward segment) is
// released; (3) the live branch head's own lineage stays retained; (4) a
// message shared between the kept ancestor and the abandoned forward
// segment survives via the live root even though its archive-exclusive
// sibling does not — proving the keep closure is a set-union over live
// roots, not exclusive-lineage release.
func observeReclaimReachability() (map[string]any, error) {
	k, _ := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return nil, err
	}
	created, err := k.CreateThread("thread_reclamation", "schema_main", "branch_reclamation")
	if err != nil {
		return nil, err
	}

	sharedMessage := k.PutObject("application/json", []byte("shared-across-live-and-archived"))
	sharedTree, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{sharedMessage}},
	}, &created.RootTurnTreeHash)
	if err != nil {
		return nil, err
	}
	sharedNode, err := k.CommitSiblingCheckpoint("branch_reclamation", created.RootTurnNodeHash, kernel.TurnNode{
		SchemaID: "schema_main", TurnTreeHash: sharedTree,
	})
	if err != nil {
		return nil, err
	}

	archivedOnlyMessage := k.PutObject("application/json", []byte("archived-exclusive-payload"))
	archivedTree, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{sharedMessage, archivedOnlyMessage}},
	}, &sharedTree)
	if err != nil {
		return nil, err
	}
	archivedNode, err := k.CommitSiblingCheckpoint("branch_reclamation", sharedNode, kernel.TurnNode{
		SchemaID: "schema_main", TurnTreeHash: archivedTree,
	})
	if err != nil {
		return nil, err
	}

	if err := k.SetBranchHead("branch_reclamation", sharedNode); err != nil {
		return nil, err
	}

	orphanObjectHash := k.PutObject("application/octet-stream", []byte("unreachable-orphan"))

	if _, err := k.Reclaim(); err != nil {
		return nil, err
	}

	_, sharedNodeRetained := k.Backend.GetTurnNode(sharedNode)
	_, archivedNodeReleased := k.Backend.GetTurnNode(archivedNode)

	return map[string]any{
		"unreachablePastGraceReleased":  !k.HasObject(orphanObjectHash),
		"archivedBranchReleased":        !k.HasObject(archivedOnlyMessage) && !archivedNodeReleased,
		"reachableFromLiveRootRetained": k.HasObject(sharedMessage) && sharedNodeRetained,
		"sharedObjectRetainedViaLiveRoot": k.HasObject(sharedMessage) &&
			!k.HasObject(archivedOnlyMessage) && !archivedNodeReleased,
	}, nil
}

// observeReclaimGraceWindow proves the grace horizon is the oldest active
// execution lease: an orphan created before the horizon is released, one
// created after it is retained even though both are equally unreachable.
func observeReclaimGraceWindow() (map[string]any, error) {
	k, clock := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return nil, err
	}

	clock.SetMs(10)
	orphanBeforeLease := k.PutObject("application/octet-stream", []byte{1})

	clock.SetMs(20)
	created, err := k.CreateThread("thread_grace", "schema_main", "branch_grace")
	if err != nil {
		return nil, err
	}
	if err := k.CreateRun("run_grace", "turn_grace", "branch_grace", "schema_main", created.RootTurnNodeHash, singleStepSequence()); err != nil {
		return nil, err
	}

	clock.SetMs(30)
	orphanAfterLease := k.PutObject("application/octet-stream", []byte{2})

	clock.SetMs(40)
	if _, err := k.Reclaim(); err != nil {
		return nil, err
	}

	return map[string]any{
		"graceWindowHeldUnderActiveLease": !k.HasObject(orphanBeforeLease) && k.HasObject(orphanAfterLease),
	}, nil
}

// observeLeaselessRunPastAdminExpiry proves a leaseless (no execution
// lease ever acquired) running run whose creator has effectively crashed
// stops pinning the grace horizon once it has gone quiet past the 24h
// admin-expiry window (ADR-050/ADR-051), so a later orphan becomes
// reclaimable.
func observeLeaselessRunPastAdminExpiry() (map[string]any, error) {
	k, clock := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return nil, err
	}
	created, err := k.CreateThread("thread_leaseless_expired", "schema_main", "branch_leaseless_expired")
	if err != nil {
		return nil, err
	}
	if err := k.CreateRun("run_leaseless_expired", "turn_leaseless_expired", "branch_leaseless_expired", "schema_main", created.RootTurnNodeHash, singleStepSequence()); err != nil {
		return nil, err
	}

	clock.SetMs(10)
	orphan := k.PutObject("application/octet-stream", []byte("leaseless-expiry-orphan"))

	clock.SetMs(kernel.LeaselessRunExpiryMs + 5000)
	if _, err := k.Reclaim(); err != nil {
		return nil, err
	}

	return map[string]any{
		"leaselessRunPastAdminExpiryDoesNotPinReclamation": !k.HasObject(orphan),
	}, nil
}

// observeLeaselessRunWithinAdminExpiry is the mirror-image control: the
// same leaseless running run shape, but reclaimed well within the 24h
// horizon, still pins reclamation so the later orphan stays retained.
func observeLeaselessRunWithinAdminExpiry() (map[string]any, error) {
	k, clock := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return nil, err
	}
	created, err := k.CreateThread("thread_leaseless_active", "schema_main", "branch_leaseless_active")
	if err != nil {
		return nil, err
	}
	if err := k.CreateRun("run_leaseless_active", "turn_leaseless_active", "branch_leaseless_active", "schema_main", created.RootTurnNodeHash, singleStepSequence()); err != nil {
		return nil, err
	}

	clock.SetMs(10)
	orphan := k.PutObject("application/octet-stream", []byte("leaseless-active-orphan"))

	clock.SetMs(1000)
	if _, err := k.Reclaim(); err != nil {
		return nil, err
	}

	return map[string]any{
		"leaselessRunWithinAdminExpiryStillPinsReclamation": k.HasObject(orphan),
	}, nil
}

// --- kernel.reclamation.erasure-probe ---

// aesGcmEnvelope AES-256-GCM-encrypts plaintext under key, returning
// nonce||ciphertext (the GCM tag is appended to the ciphertext by
// cipher.AEAD.Seal). This is the adapter playing the host/edge role kernel
// spec §9.4's erasure rationale describes: the kernel itself never sees a
// key or plaintext, only the opaque envelope bytes this function returns.
func aesGcmEnvelope(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// aesGcmOpen decrypts an aesGcmEnvelope-produced envelope under key,
// erroring if key is wrong/absent (the crypto-shredding "erased" outcome)
// or the envelope is malformed/short.
func aesGcmOpen(key, envelope []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonceSize := gcm.NonceSize()
	if len(envelope) < nonceSize {
		return nil, fmt.Errorf("erasure probe: envelope shorter than nonce")
	}
	nonce, ciphertext := envelope[:nonceSize], envelope[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// runErasureProbe plays the §4.17/§9.4 host role: it owns a payload codec
// and the key, encrypts at the edge, and hands the kernel only the opaque
// ciphertext envelope as a message object incorporated into the branch
// head's turn tree. "Erasure" is the host destroying the key (dropping it
// from its own keyring — the kernel never held it, so nothing kernel-side
// changes). The probe reports — as raw observations — that the payload is
// recoverable before and unrecoverable after key destruction, while the
// referencing kernel lineage stays byte/hash-identical.
func runErasureProbe(json.RawMessage) operationOutcome {
	k, _ := newManualClockRuntimeKernel(0)
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return errorOutcomeFor(err)
	}
	// keyring simulates the host's own key store: erasure is dropping the
	// entry, not anything the kernel is ever aware of.
	keyring := map[string][]byte{"tuvren.scope.conformance-erasure": key}
	const keyRef = "tuvren.scope.conformance-erasure"

	plaintext := []byte("sensitive-untrusted-edge-payload")
	envelope, err := aesGcmEnvelope(keyring[keyRef], plaintext)
	if err != nil {
		return errorOutcomeFor(err)
	}

	created, err := k.CreateThread("thread_erasure", "schema_main", "branch_erasure")
	if err != nil {
		return errorOutcomeFor(err)
	}
	envelopeHash := k.PutObject("application/octet-stream", envelope)
	tree, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{envelopeHash}},
	}, &created.RootTurnTreeHash)
	if err != nil {
		return errorOutcomeFor(err)
	}
	nodeHash, err := k.CommitSiblingCheckpoint("branch_erasure", created.RootTurnNodeHash, kernel.TurnNode{
		SchemaID: "schema_main", TurnTreeHash: tree,
	})
	if err != nil {
		return errorOutcomeFor(err)
	}

	branchBefore, ok := k.Backend.GetBranch("branch_erasure")
	if !ok {
		return errorOutcomeFor(fmt.Errorf("branch_erasure not found before erasure"))
	}
	nodeBefore, ok := k.Backend.GetTurnNode(nodeHash)
	if !ok {
		return errorOutcomeFor(fmt.Errorf("turn node %q not found before erasure", nodeHash))
	}

	storedBefore, _ := k.Backend.GetObject(envelopeHash)
	decryptedBefore, decryptErrBefore := aesGcmOpen(keyring[keyRef], storedBefore.Bytes)
	recoverableBeforeErasure := decryptErrBefore == nil && string(decryptedBefore) == string(plaintext)

	// ── Crypto-shredding erasure: the host destroys the key. ──
	delete(keyring, keyRef)

	storedAfter, _ := k.Backend.GetObject(envelopeHash)
	_, decryptErrAfter := aesGcmOpen(keyring[keyRef], storedAfter.Bytes)
	unrecoverableAfterErasure := decryptErrAfter != nil

	branchAfter, ok := k.Backend.GetBranch("branch_erasure")
	if !ok {
		return errorOutcomeFor(fmt.Errorf("branch_erasure not found after erasure"))
	}
	nodeAfter, ok := k.Backend.GetTurnNode(nodeHash)
	if !ok {
		return errorOutcomeFor(fmt.Errorf("turn node %q not found after erasure", nodeHash))
	}
	manifestReferencesEnvelope := false
	if treeAfter, ok := k.Backend.GetTurnTree(nodeAfter.TurnTreeHash); ok {
		for _, hash := range treeAfter.Manifest["messages"].Ordered {
			if hash == envelopeHash {
				manifestReferencesEnvelope = true
			}
		}
	}

	lineageStructurallyIntactAfterErasure := branchAfter.HeadTurnNodeHash == branchBefore.HeadTurnNodeHash &&
		nodeAfter.TurnTreeHash == nodeBefore.TurnTreeHash &&
		manifestReferencesEnvelope &&
		string(storedAfter.Bytes) == string(envelope)

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"erasure": map[string]any{
			"recoverableBeforeErasure":              recoverableBeforeErasure,
			"unrecoverableAfterErasure":             unrecoverableAfterErasure,
			"lineageStructurallyIntactAfterErasure": lineageStructurallyIntactAfterErasure,
		},
	})}
}
