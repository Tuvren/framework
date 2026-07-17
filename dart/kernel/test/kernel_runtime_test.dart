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

/// Runtime-kernel structural coverage, porting the essential edge-validation
/// scenarios from `go/kernel/kernel_runtime_test.go`: schema registration,
/// turn tree create/diff, thread/branch genesis and lineage guards, and run
/// lifecycle basics.
library;

import 'dart:convert';

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/kernel_fixtures.dart';

void main() {
  group('schema registry', () {
    test('duplicate path in the same schema is rejected', () {
      final schema = const TurnTreeSchema(
        schemaId: 'schema_dup',
        paths: [
          PathDefinition(
            path: 'messages',
            collection: PathCollectionKind.ordered,
          ),
          PathDefinition(
            path: 'messages',
            collection: PathCollectionKind.ordered,
          ),
        ],
        incorporationRules: [],
      );
      expect(
        () => validateTurnTreeSchema(
          recordFromJson({
            'schemaId': schema.schemaId,
            'paths': [
              {'path': 'messages', 'collection': 'ordered'},
              {'path': 'messages', 'collection': 'ordered'},
            ],
            'incorporationRules': <Object?>[],
          }),
        ),
        throwsA(
          isA<KernelException>().having(
            (e) => e.code,
            'code',
            errDuplicateSchemaPath,
          ),
        ),
      );
    });

    test('registering the same schemaId twice is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      expectKernelError(
        () => kernel.registerSchema(canonicalSchema()),
        'kernel_runtime_schema_already_registered',
      );
    });
  });

  group('turn tree create', () {
    test('base-less create missing a required path is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      expectKernelError(
        () => kernel.createTurnTree('schema_main', {
          'messages': const PathValue.ordered([]),
        }),
        errMissingRequiredTreePath,
      );
    });

    test('undeclared path in changes is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      expectKernelError(
        () => kernel.createTurnTree('schema_main', {
          'messages': const PathValue.ordered([]),
          'context.manifest': const PathValue.nullValue(),
          'unknown.path': const PathValue.nullValue(),
        }),
        errUnknownTreePath,
      );
    });

    test('ordered path given a single value is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      expectKernelError(
        () => kernel.createTurnTree('schema_main', {
          'messages': const PathValue.nullValue(),
          'context.manifest': const PathValue.nullValue(),
        }),
        errInvalidPathValueKind,
      );
    });

    test('single path given an ordered value is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      expectKernelError(
        () => kernel.createTurnTree('schema_main', {
          'messages': const PathValue.ordered([]),
          'context.manifest': const PathValue.ordered([]),
        }),
        errInvalidPathValueKind,
      );
    });

    test('modify produces a new hash with structural sharing', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final base = kernel.createTurnTree('schema_main', {
        'messages': const PathValue.ordered([]),
        'context.manifest': const PathValue.nullValue(),
      });
      final aHash = 'a' * 64;
      final modified = kernel.createTurnTree('schema_main', {
        'context.manifest': PathValue.single(aHash),
      }, base: base);
      expect(modified, isNot(equals(base)));

      final baseTree = kernel.backend.getTurnTree(base)!;
      final modifiedTree = kernel.backend.getTurnTree(modified)!;
      expect(baseTree.manifest['messages']!.kind, PathValueKind.ordered);
      expect(modifiedTree.manifest['messages']!.kind, PathValueKind.ordered);
      expect(modifiedTree.manifest['context.manifest']!.single, aHash);
    });

    test('modify with a mismatched schema is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      kernel.registerSchema(
        const TurnTreeSchema(
          schemaId: 'schema_other',
          paths: [
            PathDefinition(path: 'x', collection: PathCollectionKind.single),
          ],
          incorporationRules: [],
        ),
      );
      final base = kernel.createTurnTree('schema_main', {
        'messages': const PathValue.ordered([]),
        'context.manifest': const PathValue.nullValue(),
      });
      expectKernelError(
        () => kernel.createTurnTree('schema_other', {
          'x': const PathValue.nullValue(),
        }, base: base),
        errTreeSchemaMismatch,
      );
    });
  });

  group('diff turn trees', () {
    test('mismatched schemas are rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      kernel.registerSchema(
        const TurnTreeSchema(
          schemaId: 'schema_other',
          paths: [
            PathDefinition(path: 'x', collection: PathCollectionKind.single),
          ],
          incorporationRules: [],
        ),
      );
      final treeA = kernel.createTurnTree('schema_main', {
        'messages': const PathValue.ordered([]),
        'context.manifest': const PathValue.nullValue(),
      });
      final treeB = kernel.createTurnTree('schema_other', {
        'x': const PathValue.nullValue(),
      });
      expectKernelError(
        () => kernel.diffTurnTrees(treeA, treeB),
        errTreeSchemaMismatchDiff,
      );
    });

    test('diff reports sorted changed paths', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final base = kernel.createTurnTree('schema_main', {
        'messages': const PathValue.ordered([]),
        'context.manifest': const PathValue.nullValue(),
      });
      final aHash = 'a' * 64;
      final modified = kernel.createTurnTree('schema_main', {
        'messages': PathValue.ordered([aHash]),
        'context.manifest': PathValue.single(aHash),
      }, base: base);
      final diff = kernel.diffTurnTrees(base, modified);
      expect(diff, ['context.manifest', 'messages']);
    });
  });

  group('threads and branches', () {
    test('createThread mints a root node and main branch', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread(
        'thread_a',
        'schema_main',
        'branch_main',
      );
      expect(created.threadId, 'thread_a');
      expect(created.branchId, 'branch_main');
      final branch = kernel.backend.getBranch('branch_main')!;
      expect(branch.headTurnNodeHash, created.rootTurnNodeHash);
      final thread = kernel.backend.getThread('thread_a')!;
      expect(thread.rootTurnNodeHash, created.rootTurnNodeHash);
    });

    test('two threads on the same schema mint distinct genesis hashes', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final a = kernel.createThread('thread_a', 'schema_main', 'branch_a');
      final b = kernel.createThread('thread_b', 'schema_main', 'branch_b');
      expect(a.rootTurnNodeHash, isNot(equals(b.rootTurnNodeHash)));
    });

    test('createBranch from a foreign thread turn node is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final a = kernel.createThread('thread_a', 'schema_main', 'branch_a');
      kernel.createThread('thread_b', 'schema_main', 'branch_b');
      expectKernelError(
        () => kernel.createBranch('branch_c', 'thread_b', a.rootTurnNodeHash),
        errTurnNodeThreadMismatch,
      );
    });

    test('setBranchHead lateral movement is rejected', () {
      // branch_main advances via a normal run checkpoint; branch_side
      // advances via an independent commitSiblingCheckpoint off the same
      // root, carrying a distinct eventHash so its node's content-address
      // genuinely differs from branch_main's (two checkpoints off the same
      // base that consumed nothing and carried no eventHash would
      // otherwise collide onto the identical hash, since node identity is
      // purely content-addressed). Their heads are then siblings with no
      // ancestor/descendant relationship, so moving one onto the other is
      // lateral.
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread(
        'thread_a',
        'schema_main',
        'branch_main',
      );
      kernel.createBranch('branch_side', 'thread_a', created.rootTurnNodeHash);

      kernel.createRun(
        'run_a',
        'turn_a',
        'branch_main',
        'schema_main',
        created.rootTurnNodeHash,
        const [
          StepDeclaration(id: 's1', deterministic: true, sideEffects: false),
        ],
      );
      kernel.completeStep('run_a', 's1', '', '');

      final sideEvent = kernel.putObject('application/octet-stream', [7]);
      final sideHash = kernel.commitSiblingCheckpoint(
        'branch_side',
        created.rootTurnNodeHash,
        TurnNode(
          hash: '',
          schemaId: 'schema_main',
          turnTreeHash: created.rootTurnTreeHash,
          eventHash: sideEvent,
        ),
      );

      expectKernelError(
        () => kernel.setBranchHead('branch_main', sideHash),
        errLateralHeadMovement,
      );
    });

    test('forward movement with an active run on the branch is rejected', () {
      // node2 is minted on a second branch (branch_probe) forked from
      // node1, so committing it there advances branch_probe's own head
      // without touching branch_main -- leaving branch_main's head at
      // node1, with run_a still "running" (step 2 pending), so an
      // external forward setBranchHead onto node2 has something to
      // reject.
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread(
        'thread_a',
        'schema_main',
        'branch_main',
      );
      kernel.createRun(
        'run_a',
        'turn_a',
        'branch_main',
        'schema_main',
        created.rootTurnNodeHash,
        const [
          StepDeclaration(id: 's1', deterministic: true, sideEffects: false),
          StepDeclaration(id: 's2', deterministic: true, sideEffects: false),
        ],
      );
      final node1 = kernel.completeStep('run_a', 's1', '', '');

      kernel.createBranch('branch_probe', 'thread_a', node1);
      final node1Full = kernel.backend.getTurnNode(node1)!;
      final foreignEvent = kernel.putObject('application/octet-stream', [9]);
      final node2 = kernel.commitSiblingCheckpoint(
        'branch_probe',
        node1,
        TurnNode(
          hash: '',
          schemaId: node1Full.schemaId,
          turnTreeHash: node1Full.turnTreeHash,
          eventHash: foreignEvent,
        ),
      );

      expect(
        kernel.backend.getBranch('branch_main')!.headTurnNodeHash,
        node1,
        reason: 'branch_main must be untouched by branch_probe\'s commit',
      );

      expectKernelError(
        () => kernel.setBranchHead('branch_main', node2),
        errBranchHasActiveRun,
      );
    });

    test(
      'backward movement archives the abandoned lineage and fails the active run',
      () {
        final kernel = newTestKernel();
        kernel.registerSchema(canonicalSchema());
        final created = kernel.createThread(
          'thread_a',
          'schema_main',
          'branch_main',
        );
        kernel.createRun(
          'run_a',
          'turn_a',
          'branch_main',
          'schema_main',
          created.rootTurnNodeHash,
          const [
            StepDeclaration(id: 's1', deterministic: true, sideEffects: false),
            StepDeclaration(id: 's2', deterministic: true, sideEffects: false),
          ],
        );
        // Only step 1 completes; run_a is still "running" (step 2 pending)
        // when the rollback below touches its lineage.
        kernel.completeStep('run_a', 's1', '', '');

        kernel.setBranchHead('branch_main', created.rootTurnNodeHash);

        final branch = kernel.backend.getBranch('branch_main')!;
        expect(branch.headTurnNodeHash, created.rootTurnNodeHash);

        final archived =
            kernel.backend
                .listBranchesByThread('thread_a')
                .where((b) => b.archivedFromBranchId == 'branch_main')
                .toList();
        expect(archived, hasLength(1));

        final run = kernel.backend.getRun('run_a')!;
        expect(run.status, RunStatus.failed);
      },
    );
  });

  group('run lifecycle', () {
    test('second active run on the same branch is rejected', () {
      final kernel = newTestKernel();
      final root = createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      expectKernelError(
        () => kernel.createRun(
          'run_b',
          'turn_b',
          'branch_a',
          'schema_main',
          root,
          const [
            StepDeclaration(
              id: 'only_step',
              deterministic: true,
              sideEffects: false,
            ),
          ],
        ),
        errBranchAlreadyActive,
      );
    });

    test('branch head mismatch is rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      kernel.createThread('thread_a', 'schema_main', 'branch_a');
      expectKernelError(
        () => kernel.createRun(
          'run_a',
          'turn_a',
          'branch_a',
          'schema_main',
          'f' * 64,
          const [
            StepDeclaration(
              id: 'only_step',
              deterministic: true,
              sideEffects: false,
            ),
          ],
        ),
        errRunBranchHeadMismatch,
      );
    });

    test('duplicate step ids in the sequence are rejected', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread(
        'thread_a',
        'schema_main',
        'branch_a',
      );
      expectKernelError(
        () => kernel.createRun(
          'run_a',
          'turn_a',
          'branch_a',
          'schema_main',
          created.rootTurnNodeHash,
          const [
            StepDeclaration(id: 'dup', deterministic: true, sideEffects: false),
            StepDeclaration(id: 'dup', deterministic: true, sideEffects: false),
          ],
        ),
        errDuplicateStepId,
      );
    });

    test('beginStep out of order is rejected', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      expectKernelError(
        () => kernel.beginStep('run_a', 'not_the_step'),
        errUnexpectedStep,
      );
    });

    test('completeStep with a missing event object is rejected', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      expectKernelError(
        () => kernel.completeStep('run_a', 'only_step', 'f' * 64, ''),
        errMissingEventObject,
      );
    });

    test('completeStep with an existing event object succeeds', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      final eventHash = kernel.putObject('application/octet-stream', [1, 2, 3]);
      final hash = kernel.completeStep('run_a', 'only_step', eventHash, '');
      expect(hash, isNotEmpty);
    });

    test('completeRun on an already-completed run is rejected', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      kernel.completeStep('run_a', 'only_step', '', '');
      kernel.completeRun('run_a', '');
      expectKernelError(() => kernel.completeRun('run_a', ''), errRunNotActive);
    });

    test('completeRun on a paused run is rejected', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      kernel.pauseRun('run_a');
      expectKernelError(
        () => kernel.completeRun('run_a', ''),
        errInvalidPausedRunCompletion,
      );
    });

    test('completeRun clears the lease and advances the step index', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      kernel.acquireLease('run_a', 'owner_a', 5000);
      kernel.completeStep('run_a', 'only_step', '', '');
      kernel.completeRun('run_a', '');

      final run = kernel.backend.getRun('run_a')!;
      expect(run.status, RunStatus.completed);
      expect(run.currentStepIndex, run.stepSequence.length);
      expect(run.hasLease, isFalse);
    });

    test('turn tree evolves across checkpoints via incorporation rules', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      final created = kernel.createThread(
        'thread_a',
        'schema_main',
        'branch_a',
      );
      kernel.createRun(
        'run_a',
        'turn_a',
        'branch_a',
        'schema_main',
        created.rootTurnNodeHash,
        const [
          StepDeclaration(
            id: 'only_step',
            deterministic: true,
            sideEffects: false,
          ),
        ],
      );

      final messageHash = kernel.putObject('application/octet-stream', [9]);
      kernel.stageResult(
        'run_a',
        StagedResult(
          taskId: 'task_1',
          objectHash: messageHash,
          objectType: 'message',
          timestamp: 1,
          status: StagedResultStatus.completed,
        ),
      );
      final hash = kernel.completeStep('run_a', 'only_step', '', '');
      final node = kernel.backend.getTurnNode(hash)!;
      final tree = kernel.backend.getTurnTree(node.turnTreeHash)!;
      expect(tree.manifest['messages']!.ordered, [messageHash]);
    });

    test('unmatched incorporation rule is rejected', () {
      final kernel = newTestKernel();
      createSingleStepRun(kernel, 'thread_a', 'branch_a', 'run_a');
      final objectHash = kernel.putObject('application/octet-stream', [7]);
      kernel.stageResult(
        'run_a',
        StagedResult(
          taskId: 'task_1',
          objectHash: objectHash,
          objectType: 'unregistered_type',
          timestamp: 1,
          status: StagedResultStatus.completed,
        ),
      );
      expectKernelError(
        () => kernel.completeStep('run_a', 'only_step', '', ''),
        errUnmatchedIncorporationRule,
      );
    });
  });

  group('thread enumeration', () {
    test('lists threads in createdAtMs/threadId order with cursor paging', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      for (final id in ['thread_c', 'thread_a', 'thread_b']) {
        kernel.createThread(id, 'schema_main', 'branch_$id');
      }

      final (page1, cursor1) = kernel.listThreads(2, '');
      expect(page1.map((t) => t.threadId).toList(), ['thread_c', 'thread_a']);
      expect(cursor1, isNotEmpty);

      final (page2, cursor2) = kernel.listThreads(2, cursor1);
      expect(page2.map((t) => t.threadId).toList(), ['thread_b']);
      expect(cursor2, isEmpty);
    });

    test('a malformed cursor is rejected with invalidDurableReadCursor', () {
      final kernel = newTestKernel();
      expectKernelError(
        () => kernel.listThreads(10, 'not-a-valid-cursor!!'),
        errInvalidDurableReadCursor,
      );
    });

    test('a padded cursor is rejected, matching RawURLEncoding parity', () {
      final kernel = newTestKernel();
      final unpadded = base64Url.encode(
        utf8.encode(
          jsonEncode({'lastCreatedAtMs': 0, 'lastThreadId': 'thread_a'}),
        ),
      );
      // Force padding back onto an otherwise well-formed cursor: Go's
      // base64.RawURLEncoding rejects any '=' outright, so the Dart
      // decoder must reject it too instead of re-padding and accepting
      // it.
      var padded = unpadded;
      final remainder = padded.length % 4;
      if (remainder != 0) {
        padded += '=' * (4 - remainder);
      } else {
        padded += '=';
      }
      expectKernelError(
        () => kernel.listThreads(10, padded),
        errInvalidDurableReadCursor,
      );
    });

    test('a null cursor payload resumes from the zero default', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      for (final id in ['thread_c', 'thread_a', 'thread_b']) {
        kernel.createThread(id, 'schema_main', 'branch_$id');
      }

      final nullCursor = base64Url
          .encode(utf8.encode(jsonEncode(null)))
          .replaceAll('=', '');
      final (page, _) = kernel.listThreads(10, nullCursor);
      expect(page.map((t) => t.threadId).toList(), [
        'thread_c',
        'thread_a',
        'thread_b',
      ]);
    });

    test('an empty-object cursor payload resumes from the zero default', () {
      final kernel = newTestKernel();
      kernel.registerSchema(canonicalSchema());
      for (final id in ['thread_c', 'thread_a', 'thread_b']) {
        kernel.createThread(id, 'schema_main', 'branch_$id');
      }

      final emptyObjectCursor = base64Url
          .encode(utf8.encode(jsonEncode(<String, Object?>{})))
          .replaceAll('=', '');
      final (page, _) = kernel.listThreads(10, emptyObjectCursor);
      expect(page.map((t) => t.threadId).toList(), [
        'thread_c',
        'thread_a',
        'thread_b',
      ]);
    });
  });
}
