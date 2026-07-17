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

/// The M4 scope-isolation/reclamation milestone's capability-gated
/// reachability reclamation primitive (`docs/KrakenKernelSpecification.md`
/// §9.4, `maintenance.reclamation`), mirroring `go/kernel/reclamation.go`.
///
/// Reclamation is mark-and-sweep: live roots are every non-archived branch
/// head, every thread root, and every active (running/paused) run's start
/// node, created-turn-node lineage, pending checkpoint, and uncommitted
/// staged results. The keep closure is the reference closure of those
/// roots (turn nodes walked backward through `previousTurnNodeHash`, turn
/// trees walked through their manifests) unioned with everything durable
/// created at or after the grace horizon -- the oldest active run's
/// `createdAtMs`, excluding any leaseless running run that has gone quiet
/// past the 24h admin-expiry window (ADR-050/ADR-051). Only durable state
/// outside both the keep closure and the grace window is released.
library;

import 'backend.dart';
import 'validate.dart';

/// The default administrative expiry horizon (kernel spec §9.4 rationale,
/// ADR-050/ADR-051) past which a leaseless running run (`hasLease ==
/// false`) that has gone quiet -- `nowMs - run.updatedAtMs` at or beyond
/// this many milliseconds -- stops pinning the reclamation grace horizon.
/// 24 hours.
const int leaselessRunExpiryMs = 24 * 60 * 60 * 1000;

/// Reports what a single reclamation sweep released and retained,
/// mirroring `go/kernel/reclamation.go`'s `ReclamationSummary`.
final class ReclamationSummary {
  const ReclamationSummary({
    this.releasedObjectCount = 0,
    this.releasedTurnNodeCount = 0,
    this.releasedTurnTreeCount = 0,
    this.releasedArchivedBranchCount = 0,
    this.releasedRunCount = 0,
    this.retainedObjectCount = 0,
  });

  final int releasedObjectCount;
  final int releasedTurnNodeCount;
  final int releasedTurnTreeCount;
  final int releasedArchivedBranchCount;
  final int releasedRunCount;
  final int retainedObjectCount;
}

/// The optional seam a [Backend] implements to support kernel spec §9.4's
/// `maintenance.reclamation` capability. `Kernel.reclaim` throws
/// `errCapabilityUnsupported` when the backend does not implement it.
abstract class Reclaimer {
  ReclamationSummary reclaim(int nowMs);
}

bool _isActiveRunStatus(RunStatus status) =>
    status == RunStatus.running || status == RunStatus.paused;

/// Reports whether [run] is a leaseless (`hasLease == false`),
/// currently-running run whose `updatedAtMs` has gone quiet at or past
/// [leaselessRunExpiryMs] relative to [nowMs] -- the ADR-050/ADR-051
/// condition that excludes such a run from pinning the reclamation grace
/// horizon, since its creator has presumably crashed without ever
/// transitioning it out of "running".
bool _isExpiredLeaselessRunningRun(Run run, int nowMs) =>
    run.status == RunStatus.running &&
    !run.hasLease &&
    nowMs - run.updatedAtMs >= leaselessRunExpiryMs;

/// The oldest `createdAtMs` among active (running/paused) runs that are
/// not an expired leaseless running run, or `null` if there is no such
/// run (nothing pins the horizon, so age alone gates release).
int? _computeGraceHorizonMs(Map<String, Run> runs, int nowMs) {
  int? horizon;
  for (final run in runs.values) {
    if (!_isActiveRunStatus(run.status)) continue;
    if (_isExpiredLeaselessRunningRun(run, nowMs)) continue;
    if (horizon == null || run.createdAtMs < horizon) {
      horizon = run.createdAtMs;
    }
  }
  return horizon;
}

/// Pushes every non-archived branch head, every thread root, and every
/// active run's start node plus created-turn-node lineage onto
/// [turnNodeStack], and keeps every active run's currently-staged
/// (drained-but-not-yet-checkpointed) result object directly. An active
/// run's `pendingCheckpointHash` is also pushed when present: a torn
/// mid-commit checkpoint's turn node is durably written but is not yet
/// reflected in `createdTurnNodes` and has not yet become the branch
/// head, so without this seed it would be unreachable once the run stops
/// pinning the grace horizon.
void _seedLiveRoots(
  Map<String, Branch> branches,
  Map<String, Thread> threads,
  Map<String, Run> runs,
  Map<String, List<StagedResult>> stagedByRun,
  List<String> turnNodeStack,
  Set<String> keepObjects,
) {
  for (final branch in branches.values) {
    if (branch.archivedFromBranchId.isEmpty) {
      turnNodeStack.add(branch.headTurnNodeHash);
    }
  }
  for (final thread in threads.values) {
    turnNodeStack.add(thread.rootTurnNodeHash);
  }
  for (final run in runs.values) {
    if (!_isActiveRunStatus(run.status)) continue;
    turnNodeStack.add(run.startTurnNodeHash);
    turnNodeStack.addAll(run.createdTurnNodes);
    if (run.pendingCheckpointHash.isNotEmpty) {
      turnNodeStack.add(run.pendingCheckpointHash);
    }
    for (final staged in stagedByRun[run.runId] ?? const <StagedResult>[]) {
      keepObjects.add(staged.objectHash);
    }
  }
}

/// Adds everything durable created at or after [graceHorizonMs] directly
/// to the keep closure: turn nodes/trees are pushed onto their
/// reachability-walk stacks (so anything *they* reference also survives),
/// objects are kept outright.
void _seedGraceRoots(
  Map<String, TurnNode> nodes,
  Map<String, TurnTree> trees,
  Map<String, StoredObject> objects,
  int? graceHorizonMs,
  List<String> turnNodeStack,
  List<String> turnTreeStack,
  Set<String> keepObjects,
) {
  if (graceHorizonMs == null) return;
  for (final entry in nodes.entries) {
    if (entry.value.createdAtMs >= graceHorizonMs) {
      turnNodeStack.add(entry.key);
    }
  }
  for (final entry in trees.entries) {
    if (entry.value.createdAtMs >= graceHorizonMs) {
      turnTreeStack.add(entry.key);
    }
  }
  for (final entry in objects.entries) {
    if (entry.value.createdAtMs >= graceHorizonMs) {
      keepObjects.add(entry.key);
    }
  }
}

/// Walks [turnNodeStack] to a fixed point: every popped node is marked
/// kept, its previous-turn-node hash is pushed back (lineage walk), its
/// turn tree hash is queued for turn-tree closure, and its own eventHash
/// / consumed-staged-result object hashes are kept directly.
void _closeTurnNodeReachability(
  Map<String, TurnNode> nodes,
  Set<String> keepTurnNodes,
  Set<String> keepObjects,
  List<String> turnNodeStack,
  List<String> turnTreeStack,
) {
  while (turnNodeStack.isNotEmpty) {
    final hash = turnNodeStack.removeLast();
    if (hash.isEmpty || keepTurnNodes.contains(hash)) continue;
    final node = nodes[hash];
    if (node == null) continue;
    keepTurnNodes.add(hash);
    if (node.previousTurnNodeHash.isNotEmpty) {
      turnNodeStack.add(node.previousTurnNodeHash);
    }
    turnTreeStack.add(node.turnTreeHash);
    if (node.eventHash.isNotEmpty) {
      keepObjects.add(node.eventHash);
    }
    for (final staged in node.consumedStagedResults) {
      keepObjects.add(staged.objectHash);
    }
  }
}

/// Walks [turnTreeStack] to a fixed point: every popped tree is marked
/// kept and every object hash its manifest references (single or
/// ordered) is kept directly.
void _closeTurnTreeReachability(
  Map<String, TurnTree> trees,
  Set<String> keepTurnTrees,
  Set<String> keepObjects,
  List<String> turnTreeStack,
) {
  while (turnTreeStack.isNotEmpty) {
    final hash = turnTreeStack.removeLast();
    if (hash.isEmpty || keepTurnTrees.contains(hash)) continue;
    final tree = trees[hash];
    if (tree == null) continue;
    keepTurnTrees.add(hash);
    for (final value in tree.manifest.values) {
      switch (value.kind) {
        case PathValueKind.single:
          final single = value.single;
          if (single != null && single.isNotEmpty) keepObjects.add(single);
        case PathValueKind.ordered:
          keepObjects.addAll(value.ordered!);
        case PathValueKind.nullValue:
          break;
      }
    }
  }
}

/// Deletes every durable record outside both the keep closure and the
/// grace window: an archived branch whose head turn node is not kept is
/// released outright (archived branches carry no independent grace
/// window); every other record kind is released only if it is both
/// unreached and older than the grace horizon. A run is retained iff its
/// start node and every node in its created-turn-node lineage are all
/// kept turn nodes; releasing a run also releases its staged-results
/// pool.
ReclamationSummary _sweep(
  Map<String, Branch> branches,
  Map<String, Run> runs,
  Map<String, TurnNode> nodes,
  Map<String, TurnTree> trees,
  Map<String, StoredObject> objects,
  Map<String, List<StagedResult>> stagedByRun,
  Set<String> keepObjects,
  Set<String> keepTurnNodes,
  Set<String> keepTurnTrees,
  int? graceHorizonMs,
) {
  bool olderThanHorizon(int createdAtMs) =>
      graceHorizonMs == null || createdAtMs < graceHorizonMs;

  var releasedArchivedBranches = 0;
  for (final branchId in List.of(branches.keys)) {
    final branch = branches[branchId]!;
    if (branch.archivedFromBranchId.isNotEmpty &&
        !keepTurnNodes.contains(branch.headTurnNodeHash)) {
      branches.remove(branchId);
      releasedArchivedBranches++;
    }
  }

  var releasedRuns = 0;
  for (final runId in List.of(runs.keys)) {
    final run = runs[runId]!;
    var retained = keepTurnNodes.contains(run.startTurnNodeHash);
    if (retained) {
      for (final hash in run.createdTurnNodes) {
        if (!keepTurnNodes.contains(hash)) {
          retained = false;
          break;
        }
      }
    }
    if (!retained) {
      runs.remove(runId);
      stagedByRun.remove(runId);
      releasedRuns++;
    }
  }

  var releasedNodes = 0;
  for (final hash in List.of(nodes.keys)) {
    final node = nodes[hash]!;
    if (!keepTurnNodes.contains(hash) && olderThanHorizon(node.createdAtMs)) {
      nodes.remove(hash);
      releasedNodes++;
    }
  }

  var releasedTrees = 0;
  for (final hash in List.of(trees.keys)) {
    final tree = trees[hash]!;
    if (!keepTurnTrees.contains(hash) && olderThanHorizon(tree.createdAtMs)) {
      trees.remove(hash);
      releasedTrees++;
    }
  }

  var releasedObjects = 0;
  for (final hash in List.of(objects.keys)) {
    final object = objects[hash]!;
    if (!keepObjects.contains(hash) && olderThanHorizon(object.createdAtMs)) {
      objects.remove(hash);
      releasedObjects++;
    }
  }

  return ReclamationSummary(
    releasedObjectCount: releasedObjects,
    releasedTurnNodeCount: releasedNodes,
    releasedTurnTreeCount: releasedTrees,
    releasedArchivedBranchCount: releasedArchivedBranches,
    releasedRunCount: releasedRuns,
    retainedObjectCount: objects.length,
  );
}

/// Runs one in-place mark-and-sweep reclamation pass over a scope's
/// storage maps (mutating them directly), mirroring
/// `go/kernel/reclamation.go`'s `InMemoryBackend.Reclaim`.
ReclamationSummary reclaimScope({
  required Map<String, Run> runs,
  required Map<String, TurnNode> nodes,
  required Map<String, TurnTree> trees,
  required Map<String, StoredObject> objects,
  required Map<String, Branch> branches,
  required Map<String, Thread> threads,
  required Map<String, List<StagedResult>> stagedByRun,
  required int nowMs,
}) {
  final graceHorizonMs = _computeGraceHorizonMs(runs, nowMs);

  final keepObjects = <String>{};
  final keepTurnNodes = <String>{};
  final keepTurnTrees = <String>{};
  final turnNodeStack = <String>[];
  final turnTreeStack = <String>[];

  _seedLiveRoots(
    branches,
    threads,
    runs,
    stagedByRun,
    turnNodeStack,
    keepObjects,
  );
  _seedGraceRoots(
    nodes,
    trees,
    objects,
    graceHorizonMs,
    turnNodeStack,
    turnTreeStack,
    keepObjects,
  );
  _closeTurnNodeReachability(
    nodes,
    keepTurnNodes,
    keepObjects,
    turnNodeStack,
    turnTreeStack,
  );
  _closeTurnTreeReachability(trees, keepTurnTrees, keepObjects, turnTreeStack);

  return _sweep(
    branches,
    runs,
    nodes,
    trees,
    objects,
    stagedByRun,
    keepObjects,
    keepTurnNodes,
    keepTurnTrees,
    graceHorizonMs,
  );
}
