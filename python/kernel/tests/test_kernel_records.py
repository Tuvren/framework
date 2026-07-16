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

"""Fixture-complete conformance oracle for canonical encoding + identity.

Every fixture under `spec/conformance/kernel/fixtures/kernel-protocol-*.json`
that carries a `turnTreeSchemaRecordCborHex` field is a
`kernel.protocol.deterministic-hashing` / `kernel.protocol.schema-roundtrip`
fixture (the one exception, `kernel-protocol-logical.json`, belongs to the
`kernel.logical` capability and is out of scope for this milestone). For
each such fixture this module asserts, independent of the conformance
harness:

  (a) `tuvren_kernel.cbor.encode` of the normalized JSON record reproduces
      the fixture's canonical CBOR hex byte-for-byte,
  (b) `tuvren_kernel.identity.hash_kernel_record` / `hash_raw_bytes`
      reproduce the fixture's three `*Sha256Hex` fields,
  (c) `decode(encode(record)) == record` and `encode(decode(hex)) == hex`
      (the schema-roundtrip identity), and
  (d) the record normalized from JSON deep-equals the fixture's JSON record.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tuvren_kernel import cbor, identity, records

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "spec" / "conformance" / "kernel" / "fixtures"


def _load_protocol_fixtures() -> list[tuple[str, dict[str, Any]]]:
    fixtures = []
    for path in sorted(FIXTURES_DIR.glob("kernel-protocol-*.json")):
        data = json.loads(path.read_text())
        if "turnTreeSchemaRecordCborHex" in data:
            fixtures.append((path.name, data))
    return fixtures


PROTOCOL_FIXTURES = _load_protocol_fixtures()
FIXTURE_IDS = [name for name, _ in PROTOCOL_FIXTURES]


def test_fixture_set_is_complete() -> None:
    # Pin the expected fixture count so a future authority change (adding or
    # removing a kernel-protocol fixture) fails loudly here instead of
    # silently narrowing the oracle. There are 18 `kernel-protocol-*.json`
    # fixtures carrying `turnTreeSchemaRecordCborHex` as of this writing
    # (`kernel-protocol-logical.json` is the one fixture in that glob that
    # belongs to the separate `kernel.logical` capability and is excluded).
    assert len(PROTOCOL_FIXTURES) == 18


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_raw_opaque_bytes_hash(name: str, fixture: dict[str, Any]) -> None:
    raw_bytes = bytes(fixture["rawOpaqueBytes"])
    assert identity.hash_raw_bytes(raw_bytes) == fixture["rawOpaqueBytesSha256Hex"]


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_turn_tree_schema_canonical_encoding_and_hash(name: str, fixture: dict[str, Any]) -> None:
    normalized = records.normalize_turn_tree_schema(fixture["turnTreeSchemaRecord"])
    encoded = cbor.encode(normalized)

    assert encoded.hex() == fixture["turnTreeSchemaRecordCborHex"]
    assert identity.hash_kernel_record(normalized) == fixture["turnTreeSchemaRecordSha256Hex"]
    assert identity.sha256_hex(encoded) == fixture["turnTreeSchemaRecordSha256Hex"]


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_turn_node_identity_canonical_encoding_and_hash(name: str, fixture: dict[str, Any]) -> None:
    normalized = records.normalize_turn_node_identity(fixture["turnNodeIdentityRecord"])
    encoded = cbor.encode(normalized)

    assert encoded.hex() == fixture["turnNodeIdentityRecordCborHex"]
    assert identity.hash_kernel_record(normalized) == fixture["turnNodeIdentityRecordSha256Hex"]
    assert identity.sha256_hex(encoded) == fixture["turnNodeIdentityRecordSha256Hex"]


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_turn_tree_schema_roundtrip(name: str, fixture: dict[str, Any]) -> None:
    fixture_bytes = bytes.fromhex(fixture["turnTreeSchemaRecordCborHex"])
    decoded = cbor.decode(fixture_bytes)

    assert decoded == fixture["turnTreeSchemaRecord"]
    assert cbor.encode(decoded) == fixture_bytes


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_turn_node_identity_roundtrip(name: str, fixture: dict[str, Any]) -> None:
    fixture_bytes = bytes.fromhex(fixture["turnNodeIdentityRecordCborHex"])
    decoded = cbor.decode(fixture_bytes)

    assert decoded == fixture["turnNodeIdentityRecord"]
    assert cbor.encode(decoded) == fixture_bytes


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_turn_tree_schema_json_normalization_deep_equals_fixture(
    name: str, fixture: dict[str, Any]
) -> None:
    normalized = records.normalize_turn_tree_schema(fixture["turnTreeSchemaRecord"])
    assert normalized == fixture["turnTreeSchemaRecord"]


@pytest.mark.parametrize("name,fixture", PROTOCOL_FIXTURES, ids=FIXTURE_IDS)
def test_turn_node_identity_json_normalization_deep_equals_fixture(
    name: str, fixture: dict[str, Any]
) -> None:
    normalized = records.normalize_turn_node_identity(fixture["turnNodeIdentityRecord"])
    assert normalized == fixture["turnNodeIdentityRecord"]


# --- Part A carry-forward: closed-map ingestion policy ---------------------
#
# CDDL maps in `kernel-records.cddl` are closed (they enumerate every field
# explicitly, never `{* tstr => kernel-record}`), so per the pinned
# cross-language ingestion policy an unrecognized field must be REJECTED,
# not silently dropped. These fixtures are all valid records from
# `PROTOCOL_FIXTURES` with one extra, unknown field spliced in.


def test_normalize_path_definition_rejects_unknown_field() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_path_definition(
            {"path": "messages", "collection": "ordered", "unexpectedField": True}
        )


def test_normalize_incorporation_rule_rejects_unknown_field() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_incorporation_rule(
            {"objectType": "message", "targetPath": "messages", "extra": 1}
        )


def test_normalize_turn_tree_schema_rejects_unknown_field() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_turn_tree_schema(
            {
                "schemaId": "schema-a",
                "paths": [],
                "incorporationRules": [],
                "unexpectedField": "x",
            }
        )


def test_normalize_staged_result_rejects_unknown_field() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_staged_result(
            {
                "taskId": "task-1",
                "objectHash": "a" * 64,
                "objectType": "tool-result",
                "timestamp": 0,
                "status": "completed",
                "unexpectedField": "x",
            }
        )


def test_normalize_staged_result_rejects_interrupt_payload_on_settled_status() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_staged_result(
            {
                "taskId": "task-1",
                "objectHash": "a" * 64,
                "objectType": "tool-result",
                "timestamp": 0,
                "status": "completed",
                "interruptPayload": {"reason": "should not be here"},
            }
        )


def test_normalize_turn_node_identity_rejects_unknown_field() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_turn_node_identity(
            {
                "schemaId": "schema-a",
                "turnTreeHash": "a" * 64,
                "previousTurnNodeHash": None,
                "eventHash": None,
                "consumedStagedResults": [],
                "unexpectedField": "x",
            }
        )


# --- Part A carry-forward: absent-vs-null policy ----------------------------
#
# `previousTurnNodeHash` / `eventHash` are typed `hash-string / null` in the
# CDDL, so explicit null is legal there. Required non-nullable fields (e.g.
# `schemaId`, `turnTreeHash`) must reject explicit null exactly like any
# other wrong-typed value, since the CDDL type does not include null; a
# *missing* required field is a separate (and separately covered) failure
# mode already exercised by the `turn-node-identity.<field> is required`
# checks below.


def test_normalize_turn_node_identity_allows_explicit_null_for_nullable_fields() -> None:
    normalized = records.normalize_turn_node_identity(
        {
            "schemaId": "schema-a",
            "turnTreeHash": "a" * 64,
            "previousTurnNodeHash": None,
            "eventHash": None,
            "consumedStagedResults": [],
        }
    )
    assert normalized["previousTurnNodeHash"] is None
    assert normalized["eventHash"] is None


def test_normalize_turn_node_identity_rejects_null_for_non_nullable_required_field() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_turn_node_identity(
            {
                "schemaId": None,
                "turnTreeHash": "a" * 64,
                "previousTurnNodeHash": None,
                "eventHash": None,
                "consumedStagedResults": [],
            }
        )


def test_normalize_turn_tree_schema_rejects_null_for_required_schema_id() -> None:
    with pytest.raises(records.RecordValidationError):
        records.normalize_turn_tree_schema(
            {"schemaId": None, "paths": [], "incorporationRules": []}
        )


def test_normalize_path_definition_allows_explicit_null_metadata() -> None:
    # `metadata` is typed `kernel-record`, and `null` is itself a valid
    # `kernel-record` value, so an explicit null metadata is legal (distinct
    # from *absent* metadata, which normalizes with no `metadata` key at
    # all -- see the module docstring's "normalization does not mean filling
    # in defaults" note).
    normalized = records.normalize_path_definition(
        {"path": "messages", "collection": "ordered", "metadata": None}
    )
    assert normalized["metadata"] is None
