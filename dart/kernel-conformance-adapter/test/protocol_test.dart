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

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tuvren_kernel_adapter/adapter.dart';

Map<String, Object?> roundTrip(Map<String, Object?> request) =>
    jsonDecode(handleLine(jsonEncode(request))) as Map<String, Object?>;

void main() {
  test('initialize echoes adapterId, packetId, planVersion, capabilities', () {
    final response = roundTrip({
      'jsonrpc': '2.0',
      'id': 1,
      'method': 'initialize',
      'params': {'packetId': 'tuvren.kernel.protocol', 'planVersion': '0.11.0'},
    });
    expect(response['id'], 1);
    expect(response['error'], isNull);
    final result = response['result'] as Map<String, Object?>;
    expect(result['adapterId'], adapterId);
    expect(result['packetId'], 'tuvren.kernel.protocol');
    expect(result['planVersion'], '0.11.0');
    expect(result['capabilities'], capabilities());
  });

  test('initialize without packetId fails with invalid_adapter_request', () {
    final response = roundTrip({
      'jsonrpc': '2.0',
      'id': 2,
      'method': 'initialize',
      'params': {'planVersion': '0.11.0'},
    });
    final error = response['error'] as Map<String, Object?>;
    expect(error['code'], 'invalid_adapter_request');
  });

  test('dispatch of an unwired operation reports not-implemented outcome', () {
    final response = roundTrip({
      'jsonrpc': '2.0',
      'id': 3,
      'method': 'dispatch',
      'params': {'operation': 'kernel.protocol.deterministic-hashing'},
    });
    expect(response['error'], isNull);
    final outcome = response['result'] as Map<String, Object?>;
    expect(outcome['kind'], 'error');
    final error = outcome['error'] as Map<String, Object?>;
    expect(error['code'], 'adapter_operation_not_implemented');
  });

  test('dispatch without operation is a malformed request, not an outcome', () {
    final response = roundTrip({
      'jsonrpc': '2.0',
      'id': 4,
      'method': 'dispatch',
      'params': <String, Object?>{},
    });
    final error = response['error'] as Map<String, Object?>;
    expect(error['code'], 'invalid_adapter_request');
  });

  test('events returns an empty array; lifecycle methods return null', () {
    final events = roundTrip({
      'jsonrpc': '2.0',
      'id': 5,
      'method': 'events',
      'params': {},
    });
    expect(events['result'], isEmpty);
    for (final method in [
      'createInstance',
      'inspectState',
      'destroyInstance',
      'shutdown',
    ]) {
      final response = roundTrip({
        'jsonrpc': '2.0',
        'id': 6,
        'method': method,
        'params': {},
      });
      expect(response.containsKey('result'), isTrue);
      expect(response['result'], isNull);
      expect(response['error'], isNull);
    }
  });

  test('unknown method fails with adapter_method_not_implemented', () {
    final response = roundTrip({
      'jsonrpc': '2.0',
      'id': 7,
      'method': 'grade',
      'params': {},
    });
    final error = response['error'] as Map<String, Object?>;
    expect(error['code'], 'adapter_method_not_implemented');
  });

  test(
    'malformed JSON and non-2.0 frames fail with invalid_json_rpc_request',
    () {
      final malformed =
          jsonDecode(handleLine('this is not json')) as Map<String, Object?>;
      expect(
        (malformed['error'] as Map<String, Object?>)['code'],
        'invalid_json_rpc_request',
      );
      final wrongVersion = roundTrip({
        'jsonrpc': '1.0',
        'id': 8,
        'method': 'events',
      });
      expect(
        (wrongVersion['error'] as Map<String, Object?>)['code'],
        'invalid_json_rpc_request',
      );
      final nonObject =
          jsonDecode(handleLine('[1,2,3]')) as Map<String, Object?>;
      expect(
        (nonObject['error'] as Map<String, Object?>)['code'],
        'invalid_json_rpc_request',
      );
    },
  );

  test('a non-string method fails with invalid_json_rpc_request', () {
    for (final method in [7, null]) {
      final response = roundTrip({
        'jsonrpc': '2.0',
        'id': 9,
        'method': method,
        'params': {},
      });
      expect(
        (response['error'] as Map<String, Object?>)['code'],
        'invalid_json_rpc_request',
      );
    }
    // A frame missing `method` entirely decodes it as null, exercising the
    // same non-string check.
    final missing = jsonDecode(
      handleLine(jsonEncode({'jsonrpc': '2.0', 'id': 10, 'params': {}})),
    ) as Map<String, Object?>;
    expect(
      (missing['error'] as Map<String, Object?>)['code'],
      'invalid_json_rpc_request',
    );
  });

  test('response id echoes null id and numeric id', () {
    final nullId = roundTrip({
      'jsonrpc': '2.0',
      'id': null,
      'method': 'events',
      'params': {},
    });
    expect(nullId.containsKey('id'), isTrue);
    expect(nullId['id'], isNull);

    final numericId = roundTrip({
      'jsonrpc': '2.0',
      'id': 42,
      'method': 'events',
      'params': {},
    });
    expect(numericId['id'], 42);
  });

  test(
    'a response containing a non-finite double falls back to '
    'adapter_response_serialization_failed',
    () {
      const operation = 'kernel.protocol.__non_finite_double_fallback__';
      operationHandlers[operation] = (input) => {'x': double.nan};
      try {
        final line = handleLine(
          jsonEncode({
            'jsonrpc': '2.0',
            'id': 11,
            'method': 'dispatch',
            'params': {'operation': operation},
          }),
        );
        // The fallback frame is hand-built from plain strings, so it must
        // still be valid, decodable JSON.
        final decoded = jsonDecode(line) as Map<String, Object?>;
        expect(decoded['id'], 11);
        final error = decoded['error'] as Map<String, Object?>;
        expect(error['code'], 'adapter_response_serialization_failed');
      } finally {
        operationHandlers.remove(operation);
      }
    },
  );

  test('adapter process round-trips frames over real stdio', () async {
    final process = await Process.start(
        'dart',
        [
          'run',
          'bin/main.dart',
        ],
        workingDirectory: Directory.current.path);
    final responses =
        process.stdout.transform(utf8.decoder).transform(const LineSplitter());
    final stderrDrain = process.stderr.drain<void>();
    process.stdin.writeln(
      jsonEncode({
        'jsonrpc': '2.0',
        'id': 'handshake',
        'method': 'initialize',
        'params': {
          'packetId': 'tuvren.kernel.protocol',
          'planVersion': '0.11.0',
        },
      }),
    );
    final first = jsonDecode(await responses.first) as Map<String, Object?>;
    expect(first['id'], 'handshake');
    final result = first['result'] as Map<String, Object?>;
    expect(result['adapterId'], adapterId);
    await process.stdin.close();
    expect(await process.exitCode, 0);
    await stderrDrain;
  });
}
