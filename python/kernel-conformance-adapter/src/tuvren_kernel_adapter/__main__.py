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
frames only; all diagnostics go to stderr. Milestone M1 wired the three
`kernel.protocol` record/verdict operations; milestone M2 adds the
`kernel.logical` / `kernel.lineage` / `kernel.protocol.edge-validation`
surface built on `tuvren_kernel.runtime.RuntimeKernel` (see
`tuvren_kernel_adapter.operations`) into the per-operation dispatch registry
seam this module has carried since milestone M0. The remaining
`docs/KrakenKernelSpecification.md` Section 7 surface (run liveness/leases,
restart recovery, Scope isolation, reclamation) lands in later milestones.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any

from tuvren_kernel_adapter import operations

ADAPTER_ID = "python-kernel"

# Byte-for-byte identical to the "capabilities" list in adapter.json. The
# conformance harness rejects a handshake whose reported capabilities do not
# match the manifest exactly (see validateAdapterHandshake in
# tools/conformance/harness/run.ts).
CAPABILITIES: list[str] = [
    "kernel.protocol",
    "kernel.edge-validation",
    "kernel.logical",
    "kernel-protocol.thread.enumeration",
    "kernel.run-liveness",
    "kernel.restart-recovery",
]


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

# The dispatch table itself -- the mapping from promoted operation name to
# handler -- lives in `tuvren_kernel_adapter.operations.OPERATIONS`; this is
# a plain copy so this module never needs its own literal operation-name
# strings outside this generic routing seam.
OPERATION_HANDLERS: dict[str, OperationHandler] = dict(operations.OPERATIONS)


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
    except operations.OperationInputError as input_error:
        # Bad/missing operation input (malformed fixture shape, wrong type,
        # etc.) is an error-kind OperationOutcome, not a JSON-RPC failure --
        # the JSON-RPC call itself succeeded, the *operation* rejected its
        # input. See the module docstring on `AdapterOperationError` above
        # for the distinction this dispatch seam preserves.
        return {
            "kind": "error",
            "error": {"code": input_error.code, "message": input_error.message},
        }
    except Exception as unexpected_error:  # noqa: BLE001 - see rationale below
        # Any other failure a handler can raise (RecursionError on adversarial
        # nesting, ValueError from a stdlib call, an unanticipated bug in a
        # new operation) must still come back as an error-kind
        # OperationOutcome rather than propagate out of `handle_dispatch`:
        # this is a long-lived stdio process serving one request after
        # another, and letting a single malformed operation input kill the
        # process would fail every subsequent request in the same run. This
        # is deliberately the *only* bare `except Exception` in the adapter:
        # it exists strictly to keep one bad *operation* from taking down
        # the *process*, not to swallow bugs quietly, so full diagnostics
        # (exception type, message, and operation name) go to stderr while
        # stdout keeps carrying protocol frames only. JSON-RPC framing
        # failures (malformed JSON, missing method) are unaffected -- those
        # are handled entirely by `handle_line`/`dispatch_request` before
        # this handler ever runs, and continue to fail the JSON-RPC call
        # itself rather than becoming an error-kind result.
        print(
            f"unexpected error in operation {operation!r}: "
            f"{type(unexpected_error).__name__}: {unexpected_error}",
            file=sys.stderr,
        )
        return {
            "kind": "error",
            "error": {
                "code": "adapter_operation_failed",
                "message": (
                    f"operation {operation!r} raised an unexpected "
                    f"{type(unexpected_error).__name__}: {unexpected_error}"
                ),
            },
        }

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
