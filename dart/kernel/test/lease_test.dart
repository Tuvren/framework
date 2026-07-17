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

/// Run-liveness lease coverage, porting the essential scenarios from
/// `go/kernel/lease_and_recovery_test.go`'s lease section: acquire/renew
/// math, the renewal guard ladder's mismatch codes, expired-run listing
/// with paused exclusion, and stale preemption's observation fields.
library;

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/kernel_fixtures.dart';

void main() {
  group('acquire and renew', () {
    test(
      'acquire then renew extends expiry from the current clock reading',
      () {
        final (kernel, clock) = newManualClockKernel(10);
        createSingleStepRun(
          kernel,
          'thread_lease',
          'branch_lease',
          'run_lease',
        );

        final (token, expiresAt) = kernel.acquireLease(
          'run_lease',
          'owner_a',
          20,
        );
        expect(expiresAt, 30);

        clock.setMs(20);
        final renewed = kernel.renewLease('run_lease', 'owner_a', token, 20);
        expect(renewed, 40);
      },
    );

    test('renew with the wrong owner is rejected', () {
      final (kernel, _) = newManualClockKernel(10);
      createSingleStepRun(kernel, 'thread_lo', 'branch_lo', 'run_lo');
      final (token, _) = kernel.acquireLease('run_lo', 'owner_a', 20);
      expectKernelError(
        () => kernel.renewLease('run_lo', 'owner_b', token, 20),
        errRunLeaseOwnerMismatch,
      );
    });

    test('renew with a stale token is rejected', () {
      final (kernel, _) = newManualClockKernel(10);
      createSingleStepRun(kernel, 'thread_lt', 'branch_lt', 'run_lt');
      kernel.acquireLease('run_lt', 'owner_a', 20);
      expectKernelError(
        () => kernel.renewLease('run_lt', 'owner_a', 'not-the-real-token', 20),
        errRunLeaseTokenMismatch,
      );
    });

    test(
      'renew of an already-expired lease is rejected (expiry inclusive)',
      () {
        final (kernel, clock) = newManualClockKernel(0);
        createSingleStepRun(kernel, 'thread_le', 'branch_le', 'run_le');
        final (token, expiresAt) = kernel.acquireLease('run_le', 'owner_a', 10);
        clock.setMs(expiresAt);
        expectKernelError(
          () => kernel.renewLease('run_le', 'owner_a', token, 10),
          errRunLeaseExpired,
        );
      },
    );

    test(
      'renew of a paused run is rejected by the status guard, not lease-not-held',
      () {
        final (kernel, _) = newManualClockKernel(0);
        createSingleStepRun(kernel, 'thread_lp', 'branch_lp', 'run_lp');
        final (token, _) = kernel.acquireLease('run_lp', 'owner_a', 1000);
        kernel.pauseRun('run_lp');

        final run = kernel.backend.getRun('run_lp')!;
        expect(
          run.hasLease,
          isTrue,
          reason: 'pauseRun must not touch lease state',
        );

        expectKernelError(
          () => kernel.renewLease('run_lp', 'owner_a', token, 10),
          errRunNotActive,
        );
      },
    );

    test('renew without ever acquiring is rejected with leaseNotHeld', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_ln', 'branch_ln', 'run_ln');
      expectKernelError(
        () => kernel.renewLease('run_ln', 'owner_a', 'whatever', 10),
        errRunLeaseNotHeld,
      );
    });

    test(
      'acquire on a completed run is rejected and leaves lease state untouched',
      () {
        final kernel = newTestKernel();
        createSingleStepRun(kernel, 'thread_lc', 'branch_lc', 'run_lc');
        kernel.completeStep('run_lc', 'only_step', '', '');
        kernel.completeRun('run_lc', '');

        expectKernelError(
          () => kernel.acquireLease('run_lc', 'owner_a', 1000),
          errRunNotActive,
        );
        final run = kernel.backend.getRun('run_lc')!;
        expect(run.hasLease, isFalse);
      },
    );

    test(
      'lease tokens are unique per acquisition even under a frozen clock',
      () {
        final (kernel, _) = newManualClockKernel(10);
        createSingleStepRun(kernel, 'thread_tu', 'branch_tu', 'run_tu');
        final (tokenA, _) = kernel.acquireLease('run_tu', 'owner_a', 20);
        final (tokenB, _) = kernel.acquireLease('run_tu', 'owner_b', 20);
        expect(tokenA, isNot(equals(tokenB)));
      },
    );
  });

  group('pause', () {
    test('pausing a completed run is rejected and does not resurrect it', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_pc', 'branch_pc', 'run_pc');
      kernel.completeStep('run_pc', 'only_step', '', '');
      kernel.completeRun('run_pc', '');
      expectKernelError(() => kernel.pauseRun('run_pc'), errRunNotActive);
      expect(kernel.backend.getRun('run_pc')!.status, RunStatus.completed);
    });
  });

  group('expired listing', () {
    test('excludes paused runs even with an expired lease on record', () {
      final (kernel, clock) = newManualClockKernel(0);
      createSingleStepRun(kernel, 'thread_x1', 'branch_x1', 'run_running');
      createSingleStepRun(kernel, 'thread_x2', 'branch_x2', 'run_paused');

      kernel.acquireLease('run_running', 'owner_a', 10);
      kernel.acquireLease('run_paused', 'owner_a', 10);
      kernel.pauseRun('run_paused');

      clock.setMs(100);
      final expired = kernel.listExpiredRuns(100);
      expect(expired, ['run_running']);

      final pausedRun = kernel.backend.getRun('run_paused')!;
      expect(pausedRun.status, RunStatus.paused);
    });

    test('is sorted by runId and excludes non-expired leases', () {
      final (kernel, _) = newManualClockKernel(0);
      createSingleStepRun(kernel, 'thread_b', 'branch_b', 'run_b');
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      createSingleStepRun(kernel, 'thread_c', 'branch_c', 'run_c');

      kernel.acquireLease('run_b', 'owner', 5);
      kernel.acquireLease('run_a', 'owner', 5);
      kernel.acquireLease('run_c', 'owner', 5000);

      final expired = kernel.listExpiredRuns(10);
      expect(expired, ['run_a', 'run_b']);
    });
  });

  group('stale preemption', () {
    test(
      'fails the run, mints a preemption checkpoint, and clears the lease',
      () {
        final (kernel, clock) = newManualClockKernel(0);
        createSingleStepRun(kernel, 'thread_sp', 'branch_sp', 'run_sp');
        final (_, expiresAt) = kernel.acquireLease('run_sp', 'owner_a', 10);

        clock.setMs(expiresAt);
        kernel.preemptStaleRun('run_sp', expiresAt);

        final run = kernel.backend.getRun('run_sp')!;
        expect(run.status, RunStatus.failed);
        expect(run.preemptionReason, 'stale_running_recovery');
        expect(run.hasLease, isFalse);
        expect(run.leaseToken, isEmpty);

        final branch = kernel.backend.getBranch('branch_sp')!;
        expect(branch.headTurnNodeHash, run.createdTurnNodes.last);

        final headNode = kernel.backend.getTurnNode(branch.headTurnNodeHash)!;
        expect(headNode.eventHash, isNotEmpty);
      },
    );

    test(
      'preserves staged-but-uncommitted work in the preemption checkpoint',
      () {
        final (kernel, clock) = newManualClockKernel(0);
        createSingleStepRun(kernel, 'thread_sw', 'branch_sw', 'run_sw');
        final (_, expiresAt) = kernel.acquireLease('run_sw', 'owner_a', 10);

        final objectHash = kernel.putObject('application/octet-stream', [4, 2]);
        kernel.stageResult(
          'run_sw',
          StagedResult(
            taskId: 'task_1',
            objectHash: objectHash,
            objectType: 'message',
            timestamp: 1,
            status: StagedResultStatus.completed,
          ),
        );

        clock.setMs(expiresAt);
        kernel.preemptStaleRun('run_sw', expiresAt);

        final run = kernel.backend.getRun('run_sw')!;
        final headNode = kernel.backend.getTurnNode(run.createdTurnNodes.last)!;
        expect(headNode.consumedStagedResults, hasLength(1));
        expect(headNode.consumedStagedResults.single.taskId, 'task_1');

        final tree = kernel.backend.getTurnTree(headNode.turnTreeHash)!;
        expect(tree.manifest['messages']!.ordered, [objectHash]);

        // Nothing left uncommitted after a successful preemption checkpoint.
        final recovery = kernel.recoveryState('run_sw');
        expect(recovery.uncommittedStagedResults, isEmpty);
      },
    );

    test('a non-expired lease is not preemptable', () {
      final (kernel, _) = newManualClockKernel(0);
      createSingleStepRun(kernel, 'thread_np', 'branch_np', 'run_np');
      kernel.acquireLease('run_np', 'owner_a', 1000);
      expectKernelError(
        () => kernel.preemptStaleRun('run_np', 5),
        errRunNotPreemptable,
      );
    });

    test('a leaseless run is not preemptable', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_nl', 'branch_nl', 'run_nl');
      expectKernelError(
        () => kernel.preemptStaleRun('run_nl', 999999),
        errRunNotPreemptable,
      );
    });
  });
}
