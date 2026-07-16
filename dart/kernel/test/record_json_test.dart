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

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

void main() {
  group('recordFromJson', () {
    test('converts every primitive JSON shape', () {
      expect(recordFromJson(null), equals(const RecordNull()));
      expect(recordFromJson(true), equals(const RecordBool(true)));
      expect(recordFromJson(false), equals(const RecordBool(false)));
      expect(recordFromJson(42), equals(const RecordInt(42)));
      expect(recordFromJson('hi'), equals(const RecordText('hi')));
      expect(
        recordFromJson([1, 'a', null]),
        equals(
          RecordArray([
            const RecordInt(1),
            const RecordText('a'),
            const RecordNull(),
          ]),
        ),
      );
      expect(
        recordFromJson({'a': 1, 'b': null}),
        equals(RecordMap({'a': const RecordInt(1), 'b': const RecordNull()})),
      );
    });

    test('rejects a fractional number (not a base-10 integer)', () {
      expect(() => recordFromJson(1.5), throwsFormatException);
    });

    test('rejects an integral-valued double (still not a base-10 integer '
        'literal, mirroring json.Number.Int64 rejecting "2.0")', () {
      expect(() => recordFromJson(2.0), throwsFormatException);
    });

    test('rejects an integer outside the js-safe-int range', () {
      expect(() => recordFromJson(maxSafeInteger + 1), throwsFormatException);
      expect(() => recordFromJson(minSafeInteger - 1), throwsFormatException);
    });

    test('accepts the js-safe-int boundary values', () {
      expect(
        recordFromJson(maxSafeInteger),
        equals(const RecordInt(maxSafeInteger)),
      );
      expect(
        recordFromJson(minSafeInteger),
        equals(const RecordInt(minSafeInteger)),
      );
    });
  });

  group('recordToJson', () {
    test('converts every variant back to its generic JSON shape', () {
      expect(recordToJson(const RecordNull()), isNull);
      expect(recordToJson(const RecordBool(true)), isTrue);
      expect(recordToJson(const RecordInt(7)), 7);
      expect(recordToJson(const RecordText('hi')), 'hi');
      expect(recordToJson(const RecordBytes([1, 2, 3])), [1, 2, 3]);
      expect(
        recordToJson(RecordArray([const RecordInt(1), const RecordText('a')])),
        [1, 'a'],
      );
      expect(recordToJson(RecordMap({'x': const RecordInt(1)})), {'x': 1});
    });

    test('round trips through recordFromJson for a nested structure', () {
      final original = {
        'schemaId': 'schema_main',
        'paths': [
          {'path': 'messages', 'collection': 'ordered'},
        ],
        'count': 3,
        'nullable': null,
      };
      final record = recordFromJson(original);
      final roundTripped = recordToJson(record);
      expect(roundTripped, equals(original));
    });
  });
}
