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

"""Kernel record shapes from `spec/kernel/cddl/kernel-records.cddl`.

These functions validate a plain JSON-decoded value (dict/list/str/int/
bool/None) against the record's CDDL production and return a normalized
`dict`/`list` tree that is safe to pass straight to `tuvren_kernel.cbor.
encode`. "Normalize" here does *not* mean filling in defaults: CBOR map
field presence is semantically meaningful for every optional field in this
grammar (`? metadata`, `? interruptPayload`), and every
`spec/conformance/kernel/fixtures/kernel-protocol-*.json` fixture that omits
an optional field expects it to stay fully absent from the canonical
encoding, not present-as-null. So normalization only ever copies fields that
were actually present in the source object, in the CDDL's field set, after
validating their required/optional-ness and (for enums and hash-strings)
their literal shape.

The one CDDL shape handled specially is the turn-node *identity* record used
by `kernel.protocol.deterministic-hashing` / `kernel.protocol.schema-
roundtrip`: it is the `turn-node` production from the CDDL with the `hash`
field removed, because that field is the record's own self-identity (the
SHA-256 of this very record) and so cannot be part of its own input.
"""

from __future__ import annotations

import re
from typing import Any

_HASH_STRING_RE = re.compile(r"^[0-9a-f]{64}$")
_COLLECTION_KINDS = {"ordered", "single"}
_SETTLED_STATUSES = {"completed", "failed"}


class RecordValidationError(ValueError):
    """Raised when a JSON value does not match a kernel-record CDDL shape."""


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RecordValidationError(f"{label} must be an object")
    return value


def _require_non_empty_str(value: Any, label: str) -> str:
    if not isinstance(value, str) or value == "":
        raise RecordValidationError(f"{label} must be a non-empty string")
    return value


def _require_hash_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _HASH_STRING_RE.match(value):
        raise RecordValidationError(f"{label} must be a 64-character lowercase hex string")
    return value


def _require_nullable_hash_string(value: Any, label: str) -> str | None:
    if value is None:
        return None
    return _require_hash_string(value, label)


def _require_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RecordValidationError(f"{label} must be an integer")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise RecordValidationError(f"{label} must be an array")
    return value


def _reject_unknown_fields(source: dict[str, Any], known_fields: set[str], label: str) -> None:
    """Reject any field not in `known_fields`.

    The CDDL maps this module validates against (`turn-tree-schema`,
    `path-definition`, `turn-node`, ...) are all *closed* maps: they never
    use the `{* tstr => kernel-record}` "any extra field" shape, they list
    every field explicitly. So per the pinned cross-language ingestion
    policy an unrecognized field is a rejected record, not silently dropped
    data -- this mirrors CDDL's own closed-map semantics rather than the
    permissive "ignore what I don't understand" default many JSON decoders
    use.
    """

    unknown = sorted(set(source) - known_fields)
    if unknown:
        raise RecordValidationError(f"{label} has unknown field(s): {', '.join(unknown)}")


def normalize_path_definition(value: Any) -> dict[str, Any]:
    """Validate and normalize a `path-definition` record."""

    source = _require_dict(value, "path-definition")
    _reject_unknown_fields(source, {"path", "collection", "metadata"}, "path-definition")
    collection = source.get("collection")
    if collection not in _COLLECTION_KINDS:
        raise RecordValidationError(
            f"path-definition.collection must be one of {sorted(_COLLECTION_KINDS)}"
        )

    result: dict[str, Any] = {
        "path": _require_non_empty_str(source.get("path"), "path-definition.path"),
        "collection": collection,
    }
    if "metadata" in source:
        result["metadata"] = source["metadata"]
    return result


def normalize_incorporation_rule(value: Any) -> dict[str, Any]:
    """Validate and normalize an `incorporation-rule` record."""

    source = _require_dict(value, "incorporation-rule")
    _reject_unknown_fields(source, {"objectType", "targetPath"}, "incorporation-rule")
    return {
        "objectType": _require_non_empty_str(
            source.get("objectType"), "incorporation-rule.objectType"
        ),
        "targetPath": _require_non_empty_str(
            source.get("targetPath"), "incorporation-rule.targetPath"
        ),
    }


def normalize_turn_tree_schema(value: Any) -> dict[str, Any]:
    """Validate and normalize a `turn-tree-schema` record."""

    source = _require_dict(value, "turn-tree-schema")
    _reject_unknown_fields(source, {"schemaId", "paths", "incorporationRules"}, "turn-tree-schema")
    paths = _require_list(source.get("paths"), "turn-tree-schema.paths")
    incorporation_rules = _require_list(
        source.get("incorporationRules"), "turn-tree-schema.incorporationRules"
    )
    return {
        "schemaId": _require_non_empty_str(source.get("schemaId"), "turn-tree-schema.schemaId"),
        "paths": [normalize_path_definition(item) for item in paths],
        "incorporationRules": [normalize_incorporation_rule(item) for item in incorporation_rules],
    }


def normalize_staged_result(value: Any) -> dict[str, Any]:
    """Validate and normalize an `interrupted-staged-result` /
    `settled-staged-result` record (the `staged-result` CDDL choice)."""

    source = _require_dict(value, "staged-result")
    _reject_unknown_fields(
        source,
        {"taskId", "objectHash", "objectType", "timestamp", "status", "interruptPayload"},
        "staged-result",
    )
    status = source.get("status")
    result: dict[str, Any] = {
        "taskId": _require_non_empty_str(source.get("taskId"), "staged-result.taskId"),
        "objectHash": _require_hash_string(source.get("objectHash"), "staged-result.objectHash"),
        "objectType": _require_non_empty_str(source.get("objectType"), "staged-result.objectType"),
        "timestamp": _require_int(source.get("timestamp"), "staged-result.timestamp"),
    }

    if status == "interrupted":
        if "interruptPayload" not in source:
            raise RecordValidationError("interrupted-staged-result.interruptPayload is required")
        result["status"] = "interrupted"
        result["interruptPayload"] = source["interruptPayload"]
        return result

    if status in _SETTLED_STATUSES:
        if "interruptPayload" in source:
            raise RecordValidationError(
                "settled-staged-result must not have an interruptPayload field"
            )
        result["status"] = status
        return result

    raise RecordValidationError(
        "staged-result.status must be one of 'interrupted', 'completed', 'failed'"
    )


def normalize_turn_node_identity(value: Any) -> dict[str, Any]:
    """Validate and normalize a turn-node *identity* record.

    This is the `turn-node` CDDL production from `kernel-records.cddl` minus
    its `hash` field: the identity record is exactly what gets canonically
    encoded and SHA-256'd *to produce* `turn-node.hash`, so the field being
    computed cannot appear in its own input.
    """

    source = _require_dict(value, "turn-node-identity")
    _reject_unknown_fields(
        source,
        {
            "schemaId",
            "turnTreeHash",
            "previousTurnNodeHash",
            "eventHash",
            "consumedStagedResults",
        },
        "turn-node-identity",
    )
    for required_field in (
        "schemaId",
        "turnTreeHash",
        "previousTurnNodeHash",
        "eventHash",
        "consumedStagedResults",
    ):
        if required_field not in source:
            raise RecordValidationError(f"turn-node-identity.{required_field} is required")

    consumed = _require_list(
        source.get("consumedStagedResults"), "turn-node-identity.consumedStagedResults"
    )
    return {
        "schemaId": _require_non_empty_str(source.get("schemaId"), "turn-node-identity.schemaId"),
        "turnTreeHash": _require_hash_string(
            source.get("turnTreeHash"), "turn-node-identity.turnTreeHash"
        ),
        "previousTurnNodeHash": _require_nullable_hash_string(
            source.get("previousTurnNodeHash"), "turn-node-identity.previousTurnNodeHash"
        ),
        "eventHash": _require_nullable_hash_string(
            source.get("eventHash"), "turn-node-identity.eventHash"
        ),
        "consumedStagedResults": [normalize_staged_result(item) for item in consumed],
    }
