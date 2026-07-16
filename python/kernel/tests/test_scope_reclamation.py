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

"""Milestone M4 coverage: cross-Scope isolation (Section 2.3 / 9.4),
reachability reclamation (Section 9.4), and the M3-review carry-forward
fixes (atomic head-CAS, assertion honesty, leaseless-run bookkeeping).

Mirrors the exact scenario shapes the Python conformance adapter's
`kernel.scope-isolation.cross-scope-probe` / `kernel.reclamation.*`
operations build (see `tuvren_kernel_adapter.operations`), plus direct unit
coverage of predicates those operations only exercise indirectly.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel.backend import InMemoryBackend, create_scoped_backend_pair
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


class _Clock:
    def __init__(self, value: int = 0) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value


def new_kernel(clock: _Clock | None = None) -> RuntimeKernel:
    backend = InMemoryBackend(now=clock) if clock is not None else InMemoryBackend()
    kernel = RuntimeKernel(backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))
    return kernel


def checkpoint_message(
    kernel: RuntimeKernel,
    *,
    thread_id: str,
    branch_id: str,
    run_id: str,
    turn_id: str,
    parent_turn_id: str | None,
    start_turn_node_hash: str,
    task_id: str,
    message_bytes: bytes,
) -> dict[str, Any]:
    turn = kernel.turn.create(turn_id, thread_id, branch_id, parent_turn_id, start_turn_node_hash)
    kernel.run.create(
        run_id,
        turn["turnId"],
        branch_id,
        "schema_main",
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


# --- Scope isolation (Section 2.3 / 9.4) ------------------------------------------


def test_scoped_pair_store_has_is_scope_confined() -> None:
    backend_a, backend_b = create_scoped_backend_pair("scope-a", "scope-b")
    kernel_a = RuntimeKernel(backend_a)
    kernel_b = RuntimeKernel(backend_b)

    object_hash = kernel_a.store.put(b"scope-a-content")

    assert kernel_a.store.has(object_hash) is True
    assert kernel_b.store.has(object_hash) is False


def test_scoped_pair_store_get_is_scope_confined() -> None:
    backend_a, backend_b = create_scoped_backend_pair("scope-a", "scope-b")
    kernel_a = RuntimeKernel(backend_a)
    kernel_b = RuntimeKernel(backend_b)

    object_hash = kernel_a.store.put(b"scope-a-content")

    assert kernel_a.store.get(object_hash) == b"scope-a-content"
    assert kernel_b.store.get(object_hash) is None


def test_scoped_pair_thread_enumeration_is_scope_confined() -> None:
    backend_a, backend_b = create_scoped_backend_pair("scope-a", "scope-b")
    kernel_a = RuntimeKernel(backend_a)
    kernel_a.schema.register(dict(CANONICAL_SCHEMA))
    kernel_b = RuntimeKernel(backend_b)
    kernel_b.schema.register(dict(CANONICAL_SCHEMA))

    kernel_a.thread.create("thread_a", "schema_main", "branch_a")

    threads_a = [t["threadId"] for t in kernel_a.thread.list()["threads"]]
    threads_b = [t["threadId"] for t in kernel_b.thread.list()["threads"]]

    assert threads_a == ["thread_a"]
    assert threads_b == []


def test_scoped_pair_writes_do_not_collide_on_shared_ids() -> None:
    """Two scopes may reuse the identical entity id without clobbering."""

    backend_a, backend_b = create_scoped_backend_pair("scope-a", "scope-b")
    kernel_a = RuntimeKernel(backend_a)
    kernel_a.schema.register(dict(CANONICAL_SCHEMA))
    kernel_b = RuntimeKernel(backend_b)
    kernel_b.schema.register(dict(CANONICAL_SCHEMA))

    created_a = kernel_a.thread.create("thread_shared_id", "schema_main", "branch_shared_id")
    created_b = kernel_b.thread.create("thread_shared_id", "schema_main", "branch_shared_id")

    assert kernel_a.thread.get("thread_shared_id") is not None
    assert kernel_b.thread.get("thread_shared_id") is not None
    # Both threads independently bootstrap their own root -- unaffected by
    # the other scope's identically-named thread.
    assert created_a["rootTurnNodeHash"] == created_b["rootTurnNodeHash"]


def test_unscoped_backend_defaults_to_isolated_private_substrate() -> None:
    """Two plain `InMemoryBackend()`s never share state absent an explicit pair."""

    kernel_a = new_kernel()
    kernel_b = new_kernel()
    object_hash = kernel_a.store.put(b"private-content")
    assert kernel_b.store.has(object_hash) is False


# --- Reclamation (Section 9.4) ----------------------------------------------------


def test_reclaim_releases_unreachable_orphan_object() -> None:
    kernel = new_kernel()
    orphan_hash = kernel.store.put(b"unreachable-orphan")

    summary = kernel.maintenance.reclaim()

    assert kernel.store.has(orphan_hash) is False
    assert summary["releasedObjectCount"] >= 1


def test_reclaim_retains_object_reachable_from_live_branch_head() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_live", "schema_main", "branch_live")
    checkpoint = checkpoint_message(
        kernel,
        thread_id=thread["threadId"],
        branch_id=thread["branchId"],
        run_id="run_live",
        turn_id="turn_live",
        parent_turn_id=None,
        start_turn_node_hash=thread["rootTurnNodeHash"],
        task_id="msg_live",
        message_bytes=b"live-message",
    )

    kernel.maintenance.reclaim()

    assert kernel.store.has(checkpoint["objectHash"]) is True
    assert kernel.node.get(checkpoint["turnNodeHash"]) is not None


def test_reclaim_releases_archived_branch_exclusive_lineage() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_archive", "schema_main", "branch_archive")
    shared = checkpoint_message(
        kernel,
        thread_id=thread["threadId"],
        branch_id=thread["branchId"],
        run_id="run_shared",
        turn_id="turn_shared",
        parent_turn_id=None,
        start_turn_node_hash=thread["rootTurnNodeHash"],
        task_id="msg_shared",
        message_bytes=b"shared",
    )
    archived = checkpoint_message(
        kernel,
        thread_id=thread["threadId"],
        branch_id=thread["branchId"],
        run_id="run_archived",
        turn_id="turn_archived",
        parent_turn_id=shared["turnId"],
        start_turn_node_hash=shared["turnNodeHash"],
        task_id="msg_archived",
        message_bytes=b"archived-exclusive",
    )

    rollback = kernel.branch.set_head(thread["branchId"], shared["turnNodeHash"])
    assert rollback["archiveBranch"] is not None

    kernel.maintenance.reclaim()

    # Archived branch's exclusive lineage is released...
    assert kernel.store.has(archived["objectHash"]) is False
    assert kernel.node.get(archived["turnNodeHash"]) is None
    # ...but the shared ancestor stays retained via the live (rolled-back-to) head.
    assert kernel.store.has(shared["objectHash"]) is True
    assert kernel.node.get(shared["turnNodeHash"]) is not None


def test_reclaim_grace_window_holds_recent_writes_under_active_lease() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)

    clock.value = 10
    orphan_before_lease = kernel.store.put(bytes([1]))

    clock.value = 20
    thread = kernel.thread.create("thread_grace", "schema_main", "branch_grace")
    turn = kernel.turn.create(
        "turn_grace", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_grace",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
    )

    clock.value = 30
    orphan_after_lease = kernel.store.put(bytes([2]))

    clock.value = 40
    kernel.maintenance.reclaim()

    assert kernel.store.has(orphan_before_lease) is False
    assert kernel.store.has(orphan_after_lease) is True


def test_reclaim_leaseless_run_past_admin_expiry_does_not_pin() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    thread = kernel.thread.create("thread_leaseless", "schema_main", "branch_leaseless")
    turn = kernel.turn.create(
        "turn_leaseless", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    kernel.run.create(
        "run_leaseless",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
        lease_duration_ms=None,
    )
    assert kernel.backend.get_run("run_leaseless")["lease"] is None

    clock.value = 10
    orphan = kernel.store.put(b"leaseless-past-admin-expiry")

    clock.value = 86_400_000 + 5000
    kernel.maintenance.reclaim()

    assert kernel.store.has(orphan) is False


def test_reclaim_leaseless_run_within_admin_expiry_still_pins() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    thread = kernel.thread.create(
        "thread_leaseless_active", "schema_main", "branch_leaseless_active"
    )
    turn = kernel.turn.create(
        "turn_leaseless_active",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    kernel.run.create(
        "run_leaseless_active",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
        lease_duration_ms=None,
    )

    clock.value = 10
    orphan = kernel.store.put(b"leaseless-within-admin-expiry")

    clock.value = 1000
    kernel.maintenance.reclaim()

    assert kernel.store.has(orphan) is True


def test_reclaim_via_one_scope_does_not_touch_co_tenant_scope_state() -> None:
    """Section 2.3 / 9.4 confinement: reclamation is a per-Scope sweep.

    Two `InMemoryBackend` handles share one physical `_SharedTables`
    substrate (`create_scoped_backend_pair`). Running
    `kernel.maintenance.reclaim()` through scope A's handle must only ever
    enumerate, timestamp-filter, and release scope A's own durable state --
    it must never observe, let alone release, scope B's co-tenant objects,
    nodes, or threads, even though both scopes' records live in the exact
    same underlying dicts. Assertions read scope B's state directly off its
    raw `InMemoryBackend` (`get_object`/`list_*_hashes`/`get_thread`), not
    through `RuntimeKernel`, so a regression that only breaks Scope-keying
    in the read path (rather than the reclamation sweep itself) would still
    be caught here.
    """

    backend_a, backend_b = create_scoped_backend_pair("scope-reclaim-a", "scope-reclaim-b")
    kernel_a = RuntimeKernel(backend_a)
    kernel_a.schema.register(dict(CANONICAL_SCHEMA))
    kernel_b = RuntimeKernel(backend_b)
    kernel_b.schema.register(dict(CANONICAL_SCHEMA))

    # Scope B: durable state that would be reclaimable-shaped if it were
    # ever exposed to scope A's sweep -- an orphan object plus a live thread
    # with a checkpointed message reachable from its branch head.
    co_tenant_orphan = kernel_b.store.put(b"co-tenant-orphan-object")
    thread_b = kernel_b.thread.create("thread_co_tenant", "schema_main", "branch_co_tenant")
    checkpoint_b = checkpoint_message(
        kernel_b,
        thread_id=thread_b["threadId"],
        branch_id=thread_b["branchId"],
        run_id="run_co_tenant",
        turn_id="turn_co_tenant",
        parent_turn_id=None,
        start_turn_node_hash=thread_b["rootTurnNodeHash"],
        task_id="msg_co_tenant",
        message_bytes=b"co-tenant-live-message",
    )

    # Snapshot scope B's raw substrate footprint before scope A ever runs
    # reclamation, so the post-reclaim assertions compare against it exactly
    # (not merely "still present").
    object_hashes_before = sorted(backend_b.list_object_hashes())
    node_hashes_before = sorted(backend_b.list_node_hashes())
    tree_hashes_before = sorted(backend_b.list_tree_hashes())
    thread_before = backend_b.get_thread(thread_b["threadId"])
    branch_before = backend_b.get_branch(thread_b["branchId"])

    # Scope A: an orphan object with nothing anchoring it -- genuinely
    # reclaimable within scope A's own sweep.
    kernel_a.store.put(b"scope-a-orphan-object")

    kernel_a.maintenance.reclaim()

    # Sanity: scope A's own sweep actually did something (otherwise this
    # test would pass vacuously even with no isolation at all).
    assert backend_a.list_object_hashes() == []

    # Scope B's raw substrate is byte-for-byte untouched by scope A's sweep.
    assert backend_b.get_object(co_tenant_orphan) == b"co-tenant-orphan-object"
    assert sorted(backend_b.list_object_hashes()) == object_hashes_before
    assert sorted(backend_b.list_node_hashes()) == node_hashes_before
    assert sorted(backend_b.list_tree_hashes()) == tree_hashes_before
    assert backend_b.get_thread(thread_b["threadId"]) == thread_before
    assert backend_b.get_branch(thread_b["branchId"]) == branch_before
    assert backend_b.get_object(checkpoint_b["objectHash"]) is not None
    assert backend_b.get_node(checkpoint_b["turnNodeHash"]) is not None


def test_reclaim_rejects_when_backend_does_not_advertise_capability() -> None:
    class _NoReclamationBackend(InMemoryBackend):
        def capabilities(self) -> dict[str, bool]:
            return {"thread.enumeration": True, "maintenance.reclamation": False}

    kernel = RuntimeKernel(_NoReclamationBackend())
    kernel.schema.register(dict(CANONICAL_SCHEMA))
    try:
        kernel.maintenance.reclaim()
    except KernelRuntimeError as runtime_error:
        assert runtime_error.code == "kernel_capability_unsupported"
    else:
        raise AssertionError("expected kernel_capability_unsupported")


# Erasure-probe crypto internals are covered in
# `python/kernel-conformance-adapter/tests/test_erasure_probe.py`, next to
# the `cryptography` dependency that backs them -- this port's hard
# constraint keeps that dependency scoped to the conformance adapter only,
# so `tuvren_kernel`'s own test suite (this file) must not import it.


# --- Part A carry-forwards ---------------------------------------------------------


def test_compare_and_swap_branch_head_atomic_primitive() -> None:
    backend = InMemoryBackend()
    kernel = RuntimeKernel(backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))
    thread = kernel.thread.create("thread_cas", "schema_main", "branch_cas")
    root = thread["rootTurnNodeHash"]

    assert (
        backend.compare_and_swap_branch_head("branch_cas", root, "not-a-real-hash-but-fine") is True
    )
    assert backend.get_branch("branch_cas")["headTurnNodeHash"] == "not-a-real-hash-but-fine"

    # A stale `expected_head` (the branch already moved) is rejected, not applied.
    assert backend.compare_and_swap_branch_head("branch_cas", root, "another-hash") is False
    assert backend.get_branch("branch_cas")["headTurnNodeHash"] == "not-a-real-hash-but-fine"


def test_commit_checkpoint_uses_cas_and_rejects_concurrent_head_move() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create("thread_checkpoint_cas", "schema_main", "branch_checkpoint_cas")
    branch = kernel.branch.get(thread["branchId"])

    # Simulate a concurrent writer that already moved the head out from
    # under this checkpoint's stale base.
    kernel.backend.put_branch(
        thread["branchId"], {**branch, "headTurnNodeHash": "someone-elses-head"}
    )

    node_identity, node_hash = kernel.begin_checkpoint(
        {"schemaId": "schema_main", "runId": "run_x"}, branch, thread["rootTurnTreeHash"], None, []
    )
    try:
        kernel.commit_checkpoint({"runId": "run_x"}, branch, node_hash, node_identity)
    except KernelRuntimeError as runtime_error:
        assert runtime_error.code == "kernel_runtime_checkpoint_lateral_conflict"
    else:
        raise AssertionError("expected kernel_runtime_checkpoint_lateral_conflict")


def test_run_create_supports_leaseless_runs() -> None:
    kernel = new_kernel()
    thread = kernel.thread.create(
        "thread_leaseless_create", "schema_main", "branch_leaseless_create"
    )
    turn = kernel.turn.create(
        "turn_leaseless_create",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    run = kernel.run.create(
        "run_leaseless_create",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "work", "deterministic": True, "sideEffects": False}],
        lease_duration_ms=None,
    )
    assert run["lease"] is None
    assert run["createdAtMs"] == 0
    assert run["updatedAtMs"] == 0
