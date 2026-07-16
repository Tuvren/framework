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

void _expectCode(void Function() body, String code) {
  try {
    body();
    fail(
        'expected a KernelException with code "$code", but nothing was thrown');
  } on KernelException catch (e) {
    expect(e.code, code);
  }
}

void main() {
  group('validateTurnTreeSchema', () {
    test('rejects unknown field', () {
      final record = RecordMap({
        'schemaId': const RecordText('schema_main'),
        'paths': const RecordArray([]),
        'incorporationRules': const RecordArray([]),
        'unexpectedField': const RecordText('nope'),
      });
      _expectCode(
        () => validateTurnTreeSchema(record),
        errUnknownRecordField,
      );
    });

    test('rejects duplicate path', () {
      final pathDef = RecordMap({
        'path': const RecordText('messages'),
        'collection': const RecordText('ordered'),
      });
      final record = RecordMap({
        'schemaId': const RecordText('schema_main'),
        'paths': RecordArray([pathDef, pathDef]),
        'incorporationRules': const RecordArray([]),
      });
      _expectCode(
        () => validateTurnTreeSchema(record),
        errDuplicateSchemaPath,
      );
    });

    test('accepts a well-formed schema', () {
      final record = RecordMap({
        'schemaId': const RecordText('schema_main'),
        'paths': RecordArray([
          RecordMap({
            'path': const RecordText('messages'),
            'collection': const RecordText('ordered'),
          }),
          RecordMap({
            'path': const RecordText('context.manifest'),
            'collection': const RecordText('single'),
            'metadata': const RecordNull(),
          }),
        ]),
        'incorporationRules': RecordArray([
          RecordMap({
            'objectType': const RecordText('message'),
            'targetPath': const RecordText('messages'),
          }),
        ]),
      });

      final schema = validateTurnTreeSchema(record);
      expect(schema.schemaId, 'schema_main');
      expect(schema.paths, hasLength(2));
    });

    test('rejects an invalid collection kind', () {
      final record = RecordMap({
        'schemaId': const RecordText('schema_main'),
        'paths': RecordArray([
          RecordMap({
            'path': const RecordText('messages'),
            'collection': const RecordText('not-a-real-kind'),
          }),
        ]),
        'incorporationRules': const RecordArray([]),
      });
      _expectCode(
        () => validateTurnTreeSchema(record),
        errInvalidRecordField,
      );
    });
  });

  group('validateStepDeclaration', () {
    test('rejects a missing required field', () {
      final record = RecordMap({
        'id': const RecordText('step_a'),
        'deterministic': const RecordBool(true),
        // sideEffects intentionally omitted
      });
      _expectCode(
        () => validateStepDeclaration(record),
        errMissingRecordField,
      );
    });

    test('accepts absent optional metadata', () {
      final record = RecordMap({
        'id': const RecordText('step_a'),
        'deterministic': const RecordBool(true),
        'sideEffects': const RecordBool(false),
      });
      final decl = validateStepDeclaration(record);
      expect(decl.metadata, isNull);
    });

    test('accepts explicit null metadata', () {
      // metadata's CDDL type is kernel-record, whose own union includes
      // null, so an explicit null is a legitimate value here (unlike a
      // field typed without null in its union).
      final record = RecordMap({
        'id': const RecordText('step_a'),
        'deterministic': const RecordBool(true),
        'sideEffects': const RecordBool(false),
        'metadata': const RecordNull(),
      });
      final decl = validateStepDeclaration(record);
      expect(decl.metadata, isNotNull);
      expect(decl.metadata, equals(const RecordNull()));
    });
  });

  group('validateStagedResult', () {
    test('interrupted status requires interruptPayload', () {
      final record = RecordMap({
        'taskId': const RecordText('task_1'),
        'objectHash': RecordText(hashBytesToHex('x'.codeUnits)),
        'objectType': const RecordText('tool_result'),
        'timestamp': const RecordInt(1),
        'status': const RecordText('interrupted'),
        // interruptPayload intentionally omitted
      });
      _expectCode(
        () => validateStagedResult(record),
        errMissingRecordField,
      );
    });

    test('settled status rejects interruptPayload field', () {
      // interruptPayload is only in the interrupted-staged-result shape; a
      // settled (completed/failed) record carrying it violates the
      // closed-map rule for that variant.
      final record = RecordMap({
        'taskId': const RecordText('task_1'),
        'objectHash': RecordText(hashBytesToHex('x'.codeUnits)),
        'objectType': const RecordText('tool_result'),
        'timestamp': const RecordInt(1),
        'status': const RecordText('completed'),
        'interruptPayload': const RecordText('nope'),
      });
      _expectCode(
        () => validateStagedResult(record),
        errUnknownRecordField,
      );
    });

    test('rejects an unknown status', () {
      final record = RecordMap({
        'taskId': const RecordText('task_1'),
        'objectHash': RecordText(hashBytesToHex('x'.codeUnits)),
        'objectType': const RecordText('tool_result'),
        'timestamp': const RecordInt(1),
        'status': const RecordText('not-a-real-status'),
      });
      _expectCode(
        () => validateStagedResult(record),
        errInvalidRecordField,
      );
    });
  });

  test(
    'validateTurnTreeManifestLike accepts null, single, and ordered values',
    () {
      final hashA = hashBytesToHex('a'.codeUnits);
      final hashB = hashBytesToHex('b'.codeUnits);
      final record = RecordMap({
        'context.manifest': const RecordNull(),
        'single.path': RecordText(hashA),
        'messages': RecordArray([RecordText(hashA), RecordText(hashB)]),
      });

      final manifest =
          validateTurnTreeManifestLike(record, 'turn-tree-manifest');

      expect(manifest['context.manifest']!.kind, PathValueKind.nullValue);
      expect(manifest['single.path']!.kind, PathValueKind.single);
      expect(manifest['single.path']!.single, hashA);
      expect(manifest['messages']!.kind, PathValueKind.ordered);
      expect(manifest['messages']!.ordered, hasLength(2));
    },
  );
}
