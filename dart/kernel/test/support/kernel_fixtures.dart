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

/// Shared runtime-kernel test fixtures, mirroring the helpers
/// `go/kernel/kernel_runtime_test.go` and `go/kernel/lease_and_recovery_test.go`
/// define at the top of their files (`canonicalSchema`, `newTestKernel`,
/// `newManualClockKernel`, `createSingleStepRun`).
library;

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

/// The shared canonical turn-tree schema every M2 conformance fixture and
/// most of this port's own tests build threads/runs against: `messages`
/// (ordered) plus `context.manifest` (single), matching
/// `spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json` and
/// `go/kernel/kernel_runtime_test.go`'s `canonicalSchema`.
TurnTreeSchema canonicalSchema() => const TurnTreeSchema(
  schemaId: 'schema_main',
  paths: [
    PathDefinition(path: 'messages', collection: PathCollectionKind.ordered),
    PathDefinition(
      path: 'context.manifest',
      collection: PathCollectionKind.single,
    ),
  ],
  incorporationRules: [
    IncorporationRule(objectType: 'message', targetPath: 'messages'),
    IncorporationRule(
      objectType: 'context_manifest',
      targetPath: 'context.manifest',
    ),
  ],
);

/// A [Kernel] over a fresh [InMemoryBackend] driven by an
/// [IncrementingClock], mirroring `newTestKernel`.
Kernel newTestKernel() {
  final clock = IncrementingClock();
  final backend = InMemoryBackend(clock);
  return Kernel('test-scope', clock, backend);
}

/// A [Kernel] over a fresh [InMemoryBackend] driven by a [ManualClock]
/// pinned to [startMs], plus the clock itself so a test can advance time
/// explicitly, mirroring `newManualClockKernel`.
(Kernel, ManualClock) newManualClockKernel(int startMs) {
  final clock = ManualClock(startMs);
  final backend = InMemoryBackend(clock);
  return (Kernel('test-scope', clock, backend), clock);
}

/// Registers [canonicalSchema] (a no-op if this [kernel] already has it
/// registered, so callers may build several runs on one kernel), creates a
/// thread/branch, and starts a single-step run on it, returning the root
/// turn node hash. Mirrors `createSingleStepRun`.
String createSingleStepRun(
  Kernel kernel,
  String threadId,
  String branchId,
  String runId,
) {
  if (kernel.backend.getSchema('schema_main') == null) {
    kernel.registerSchema(canonicalSchema());
  }
  final created = kernel.createThread(threadId, 'schema_main', branchId);
  final steps = [
    const StepDeclaration(
      id: 'only_step',
      deterministic: true,
      sideEffects: false,
    ),
  ];
  kernel.createRun(
    runId,
    'turn_$runId',
    branchId,
    'schema_main',
    created.rootTurnNodeHash,
    steps,
  );
  return created.rootTurnNodeHash;
}

/// Asserts that invoking [body] throws a [KernelException] whose `code`
/// equals [code], mirroring `requireErrCode`.
void expectKernelError(void Function() body, String code) {
  expect(
    body,
    throwsA(isA<KernelException>().having((e) => e.code, 'code', code)),
  );
}
