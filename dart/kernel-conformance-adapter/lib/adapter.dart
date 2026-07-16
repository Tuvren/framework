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

/// Dart kernel conformance adapter.
///
/// Speaks the Tuvren conformance adapter protocol (JSON-RPC 2.0 request and
/// response framing over line-delimited stdio, see
/// tools/conformance/adapter-protocol/protocol.md) so the shared conformance
/// engine (tools/conformance/harness/run.ts) can drive the Dart kernel port
/// the same way it drives the TypeScript, Rust, Go, and Python ports.
/// Operation handlers are wired through [operationHandlers]; an operation
/// name outside that table reports adapter_operation_not_implemented.
library;

import 'dart:convert';

/// Adapter identity echoed by `initialize`; must match `adapter.json`.
const String adapterId = 'dart-kernel';

/// Capabilities advertised by `initialize`; must stay set-equal to the
/// `capabilities` array in `adapter.json`. Empty until the Dart kernel
/// implementation lands: an honest empty set makes every kernel plan check
/// non-applicable instead of dishonestly failing.
List<String> capabilities() => const <String>[];

/// One conformance operation: raw dispatch `input` in, observation out.
///
/// The returned observation is wrapped by [projection] so the plan can read
/// the same value under both `$.result` and `$.evidence`.
typedef OperationHandler = Object? Function(Object? input);

/// Dispatch table mapping `params.operation` names from the kernel
/// conformance plans to their handlers. Populated by the kernel
/// implementation milestone; empty while the adapter is a protocol stub.
final Map<String, OperationHandler> operationHandlers =
    <String, OperationHandler>{};

/// Wraps a raw observation as the `{result, evidence}` shape the kernel
/// plans read, mirroring the Go adapter's projection helper: `result` and
/// `evidence` carry the same observation object.
Map<String, Object?> projection(Object? observation) => <String, Object?>{
      'result': observation,
      'evidence': observation,
    };

Map<String, Object?> _errorEnvelope(String code, String message) =>
    <String, Object?>{'code': code, 'message': message};

Map<String, Object?> _errorResponse(Object? id, String code, String message) =>
    <String, Object?>{
      'jsonrpc': '2.0',
      'id': id,
      'error': _errorEnvelope(code, message),
    };

Map<String, Object?> _resultResponse(Object? id, Object? result) =>
    <String, Object?>{'jsonrpc': '2.0', 'id': id, 'result': result};

/// Recursively walks a value that is about to be handed to [jsonEncode],
/// throwing a [FormatException] on the first `double` that is not
/// [double.isFinite] (NaN, +Infinity, or -Infinity). `jsonEncode` encodes
/// these as invalid, non-JSON tokens instead of throwing, so this check must
/// run before encoding to route non-encodable responses into the
/// hand-built adapter_response_serialization_failed fallback.
void _rejectNonFiniteDoubles(Object? value) {
  switch (value) {
    case double d when !d.isFinite:
      throw FormatException('non-finite double $d is not valid JSON');
    case Map<Object?, Object?> map:
      for (final entry in map.values) {
        _rejectNonFiniteDoubles(entry);
      }
    case Iterable<Object?> iterable:
      for (final element in iterable) {
        _rejectNonFiniteDoubles(element);
      }
    default:
      return;
  }
}

/// Routes one operation dispatch to its handler, converting an uncaught
/// throw into an adapter_operation_panicked error outcome so a broken
/// handler fails only its own check instead of crashing the process.
Map<String, Object?> dispatchOperation(String operation, Object? input) {
  final handler = operationHandlers[operation];
  if (handler == null) {
    return <String, Object?>{
      'kind': 'error',
      'error': _errorEnvelope(
        'adapter_operation_not_implemented',
        'operation $operation is not implemented by $adapterId',
      ),
    };
  }
  try {
    return <String, Object?>{'kind': 'result', 'value': handler(input)};
  } catch (error) {
    return <String, Object?>{
      'kind': 'error',
      'error': _errorEnvelope(
        'adapter_operation_panicked',
        'operation $operation panicked: $error',
      ),
    };
  }
}

Map<String, Object?> _handleInitialize(Object? id, Object? params) {
  final map = params is Map<String, Object?> ? params : const {};
  final packetId = map['packetId'];
  if (packetId is! String || packetId.isEmpty) {
    return _errorResponse(
      id,
      'invalid_adapter_request',
      'params.packetId must be a non-empty string',
    );
  }
  final planVersion = map['planVersion'];
  if (planVersion is! String || planVersion.isEmpty) {
    return _errorResponse(
      id,
      'invalid_adapter_request',
      'params.planVersion must be a non-empty string',
    );
  }
  return _resultResponse(id, <String, Object?>{
    'adapterId': adapterId,
    'capabilities': capabilities(),
    'packetId': packetId,
    'planVersion': planVersion,
  });
}

Map<String, Object?> _handleDispatch(Object? id, Object? params) {
  final map = params is Map<String, Object?> ? params : const {};
  final operation = map['operation'];
  // A dispatch frame without a string operation is a malformed request,
  // not an unimplemented operation: fail the JSON-RPC call itself with
  // invalid_adapter_request, matching the Go, Rust, and Python adapters.
  if (operation is! String || operation.isEmpty) {
    return _errorResponse(
      id,
      'invalid_adapter_request',
      'params.operation must be a non-empty string',
    );
  }
  return _resultResponse(id, dispatchOperation(operation, map['input']));
}

/// Parses and dispatches a single JSON-RPC request line, returning exactly
/// one JSON-RPC response line (without the trailing newline). Diagnostics
/// never go to stdout; stdout carries protocol frames only.
String handleLine(String line) {
  Object? id;
  Map<String, Object?> response;
  try {
    final decoded = jsonDecode(line);
    if (decoded is! Map<String, Object?>) {
      response = _errorResponse(
        null,
        'invalid_json_rpc_request',
        'request frame must be a JSON object',
      );
    } else {
      id = decoded['id'];
      if (decoded['jsonrpc'] != '2.0') {
        response = _errorResponse(
          id,
          'invalid_json_rpc_request',
          'request jsonrpc must be 2.0',
        );
      } else {
        final method = decoded['method'];
        // A frame whose method isn't a string is a malformed request, not an
        // unimplemented method: fail with invalid_json_rpc_request, matching
        // the Go adapter's method-type check.
        if (method is! String) {
          response = _errorResponse(
            id,
            'invalid_json_rpc_request',
            'request method must be a string',
          );
        } else {
          final params = decoded['params'];
          response = switch (method) {
            'initialize' => _handleInitialize(id, params),
            'dispatch' => _handleDispatch(id, params),
            'events' => _resultResponse(id, const <Object?>[]),
            'createInstance' ||
            'inspectState' ||
            'destroyInstance' ||
            'shutdown' =>
              _resultResponse(id, null),
            final method => _errorResponse(
                id,
                'adapter_method_not_implemented',
                'unsupported adapter method $method',
              ),
          };
        }
      }
    }
  } on FormatException catch (error) {
    response = _errorResponse(
      null,
      'invalid_json_rpc_request',
      'failed to parse JSON-RPC request: ${error.message}',
    );
  }

  try {
    // dart:convert's jsonEncode does not throw on double.nan or
    // double.infinity: it silently emits the invalid (non-JSON) tokens NaN,
    // Infinity, and -Infinity, so the adapter_response_serialization_failed
    // fallback below would never fire for a handler that returns a
    // non-finite double. Walk the response first and throw on any such
    // value so it routes into the same fallback as a genuine encode
    // failure, matching the Go and Python adapters' behavior.
    _rejectNonFiniteDoubles(response);
    return jsonEncode(response);
  } catch (error) {
    // A response frame that fails to encode must still produce exactly one
    // line on stdout: the harness matches responses to requests by id, and
    // writing nothing would hang that request id until its deadline instead
    // of failing it. Hand-build a minimal error frame whose only encoded
    // parts are plain strings (which cannot fail to encode), matching the
    // Go and Python adapters' adapter_response_serialization_failed code.
    String idLiteral;
    try {
      idLiteral = jsonEncode(id);
    } catch (_) {
      idLiteral = 'null';
    }
    final message = jsonEncode('failed to encode response frame: $error');
    return '{"jsonrpc":"2.0","id":$idLiteral,'
        '"error":{"code":"adapter_response_serialization_failed",'
        '"message":$message}}';
  }
}
