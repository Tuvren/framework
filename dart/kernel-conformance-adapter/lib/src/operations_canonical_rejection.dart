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

/// The `kernel.protocol.canonical-rejection` operation, mirroring
/// `go/kernel-conformance-adapter/operations_canonical_rejection.go`:
/// `kernel-protocol-extended.json`'s adversarial-CBOR check
/// (`spec/conformance/kernel/fixtures/kernel-protocol-adversarial-cbor.json`)
/// asserts every listed byte sequence is refused by the strict canonical
/// [decodeCanonical] decoder (kernel spec §2.3). This handler only reports
/// whether each case's bytes were rejected -- it never projects an error
/// code, matching the adapter guardrail that adapters do not grade or
/// classify failures themselves.
library;

import 'dart:typed_data';

import 'package:tuvren_kernel/tuvren_kernel.dart';

import '../adapter.dart' show projection;
import 'support.dart';

/// Attempts [decodeCanonical] against every case in the fixture's `cases`
/// map and projects, for each case name, whether decoding it threw. A
/// case's `cborBytes` array is read with the same helper
/// ([readFixtureByteArray]) the deterministic-hashing/schema-roundtrip
/// operations already use for byte-array fixture fields.
Object? runCanonicalRejection(Object? input) {
  final fixture = readInputFixture(input);

  final rawCases = fixture['cases'];
  if (rawCases is! Map<String, Object?>) {
    throw const FormatException('fixture.cases must be a JSON object');
  }

  final rejection = <String, Object?>{};
  for (final entry in rawCases.entries) {
    final caseObject = entry.value;
    if (caseObject is! Map<String, Object?>) {
      throw FormatException('fixture.cases.${entry.key} must be a JSON object');
    }

    final cborBytes = readFixtureByteArray(caseObject, 'cborBytes');

    var rejected = false;
    try {
      decodeCanonical(Uint8List.fromList(cborBytes));
    } catch (_) {
      rejected = true;
    }
    rejection[entry.key] = {'rejected': rejected};
  }

  return projection({'rejection': rejection});
}
