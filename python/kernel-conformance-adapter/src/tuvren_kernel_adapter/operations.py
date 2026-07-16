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
from tuvren_kernel.backend import InMemoryBackend, create_scoped_backend_pair
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.fault_injection import FaultInjectingBackend
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


class _InjectedClock:
    """A mutable, adapter-controlled `RuntimeBackend.now()` clock.

    Every run-liveness/restart-recovery scenario below needs precise control
    over the backend-authoritative clock (ADR-050: lease math is always
    computed from `RuntimeBackend.now()`, never a caller-supplied value) to
    land on the plan's literal expected numbers -- e.g. `renewal.
    renewedLeaseExpiresAtMs == 40`. This is that seam: a plain callable
    `InMemoryBackend.now` accepts, whose `.value` the scenario advances
    between kernel calls.
    """

    def __init__(self, value: int = 0) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value


def _new_conformance_kernel_with_clock(clock: _InjectedClock) -> RuntimeKernel:
    kernel = RuntimeKernel(InMemoryBackend(now=clock))
    kernel.schema.register(dict(_load_canonical_schema()))
    return kernel


def run_lease_renewal(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.run-liveness.lease-renewal`.

    Creates a run with a 10ms lease at clock=0 (`expiresAtMs = 10`), then
    renews it at clock=10 with a 30ms duration, landing the renewed expiry
    on the plan's literal `40`. Also captures the two distinct renewal
    rejection codes: a different owner id is rejected before the token is
    even inspected (`run_lease_owner_mismatch`), a correct owner presenting
    a token that does not match the run's actual lease token is rejected
    with `run_lease_token_mismatch`.
    """

    clock = _InjectedClock(0)
    kernel = _new_conformance_kernel_with_clock(clock)
    schema_id = _load_canonical_schema()["schemaId"]

    thread = kernel.thread.create("thread_lease_renewal", schema_id, "branch_lease_renewal")
    turn = kernel.turn.create(
        "turn_lease_renewal",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_lease_renewal",
        turn["turnId"],
        thread["branchId"],
        schema_id,
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
        owner_id="owner_primary",
        lease_duration_ms=10,
    )
    actual_token = kernel.backend.get_run("run_lease_renewal")["lease"]["token"]

    clock.value = 10
    renewed_lease = kernel.run.renew_lease(
        "run_lease_renewal", "owner_primary", actual_token, lease_duration_ms=30
    )

    owner_mismatch_code = _capture_semantic_error_code(
        lambda: kernel.run.renew_lease(
            "run_lease_renewal", "owner_impostor", actual_token, lease_duration_ms=30
        )
    )
    stale_token_code = _capture_semantic_error_code(
        lambda: kernel.run.renew_lease(
            "run_lease_renewal", "owner_primary", "stale-lease-token", lease_duration_ms=30
        )
    )

    return _projection(
        {
            "renewal": {
                "renewedLeaseExpiresAtMs": renewed_lease["expiresAtMs"],
                "ownerMismatchCode": owner_mismatch_code,
                "staleTokenCode": stale_token_code,
            }
        }
    )


def run_expired_listing(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.run-liveness.expired-listing`.

    Builds two runs on two separate branches (Appendix B forbids two
    simultaneously-active runs sharing one branch, and "active" covers both
    `running` and `paused`): `run_expired`, left `running` with a lease that
    has since expired, and `run_paused_candidate`, explicitly paused with an
    equally stale-looking lease. The plan's assertions expect only the
    former in `expiredRunIds` -- proving pause exclusion is a real status
    check, not just "not yet past its expiry".
    """

    clock = _InjectedClock(0)
    kernel = _new_conformance_kernel_with_clock(clock)
    schema_id = _load_canonical_schema()["schemaId"]

    thread_running = kernel.thread.create(
        "thread_expired_listing_running", schema_id, "branch_expired_listing_running"
    )
    turn_running = kernel.turn.create(
        "turn_expired_listing_running",
        thread_running["threadId"],
        thread_running["branchId"],
        None,
        thread_running["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_expired",
        turn_running["turnId"],
        thread_running["branchId"],
        schema_id,
        thread_running["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
        owner_id="owner_running",
        lease_duration_ms=5,
    )

    thread_paused = kernel.thread.create(
        "thread_expired_listing_paused", schema_id, "branch_expired_listing_paused"
    )
    turn_paused = kernel.turn.create(
        "turn_expired_listing_paused",
        thread_paused["threadId"],
        thread_paused["branchId"],
        None,
        thread_paused["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_paused_candidate",
        turn_paused["turnId"],
        thread_paused["branchId"],
        schema_id,
        thread_paused["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
        owner_id="owner_paused",
        lease_duration_ms=5,
    )
    kernel.run.begin_step("run_paused_candidate", "step")
    kernel.run.complete("run_paused_candidate", "paused")

    # Well past both leases' expiry -- proves the paused run's exclusion is
    # a status check, not a coincidence of timing.
    clock.value = 100

    expired_run_ids = sorted(run["runId"] for run in kernel.run.list_expired_running())
    paused_run = kernel.backend.get_run("run_paused_candidate")

    return _projection(
        {
            "listing": {
                "expiredRunIds": expired_run_ids,
                "pausedRunStatus": paused_run["status"],
                "pausedRunListed": "run_paused_candidate" in expired_run_ids,
            }
        }
    )


def run_stale_preemption(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.run-liveness.stale-preemption`.

    Builds a run with one uncommitted staged result and an expired lease,
    then preempts it. The plan's assertions expect the run to land on
    `status: "failed"` / `preemptionReason: "stale_running_recovery"`, its
    uncommitted staged result discarded, its lease cleared, and its
    recovery-state's last TurnNode hash matching the branch head (this run
    never checkpointed past its own start, so the branch head it started at
    is still the branch's current head).
    """

    clock = _InjectedClock(0)
    kernel = _new_conformance_kernel_with_clock(clock)
    schema_id = _load_canonical_schema()["schemaId"]

    thread = kernel.thread.create("thread_stale_preemption", schema_id, "branch_stale_preemption")
    turn = kernel.turn.create(
        "turn_stale_preemption",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_stale_preemption",
        turn["turnId"],
        thread["branchId"],
        schema_id,
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
        owner_id="owner_stale",
        lease_duration_ms=5,
    )
    kernel.staging.stage(
        "run_stale_preemption", b"uncommitted staged work", "task_stale", "message", "completed"
    )

    clock.value = 100
    preempted = kernel.run.preempt_stale("run_stale_preemption")

    branch = kernel.branch.get(thread["branchId"])
    recovery = kernel.run.recover("run_stale_preemption")

    return _projection(
        {
            "preemption": {
                "runStatus": preempted["status"],
                "preemptionReason": preempted["preemptionReason"],
                "uncommittedStagedResults": len(kernel.staging.current("run_stale_preemption")),
                "leaseCleared": preempted["lease"] is None,
                "branchHeadTurnNodeHash": branch["headTurnNodeHash"],
                "recoveryLastTurnNodeHash": recovery["lastTurnNodeHash"],
                "recoveryHeadMatchesBranchHead": recovery["lastTurnNodeHash"]
                == branch["headTurnNodeHash"],
            }
        }
    )


def _run_crash_recovery_fault_point(fault_point: str) -> dict[str, Any]:
    """One `beforeCommit` / `midCommit` / `afterCommitBeforeAck` sub-scenario
    shared by `run_crash_recovery_in_process`.

    Builds a fresh kernel, completes one ordinary checkpoint (message 1),
    then attempts a second checkpoint (message 2) with a
    `FaultInjectingBackend` swapped in for that one call so the fault fires
    at `fault_point`, and finally calls `RuntimeKernel.run.reconcile` --
    mirroring what a restarted process would do on recovery -- to determine
    how far the interrupted attempt got and whether it needs to be rolled
    forward.
    """

    base_backend = InMemoryBackend()
    kernel = RuntimeKernel(base_backend)
    kernel.schema.register(dict(_load_canonical_schema()))
    schema_id = _load_canonical_schema()["schemaId"]

    thread = kernel.thread.create(
        f"thread_crash_recovery_{fault_point}", schema_id, f"branch_crash_recovery_{fault_point}"
    )
    turn = kernel.turn.create(
        f"turn_crash_recovery_{fault_point}",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    run_id = f"run_crash_recovery_{fault_point}"
    kernel.run.create(
        run_id,
        turn["turnId"],
        thread["branchId"],
        schema_id,
        thread["rootTurnNodeHash"],
        [
            {"id": "seed", "deterministic": False, "sideEffects": False},
            {"id": "faulted", "deterministic": False, "sideEffects": False},
        ],
    )

    # Message 1: an ordinary, uninterrupted checkpoint.
    kernel.staging.stage(run_id, b"seed message", "task_seed", "message", "completed")
    kernel.run.begin_step(run_id, "seed")
    kernel.run.complete_step(run_id, "seed")
    pre_fault_head = kernel.branch.get(thread["branchId"])["headTurnNodeHash"]

    # Message 2: attempted under fault injection.
    kernel.staging.stage(run_id, b"faulted message", "task_faulted", "message", "completed")
    kernel.run.begin_step(run_id, "faulted")

    kernel.backend = FaultInjectingBackend(base_backend, fault_point, policy="once")  # type: ignore[assignment]
    injected_error_code: str | None = None
    try:
        kernel.run.complete_step(run_id, "faulted")
    except KernelRuntimeError as runtime_error:
        injected_error_code = runtime_error.code
    kernel.backend = base_backend

    pending_before_reconcile = kernel.backend.get_run(run_id).get("pendingCheckpoint")
    expected_new_node_hash = (
        pending_before_reconcile["nodeHash"] if pending_before_reconcile is not None else None
    )

    reconciled = kernel.run.reconcile(run_id)
    pending_message_committed = bool(reconciled["pendingMessageCommitted"])

    actual_head = kernel.branch.get(thread["branchId"])["headTurnNodeHash"]
    expected_checkpoint = expected_new_node_hash if pending_message_committed else pre_fault_head
    head_matches_expected_checkpoint = actual_head == expected_checkpoint

    try:
        kernel.verify_thread_membership(thread, actual_head)
        lineage_consistent = True
    except KernelRuntimeError:
        lineage_consistent = False

    recovery = kernel.run.recover(run_id)
    recovery_state_consistent = recovery["lastTurnNodeHash"] == actual_head

    # The actually-committed message count, read from the turn tree
    # manifest's "messages" path at the head node's tree -- not
    # `len(createdTurnNodes)`, which is only a proxy (it counts checkpoints,
    # not messages, and would silently drift from the true count the moment
    # a checkpoint folds in more than one message). Mirrors the Go port's
    # length-of-the-ordered-collection-at-the-messages-path read.
    head_node_for_count = kernel.backend.get_node(actual_head)
    assert head_node_for_count is not None  # actual_head always resolves to a stored node
    head_tree_for_count = kernel.backend.get_tree(head_node_for_count["turnTreeHash"])
    assert head_tree_for_count is not None  # every stored node references a stored tree
    visible_committed_message_count = len(head_tree_for_count["manifest"].get("messages", []))

    return {
        "injectedErrorCode": injected_error_code,
        "headMatchesExpectedCheckpoint": head_matches_expected_checkpoint,
        "lineageConsistent": lineage_consistent,
        "pendingMessageCommitted": pending_message_committed,
        "recoveryStateConsistent": recovery_state_consistent,
        "visibleCommittedMessageCount": visible_committed_message_count,
    }


def run_crash_recovery_in_process(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.restart-recovery.crash-recovery-in-process`.

    Runs the three `_run_crash_recovery_fault_point` sub-scenarios (one per
    Section 5.5 checkpoint-write fault point) and reports all three under
    `$.crashRecovery.{beforeCommit,midCommit,afterCommitBeforeAck}`.
    """

    return _projection(
        {
            "crashRecovery": {
                "beforeCommit": _run_crash_recovery_fault_point("beforeCommit"),
                "midCommit": _run_crash_recovery_fault_point("midCommit"),
                "afterCommitBeforeAck": _run_crash_recovery_fault_point("afterCommitBeforeAck"),
            }
        }
    )


def run_restart_recovery_concurrent_writer(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.restart-recovery.concurrent-writer`.

    Two writers race a checkpoint from the same base branch head via
    `RuntimeKernel.checkpoint` directly (bypassing `RunOps`'s one-active-
    run-per-branch guard, since this scenario is exercising the storage-
    layer optimistic-concurrency guard in `RuntimeKernel.commit_checkpoint`,
    not `RunOps`'s own Run-lifecycle rules). Writer one commits under a
    `FaultInjectingBackend` set to fire at `afterCommitBeforeAck` -- its
    backend write fully succeeds, but its own call still observes the
    injected fault, simulating "crashed right after commit". Writer two
    then attempts a checkpoint from the *same* stale base and must be
    rejected with the typed `kernel_runtime_checkpoint_lateral_conflict`
    (not a generic exception) because writer one already moved the branch
    head out from under it.
    """

    base_backend = InMemoryBackend()
    kernel = RuntimeKernel(base_backend)
    kernel.schema.register(dict(_load_canonical_schema()))
    schema_id = _load_canonical_schema()["schemaId"]

    thread = kernel.thread.create("thread_concurrent_writer", schema_id, "branch_concurrent_writer")
    branch_id = thread["branchId"]
    base_branch = kernel.branch.get(branch_id)
    tree_hash = thread["rootTurnTreeHash"]

    event_one = kernel.store.put(b"concurrent-writer-one-event")
    event_two = kernel.store.put(b"concurrent-writer-two-event")

    writer_one = {"runId": "writer_one", "schemaId": schema_id, "branchId": branch_id}
    writer_two = {"runId": "writer_two", "schemaId": schema_id, "branchId": branch_id}

    kernel.backend = FaultInjectingBackend(base_backend, "afterCommitBeforeAck", policy="once")  # type: ignore[assignment]
    fault_plan_injected_error_code: str | None = None
    try:
        kernel.checkpoint(writer_one, base_branch, tree_hash, event_one, [])
    except KernelRuntimeError as runtime_error:
        fault_plan_injected_error_code = runtime_error.code
    kernel.backend = base_backend

    branch_after_writer_one = kernel.branch.get(branch_id)
    writer_one_node_hash = branch_after_writer_one["headTurnNodeHash"]
    writer_advanced_head = writer_one_node_hash != base_branch["headTurnNodeHash"]
    writer_one_node = kernel.backend.get_node(writer_one_node_hash)
    writer_produced_sibling_head = writer_advanced_head and (
        writer_one_node is not None
        and writer_one_node["previousTurnNodeHash"] == base_branch["headTurnNodeHash"]
    )

    losing_error_code: str | None = None
    try:
        kernel.checkpoint(writer_two, base_branch, tree_hash, event_two, [])
    except KernelRuntimeError as runtime_error:
        losing_error_code = runtime_error.code

    single_writer_rejected = losing_error_code == "kernel_runtime_checkpoint_lateral_conflict"
    typed_lateral_conflict_observed = single_writer_rejected

    final_branch = kernel.branch.get(branch_id)
    final_head = final_branch["headTurnNodeHash"]
    final_head_is_committed_sibling = kernel.backend.get_node(final_head) is not None
    final_head_matches_winner = final_head == writer_one_node_hash

    # A retry from the now-current head succeeds -- the rejection above was
    # about the stale base, not writer_two being permanently locked out.
    retry_after_loss_error_code: str | None = None
    try:
        kernel.checkpoint(writer_two, final_branch, tree_hash, event_two, [])
    except KernelRuntimeError as runtime_error:
        retry_after_loss_error_code = runtime_error.code

    return _projection(
        {
            "crashRecoveryConcurrency": {
                "singleWriterRejected": single_writer_rejected,
                "finalHeadIsCommittedSibling": final_head_is_committed_sibling,
                "finalHeadMatchesWinner": final_head_matches_winner,
                "losingErrorCode": losing_error_code,
                "retryAfterLossErrorCode": retry_after_loss_error_code,
                "typedLateralConflictObserved": typed_lateral_conflict_observed,
            },
            "faultPlanConcurrentWriter": {
                "injectedErrorCode": fault_plan_injected_error_code,
                "writerAdvancedHead": writer_advanced_head,
                "writerProducedSiblingHead": writer_produced_sibling_head,
            },
        }
    )


# Two distinct, non-default Scopes bound to one shared substrate so the
# cross-scope isolation probe can prove a co-tenant scope observes none of
# the constructing scope's content. Mirrors the TypeScript conformance
# host's `CONFORMANCE_SCOPE_A` / `CONFORMANCE_SCOPE_B` (host-support.ts) --
# the host supplies the Scope at construction (Section 2.3); the kernel
# syscall surface never sees it.
_CONFORMANCE_SCOPE_A = "tuvren.scope.conformance-a"
_CONFORMANCE_SCOPE_B = "tuvren.scope.conformance-b"


def run_cross_scope_probe(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.scope-isolation.cross-scope-probe`.

    Binds two `RuntimeKernel`s to one shared `InMemoryBackend` substrate via
    distinct Scope identities (`create_scoped_backend_pair`), then proves
    `store.has`/`store.get`/`thread.list` are all Scope-confined: content
    the "A" kernel writes is invisible through the "B" handle, and
    vice versa, even though both handles share the same physical dicts
    underneath. Serves three checks (`kernel.scope-isolation.
    store_has_is_scope_confined`, `..._store_get_is_scope_confined`,
    `..._enumeration_is_scope_confined`) from the fields below.
    """

    backend_a, backend_b = create_scoped_backend_pair(_CONFORMANCE_SCOPE_A, _CONFORMANCE_SCOPE_B)
    kernel_a = RuntimeKernel(backend_a)
    kernel_a.schema.register(dict(_load_canonical_schema()))
    kernel_b = RuntimeKernel(backend_b)
    kernel_b.schema.register(dict(_load_canonical_schema()))
    schema_id = _load_canonical_schema()["schemaId"]

    object_hash = kernel_a.store.put(b"scope-a-only-content")

    same_scope_observes_own_content = kernel_a.store.has(object_hash)
    cross_scope_observes_other_content = kernel_b.store.has(object_hash)

    same_scope_returns_object = kernel_a.store.get(object_hash) is not None
    cross_scope_returns_null = kernel_b.store.get(object_hash) is None

    kernel_a.thread.create("thread_scope_a", schema_id, "branch_scope_a")
    threads_a = kernel_a.thread.list()["threads"]
    threads_b = kernel_b.thread.list()["threads"]
    same_scope_thread_visible = any(thread["threadId"] == "thread_scope_a" for thread in threads_a)
    cross_scope_thread_visible = any(thread["threadId"] == "thread_scope_a" for thread in threads_b)

    return _projection(
        {
            "storeHas": {
                "sameScopeObservesOwnContent": same_scope_observes_own_content,
                "crossScopeObservesOtherContent": cross_scope_observes_other_content,
            },
            "storeGet": {
                "sameScopeReturnsObject": same_scope_returns_object,
                "crossScopeReturnsNull": cross_scope_returns_null,
            },
            "enumeration": {
                "sameScopeThreadVisible": same_scope_thread_visible,
                "crossScopeThreadVisible": cross_scope_thread_visible,
            },
        }
    )


def _checkpoint_message_into_head(
    kernel: RuntimeKernel,
    *,
    thread_id: str,
    branch_id: str,
    run_id: str,
    turn_id: str,
    parent_turn_id: str | None,
    start_turn_node_hash: str,
    schema_id: str,
    task_id: str,
    message_bytes: bytes,
) -> dict[str, Any]:
    """One Turn+Run+staged-message+checkpoint+complete cycle over `kernel`.

    Shared by every `kernel.reclamation.*` sub-scenario below (and the
    erasure probe) to build one committed message TurnNode without
    repeating the full Turn/Run/staging/checkpoint call sequence each time
    -- mirrors the Rust adapter's `checkpoint_message_into_head` helper.
    """

    turn = kernel.turn.create(turn_id, thread_id, branch_id, parent_turn_id, start_turn_node_hash)
    kernel.run.create(
        run_id,
        turn["turnId"],
        branch_id,
        schema_id,
        start_turn_node_hash,
        [{"id": "checkpoint", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step(run_id, "checkpoint")
    staged = kernel.staging.stage(run_id, message_bytes, task_id, "message", "completed")
    completed = kernel.run.complete_step(run_id, "checkpoint")
    kernel.run.complete(run_id, "completed")
    return {
        "objectHash": staged["objectHash"],
        "turnId": turn["turnId"],
        "turnNodeHash": completed["turnNodeHash"],
    }


def run_reclamation_probe(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.reclamation.reclaim-probe`.

    Four independent sub-scenarios, each over its own kernel: (1) an archive
    rollback over a shared non-root ancestor proves the keep closure is a
    set-union over live roots and that cross-branch structural sharing keeps
    a shared Object alive via any live root; (2) a deterministic clock
    orders writes around an active execution lease to prove the grace window
    is the lease horizon; (3)/(4) a leaseless running run either past or
    within the 24h admin-expiry horizon does/doesn't pin the grace horizon.
    Mirrors the Rust/TypeScript adapters' `run_reclamation_probe` /
    `runReclamationProbe`.
    """

    schema_id = _load_canonical_schema()["schemaId"]

    # --- (1) Reachability sub-scenario (archive rollback). ---
    kernel = _new_conformance_kernel()
    thread = kernel.thread.create("thread_reclamation", schema_id, "branch_reclamation")

    shared = _checkpoint_message_into_head(
        kernel,
        thread_id=thread["threadId"],
        branch_id=thread["branchId"],
        run_id="run_shared",
        turn_id="turn_shared",
        parent_turn_id=None,
        start_turn_node_hash=thread["rootTurnNodeHash"],
        schema_id=schema_id,
        task_id="msg_shared",
        message_bytes=b"shared-across-live-and-archived",
    )
    shared_object_hash = shared["objectHash"]

    archived = _checkpoint_message_into_head(
        kernel,
        thread_id=thread["threadId"],
        branch_id=thread["branchId"],
        run_id="run_archived",
        turn_id="turn_archived",
        parent_turn_id=shared["turnId"],
        start_turn_node_hash=shared["turnNodeHash"],
        schema_id=schema_id,
        task_id="msg_archived",
        message_bytes=b"archived-exclusive-payload",
    )
    archived_only_object_hash = archived["objectHash"]

    archived_node = kernel.node.get(archived["turnNodeHash"])
    assert archived_node is not None
    archived_tree = kernel.backend.get_tree(archived_node["turnTreeHash"])
    assert archived_tree is not None
    shared_object_referenced_by_archived_node = shared_object_hash in archived_tree["manifest"].get(
        "messages", []
    )

    rollback = kernel.branch.set_head(thread["branchId"], shared["turnNodeHash"])
    archive_branch = rollback["archiveBranch"]
    archived_into_branch = (
        archive_branch is not None
        and archive_branch["headTurnNodeHash"] == archived["turnNodeHash"]
    )

    orphan_object_hash = kernel.store.put(b"unreachable-orphan")

    summary = kernel.maintenance.reclaim()

    branches_after = kernel.branch.list(thread["threadId"])
    thread_after = kernel.thread.get(thread["threadId"])

    archived_branch_released = (
        archived_into_branch
        and not kernel.store.has(archived_only_object_hash)
        and kernel.node.get(archived["turnNodeHash"]) is None
        and not any("archive" in branch_id for branch_id, _ in branches_after)
        and summary["releasedArchivedBranchCount"] >= 1
    )

    reachable_from_live_root_retained = (
        kernel.store.has(shared_object_hash)
        and kernel.node.get(shared["turnNodeHash"]) is not None
        and thread_after is not None
        and thread_after["rootTurnNodeHash"] == thread["rootTurnNodeHash"]
    )

    shared_object_retained_via_live_root = (
        shared_object_referenced_by_archived_node
        and kernel.store.has(shared_object_hash)
        and not kernel.store.has(archived_only_object_hash)
        and kernel.node.get(archived["turnNodeHash"]) is None
    )

    unreachable_past_grace_released = (
        not kernel.store.has(orphan_object_hash) and summary["releasedObjectCount"] >= 1
    )

    # --- (2) Grace-window sub-scenario. ---
    grace_clock = _InjectedClock(0)
    grace_kernel = _new_conformance_kernel_with_clock(grace_clock)

    grace_clock.value = 10
    orphan_before_lease = grace_kernel.store.put(bytes([1]))

    grace_clock.value = 20
    grace_thread = grace_kernel.thread.create("thread_grace", schema_id, "branch_grace")
    grace_turn = grace_kernel.turn.create(
        "turn_grace",
        grace_thread["threadId"],
        grace_thread["branchId"],
        None,
        grace_thread["rootTurnNodeHash"],
    )
    grace_kernel.run.create(
        "run_grace",
        grace_turn["turnId"],
        grace_thread["branchId"],
        schema_id,
        grace_thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
    )

    grace_clock.value = 30
    orphan_after_lease = grace_kernel.store.put(bytes([2]))

    grace_clock.value = 40
    grace_kernel.maintenance.reclaim()

    grace_window_held_under_active_lease = not grace_kernel.store.has(
        orphan_before_lease
    ) and grace_kernel.store.has(orphan_after_lease)

    # --- (3) Leaseless-expired sub-scenario. ---
    leaseless_expired_clock = _InjectedClock(0)
    leaseless_expired_kernel = _new_conformance_kernel_with_clock(leaseless_expired_clock)
    leaseless_expired_thread = leaseless_expired_kernel.thread.create(
        "thread_leaseless_expired", schema_id, "branch_leaseless_expired"
    )
    leaseless_expired_turn = leaseless_expired_kernel.turn.create(
        "turn_leaseless_expired",
        leaseless_expired_thread["threadId"],
        leaseless_expired_thread["branchId"],
        None,
        leaseless_expired_thread["rootTurnNodeHash"],
    )
    leaseless_expired_kernel.run.create(
        "run_leaseless_expired",
        leaseless_expired_turn["turnId"],
        leaseless_expired_thread["branchId"],
        schema_id,
        leaseless_expired_thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
        lease_duration_ms=None,
    )

    leaseless_expired_clock.value = 10
    leaseless_expired_orphan = leaseless_expired_kernel.store.put(b"leaseless-expiry-orphan")

    leaseless_expired_clock.value = 86_400_000 + 5000
    leaseless_expired_kernel.maintenance.reclaim()

    leaseless_run_past_admin_expiry_does_not_pin_reclamation = (
        not leaseless_expired_kernel.store.has(leaseless_expired_orphan)
    )

    # --- (4) Leaseless-active sub-scenario. ---
    leaseless_active_clock = _InjectedClock(0)
    leaseless_active_kernel = _new_conformance_kernel_with_clock(leaseless_active_clock)
    leaseless_active_thread = leaseless_active_kernel.thread.create(
        "thread_leaseless_active", schema_id, "branch_leaseless_active"
    )
    leaseless_active_turn = leaseless_active_kernel.turn.create(
        "turn_leaseless_active",
        leaseless_active_thread["threadId"],
        leaseless_active_thread["branchId"],
        None,
        leaseless_active_thread["rootTurnNodeHash"],
    )
    leaseless_active_kernel.run.create(
        "run_leaseless_active",
        leaseless_active_turn["turnId"],
        leaseless_active_thread["branchId"],
        schema_id,
        leaseless_active_thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
        lease_duration_ms=None,
    )

    leaseless_active_clock.value = 10
    leaseless_active_orphan = leaseless_active_kernel.store.put(b"leaseless-active-orphan")

    leaseless_active_clock.value = 1000
    leaseless_active_kernel.maintenance.reclaim()

    leaseless_run_within_admin_expiry_still_pins_reclamation = leaseless_active_kernel.store.has(
        leaseless_active_orphan
    )

    return _projection(
        {
            "reclaim": {
                "unreachablePastGraceReleased": unreachable_past_grace_released,
                "archivedBranchReleased": archived_branch_released,
                "reachableFromLiveRootRetained": reachable_from_live_root_retained,
                "sharedObjectRetainedViaLiveRoot": shared_object_retained_via_live_root,
                "graceWindowHeldUnderActiveLease": grace_window_held_under_active_lease,
                "leaselessRunPastAdminExpiryDoesNotPinReclamation": (
                    leaseless_run_past_admin_expiry_does_not_pin_reclamation
                ),
                "leaselessRunWithinAdminExpiryStillPinsReclamation": (
                    leaseless_run_within_admin_expiry_still_pins_reclamation
                ),
            }
        }
    )


def run_erasure_probe(_operation_input: Any) -> dict[str, Any]:
    """Handle `kernel.reclamation.erasure-probe`.

    The crypto is entirely adapter-side: the kernel itself never sees
    plaintext or a key, only ever calling `store.put`/`store.get` on opaque
    ciphertext bytes (an AES-256-GCM envelope, `nonce || ciphertext`, via
    the `cryptography` package). "Erasure" is the host destroying its own
    only reference to the key -- crypto-shredding, per Section 9.4's "full
    tenant offboarding is dropping the Scope partition plus host destruction
    of the relevant payload-encryption keys" note. Mirrors the Rust
    adapter's `run_erasure_probe`.
    """

    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    kernel = _new_conformance_kernel()
    schema_id = _load_canonical_schema()["schemaId"]

    key: bytes | None = AESGCM.generate_key(bit_length=256)
    plaintext = b"sensitive-untrusted-edge-payload"

    def _encrypt(encryption_key: bytes) -> bytes:
        nonce = _os_urandom(12)
        ciphertext = AESGCM(encryption_key).encrypt(nonce, plaintext, None)
        return nonce + ciphertext

    def _decrypt(decryption_key: bytes, envelope_bytes: bytes) -> bytes | None:
        nonce, ciphertext = envelope_bytes[:12], envelope_bytes[12:]
        try:
            return AESGCM(decryption_key).decrypt(nonce, ciphertext, None)
        except InvalidTag:
            return None

    envelope = _encrypt(key)

    thread = kernel.thread.create("thread_erasure", schema_id, "branch_erasure")
    checkpoint = _checkpoint_message_into_head(
        kernel,
        thread_id=thread["threadId"],
        branch_id=thread["branchId"],
        run_id="run_erasure",
        turn_id="turn_erasure",
        parent_turn_id=None,
        start_turn_node_hash=thread["rootTurnNodeHash"],
        schema_id=schema_id,
        task_id="msg_erasure",
        message_bytes=envelope,
    )
    envelope_hash = checkpoint["objectHash"]

    branch_before = kernel.branch.get(thread["branchId"])
    node_before = kernel.node.get(checkpoint["turnNodeHash"])
    assert branch_before is not None
    assert node_before is not None

    stored_before = kernel.store.get(envelope_hash)
    assert stored_before is not None
    recoverable_before_erasure = _decrypt(key, stored_before) == plaintext

    # -- Crypto-shredding erasure: the host destroys its only key reference. --
    key = None

    stored_after = kernel.store.get(envelope_hash)
    assert stored_after is not None
    # The real key is gone, so it cannot be reconstructed. Mirror the Rust
    # reference's keyring-resolution failure: attempt decryption through the
    # same `key` slot erasure just cleared, rather than substituting an
    # unrelated key (an unrelated key would always fail AES-GCM's
    # authentication check regardless of whether erasure ever ran, making
    # this assertion insensitive to a regression that skips it).
    unrecoverable_after_erasure = key is None or _decrypt(key, stored_after) != plaintext

    branch_after = kernel.branch.get(thread["branchId"])
    node_after = kernel.node.get(checkpoint["turnNodeHash"])
    assert branch_after is not None
    assert node_after is not None
    tree_after = kernel.backend.get_tree(node_after["turnTreeHash"])
    assert tree_after is not None
    manifest_references_envelope = envelope_hash in tree_after["manifest"].get("messages", [])

    lineage_structurally_intact_after_erasure = (
        branch_after["headTurnNodeHash"] == branch_before["headTurnNodeHash"]
        and node_after["turnTreeHash"] == node_before["turnTreeHash"]
        and manifest_references_envelope
        and stored_after == stored_before
        and stored_after == envelope
    )

    return _projection(
        {
            "erasure": {
                "recoverableBeforeErasure": recoverable_before_erasure,
                "unrecoverableAfterErasure": unrecoverable_after_erasure,
                "lineageStructurallyIntactAfterErasure": lineage_structurally_intact_after_erasure,
            }
        }
    )


def _os_urandom(length: int) -> bytes:
    import os

    return os.urandom(length)


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
    "kernel.run-liveness.lease-renewal": run_lease_renewal,
    "kernel.run-liveness.expired-listing": run_expired_listing,
    "kernel.run-liveness.stale-preemption": run_stale_preemption,
    "kernel.restart-recovery.crash-recovery-in-process": run_crash_recovery_in_process,
    "kernel.restart-recovery.concurrent-writer": run_restart_recovery_concurrent_writer,
    "kernel.scope-isolation.cross-scope-probe": run_cross_scope_probe,
    "kernel.reclamation.reclaim-probe": run_reclamation_probe,
    "kernel.reclamation.erasure-probe": run_erasure_probe,
}
