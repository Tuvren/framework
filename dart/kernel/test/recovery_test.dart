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

/// Restart-recovery coverage, porting the essential scenarios from
/// `go/kernel/lease_and_recovery_test.go`'s fault-injection and recovery
/// sections: all three fault points' commit invariants, `reconcileRun`'s
/// torn-checkpoint roll-forward and lost-CAS/terminal-run guards, the
/// pending-checkpoint refusal on a naive retry, and
/// `commitSiblingCheckpoint`'s single-writer CAS.
library;

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/kernel_fixtures.dart';

/// Registers [canonicalSchema], creates `thread_crash`/`branch_crash`, a
/// two-step run `run_crash`, completes step 1, and stages (but does not
/// yet checkpoint) message 2 -- the shared "about to tear step 2's
/// checkpoint" setup `go/kernel/lease_and_recovery_test.go`'s
/// `setUpFirstCheckpoint` builds.
(String, String) setUpFirstCheckpoint(Kernel kernel) {
  kernel.registerSchema(canonicalSchema());
  final created =
      kernel.createThread('thread_crash', 'schema_main', 'branch_crash');
  const steps = [
    StepDeclaration(id: 'step_1', deterministic: true, sideEffects: false),
    StepDeclaration(id: 'step_2', deterministic: true, sideEffects: false),
  ];
  kernel.createRun(
    'run_crash',
    'turn_crash',
    'branch_crash',
    'schema_main',
    created.rootTurnNodeHash,
    steps,
  );

  final message1Hash =
      kernel.putObject('application/json', 'message-1'.codeUnits);
  kernel.stageResult(
    'run_crash',
    StagedResult(
      taskId: 'task_1',
      objectHash: message1Hash,
      objectType: 'message',
      timestamp: 0,
      status: StagedResultStatus.completed,
    ),
  );
  kernel.completeStep('run_crash', 'step_1', '', '');

  final message2Hash =
      kernel.putObject('application/json', 'message-2'.codeUnits);
  kernel.stageResult(
    'run_crash',
    StagedResult(
      taskId: 'task_2',
      objectHash: message2Hash,
      objectType: 'message',
      timestamp: 0,
      status: StagedResultStatus.completed,
    ),
  );

  return ('run_crash', message2Hash);
}

int messageCount(Kernel kernel, String branchId) {
  final branch = kernel.backend.getBranch(branchId)!;
  final node = kernel.backend.getTurnNode(branch.headTurnNodeHash)!;
  final tree = kernel.backend.getTurnTree(node.turnTreeHash)!;
  return tree.manifest['messages']!.ordered!.length;
}

void main() {
  group('fault point: before-commit', () {
    test('nothing durable changes and the staged message is restaged', () {
      final (kernel, _) = newManualClockKernel(0);
      final (runId, _) = setUpFirstCheckpoint(kernel);

      final baseBackend = kernel.backend;
      final beforeHead = kernel.backend.getBranch('branch_crash')!;

      kernel.backend = FaultInjectingBackend(
        baseBackend,
        const FaultPlan(
            point: FaultPoint.beforeCommit, policy: FaultPolicy.once),
      );
      expectKernelError(
        () => kernel.completeStep(runId, 'step_2', '', ''),
        errPersistenceFaultInjected,
      );
      kernel.backend = baseBackend;

      final afterHead = kernel.backend.getBranch('branch_crash')!;
      expect(afterHead.headTurnNodeHash, beforeHead.headTurnNodeHash);
      expect(messageCount(kernel, 'branch_crash'), 1);

      final state = kernel.recoveryState(runId);
      expect(state.uncommittedStagedResults, hasLength(1));
      expect(state.lastTurnNodeHash, afterHead.headTurnNodeHash);
    });
  });

  void testFaultPointCommitsDespiteError(FaultPoint point) {
    final (kernel, _) = newManualClockKernel(0);
    final (runId, message2Hash) = setUpFirstCheckpoint(kernel);

    final baseBackend = kernel.backend;
    kernel.backend = FaultInjectingBackend(
      baseBackend,
      FaultPlan(point: point, policy: FaultPolicy.once),
    );
    expectKernelError(
      () => kernel.completeStep(runId, 'step_2', '', ''),
      errPersistenceFaultInjected,
    );
    kernel.backend = baseBackend;

    expect(messageCount(kernel, 'branch_crash'), 2);

    final branch = kernel.backend.getBranch('branch_crash')!;
    final node = kernel.backend.getTurnNode(branch.headTurnNodeHash)!;
    final tree = kernel.backend.getTurnTree(node.turnTreeHash)!;
    expect(tree.manifest['messages']!.ordered, contains(message2Hash));

    final staleRun = kernel.backend.getRun(runId)!;
    expect(staleRun.currentStepIndex, 1,
        reason: 'run record is stale before reconciliation');

    kernel.reconcileRun(runId);

    final reconciled = kernel.backend.getRun(runId)!;
    expect(reconciled.currentStepIndex, 2);

    final state = kernel.recoveryState(runId);
    expect(state.lastTurnNodeHash, branch.headTurnNodeHash);
    expect(state.uncommittedStagedResults, isEmpty);
  }

  group('fault point: after-commit-before-ack', () {
    test('commits despite the injected error and reconciles cleanly', () {
      testFaultPointCommitsDespiteError(FaultPoint.afterCommitBeforeAck);
    });
  });

  group('fault point: mid-commit', () {
    test('leaves a genuine torn checkpoint that reconcile rolls forward', () {
      final (kernel, _) = newManualClockKernel(0);
      final (runId, message2Hash) = setUpFirstCheckpoint(kernel);

      final beforeHead = kernel.backend.getBranch('branch_crash')!;

      final baseBackend = kernel.backend;
      kernel.backend = FaultInjectingBackend(
        baseBackend,
        const FaultPlan(point: FaultPoint.midCommit, policy: FaultPolicy.once),
      );
      expectKernelError(
        () => kernel.completeStep(runId, 'step_2', '', ''),
        errPersistenceFaultInjected,
      );
      kernel.backend = baseBackend;

      final afterFaultHead = kernel.backend.getBranch('branch_crash')!;
      expect(afterFaultHead.headTurnNodeHash, beforeHead.headTurnNodeHash);
      expect(messageCount(kernel, 'branch_crash'), 1);

      final pendingChildren =
          kernel.backend.listChildTurnNodes(beforeHead.headTurnNodeHash);
      expect(pendingChildren, hasLength(1));
      final pendingNode = pendingChildren.single;
      final pendingTree = kernel.backend.getTurnTree(pendingNode.turnTreeHash)!;
      expect(pendingTree.manifest['messages']!.ordered, contains(message2Hash));
      expect(pendingNode.consumedStagedResults, hasLength(1));

      final state = kernel.recoveryState(runId);
      expect(state.uncommittedStagedResults, isEmpty,
          reason: 'message 2 is embedded in the pending node, not restaged');

      final staleRun = kernel.backend.getRun(runId)!;
      expect(staleRun.currentStepIndex, 1);

      kernel.reconcileRun(runId);

      final afterReconcileHead = kernel.backend.getBranch('branch_crash')!;
      expect(afterReconcileHead.headTurnNodeHash, pendingNode.hash);
      expect(messageCount(kernel, 'branch_crash'), 2);

      final reconciled = kernel.backend.getRun(runId)!;
      expect(reconciled.currentStepIndex, 2);
      expect(reconciled.createdTurnNodes.last, pendingNode.hash);

      final postState = kernel.recoveryState(runId);
      expect(postState.lastTurnNodeHash, pendingNode.hash);
      expect(postState.uncommittedStagedResults, isEmpty);
    });

    test('naive retry without reconciling is rejected, marker/head untouched',
        () {
      final (kernel, _) = newManualClockKernel(0);
      final (runId, message2Hash) = setUpFirstCheckpoint(kernel);

      final beforeTornHead = kernel.backend.getBranch('branch_crash')!;

      final baseBackend = kernel.backend;
      kernel.backend = FaultInjectingBackend(
        baseBackend,
        const FaultPlan(point: FaultPoint.midCommit, policy: FaultPolicy.once),
      );
      expectKernelError(
        () => kernel.completeStep(runId, 'step_2', '', ''),
        errPersistenceFaultInjected,
      );
      kernel.backend = baseBackend;

      final tornRun = kernel.backend.getRun(runId)!;
      expect(tornRun.pendingCheckpointHash, isNotEmpty);
      expect(tornRun.pendingCheckpointKind, PendingCheckpointKind.step);

      final pendingBefore =
          kernel.backend.listChildTurnNodes(beforeTornHead.headTurnNodeHash);
      expect(pendingBefore, hasLength(1));
      final pendingHash = pendingBefore.single.hash;

      expectKernelError(
        () => kernel.completeStep(runId, 'step_2', '', ''),
        errRunPendingCheckpoint,
      );

      final afterRetryRun = kernel.backend.getRun(runId)!;
      expect(
          afterRetryRun.pendingCheckpointHash, tornRun.pendingCheckpointHash);
      expect(afterRetryRun.currentStepIndex, tornRun.currentStepIndex);
      final afterRetryHead = kernel.backend.getBranch('branch_crash')!;
      expect(afterRetryHead.headTurnNodeHash, beforeTornHead.headTurnNodeHash);
      final pendingAfter =
          kernel.backend.listChildTurnNodes(beforeTornHead.headTurnNodeHash);
      expect(pendingAfter, hasLength(1),
          reason: 'the rejected retry must not mint a second node');

      final state = kernel.recoveryState(runId);
      expect(state.uncommittedStagedResults, isEmpty);

      kernel.reconcileRun(runId);

      final reconciledHead = kernel.backend.getBranch('branch_crash')!;
      expect(reconciledHead.headTurnNodeHash, pendingHash);
      final headNode =
          kernel.backend.getTurnNode(reconciledHead.headTurnNodeHash)!;
      expect(headNode.consumedStagedResults.map((r) => r.objectHash),
          contains(message2Hash));

      final reconciledRun = kernel.backend.getRun(runId)!;
      expect(reconciledRun.currentStepIndex, 2);
      expect(reconciledRun.pendingCheckpointHash, isEmpty);

      // Steps are now exhausted: retrying step_2 again is an ordinary
      // unexpected-step rejection, not another pending-checkpoint refusal.
      expectKernelError(
        () => kernel.completeStep(runId, 'step_2', '', ''),
        errUnexpectedStep,
      );
    });
  });

  group('reconcileRun guards', () {
    test('a lost CAS against a foreign winner retires the stale marker', () {
      final (kernel, _) = newManualClockKernel(0);
      final (runId, _) = setUpFirstCheckpoint(kernel);

      final beforeHead = kernel.backend.getBranch('branch_crash')!;
      final headNode = kernel.backend.getTurnNode(beforeHead.headTurnNodeHash)!;

      final baseBackend = kernel.backend;
      kernel.backend = FaultInjectingBackend(
        baseBackend,
        const FaultPlan(point: FaultPoint.midCommit, policy: FaultPolicy.once),
      );
      expectKernelError(
        () => kernel.completeStep(runId, 'step_2', '', ''),
        errPersistenceFaultInjected,
      );
      kernel.backend = baseBackend;

      final tornRun = kernel.backend.getRun(runId)!;
      expect(tornRun.pendingCheckpointHash, isNotEmpty);
      final createdBefore = tornRun.createdTurnNodes.length;
      final stepIndexBefore = tornRun.currentStepIndex;

      final foreignEvent =
          kernel.putObject('application/json', 'foreign-winner'.codeUnits);
      final foreignNode = kernel.commitSiblingCheckpoint(
        'branch_crash',
        beforeHead.headTurnNodeHash,
        TurnNode(
          hash: '',
          schemaId: headNode.schemaId,
          turnTreeHash: headNode.turnTreeHash,
          eventHash: foreignEvent,
        ),
      );

      kernel.reconcileRun(runId);

      final branch = kernel.backend.getBranch('branch_crash')!;
      expect(branch.headTurnNodeHash, foreignNode);

      final reconciled = kernel.backend.getRun(runId)!;
      expect(reconciled.pendingCheckpointHash, isEmpty);
      expect(reconciled.pendingCheckpointKind, isNull);
      expect(reconciled.createdTurnNodes, hasLength(createdBefore));
      expect(reconciled.currentStepIndex, stepIndexBefore);
    });

    test(
        'reconciling an older terminal run after a later run advanced is a no-op',
        () {
      final (kernel, _) = newManualClockKernel(0);
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread('thread_reconcile_terminal',
          'schema_main', 'branch_reconcile_terminal');
      const steps = [
        StepDeclaration(
            id: 'only_step', deterministic: true, sideEffects: false),
      ];

      kernel.createRun('run_a', 'turn_a', 'branch_reconcile_terminal',
          'schema_main', created.rootTurnNodeHash, steps);
      final message1 =
          kernel.putObject('application/json', 'message-a'.codeUnits);
      kernel.stageResult(
        'run_a',
        StagedResult(
          taskId: 'task_a',
          objectHash: message1,
          objectType: 'message',
          timestamp: 0,
          status: StagedResultStatus.completed,
        ),
      );
      kernel.completeStep('run_a', 'only_step', '', '');
      kernel.completeRun('run_a', '');

      final runABefore = kernel.backend.getRun('run_a')!;
      expect(runABefore.status, RunStatus.completed);
      final createdBefore = List.of(runABefore.createdTurnNodes);
      final stepIndexBefore = runABefore.currentStepIndex;

      final branchAfterA =
          kernel.backend.getBranch('branch_reconcile_terminal')!;

      kernel.createRun('run_b', 'turn_b', 'branch_reconcile_terminal',
          'schema_main', branchAfterA.headTurnNodeHash, steps);
      final message2 =
          kernel.putObject('application/json', 'message-b'.codeUnits);
      kernel.stageResult(
        'run_b',
        StagedResult(
          taskId: 'task_b',
          objectHash: message2,
          objectType: 'message',
          timestamp: 0,
          status: StagedResultStatus.completed,
        ),
      );
      kernel.completeStep('run_b', 'only_step', '', '');

      final branchAfterB =
          kernel.backend.getBranch('branch_reconcile_terminal')!;
      expect(branchAfterB.headTurnNodeHash,
          isNot(equals(branchAfterA.headTurnNodeHash)));

      kernel.reconcileRun('run_a');

      final runAAfter = kernel.backend.getRun('run_a')!;
      expect(runAAfter.currentStepIndex, stepIndexBefore);
      expect(runAAfter.createdTurnNodes, createdBefore);
    });
  });

  group('commitSiblingCheckpoint', () {
    test('first writer wins, second loses with a typed lateral conflict', () {
      final (kernel, _) = newManualClockKernel(0);
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread(
          'thread_concurrent', 'schema_main', 'branch_concurrent');
      final base = created.rootTurnNodeHash;

      final eventA = kernel.putObject('application/json', 'writer-a'.codeUnits);
      final winnerHash = kernel.commitSiblingCheckpoint(
        'branch_concurrent',
        base,
        TurnNode(
          hash: '',
          schemaId: 'schema_main',
          turnTreeHash: created.rootTurnTreeHash,
          eventHash: eventA,
        ),
      );

      final eventB = kernel.putObject('application/json', 'writer-b'.codeUnits);
      expectKernelError(
        () => kernel.commitSiblingCheckpoint(
          'branch_concurrent',
          base,
          TurnNode(
            hash: '',
            schemaId: 'schema_main',
            turnTreeHash: created.rootTurnTreeHash,
            eventHash: eventB,
          ),
        ),
        errCheckpointLateralConflict,
      );

      final branch = kernel.backend.getBranch('branch_concurrent')!;
      expect(branch.headTurnNodeHash, winnerHash);
    });
  });
}
