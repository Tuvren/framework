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

import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

void main() {
  group('decodeCanonical rejects non-canonical input', () {
    test('non-minimal integer head', () {
      // 0x18 0x05 encodes the integer 5 using the 1-byte-argument form
      // (additional info 24), even though 5 fits in the immediate 5-bit
      // argument (0x05). The canonical form is the single byte 0x05; this
      // input round-trips to different bytes and must be rejected.
      final nonMinimal = Uint8List.fromList([0x18, 0x05]);
      expect(() => decodeCanonical(nonMinimal), throwsFormatException);
    });

    test('unsorted map keys', () {
      // { "bb": 1, "a": 2 } with keys encoded in file order (longer key
      // first) is well-formed CBOR but not canonical: "a" (1-byte key)
      // sorts before "bb" (2-byte key).
      final unsorted = Uint8List.fromList([
        0xa2, // map(2)
        0x62, 0x62, 0x62, 0x01, // "bb": 1
        0x61, 0x61, 0x02, // "a": 2
      ]);
      expect(() => decodeCanonical(unsorted), throwsFormatException);
    });

    test('float', () {
      // 0xfb + 8 bytes is a double-precision float (1.0).
      final floatBytes = Uint8List.fromList([
        0xfb,
        0x3f,
        0xf0,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ]);
      expect(() => decodeCanonical(floatBytes), throwsFormatException);
    });

    test('tag', () {
      // Tag 0 (standard date/time string) wrapping a text string.
      final tagged = Uint8List.fromList([0xc0, 0x60]);
      expect(() => decodeCanonical(tagged), throwsFormatException);
    });

    test('indefinite length', () {
      // Indefinite-length array (0x9f) terminated by break (0xff), empty.
      final indefinite = Uint8List.fromList([0x9f, 0xff]);
      expect(() => decodeCanonical(indefinite), throwsFormatException);
    });

    test('trailing bytes', () {
      // A canonical null (0xf6) followed by a stray extra byte.
      final trailing = Uint8List.fromList([0xf6, 0x00]);
      expect(() => decodeCanonical(trailing), throwsFormatException);
    });

    test('integer outside safe range', () {
      // 2^63-1, encoded minimally as an 8-byte unsigned integer, is far
      // outside the js-safe-int range.
      final tooLarge = Uint8List.fromList([
        0x1b,
        0x7f,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ]);
      expect(() => decodeCanonical(tooLarge), throwsFormatException);
    });

    test('array length claim exceeding input', () {
      // 0x9b + 8 bytes of 0xff is the 8-byte-argument form of major type 4
      // (array), claiming 2^64-1 elements from a 9-byte input.
      final adversarial = Uint8List.fromList([
        0x9b,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ]);
      expect(() => decodeCanonical(adversarial), throwsFormatException);
    });

    test('map length claim exceeding input', () {
      // 0xbb + 8 bytes of 0xff is the 8-byte-argument form of major type 5
      // (map), claiming 2^64-1 entries from a 9-byte input.
      final adversarial = Uint8List.fromList([
        0xbb,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ]);
      expect(() => decodeCanonical(adversarial), throwsFormatException);
    });

    test('excessive nesting depth', () {
      // 2000 nested single-element arrays, each encoded as 0x81 (array(1))
      // followed eventually by a single null. Without a recursion depth
      // cap this recurses 2000 stack frames deep purely from adversarial
      // input shape.
      const depth = 2000;
      final encoded = <int>[for (var i = 0; i < depth; i++) 0x81, 0xf6];
      expect(
        () => decodeCanonical(Uint8List.fromList(encoded)),
        throwsFormatException,
      );
    });
  });

  test('encodeCanonical rejects integers outside the safe range', () {
    expect(
      () => encodeCanonical(const RecordInt(maxSafeInteger + 1)),
      throwsFormatException,
    );
    expect(
      () => encodeCanonical(const RecordInt(minSafeInteger - 1)),
      throwsFormatException,
    );
  });

  test('encode/decode round trips across every kind', () {
    final record = RecordMap({
      'z': const RecordNull(),
      'a': RecordArray([
        const RecordBool(true),
        const RecordBool(false),
        const RecordInt(-1),
        const RecordInt(0),
        const RecordInt(maxSafeInteger),
        const RecordInt(minSafeInteger),
        const RecordText('hello'),
        const RecordBytes([0x00, 0x01, 0xff]),
      ]),
      'nested': RecordMap({'inner': const RecordText('value')}),
    });

    final encoded = encodeCanonical(record);
    final decoded = decodeCanonical(encoded);
    final reencoded = encodeCanonical(decoded);

    expect(reencoded, equals(encoded));
  });

  test('map keys are sorted by encoded key bytes, not native string order', () {
    // "b" (ASCII 0x62) sorts after "B" (0x42) as encoded key bytes; a naive
    // Dart string `Comparable` sort would agree here, but a longer key
    // ("aa") must still sort after a shorter one ("b") whose codepoint is
    // numerically larger, because CBOR canonical order compares the
    // length-prefixed encoded key, not just the text.
    final record = RecordMap({
      'aa': const RecordInt(1),
      'b': const RecordInt(2),
    });
    final encoded = encodeCanonical(record);
    // "b" (1-byte key head 0x61 0x62) must be encoded before "aa" (0x62
    // 0x61 0x61) because its encoded key is shorter.
    final bIndex = _indexOfSubsequence(encoded, [0xa2, 0x61, 0x62]);
    expect(bIndex, 0);
  });
}

int _indexOfSubsequence(List<int> haystack, List<int> needle) {
  for (var i = 0; i + needle.length <= haystack.length; i++) {
    var matched = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}
