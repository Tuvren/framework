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

"""`kernel.run-liveness.*` / `kernel.restart-recovery.*` operation handlers:
lease renewal and rejection, expired-run listing, stale-run preemption, and
in-process crash-recovery / concurrent-writer restart-recovery scenarios.

See `tuvren_kernel_adapter.operations` for the shared adapter-input helpers,
the `AdapterObservation` envelope shape, and the routing table these
handlers are registered under.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel.backend import InMemoryBackend
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.fault_injection import FaultInjectingBackend
from tuvren_kernel.runtime import RuntimeKernel

from tuvren_kernel_adapter.operations_common import (
    _InjectedClock,
    _capture_semantic_error_code,
    _load_canonical_schema,
    _new_conformance_kernel_with_clock,
    _projection,
)


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

    Builds a run with one uncommitted staged result (task id
    `assistant_message`) and an expired lease, then preempts it. The plan's
    assertions expect the run to land on `status: "failed"` /
    `preemptionReason: "stale_running_recovery"`, its lease cleared, and
    (Section 5.2 step 4) its staged result *preserved* via a reactive
    checkpoint rather than discarded: the branch head advances onto that
    checkpoint's TurnNode, `uncommittedStagedResults` reports zero because
    the work was consumed into the checkpoint rather than thrown away, and
    `preservedStagedResultTaskIds` reports the checkpoint node's
    `consumedStagedResults` task ids in order -- proving preservation
    positively rather than merely asserting the uncommitted count alone
    (which a discard implementation could also satisfy).
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
        "run_stale_preemption",
        b"uncommitted staged work",
        "assistant_message",
        "message",
        "completed",
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
                "preservedStagedResultTaskIds": [
                    staged["taskId"] for staged in recovery["consumedStagedResults"]
                ],
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
