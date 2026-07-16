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

"""Milestone M3 coverage: run execution leases (Section 5.2 / ADR-050) and
Section 5.5 checkpoint crash-recovery (`tuvren_kernel.fault_injection`).

Mirrors the exact scenario shapes the Python conformance adapter's
`kernel.run-liveness.*` / `kernel.restart-recovery.*` operations build (see
`tuvren_kernel_adapter.operations`), plus direct unit coverage of the
lease-lifecycle and fault-point edge cases those operations don't each
individually exercise.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel.backend import InMemoryBackend
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.fault_injection import FaultInjectingBackend
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


def error_code(callable_: Any) -> str:
    try:
        callable_()
    except KernelRuntimeError as error:
        return error.code
    raise AssertionError("expected a KernelRuntimeError")


def make_run(
    kernel: RuntimeKernel,
    prefix: str,
    *,
    owner_id: str | None = None,
    lease_duration_ms: int = 60_000,
    step_ids: list[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    thread = kernel.thread.create(f"thread_{prefix}", "schema_main", f"branch_{prefix}")
    turn = kernel.turn.create(
        f"turn_{prefix}", thread["threadId"], thread["branchId"], None, thread["rootTurnNodeHash"]
    )
    steps = [
        {"id": step_id, "deterministic": False, "sideEffects": False}
        for step_id in (step_ids or ["step"])
    ]
    run = kernel.run.create(
        f"run_{prefix}",
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        steps,
        owner_id=owner_id,
        lease_duration_ms=lease_duration_ms,
    )
    return thread, turn, run


# --- Lease lifecycle ---------------------------------------------------------


def test_run_create_stamps_a_backend_authoritative_lease() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    _, _, run = make_run(kernel, "lease_create", owner_id="owner_a", lease_duration_ms=25)
    assert run["lease"] == {"ownerId": "owner_a", "token": run["lease"]["token"], "expiresAtMs": 25}


def test_run_lease_renewal_extends_expiry_from_backend_clock() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    _, _, run = make_run(kernel, "lease_renew", owner_id="owner_a", lease_duration_ms=10)
    token = run["lease"]["token"]

    clock.value = 10
    renewed = kernel.run.renew_lease("run_lease_renew", "owner_a", token, lease_duration_ms=30)
    assert renewed["expiresAtMs"] == 40


def test_run_lease_renewal_rejects_owner_mismatch() -> None:
    kernel = new_kernel()
    _, _, run = make_run(kernel, "lease_owner", owner_id="owner_a")
    token = run["lease"]["token"]
    code = error_code(
        lambda: kernel.run.renew_lease("run_lease_owner", "owner_b", token, lease_duration_ms=10)
    )
    assert code == "run_lease_owner_mismatch"


def test_run_lease_renewal_rejects_stale_token() -> None:
    kernel = new_kernel()
    make_run(kernel, "lease_token", owner_id="owner_a")
    code = error_code(
        lambda: kernel.run.renew_lease(
            "run_lease_token", "owner_a", "not-the-real-token", lease_duration_ms=10
        )
    )
    assert code == "run_lease_token_mismatch"


def test_run_list_expired_running_excludes_paused_runs() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    make_run(kernel, "expiry_running", owner_id="owner_running", lease_duration_ms=5)
    make_run(kernel, "expiry_paused", owner_id="owner_paused", lease_duration_ms=5)
    kernel.run.begin_step("run_expiry_paused", "step")
    kernel.run.complete("run_expiry_paused", "paused")

    clock.value = 100
    expired_ids = sorted(run["runId"] for run in kernel.run.list_expired_running())
    assert expired_ids == ["run_expiry_running"]

    paused_run = kernel.backend.get_run("run_expiry_paused")
    assert paused_run["status"] == "paused"


def test_run_list_expired_running_excludes_unexpired_runs() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    make_run(kernel, "expiry_fresh", owner_id="owner_a", lease_duration_ms=1_000)

    clock.value = 10
    assert kernel.run.list_expired_running() == []


def test_run_preempt_stale_transitions_run_and_clears_lease_and_staging() -> None:
    clock = _Clock(0)
    kernel = new_kernel(clock)
    thread, _, run = make_run(kernel, "preempt", owner_id="owner_a", lease_duration_ms=5)
    kernel.staging.stage("run_preempt", b"uncommitted", "task_1", "message", "completed")

    clock.value = 100
    preempted = kernel.run.preempt_stale("run_preempt")

    assert preempted["status"] == "failed"
    assert preempted["preemptionReason"] == "stale_running_recovery"
    assert preempted["lease"] is None
    assert kernel.staging.current("run_preempt") == []

    branch = kernel.branch.get(thread["branchId"])
    recovery = kernel.run.recover("run_preempt")
    assert recovery["lastTurnNodeHash"] == branch["headTurnNodeHash"]


def test_run_preempt_stale_reactively_checkpoints_uncommitted_staged_work() -> None:
    """Section 5.2 step 4: preemption must fold verifiably-uncommitted
    staged work into one last checkpoint on the run's active lineage
    instead of discarding it -- the branch head advances to a new
    TurnNode whose `consumedStagedResults` carries the staged task, and
    `run.recover`'s `uncommittedStagedResults` reports zero because the
    work was checkpointed, not thrown away.
    """

    clock = _Clock(0)
    kernel = new_kernel(clock)
    thread, _, run = make_run(kernel, "preempt_preserve", owner_id="owner_a", lease_duration_ms=5)
    root_head = thread["rootTurnNodeHash"]
    kernel.staging.stage(
        "run_preempt_preserve", b"assistant reply", "assistant_message", "message", "completed"
    )

    clock.value = 100
    preempted = kernel.run.preempt_stale("run_preempt_preserve")

    assert preempted["status"] == "failed"
    assert preempted["preemptionReason"] == "stale_running_recovery"
    assert preempted["lease"] is None
    assert kernel.staging.current("run_preempt_preserve") == []

    branch = kernel.branch.get(thread["branchId"])
    # The branch head must have advanced past the run's start node onto a
    # freshly minted reactive-checkpoint TurnNode.
    assert branch["headTurnNodeHash"] != root_head
    assert preempted["createdTurnNodes"] == [branch["headTurnNodeHash"]]

    head_node = kernel.node.get(branch["headTurnNodeHash"])
    assert head_node is not None
    assert [staged["taskId"] for staged in head_node["consumedStagedResults"]] == [
        "assistant_message"
    ]

    recovery = kernel.run.recover("run_preempt_preserve")
    assert recovery["lastTurnNodeHash"] == branch["headTurnNodeHash"]
    assert recovery["uncommittedStagedResults"] == []
    assert [staged["taskId"] for staged in recovery["consumedStagedResults"]] == [
        "assistant_message"
    ]


def test_run_preempt_stale_with_no_staged_work_still_records_a_preemption_node() -> None:
    """Preemption checkpoints unconditionally (unlike `complete`'s
    staged-only guard): even with zero uncommitted staged work the branch
    head advances onto a fresh TurnNode with an empty
    `consumedStagedResults` whose `eventHash` pins the preemption event
    object, so the lineage durably records that a preemption happened
    (matching the TypeScript reference and the Go port)."""

    clock = _Clock(0)
    kernel = new_kernel(clock)
    thread, _, run = make_run(kernel, "preempt_empty", owner_id="owner_a", lease_duration_ms=5)
    root_head = thread["rootTurnNodeHash"]

    clock.value = 100
    preempted = kernel.run.preempt_stale("run_preempt_empty")

    assert preempted["status"] == "failed"

    branch = kernel.branch.get(thread["branchId"])
    assert branch["headTurnNodeHash"] != root_head
    assert preempted["createdTurnNodes"] == [branch["headTurnNodeHash"]]
    head_node = kernel.backend.get_node(branch["headTurnNodeHash"])
    assert head_node is not None
    assert head_node["consumedStagedResults"] == []
    assert head_node["eventHash"] is not None
    assert head_node["previousTurnNodeHash"] == root_head
    # The tree itself is unchanged: nothing was staged, so the event node
    # re-anchors the same TurnTree the previous head carried.
    root_node = kernel.backend.get_node(root_head)
    assert head_node["turnTreeHash"] == root_node["turnTreeHash"]


def test_run_preempt_stale_rejects_a_run_that_is_not_running() -> None:
    kernel = new_kernel()
    make_run(kernel, "preempt_terminal", owner_id="owner_a")
    kernel.run.begin_step("run_preempt_terminal", "step")
    kernel.run.complete("run_preempt_terminal", "completed")
    code = error_code(lambda: kernel.run.preempt_stale("run_preempt_terminal"))
    assert code == "kernel_runtime_run_not_running"


def test_run_preempt_stale_rejects_a_live_unexpired_lease() -> None:
    """Section 5.2's preemption guard: a running run whose lease is still
    live as of the backend-authoritative clock must not be preemptable --
    otherwise a healthy owner could be forced to `failed` by any peer.
    """

    clock = _Clock(0)
    kernel = new_kernel(clock)
    make_run(kernel, "preempt_live", owner_id="owner_a", lease_duration_ms=60_000)
    code = error_code(lambda: kernel.run.preempt_stale("run_preempt_live"))
    assert code == "kernel_runtime_run_lease_not_expired"
    assert kernel.backend.get_run("run_preempt_live")["status"] == "running"


def test_run_preempt_stale_rejects_a_run_without_a_lease() -> None:
    """Section 5.2's preemption guard: preemption is defined over an
    expired *lease*; a running run with no lease on record has nothing to
    go stale and must be rejected rather than failed. This port stamps a
    lease on every `run.create`, so the leaseless-running shape is only
    reachable by direct store manipulation -- the guard is defensive.
    """

    kernel = new_kernel()
    make_run(kernel, "preempt_leaseless")
    stored = kernel.backend.get_run("run_preempt_leaseless")
    stored["lease"] = None
    kernel.backend.put_run("run_preempt_leaseless", stored)
    code = error_code(lambda: kernel.run.preempt_stale("run_preempt_leaseless"))
    assert code == "kernel_runtime_run_no_active_lease"
    assert kernel.backend.get_run("run_preempt_leaseless")["status"] == "running"


# --- Checkpoint fault points / crash recovery --------------------------------


def _seed_and_fault(fault_point: str) -> dict[str, Any]:
    base_backend = InMemoryBackend()
    kernel = RuntimeKernel(base_backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))

    thread = kernel.thread.create(
        f"thread_fault_{fault_point}", "schema_main", f"branch_fault_{fault_point}"
    )
    turn = kernel.turn.create(
        f"turn_fault_{fault_point}",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    run_id = f"run_fault_{fault_point}"
    kernel.run.create(
        run_id,
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [
            {"id": "seed", "deterministic": False, "sideEffects": False},
            {"id": "faulted", "deterministic": False, "sideEffects": False},
        ],
    )

    kernel.run.begin_step(run_id, "seed")
    kernel.run.complete_step(run_id, "seed")
    pre_fault_head = kernel.branch.get(thread["branchId"])["headTurnNodeHash"]

    kernel.run.begin_step(run_id, "faulted")
    kernel.backend = FaultInjectingBackend(base_backend, fault_point, policy="once")  # type: ignore[assignment]
    raised_code = None
    try:
        kernel.run.complete_step(run_id, "faulted")
    except KernelRuntimeError as runtime_error:
        raised_code = runtime_error.code
    kernel.backend = base_backend

    return {
        "kernel": kernel,
        "thread": thread,
        "run_id": run_id,
        "pre_fault_head": pre_fault_head,
        "raised_code": raised_code,
    }


def test_fault_injecting_backend_fires_exactly_once_under_once_policy() -> None:
    base_backend = InMemoryBackend()
    faulty = FaultInjectingBackend(base_backend, "beforeCommit", policy="once")
    assert base_backend.get_node("deadbeef") is None
    for attempt in range(3):
        try:
            faulty.put_node(f"node-{attempt}", {"marker": attempt})
        except KernelRuntimeError as runtime_error:
            assert attempt == 0
            assert runtime_error.code == "kernel_persistence_fault_injected"
        else:
            assert attempt != 0


def test_before_commit_fault_leaves_no_partial_checkpoint() -> None:
    scenario = _seed_and_fault("beforeCommit")
    kernel: RuntimeKernel = scenario["kernel"]
    run_id = scenario["run_id"]

    assert scenario["raised_code"] == "kernel_persistence_fault_injected"

    run_record = kernel.backend.get_run(run_id)
    pending = run_record["pendingCheckpoint"]
    assert pending is not None
    assert kernel.backend.get_node(pending["nodeHash"]) is None

    reconciled = kernel.run.reconcile(run_id)
    assert reconciled == {
        "reconciled": True,
        "pendingMessageCommitted": False,
        "headTurnNodeHash": scenario["pre_fault_head"],
    }
    assert len(kernel.backend.get_run(run_id)["createdTurnNodes"]) == 1


def test_mid_commit_fault_leaves_genuine_partial_state_and_rolls_forward() -> None:
    scenario = _seed_and_fault("midCommit")
    kernel: RuntimeKernel = scenario["kernel"]
    run_id = scenario["run_id"]
    thread = scenario["thread"]

    assert scenario["raised_code"] == "kernel_persistence_fault_injected"

    run_record = kernel.backend.get_run(run_id)
    pending = run_record["pendingCheckpoint"]
    assert pending is not None
    # Genuine partial state: the TurnNode is durably written...
    assert kernel.backend.get_node(pending["nodeHash"]) is not None
    # ...but the branch head has not advanced to it yet.
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == scenario["pre_fault_head"]

    reconciled = kernel.run.reconcile(run_id)
    assert reconciled["pendingMessageCommitted"] is True
    assert reconciled["headTurnNodeHash"] == pending["nodeHash"]
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == pending["nodeHash"]
    assert len(kernel.backend.get_run(run_id)["createdTurnNodes"]) == 2


def test_mid_commit_reconcile_leaves_a_head_that_legitimately_moved_elsewhere() -> None:
    """The midCommit roll-forward is CAS'd from the head the pending node
    was minted against, never a blind write: if the branch head moved
    somewhere else entirely while the checkpoint was torn, reconcile must
    leave that head alone and just retire the stale pending marker
    (mirroring go/kernel/recovery.go's ReconcileRun)."""

    scenario = _seed_and_fault("midCommit")
    kernel: RuntimeKernel = scenario["kernel"]
    run_id = scenario["run_id"]
    thread = scenario["thread"]

    pending = kernel.backend.get_run(run_id)["pendingCheckpoint"]
    assert pending is not None

    # Simulate the head legitimately advancing elsewhere during the tear:
    # move it onto a different durable node (the pre-fault head's own
    # predecessor chain gives us none forward, so mint a sibling by
    # re-anchoring the root -- direct store manipulation keeps this focused
    # on reconcile's guard rather than on who moved the head).
    branch = kernel.branch.get(thread["branchId"])
    foreign_head = thread["rootTurnNodeHash"]
    kernel.backend.put_branch(branch["branchId"], {**branch, "headTurnNodeHash": foreign_head})

    reconciled = kernel.run.reconcile(run_id)
    assert reconciled["reconciled"] is True
    assert reconciled["pendingMessageCommitted"] is False
    assert reconciled["headTurnNodeHash"] == foreign_head
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == foreign_head
    assert kernel.backend.get_run(run_id)["pendingCheckpoint"] is None


def test_after_commit_before_ack_fault_is_already_fully_durable() -> None:
    scenario = _seed_and_fault("afterCommitBeforeAck")
    kernel: RuntimeKernel = scenario["kernel"]
    run_id = scenario["run_id"]
    thread = scenario["thread"]

    assert scenario["raised_code"] == "kernel_persistence_fault_injected"

    run_record = kernel.backend.get_run(run_id)
    pending = run_record["pendingCheckpoint"]
    assert pending is not None
    # The backend write already fully committed before the fault fired.
    assert kernel.backend.get_node(pending["nodeHash"]) is not None
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == pending["nodeHash"]
    # Only the run-record bookkeeping ("ack") is missing.
    assert pending["nodeHash"] not in run_record["createdTurnNodes"]

    reconciled = kernel.run.reconcile(run_id)
    assert reconciled["pendingMessageCommitted"] is True
    assert len(kernel.backend.get_run(run_id)["createdTurnNodes"]) == 2


def test_reconcile_is_a_no_op_without_a_pending_checkpoint() -> None:
    kernel = new_kernel()
    thread, _, _ = make_run(kernel, "reconcile_noop")
    reconciled = kernel.run.reconcile("run_reconcile_noop")
    assert reconciled["reconciled"] is False
    assert reconciled["pendingMessageCommitted"] is None
    assert reconciled["headTurnNodeHash"] == thread["rootTurnNodeHash"]


# --- Torn preemption checkpoints (P2 fix) ------------------------------------


def _seed_and_fault_preempt(fault_point: str) -> dict[str, Any]:
    """`_seed_and_fault`'s counterpart for `RunOps.preempt_stale`.

    Seeds a run with an already-expired lease and one uncommitted staged
    result, then injects `fault_point` into the reactive checkpoint
    `preempt_stale` performs -- the same three-write `commit_checkpoint`
    sequence `complete_step` uses -- so a caller can inspect exactly how
    far the torn preemption got and exercise `reconcile`/retry against it.
    """

    clock = _Clock(0)
    base_backend = InMemoryBackend(now=clock)
    kernel = RuntimeKernel(base_backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))

    thread = kernel.thread.create(
        f"thread_preempt_fault_{fault_point}",
        "schema_main",
        f"branch_preempt_fault_{fault_point}",
    )
    turn = kernel.turn.create(
        f"turn_preempt_fault_{fault_point}",
        thread["threadId"],
        thread["branchId"],
        None,
        thread["rootTurnNodeHash"],
    )
    run_id = f"run_preempt_fault_{fault_point}"
    kernel.run.create(
        run_id,
        turn["turnId"],
        thread["branchId"],
        "schema_main",
        thread["rootTurnNodeHash"],
        [{"id": "step", "deterministic": False, "sideEffects": False}],
        owner_id="owner_a",
        lease_duration_ms=5,
    )
    kernel.staging.stage(run_id, b"uncommitted", "task_1", "message", "completed")
    pre_fault_head = kernel.branch.get(thread["branchId"])["headTurnNodeHash"]

    clock.value = 100  # past the run's 5ms lease -- eligible for preemption
    kernel.backend = FaultInjectingBackend(base_backend, fault_point, policy="once")  # type: ignore[assignment]
    raised_code = None
    try:
        kernel.run.preempt_stale(run_id)
    except KernelRuntimeError as runtime_error:
        raised_code = runtime_error.code
    kernel.backend = base_backend

    return {
        "kernel": kernel,
        "thread": thread,
        "run_id": run_id,
        "pre_fault_head": pre_fault_head,
        "raised_code": raised_code,
    }


def test_preempt_stale_mid_commit_tear_refuses_a_naive_retry_and_reconciles_cleanly() -> None:
    """The torn-preemption consequence this fix closes: without a durable
    `pendingCheckpoint` marker, a process death between the head CAS and
    `clear_staged` would leave the run `"running"` with an expired lease
    and an intact staged pool, so a retry would re-incorporate the same
    staged results a second time onto the already-advanced head. Proves
    both halves of the fix: a naive retry refuses
    (`kernel_runtime_run_pending_checkpoint`) instead of double-
    incorporating, and `run.reconcile` repairs the torn attempt to the
    exact terminal state an untorn preemption reaches.
    """

    scenario = _seed_and_fault_preempt("midCommit")
    kernel: RuntimeKernel = scenario["kernel"]
    run_id = scenario["run_id"]
    thread = scenario["thread"]

    assert scenario["raised_code"] == "kernel_persistence_fault_injected"

    torn_run = kernel.backend.get_run(run_id)
    assert torn_run["status"] == "running"
    assert torn_run["lease"] is not None
    pending = torn_run["pendingCheckpoint"]
    assert pending is not None
    assert pending["kind"] == "preempt"
    # Genuine partial state: the TurnNode is durable, but the branch head
    # has not advanced to it and staging has not cleared.
    assert kernel.backend.get_node(pending["nodeHash"]) is not None
    assert kernel.branch.get(thread["branchId"])["headTurnNodeHash"] == scenario["pre_fault_head"]
    assert kernel.staging.current(run_id) != []

    # A naive retry must refuse rather than re-run the reactive checkpoint
    # over the same still-staged results.
    code = error_code(lambda: kernel.run.preempt_stale(run_id))
    assert code == "kernel_runtime_run_pending_checkpoint"
    assert kernel.backend.get_run(run_id)["status"] == "running"

    reconciled = kernel.run.reconcile(run_id)
    assert reconciled["pendingMessageCommitted"] is True
    assert reconciled["headTurnNodeHash"] == pending["nodeHash"]

    repaired = kernel.backend.get_run(run_id)
    assert repaired["status"] == "failed"
    assert repaired["preemptionReason"] == "stale_running_recovery"
    assert repaired["lease"] is None
    assert repaired["pendingCheckpoint"] is None
    # Exactly one checkpoint node was ever minted for the staged work --
    # reconcile finished the torn attempt, it did not mint a second one.
    assert repaired["createdTurnNodes"] == [pending["nodeHash"]]
    assert kernel.staging.current(run_id) == []

    head_node = kernel.backend.get_node(kernel.branch.get(thread["branchId"])["headTurnNodeHash"])
    assert head_node is not None
    assert [staged["taskId"] for staged in head_node["consumedStagedResults"]] == ["task_1"]


def test_preempt_stale_before_commit_tear_reconciles_and_then_retries_cleanly() -> None:
    """A `beforeCommit` tear never durably wrote the checkpoint's TurnNode
    at all, so `reconcile` just discards the stale marker (the run stays
    `"running"` with its staged pool untouched -- nothing was ever
    incorporated) and a subsequent `preempt_stale` retry proceeds exactly
    as if the first attempt never happened, incorporating the staged work
    exactly once.
    """

    scenario = _seed_and_fault_preempt("beforeCommit")
    kernel: RuntimeKernel = scenario["kernel"]
    run_id = scenario["run_id"]

    assert scenario["raised_code"] == "kernel_persistence_fault_injected"

    torn_run = kernel.backend.get_run(run_id)
    assert torn_run["status"] == "running"
    pending = torn_run["pendingCheckpoint"]
    assert pending is not None
    assert kernel.backend.get_node(pending["nodeHash"]) is None
    assert kernel.staging.current(run_id) != []

    reconciled = kernel.run.reconcile(run_id)
    assert reconciled["pendingMessageCommitted"] is False

    after_reconcile = kernel.backend.get_run(run_id)
    assert after_reconcile["status"] == "running"
    assert after_reconcile["pendingCheckpoint"] is None
    assert kernel.staging.current(run_id) != []  # untouched: nothing was incorporated

    preempted = kernel.run.preempt_stale(run_id)
    assert preempted["status"] == "failed"
    assert preempted["lease"] is None
    assert len(preempted["createdTurnNodes"]) == 1
    assert kernel.staging.current(run_id) == []


# --- Concurrent-writer optimistic-concurrency guard ---------------------------


def test_commit_checkpoint_rejects_a_concurrent_lateral_writer() -> None:
    base_backend = InMemoryBackend()
    kernel = RuntimeKernel(base_backend)
    kernel.schema.register(dict(CANONICAL_SCHEMA))
    thread = kernel.thread.create("thread_lateral", "schema_main", "branch_lateral")
    branch_id = thread["branchId"]
    base_branch = kernel.branch.get(branch_id)
    tree_hash = thread["rootTurnTreeHash"]

    event_one = kernel.store.put(b"writer-one")
    event_two = kernel.store.put(b"writer-two")

    writer_one = {"runId": "writer_one", "schemaId": "schema_main", "branchId": branch_id}
    writer_two = {"runId": "writer_two", "schemaId": "schema_main", "branchId": branch_id}

    winner_hash = kernel.checkpoint(writer_one, base_branch, tree_hash, event_one, [])
    assert kernel.branch.get(branch_id)["headTurnNodeHash"] == winner_hash

    code = error_code(lambda: kernel.checkpoint(writer_two, base_branch, tree_hash, event_two, []))
    assert code == "kernel_runtime_checkpoint_lateral_conflict"
    # The loser did not clobber the winner's head.
    assert kernel.branch.get(branch_id)["headTurnNodeHash"] == winner_hash

    # A retry from the now-current head succeeds.
    fresh_branch = kernel.branch.get(branch_id)
    retried_hash = kernel.checkpoint(writer_two, fresh_branch, tree_hash, event_two, [])
    assert kernel.branch.get(branch_id)["headTurnNodeHash"] == retried_hash
    assert retried_hash != winner_hash
