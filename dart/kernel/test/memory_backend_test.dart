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

/// [InMemoryBackend] coverage, porting the essential scenarios from
/// `go/kernel/memory_backend_test.go` (defensive copies), the
/// `kernel.scope-isolation` section of
/// `go/kernel/scope_isolation_and_reclamation_test.go`, and
/// `go/kernel/thread_root_uniqueness_internal_test.go` (root ownership
/// index / genesis-hash-collision defense).
library;

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/kernel_fixtures.dart';

(Kernel, Kernel) newScopedKernelPair() {
  final store = MemoryScopeStore();
  final clock = IncrementingClock();
  final backendA = InMemoryBackend.scoped(clock, store, 'tuvren.scope.test-a');
  final backendB = InMemoryBackend.scoped(clock, store, 'tuvren.scope.test-b');
  return (
    Kernel('scope-a', clock, backendA),
    Kernel('scope-b', clock, backendB),
  );
}

void main() {
  group('scope isolation', () {
    test('hasObject is scope-confined', () {
      final (kernelA, kernelB) = newScopedKernelPair();
      final hash = kernelA.putObject(
        'application/json',
        'scope-a content'.codeUnits,
      );
      expect(kernelA.hasObject(hash), isTrue);
      expect(kernelB.hasObject(hash), isFalse);
    });

    test('getObject is scope-confined', () {
      final (kernelA, kernelB) = newScopedKernelPair();
      final hash = kernelA.putObject(
        'application/json',
        'scope-a content'.codeUnits,
      );
      expect(kernelA.backend.getObject(hash), isNotNull);
      expect(kernelB.backend.getObject(hash), isNull);
    });

    test('thread enumeration is scope-confined', () {
      final (kernelA, kernelB) = newScopedKernelPair();
      kernelA.registerSchema(canonicalSchema());
      kernelA.createThread(
        'thread_scope_probe',
        'schema_main',
        'branch_scope_probe',
      );

      final (threadsA, _) = kernelA.listThreads(0, '');
      expect(threadsA.map((t) => t.threadId), contains('thread_scope_probe'));

      final (threadsB, _) = kernelB.listThreads(0, '');
      expect(
        threadsB.map((t) => t.threadId),
        isNot(contains('thread_scope_probe')),
      );
    });

    test(
      'two handles bound to the same store and scope share committed state',
      () {
        final store = MemoryScopeStore();
        final clock = IncrementingClock();
        final backend1 = InMemoryBackend.scoped(
          clock,
          store,
          'tuvren.scope.shared',
        );
        final backend2 = InMemoryBackend.scoped(
          clock,
          store,
          'tuvren.scope.shared',
        );
        final kernel1 = Kernel('shared', clock, backend1);
        final kernel2 = Kernel('shared', clock, backend2);

        final hash = kernel1.putObject(
          'application/json',
          'shared content'.codeUnits,
        );
        expect(kernel2.hasObject(hash), isTrue);
      },
    );
  });

  group('defensive copies', () {
    test('getTurnTree returns a copy independent of later mutation', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final hash = kernel.createTurnTree('schema_main', {
        'messages': const PathValue.ordered([]),
        'context.manifest': const PathValue.nullValue(),
      });

      final first = kernel.backend.getTurnTree(hash)!;
      first.manifest['messages'] = PathValue.ordered(['injected']);

      final second = kernel.backend.getTurnTree(hash)!;
      expect(second.manifest['messages']!.ordered, isEmpty);
    });

    test('mutating a returned ordered PathValue list in place does not '
        'corrupt stored state', () {
      // Regression for the P2-2 bug: TurnTree.clone() used to do a shallow
      // Map.of(manifest), so an ordered PathValue's backing List<String>
      // was shared between the backend's stored state and every value
      // returned by getTurnTree -- mutating the returned list in place
      // (rather than replacing the map entry) corrupted the stored tree.
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final hash = kernel.createTurnTree('schema_main', {
        'messages': const PathValue.ordered(['a', 'b']),
        'context.manifest': const PathValue.nullValue(),
      });

      final first = kernel.backend.getTurnTree(hash)!;
      first.manifest['messages']!.ordered!.add('injected');

      final second = kernel.backend.getTurnTree(hash)!;
      expect(second.manifest['messages']!.ordered, equals(['a', 'b']));
    });

    test(
      'getTurnNode returns a copy whose consumedStagedResults is independent storage',
      () {
        final kernel = newTestKernel();
        createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
        final hash = kernel.completeStep('run_a', 'only_step', '', '');

        final first = kernel.backend.getTurnNode(hash)!;
        first.consumedStagedResults.add(
          const StagedResult(
            taskId: 'injected',
            objectHash:
                '0000000000000000000000000000000000000000000000000000000000000000',
            objectType: 'message',
            timestamp: 0,
            status: StagedResultStatus.completed,
          ),
        );

        final second = kernel.backend.getTurnNode(hash)!;
        expect(second.consumedStagedResults, isEmpty);
      },
    );
  });

  group('thread root uniqueness', () {
    // go/kernel/thread_root_uniqueness_internal_test.go exercises
    // createThread's ErrThreadRootNotUnique defense-in-depth guard as an
    // *internal* (same-package) test by directly manipulating unexported
    // backend state to force a genesis-hash collision -- something
    // structurally unreachable through normal use once genesis nodes carry
    // a thread-unique bootstrap eventHash (see createThread's doc
    // comment). This port has no test-only backdoor into InMemoryBackend's
    // private scope state to reproduce that exact white-box setup, so this
    // instead pins the root-ownership index the guard depends on: every
    // created thread's root hash resolves back to its own owning thread,
    // and two threads on the same schema never collide.
    test('the root-ownership index resolves each thread back to itself', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final a = kernel.createThread('thread_a', 'schema_main', 'branch_a');
      final b = kernel.createThread('thread_b', 'schema_main', 'branch_b');

      expect(
        kernel.backend.getThreadByRootTurnNode(a.rootTurnNodeHash),
        'thread_a',
      );
      expect(
        kernel.backend.getThreadByRootTurnNode(b.rootTurnNodeHash),
        'thread_b',
      );
      expect(a.rootTurnNodeHash, isNot(equals(b.rootTurnNodeHash)));
    });
  });
}
