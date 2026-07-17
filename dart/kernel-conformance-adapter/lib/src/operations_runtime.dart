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

/// The M2 runtime-kernel operations (`kernel.logical.*`, `kernel.lineage.*`,
/// `kernel.protocol.edge-validation`), mirroring
/// `go/kernel-conformance-adapter/operations_runtime.go`. Every handler here
/// builds its own fresh in-memory [Kernel] (`tuvren_kernel`'s [Kernel] +
/// [InMemoryBackend]) per dispatch call -- there is no state shared across
/// operations or across repeated calls to the same operation, matching
/// every other conformance adapter host's per-check isolation.
library;

import 'dart:convert';

import 'package:tuvren_kernel/tuvren_kernel.dart';

import '../adapter.dart' show projection;
import 'support.dart';

/// The shared canonical schema
/// (`spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json`)
/// several logical/lineage/edge-validation scenarios bootstrap against. It
/// is embedded directly rather than read from disk at dispatch time: the
/// adapter must not depend on its process working directory to locate
/// authority fixtures it can just as well express as a Dart value once and
/// reuse.
TurnTreeSchema canonicalTurnTreeSchema() => const TurnTreeSchema(
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

Kernel newRuntimeKernel() {
  final clock = IncrementingClock();
  final backend = InMemoryBackend(clock);
  return Kernel('kernel-conformance-adapter', clock, backend);
}

/// Converts a JSON value shaped like the CDDL path-value union (a hash
/// string, an array of hash strings, or null) into a [PathValue].
PathValue _parsePathValueJson(Object? value) {
  if (value == null) return const PathValue.nullValue();
  if (value is String) return PathValue.single(value);
  if (value is List) {
    final hashes = <String>[];
    for (final element in value) {
      if (element is! String) {
        throw FormatException(
          'ordered path value element must be a string, got ${element.runtimeType}',
        );
      }
      hashes.add(element);
    }
    return PathValue.ordered(hashes);
  }
  throw FormatException(
    'path value must be a string, an array of strings, or null, got '
    '${value.runtimeType}',
  );
}

Map<String, PathValue> _parseChangeSetJson(Object? raw) {
  if (raw is! Map<String, Object?>) {
    throw FormatException(
      'change set must be a JSON object, got ${raw.runtimeType}',
    );
  }
  return {
    for (final entry in raw.entries)
      entry.key: _parsePathValueJson(entry.value),
  };
}

/// Converts a JSON array of step-declaration-shaped objects into
/// `List<StepDeclaration>`.
List<StepDeclaration> _parseStepSequenceJson(Object? raw) {
  if (raw is! List) {
    throw FormatException(
      'step sequence must be a JSON array, got ${raw.runtimeType}',
    );
  }
  final out = <StepDeclaration>[];
  for (final element in raw) {
    if (element is! Map<String, Object?>) {
      throw FormatException(
        'step declaration must be a JSON object, got ${element.runtimeType}',
      );
    }
    out.add(
      StepDeclaration(
        id: element['id'] as String? ?? '',
        deterministic: element['deterministic'] as bool? ?? false,
        sideEffects: element['sideEffects'] as bool? ?? false,
      ),
    );
  }
  return out;
}

/// Converts a JSON object shaped like the CDDL staged-result union into a
/// [StagedResult].
StagedResult _parseStagedResultJson(Object? raw) {
  if (raw is! Map<String, Object?>) {
    throw FormatException(
      'staged result must be a JSON object, got ${raw.runtimeType}',
    );
  }
  final taskId = raw['taskId'] as String? ?? '';
  final objectHash = raw['objectHash'] as String? ?? '';
  final objectType = raw['objectType'] as String? ?? '';
  final statusText = raw['status'] as String? ?? '';
  final timestampValue = raw['timestamp'];
  if (timestampValue is! int) {
    throw FormatException(
      'staged result timestamp must be an integer, got ${timestampValue.runtimeType}',
    );
  }
  final status = switch (statusText) {
    'completed' => StagedResultStatus.completed,
    'failed' => StagedResultStatus.failed,
    'interrupted' => StagedResultStatus.interrupted,
    _ =>
      throw FormatException(
        'staged result status must be "completed", "failed", or '
        '"interrupted", got "$statusText"',
      ),
  };

  Record? interruptPayload;
  if (status == StagedResultStatus.interrupted) {
    interruptPayload = recordFromJson(raw['interruptPayload']);
  }

  return StagedResult(
    taskId: taskId,
    objectHash: objectHash,
    objectType: objectType,
    timestamp: timestampValue,
    status: status,
    interruptPayload: interruptPayload,
  );
}

// --- kernel.logical.diff-paths ---

Object? runLogicalDiffPaths(Object? input) {
  final fixture = readInputFixture(input);
  final changeSet = _parseChangeSetJson(fixture['turnTreeChangeSet']);

  final k = newRuntimeKernel();
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
    'thread_conformance',
    'schema_main',
    'branch_main',
  );

  final changedTreeHash = k.createTurnTree(
    'schema_main',
    changeSet,
    base: created.rootTurnTreeHash,
  );
  final diff = k.diffTurnTrees(created.rootTurnTreeHash, changedTreeHash);

  return projection({'diffPaths': diff});
}

// --- kernel.logical.branch-list ---

Object? runLogicalBranchList(Object? input) {
  readInputFixture(input);

  final k = newRuntimeKernel();
  k.registerSchema(canonicalTurnTreeSchema());
  k.createThread('thread_conformance', 'schema_main', 'branch_main');

  final entries = k.listBranchHeads('thread_conformance');
  final branchEntries = [
    for (final (id, head) in entries) [id, head],
  ];

  return projection({'branchEntries': branchEntries});
}

// --- kernel.logical.recovery-state ---

Object? runLogicalRecoveryState(Object? input) {
  final fixture = readInputFixture(input);

  final recoveryFixture = fixture['recoveryState'];
  if (recoveryFixture is! Map<String, Object?>) {
    throw const FormatException('fixture.recoveryState must be a JSON object');
  }
  final stepSequence = _parseStepSequenceJson(recoveryFixture['stepSequence']);
  if (stepSequence.length < 2) {
    throw const FormatException(
      'fixture.recoveryState.stepSequence must declare at least 2 steps',
    );
  }

  final consumedArray = recoveryFixture['consumedStagedResults'];
  if (consumedArray is! List || consumedArray.isEmpty) {
    throw const FormatException(
      'fixture.recoveryState.consumedStagedResults must be a non-empty array',
    );
  }
  final consumedFixture = _parseStagedResultJson(consumedArray[0]);

  final uncommittedArray = recoveryFixture['uncommittedStagedResults'];
  if (uncommittedArray is! List || uncommittedArray.isEmpty) {
    throw const FormatException(
      'fixture.recoveryState.uncommittedStagedResults must be a non-empty array',
    );
  }
  final uncommittedFixture = _parseStagedResultJson(uncommittedArray[0]);

  final k = newRuntimeKernel();
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
    'thread_recovery',
    'schema_main',
    'branch_recovery',
  );
  k.createRun(
    'run_recovery',
    'turn_recovery',
    'branch_recovery',
    'schema_main',
    created.rootTurnNodeHash,
    stepSequence.sublist(0, 2),
  );

  // A staged result consumed before the run's first step boundary, so the
  // recovery-state scenario demonstrates that consumedStagedResults
  // reflects only the *most recent* checkpoint's consumption, not the run's
  // entire history.
  final preFixture = StagedResult(
    taskId: 'pre_fixture_consumed',
    objectHash: hashBytesToHex(utf8.encode('pre-fixture-consumed')),
    objectType: 'message',
    status: StagedResultStatus.completed,
    timestamp: 0,
  );
  k.stageResult('run_recovery', preFixture);
  k.completeStep('run_recovery', stepSequence[0].id, '', '');

  k.stageResult('run_recovery', consumedFixture);
  k.completeStep('run_recovery', stepSequence[1].id, '', '');

  k.stageResult('run_recovery', uncommittedFixture);

  final state = k.recoveryState('run_recovery');

  return projection({
    'recovery': {
      'lastCompletedStepId': state.lastCompletedStepId,
      'consumedStagedResults': state.consumedStagedResults.length,
      'uncommittedStagedResults': state.uncommittedStagedResults.length,
    },
  });
}

// --- kernel.lineage.cross-thread-rejection ---

Object? runLineageCrossThreadRejection(Object? input) {
  final k = newRuntimeKernel();
  k.registerSchema(canonicalTurnTreeSchema());

  final resultA = k.createThread(
    'thread_lineage_a',
    'schema_main',
    'branch_lineage_a',
  );
  final eventHash = k.putObject(
    'application/json',
    utf8.encode('lineage-cross-thread-event'),
  );
  k.createRun(
    'run_lineage_a',
    'turn_lineage_a',
    'branch_lineage_a',
    'schema_main',
    resultA.rootTurnNodeHash,
    const [
      StepDeclaration(id: 'step_a', deterministic: true, sideEffects: false),
    ],
  );
  final nodeA = k.completeStep('run_lineage_a', 'step_a', eventHash, '');

  k.createThread('thread_lineage_b', 'schema_main', 'branch_lineage_b');

  final errorCode = captureCode(() {
    k.createBranch('branch_cross_thread', 'thread_lineage_b', nodeA);
  });

  return projection({'errorCode': errorCode});
}

// --- kernel.protocol.edge-validation ---

/// Builds the [Record] shape [validateTurnTreeSchema] expects from a
/// [TurnTreeSchema] value, so probes that need to exercise record-level
/// validation (rather than the already-registered [Kernel.registerSchema]
/// path) can do so directly.
RecordMap _recordFromTurnTreeSchema(TurnTreeSchema schema) {
  final paths = [
    for (final p in schema.paths)
      RecordMap({
        'path': RecordText(p.path),
        'collection': RecordText(
          p.collection == PathCollectionKind.ordered ? 'ordered' : 'single',
        ),
      }),
  ];
  final rules = [
    for (final r in schema.incorporationRules)
      RecordMap({
        'objectType': RecordText(r.objectType),
        'targetPath': RecordText(r.targetPath),
      }),
  ];
  return RecordMap({
    'schemaId': RecordText(schema.schemaId),
    'paths': RecordArray(paths),
    'incorporationRules': RecordArray(rules),
  });
}

Object? runProtocolEdgeValidation(Object? input) {
  final schema = canonicalTurnTreeSchema();

  final duplicatePathCode = captureCode(() {
    final record = _recordFromTurnTreeSchema(
      const TurnTreeSchema(
        schemaId: 'schema_edge_duplicate',
        paths: [
          PathDefinition(
            path: 'firstPath',
            collection: PathCollectionKind.single,
          ),
          PathDefinition(
            path: 'firstPath',
            collection: PathCollectionKind.single,
          ),
        ],
        incorporationRules: [],
      ),
    );
    validateTurnTreeSchema(record);
  });

  final missingRequiredPathCode = captureCode(() {
    final k = newRuntimeKernel();
    k.registerSchema(schema);
    k.createTurnTree('schema_main', {'messages': const PathValue.ordered([])});
  });

  final schemaMismatchCode = captureCode(() {
    final k = newRuntimeKernel();
    k.registerSchema(schema);
    const otherSchema = TurnTreeSchema(
      schemaId: 'schema_edge_other',
      paths: [
        PathDefinition(path: 'solo', collection: PathCollectionKind.single),
      ],
      incorporationRules: [],
    );
    k.registerSchema(otherSchema);
    final treeA = k.createTurnTree('schema_main', {
      'messages': const PathValue.ordered([]),
      'context.manifest': const PathValue.nullValue(),
    });
    final treeB = k.createTurnTree('schema_edge_other', {
      'solo': const PathValue.nullValue(),
    });
    k.diffTurnTrees(treeA, treeB);
  });

  final busyBranchCode = captureCode(() {
    final k = newRuntimeKernel();
    k.registerSchema(schema);
    final created = k.createThread(
      'thread_edge_busy',
      'schema_main',
      'branch_edge_busy',
    );
    const steps = [
      StepDeclaration(id: 'only_step', deterministic: true, sideEffects: false),
    ];
    k.createRun(
      'run_edge_busy_1',
      'turn_edge_busy_1',
      'branch_edge_busy',
      'schema_main',
      created.rootTurnNodeHash,
      steps,
    );
    k.createRun(
      'run_edge_busy_2',
      'turn_edge_busy_2',
      'branch_edge_busy',
      'schema_main',
      created.rootTurnNodeHash,
      steps,
    );
  });

  final outOfOrderStepCode = captureCode(() {
    final k = newRuntimeKernel();
    k.registerSchema(schema);
    final created = k.createThread(
      'thread_edge_step_order',
      'schema_main',
      'branch_edge_step_order',
    );
    const steps = [
      StepDeclaration(id: 'first', deterministic: true, sideEffects: false),
      StepDeclaration(id: 'second', deterministic: true, sideEffects: false),
    ];
    k.createRun(
      'run_edge_step_order',
      'turn_edge_step_order',
      'branch_edge_step_order',
      'schema_main',
      created.rootTurnNodeHash,
      steps,
    );
    k.beginStep('run_edge_step_order', 'second');
  });

  final missingEventObjectCode = captureCode(() {
    final k = newRuntimeKernel();
    k.registerSchema(schema);
    final created = k.createThread(
      'thread_edge_event',
      'schema_main',
      'branch_edge_event',
    );
    const steps = [
      StepDeclaration(id: 'only_step', deterministic: true, sideEffects: false),
    ];
    k.createRun(
      'run_edge_event',
      'turn_edge_event',
      'branch_edge_event',
      'schema_main',
      created.rootTurnNodeHash,
      steps,
    );
    const neverStoredEventHash =
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    k.completeStep('run_edge_event', 'only_step', neverStoredEventHash, '');
  });

  final lateralHeadCode = captureCode(() {
    final k = newRuntimeKernel();
    k.registerSchema(schema);
    final created = k.createThread(
      'thread_edge_lateral',
      'schema_main',
      'branch_edge_lateral_main',
    );
    final mainEventHash = k.putObject(
      'application/json',
      utf8.encode('edge-lateral-main-event'),
    );
    const steps = [
      StepDeclaration(id: 'only_step', deterministic: true, sideEffects: false),
    ];
    k.createRun(
      'run_edge_lateral_main',
      'turn_edge_lateral_main',
      'branch_edge_lateral_main',
      'schema_main',
      created.rootTurnNodeHash,
      steps,
    );
    k.completeStep('run_edge_lateral_main', 'only_step', mainEventHash, '');

    k.createBranch(
      'branch_edge_lateral_fork',
      'thread_edge_lateral',
      created.rootTurnNodeHash,
    );
    final forkEventHash = k.putObject(
      'application/json',
      utf8.encode('edge-lateral-fork-event'),
    );
    k.createRun(
      'run_edge_lateral_fork',
      'turn_edge_lateral_fork',
      'branch_edge_lateral_fork',
      'schema_main',
      created.rootTurnNodeHash,
      steps,
    );
    final forkNodeHash = k.completeStep(
      'run_edge_lateral_fork',
      'only_step',
      forkEventHash,
      '',
    );

    k.setBranchHead('branch_edge_lateral_main', forkNodeHash);
  });

  return projection({
    'protocolEdgeValidation': {
      'schema': {'duplicatePathCode': duplicatePathCode},
      'tree': {
        'missingRequiredPathCode': missingRequiredPathCode,
        'schemaMismatchCode': schemaMismatchCode,
      },
      'run': {
        'busyBranchCode': busyBranchCode,
        'outOfOrderStepCode': outOfOrderStepCode,
        'missingEventObjectCode': missingEventObjectCode,
      },
      'branch': {'lateralHeadCode': lateralHeadCode},
    },
  });
}

// --- kernel.logical.thread-list ---

Object? runLogicalThreadList(Object? input) {
  final k = newRuntimeKernel();
  k.registerSchema(canonicalTurnTreeSchema());
  k.createThread('thread_enum_a', 'schema_main', 'branch_enum_a');
  k.createThread('thread_enum_b', 'schema_main', 'branch_enum_b');

  final (all, _) = k.listThreads(0, '');
  final (paged, nextCursor) = k.listThreads(1, '');

  final firstThreadId = all.isNotEmpty ? all[0].threadId : '';

  return projection({
    'threadEnumeration': {
      'count': all.length,
      'firstThreadId': firstThreadId,
      'pagedCount': paged.length,
      'hasCursor': nextCursor.isNotEmpty,
    },
  });
}
