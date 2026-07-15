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

"""`kernel.protocol` operation handlers backing the Python conformance adapter.

Each handler receives the JSON-RPC `dispatch` call's `params.input` (the
compiled adapter input, i.e. `{"checkInput": ..., "fixture": <fixture json
or None>}`; see `tools/conformance/harness/run.ts::createAdapterInput`) and
returns the `AdapterObservation` value the harness reads assertions from.

Per the adapter hard rules this module never receives a check identifier,
never grades pass/fail, and never emits evidence itself -- it only *computes* the
`tuvren_kernel` semantics a conformance plan's assertions read back out of
`$.result...` / `$.evidence...`. The `{"result": obs, "evidence": obs}`
envelope shape mirrors `rust/kernel-conformance-adapter/src/main.rs`'s
`projection()` helper, which the harness's `createResultContext` unwraps
(`outcome.value.result` / `outcome.value.evidence`) to build assertion
context -- this is a protocol requirement of the shared harness, not an
adapter-invented shape.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel import identity, records
from tuvren_kernel.verdict import compose_verdicts

# Verdict inputs for kernel.protocol.modify-composition. This mirrors the
# exact scenario `rust/kernel-conformance-adapter/src/main.rs::
# run_modify_composition` builds, which is itself derived directly from the
# modify-composition check's expected `$.verdict.transform` array in both
# `spec/conformance/kernel/plans/kernel-protocol-core.json` and
# `kernel-protocol-extended.json` -- not invented here.
_MODIFY_COMPOSITION_VERDICTS: list[dict[str, Any]] = [
    {
        "kind": "modify",
        "transform": {"extension": "first", "mutation": "append-prefix"},
    },
    {"kind": "proceed"},
    {
        "kind": "modify",
        "transform": {"extension": "second", "mutation": "append-suffix"},
    },
]


class OperationInputError(Exception):
    """Raised when adapter input does not match what an operation expects.

    The adapter's dispatch seam (`tuvren_kernel_adapter.__main__.
    handle_dispatch`) catches `AdapterOperationError`, not this type
    directly -- handlers raise `OperationInputError` and the dispatch
    wrapper below translates it, keeping the error *code* naming
    (`missing_value`, `invalid_object_fixture`, ...) aligned with
    `rust/kernel-conformance-adapter/src/main.rs`'s `KernelError` codes for
    cross-language consistency, without importing the Rust adapter's types.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _read_fixture(operation_input: Any) -> dict[str, Any]:
    if not isinstance(operation_input, dict):
        raise OperationInputError("missing_value", "adapter input is required for this operation")
    fixture = operation_input.get("fixture")
    if not isinstance(fixture, dict):
        raise OperationInputError(
            "invalid_object_fixture", "adapter input fixture must be an object"
        )
    return fixture


def _read_u8_array(value: Any, label: str) -> bytes:
    if not isinstance(value, list):
        raise OperationInputError("invalid_array_fixture", f"{label} must be an array")
    out = bytearray()
    for entry in value:
        if isinstance(entry, bool) or not isinstance(entry, int) or not (0 <= entry <= 255):
            raise OperationInputError("invalid_byte_fixture", f"{label} must contain bytes")
        out.append(entry)
    return bytes(out)


def _projection(evidence: dict[str, Any]) -> dict[str, Any]:
    return {"evidence": evidence, "result": evidence}


def run_deterministic_hashing(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.protocol.deterministic-hashing`.

    Hashes the fixture's raw opaque bytes directly, and the fixture's
    `turnTreeSchemaRecord` / `turnNodeIdentityRecord` JSON records as
    canonical kernel-record CBOR, then reports the three resulting SHA-256
    hex digests for the associated conformance plan's assertions to compare
    against the fixture's matching `*Sha256Hex` field.
    """

    fixture = _read_fixture(operation_input)
    raw_bytes = _read_u8_array(fixture.get("rawOpaqueBytes"), "rawOpaqueBytes")

    try:
        schema = records.normalize_turn_tree_schema(fixture.get("turnTreeSchemaRecord"))
        node = records.normalize_turn_node_identity(fixture.get("turnNodeIdentityRecord"))
    except records.RecordValidationError as validation_error:
        raise OperationInputError("invalid_object_fixture", str(validation_error)) from (
            validation_error
        )

    return _projection(
        {
            "hashes": {
                "rawOpaqueBytes": identity.hash_raw_bytes(raw_bytes),
                "turnTreeSchema": identity.hash_kernel_record(schema),
                "turnNodeIdentity": identity.hash_kernel_record(node),
            }
        }
    )


def run_schema_roundtrip(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.protocol.schema-roundtrip`.

    Decodes the fixture's canonical CBOR hex fields back into JSON records
    and reports them, so the associated conformance plan's assertions can
    check the decoded record deep-equals the fixture's original JSON
    record (proving `decode(encode(record)) == record` end to end through
    the wire fixture, not just through the in-process normalizer).
    """

    fixture = _read_fixture(operation_input)

    from tuvren_kernel import cbor

    def _decode_hex_field(field: str) -> Any:
        value = fixture.get(field)
        if not isinstance(value, str):
            raise OperationInputError("invalid_string_fixture", f"{field} must be a string")
        try:
            raw = bytes.fromhex(value)
        except ValueError as decode_error:
            raise OperationInputError(
                "invalid_hex_fixture", f"{field} must be valid hex"
            ) from decode_error
        try:
            return cbor.decode(raw)
        except cbor.CborDecodeError as decode_error:
            raise OperationInputError(
                "invalid_hex_fixture", f"{field} is not canonical kernel-record CBOR"
            ) from decode_error

    schema_record = _decode_hex_field("turnTreeSchemaRecordCborHex")
    node_record = _decode_hex_field("turnNodeIdentityRecordCborHex")

    return _projection(
        {
            "roundtrip": {
                "turnTreeSchemaRecord": schema_record,
                "turnNodeIdentityRecord": node_record,
            }
        }
    )


def run_modify_composition(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.protocol.modify-composition`.

    Composes the fixed ordered verdict scenario (modify "first", proceed,
    modify "second") through `tuvren_kernel.verdict.compose_verdicts` and
    reports the resulting verdict, which the associated conformance plan's
    assertions expect to be a single Modify verdict whose transform is the
    ordered concatenation of the two Modify transforms.
    """

    composed = compose_verdicts(_MODIFY_COMPOSITION_VERDICTS)
    return _projection({"verdict": composed})


OPERATIONS: dict[str, Any] = {
    "kernel.protocol.deterministic-hashing": run_deterministic_hashing,
    "kernel.protocol.schema-roundtrip": run_schema_roundtrip,
    "kernel.protocol.modify-composition": run_modify_composition,
}
