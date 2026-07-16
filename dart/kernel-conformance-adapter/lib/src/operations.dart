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

/// The `kernel.protocol.*` record-identity operations, mirroring
/// `go/kernel-conformance-adapter/operations.go`:
/// `deterministic-hashing`, `schema-roundtrip`, and `modify-composition`.
library;

import 'package:tuvren_kernel/tuvren_kernel.dart';

import '../adapter.dart' show projection;
import 'support.dart';

Object? runDeterministicHashing(Object? input) {
  final fixture = readInputFixture(input);

  final rawOpaqueBytes = readFixtureByteArray(fixture, 'rawOpaqueBytes');

  // The schema/node hashes must be derived by walking the JSON->Record path
  // (recordFromJson), matching how the Go/TypeScript reference computes
  // them. Decoding the fixture's own CBOR hex fields and re-hashing those
  // would be circular -- it never exercises JSON ingestion at all, so it
  // could not catch a JSON->Record bug even when both paths happen to
  // agree.
  if (!fixture.containsKey('turnTreeSchemaRecord')) {
    throw const FormatException('fixture.turnTreeSchemaRecord must be present');
  }
  final schemaRecord = recordFromJson(fixture['turnTreeSchemaRecord']);
  final schemaHash = hashRecord(schemaRecord);

  if (!fixture.containsKey('turnNodeIdentityRecord')) {
    throw const FormatException(
      'fixture.turnNodeIdentityRecord must be present',
    );
  }
  final nodeRecord = recordFromJson(fixture['turnNodeIdentityRecord']);
  final nodeHash = hashRecord(nodeRecord);

  return projection({
    'hashes': {
      'rawOpaqueBytes': hashBytesToHex(rawOpaqueBytes),
      'turnTreeSchema': schemaHash,
      'turnNodeIdentity': nodeHash,
    },
  });
}

Object? runSchemaRoundtrip(Object? input) {
  final fixture = readInputFixture(input);

  final schemaRecord = decodeCanonicalHexField(
    fixture,
    'turnTreeSchemaRecordCborHex',
  );
  final schemaJson = recordToJson(schemaRecord);

  final nodeRecord = decodeCanonicalHexField(
    fixture,
    'turnNodeIdentityRecordCborHex',
  );
  final nodeJson = recordToJson(nodeRecord);

  return projection({
    'roundtrip': {
      'turnTreeSchemaRecord': schemaJson,
      'turnNodeIdentityRecord': nodeJson,
    },
  });
}

/// Builds one Modify verdict's transform record, e.g. `{"extension":
/// "first", "mutation": "append-prefix"}`.
RecordMap _modifyTransformRecord(String extension, String mutation) =>
    RecordMap({
      'extension': RecordText(extension),
      'mutation': RecordText(mutation),
    });

/// Exercises the kernel spec's §6.2 composition rule.
///
/// Without a fixture (`params.input` carries no `fixture` key at all -- the
/// original `kernel-protocol-core.json` check), it runs its original
/// fixture-less scenario: two Modify verdicts registered around an
/// intervening Proceed (which contributes nothing), asserting the kernel
/// composes their transforms, in registration order, into a single Modify
/// verdict.
///
/// With a fixture present (`kernel-protocol-extended.json`'s
/// `f-verdict-composition`), it instead composes every fixture case's own
/// verdicts through [composeVerdicts] and projects each case's composed
/// result under `$.composition.<name>`, so the plan can deep-equal it
/// against that same case's committed `$.fixture.cases.<name>.expected`
/// value.
Object? runModifyComposition(Object? input) {
  final fixture = tryReadInputFixture(input);
  if (fixture != null) {
    return _runModifyCompositionFromFixture(fixture);
  }

  final composed = composeVerdicts([
    Verdict(
      kind: verdictKindModify,
      transform: _modifyTransformRecord('first', 'append-prefix'),
    ),
    const Verdict(kind: verdictKindProceed),
    Verdict(
      kind: verdictKindModify,
      transform: _modifyTransformRecord('second', 'append-suffix'),
    ),
  ]);

  if (composed.kind != verdictKindModify) {
    throw StateError(
      'expected modify verdict after composing ordered modify transforms',
    );
  }

  final transformJson = recordToJson(composed.transform!);

  return projection({
    'verdict': {'kind': 'modify', 'transform': transformJson},
  });
}

/// Converts one fixture verdict object into a [Verdict]. Only the fields
/// [composeVerdicts] actually reads for that verdict's kind are populated;
/// an unrecognized `kind` is rejected up front rather than silently
/// composing as Proceed.
Verdict _verdictFromJson(Object? raw) {
  if (raw is! Map<String, Object?>) {
    throw const FormatException('fixture verdict must be a JSON object');
  }
  final kind = raw['kind'];
  if (kind is! String) {
    throw const FormatException('fixture verdict.kind must be a string');
  }

  switch (kind) {
    case verdictKindProceed:
      return Verdict(kind: kind);
    case verdictKindAbort:
      return Verdict(
        kind: kind,
        disposition: raw['disposition'] as String?,
        reason: raw['reason'] as String?,
      );
    case verdictKindModify:
      return Verdict(kind: kind, transform: recordFromJson(raw['transform']));
    case verdictKindPause:
      return Verdict(
        kind: kind,
        reason: raw['reason'] as String?,
        resumptionSchema: recordFromJson(raw['resumptionSchema']),
      );
    case verdictKindRetry:
      return Verdict(kind: kind, adjustment: recordFromJson(raw['adjustment']));
    default:
      throw FormatException('fixture verdict has unknown kind "$kind"');
  }
}

/// Converts a composed [Verdict] back into the same bare-field JSON object
/// shape the verdict-composition fixture's own "expected" values use: only
/// the fields meaningful to `kind` are present, so a deep-equal comparison
/// against the fixture's committed expectation (rather than a superset with
/// extra null fields) succeeds.
Map<String, Object?> _composedVerdictJson(Verdict verdict) {
  final out = <String, Object?>{'kind': verdict.kind};
  switch (verdict.kind) {
    case verdictKindProceed:
      break;
    case verdictKindAbort:
      out['disposition'] = verdict.disposition;
      out['reason'] = verdict.reason;
    case verdictKindModify:
      out['transform'] = recordToJson(verdict.transform!);
    case verdictKindPause:
      out['reason'] = verdict.reason;
      out['resumptionSchema'] = recordToJson(verdict.resumptionSchema!);
    case verdictKindRetry:
      out['adjustment'] = recordToJson(verdict.adjustment!);
  }
  return out;
}

/// Composes every case in a `kernel-protocol-verdict-composition.json`-
/// shaped fixture's `cases` map through [composeVerdicts] and projects each
/// case's composed verdict under `$.composition.<name>`, keyed by the same
/// case name the fixture (and the plan's `$.fixture.cases.<name>.expected`
/// assertions) use.
Object? _runModifyCompositionFromFixture(Map<String, Object?> fixture) {
  final rawCases = fixture['cases'];
  if (rawCases is! Map<String, Object?>) {
    throw const FormatException('fixture.cases must be a JSON object');
  }

  final composition = <String, Object?>{};
  for (final entry in rawCases.entries) {
    final caseObject = entry.value;
    if (caseObject is! Map<String, Object?>) {
      throw FormatException('fixture.cases.${entry.key} must be a JSON object');
    }
    final rawVerdicts = caseObject['verdicts'];
    if (rawVerdicts is! List) {
      throw FormatException(
        'fixture.cases.${entry.key}.verdicts must be a JSON array',
      );
    }

    final verdicts = [for (final v in rawVerdicts) _verdictFromJson(v)];
    final composed = composeVerdicts(verdicts);
    composition[entry.key] = _composedVerdictJson(composed);
  }

  return projection({'composition': composition});
}
