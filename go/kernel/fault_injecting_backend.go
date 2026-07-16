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

// This file implements the M3 restart-recovery capability's fault-injection
// seam: FaultInjectingBackend, a test/adapter-only Backend decorator that
// interrupts the checkpoint-commit path (Kernel.checkpointRun's PutTurnNode
// + UpdateBranchHead + optional after-commit-before-ack hook) at a chosen
// point, mirroring typescript/kernel/testkit's
// fault-injecting-backend.ts. Unlike the TypeScript version — which wraps a
// transactional RuntimeBackend and matches faults by branch id / operation
// kind across a `transact` call's full recording — this Go port targets an
// untransacted, two-call commit sequence directly: a caller installs a
// FaultInjectingBackend on a Kernel (by assigning Kernel.Backend) only for
// the specific checkpoint call it wants faulted, so there is no need for
// the TypeScript version's per-transaction match rules. See
// go/kernel-conformance-adapter's restart-recovery operations for how a
// scenario swaps a FaultInjectingBackend in and back out around one
// Kernel.CompleteStep call.
package kernel

import "sync"

// FaultPoint is a point in the checkpoint-commit sequence a FaultPlan can
// target. Mirrors typescript/kernel/testkit's FaultPoint union.
type FaultPoint string

const (
	// FaultPointBeforeCommit fires before the checkpoint's turn node is
	// ever written: PutTurnNode fails outright and nothing durable changes.
	FaultPointBeforeCommit FaultPoint = "before-commit"
	// FaultPointMidCommit fires from the UpdateBranchHead call itself
	// without performing the head move: the turn node write already
	// happened durably (PutTurnNode succeeded), but the branch head is
	// left pointing at its pre-commit value, modeling a genuine torn
	// checkpoint — a crash after the node is durable but before the head
	// advance that would have made it live. This is the state kernel spec
	// §5.5 describes ("TurnNode exists → checkpoint succeeded") and is
	// what ReconcileRun (recovery.go) rolls forward: it discovers the
	// durable-but-unreferenced pending node and advances the head to it
	// itself, rather than finding a head that already silently moved.
	FaultPointMidCommit FaultPoint = "mid-commit"
	// FaultPointAfterCommitBeforeAck fires after both durable writes above
	// have succeeded and Kernel.checkpointRun would otherwise report
	// success — modeling a crash between a fully-durable commit and the
	// caller's acknowledgment of it.
	FaultPointAfterCommitBeforeAck FaultPoint = "after-commit-before-ack"
)

// FaultPolicy controls how many matching commit attempts a FaultPlan fires
// on.
type FaultPolicy string

const (
	// FaultPolicyOnce injects the fault on the first eligible commit
	// attempt only; every later attempt through the same
	// FaultInjectingBackend proceeds normally.
	FaultPolicyOnce FaultPolicy = "once"
	// FaultPolicyAlways injects the fault on every eligible commit
	// attempt.
	FaultPolicyAlways FaultPolicy = "always"
)

// FaultPlan describes when and how a FaultInjectingBackend should inject a
// fault. Mirrors typescript/kernel/testkit's FaultPlan, scoped down to the
// Point/Policy fields this Go port's untransacted commit sequence needs
// (see the package doc comment above for why match/concurrentWriter rules
// are not reproduced here).
type FaultPlan struct {
	Point  FaultPoint
	Policy FaultPolicy
}

// FaultInjectingBackend wraps a Backend so its checkpoint-commit path
// (PutTurnNode, UpdateBranchHead, and the afterCommitBeforeAckHook seam
// Kernel.checkpointRun calls) fails at plan.Point, for exercising
// crash-recovery behavior (docs/KrakenKernelSpecification.md §5). Every
// other Backend method passes straight through to the wrapped backend
// unmodified via interface embedding.
type FaultInjectingBackend struct {
	Backend

	mu       sync.Mutex
	plan     FaultPlan
	consumed bool
}

// NewFaultInjectingBackend wraps inner with plan.
func NewFaultInjectingBackend(inner Backend, plan FaultPlan) *FaultInjectingBackend {
	return &FaultInjectingBackend{Backend: inner, plan: plan}
}

// Consumed reports whether this backend has already injected its fault
// (always false for FaultPolicyAlways since it never marks itself
// consumed).
func (f *FaultInjectingBackend) Consumed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.consumed
}

func (f *FaultInjectingBackend) shouldFire() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.plan.Policy == FaultPolicyOnce && f.consumed {
		return false
	}
	return true
}

func (f *FaultInjectingBackend) markConsumed() {
	f.mu.Lock()
	f.consumed = true
	f.mu.Unlock()
}

func injectedFaultError(point FaultPoint) *KernelError {
	return newKernelError(ErrPersistenceFaultInjected, "injected %s persistence fault interrupted checkpoint commit", point)
}

// PutTurnNode is the checkpoint-commit sequence's first durable write: a
// FaultPointBeforeCommit plan fires here, before inner ever sees the write.
func (f *FaultInjectingBackend) PutTurnNode(node TurnNode) error {
	if f.plan.Point == FaultPointBeforeCommit && f.shouldFire() {
		f.markConsumed()
		return injectedFaultError(FaultPointBeforeCommit)
	}
	return f.Backend.PutTurnNode(node)
}

// UpdateBranchHead is the checkpoint-commit sequence's second durable
// write. A FaultPointMidCommit plan fires here without ever calling
// through to inner: the head is left exactly where it was (the turn node
// this head move would have pointed to is already durable via the prior
// PutTurnNode call, but nothing yet references it as live), modeling a
// genuine torn checkpoint rather than a head move the caller merely failed
// to be acknowledged for.
func (f *FaultInjectingBackend) UpdateBranchHead(branchID, headTurnNodeHash string, updatedAtMs int64) (bool, error) {
	if f.plan.Point == FaultPointMidCommit && f.shouldFire() {
		f.markConsumed()
		return false, injectedFaultError(FaultPointMidCommit)
	}
	return f.Backend.UpdateBranchHead(branchID, headTurnNodeHash, updatedAtMs)
}

// CompareAndSwapBranchHead mirrors UpdateBranchHead's FaultPointMidCommit
// handling for the atomic head-CAS path: the fault fires without ever
// attempting the swap, leaving the head at expectedHead.
func (f *FaultInjectingBackend) CompareAndSwapBranchHead(branchID, expectedHead, newHead string, updatedAtMs int64) (bool, error) {
	if f.plan.Point == FaultPointMidCommit && f.shouldFire() {
		f.markConsumed()
		return false, injectedFaultError(FaultPointMidCommit)
	}
	return f.Backend.CompareAndSwapBranchHead(branchID, expectedHead, newHead, updatedAtMs)
}

// AfterCommitBeforeAck implements afterCommitBeforeAckHook
// (kernel_runtime.go): Kernel.checkpointRun calls this after both durable
// writes above have already succeeded, letting a FaultPointAfterCommitBeforeAck
// plan fire precisely there.
func (f *FaultInjectingBackend) AfterCommitBeforeAck() error {
	if f.plan.Point == FaultPointAfterCommitBeforeAck && f.shouldFire() {
		f.markConsumed()
		return injectedFaultError(FaultPointAfterCommitBeforeAck)
	}
	return nil
}

var (
	_ Backend                  = (*FaultInjectingBackend)(nil)
	_ afterCommitBeforeAckHook = (*FaultInjectingBackend)(nil)
)
