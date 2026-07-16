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

/// Fixture-driven golden tests over every `kernel-protocol-*.json` fixture
/// under `spec/conformance/kernel/fixtures/` that carries the
/// deterministic-hashing/schema-roundtrip oracle fields (`rawOpaqueBytes*`,
/// `turnTreeSchemaRecord*`, `turnNodeIdentityRecord*`). Mirrors
/// `go/kernel/fixtures_test.go`'s `TestFixtures_DeterministicHashesAndCanonicalEncoding`
/// byte-for-byte: for each fixture, this asserts
///
///  a) `encodeCanonical(recordFromJson(fixture.*Record))` equals the
///     fixture's committed CBOR hex, for both record families;
///  b) `hashBytesToHex`/`hashRecord` reproduce the fixture's three pinned
///     SHA-256 hex digests;
///  c) `decodeCanonical(fixture.*RecordCborHex) -> encodeCanonical` is a
///     byte-for-byte identity (the canonical hex is already canonical); and
///  d) `recordToJson(decodeCanonical(...))` deep-equals the fixture's own
///     JSON record.
///
/// `kernel-protocol-logical.json` intentionally has a different shape (it
/// backs the `kernel.logical.*` checks, out of scope for this milestone)
/// and is excluded, matching Go's `kernelProtocolFixtures` list.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import 'support/fixture_paths.dart';
import 'support/hex.dart';

const List<String> _kernelProtocolFixtures = [
  'kernel-protocol-deterministic.json',
  'kernel-protocol-empty-bytes.json',
  'kernel-protocol-single-byte.json',
  'kernel-protocol-all-zero-bytes.json',
  'kernel-protocol-all-ones-bytes.json',
  'kernel-protocol-large-bytes.json',
  'kernel-protocol-multi-path-schema.json',
  'kernel-protocol-all-single-paths-schema.json',
  'kernel-protocol-all-ordered-paths-schema.json',
  'kernel-protocol-with-prev-turn.json',
  'kernel-protocol-with-event-hash.json',
  'kernel-protocol-staged-result-failed.json',
  'kernel-protocol-staged-result-interrupted.json',
  'kernel-protocol-many-staged-results.json',
  'kernel-protocol-deep-path-schema.json',
  'kernel-protocol-non-utf8-bytes.json',
  'kernel-protocol-zero-turn-tree-hash.json',
  'kernel-protocol-mixed-status-staged-results.json',
];

void main() {
  final fixturesDir = kernelFixturesDir();

  for (final name in _kernelProtocolFixtures) {
    test(name, () {
      final file = File('${fixturesDir.path}/$name');
      final top = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;

      final rawOpaqueBytes = (top['rawOpaqueBytes'] as List<dynamic>)
          .map((e) => e as int)
          .toList();
      final rawOpaqueBytesSha256Hex = top['rawOpaqueBytesSha256Hex'] as String;
      final turnNodeIdentityRecord = top['turnNodeIdentityRecord'];
      final turnNodeIdentityRecordCborHex =
          top['turnNodeIdentityRecordCborHex'] as String;
      final turnNodeIdentityRecordSha256Hex =
          top['turnNodeIdentityRecordSha256Hex'] as String;
      final turnTreeSchemaRecord = top['turnTreeSchemaRecord'];
      final turnTreeSchemaRecordCborHex =
          top['turnTreeSchemaRecordCborHex'] as String;
      final turnTreeSchemaRecordSha256Hex =
          top['turnTreeSchemaRecordSha256Hex'] as String;

      // (a) canonical CBOR bytes match the fixture's committed hex, for
      // both record families, when encoding directly from the fixture's
      // JSON record (not from the pre-encoded hex).
      final schemaRecord = recordFromJson(turnTreeSchemaRecord);
      final schemaBytes = encodeCanonical(schemaRecord);
      expect(hexEncode(schemaBytes), turnTreeSchemaRecordCborHex);

      final nodeRecord = recordFromJson(turnNodeIdentityRecord);
      final nodeBytes = encodeCanonical(nodeRecord);
      expect(hexEncode(nodeBytes), turnNodeIdentityRecordCborHex);

      // (b) SHA-256 hex matches all three *Sha256Hex fields.
      expect(hashBytesToHex(rawOpaqueBytes), rawOpaqueBytesSha256Hex);
      expect(hashRecord(schemaRecord), turnTreeSchemaRecordSha256Hex);
      expect(hashRecord(nodeRecord), turnNodeIdentityRecordSha256Hex);

      // (c) decode(hex) -> record -> encode == same bytes.
      final schemaHexBytes = hexDecode(turnTreeSchemaRecordCborHex);
      final decodedSchema = decodeCanonical(schemaHexBytes);
      expect(encodeCanonical(decodedSchema), equals(schemaHexBytes));

      final nodeHexBytes = hexDecode(turnNodeIdentityRecordCborHex);
      final decodedNode = decodeCanonical(nodeHexBytes);
      expect(encodeCanonical(decodedNode), equals(nodeHexBytes));

      // (d) record JSON round trip deep-equals the fixture record JSON.
      expect(recordToJson(decodedSchema), equals(turnTreeSchemaRecord));
      expect(recordToJson(decodedNode), equals(turnNodeIdentityRecord));
    });
  }
}
