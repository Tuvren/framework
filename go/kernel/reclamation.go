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

// This file implements the M4 scope-isolation/reclamation milestone's
// capability-gated reachability reclamation primitive
// (docs/KrakenKernelSpecification.md §9.4, `maintenance.reclamation`).
// Reclamation is mark-and-sweep: live roots are every non-archived branch
// head, every thread root, and every active (running/paused) run's start
// node, created-turn-node lineage, and uncommitted staged results. The
// keep closure is the reference closure of those roots (turn nodes walked
// backward through PreviousTurnNodeHash, turn trees walked through their
// manifests) unioned with everything durable created at or after the
// grace horizon — the oldest active run's CreatedAtMs, excluding any
// leaseless running run that has gone quiet past the 24h admin-expiry
// window (ADR-050/ADR-051). Only durable state outside both the keep
// closure and the grace window is released. This mirrors
// typescript/kernel/backends/memory's delegate to
// @tuvren/backend-shared's reclaimBackendState, scoped down to the Go
// port's simpler storage shape: TurnTree.Manifest holds hashes directly
// (no ordered-path chunk indirection) and there is no separate Turn
// entity to track.
package kernel

import "math"

// LeaselessRunExpiryMs is the default administrative expiry horizon
// (kernel spec §9.4 rationale, ADR-050/ADR-051) past which a leaseless
// running run (HasLease == false) that has gone quiet — nowMs -
// run.UpdatedAtMs at or beyond this many milliseconds — stops pinning the
// reclamation grace horizon. 24 hours.
const LeaselessRunExpiryMs int64 = 24 * 60 * 60 * 1000

// ReclamationSummary reports what a single Kernel.Reclaim call released
// and retained, mirroring (a scoped-down subset of) the TypeScript port's
// ReclamationSummary.
type ReclamationSummary struct {
	ReleasedObjectCount         int
	ReleasedTurnNodeCount       int
	ReleasedTurnTreeCount       int
	ReleasedArchivedBranchCount int
	ReleasedRunCount            int
	RetainedObjectCount         int
}

// Reclaimer is the optional seam a Backend implements to support kernel
// spec §9.4's maintenance.reclamation capability. Kernel.Reclaim rejects
// with ErrCapabilityUnsupported when the backend does not implement it —
// InMemoryBackend (memory-backend-reclamation.go) does.
type Reclaimer interface {
	Reclaim(nowMs int64) ReclamationSummary
}

// Reclaim runs the backend's mark-and-sweep reclamation sweep, using
// k.Clock for the "now" reference the leaseless-run admin-expiry check
// needs. Returns ErrCapabilityUnsupported if the backend does not
// implement Reclaimer.
func (k *Kernel) Reclaim() (ReclamationSummary, error) {
	reclaimer, ok := k.Backend.(Reclaimer)
	if !ok {
		return ReclamationSummary{}, newKernelError(ErrCapabilityUnsupported, "backend does not support maintenance.reclamation")
	}
	return reclaimer.Reclaim(k.Clock.NowMs()), nil
}

func isActiveRunStatus(status RunStatus) bool {
	return status == RunStatusRunning || status == RunStatusPaused
}

// isExpiredLeaselessRunningRun reports whether run is a leaseless
// (HasLease == false), currently-running run whose UpdatedAtMs has gone
// quiet at or past LeaselessRunExpiryMs relative to nowMs — the ADR-050/
// ADR-051 condition that excludes such a run from pinning the reclamation
// grace horizon, since its creator has presumably crashed without ever
// transitioning it out of "running".
func isExpiredLeaselessRunningRun(run Run, nowMs int64) bool {
	return run.Status == RunStatusRunning && !run.HasLease && nowMs-run.UpdatedAtMs >= LeaselessRunExpiryMs
}

// Reclaim implements Reclaimer for InMemoryBackend: an in-place
// mark-and-sweep over this backend's own Scope partition, guarded by that
// partition's mutex for the whole operation so no concurrent write can
// observe (or produce) a half-swept state. Only this backend's own Scope
// is ever touched, even when it shares a MemoryScopeStore with other
// scoped handles.
func (b *InMemoryBackend) Reclaim(nowMs int64) ReclamationSummary {
	st := b.state()
	st.mu.Lock()
	defer st.mu.Unlock()

	graceHorizonMs := computeGraceHorizonMs(st.runs, nowMs)

	keepObjects := make(map[string]bool)
	keepTurnNodes := make(map[string]bool)
	keepTurnTrees := make(map[string]bool)

	var turnNodeStack, turnTreeStack []string

	seedLiveRoots(st, &turnNodeStack, keepObjects)
	seedGraceRoots(st, graceHorizonMs, &turnNodeStack, &turnTreeStack, keepObjects)
	closeTurnNodeReachability(st, keepTurnNodes, keepObjects, &turnNodeStack, &turnTreeStack)
	closeTurnTreeReachability(st, keepTurnTrees, keepObjects, &turnTreeStack)

	return sweepBackend(st, keepObjects, keepTurnNodes, keepTurnTrees, graceHorizonMs)
}

// computeGraceHorizonMs is the oldest CreatedAtMs among active
// (running/paused) runs that are not an expired leaseless running run, or
// +Inf if there is no such run (nothing pins the horizon, so age alone
// gates release).
func computeGraceHorizonMs(runs map[string]Run, nowMs int64) int64 {
	horizon := int64(math.MaxInt64)
	for _, run := range runs {
		if !isActiveRunStatus(run.Status) {
			continue
		}
		if isExpiredLeaselessRunningRun(run, nowMs) {
			continue
		}
		if run.CreatedAtMs < horizon {
			horizon = run.CreatedAtMs
		}
	}
	return horizon
}

// seedLiveRoots pushes every non-archived branch head, every thread root,
// and every active run's start node plus created-turn-node lineage onto
// turnNodeStack, and keeps every active run's currently-staged (drained-
// but-not-yet-checkpointed) result object directly.
//
// An active run's PendingCheckpointHash is also pushed when present: a
// torn mid-commit checkpoint's turn node is durably written (checkpointRun
// already succeeded at the storage layer) but is not yet reflected in
// CreatedTurnNodes and has not yet become the branch head, so without this
// seed it would be reachable from nothing once the run stops pinning the
// grace horizon (an expired leaseless running run past
// LeaselessRunExpiryMs). Losing that node bricks the run permanently:
// ReconcileRun needs it to fold the torn checkpoint onto the lineage, and
// checkpointRun's ErrRunPendingCheckpoint guard refuses any further
// checkpoint attempt on the run until ReconcileRun succeeds. This is a
// port-local obligation of the durable pending-checkpoint marker
// discipline (memory-backend-checkpoint.go) — the TypeScript backend has
// no equivalent marker because its transact() makes checkpoint commits
// atomic, so it never observes a torn state to begin with.
func seedLiveRoots(st *scopeState, turnNodeStack *[]string, keepObjects map[string]bool) {
	for _, branch := range st.branches {
		if branch.ArchivedFromBranchID == "" {
			*turnNodeStack = append(*turnNodeStack, branch.HeadTurnNodeHash)
		}
	}
	for _, thread := range st.threads {
		*turnNodeStack = append(*turnNodeStack, thread.RootTurnNodeHash)
	}
	for _, run := range st.runs {
		if !isActiveRunStatus(run.Status) {
			continue
		}
		*turnNodeStack = append(*turnNodeStack, run.StartTurnNodeHash)
		*turnNodeStack = append(*turnNodeStack, run.CreatedTurnNodes...)
		if run.PendingCheckpointHash != "" {
			*turnNodeStack = append(*turnNodeStack, run.PendingCheckpointHash)
		}
		for _, staged := range st.stagedByRun[run.RunID] {
			keepObjects[staged.ObjectHash] = true
		}
	}
}

// seedGraceRoots adds everything durable created at or after
// graceHorizonMs directly to the keep closure: turn nodes/trees are
// pushed onto their reachability-walk stacks (so anything *they*
// reference also survives), objects are kept outright.
func seedGraceRoots(st *scopeState, graceHorizonMs int64, turnNodeStack, turnTreeStack *[]string, keepObjects map[string]bool) {
	if graceHorizonMs == math.MaxInt64 {
		return
	}
	for hash, node := range st.nodes {
		if node.CreatedAtMs >= graceHorizonMs {
			*turnNodeStack = append(*turnNodeStack, hash)
		}
	}
	for hash, tree := range st.trees {
		if tree.CreatedAtMs >= graceHorizonMs {
			*turnTreeStack = append(*turnTreeStack, hash)
		}
	}
	for hash, object := range st.objects {
		if object.CreatedAtMs >= graceHorizonMs {
			keepObjects[hash] = true
		}
	}
}

// closeTurnNodeReachability walks turnNodeStack to a fixed point: every
// popped node is marked kept, its previous-turn-node hash is pushed back
// (lineage walk), its turn tree hash is queued for turn-tree closure, and
// its own eventHash / consumed-staged-result object hashes are kept
// directly.
func closeTurnNodeReachability(st *scopeState, keepTurnNodes map[string]bool, keepObjects map[string]bool, turnNodeStack, turnTreeStack *[]string) {
	for len(*turnNodeStack) > 0 {
		n := len(*turnNodeStack) - 1
		hash := (*turnNodeStack)[n]
		*turnNodeStack = (*turnNodeStack)[:n]
		if hash == "" || keepTurnNodes[hash] {
			continue
		}
		node, ok := st.nodes[hash]
		if !ok {
			continue
		}
		keepTurnNodes[hash] = true
		if node.PreviousTurnNodeHash != "" {
			*turnNodeStack = append(*turnNodeStack, node.PreviousTurnNodeHash)
		}
		*turnTreeStack = append(*turnTreeStack, node.TurnTreeHash)
		if node.EventHash != "" {
			keepObjects[node.EventHash] = true
		}
		for _, staged := range node.ConsumedStagedResults {
			keepObjects[staged.ObjectHash] = true
		}
	}
}

// closeTurnTreeReachability walks turnTreeStack to a fixed point: every
// popped tree is marked kept and every object hash its manifest
// references (single or ordered) is kept directly.
func closeTurnTreeReachability(st *scopeState, keepTurnTrees map[string]bool, keepObjects map[string]bool, turnTreeStack *[]string) {
	for len(*turnTreeStack) > 0 {
		n := len(*turnTreeStack) - 1
		hash := (*turnTreeStack)[n]
		*turnTreeStack = (*turnTreeStack)[:n]
		if hash == "" || keepTurnTrees[hash] {
			continue
		}
		tree, ok := st.trees[hash]
		if !ok {
			continue
		}
		keepTurnTrees[hash] = true
		for _, value := range tree.Manifest {
			switch value.Kind {
			case PathValueSingleKind:
				if value.Single != "" {
					keepObjects[value.Single] = true
				}
			case PathValueOrderedKind:
				for _, objectHash := range value.Ordered {
					keepObjects[objectHash] = true
				}
			}
		}
	}
}

// sweepBackend deletes every durable record outside both the keep closure
// and the grace window: an archived branch whose head turn node is not
// kept is released outright (archived branches carry no independent grace
// window — the branch itself only exists as an archival pointer, so
// keeping an unreachable one around serves no purpose); every other
// record kind is released only if it is both unreached and older than the
// grace horizon. A run is retained iff its start node and every node in
// its created-turn-node lineage are all kept turn nodes; releasing a run
// also releases its staged-results pool.
func sweepBackend(st *scopeState, keepObjects, keepTurnNodes, keepTurnTrees map[string]bool, graceHorizonMs int64) ReclamationSummary {
	releasedArchivedBranches := 0
	for branchID, branch := range st.branches {
		if branch.ArchivedFromBranchID != "" && !keepTurnNodes[branch.HeadTurnNodeHash] {
			delete(st.branches, branchID)
			releasedArchivedBranches++
		}
	}

	releasedRuns := 0
	for runID, run := range st.runs {
		retained := keepTurnNodes[run.StartTurnNodeHash]
		if retained {
			for _, hash := range run.CreatedTurnNodes {
				if !keepTurnNodes[hash] {
					retained = false
					break
				}
			}
		}
		if !retained {
			delete(st.runs, runID)
			delete(st.stagedByRun, runID)
			releasedRuns++
		}
	}

	releasedNodes := 0
	for hash, node := range st.nodes {
		if !keepTurnNodes[hash] && node.CreatedAtMs < graceHorizonMs {
			delete(st.nodes, hash)
			releasedNodes++
		}
	}

	releasedTrees := 0
	for hash, tree := range st.trees {
		if !keepTurnTrees[hash] && tree.CreatedAtMs < graceHorizonMs {
			delete(st.trees, hash)
			releasedTrees++
		}
	}

	releasedObjects := 0
	for hash, object := range st.objects {
		if !keepObjects[hash] && object.CreatedAtMs < graceHorizonMs {
			delete(st.objects, hash)
			releasedObjects++
		}
	}

	return ReclamationSummary{
		ReleasedObjectCount:         releasedObjects,
		ReleasedTurnNodeCount:       releasedNodes,
		ReleasedTurnTreeCount:       releasedTrees,
		ReleasedArchivedBranchCount: releasedArchivedBranches,
		ReleasedRunCount:            releasedRuns,
		RetainedObjectCount:         len(st.objects),
	}
}

var _ Reclaimer = (*InMemoryBackend)(nil)
