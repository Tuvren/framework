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

/// Fixture-driven tests over
/// `spec/conformance/kernel/fixtures/kernel-protocol-verdict-composition.json`:
/// every case's `verdicts` must [composeVerdicts] to exactly that case's own
/// `expected` value.
///
/// The fixture's `verdicts`/`expected` values are bare JSON objects (a
/// `kind` discriminant plus only the fields meaningful to that kind), the
/// same shape `go/kernel-conformance-adapter/operations.go`'s
/// `verdictFromJSON`/`composedVerdictJSON` produce and consume. Those two
/// bridging functions are conformance-adapter plumbing, not part of the
/// kernel library's own public surface (`go/kernel` itself has no JSON
/// verdict bridge), so this test ports the same bare-object shape locally
/// rather than adding it to `lib/src/verdict.dart`.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/fixture_paths.dart';

Verdict _verdictFromJson(Map<String, dynamic> object) {
  final kind = object['kind'] as String;
  switch (kind) {
    case verdictKindProceed:
      return Verdict(kind: kind);
    case verdictKindAbort:
      return Verdict(
        kind: kind,
        disposition: object['disposition'] as String?,
        reason: object['reason'] as String?,
      );
    case verdictKindModify:
      return Verdict(
          kind: kind, transform: recordFromJson(object['transform']));
    case verdictKindPause:
      return Verdict(
        kind: kind,
        reason: object['reason'] as String?,
        resumptionSchema: recordFromJson(object['resumptionSchema']),
      );
    case verdictKindRetry:
      return Verdict(
          kind: kind, adjustment: recordFromJson(object['adjustment']));
    default:
      throw FormatException('fixture verdict has unknown kind "$kind"');
  }
}

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

void main() {
  final file = File(
    '${kernelFixturesDir().path}/kernel-protocol-verdict-composition.json',
  );
  final top = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  final cases = top['cases'] as Map<String, dynamic>;

  for (final entry in cases.entries) {
    final name = entry.key;
    final caseObject = entry.value as Map<String, dynamic>;

    test(name, () {
      final verdicts = (caseObject['verdicts'] as List<dynamic>)
          .map((v) => _verdictFromJson(v as Map<String, dynamic>))
          .toList();
      final composed = composeVerdicts(verdicts);
      final composedJson = _composedVerdictJson(composed);
      expect(composedJson, equals(caseObject['expected']));
    });
  }

  test('the fixture exercised every priority tier', () {
    expect(
        cases.keys,
        containsAll(<String>[
          'single-proceed',
          'single-modify',
          'multi-modify-preserves-registration-order',
          'abort-dominates-pause-modify-retry',
          'pause-dominates-modify-retry-proceed',
          'modify-dominates-retry-proceed',
          'retry-dominates-proceed',
        ]));
  });
}
