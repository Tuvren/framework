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

"""`kernel.logical.*` / `kernel.lineage.*` / `kernel.protocol.edge-validation`
operation handlers: tree diffing, branch/thread enumeration, run recovery
state, cross-thread lineage rejection, and the Appendix-B protocol edge
probes.

See `tuvren_kernel_adapter.operations` for the shared adapter-input helpers,
the `AdapterObservation` envelope shape, and the routing table these
handlers are registered under.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.runtime import RuntimeKernel

from tuvren_kernel_adapter.operations_common import (
    OperationInputError,
    _capture_semantic_error_code,
    _load_canonical_schema,
    _new_conformance_kernel,
    _projection,
    _read_fixture,
)


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
