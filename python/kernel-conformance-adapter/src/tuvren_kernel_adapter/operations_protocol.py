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

"""`kernel.protocol` wire-level operation handlers: deterministic hashing,
canonical CBOR schema roundtripping, and verdict composition.

See `tuvren_kernel_adapter.operations` for the shared adapter-input helpers,
the `AdapterObservation` envelope shape, and the routing table these
handlers are registered under.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel import identity, records
from tuvren_kernel.verdict import compose_verdicts

from tuvren_kernel_adapter.operations_common import (
    OperationInputError,
    _projection,
    _read_fixture,
    _read_fixture_optional,
    _read_u8_array,
)

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


def run_modify_composition(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.protocol.modify-composition`.

    Without a fixture (the core-plan check), composes the fixed ordered
    verdict scenario (modify "first", proceed, modify "second") through
    `tuvren_kernel.verdict.compose_verdicts` and reports the resulting
    verdict -- unchanged from this operation's original behavior.

    With a fixture (the extended-plan `kernel-protocol-verdict-composition`
    check), composes each fixture case's `verdicts` list independently and
    reports the composed verdict per case under `$.composition.<name>`,
    which the associated conformance plan's assertions deep-equal against
    that case's fixture-authored `expected` value (spec §6.1/§6.2
    dominance and multi-Modify transform-ordering semantics).
    """

    fixture = _read_fixture_optional(operation_input)
    if fixture is None:
        composed = compose_verdicts(_MODIFY_COMPOSITION_VERDICTS)
        return _projection({"verdict": composed})

    cases = fixture.get("cases")
    if not isinstance(cases, dict):
        raise OperationInputError("invalid_object_fixture", "fixture cases must be an object")

    composition: dict[str, Any] = {}
    for case_name, case_value in cases.items():
        if not isinstance(case_value, dict):
            raise OperationInputError(
                "invalid_object_fixture", f"cases.{case_name} must be an object"
            )
        verdicts = case_value.get("verdicts")
        if not isinstance(verdicts, list):
            raise OperationInputError(
                "invalid_array_fixture", f"cases.{case_name}.verdicts must be an array"
            )
        composition[case_name] = compose_verdicts(verdicts)

    return _projection({"composition": composition})


def run_canonical_rejection(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.protocol.canonical-rejection`.

    Attempts the strict canonical `tuvren_kernel.cbor.decode` on each
    adversarial fixture case's raw byte sequence and reports whether the
    decode raised `CborDecodeError` (`rejected: true`) or succeeded
    (`rejected: false`) -- no error-code projection, per the adapter hard
    rules. The associated conformance plan expects every case rejected.
    """

    fixture = _read_fixture(operation_input)
    cases = fixture.get("cases")
    if not isinstance(cases, dict):
        raise OperationInputError("invalid_object_fixture", "fixture cases must be an object")

    from tuvren_kernel import cbor

    rejection: dict[str, Any] = {}
    for case_name, case_value in cases.items():
        if not isinstance(case_value, dict):
            raise OperationInputError(
                "invalid_object_fixture", f"cases.{case_name} must be an object"
            )
        cbor_bytes = _read_u8_array(case_value.get("cborBytes"), f"cases.{case_name}.cborBytes")
        try:
            cbor.decode(cbor_bytes)
            rejected = False
        except cbor.CborDecodeError:
            rejected = True
        rejection[case_name] = {"rejected": rejected}

    return _projection({"rejection": rejection})
