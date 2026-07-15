# Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Entry point for ``python -m tuvren_kernel_adapter``.

Reads JSON-RPC 2.0 requests one per line from stdin and writes one JSON-RPC
2.0 response per line to stdout, per
`tools/conformance/adapter-protocol/protocol.md`. Stdout carries protocol
frames only; all diagnostics go to stderr. This module is a protocol-complete
skeleton for milestone M0 — it implements the seven adapter-protocol methods
and a per-operation dispatch registry seam, but no kernel operation has
semantics yet.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any

ADAPTER_ID = "python-kernel"

# Byte-for-byte identical to the "capabilities" list in adapter.json. The
# conformance harness rejects a handshake whose reported capabilities do not
# match the manifest exactly (see validateAdapterHandshake in
# tools/conformance/harness/run.ts).
CAPABILITIES: list[str] = []


class AdapterError(Exception):
    """Carries a Tuvren ErrorEnvelope for a failed JSON-RPC request.

    This is distinct from an operation-level `{"kind": "error", ...}`
    OperationOutcome: raising AdapterError fails the JSON-RPC call itself
    (used for malformed requests and unsupported methods), while dispatch
    operation failures are returned as a normal JSON-RPC result whose value
    is an error-kind OperationOutcome.
    """

    def __init__(
        self,
        code: str,
        message: str,
        details: Any = None,
        cause: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details
        self.cause = cause

    def to_envelope(self) -> dict[str, Any]:
        envelope: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            envelope["details"] = self.details
        if self.cause is not None:
            envelope["cause"] = self.cause
        return envelope


# Per-operation dispatch registry seam. Later milestones populate this with
# real kernel operation handlers; each handler receives the operation input
# and returns the OperationOutcome "value" payload (an AdapterObservation),
# raising AdapterOperationError for an error-kind outcome.
class AdapterOperationError(Exception):
    """Raised by an operation handler to produce an error-kind OperationOutcome."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


OperationHandler = Callable[[dict[str, Any]], dict[str, Any]]

OPERATION_HANDLERS: dict[str, OperationHandler] = {}


def handle_initialize(params: dict[str, Any]) -> dict[str, Any]:
    packet_id = _require_str(params, "packetId")
    plan_version = _require_str(params, "planVersion")
    return {
        "adapterId": ADAPTER_ID,
        "capabilities": CAPABILITIES,
        "packetId": packet_id,
        "planVersion": plan_version,
    }


def handle_dispatch(params: dict[str, Any]) -> dict[str, Any]:
    operation = _require_str(params, "operation")
    handler = OPERATION_HANDLERS.get(operation)

    if handler is None:
        return {
            "kind": "error",
            "error": {
                "code": "adapter_operation_not_implemented",
                "message": f"operation not implemented: {operation}",
            },
        }

    try:
        value = handler(params.get("input"))
    except AdapterOperationError as operation_error:
        error: dict[str, Any] = {
            "code": operation_error.code,
            "message": operation_error.message,
        }
        if operation_error.details is not None:
            error["details"] = operation_error.details
        return {"kind": "error", "error": error}

    return {"kind": "result", "value": value}


def handle_events(_params: dict[str, Any]) -> list[Any]:
    return []


def handle_create_instance(_params: dict[str, Any]) -> None:
    return None


def handle_inspect_state(_params: dict[str, Any]) -> None:
    return None


def handle_destroy_instance(_params: dict[str, Any]) -> None:
    return None


def handle_shutdown(_params: dict[str, Any]) -> None:
    return None


METHOD_HANDLERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "initialize": handle_initialize,
    "createInstance": handle_create_instance,
    "dispatch": handle_dispatch,
    "events": handle_events,
    "inspectState": handle_inspect_state,
    "destroyInstance": handle_destroy_instance,
    "shutdown": handle_shutdown,
}


def _require_str(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str):
        raise AdapterError("invalid_adapter_request", f"params.{key} must be a string")
    return value


def dispatch_request(request: dict[str, Any]) -> Any:
    if request.get("jsonrpc") != "2.0":
        raise AdapterError("invalid_json_rpc_request", "request jsonrpc must be 2.0")

    method = request.get("method")
    if not isinstance(method, str):
        raise AdapterError("invalid_json_rpc_request", "request method must be a string")

    handler = METHOD_HANDLERS.get(method)
    if handler is None:
        raise AdapterError("adapter_method_not_implemented", f"unsupported adapter method {method}")

    params = request.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise AdapterError("invalid_json_rpc_request", "request params must be an object")

    return handler(params)


def handle_line(line: str) -> dict[str, Any] | None:
    stripped = line.strip()
    if stripped == "":
        return None

    try:
        request = json.loads(stripped)
    except json.JSONDecodeError as decode_error:
        # Malformed frames still get one JSON-RPC error response with a null
        # id (there is no request id to reply to), matching the Go and Rust
        # adapters. The decode error is also logged to stderr for local
        # diagnostics; stdout carries protocol frames only.
        print(f"malformed JSON-RPC request: {decode_error}", file=sys.stderr)
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": AdapterError(
                "invalid_adapter_request",
                f"failed to parse JSON-RPC request: {decode_error}",
            ).to_envelope(),
        }

    request_id = request.get("id") if isinstance(request, dict) else None

    try:
        if not isinstance(request, dict):
            raise AdapterError("invalid_json_rpc_request", "request must be a JSON object")
        result = dispatch_request(request)
    except AdapterError as adapter_error:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": adapter_error.to_envelope(),
        }

    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> None:
    while True:
        line = sys.stdin.readline()
        if line == "":
            break

        response = handle_line(line)
        if response is None:
            continue

        sys.stdout.write(json.dumps(response, allow_nan=False, separators=(",", ":")))
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
