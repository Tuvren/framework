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
    assert code == "invalid_path_value_kind"


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


def test_branch_set_head_same_node_is_a_no_op_even_with_an_active_run() -> None:
    # Round-6 finding #2: TS returns success immediately when the target
    # equals the current head (runtime-kernel.ts:236-238); this must never
    # fall through to "forward" classification, which would wrongly raise
    # kernel_runtime_branch_has_active_run against an active run whose
    # lineage the no-op move doesn't touch at all.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_same_head", "schema_main", "branch_same_head")
    turn = kernel.turn.create(
        "turn_same_head",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_same_head",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )

    branch_before = kernel.branch.get(thread["branchId"])
    result = kernel.branch.set_head(thread["branchId"], thread["rootTurnNodeHash"])

    assert result["archiveBranch"] is None
    assert result["branch"]["headTurnNodeHash"] == thread["rootTurnNodeHash"]
    branch_after = kernel.branch.get(thread["branchId"])
    assert branch_after == branch_before
    # The active run survives untouched -- a same-node move is a genuine
    # no-op, not a (rejected) forward move.
    assert kernel.backend.get_run("run_same_head")["status"] == "running"


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
    # branch.setHead forward movement rejects while the branch has an
    # active run (kernel_runtime_branch_has_active_run) -- complete it
    # first so this test exercises the plain pointer-update path.
    kernel.run.complete("run_fwd", "completed")

    result = kernel.branch.set_head(thread["branchId"], checkpoint["turnNodeHash"])
    assert result["archiveBranch"] is None
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == checkpoint["turnNodeHash"]


def test_branch_set_head_forward_rejects_when_branch_has_active_run() -> None:
    # P1 fix: a forward `branch.setHead` move must not proceed while the
    # branch has a `running`/`paused` Run -- matching the TypeScript
    # reference's `assertNoActiveBranchRunForForwardHeadMove`, error code
    # `kernel_runtime_branch_has_active_run`.
    #
    # `complete_step` always advances the *checkpointing* branch's own head
    # to the node it just committed, so a move-target genuinely ahead of --
    # and distinct from -- `branch_fwd_active`'s current head has to come
    # from elsewhere: a sibling branch forked at the same root that
    # independently advances past it (round-6 finding #2 fixed
    # `branch.setHead` to treat "target already equals current head" as a
    # no-op, which is a different, non-error path from this genuine forward
    # move).
    kernel = new_kernel()
    thread = kernel.thread.create("thread_fwd_active", "schema_main", "branch_fwd_active")
    root = thread["rootTurnNodeHash"]

    donor_branch = kernel.branch.create("branch_fwd_active_donor", thread["threadId"], root)
    donor_turn = kernel.turn.create(
        "turn_fwd_active_donor", thread["threadId"], donor_branch["branchId"], None, root
    )
    kernel.run.create(
        "run_fwd_active_donor",
        donor_turn["turnId"],
        donor_branch["branchId"],
        "schema_main",
        root,
        [{"id": "donor_step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_fwd_active_donor", "donor_step")
    donor_checkpoint = kernel.run.complete_step("run_fwd_active_donor", "donor_step")
    kernel.run.complete("run_fwd_active_donor", "completed")
    # The donor's committed node is a genuine descendant of root, so it
    # classifies as "forward" for any other branch still sitting at root.
    forward_target = donor_checkpoint["turnNodeHash"]
    assert forward_target != root

    turn = kernel.turn.create("turn_fwd_active", thread["threadId"], thread["branchId"], None, root)
    kernel.run.create(
        "run_fwd_active_first",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        root,
        [{"id": "step_one", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_fwd_active_first", "step_one")
    # run_fwd_active_first is still "running" (mid-step) -- its own branch
    # is still sitting at root, so moving its head forward to the donor's
    # descendant must be rejected even though the target is a legitimate
    # descendant of the current head.
    code = error_code(lambda: kernel.branch.set_head(thread["branchId"], forward_target))
    assert code == "kernel_runtime_branch_has_active_run"
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == root


def test_branch_set_head_forward_succeeds_once_run_completes() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_fwd_done", "schema_main", "branch_fwd_done")
    turn = kernel.turn.create(
        "turn_fwd_done", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_fwd_done",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_fwd_done", "step")
    checkpoint = kernel.run.complete_step("run_fwd_done", "step")
    kernel.run.complete("run_fwd_done", "completed")

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


def test_branch_set_head_backward_fails_touching_run_and_clears_its_staging() -> None:
    # M4 fix: a backward branch.setHead rollback must fail only active runs
    # whose lineage actually touches the abandoned segment (TS reference:
    # `runTouchesSegment` in `runtime-kernel-lineage.ts`) and must clear
    # each failed run's staged pool in the same pass (TS:
    # `tx.stagedResults.clearRun`), not merely flip its status and leave
    # uncommitted staged work stranded behind a terminal run.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_seg_touch", "schema_main", "branch_seg_touch")
    root = thread["rootTurnNodeHash"]
    turn = kernel.turn.create("turn_seg_touch", thread["threadId"], thread["branchId"], None, root)
    kernel.run.create(
        "run_seg_touch",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        root,
        [
            {"id": "step_one", "deterministic": False, "sideEffects": False},
            {"id": "step_two", "deterministic": False, "sideEffects": False},
        ],
    )
    kernel.run.begin_step("run_seg_touch", "step_one")
    checkpoint = kernel.run.complete_step("run_seg_touch", "step_one")
    kernel.run.begin_step("run_seg_touch", "step_two")
    # Uncommitted staged work left behind on the run's own checkpointed
    # segment -- this is exactly the pool that must be emptied once the
    # rollback fails the run, not stranded forever.
    kernel.staging.stage("run_seg_touch", b"pending", "task_1", "message", "completed")
    assert kernel.staging.current("run_seg_touch") != []

    result = kernel.branch.set_head(thread["branchId"], root)
    assert result["archiveBranch"]["headTurnNodeHash"] == checkpoint["turnNodeHash"]
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == root

    stored_run = kernel.backend.get_run("run_seg_touch")
    assert stored_run["status"] == "failed"
    assert kernel.staging.current("run_seg_touch") == []
    recovery = kernel.run.recover("run_seg_touch")
    assert recovery["uncommittedStagedResults"] == []


def test_branch_set_head_backward_spares_active_run_that_does_not_touch_segment() -> None:
    # M4 fix: `runTouchesSegment` only fails an active run whose own
    # lineage (startTurnNodeHash or one of its own createdTurnNodes)
    # intersects the abandoned segment. Given this port's (and the TS
    # reference's) at-most-one-active-run-per-branch invariant, an
    # organically-created active run's own start or last checkpoint is
    # always the branch's current head, so it always overlaps whatever a
    # genuine rollback on that same branch abandons -- there is no
    # API-only path to an active run that legitimately doesn't touch its
    # own branch's abandoned segment. Construct that "doesn't touch" case
    # directly via store manipulation instead, the same defensive-guard
    # pattern `test_run_preempt_stale_rejects_a_run_without_a_lease` uses
    # (in `test_run_liveness.py`) to reach `preempt_stale`'s leaseless
    # guard.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_seg_spare", "schema_main", "branch_seg_spare")
    root = thread["rootTurnNodeHash"]
    turn = kernel.turn.create("turn_seg_spare", thread["threadId"], thread["branchId"], None, root)
    kernel.run.create(
        "run_seg_early",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        root,
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.run.begin_step("run_seg_early", "step")
    checkpoint = kernel.run.complete_step("run_seg_early", "step")
    kernel.run.complete("run_seg_early", "completed")

    kernel.run.create(
        "run_seg_active",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        checkpoint["turnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    # Defensive: pretend this active run's own lineage predates the
    # single-node segment the rollback below abandons.
    stored_active_run = kernel.backend.get_run("run_seg_active")
    stored_active_run["startTurnNodeHash"] = root
    kernel.backend.put_run("run_seg_active", stored_active_run)

    result = kernel.branch.set_head(thread["branchId"], root)
    assert result["archiveBranch"]["headTurnNodeHash"] == checkpoint["turnNodeHash"]
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == root

    survivor = kernel.backend.get_run("run_seg_active")
    assert survivor["status"] == "running"
    assert survivor["lease"] is not None


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


def test_run_complete_checkpoints_on_event_hash_alone_with_zero_staged_results() -> None:
    # M4 fix: TS `maybeCheckpoint` (`runtime-kernel-lineage.ts`) only skips
    # the reactive checkpoint when *both* stagedResults is empty and
    # eventHash is null. An eventHash-only completion (zero staged
    # results, an explicit terminal event) must still mint a checkpoint
    # that pins the event, not silently drop it.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_event_only", "schema_main", "branch_event_only")
    turn = kernel.turn.create(
        "turn_event_only", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_event_only",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    event_hash = kernel.store.put(b"terminal-event")
    assert kernel.staging.current("run_event_only") == []

    result = kernel.run.complete("run_event_only", "completed", event_hash)
    assert "turnNodeHash" in result
    branch = kernel.branch.get(thread["branchId"])
    assert branch["headTurnNodeHash"] == result["turnNodeHash"]
    node = kernel.backend.get_node(result["turnNodeHash"])
    assert node["eventHash"] == event_hash
    assert node["consumedStagedResults"] == []
    assert kernel.backend.get_run("run_event_only")["createdTurnNodes"] == [result["turnNodeHash"]]


def test_run_complete_paused_performs_the_same_reactive_checkpoint_as_completed() -> None:
    # M4 fix: TS `complete` never special-cases `status` inside
    # `maybeCheckpoint` -- completing to "paused" performs exactly the
    # same reactive checkpoint of un-anchored staged work that completing
    # to "completed"/"failed" does, advancing the branch head and clearing
    # the staged pool, before the status write.
    kernel = new_kernel()
    thread = kernel.thread.create(
        "thread_paused_checkpoint", "schema_main", "branch_paused_checkpoint"
    )
    turn = kernel.turn.create(
        "turn_paused_checkpoint",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_paused_checkpoint",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.staging.stage("run_paused_checkpoint", b"payload", "task_1", "message", "completed")

    result = kernel.run.complete("run_paused_checkpoint", "paused")
    assert "turnNodeHash" in result
    branch = kernel.branch.get(thread["branchId"])
    assert branch["headTurnNodeHash"] == result["turnNodeHash"]
    assert kernel.staging.current("run_paused_checkpoint") == []
    stored_run = kernel.backend.get_run("run_paused_checkpoint")
    assert stored_run["status"] == "paused"
    assert stored_run["createdTurnNodes"] == [result["turnNodeHash"]]


def test_run_complete_clears_the_lease_on_every_terminal_status() -> None:
    # M4 fix: TS `clearStoredRunLease` is applied unconditionally by
    # `complete` (`runtime-kernel-runs.ts`) regardless of the target
    # status -- including "paused" -- so mirror that here: every
    # `complete` call clears the run's lease and preemption reason, not
    # just terminal-and-not-paused ones.
    kernel = new_kernel()
    for status in ("completed", "failed", "paused"):
        thread = kernel.thread.create(
            f"thread_lease_clear_{status}", "schema_main", f"branch_lease_clear_{status}"
        )
        turn = kernel.turn.create(
            f"turn_lease_clear_{status}",
            thread["threadId"],
            thread["branchId"],
            None,
            thread["rootTurnNodeHash"],
        )
        run_id = f"run_lease_clear_{status}"
        kernel.run.create(
            run_id,
            turn["turnId"],
            thread["branchId"],
            "schema_main",
            thread["rootTurnNodeHash"],
            [{"id": "step", "deterministic": False, "sideEffects": False}],
            owner_id="owner",
            lease_duration_ms=60_000,
        )
        assert kernel.backend.get_run(run_id)["lease"] is not None

        kernel.run.complete(run_id, status)

        stored_run = kernel.backend.get_run(run_id)
        assert stored_run["status"] == status
        assert stored_run["lease"] is None
        assert stored_run["preemptionReason"] is None


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


def test_run_recover_returns_only_last_turn_nodes_consumed_staged_results() -> None:
    # P0 regression: `run.recover` must expose ONLY the last checkpoint's
    # `consumedStagedResults` (Section 5.7 / recovery-state CDDL: "from last
    # TurnNode"), never the Run's full checkpoint history. A result staged
    # and consumed at an EARLIER checkpoint must not resurface in recovery
    # once a LATER checkpoint has consumed something else -- the bug this
    # guards against returned the concatenation of every checkpoint's
    # consumed results instead of just the last one's.
    kernel = new_kernel()
    thread = kernel.thread.create(
        "thread_recover_last_node", "schema_main", "branch_recover_last_node"
    )
    turn = kernel.turn.create(
        "turn_recover_last_node",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    steps = [
        {"id": "first", "deterministic": False, "sideEffects": False},
        {"id": "second", "deterministic": False, "sideEffects": False},
    ]
    kernel.run.create(
        "run_recover_last_node",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        steps,
    )

    # Stage and consume a result at the FIRST checkpoint.
    kernel.run.begin_step("run_recover_last_node", "first")
    kernel.staging.stage(
        "run_recover_last_node",
        b"pre-checkpoint-one",
        "task_pre_checkpoint_one",
        "message",
        "completed",
    )
    kernel.run.complete_step("run_recover_last_node", "first")

    # Stage and consume a DIFFERENT result at the SECOND checkpoint.
    kernel.run.begin_step("run_recover_last_node", "second")
    kernel.staging.stage(
        "run_recover_last_node",
        b"pre-checkpoint-two",
        "task_pre_checkpoint_two",
        "message",
        "completed",
    )
    kernel.run.complete_step("run_recover_last_node", "second")

    recovery = kernel.run.recover("run_recover_last_node")
    consumed_task_ids = [item["taskId"] for item in recovery["consumedStagedResults"]]
    # Only the second checkpoint's result may appear -- the first
    # checkpoint's result is excluded, matching the Go/TS-verified
    # last-TurnNode semantics.
    assert consumed_task_ids == ["task_pre_checkpoint_two"]
    assert (
        recovery["lastTurnNodeHash"]
        == kernel.backend.get_run("run_recover_last_node")["createdTurnNodes"][-1]
    )


def test_run_recover_falls_back_to_start_node_before_any_checkpoint() -> None:
    # A fresh run that has not checkpointed yet has no `createdTurnNodes`
    # entry: `recover` must fall back to the run's `startTurnNodeHash` node
    # (matching the TypeScript reference's `getLastRunTurnNodeHash`), not an
    # unconditional empty array.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_recover_fresh", "schema_main", "branch_recover_fresh")
    turn = kernel.turn.create(
        "turn_recover_fresh",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_recover_fresh",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )

    recovery = kernel.run.recover("run_recover_fresh")
    root_node = kernel.backend.get_node(thread["rootTurnNodeHash"])
    assert recovery["lastTurnNodeHash"] == thread["rootTurnNodeHash"]
    assert recovery["consumedStagedResults"] == root_node["consumedStagedResults"]


def test_run_recover_rejects_unknown_run() -> None:
    kernel = new_kernel()
    assert error_code(lambda: kernel.run.recover("run_unknown")) == "kernel_runtime_missing_run"


# --- Backend aliasing (P2) --------------------------------------------------------


def test_backend_get_run_returns_a_copy_callers_cannot_corrupt() -> None:
    # P2 fix: `RuntimeBackend` getters must return copies, not live
    # references into backend-internal state -- otherwise a caller (or
    # `runtime.py` itself, which mutates a fetched run in place before
    # `put_run`) could corrupt durable state just by holding onto and
    # mutating a returned value, without ever calling a `put_*`.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_alias", "schema_main", "branch_alias")
    turn = kernel.turn.create(
        "turn_alias", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_alias",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )

    fetched = kernel.backend.get_run("run_alias")
    fetched["status"] = "corrupted"
    fetched["stepSequence"].append({"id": "ghost", "deterministic": False, "sideEffects": False})
    fetched["createdTurnNodes"].append("not-a-real-hash")

    refetched = kernel.backend.get_run("run_alias")
    assert refetched["status"] == "running"
    assert [step["id"] for step in refetched["stepSequence"]] == ["step"]
    assert refetched["createdTurnNodes"] == []


def test_backend_list_staged_returns_copies_callers_cannot_corrupt() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_alias_staged", "schema_main", "branch_alias_staged")
    turn = kernel.turn.create(
        "turn_alias_staged",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_alias_staged",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
    )
    kernel.staging.stage("run_alias_staged", b"hello", "task_1", "message", "completed")

    fetched = kernel.backend.list_staged("run_alias_staged")
    fetched[0]["taskId"] = "corrupted"
    fetched.append({"taskId": "ghost"})

    refetched = kernel.backend.list_staged("run_alias_staged")
    assert len(refetched) == 1
    assert refetched[0]["taskId"] == "task_1"


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


# --- Lineage depth cap (P2) -------------------------------------------------------


def _seed_linear_lineage_chain(kernel: RuntimeKernel, length: int) -> str:
    """Hand-write `length` TurnNode records chained by `previousTurnNodeHash`.

    Bypasses `RuntimeKernel.checkpoint`'s content-addressed hashing (which
    would be far too slow to invoke `length` times here) by writing directly
    through the backend with synthetic, sequential hashes. Returns the hash
    of the chain's tip (furthest from any root).
    """

    previous_hash: str | None = None
    node_hash = "0" * 64
    for index in range(length):
        node_hash = f"{index:064d}"
        kernel.backend.put_node(
            node_hash,
            {
                "schemaId": "schema_main",
                "turnTreeHash": "f" * 64,
                "previousTurnNodeHash": previous_hash,
                "eventHash": None,
                "consumedStagedResults": [],
                "hash": node_hash,
            },
        )
        previous_hash = node_hash
    return node_hash


def test_verify_thread_membership_rejects_lineage_walk_exceeding_depth_cap() -> None:
    # P2 fix: `verify_thread_membership`'s `previousTurnNodeHash` walk must
    # not loop unboundedly over an adversarial/pathologically long chain --
    # it must degrade into a normal kernel error once the walk exceeds
    # `_MAX_LINEAGE_WALK_DEPTH` (100_000, matching the Go port's
    # `maxLineageWalkDepth`) hops without reaching a thread root.
    kernel = new_kernel()
    thread = kernel.thread.create("thread_depth_cap", "schema_main", "branch_depth_cap")
    tip_hash = _seed_linear_lineage_chain(kernel, 100_002)

    code = error_code(lambda: kernel.verify_thread_membership(thread, tip_hash))
    assert code == "kernel_runtime_lineage_walk_depth_exceeded"


def test_reaches_rejects_lineage_walk_exceeding_depth_cap() -> None:
    kernel = new_kernel()
    tip_hash = _seed_linear_lineage_chain(kernel, 100_002)

    code = error_code(lambda: kernel.reaches(tip_hash, "unreachable_target"))
    assert code == "kernel_runtime_lineage_walk_depth_exceeded"


def test_verify_thread_membership_accepts_chain_within_depth_cap() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_within_cap", "schema_main", "branch_within_cap")
    # Re-root the synthetic chain onto the thread's real root so the walk
    # both stays under the cap and legitimately resolves.
    tip_hash = "chain_tip_within_cap"
    kernel.backend.put_node(
        tip_hash,
        {
            "schemaId": "schema_main",
            "turnTreeHash": "f" * 64,
            "previousTurnNodeHash": thread["rootTurnNodeHash"],
            "eventHash": None,
            "consumedStagedResults": [],
            "hash": tip_hash,
        },
    )
    kernel.verify_thread_membership(thread, tip_hash)  # must not raise


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
