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

/// The canonical kernel-record sum type mirroring `go/kernel/record.go` and
/// the CDDL grammar in `spec/kernel/cddl/kernel-records.cddl`:
///
///     kernel-record = null / bool / js-safe-int / tstr / bytes / kernel-array / kernel-map
///
/// [Record] is a closed `sealed` hierarchy: only the seven variants declared
/// in this file implement it, so an exhaustive `switch` over a [Record]
/// needs no `default` case.
library;

/// Maximum JavaScript-safe integer accepted by kernel records
/// (`js-safe-int` in `spec/kernel/cddl/kernel-records.cddl`).
const int maxSafeInteger = 9007199254740991;

/// Minimum JavaScript-safe integer accepted by kernel records
/// (`js-safe-int` in `spec/kernel/cddl/kernel-records.cddl`).
const int minSafeInteger = -9007199254740991;

/// Closed kernel-record sum type. See the library doc comment for the CDDL
/// grammar this mirrors.
sealed class Record {
  const Record();
}

/// The kernel-record `null` variant.
final class RecordNull extends Record {
  const RecordNull();

  @override
  bool operator ==(Object other) => other is RecordNull;

  @override
  int get hashCode => (RecordNull).hashCode;

  @override
  String toString() => 'RecordNull()';
}

/// The kernel-record `bool` variant.
final class RecordBool extends Record {
  const RecordBool(this.value);

  final bool value;

  @override
  bool operator ==(Object other) => other is RecordBool && other.value == value;

  @override
  int get hashCode => Object.hash(RecordBool, value);

  @override
  String toString() => 'RecordBool($value)';
}

/// The kernel-record `js-safe-int` variant. Values must stay within
/// [minSafeInteger, maxSafeInteger]; encoding ([encodeCanonical] in
/// `cbor.dart`) and decoding both enforce that bound. Construction itself
/// does not, mirroring `go/kernel/record.go`'s `RecordInt`, which is a bare
/// `int64` alias with no constructor-time check -- out-of-range values are
/// only ever rejected where the record actually crosses a wire boundary.
final class RecordInt extends Record {
  const RecordInt(this.value);

  final int value;

  @override
  bool operator ==(Object other) => other is RecordInt && other.value == value;

  @override
  int get hashCode => Object.hash(RecordInt, value);

  @override
  String toString() => 'RecordInt($value)';
}

/// The kernel-record `tstr` variant.
final class RecordText extends Record {
  const RecordText(this.value);

  final String value;

  @override
  bool operator ==(Object other) => other is RecordText && other.value == value;

  @override
  int get hashCode => Object.hash(RecordText, value);

  @override
  String toString() => 'RecordText(${value.length} chars)';
}

/// The kernel-record `bytes` variant.
final class RecordBytes extends Record {
  const RecordBytes(this.value);

  final List<int> value;

  @override
  bool operator ==(Object other) {
    if (other is! RecordBytes || other.value.length != value.length) {
      return false;
    }
    for (var i = 0; i < value.length; i++) {
      if (other.value[i] != value[i]) return false;
    }
    return true;
  }

  @override
  int get hashCode => Object.hashAll(value);

  @override
  String toString() => 'RecordBytes(${value.length} bytes)';
}

/// The kernel-record `kernel-array` variant.
final class RecordArray extends Record {
  const RecordArray(this.value);

  final List<Record> value;

  @override
  bool operator ==(Object other) {
    if (other is! RecordArray || other.value.length != value.length) {
      return false;
    }
    for (var i = 0; i < value.length; i++) {
      if (other.value[i] != value[i]) return false;
    }
    return true;
  }

  @override
  int get hashCode => Object.hashAll(value);

  @override
  String toString() => 'RecordArray(${value.length} elements)';
}

/// The kernel-record `kernel-map` variant. Key order carries no meaning:
/// canonical encoding ([encodeCanonical] in `cbor.dart`) always sorts
/// entries by their encoded key bytes, so any two maps with the same
/// key/value pairs encode identically regardless of this map's own
/// iteration order.
final class RecordMap extends Record {
  const RecordMap(this.value);

  final Map<String, Record> value;

  @override
  bool operator ==(Object other) {
    if (other is! RecordMap || other.value.length != value.length) {
      return false;
    }
    for (final entry in value.entries) {
      final otherValue = other.value[entry.key];
      if (otherValue == null && !other.value.containsKey(entry.key)) {
        return false;
      }
      if (otherValue != entry.value) return false;
    }
    return true;
  }

  @override
  int get hashCode {
    // Order-independent combiner: XOR every entry's hash together so two
    // maps with the same key/value pairs in different iteration orders hash
    // equally, matching the `==` contract above.
    var hash = 0;
    for (final entry in value.entries) {
      hash ^= Object.hash(entry.key, entry.value);
    }
    return hash;
  }

  @override
  String toString() => 'RecordMap(${value.length} entries)';
}

/// Converts a generic JSON value (as produced by `dart:convert`'s
/// `jsonDecode`) into a [Record]. Mirrors `go/kernel/json.go`'s
/// `RecordFromJSON`: JSON numbers must be base-10 integers within the
/// js-safe-int range -- a JSON numeric literal with a fractional or
/// exponent part decodes to a Dart `double`, which this function rejects
/// outright, exactly as Go's `json.Number.Int64()` rejects a literal such
/// as `"1.5"`. JSON's normal object/array/string forms map onto
/// [RecordMap]/[RecordArray]/[RecordText] directly. There is no dedicated
/// JSON shape for [RecordBytes] in this conversion, mirroring Go: none of
/// the kernel-protocol record families (turn-tree-schema, turn-node
/// identity) carry a bytes-typed field.
Record recordFromJson(Object? value) {
  switch (value) {
    case null:
      return const RecordNull();
    case bool b:
      return RecordBool(b);
    case int i:
      if (i < minSafeInteger || i > maxSafeInteger) {
        throw FormatException(
          'kernel record from JSON: integer $i is outside the js-safe-int '
          'range [$minSafeInteger, $maxSafeInteger]',
        );
      }
      return RecordInt(i);
    case double d:
      throw FormatException(
        'kernel record from JSON: $d is not a base-10 integer',
      );
    case String s:
      return RecordText(s);
    case List<Object?> list:
      return RecordArray(<Record>[
        for (final item in list) recordFromJson(item),
      ]);
    case Map<String, Object?> map:
      return RecordMap(<String, Record>{
        for (final entry in map.entries) entry.key: recordFromJson(entry.value),
      });
    default:
      throw FormatException(
        'kernel record from JSON: unsupported JSON value type '
        '${value.runtimeType}',
      );
  }
}

/// Converts a [Record] back into a generic JSON-marshalable value (as
/// consumed by `dart:convert`'s `jsonEncode`, or compared structurally
/// against a `jsonDecode`d fixture). Mirrors `go/kernel/json.go`'s
/// `RecordToJSON`: [RecordInt] values stay a Dart `int` (so js-safe-int
/// fidelity survives a `jsonEncode` round trip, since Dart's JSON encoder
/// emits `int` as a JSON integer literal, never `1.0`-style float
/// notation); [RecordBytes] values become a `List<int>` of unsigned byte
/// values, mirroring how the TypeScript, Rust, and Go kernel ports
/// represent opaque bytes at the JSON boundary.
Object? recordToJson(Record record) {
  return switch (record) {
    RecordNull() => null,
    RecordBool(:final value) => value,
    RecordInt(:final value) => value,
    RecordText(:final value) => value,
    RecordBytes(:final value) => List<int>.of(value),
    RecordArray(:final value) => [
      for (final element in value) recordToJson(element),
    ],
    RecordMap(:final value) => {
      for (final entry in value.entries) entry.key: recordToJson(entry.value),
    },
  };
}
