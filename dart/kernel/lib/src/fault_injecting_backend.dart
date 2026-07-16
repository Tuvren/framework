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

/// The M3 restart-recovery capability's fault-injection seam:
/// [FaultInjectingBackend], a test/adapter-only [Backend] decorator that
/// interrupts the checkpoint-commit path (`Kernel.checkpointRun`'s
/// `putTurnNode` + `updateBranchHead`/`compareAndSwapBranchHead` +
/// optional after-commit-before-ack hook) at a chosen point, mirroring
/// `go/kernel/fault_injecting_backend.go`. Every other [Backend] method
/// passes straight through to the wrapped backend unmodified.
library;

import 'backend.dart';
import 'clock.dart';
import 'errors.dart';
import 'validate.dart';

/// A point in the checkpoint-commit sequence a [FaultPlan] can target.
enum FaultPoint {
  /// Fires before the checkpoint's turn node is ever written: `putTurnNode`
  /// fails outright and nothing durable changes.
  beforeCommit,

  /// Fires from the `updateBranchHead`/`compareAndSwapBranchHead` call
  /// itself without performing the head move: the turn node write already
  /// happened durably, but the branch head is left pointing at its
  /// pre-commit value, modeling a genuine torn checkpoint -- a crash after
  /// the node is durable but before the head advance that would have made
  /// it live.
  midCommit,

  /// Fires after both durable writes above have succeeded and
  /// `Kernel.checkpointRun` would otherwise report success -- modeling a
  /// crash between a fully-durable commit and the caller's acknowledgment
  /// of it.
  afterCommitBeforeAck,
}

/// Controls how many matching commit attempts a [FaultPlan] fires on.
enum FaultPolicy {
  /// Injects the fault on the first eligible commit attempt only; every
  /// later attempt through the same [FaultInjectingBackend] proceeds
  /// normally.
  once,

  /// Injects the fault on every eligible commit attempt.
  always,
}

/// Describes when and how a [FaultInjectingBackend] should inject a fault.
final class FaultPlan {
  const FaultPlan({required this.point, required this.policy});

  final FaultPoint point;
  final FaultPolicy policy;
}

KernelException _injectedFaultError(FaultPoint point) => KernelException(
      errPersistenceFaultInjected,
      'injected ${point.name} persistence fault interrupted checkpoint commit',
    );

/// Wraps a [Backend] so its checkpoint-commit path (`putTurnNode`,
/// `updateBranchHead`/`compareAndSwapBranchHead`, and the
/// [AfterCommitBeforeAckHook] seam `Kernel.checkpointRun` calls) fails at
/// `plan.point`, for exercising crash-recovery behavior. Every other
/// [Backend] method passes straight through to [inner] unmodified.
final class FaultInjectingBackend implements Backend, AfterCommitBeforeAckHook {
  FaultInjectingBackend(this.inner, this.plan);

  final Backend inner;
  final FaultPlan plan;

  bool _consumed = false;

  /// Reports whether this backend has already injected its fault (always
  /// `false` for [FaultPolicy.always] since it never marks itself
  /// consumed).
  bool get consumed => _consumed;

  bool _shouldFire() {
    if (plan.policy == FaultPolicy.once && _consumed) return false;
    return true;
  }

  void _markConsumed() => _consumed = true;

  /// The checkpoint-commit sequence's first durable write: a
  /// [FaultPoint.beforeCommit] plan fires here, before [inner] ever sees
  /// the write.
  @override
  void putTurnNode(TurnNode node) {
    if (plan.point == FaultPoint.beforeCommit && _shouldFire()) {
      _markConsumed();
      throw _injectedFaultError(FaultPoint.beforeCommit);
    }
    inner.putTurnNode(node);
  }

  /// The checkpoint-commit sequence's second durable write. A
  /// [FaultPoint.midCommit] plan fires here without ever calling through
  /// to [inner]: the head is left exactly where it was, modeling a
  /// genuine torn checkpoint rather than a head move the caller merely
  /// failed to be acknowledged for.
  @override
  bool updateBranchHead(
      String branchId, String headTurnNodeHash, int updatedAtMs) {
    if (plan.point == FaultPoint.midCommit && _shouldFire()) {
      _markConsumed();
      throw _injectedFaultError(FaultPoint.midCommit);
    }
    return inner.updateBranchHead(branchId, headTurnNodeHash, updatedAtMs);
  }

  /// Mirrors [updateBranchHead]'s [FaultPoint.midCommit] handling for the
  /// atomic head-CAS path: the fault fires without ever attempting the
  /// swap, leaving the head at [expectedHead].
  @override
  bool compareAndSwapBranchHead(
    String branchId,
    String expectedHead,
    String newHead,
    int updatedAtMs,
  ) {
    if (plan.point == FaultPoint.midCommit && _shouldFire()) {
      _markConsumed();
      throw _injectedFaultError(FaultPoint.midCommit);
    }
    return inner.compareAndSwapBranchHead(
        branchId, expectedHead, newHead, updatedAtMs);
  }

  /// Implements [AfterCommitBeforeAckHook]: `Kernel.checkpointRun` calls
  /// this after both durable writes above have already succeeded, letting
  /// a [FaultPoint.afterCommitBeforeAck] plan fire precisely there.
  @override
  void afterCommitBeforeAck() {
    if (plan.point == FaultPoint.afterCommitBeforeAck && _shouldFire()) {
      _markConsumed();
      throw _injectedFaultError(FaultPoint.afterCommitBeforeAck);
    }
  }

  // --- pure pass-through ---

  @override
  Clock get clock => inner.clock;

  @override
  StoredObject putObject(String mediaType, List<int> data) =>
      inner.putObject(mediaType, data);

  @override
  StoredObject? getObject(String hash) => inner.getObject(hash);

  @override
  bool hasObject(String hash) => inner.hasObject(hash);

  @override
  bool putSchema(TurnTreeSchema schema) => inner.putSchema(schema);

  @override
  TurnTreeSchema? getSchema(String schemaId) => inner.getSchema(schemaId);

  @override
  void putTurnTree(TurnTree tree) => inner.putTurnTree(tree);

  @override
  TurnTree? getTurnTree(String hash) => inner.getTurnTree(hash);

  @override
  TurnNode? getTurnNode(String hash) => inner.getTurnNode(hash);

  @override
  List<TurnNode> listChildTurnNodes(String previousHash) =>
      inner.listChildTurnNodes(previousHash);

  @override
  bool putThread(Thread thread) => inner.putThread(thread);

  @override
  Thread? getThread(String threadId) => inner.getThread(threadId);

  @override
  String? getThreadByRootTurnNode(String rootTurnNodeHash) =>
      inner.getThreadByRootTurnNode(rootTurnNodeHash);

  @override
  List<Thread> listThreads() => inner.listThreads();

  @override
  bool putBranch(Branch branch) => inner.putBranch(branch);

  @override
  Branch? getBranch(String branchId) => inner.getBranch(branchId);

  @override
  List<Branch> listBranchesByThread(String threadId) =>
      inner.listBranchesByThread(threadId);

  @override
  bool putRun(Run run) => inner.putRun(run);

  @override
  Run? getRun(String runId) => inner.getRun(runId);

  @override
  bool updateRun(Run run) => inner.updateRun(run);

  @override
  List<Run> listRunsByBranch(String branchId) =>
      inner.listRunsByBranch(branchId);

  @override
  List<Run> listRuns() => inner.listRuns();

  @override
  void stageResult(String runId, StagedResult result) =>
      inner.stageResult(runId, result);

  @override
  List<StagedResult> drainStagedResults(String runId) =>
      inner.drainStagedResults(runId);
}
