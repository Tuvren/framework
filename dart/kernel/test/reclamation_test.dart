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

/// Reclamation coverage, porting the essential probes from
/// `go/kernel/scope_isolation_and_reclamation_test.go`'s `kernel.reclamation`
/// section: unreachable-past-grace release, archived-branch release with
/// shared-object retention via the live head, the active-run grace window,
/// and the leaseless-run 24h admin-expiry boundary on both sides.
library;

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/kernel_fixtures.dart';

(Kernel, ManualClock) newReclaimKernel(int startMs) {
  final (kernel, clock) = newManualClockKernel(startMs);
  kernel.registerSchema(canonicalSchema());
  return (kernel, clock);
}

void main() {
  test('an unreachable object past the grace horizon is released', () {
    final (kernel, _) = newReclaimKernel(0);
    final orphan = kernel.putObject(
        'application/octet-stream', 'unreachable-orphan'.codeUnits);
    expect(kernel.hasObject(orphan), isTrue);

    final summary = kernel.reclaim();
    expect(summary.releasedObjectCount, greaterThanOrEqualTo(1));
    expect(kernel.hasObject(orphan), isFalse);
  });

  test(
      'an archived branch releases its exclusive lineage but keeps shared objects',
      () {
    final (kernel, _) = newReclaimKernel(0);
    final created = kernel.createThread(
        'thread_reclaim_archive', 'schema_main', 'branch_reclaim_archive');

    final sharedMessage = kernel.putObject(
        'application/json', 'shared-across-live-and-archived'.codeUnits);
    final sharedTree = kernel.createTurnTree(
      'schema_main',
      {
        'messages': PathValue.ordered([sharedMessage])
      },
      base: created.rootTurnTreeHash,
    );
    final sharedNode = kernel.commitSiblingCheckpoint(
      'branch_reclaim_archive',
      created.rootTurnNodeHash,
      TurnNode(hash: '', schemaId: 'schema_main', turnTreeHash: sharedTree),
    );

    final archivedOnlyMessage = kernel.putObject(
        'application/json', 'archived-exclusive-payload'.codeUnits);
    final archivedTree = kernel.createTurnTree(
      'schema_main',
      {
        'messages': PathValue.ordered([sharedMessage, archivedOnlyMessage]),
      },
      base: sharedTree,
    );
    final archivedNode = kernel.commitSiblingCheckpoint(
      'branch_reclaim_archive',
      sharedNode,
      TurnNode(hash: '', schemaId: 'schema_main', turnTreeHash: archivedTree),
    );

    // Roll the live head back to the shared ancestor: the forward segment
    // (archivedNode) is archived and becomes unreferenced by any live root.
    kernel.setBranchHead('branch_reclaim_archive', sharedNode);

    final summary = kernel.reclaim();
    expect(summary.releasedArchivedBranchCount, greaterThanOrEqualTo(1));

    expect(kernel.hasObject(sharedMessage), isTrue,
        reason: 'retained via the live branch head');
    expect(kernel.hasObject(archivedOnlyMessage), isFalse);
    expect(kernel.backend.getTurnNode(archivedNode), isNull);
    expect(kernel.backend.getTurnNode(sharedNode), isNotNull);
  });

  test(
      'the grace window is held under an active run and gates by creation order',
      () {
    final (kernel, clock) = newReclaimKernel(0);

    clock.setMs(10);
    final orphanBeforeLease = kernel.putObject('application/octet-stream', [1]);

    clock.setMs(20);
    final created = kernel.createThread(
        'thread_reclaim_grace', 'schema_main', 'branch_reclaim_grace');
    kernel.createRun(
      'run_reclaim_grace',
      'turn_reclaim_grace',
      'branch_reclaim_grace',
      'schema_main',
      created.rootTurnNodeHash,
      const [
        StepDeclaration(id: 'work', deterministic: true, sideEffects: false)
      ],
    );

    clock.setMs(30);
    final orphanAfterLease = kernel.putObject('application/octet-stream', [2]);

    clock.setMs(40);
    kernel.reclaim();

    expect(kernel.hasObject(orphanBeforeLease), isFalse,
        reason: 'older than the active run that pins the horizon');
    expect(kernel.hasObject(orphanAfterLease), isTrue,
        reason: 'newer than the horizon, retained despite being unreachable');
  });

  test(
      'a leaseless run past the 24h admin-expiry horizon stops pinning reclamation',
      () {
    final (kernel, clock) = newReclaimKernel(0);
    final created = kernel.createThread(
        'thread_leaseless_expired', 'schema_main', 'branch_leaseless_expired');
    kernel.createRun(
      'run_leaseless_expired',
      'turn_leaseless_expired',
      'branch_leaseless_expired',
      'schema_main',
      created.rootTurnNodeHash,
      const [
        StepDeclaration(id: 'work', deterministic: true, sideEffects: false)
      ],
    );

    clock.setMs(10);
    final orphan = kernel.putObject(
        'application/octet-stream', 'leaseless-expiry-orphan'.codeUnits);

    clock.setMs(leaselessRunExpiryMs + 5000);
    kernel.reclaim();

    expect(kernel.hasObject(orphan), isFalse);
  });

  test(
      'a leaseless run within the 24h admin-expiry horizon still pins reclamation',
      () {
    final (kernel, clock) = newReclaimKernel(0);
    final created = kernel.createThread(
        'thread_leaseless_active', 'schema_main', 'branch_leaseless_active');
    kernel.createRun(
      'run_leaseless_active',
      'turn_leaseless_active',
      'branch_leaseless_active',
      'schema_main',
      created.rootTurnNodeHash,
      const [
        StepDeclaration(id: 'work', deterministic: true, sideEffects: false)
      ],
    );

    clock.setMs(10);
    final orphan = kernel.putObject(
        'application/octet-stream', 'leaseless-active-orphan'.codeUnits);

    clock.setMs(1000);
    kernel.reclaim();

    expect(kernel.hasObject(orphan), isTrue);
  });

  test('reclaim on a backend that does not implement Reclaimer is unsupported',
      () {
    final kernel =
        Kernel('scope', IncrementingClock(), _NonReclaimingBackend());
    expectKernelError(kernel.reclaim, errCapabilityUnsupported);
  });
}

/// A minimal [Backend] wrapper that deliberately does not implement
/// [Reclaimer], to exercise `Kernel.reclaim`'s capability-unsupported
/// guard the same way `go/kernel/scope_isolation_and_reclamation_test.go`'s
/// `TestReclamation_UnsupportedBackendRejectsWithCapabilityError` does.
class _NonReclaimingBackend implements Backend {
  final Backend _inner = InMemoryBackend();

  @override
  Clock get clock => _inner.clock;

  @override
  StoredObject putObject(String mediaType, List<int> data) =>
      _inner.putObject(mediaType, data);

  @override
  StoredObject? getObject(String hash) => _inner.getObject(hash);

  @override
  bool hasObject(String hash) => _inner.hasObject(hash);

  @override
  bool putSchema(TurnTreeSchema schema) => _inner.putSchema(schema);

  @override
  TurnTreeSchema? getSchema(String schemaId) => _inner.getSchema(schemaId);

  @override
  void putTurnTree(TurnTree tree) => _inner.putTurnTree(tree);

  @override
  TurnTree? getTurnTree(String hash) => _inner.getTurnTree(hash);

  @override
  void putTurnNode(TurnNode node) => _inner.putTurnNode(node);

  @override
  TurnNode? getTurnNode(String hash) => _inner.getTurnNode(hash);

  @override
  List<TurnNode> listChildTurnNodes(String previousHash) =>
      _inner.listChildTurnNodes(previousHash);

  @override
  bool putThread(Thread thread) => _inner.putThread(thread);

  @override
  Thread? getThread(String threadId) => _inner.getThread(threadId);

  @override
  String? getThreadByRootTurnNode(String rootTurnNodeHash) =>
      _inner.getThreadByRootTurnNode(rootTurnNodeHash);

  @override
  List<Thread> listThreads() => _inner.listThreads();

  @override
  bool putBranch(Branch branch) => _inner.putBranch(branch);

  @override
  Branch? getBranch(String branchId) => _inner.getBranch(branchId);

  @override
  List<Branch> listBranchesByThread(String threadId) =>
      _inner.listBranchesByThread(threadId);

  @override
  bool updateBranchHead(
          String branchId, String headTurnNodeHash, int updatedAtMs) =>
      _inner.updateBranchHead(branchId, headTurnNodeHash, updatedAtMs);

  @override
  bool compareAndSwapBranchHead(
    String branchId,
    String expectedHead,
    String newHead,
    int updatedAtMs,
  ) =>
      _inner.compareAndSwapBranchHead(
          branchId, expectedHead, newHead, updatedAtMs);

  @override
  bool putRun(Run run) => _inner.putRun(run);

  @override
  Run? getRun(String runId) => _inner.getRun(runId);

  @override
  bool updateRun(Run run) => _inner.updateRun(run);

  @override
  List<Run> listRunsByBranch(String branchId) =>
      _inner.listRunsByBranch(branchId);

  @override
  List<Run> listRuns() => _inner.listRuns();

  @override
  void stageResult(String runId, StagedResult result) =>
      _inner.stageResult(runId, result);

  @override
  List<StagedResult> drainStagedResults(String runId) =>
      _inner.drainStagedResults(runId);
}
