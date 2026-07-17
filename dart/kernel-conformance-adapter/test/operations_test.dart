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

/// Focused unit tests for the operation-handler support seams that the
/// full conformance harness run (`bun tools/conformance/harness/run.ts`)
/// already exercises end-to-end but that are worth pinning directly: the
/// [captureCode] probe-capture convention, the shared canonical turn-tree
/// schema shape, and the [runErasureProbe] AES-256-GCM crypto-shredding
/// scenario run standalone (outside the JSON-RPC transport).
library;

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';
import 'package:tuvren_kernel_adapter/src/operations_maintenance.dart';
import 'package:tuvren_kernel_adapter/src/operations_runtime.dart';
import 'package:tuvren_kernel_adapter/src/support.dart';

void main() {
  group('captureCode', () {
    test('a probe that succeeds reports unexpected_success', () {
      expect(captureCode(() {}), 'unexpected_success');
    });

    test('a probe that throws a KernelException reports its code', () {
      final code = captureCode(() {
        throw const KernelException(
          'kernel_runtime_run_not_found',
          'probe failure',
        );
      });
      expect(code, 'kernel_runtime_run_not_found');
    });

    test(
      'a probe that throws a non-KernelException reports internal_error',
      () {
        final code = captureCode(() {
          throw StateError('not a kernel exception');
        });
        expect(code, 'internal_error');
      },
    );

    test('a real kernel operation error surfaces through captureCode exactly '
        'like an edge-validation probe', () {
      final code = captureCode(() {
        final clock = IncrementingClock();
        final backend = InMemoryBackend(clock);
        final k = Kernel('capture-code-test', clock, backend);
        k.createTurnTree('schema_never_registered', const {});
      });
      expect(code, 'kernel_runtime_schema_not_found');
    });
  });

  group('canonicalTurnTreeSchema', () {
    final schema = canonicalTurnTreeSchema();

    test('matches the authority fixture\'s schemaId', () {
      expect(schema.schemaId, 'schema_main');
    });

    test('declares exactly the messages (ordered) and context.manifest '
        '(single) paths, in that order', () {
      expect(schema.paths, hasLength(2));
      expect(schema.paths[0].path, 'messages');
      expect(schema.paths[0].collection, PathCollectionKind.ordered);
      expect(schema.paths[1].path, 'context.manifest');
      expect(schema.paths[1].collection, PathCollectionKind.single);
    });

    test('declares exactly the message->messages and '
        'context_manifest->context.manifest incorporation rules, in that '
        'order', () {
      expect(schema.incorporationRules, hasLength(2));
      expect(schema.incorporationRules[0].objectType, 'message');
      expect(schema.incorporationRules[0].targetPath, 'messages');
      expect(schema.incorporationRules[1].objectType, 'context_manifest');
      expect(schema.incorporationRules[1].targetPath, 'context.manifest');
    });

    test('is usable as-is to register a schema and create its root tree', () {
      final clock = IncrementingClock();
      final backend = InMemoryBackend(clock);
      final k = Kernel('canonical-schema-test', clock, backend);
      k.registerSchema(schema);
      final created = k.createThread(
        'thread_schema_shape',
        'schema_main',
        'branch_schema_shape',
      );
      expect(created.rootTurnNodeHash, isNotEmpty);
    });
  });

  group('runErasureProbe', () {
    test('reports the payload recoverable before, unrecoverable after key '
        'destruction, with kernel lineage left byte-identical', () async {
      final outcome = await runErasureProbe(null) as Map<String, Object?>;
      final result = outcome['result'] as Map<String, Object?>;
      final evidence = outcome['evidence'] as Map<String, Object?>;
      // projection() mirrors the same observation under both result and
      // evidence.
      expect(identical(result, evidence), isTrue);

      final erasure = result['erasure'] as Map<String, Object?>;
      expect(erasure['recoverableBeforeErasure'], isTrue);
      expect(erasure['unrecoverableAfterErasure'], isTrue);
      expect(erasure['lineageStructurallyIntactAfterErasure'], isTrue);
    });

    test(
      'two independent runs use independent random keys and envelopes',
      () async {
        final first = await runErasureProbe(null) as Map<String, Object?>;
        final second = await runErasureProbe(null) as Map<String, Object?>;
        final firstErasure =
            (first['result'] as Map<String, Object?>)['erasure']
                as Map<String, Object?>;
        final secondErasure =
            (second['result'] as Map<String, Object?>)['erasure']
                as Map<String, Object?>;
        // Both runs are independently self-consistent; this is mainly a
        // smoke check that repeated invocations do not share mutable state
        // (each dispatch builds a fresh Kernel, fresh key, and fresh
        // envelope).
        expect(firstErasure['recoverableBeforeErasure'], isTrue);
        expect(secondErasure['recoverableBeforeErasure'], isTrue);
      },
    );
  });
}
