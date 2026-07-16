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

/// A typed CDDL validation layer for the record families the M2 runtime
/// kernel ingests (`spec/kernel/cddl/kernel-records.cddl`: turn-tree-schema,
/// path-definition, incorporation-rule, step-declaration, staged-result,
/// turn-tree-manifest / turn-tree-change-set). It sits between the generic
/// [Record] decoding in `cbor.dart`/`record.dart` and the runtime kernel
/// logic (a later milestone): every record the runtime kernel accepts from a
/// caller is meant to be validated here first. Mirrors
/// `go/kernel/validate.go`.
///
/// Two structural rules apply uniformly:
///
///  1. CDDL maps in this record family are closed: a record carrying a
///     field name absent from the map's grammar is a validation error, not
///     silently-ignored extra data.
///  2. Absent vs. null is significant for optional fields whose CDDL type
///     does not itself include null: leaving the field out entirely is
///     valid, but explicitly setting it to null where the field's type
///     doesn't allow null is a validation error. Optional fields typed as
///     `kernel-record` (which itself includes null in its union) accept an
///     explicit null the same as any other kernel-record value -- in this
///     port that is represented as `null` (Dart) meaning "absent" versus a
///     non-null [Record] (possibly [RecordNull]) meaning "present".
library;

import 'errors.dart';
import 'record.dart';

final RegExp _hashStringPattern = RegExp(r'^[0-9a-f]{64}$');

// --- generic record-shape helpers ---

RecordMap _expectMap(Record value, String context) {
  if (value is! RecordMap) {
    throw KernelException(
      errInvalidRecordField,
      '$context: expected a map, got ${value.runtimeType}',
    );
  }
  return value;
}

RecordArray _expectArray(Record value, String context) {
  if (value is! RecordArray) {
    throw KernelException(
      errInvalidRecordField,
      '$context: expected an array, got ${value.runtimeType}',
    );
  }
  return value;
}

/// Returns the record at [key], erroring if the key is absent. An explicit
/// null value is returned as-is ([RecordNull]); callers whose field type
/// does not permit null must reject it themselves via [_requireNonNull].
/// [RecordMap.value] cannot itself store a Dart `null` (its value type is
/// the non-nullable [Record]), so a `null` lookup result unambiguously
/// means the key is absent.
Record _requiredField(RecordMap m, String key, String context) {
  final value = m.value[key];
  if (value == null) {
    throw KernelException(
      errMissingRecordField,
      '$context: missing required field "$key"',
    );
  }
  return value;
}

/// Returns the record at [key] and whether it was present at all
/// (present-with-null counts as present).
(Record?, bool) _optionalField(RecordMap m, String key) {
  if (!m.value.containsKey(key)) return (null, false);
  return (m.value[key], true);
}

Record _requireNonNull(Record value, String key, String context) {
  if (value is RecordNull) {
    throw KernelException(
      errNullNotAllowedField,
      '$context: field "$key" must not be null',
    );
  }
  return value;
}

String _requireText(RecordMap m, String key, String context) {
  final value = _requireNonNull(_requiredField(m, key, context), key, context);
  if (value is! RecordText) {
    throw KernelException(
      errInvalidRecordField,
      '$context: field "$key" must be a string, got ${value.runtimeType}',
    );
  }
  return value.value;
}

String _requireNonEmptyText(RecordMap m, String key, String context) {
  final text = _requireText(m, key, context);
  if (text.isEmpty) {
    throw KernelException(
      errInvalidRecordField,
      '$context: field "$key" must be a non-empty string',
    );
  }
  return text;
}

String _requireHashString(RecordMap m, String key, String context) {
  final text = _requireNonEmptyText(m, key, context);
  if (!_hashStringPattern.hasMatch(text)) {
    throw KernelException(
      errInvalidRecordField,
      '$context: field "$key" must be a 64-character lowercase hex hash '
      'string, got "$text"',
    );
  }
  return text;
}

bool _requireBool(RecordMap m, String key, String context) {
  final value = _requireNonNull(_requiredField(m, key, context), key, context);
  if (value is! RecordBool) {
    throw KernelException(
      errInvalidRecordField,
      '$context: field "$key" must be a bool, got ${value.runtimeType}',
    );
  }
  return value.value;
}

int _requireInt(RecordMap m, String key, String context) {
  final value = _requireNonNull(_requiredField(m, key, context), key, context);
  if (value is! RecordInt) {
    throw KernelException(
      errInvalidRecordField,
      '$context: field "$key" must be an integer, got ${value.runtimeType}',
    );
  }
  return value.value;
}

RecordArray _requireArrayField(RecordMap m, String key, String context) {
  final value = _requireNonNull(_requiredField(m, key, context), key, context);
  return _expectArray(value, '$context.$key');
}

/// Rejects any key in [m] that is not in [allowed], per the CDDL
/// closed-map rule this record family uses throughout.
void _checkClosedMap(RecordMap m, Set<String> allowed, String context) {
  for (final key in m.value.keys) {
    if (!allowed.contains(key)) {
      throw KernelException(
        errUnknownRecordField,
        '$context: unrecognized field "$key"',
      );
    }
  }
}

// --- path-definition / incorporation-rule / turn-tree-schema ---

/// Mirrors the CDDL `path-collection-kind` enum.
enum PathCollectionKind { ordered, single }

/// Mirrors the CDDL `path-definition` record.
class PathDefinition {
  const PathDefinition({
    required this.path,
    required this.collection,
    this.metadata,
  });

  final String path;
  final PathCollectionKind collection;

  /// `null` if the optional field was absent from the record; a non-null
  /// [Record] (possibly [RecordNull]) if it was present.
  final Record? metadata;
}

final Set<String> _pathDefinitionFields = {'path', 'collection', 'metadata'};

PathDefinition _validatePathDefinition(Record value) {
  const context = 'path-definition';
  final m = _expectMap(value, context);
  _checkClosedMap(m, _pathDefinitionFields, context);

  final path = _requireNonEmptyText(m, 'path', context);
  final collectionText = _requireNonEmptyText(m, 'collection', context);
  final collection = switch (collectionText) {
    'ordered' => PathCollectionKind.ordered,
    'single' => PathCollectionKind.single,
    _ => throw KernelException(
        errInvalidRecordField,
        '$context: field "collection" must be "ordered" or "single", got '
        '"$collectionText"',
      ),
  };

  // metadata: kernel-record, whose own union includes null, so an explicit
  // null here is a legitimate kernel-record value, not a violation of the
  // absent-vs-null rule.
  final (metadata, _) = _optionalField(m, 'metadata');

  return PathDefinition(path: path, collection: collection, metadata: metadata);
}

/// Mirrors the CDDL `incorporation-rule` record.
class IncorporationRule {
  const IncorporationRule({required this.objectType, required this.targetPath});

  final String objectType;
  final String targetPath;
}

final Set<String> _incorporationRuleFields = {'objectType', 'targetPath'};

IncorporationRule _validateIncorporationRule(Record value) {
  const context = 'incorporation-rule';
  final m = _expectMap(value, context);
  _checkClosedMap(m, _incorporationRuleFields, context);
  final objectType = _requireNonEmptyText(m, 'objectType', context);
  final targetPath = _requireNonEmptyText(m, 'targetPath', context);
  return IncorporationRule(objectType: objectType, targetPath: targetPath);
}

/// Mirrors the CDDL `turn-tree-schema` record.
class TurnTreeSchema {
  const TurnTreeSchema({
    required this.schemaId,
    required this.paths,
    required this.incorporationRules,
  });

  final String schemaId;
  final List<PathDefinition> paths;
  final List<IncorporationRule> incorporationRules;
}

final Set<String> _turnTreeSchemaFields = {
  'schemaId',
  'paths',
  'incorporationRules',
};

/// Decodes and validates a turn-tree-schema record. Duplicate path
/// definitions across `paths` are rejected with [errDuplicateSchemaPath]
/// (checked here rather than left to the runtime kernel, since a schema
/// with duplicate paths is malformed at the record level, independent of
/// any tree operation). Mirrors `go/kernel/validate.go`'s
/// `ValidateTurnTreeSchema`.
TurnTreeSchema validateTurnTreeSchema(Record value) {
  const context = 'turn-tree-schema';
  final m = _expectMap(value, context);
  _checkClosedMap(m, _turnTreeSchemaFields, context);

  final schemaId = _requireNonEmptyText(m, 'schemaId', context);

  final pathsArray = _requireArrayField(m, 'paths', context);
  final seenPaths = <String>{};
  final paths = <PathDefinition>[];
  for (final element in pathsArray.value) {
    final definition = _validatePathDefinition(element);
    if (!seenPaths.add(definition.path)) {
      throw KernelException(
        errDuplicateSchemaPath,
        'turn-tree-schema "$schemaId" declares path "${definition.path}" '
        'more than once',
      );
    }
    paths.add(definition);
  }

  final rulesArray = _requireArrayField(m, 'incorporationRules', context);
  final rules = <IncorporationRule>[
    for (final element in rulesArray.value) _validateIncorporationRule(element),
  ];

  return TurnTreeSchema(
    schemaId: schemaId,
    paths: paths,
    incorporationRules: rules,
  );
}

// --- step-declaration ---

/// Mirrors the CDDL `step-declaration` record.
class StepDeclaration {
  const StepDeclaration({
    required this.id,
    required this.deterministic,
    required this.sideEffects,
    this.metadata,
  });

  final String id;
  final bool deterministic;
  final bool sideEffects;

  /// `null` if the optional field was absent from the record; a non-null
  /// [Record] (possibly [RecordNull]) if it was present.
  final Record? metadata;
}

final Set<String> _stepDeclarationFields = {
  'id',
  'deterministic',
  'sideEffects',
  'metadata',
};

StepDeclaration validateStepDeclaration(Record value) {
  const context = 'step-declaration';
  final m = _expectMap(value, context);
  _checkClosedMap(m, _stepDeclarationFields, context);

  final id = _requireNonEmptyText(m, 'id', context);
  final deterministic = _requireBool(m, 'deterministic', context);
  final sideEffects = _requireBool(m, 'sideEffects', context);

  final (metadata, _) = _optionalField(m, 'metadata');

  return StepDeclaration(
    id: id,
    deterministic: deterministic,
    sideEffects: sideEffects,
    metadata: metadata,
  );
}

// --- staged-result ---

/// Mirrors the CDDL `staged-result-status` enum.
enum StagedResultStatus { completed, failed, interrupted }

/// Mirrors the CDDL `staged-result` union (`base-staged-result` plus either
/// `interrupted-staged-result`'s `interruptPayload` or a settled status).
class StagedResult {
  const StagedResult({
    required this.taskId,
    required this.objectHash,
    required this.objectType,
    required this.timestamp,
    required this.status,
    this.interruptPayload,
  });

  final String taskId;
  final String objectHash;
  final String objectType;
  final int timestamp;
  final StagedResultStatus status;

  /// Set iff [status] is [StagedResultStatus.interrupted].
  final Record? interruptPayload;
}

final Set<String> _settledStagedResultFields = {
  'taskId',
  'objectHash',
  'objectType',
  'timestamp',
  'status',
};
final Set<String> _interruptedStagedResultFields = {
  ..._settledStagedResultFields,
  'interruptPayload',
};

StagedResult validateStagedResult(Record value) {
  const context = 'staged-result';
  final m = _expectMap(value, context);

  final statusText = _requireNonEmptyText(m, 'status', context);
  final StagedResultStatus status;
  final Set<String> allowed;
  switch (statusText) {
    case 'completed':
      status = StagedResultStatus.completed;
      allowed = _settledStagedResultFields;
    case 'failed':
      status = StagedResultStatus.failed;
      allowed = _settledStagedResultFields;
    case 'interrupted':
      status = StagedResultStatus.interrupted;
      allowed = _interruptedStagedResultFields;
    default:
      throw KernelException(
        errInvalidRecordField,
        '$context: field "status" must be "completed", "failed", or '
        '"interrupted", got "$statusText"',
      );
  }
  _checkClosedMap(m, allowed, context);

  final taskId = _requireNonEmptyText(m, 'taskId', context);
  final objectHash = _requireHashString(m, 'objectHash', context);
  final objectType = _requireNonEmptyText(m, 'objectType', context);
  final timestamp = _requireInt(m, 'timestamp', context);

  Record? interruptPayload;
  if (status == StagedResultStatus.interrupted) {
    interruptPayload = _requiredField(m, 'interruptPayload', context);
  }

  return StagedResult(
    taskId: taskId,
    objectHash: objectHash,
    objectType: objectType,
    timestamp: timestamp,
    status: status,
    interruptPayload: interruptPayload,
  );
}

// --- turn-tree-manifest / turn-tree-change-set (path-value maps) ---

/// Mirrors the CDDL `path-value` union's discriminant: a single hash
/// string, an ordered array of hash strings, or null (path not populated).
enum PathValueKind { nullValue, single, ordered }

/// Mirrors the CDDL `path-value` union.
class PathValue {
  const PathValue.nullValue()
      : kind = PathValueKind.nullValue,
        single = null,
        ordered = null;

  const PathValue.single(String value)
      : kind = PathValueKind.single,
        single = value,
        ordered = null;

  const PathValue.ordered(List<String> values)
      : kind = PathValueKind.ordered,
        single = null,
        ordered = values;

  final PathValueKind kind;

  /// Set when [kind] is [PathValueKind.single].
  final String? single;

  /// Set when [kind] is [PathValueKind.ordered].
  final List<String>? ordered;
}

PathValue _validatePathValue(Record value, String context) {
  if (value is RecordNull) {
    return const PathValue.nullValue();
  }
  if (value is RecordText) {
    if (!_hashStringPattern.hasMatch(value.value)) {
      throw KernelException(
        errInvalidRecordField,
        '$context: expected a hash string, got "${value.value}"',
      );
    }
    return PathValue.single(value.value);
  }
  if (value is RecordArray) {
    final hashes = <String>[];
    for (final element in value.value) {
      if (element is! RecordText ||
          !_hashStringPattern.hasMatch(element.value)) {
        throw KernelException(
          errInvalidRecordField,
          '$context: expected an array of hash strings',
        );
      }
      hashes.add(element.value);
    }
    return PathValue.ordered(hashes);
  }
  throw KernelException(
    errInvalidRecordField,
    '$context: expected a hash string, an array of hash strings, or null, '
    'got ${value.runtimeType}',
  );
}

/// Decodes a turn-tree-manifest or turn-tree-change-set record:
/// `{ * non-empty-tstr => path-value }`. Both CDDL shapes are structurally
/// identical open string-keyed maps (unlike the closed record shapes
/// above), so one validator serves both. Mirrors `go/kernel/validate.go`'s
/// `ValidateTurnTreeManifestLike`.
Map<String, PathValue> validateTurnTreeManifestLike(
    Record value, String context) {
  final m = _expectMap(value, context);
  final result = <String, PathValue>{};
  for (final entry in m.value.entries) {
    if (entry.key.isEmpty) {
      throw KernelException(
        errInvalidRecordField,
        '$context: keys must be non-empty strings',
      );
    }
    result[entry.key] =
        _validatePathValue(entry.value, '$context["${entry.key}"]');
  }
  return result;
}
