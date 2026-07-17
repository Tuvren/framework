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

/// Canonical deterministic CBOR codec for [Record], mirroring
/// `go/kernel/cbor.go`'s `EncodeCanonical`/`DecodeCanonical` byte-for-byte:
/// RFC 8949's core deterministic encoding requirements as scoped by
/// `spec/kernel/cddl/kernel-records.cddl` -- definite lengths everywhere,
/// the shortest-possible integer head for every length and integer value,
/// and map entries sorted by their own encoded key bytes (which, for the
/// short text keys this record family uses, amounts to shortest-key-first
/// and then byte-lexicographic).
///
/// Encode/decode failures throw a [FormatException], mirroring Go's plain
/// (untyped, code-less) `error` return from `EncodeCanonical`/
/// `DecodeCanonical` -- unlike `errors.dart`'s [KernelException], neither
/// Go function's failures carry a normative error code.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'record.dart';

/// Serializes [record] into deterministic CBOR bytes. Throws a
/// [FormatException] if [record] (at any depth) contains an integer outside
/// [minSafeInteger, maxSafeInteger] -- mirroring `go/kernel/cbor.go`'s
/// `appendInt`, the only way `EncodeCanonical` fails: every other [Record]
/// variant always has a valid canonical encoding.
Uint8List encodeCanonical(Record record) {
  final out = BytesBuilder(copy: false);
  _appendRecord(out, record);
  return out.toBytes();
}

/// Parses [data] into a [Record] and rejects any input that is not already
/// the unique canonical encoding of the record it describes. Strictness is
/// enforced by re-encoding the decoded record and requiring a byte-for-byte
/// match against [data]: this catches non-minimal integer heads,
/// out-of-order map keys, and duplicate map keys without a second bespoke
/// validation pass, mirroring `go/kernel/cbor.go`'s `DecodeCanonical`.
/// Floats, tags, and indefinite-length items are rejected directly during
/// decoding because this record family has no representation for them at
/// all.
Record decodeCanonical(Uint8List data) {
  final result = _decodeRecord(data, 0, 0);
  if (result.next != data.length) {
    throw FormatException(
      'kernel record decode: ${data.length - result.next} trailing byte(s) '
      'after top-level value',
    );
  }

  final canonical = encodeCanonical(result.record);
  if (!_bytesEqual(canonical, data)) {
    throw FormatException(
      'kernel record decode: input is not the canonical deterministic CBOR '
      'encoding of its own value',
    );
  }
  return result.record;
}

// --- encoding ---

void _appendRecord(BytesBuilder out, Record record) {
  switch (record) {
    case RecordNull():
      out.addByte(0xf6);
    case RecordBool(value: true):
      out.addByte(0xf5);
    case RecordBool(value: false):
      out.addByte(0xf4);
    case RecordInt(:final value):
      _appendInt(out, value);
    case RecordText(:final value):
      _appendTextBytes(out, utf8.encode(value));
    case RecordBytes(:final value):
      _appendHead(out, 2, value.length);
      out.add(value);
    case RecordArray(:final value):
      _appendHead(out, 4, value.length);
      for (final element in value) {
        _appendRecord(out, element);
      }
    case RecordMap(:final value):
      _appendMap(out, value);
  }
}

void _appendInt(BytesBuilder out, int value) {
  if (value < minSafeInteger || value > maxSafeInteger) {
    throw FormatException(
      'kernel record encode: integer $value is outside the js-safe-int '
      'range [$minSafeInteger, $maxSafeInteger]',
    );
  }
  if (value >= 0) {
    _appendHead(out, 0, value);
  } else {
    _appendHead(out, 1, -1 - value);
  }
}

void _appendTextBytes(BytesBuilder out, List<int> textBytes) {
  _appendHead(out, 3, textBytes.length);
  out.add(textBytes);
}

class _MapEntry {
  _MapEntry(this.keyBytes, this.valueBytes);

  final Uint8List keyBytes;
  final Uint8List valueBytes;
}

void _appendMap(BytesBuilder out, Map<String, Record> value) {
  final entries = <_MapEntry>[];
  for (final entry in value.entries) {
    final keyBuilder = BytesBuilder(copy: false);
    _appendTextBytes(keyBuilder, utf8.encode(entry.key));
    final valueBuilder = BytesBuilder(copy: false);
    _appendRecord(valueBuilder, entry.value);
    entries.add(_MapEntry(keyBuilder.toBytes(), valueBuilder.toBytes()));
  }

  // RFC 8949 deterministic encoding orders map entries by their own
  // encoded key bytes, not by Dart's native string ordering. Comparing the
  // encoded bytes handles the length-prefix rule automatically for every
  // key length, not just the short keys this record family happens to use.
  entries.sort((a, b) => _compareBytes(a.keyBytes, b.keyBytes));

  _appendHead(out, 5, entries.length);
  for (final entry in entries) {
    out.add(entry.keyBytes);
    out.add(entry.valueBytes);
  }
}

int _compareBytes(List<int> a, List<int> b) {
  final minLength = a.length < b.length ? a.length : b.length;
  for (var i = 0; i < minLength; i++) {
    final diff = a[i] - b[i];
    if (diff != 0) return diff;
  }
  return a.length - b.length;
}

/// Writes a CBOR major-type/argument head using the shortest encoding that
/// represents [val], per RFC 8949's deterministic encoding rule. [val] must
/// be non-negative and within the js-safe-int range; every caller in this
/// file already guarantees that (array/map/string lengths are always small,
/// and [_appendInt] range-checks integers before calling in).
void _appendHead(BytesBuilder out, int majorType, int val) {
  final prefix = majorType << 5;
  if (val < 24) {
    out.addByte(prefix | val);
  } else if (val <= 0xff) {
    out.addByte(prefix | 24);
    out.addByte(val);
  } else if (val <= 0xffff) {
    out.addByte(prefix | 25);
    out.addByte((val >> 8) & 0xff);
    out.addByte(val & 0xff);
  } else if (val <= 0xffffffff) {
    out.addByte(prefix | 26);
    out.addByte((val >> 24) & 0xff);
    out.addByte((val >> 16) & 0xff);
    out.addByte((val >> 8) & 0xff);
    out.addByte(val & 0xff);
  } else {
    // dart2js compiles `int` bitwise/shift operators as JS 32-bit
    // operations, so a shift above 31 bits (as an 8-byte argument needs)
    // silently truncates on web. Derive each byte by integer division
    // instead: every divisor here is a compile-time power of two, and
    // integer division composes exactly for any int representable in
    // Dart, unlike a >31-bit shift.
    out.addByte(prefix | 27);
    out.addByte((val ~/ 0x100000000000000) & 0xff);
    out.addByte((val ~/ 0x1000000000000) & 0xff);
    out.addByte((val ~/ 0x10000000000) & 0xff);
    out.addByte((val ~/ 0x100000000) & 0xff);
    out.addByte((val ~/ 0x1000000) & 0xff);
    out.addByte((val ~/ 0x10000) & 0xff);
    out.addByte((val ~/ 0x100) & 0xff);
    out.addByte(val & 0xff);
  }
}

// --- decoding ---

/// Recursion depth cap [_decodeRecord] will follow through nested arrays and
/// maps, mirroring `go/kernel/cbor.go`'s `maxDecodeDepth`. Kernel records
/// never need anything close to this deep a nesting; the cap exists purely
/// to turn adversarial deeply-nested input into a normal decode error
/// instead of a stack-exhaustion crash.
const int _maxDecodeDepth = 512;

/// The negative-integer argument bound (`-(minSafeInteger + 1)`) beyond
/// which a major-type-1 value would decode outside the js-safe-int range.
final int _maxSafeNegOffset = -(minSafeInteger + 1);

class _DecodeResult {
  _DecodeResult(this.record, this.next);

  final Record record;
  final int next;
}

_DecodeResult _decodeRecord(Uint8List data, int i, int depth) {
  if (depth > _maxDecodeDepth) {
    throw FormatException(
      'kernel record decode: nesting depth exceeds the maximum of '
      '$_maxDecodeDepth',
    );
  }

  final head = _decodeHead(data, i);

  switch (head.majorType) {
    case 0: // unsigned integer
      if (head.overflow || head.val > maxSafeInteger) {
        throw FormatException(
          'kernel record decode: unsigned integer exceeds js-safe-int range',
        );
      }
      return _DecodeResult(RecordInt(head.val), head.next);
    case 1: // negative integer
      if (head.overflow || head.val > _maxSafeNegOffset) {
        throw FormatException(
          'kernel record decode: negative integer argument exceeds '
          'js-safe-int range',
        );
      }
      return _DecodeResult(RecordInt(-1 - head.val), head.next);
    case 2: // byte string
      if (head.overflow || head.val > data.length - head.next) {
        throw FormatException(
          'kernel record decode: byte string length exceeds remaining '
          'input',
        );
      }
      final end = head.next + head.val;
      final bytes = Uint8List.fromList(data.sublist(head.next, end));
      return _DecodeResult(RecordBytes(bytes), end);
    case 3: // text string
      if (head.overflow || head.val > data.length - head.next) {
        throw FormatException(
          'kernel record decode: text string length exceeds remaining '
          'input',
        );
      }
      final end = head.next + head.val;
      final text = _decodeUtf8(
        data,
        head.next,
        end,
        'kernel record decode: text string is not valid UTF-8',
      );
      return _DecodeResult(RecordText(text), end);
    case 4: // array
      // head.val is an untrusted length header: a 9-byte input can claim
      // 2^64-1 elements. Every element needs at least one input byte, so
      // this check turns a malicious length claim into a normal decode
      // error (the loop below would run out of input long before head.val
      // iterations) instead of an unbounded allocation.
      if (head.overflow || head.val > data.length - head.next) {
        throw FormatException(
          'kernel record decode: array length exceeds remaining input',
        );
      }
      final elements = <Record>[];
      var cursor = head.next;
      for (var count = 0; count < head.val; count++) {
        final element = _decodeRecord(data, cursor, depth + 1);
        elements.add(element.record);
        cursor = element.next;
      }
      return _DecodeResult(RecordArray(elements), cursor);
    case 5: // map
      // Same untrusted-length guard as the array case above: each map
      // entry needs at least a 1-byte key head and a 1-byte value, so two
      // bytes is the minimum remaining-input cost per claimed entry.
      if (head.overflow || head.val > (data.length - head.next) ~/ 2) {
        throw FormatException(
          'kernel record decode: map length exceeds remaining input',
        );
      }
      final result = <String, Record>{};
      var cursor = head.next;
      for (var count = 0; count < head.val; count++) {
        final keyHead = _decodeHead(data, cursor);
        if (keyHead.majorType != 3) {
          throw FormatException(
            'kernel record decode: map keys must be text strings',
          );
        }
        if (keyHead.overflow || keyHead.val > data.length - keyHead.next) {
          throw FormatException(
            'kernel record decode: map key length exceeds remaining input',
          );
        }
        final keyEnd = keyHead.next + keyHead.val;
        final keyText = _decodeUtf8(
          data,
          keyHead.next,
          keyEnd,
          'kernel record decode: map key is not valid UTF-8',
        );

        final value = _decodeRecord(data, keyEnd, depth + 1);
        // Duplicate keys are not rejected here: they collapse via this
        // overwrite (last write wins), which produces a decoded map with
        // fewer entries than the header declared. That mismatch is caught
        // by decodeCanonical's re-encode-and-compare strictness check, not
        // by this recursive decoder, mirroring Go's decodeRecordAtDepth.
        result[keyText] = value.record;
        cursor = value.next;
      }
      return _DecodeResult(RecordMap(result), cursor);
    case 6: // tag
      throw FormatException(
        'kernel record decode: kernel records must not use CBOR tags',
      );
    case 7: // simple values and floats
      switch (head.additionalInfo) {
        case 20:
          return _DecodeResult(const RecordBool(false), head.next);
        case 21:
          return _DecodeResult(const RecordBool(true), head.next);
        case 22:
          return _DecodeResult(const RecordNull(), head.next);
        case 25:
        case 26:
        case 27:
          throw FormatException(
            'kernel record decode: kernel records must not use CBOR floats',
          );
        default:
          throw FormatException(
            'kernel record decode: unsupported simple value (additional '
            'info ${head.additionalInfo})',
          );
      }
    default:
      throw FormatException(
        'kernel record decode: unsupported major type ${head.majorType}',
      );
  }
}

String _decodeUtf8(Uint8List data, int start, int end, String errorMessage) {
  try {
    return utf8.decode(data.sublist(start, end), allowMalformed: false);
  } on FormatException {
    throw FormatException(errorMessage);
  }
}

class _Head {
  _Head({
    required this.majorType,
    required this.additionalInfo,
    required this.val,
    required this.overflow,
    required this.next,
  });

  final int majorType;
  final int additionalInfo;

  /// The decoded argument value. Only meaningful when [overflow] is false.
  final int val;

  /// True when the raw CBOR argument could not be represented as a
  /// non-negative Dart `int` (only possible for the 8-byte-argument form:
  /// an unsigned 64-bit value >= 2^63 has no non-negative representation in
  /// Dart's 64-bit two's-complement `int`). Any such value is, by
  /// construction, far outside the js-safe-int range and far larger than
  /// any real record's remaining input, so every call site treats overflow
  /// as an immediate decode error.
  final bool overflow;

  final int next;
}

/// Reads one CBOR major-type/argument head starting at `data[i]` and
/// returns the major type, the raw 5-bit additional-info field, the decoded
/// argument value, and the index just past the head. Reserved
/// additional-info values (28-30) and the indefinite-length marker (31) are
/// rejected here because this record family has no representation for
/// either.
_Head _decodeHead(Uint8List data, int i) {
  if (i >= data.length) {
    throw FormatException(
      'kernel record decode: unexpected end of input reading a value head',
    );
  }

  final first = data[i];
  final majorType = first >> 5;
  final additionalInfo = first & 0x1f;
  var cursor = i + 1;

  var val = 0;
  var overflow = false;
  if (additionalInfo < 24) {
    val = additionalInfo;
  } else if (additionalInfo == 24) {
    if (cursor + 1 > data.length) {
      throw FormatException(
        'kernel record decode: truncated 1-byte length argument',
      );
    }
    val = data[cursor];
    cursor += 1;
  } else if (additionalInfo == 25) {
    if (cursor + 2 > data.length) {
      throw FormatException(
        'kernel record decode: truncated 2-byte length argument',
      );
    }
    val = (data[cursor] << 8) | data[cursor + 1];
    cursor += 2;
  } else if (additionalInfo == 26) {
    if (cursor + 4 > data.length) {
      throw FormatException(
        'kernel record decode: truncated 4-byte length argument',
      );
    }
    val =
        (data[cursor] << 24) |
        (data[cursor + 1] << 16) |
        (data[cursor + 2] << 8) |
        data[cursor + 3];
    cursor += 4;
  } else if (additionalInfo == 27) {
    if (cursor + 8 > data.length) {
      throw FormatException(
        'kernel record decode: truncated 8-byte length argument',
      );
    }
    // dart2js compiles `int` bitwise/shift operators as JS 32-bit
    // operations, so composing a 64-bit argument via `<<`/`|` across the
    // 32-bit boundary would silently truncate on web. Compose hi/lo with
    // multiplication/addition instead (exact for any int Dart can
    // represent), then combine them arithmetically rather than shifting.
    final hi =
        data[cursor] * 0x1000000 +
        data[cursor + 1] * 0x10000 +
        data[cursor + 2] * 0x100 +
        data[cursor + 3];
    final lo =
        data[cursor + 4] * 0x1000000 +
        data[cursor + 5] * 0x10000 +
        data[cursor + 6] * 0x100 +
        data[cursor + 7];
    if (hi >= 0x80000000) {
      // The unsigned 64-bit argument is >= 2^63: it has no non-negative
      // Dart `int` representation and is certainly far outside the
      // js-safe-int range, so record it as an overflow rather than
      // attempting a wraparound value.
      overflow = true;
    } else {
      // hi * 2^32 + lo is exact for the values that reach here: hi < 2^31
      // and lo < 2^32, so the product and sum stay within the 2^53
      // js-safe-double mantissa up to hi ~= 2^21, and any larger hi (up
      // to the 2^53 adversarial cases the fixtures pin) rounds to the
      // nearest representable double while remaining well above
      // maxSafeInteger -- so the existing `head.val > maxSafeInteger`
      // rejection at the call site still fires correctly either way.
      val = hi * 0x100000000 + lo;
    }
    cursor += 8;
  } else if (additionalInfo == 31) {
    throw FormatException(
      'kernel record decode: indefinite-length CBOR items are not '
      'supported',
    );
  } else {
    throw FormatException(
      'kernel record decode: reserved additional information value '
      '$additionalInfo',
    );
  }

  return _Head(
    majorType: majorType,
    additionalInfo: additionalInfo,
    val: val,
    overflow: overflow,
    next: cursor,
  );
}

bool _bytesEqual(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
