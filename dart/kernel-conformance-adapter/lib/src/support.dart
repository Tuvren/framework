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

/// Shared dispatch-input parsing helpers for the operation handler files,
/// mirroring `go/kernel-conformance-adapter/operations.go`'s
/// `readInputFixture`/`tryReadInputFixture`/`readFixtureString`/
/// `readFixtureByteArray`/`decodeCanonicalHexField` and
/// `operations_runtime.go`'s `captureCode`.
///
/// Unlike the Go adapter (which keeps `params.input` as raw JSON text until
/// each handler decides to decode it, using `json.Number` so integers never
/// become `float64`), the Dart adapter's `handleLine` already ran the whole
/// request line through `jsonDecode` once: `params.input` arrives here as
/// plain decoded Dart values, and `dart:convert`'s `jsonDecode` already
/// decodes a base-10 JSON integer literal as a Dart `int` (never a
/// `double`), so no extra integer-safety step is needed on top of that.
library;

import 'dart:typed_data';

import 'package:tuvren_kernel/tuvren_kernel.dart';

/// Extracts `params.input.fixture` as a JSON object. Every
/// `kernel.protocol.*` check that carries a fixture wraps it this way.
/// Throws a [FormatException] if `input` has no `fixture` object.
Map<String, Object?> readInputFixture(Object? input) {
  final fixture = tryReadInputFixture(input);
  if (fixture == null) {
    throw const FormatException('dispatch input.fixture must be a JSON object');
  }
  return fixture;
}

/// [readInputFixture]'s non-required counterpart: returns `null` when
/// `input` carries no `fixture` key at all (or `input` itself is not an
/// object), letting an operation like `kernel.protocol.modify-composition`
/// stay fixture-optional. Throws a [FormatException] if `fixture` is
/// present but is not a JSON object.
Map<String, Object?>? tryReadInputFixture(Object? input) {
  if (input is! Map<String, Object?>) return null;
  if (!input.containsKey('fixture')) return null;
  final fixture = input['fixture'];
  if (fixture is! Map<String, Object?>) {
    throw const FormatException('dispatch input.fixture must be a JSON object');
  }
  return fixture;
}

String readFixtureString(Map<String, Object?> fixture, String field) {
  final value = fixture[field];
  if (value is! String) {
    throw FormatException('fixture.$field must be a string');
  }
  return value;
}

/// Reads `fixture[field]` as a JSON array of byte values (0-255), the shape
/// a raw-bytes fixture field carries at the JSON boundary.
List<int> readFixtureByteArray(Map<String, Object?> fixture, String field) {
  final rawArray = fixture[field];
  if (rawArray is! List) {
    throw FormatException('fixture.$field must be an array of bytes');
  }
  final out = <int>[];
  for (var i = 0; i < rawArray.length; i++) {
    final element = rawArray[i];
    if (element is! int || element < 0 || element > 255) {
      throw FormatException('fixture.$field[$i] must be a byte value (0-255)');
    }
    out.add(element);
  }
  return out;
}

/// Decodes `fixture[field]` as a lowercase-hex string of canonical
/// deterministic CBOR bytes and returns the decoded [Record]. `dart:convert`
/// has no hex codec, so this file carries a tiny one (mirroring
/// `dart/kernel/test/support/hex.dart`, which cannot be imported from a
/// non-test library).
Record decodeCanonicalHexField(Map<String, Object?> fixture, String field) {
  final hexValue = readFixtureString(fixture, field);
  final bytes = hexDecode(hexValue);
  return decodeCanonical(bytes);
}

const String _hexDigits = '0123456789abcdef';

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

String hexEncode(List<int> bytes) {
  final buffer = StringBuffer();
  for (final byte in bytes) {
    buffer.write(_hexDigits[(byte >> 4) & 0xf]);
    buffer.write(_hexDigits[byte & 0xf]);
  }
  return buffer.toString();
}

/// Runs [probe] and returns `"unexpected_success"` if it returns normally,
/// or the [KernelException.code] it threw. Mirrors
/// `go/kernel-conformance-adapter/operations_runtime.go`'s `captureCode`: an
/// edge-validation (or lineage-rejection) probe that unexpectedly succeeds
/// must report that cleanly rather than the adapter crashing or masking the
/// surprise. A non-[KernelException] throw reports `"internal_error"`,
/// mirroring the Go adapter's fallback for a non-`*KernelError` Go error.
String captureCode(void Function() probe) {
  try {
    probe();
    return 'unexpected_success';
  } on KernelException catch (e) {
    return e.code;
  } catch (_) {
    return 'internal_error';
  }
}

/// [captureCode]'s counterpart for a call whose success value the caller
/// also needs, so the call cannot be wrapped as a void probe: mirrors
/// `go/kernel-conformance-adapter/operations_liveness.go`'s `codeOf`,
/// applied to an [error] already caught from a `try`/`catch` around that
/// call.
String codeOf(Object? error) {
  if (error == null) return 'unexpected_success';
  if (error is KernelException) return error.code;
  return 'internal_error';
}

/// Reports whether two byte lists hold identical content, used by the
/// erasure-probe operation to compare stored ciphertext bytes and decrypted
/// plaintext bytes.
bool bytesEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
