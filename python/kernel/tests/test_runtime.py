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

"""Milestone M2 coverage for `tuvren_kernel.runtime.RuntimeKernel`.

Every scenario here mirrors the exact scenario the shared conformance
adapters (TypeScript's `host.ts`, Rust's `main.rs`) build for the
`kernel.logical.*`, `kernel.lineage.*`, and `kernel.protocol.edge-
validation` checks this milestone promotes -- see
`spec/conformance/kernel/plans/kernel-protocol-core.json` and
`kernel-protocol-extended.json` for the normative assertions -- plus direct
unit coverage of every other M2 success/error path
(`docs/KrakenKernelSpecification.md` Appendix B).
"""

from __future__ import annotations

from typing import Any

import pytest

from tuvren_kernel.backend import InMemoryBackend
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.runtime import RuntimeKernel

CANONICAL_SCHEMA: dict[str, Any] = {
    "schemaId": "schema_main",
    "paths": [
        {"path": "messages", "collection": "ordered"},
        {"path": "context.manifest", "collection": "single"},
    ],
    "incorporationRules": [
        {"objectType": "message", "targetPath": "messages"},
        {"objectType": "context_manifest", "targetPath": "context.manifest"},
    ],
}


def new_kernel(now: Any = None) -> RuntimeKernel:
    backend = InMemoryBackend(now=now) if now is not None else InMemoryBackend()
    kernel = RuntimeKernel(backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))
    return kernel


def error_code(callable_: Any) -> str:
    try:
        callable_()
    except KernelRuntimeError as error:
        return error.code
    return "unexpected_success"


# --- Schema registry ---------------------------------------------------------


def test_schema_register_rejects_duplicate_path() -> None:
    kernel = new_kernel()
    first_path = CANONICAL_SCHEMA["paths"][0]
    code = error_code(
        lambda: kernel.schema.register(
            {
                **CANONICAL_SCHEMA,
                "schemaId": "schema_edge_duplicate_path",
                "paths": [*CANONICAL_SCHEMA["paths"], dict(first_path)],
            }
        )
    )
    assert code == "duplicate_schema_path"


def test_schema_register_rejects_duplicate_schema_id() -> None:
    kernel = new_kernel()
    assert error_code(lambda: kernel.schema.register(dict(CANONICAL_SCHEMA))) == (
        "kernel_runtime_duplicate_schema"
    )


def test_schema_register_rejects_unknown_incorporation_target_path() -> None:
    kernel = new_kernel()
    code = error_code(
        lambda: kernel.schema.register(
            {
                "schemaId": "schema_bad_target",
                "paths": [{"path": "messages", "collection": "ordered"}],
                "incorporationRules": [{"objectType": "message", "targetPath": "does.not.exist"}],
            }
        )
    )
    assert code == "kernel_runtime_unknown_tree_path"


def test_schema_get_returns_registered_schema() -> None:
    kernel = new_kernel()
    assert kernel.schema.get("schema_main")["schemaId"] == "schema_main"
    assert kernel.schema.get("schema_unknown") is None


# --- TurnTree ----------------------------------------------------------------


def test_tree_create_without_base_requires_every_schema_path() -> None:
    kernel = new_kernel()
    code = error_code(lambda: kernel.tree.create("schema_main", {"messages": []}))
    assert code == "kernel_runtime_missing_required_tree_path"


def test_tree_create_rejects_unknown_schema() -> None:
    kernel = new_kernel()
    code = error_code(
        lambda: kernel.tree.create("schema_unknown", {"messages": [], "context.manifest": None})
    )
    assert code == "kernel_runtime_missing_schema"


def test_tree_create_rejects_unknown_path() -> None:
    kernel = new_kernel()
    code = error_code(
        lambda: kernel.tree.create(
            "schema_main", {"messages": [], "context.manifest": None, "bogus": []}
        )
    )
    assert code == "kernel_runtime_unknown_tree_path"


def test_tree_create_rejects_invalid_path_value_shape() -> None:
    kernel = new_kernel()
    code = error_code(
        lambda: kernel.tree.create(
            "schema_main", {"messages": "not-a-list", "context.manifest": None}
        )
    )
    assert code == "kernel_runtime_invalid_tree_path_value"


def test_tree_create_with_base_inherits_unchanged_paths() -> None:
    kernel = new_kernel()
    base = kernel.tree.create("schema_main", {"messages": [], "context.manifest": None})
    changed = kernel.tree.create("schema_main", {"messages": ["a" * 64]}, base)
    assert kernel.tree.diff(base, changed) == ["messages"]


def test_tree_create_with_missing_base_is_rejected() -> None:
    kernel = new_kernel()
    code = error_code(lambda: kernel.tree.create("schema_main", {}, "f" * 64))
    assert code == "kernel_runtime_missing_turn_tree"


def test_tree_create_with_base_of_different_schema_is_rejected() -> None:
    kernel = new_kernel()
    kernel.schema.register({**CANONICAL_SCHEMA, "schemaId": "schema_alt"})
    base = kernel.tree.create("schema_alt", {"messages": [], "context.manifest": None})
    code = error_code(lambda: kernel.tree.create("schema_main", {}, base))
    assert code == "kernel_runtime_tree_schema_mismatch"


def test_tree_diff_matches_diff_paths_conformance_scenario() -> None:
    # Mirrors `kernel.logical.diff_paths`: $.diffPaths == ["context.manifest", "messages"].
    kernel = new_kernel()
    created = kernel.thread.create("thread_conformance", "schema_main", "branch_main")
    changed = kernel.tree.create(
        "schema_main",
        {
            "context.manifest": "1" * 64,
            "messages": ["2" * 64, "23" * 32],
        },
        created["rootTurnTreeHash"],
    )
    assert kernel.tree.diff(created["rootTurnTreeHash"], changed) == [
        "context.manifest",
        "messages",
    ]


def test_tree_diff_rejects_missing_tree() -> None:
    kernel = new_kernel()
    tree = kernel.tree.create("schema_main", {"messages": [], "context.manifest": None})
    assert (
        error_code(lambda: kernel.tree.diff(tree, "f" * 64)) == "kernel_runtime_missing_turn_tree"
    )


def test_tree_diff_rejects_schema_mismatch() -> None:
    kernel = new_kernel()
    kernel.schema.register({**CANONICAL_SCHEMA, "schemaId": "schema_edge_alternate"})
    canonical_tree = kernel.tree.create("schema_main", {"context.manifest": None, "messages": []})
    alternate_tree = kernel.tree.create(
        "schema_edge_alternate", {"context.manifest": None, "messages": []}
    )
    code = error_code(lambda: kernel.tree.diff(canonical_tree, alternate_tree))
    assert code == "kernel_runtime_tree_schema_mismatch_diff"


def test_tree_incorporate_rejects_unmatched_object_type() -> None:
    kernel = new_kernel()
    base = kernel.tree.create("schema_main", {"messages": [], "context.manifest": None})
    staged = [{"objectHash": "a" * 64, "objectType": "unmapped_type"}]
    assert error_code(lambda: kernel.tree.incorporate(base, staged)) == (
        "kernel_runtime_unmatched_incorporation_rule"
    )


# --- Thread / Branch -----------------------------------------------------------


def test_thread_create_bootstraps_root_node_and_main_branch() -> None:
    kernel = new_kernel()
    created = kernel.thread.create("thread_a", "schema_main", "branch_a")
    thread = kernel.thread.get("thread_a")
    branch = kernel.branch.get("branch_a")
    assert thread["rootTurnNodeHash"] == created["rootTurnNodeHash"]
    assert branch["headTurnNodeHash"] == created["rootTurnNodeHash"]


def test_thread_create_rejects_duplicate_thread_id() -> None:
    kernel = new_kernel()
    kernel.thread.create("thread_a", "schema_main", "branch_a")
    assert error_code(lambda: kernel.thread.create("thread_a", "schema_main", "branch_b")) == (
        "kernel_runtime_thread_exists"
    )


def test_thread_create_rejects_duplicate_branch_id() -> None:
    kernel = new_kernel()
    kernel.thread.create("thread_a", "schema_main", "branch_shared")
    assert error_code(lambda: kernel.thread.create("thread_b", "schema_main", "branch_shared")) == (
        "kernel_runtime_branch_exists"
    )


def test_two_threads_with_same_schema_have_distinct_root_nodes() -> None:
    # Section 3.3's bootstrap-event exception: without it, two threads with
    # an identical empty root tree would collapse to the same genesis
    # TurnNode hash and defeat cross-thread lineage proofs.
    kernel = new_kernel()
    thread_a = kernel.thread.create("thread_a", "schema_main", "branch_a")
    thread_b = kernel.thread.create("thread_b", "schema_main", "branch_b")
    assert thread_a["rootTurnNodeHash"] != thread_b["rootTurnNodeHash"]


def test_branch_list_matches_branch_list_conformance_scenario() -> None:
    # Mirrors `kernel.logical.branch_list`: $.branchEntries.0.0 == "branch_main".
    kernel = new_kernel()
    kernel.thread.create("thread_conformance", "schema_main", "branch_main")
    entries = kernel.branch.list("thread_conformance")
    assert entries[0][0] == "branch_main"


def test_branch_list_rejects_unknown_thread() -> None:
    kernel = new_kernel()
    assert (
        error_code(lambda: kernel.branch.list("thread_unknown")) == "kernel_runtime_missing_thread"
    )


def test_branch_create_rejects_cross_thread_seed() -> None:
    # Mirrors `kernel.lineage.cross_thread_rejection`: $.errorCode == "turn_node_thread_mismatch".
    kernel = new_kernel()
    thread_a = kernel.thread.create("thread_a", "schema_main", "branch_a")
    turn_a = kernel.turn.create(
        "turn_a", thread_a["threadId"], thread_a["branchId"], None, thread_a["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_a",
        turn_a["turnId"],
        thread_a["branchId"],
        "schema_main",
        thread_a["rootTurnNodeHash"],
        [{"id": "step_a", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_a", "step_a")
    completed = kernel.run.complete_step("run_a", "step_a")
    kernel.thread.create("thread_b", "schema_main", "branch_b")

    code = error_code(
        lambda: kernel.branch.create("branch_cross_thread", "thread_b", completed["turnNodeHash"])
    )
    assert code == "turn_node_thread_mismatch"


def test_branch_create_rejects_unknown_thread() -> None:
    kernel = new_kernel()
    assert error_code(lambda: kernel.branch.create("branch_x", "thread_unknown", "f" * 64)) == (
        "kernel_runtime_missing_thread"
    )


def test_branch_create_rejects_duplicate_branch_id() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_a", "schema_main", "branch_a")
    code = error_code(
        lambda: kernel.branch.create("branch_a", "thread_a", thread["rootTurnNodeHash"])
    )
    assert code == "kernel_runtime_branch_exists"


def test_branch_set_head_rejects_lateral_movement() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_lateral", "schema_main", "branch_lateral_main")
    bootstrap_turn = kernel.turn.create(
        "turn_bootstrap", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_bootstrap",
        bootstrap_turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "bootstrap", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_bootstrap", "bootstrap")
    bootstrap_checkpoint = kernel.run.complete_step("run_bootstrap", "bootstrap")
    kernel.run.complete("run_bootstrap", "completed")

    main_turn = kernel.turn.create(
        "turn_main",
        thread["threadId"],
        thread["branchId"],
        bootstrap_turn["turnId"],
        bootstrap_checkpoint["turnNodeHash"],
    )
    kernel.run.create(
        "run_main",
        main_turn["turnId"],
        thread["branchId"],
        "schema_main",
        bootstrap_checkpoint["turnNodeHash"],
        [{"id": "main", "deterministic": False, "sideEffects": False}],
    )
    main_event = kernel.store.put(b"lateral-main")
    kernel.run.begin_step("run_main", "main")
    kernel.run.complete_step("run_main", "main", main_event)
    kernel.run.complete("run_main", "completed")

    fork_branch = kernel.branch.create(
        "branch_lateral_fork", thread["threadId"], bootstrap_checkpoint["turnNodeHash"]
    )
    fork_turn = kernel.turn.create(
        "turn_fork",
        thread["threadId"],
        fork_branch["branchId"],
        bootstrap_turn["turnId"],
        bootstrap_checkpoint["turnNodeHash"],
    )
    kernel.run.create(
        "run_fork",
        fork_turn["turnId"],
        fork_branch["branchId"],
        "schema_main",
        bootstrap_checkpoint["turnNodeHash"],
        [{"id": "fork", "deterministic": False, "sideEffects": False}],
    )
    fork_event = kernel.store.put(b"lateral-fork")
    kernel.run.begin_step("run_fork", "fork")
    fork_checkpoint = kernel.run.complete_step("run_fork", "fork", fork_event)
    kernel.run.complete("run_fork", "completed")

    code = error_code(
        lambda: kernel.branch.set_head(thread["branchId"], fork_checkpoint["turnNodeHash"])
    )
    assert code == "kernel_runtime_lateral_head_movement"


def test_branch_set_head_forward_is_a_pointer_update() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_fwd", "schema_main", "branch_fwd")
    turn = kernel.turn.create(
        "turn_fwd", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_fwd",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_fwd", "step")
    checkpoint = kernel.run.complete_step("run_fwd", "step")

    result = kernel.branch.set_head(thread["branchId"], checkpoint["turnNodeHash"])
    assert result["archiveBranch"] is None
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == checkpoint["turnNodeHash"]


def test_branch_set_head_backward_archives_and_fails_active_runs() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_back", "schema_main", "branch_back")
    root = thread["rootTurnNodeHash"]
    turn = kernel.turn.create("turn_back", thread["threadId"], thread["branchId"], None, root)
    kernel.run.create(
        "run_back",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        root,
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_back", "step")
    checkpoint = kernel.run.complete_step("run_back", "step")
    # run_back is still "running" (never completed) -- rollback must fail it.

    result = kernel.branch.set_head(thread["branchId"], root)
    assert result["archiveBranch"]["headTurnNodeHash"] == checkpoint["turnNodeHash"]
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == root
    assert kernel.run.recover("run_back") is not None  # run still exists, just failed
    stored_run = kernel.backend.get_run("run_back")
    assert stored_run["status"] == "failed"


# --- Run lifecycle -------------------------------------------------------------


def test_run_create_rejects_second_active_run_on_branch() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_busy", "schema_main", "branch_busy")
    turn = kernel.turn.create(
        "turn_busy", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_busy_active",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "first", "deterministic": False, "sideEffects": False}],
    )
    code = error_code(
        lambda: kernel.run.create(
            "run_busy_rejected",
            turn["turnId"],
            thread["branchId"],
            "schema_main",
            thread["rootTurnNodeHash"],
            [{"id": "next", "deterministic": False, "sideEffects": False}],
        )
    )
    assert code == "kernel_runtime_branch_already_active"


def test_run_create_rejects_duplicate_run_id() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_dup_run", "schema_main", "branch_dup_run")
    turn = kernel.turn.create(
        "turn_dup", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    steps = [{"id": "step", "deterministic": False, "sideEffects": False}]
    kernel.run.create(
        "run_dup",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        steps,
    )
    kernel.run.complete("run_dup", "completed")
    code = error_code(
        lambda: kernel.run.create(
            "run_dup",
            turn["turnId"],
            thread["branchId"],
            "schema_main",
            thread["rootTurnNodeHash"],
            steps,
        )
    )
    assert code == "kernel_runtime_run_exists"


def test_run_create_rejects_duplicate_step_id() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_dup_step", "schema_main", "branch_dup_step")
    turn = kernel.turn.create(
        "turn_dup_step", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    code = error_code(
        lambda: kernel.run.create(
            "run_dup_step",
            turn["turnId"],
            thread["branchId"],
            "schema_main",
            thread["rootTurnNodeHash"],
            [
                {"id": "step", "deterministic": False, "sideEffects": False},
                {"id": "step", "deterministic": False, "sideEffects": False},
            ],
        )
    )
    assert code == "kernel_runtime_duplicate_step_id"


def test_run_create_rejects_branch_head_mismatch() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_head_mismatch", "schema_main", "branch_head_mismatch")
    turn = kernel.turn.create(
        "turn_head_mismatch",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    code = error_code(
        lambda: kernel.run.create(
            "run_head_mismatch",
            turn["turnId"],
            thread["branchId"],
            "schema_main",
            "f" * 64,
            [{"id": "step", "deterministic": False, "sideEffects": False}],
        )
    )
    assert code == "kernel_runtime_run_branch_head_mismatch"


def test_run_begin_step_rejects_out_of_order_step() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_order", "schema_main", "branch_order")
    turn = kernel.turn.create(
        "turn_order", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_order",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [
            {"id": "first", "deterministic": False, "sideEffects": False},
            {"id": "second", "deterministic": False, "sideEffects": False},
        ],
    )
    code = error_code(lambda: kernel.run.begin_step("run_order", "second"))
    assert code == "kernel_runtime_unexpected_step"


def test_run_begin_step_rejects_not_running() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_not_running", "schema_main", "branch_not_running")
    turn = kernel.turn.create(
        "turn_not_running",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_not_running",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.complete("run_not_running", "completed")
    assert error_code(lambda: kernel.run.begin_step("run_not_running", "step")) == (
        "kernel_runtime_run_not_running"
    )


def test_run_complete_step_rejects_missing_event_object() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_missing_event", "schema_main", "branch_missing_event")
    turn = kernel.turn.create(
        "turn_missing_event",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_missing_event",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "event_step", "deterministic": False, "sideEffects": False}],
    )
    code = error_code(lambda: kernel.run.complete_step("run_missing_event", "event_step", "a" * 64))
    assert code == "kernel_runtime_missing_event_object"


def test_run_complete_step_checkpoints_and_advances_branch_head() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_checkpoint", "schema_main", "branch_checkpoint")
    turn = kernel.turn.create(
        "turn_checkpoint", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_checkpoint",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.staging.stage("run_checkpoint", b"hello", "task_1", "message", "completed")
    kernel.run.begin_step("run_checkpoint", "step")
    result = kernel.run.complete_step("run_checkpoint", "step")
    assert result["checkpointed"] is True
    branch = kernel.branch.get(thread["branchId"])
    assert branch["headTurnNodeHash"] == result["turnNodeHash"]
    assert kernel.staging.current("run_checkpoint") == []


def test_run_complete_rejects_illegal_transition_from_running() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_illegal", "schema_main", "branch_illegal")
    turn = kernel.turn.create(
        "turn_illegal", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_illegal",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    assert error_code(lambda: kernel.run.complete("run_illegal", "running")) == (
        "kernel_runtime_illegal_run_status_transition"
    )


def test_run_complete_paused_may_only_resolve_to_failed() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_paused", "schema_main", "branch_paused")
    turn = kernel.turn.create(
        "turn_paused", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_paused",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.complete("run_paused", "paused")
    assert error_code(lambda: kernel.run.complete("run_paused", "completed")) == (
        "kernel_runtime_invalid_paused_run_completion"
    )
    kernel.run.complete("run_paused", "failed")
    assert kernel.backend.get_run("run_paused")["status"] == "failed"


def test_run_complete_on_terminal_run_is_rejected() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_terminal", "schema_main", "branch_terminal")
    turn = kernel.turn.create(
        "turn_terminal", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_terminal",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.complete("run_terminal", "completed")
    assert error_code(lambda: kernel.run.complete("run_terminal", "failed")) == (
        "kernel_runtime_illegal_run_status_transition"
    )


def test_run_complete_reactive_checkpoint_on_uncommitted_staging() -> None:
    # Section 5.6: a Run-terminating signal with un-anchored StagedResults
    # triggers a reactive checkpoint before the Run halts.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_reactive", "schema_main", "branch_reactive")
    turn = kernel.turn.create(
        "turn_reactive", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_reactive",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.staging.stage("run_reactive", b"payload", "task_1", "message", "completed")
    result = kernel.run.complete("run_reactive", "completed")
    assert "turnNodeHash" in result
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == result["turnNodeHash"]
    assert kernel.staging.current("run_reactive") == []


def test_staging_stage_rejects_when_run_not_running() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_stage", "schema_main", "branch_stage")
    turn = kernel.turn.create(
        "turn_stage", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_stage",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.complete("run_stage", "completed")
    code = error_code(
        lambda: kernel.staging.stage("run_stage", b"x", "task", "message", "completed")
    )
    assert code == "kernel_runtime_run_not_running"


def test_run_recover_matches_recovery_state_conformance_scenario() -> None:
    # Mirrors `kernel.logical.recovery_state`.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_conformance", "schema_main", "branch_main")
    turn = kernel.turn.create(
        "turn_recovery", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    steps = [
        {"id": "model_call", "deterministic": False, "sideEffects": False},
        {"id": "tool_execution", "deterministic": False, "sideEffects": True},
    ]
    kernel.run.create(
        "run_recovery",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        steps,
    )
    kernel.run.begin_step("run_recovery", "model_call")
    kernel.run.complete_step("run_recovery", "model_call")
    kernel.run.begin_step("run_recovery", "tool_execution")
    kernel.staging.stage("run_recovery", b"assistant", "msg_assistant", "message", "completed")
    kernel.run.complete_step("run_recovery", "tool_execution")
    kernel.staging.stage(
        "run_recovery",
        b"tool call pending",
        "tool_call_pending",
        "tool_result",
        "interrupted",
        {"reason": "awaiting_approval"},
    )

    recovery = kernel.run.recover("run_recovery")
    assert recovery["lastCompletedStepId"] == "tool_execution"
    assert len(recovery["consumedStagedResults"]) == 1
    assert len(recovery["uncommittedStagedResults"]) == 1


def test_run_recover_rejects_unknown_run() -> None:
    kernel = new_kernel()
    assert error_code(lambda: kernel.run.recover("run_unknown")) == "kernel_runtime_missing_run"


# --- Object store --------------------------------------------------------------


def test_store_put_is_idempotent_and_content_addressed() -> None:
    kernel = new_kernel()
    hash_first = kernel.store.put(b"same content")
    hash_second = kernel.store.put(b"same content")
    assert hash_first == hash_second
    assert kernel.store.has(hash_first) is True
    assert kernel.store.get(hash_first) == b"same content"


def test_store_get_and_has_are_false_for_unknown_hash() -> None:
    kernel = new_kernel()
    assert kernel.store.get("f" * 64) is None
    assert kernel.store.has("f" * 64) is False


# --- Thread enumeration --------------------------------------------------------


def test_thread_list_matches_thread_list_conformance_scenario() -> None:
    # Mirrors `kernel.logical.thread_list` (kernel-protocol.thread.enumeration).
    kernel = new_kernel()
    kernel.thread.create("thread_enum_a", "schema_main", "branch_enum_a")
    kernel.thread.create("thread_enum_b", "schema_main", "branch_enum_b")

    all_threads = kernel.thread.list()
    paged = kernel.thread.list(limit=1)

    assert len(all_threads["threads"]) == 2
    assert all_threads["threads"][0]["threadId"] == "thread_enum_a"
    assert len(paged["threads"]) == 1
    assert "nextCursor" in paged


def test_thread_list_cursor_pages_through_all_results() -> None:
    kernel = new_kernel()
    for index in range(5):
        kernel.thread.create(f"thread_{index}", "schema_main", f"branch_{index}")

    seen: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        page = kernel.thread.list(limit=2, cursor=cursor)
        seen.extend(thread["threadId"] for thread in page["threads"])
        cursor = page.get("nextCursor")
        if cursor is None:
            break

    assert seen == [f"thread_{index}" for index in range(5)]


def test_thread_list_filters_by_schema_id() -> None:
    kernel = new_kernel()
    kernel.schema.register({**CANONICAL_SCHEMA, "schemaId": "schema_other"})
    kernel.thread.create("thread_main_schema", "schema_main", "branch_main_schema")
    kernel.thread.create("thread_other_schema", "schema_other", "branch_other_schema")

    filtered = kernel.thread.list(schema_id="schema_other")
    assert [thread["threadId"] for thread in filtered["threads"]] == ["thread_other_schema"]


def test_thread_list_rejects_unsupported_capability() -> None:
    backend = InMemoryBackend()

    class _NoEnumerationBackend(InMemoryBackend):
        def capabilities(self) -> dict[str, bool]:
            return {"thread.enumeration": False}

    unsupported_backend = _NoEnumerationBackend()
    kernel = RuntimeKernel(unsupported_backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))
    assert error_code(lambda: kernel.thread.list()) == "kernel_capability_unsupported"
    del backend  # unused placeholder for symmetry with other tests


def test_thread_list_rejects_malformed_cursor() -> None:
    kernel = new_kernel()
    kernel.thread.create("thread_a", "schema_main", "branch_a")
    assert error_code(lambda: kernel.thread.list(cursor="not-a-valid-cursor")) == (
        "invalid_durable_read_cursor"
    )


# --- Turn ------------------------------------------------------------------------


def test_turn_create_rejects_unknown_thread() -> None:
    kernel = new_kernel()
    assert error_code(
        lambda: kernel.turn.create("turn_x", "thread_unknown", "branch_x", None, "f" * 64)
    ) == ("kernel_runtime_missing_thread")


def test_turn_create_rejects_start_node_from_another_thread() -> None:
    kernel = new_kernel()
    thread_a = kernel.thread.create("thread_a", "schema_main", "branch_a")
    thread_b = kernel.thread.create("thread_b", "schema_main", "branch_b")
    code = error_code(
        lambda: kernel.turn.create(
            "turn_cross",
            thread_b["threadId"],
            thread_b["branchId"],
            None,
            thread_a["rootTurnNodeHash"],
        )
    )
    assert code == "turn_node_thread_mismatch"


def test_turn_create_rejects_duplicate_turn_id() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_a", "schema_main", "branch_a")
    kernel.turn.create(
        "turn_a", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    code = error_code(
        lambda: kernel.turn.create(
            "turn_a", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
        )
    )
    assert code == "kernel_runtime_turn_exists"


# --- Verdicts (already covered by test_verdict.py; smoke-test the namespace only) --


def test_verdicts_namespace_delegates_to_compose_verdicts() -> None:
    kernel = new_kernel()
    composed = kernel.verdicts.compose([{"kind": "proceed"}, {"kind": "retry", "adjustment": None}])
    assert composed == {"kind": "retry", "adjustment": None}


@pytest.mark.parametrize("status", ["completed", "failed", "paused"])
def test_run_complete_accepts_every_legal_running_transition(status: str) -> None:
    kernel = new_kernel()
    thread = kernel.thread.create(f"thread_{status}", "schema_main", f"branch_{status}")
    turn = kernel.turn.create(
        f"turn_{status}", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        f"run_{status}",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.complete(f"run_{status}", status)
    assert kernel.backend.get_run(f"run_{status}")["status"] == status
