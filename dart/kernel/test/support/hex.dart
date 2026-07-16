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

/// Minimal lowercase-hex codec for test fixtures. `dart:convert` has no
/// hex codec, and the kernel library itself has no reason to expose one
/// (it only ever produces hex via [hashBytesToHex]/[hashRecord]'s SHA-256
/// digests), so tests that need to decode a fixture's pinned CBOR hex
/// bytes carry this tiny helper instead.
library;

import 'dart:typed_data';

const String _digits = '0123456789abcdef';

String hexEncode(List<int> bytes) {
  final buffer = StringBuffer();
  for (final byte in bytes) {
    buffer.write(_digits[(byte >> 4) & 0xf]);
    buffer.write(_digits[byte & 0xf]);
  }
  return buffer.toString();
}

Uint8List hexDecode(String hex) {
  if (hex.length.isOdd) {
    throw FormatException('hex string has odd length: $hex');
  }
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}
