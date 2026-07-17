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

/// Fixture-driven rejection tests over
/// `spec/conformance/kernel/fixtures/kernel-protocol-adversarial-cbor.json`:
/// every case's `cborBytes` must be rejected by [decodeCanonical] except
/// `control-canonical-map`, the anchor case that must be accepted (so the
/// rejection assertions stay meaningful on their own, per the fixture's own
/// description).
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/fixture_paths.dart';

void main() {
  final file = File(
    '${kernelFixturesDir().path}/kernel-protocol-adversarial-cbor.json',
  );
  final top = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  final cases = top['cases'] as Map<String, dynamic>;

  for (final entry in cases.entries) {
    final name = entry.key;
    final caseObject = entry.value as Map<String, dynamic>;
    final cborBytes = Uint8List.fromList(
      (caseObject['cborBytes'] as List<dynamic>).map((e) => e as int).toList(),
    );

    if (name == 'control-canonical-map') {
      test('$name is accepted (control case)', () {
        expect(() => decodeCanonical(cborBytes), returnsNormally);
      });
    } else {
      test('$name is rejected', () {
        expect(() => decodeCanonical(cborBytes), throwsFormatException);
      });
    }
  }

  test('the fixture exercised at least one rejection and the control case', () {
    expect(cases.keys, contains('control-canonical-map'));
    expect(cases.length, greaterThan(1));
  });
}
