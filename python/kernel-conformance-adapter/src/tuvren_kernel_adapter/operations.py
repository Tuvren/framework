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

import json
from pathlib import Path
from typing import Any

from tuvren_kernel import identity, records
from tuvren_kernel.backend import InMemoryBackend
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.runtime import RuntimeKernel
from tuvren_kernel.verdict import compose_verdicts

# `python/kernel-conformance-adapter/src/tuvren_kernel_adapter/operations.py`
# -> parents[4] is the repository root, mirroring the fixture-path derivation
# `python/kernel/tests/test_kernel_records.py` already uses for the sibling
# `spec/conformance/kernel/fixtures/` tree.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_CANONICAL_SCHEMA_PATH = (
    _REPO_ROOT / "spec" / "conformance" / "kernel" / "fixtures" / "canonical-turn-tree-schema.json"
)

_canonical_schema_cache: dict[str, Any] | None = None

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


def _load_canonical_schema() -> dict[str, Any]:
    """Load & cache `spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json`.

    This is the one schema every `kernel.logical.*` / `kernel.lineage.*` /
    `kernel.protocol.edge-validation` scenario below registers, matching
    `loadCanonicalSchema` in the TypeScript adapter's `host-support.ts` and
    the Rust adapter's equivalent -- the schema itself is authority (shared
    across every conformance adapter), not an adapter-invented fixture.
    """

    global _canonical_schema_cache
    if _canonical_schema_cache is None:
        raw = json.loads(_CANONICAL_SCHEMA_PATH.read_text())
        try:
            _canonical_schema_cache = records.normalize_turn_tree_schema(raw)
        except records.RecordValidationError as validation_error:
            raise OperationInputError(
                "invalid_object_fixture", f"canonical schema is invalid: {validation_error}"
            ) from validation_error
    return _canonical_schema_cache


def _new_conformance_kernel() -> RuntimeKernel:
    """A fresh in-memory kernel with the canonical schema registered.

    Every M2 operation below builds its scenario from a clean kernel, the
    same isolation `withConformanceKernel` gives each TypeScript adapter
    call -- one dispatch, one kernel, no state leaking between operations.
    """

    kernel = RuntimeKernel(InMemoryBackend())
    kernel.schema.register(dict(_load_canonical_schema()))
    return kernel


def _read_logical_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    branch_head_list_entry = fixture.get("branchHeadListEntry")
    if not isinstance(branch_head_list_entry, list) or len(branch_head_list_entry) != 2:
        raise OperationInputError(
            "invalid_array_fixture", "branchHeadListEntry must contain exactly two items"
        )
    recovery_state = fixture.get("recoveryState")
    if not isinstance(recovery_state, dict):
        raise OperationInputError("invalid_object_fixture", "recoveryState must be an object")
    turn_tree_change_set = fixture.get("turnTreeChangeSet")
    if not isinstance(turn_tree_change_set, dict):
        raise OperationInputError("invalid_object_fixture", "turnTreeChangeSet must be an object")
    return {
        "branchHeadListEntry": branch_head_list_entry,
        "recoveryState": recovery_state,
        "turnTreeChangeSet": turn_tree_change_set,
    }


def _stage_fixture_result(
    kernel: RuntimeKernel, run_id: str, staged_result: dict[str, Any], index: int
) -> None:
    """Stage a fixture-described `staged-result`, mirroring `stageFixtureResult`
    in the TypeScript adapter's `host-support.ts`: the fixture's own
    `objectHash` is not replayed as storage content (this milestone's
    conformance checks never assert on the staged object's bytes or hash,
    only on staged-result *counts*), so the blob is a small adapter-local
    placeholder distinct per index.
    """

    interrupt_payload = (
        staged_result.get("interruptPayload")
        if staged_result.get("status") == "interrupted"
        else None
    )
    kernel.staging.stage(
        run_id,
        f"fixture staged result {index}".encode(),
        staged_result["taskId"],
        staged_result["objectType"],
        staged_result["status"],
        interrupt_payload,
    )


def _capture_semantic_error_code(execute: Any) -> str:
    try:
        execute()
        return "unexpected_success"
    except KernelRuntimeError as runtime_error:
        return runtime_error.code


def run_logical_diff(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.logical.diff-paths`.

    Builds a thread over the canonical schema, applies the fixture's
    `turnTreeChangeSet` on top of the thread's empty root tree, and diffs
    the two trees. The associated conformance check's assertion expects
    `$.diffPaths == ["context.manifest", "messages"]`.
    """

    fixture = _read_logical_fixture(_read_fixture(operation_input))
    kernel = _new_conformance_kernel()
    schema_id = _load_canonical_schema()["schemaId"]
    created = kernel.thread.create(
        "thread_conformance", schema_id, fixture["branchHeadListEntry"][0]
    )
    changed_tree = kernel.tree.create(
        schema_id, fixture["turnTreeChangeSet"], created["rootTurnTreeHash"]
    )
    diff_paths = sorted(kernel.tree.diff(created["rootTurnTreeHash"], changed_tree))
    return _projection({"diffPaths": diff_paths})


def run_branch_list(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.logical.branch-list`.

    The associated conformance check compares `$.branchEntries.0.0` against
    `$.fixture.branchHeadListEntry.0`.
    """

    fixture = _read_logical_fixture(_read_fixture(operation_input))
    kernel = _new_conformance_kernel()
    schema_id = _load_canonical_schema()["schemaId"]
    kernel.thread.create("thread_conformance", schema_id, fixture["branchHeadListEntry"][0])
    branch_entries = kernel.branch.list("thread_conformance")
    return _projection({"branchEntries": branch_entries})


def run_recovery_state(operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.logical.recovery-state`.

    Builds a run over the fixture's two-step `stepSequence`, staging the
    fixture's `consumedStagedResults` before the second step's checkpoint
    and its `uncommittedStagedResults` after. The associated conformance
    check's assertions expect `$.recovery.lastCompletedStepId ==
    "tool_execution"`, `$.recovery.consumedStagedResults == 1`, and
    `$.recovery.uncommittedStagedResults == 1` (counts, not arrays).
    """

    fixture = _read_logical_fixture(_read_fixture(operation_input))
    recovery_state = fixture["recoveryState"]
    step_sequence = recovery_state.get("stepSequence")
    if not isinstance(step_sequence, list) or len(step_sequence) < 2:
        raise OperationInputError(
            "invalid_array_fixture", "recoveryState.stepSequence must declare at least two steps"
        )

    kernel = _new_conformance_kernel()
    schema_id = _load_canonical_schema()["schemaId"]
    thread = kernel.thread.create(
        "thread_conformance", schema_id, fixture["branchHeadListEntry"][0]
    )
    turn = kernel.turn.create(
        "turn_recovery", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_recovery",
        turn["turnId"],
        thread["branchId"],
        schema_id,
        thread["rootTurnNodeHash"],
        step_sequence,
    )

    first_step, second_step = step_sequence[0], step_sequence[1]
    kernel.run.begin_step("run_recovery", first_step["id"])
    kernel.run.complete_step("run_recovery", first_step["id"])
    kernel.run.begin_step("run_recovery", second_step["id"])

    consumed = recovery_state.get("consumedStagedResults")
    if not isinstance(consumed, list):
        raise OperationInputError(
            "invalid_array_fixture", "recoveryState.consumedStagedResults must be an array"
        )
    for index, staged_result in enumerate(consumed):
        _stage_fixture_result(kernel, "run_recovery", staged_result, index)

    kernel.run.complete_step("run_recovery", second_step["id"])

    uncommitted = recovery_state.get("uncommittedStagedResults")
    if not isinstance(uncommitted, list):
        raise OperationInputError(
            "invalid_array_fixture", "recoveryState.uncommittedStagedResults must be an array"
        )
    for index, staged_result in enumerate(uncommitted):
        _stage_fixture_result(kernel, "run_recovery", staged_result, index)

    recovery = kernel.run.recover("run_recovery")
    return _projection(
        {
            "recovery": {
                "lastCompletedStepId": recovery["lastCompletedStepId"],
                "consumedStagedResults": len(recovery["consumedStagedResults"]),
                "uncommittedStagedResults": len(recovery["uncommittedStagedResults"]),
            }
        }
    )


def run_thread_list(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.logical.thread-list` (capability
    `kernel-protocol.thread.enumeration`).

    The associated conformance check's assertions expect
    `$.threadEnumeration == {count: 2, firstThreadId: "thread_enum_a",
    pagedCount: 1, hasCursor: true}`.
    """

    kernel = _new_conformance_kernel()
    schema_id = _load_canonical_schema()["schemaId"]
    kernel.thread.create("thread_enum_a", schema_id, "branch_enum_a")
    kernel.thread.create("thread_enum_b", schema_id, "branch_enum_b")

    all_threads = kernel.thread.list()
    paged = kernel.thread.list(limit=1)

    return _projection(
        {
            "threadEnumeration": {
                "count": len(all_threads["threads"]),
                "firstThreadId": (
                    all_threads["threads"][0]["threadId"] if all_threads["threads"] else None
                ),
                "pagedCount": len(paged["threads"]),
                "hasCursor": "nextCursor" in paged,
            }
        }
    )


def run_cross_thread_lineage(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.lineage.cross-thread-rejection`.

    The associated conformance check's assertion expects `$.errorCode ==
    "turn_node_thread_mismatch"`.
    """

    kernel = _new_conformance_kernel()
    schema_id = _load_canonical_schema()["schemaId"]
    thread_a = kernel.thread.create("thread_a", schema_id, "branch_a")
    turn_a = kernel.turn.create(
        "turn_a", thread_a["threadId"], thread_a["branchId"], None, thread_a["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_a",
        turn_a["turnId"],
        thread_a["branchId"],
        schema_id,
        thread_a["rootTurnNodeHash"],
        [{"id": "step_a", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_a", "step_a")
    completed = kernel.run.complete_step("run_a", "step_a")

    kernel.thread.create("thread_b", schema_id, "branch_b")

    try:
        kernel.branch.create("branch_cross_thread", "thread_b", completed["turnNodeHash"])
    except KernelRuntimeError as runtime_error:
        return _projection({"errorCode": runtime_error.code})

    # Unexpected acceptance is surfaced as evidence instead of raising, so
    # the shared runner reports one clean semantic failure (per the adapter
    # hard rule: never map adapter/protocol failures into $.result.error).
    return _projection(
        {
            "errorCode": "unexpected_success",
            "diagnostics": ["thread A node unexpectedly seeded thread B branch"],
        }
    )


def run_protocol_edge_validation(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.protocol.edge-validation`.

    Runs the seven Appendix-B edge probes the extended conformance plan
    asserts against, each via `_capture_semantic_error_code`. Mirrors
    `runProtocolEdgeValidation` in the TypeScript adapter's `host.ts`
    (the only other port implementing this operation today).
    """

    kernel = _new_conformance_kernel()
    schema = _load_canonical_schema()
    schema_id = schema["schemaId"]
    first_path = schema["paths"][0]

    duplicate_path_code = _capture_semantic_error_code(
        lambda: kernel.schema.register(
            {
                **schema,
                "schemaId": "schema_edge_duplicate_path",
                "paths": [*schema["paths"], dict(first_path)],
            }
        )
    )

    missing_required_path_code = _capture_semantic_error_code(
        lambda: kernel.tree.create(schema_id, {"messages": []})
    )

    alternate_schema_id = "schema_edge_alternate"
    kernel.schema.register({**schema, "schemaId": alternate_schema_id})
    canonical_tree = kernel.tree.create(schema_id, {"context.manifest": None, "messages": []})
    alternate_tree = kernel.tree.create(
        alternate_schema_id, {"context.manifest": None, "messages": []}
    )
    schema_mismatch_code = _capture_semantic_error_code(
        lambda: kernel.tree.diff(canonical_tree, alternate_tree)
    )

    busy_thread = kernel.thread.create(
        "thread_edge_busy_branch", schema_id, "branch_edge_busy_branch"
    )
    busy_turn = kernel.turn.create(
        "turn_edge_busy_branch",
        busy_thread["threadId"],
        busy_thread["branchId"],
        None,
        busy_thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_edge_busy_branch_active",
        busy_turn["turnId"],
        busy_thread["branchId"],
        schema_id,
        busy_thread["rootTurnNodeHash"],
        [{"id": "first", "deterministic": False, "sideEffects": False}],
    )
    busy_branch_code = _capture_semantic_error_code(
        lambda: kernel.run.create(
            "run_edge_busy_branch_rejected",
            busy_turn["turnId"],
            busy_thread["branchId"],
            schema_id,
            busy_thread["rootTurnNodeHash"],
            [{"id": "next", "deterministic": False, "sideEffects": False}],
        )
    )

    ordered_thread = kernel.thread.create(
        "thread_edge_step_order", schema_id, "branch_edge_step_order"
    )
    ordered_turn = kernel.turn.create(
        "turn_edge_step_order",
        ordered_thread["threadId"],
        ordered_thread["branchId"],
        None,
        ordered_thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_edge_step_order",
        ordered_turn["turnId"],
        ordered_thread["branchId"],
        schema_id,
        ordered_thread["rootTurnNodeHash"],
        [
            {"id": "first", "deterministic": False, "sideEffects": False},
            {"id": "second", "deterministic": False, "sideEffects": False},
        ],
    )
    out_of_order_step_code = _capture_semantic_error_code(
        lambda: kernel.run.begin_step("run_edge_step_order", "second")
    )

    missing_event_thread = kernel.thread.create(
        "thread_edge_missing_event", schema_id, "branch_edge_missing_event"
    )
    missing_event_turn = kernel.turn.create(
        "turn_edge_missing_event",
        missing_event_thread["threadId"],
        missing_event_thread["branchId"],
        None,
        missing_event_thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_edge_missing_event",
        missing_event_turn["turnId"],
        missing_event_thread["branchId"],
        schema_id,
        missing_event_thread["rootTurnNodeHash"],
        [{"id": "event_step", "deterministic": False, "sideEffects": False}],
    )
    missing_event_object_code = _capture_semantic_error_code(
        lambda: kernel.run.complete_step("run_edge_missing_event", "event_step", "a" * 64)
    )

    lateral_thread = kernel.thread.create(
        "thread_edge_lateral", schema_id, "branch_edge_lateral_main"
    )
    bootstrap_turn = kernel.turn.create(
        "turn_edge_lateral_bootstrap",
        lateral_thread["threadId"],
        lateral_thread["branchId"],
        None,
        lateral_thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_edge_lateral_bootstrap",
        bootstrap_turn["turnId"],
        lateral_thread["branchId"],
        schema_id,
        lateral_thread["rootTurnNodeHash"],
        [{"id": "bootstrap", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_edge_lateral_bootstrap", "bootstrap")
    bootstrap_checkpoint = kernel.run.complete_step("run_edge_lateral_bootstrap", "bootstrap")
    kernel.run.complete("run_edge_lateral_bootstrap", "completed")

    main_turn = kernel.turn.create(
        "turn_edge_lateral_main",
        lateral_thread["threadId"],
        lateral_thread["branchId"],
        bootstrap_turn["turnId"],
        bootstrap_checkpoint["turnNodeHash"],
    )
    kernel.run.create(
        "run_edge_lateral_main",
        main_turn["turnId"],
        lateral_thread["branchId"],
        schema_id,
        bootstrap_checkpoint["turnNodeHash"],
        [{"id": "main", "deterministic": False, "sideEffects": False}],
    )
    main_event_hash = kernel.store.put(b"lateral-main")
    kernel.run.begin_step("run_edge_lateral_main", "main")
    main_checkpoint = kernel.run.complete_step("run_edge_lateral_main", "main", main_event_hash)
    kernel.run.complete("run_edge_lateral_main", "completed")

    fork_branch = kernel.branch.create(
        "branch_edge_lateral_fork", lateral_thread["threadId"], bootstrap_checkpoint["turnNodeHash"]
    )
    fork_turn = kernel.turn.create(
        "turn_edge_lateral_fork",
        lateral_thread["threadId"],
        fork_branch["branchId"],
        bootstrap_turn["turnId"],
        bootstrap_checkpoint["turnNodeHash"],
    )
    kernel.run.create(
        "run_edge_lateral_fork",
        fork_turn["turnId"],
        fork_branch["branchId"],
        schema_id,
        bootstrap_checkpoint["turnNodeHash"],
        [{"id": "fork", "deterministic": False, "sideEffects": False}],
    )
    fork_event_hash = kernel.store.put(b"lateral-fork")
    kernel.run.begin_step("run_edge_lateral_fork", "fork")
    fork_checkpoint = kernel.run.complete_step("run_edge_lateral_fork", "fork", fork_event_hash)
    kernel.run.complete("run_edge_lateral_fork", "completed")

    lateral_head_code = _capture_semantic_error_code(
        lambda: kernel.branch.set_head(lateral_thread["branchId"], fork_checkpoint["turnNodeHash"])
    )

    del main_checkpoint  # only its side effects (branch head advance) matter here

    return _projection(
        {
            "protocolEdgeValidation": {
                "schema": {"duplicatePathCode": duplicate_path_code},
                "tree": {
                    "missingRequiredPathCode": missing_required_path_code,
                    "schemaMismatchCode": schema_mismatch_code,
                },
                "run": {
                    "busyBranchCode": busy_branch_code,
                    "outOfOrderStepCode": out_of_order_step_code,
                    "missingEventObjectCode": missing_event_object_code,
                },
                "branch": {"lateralHeadCode": lateral_head_code},
            }
        }
    )


OPERATIONS: dict[str, Any] = {
    "kernel.protocol.deterministic-hashing": run_deterministic_hashing,
    "kernel.protocol.schema-roundtrip": run_schema_roundtrip,
    "kernel.protocol.modify-composition": run_modify_composition,
    "kernel.protocol.edge-validation": run_protocol_edge_validation,
    "kernel.logical.diff-paths": run_logical_diff,
    "kernel.logical.branch-list": run_branch_list,
    "kernel.logical.recovery-state": run_recovery_state,
    "kernel.logical.thread-list": run_thread_list,
    "kernel.lineage.cross-thread-rejection": run_cross_thread_lineage,
}
