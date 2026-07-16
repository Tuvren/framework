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

"""`kernel.scope-isolation.*` / `kernel.reclamation.*` operation handlers:
cross-Scope isolation probes, garbage-collection reclamation scenarios, and
the crypto-shredding erasure probe.

See `tuvren_kernel_adapter.operations` for the shared adapter-input helpers,
the `AdapterObservation` envelope shape, and the routing table these
handlers are registered under.
"""

from __future__ import annotations

from typing import Any

from tuvren_kernel.backend import create_scoped_backend_pair
from tuvren_kernel.runtime import RuntimeKernel

from tuvren_kernel_adapter.operations_common import (
    _InjectedClock,
    _load_canonical_schema,
    _new_conformance_kernel,
    _new_conformance_kernel_with_clock,
    _projection,
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

    # `key` is a mutable `bytearray`, not immutable `bytes`, specifically so
    # crypto-shredding below can zero the real key material in place instead
    # of merely dropping a reference to it and leaving the actual bytes
    # sitting in a prior object somewhere in the interpreter's heap.
    key: bytearray | None = bytearray(AESGCM.generate_key(bit_length=256))
    plaintext = b"sensitive-untrusted-edge-payload"

    def _encrypt(encryption_key: bytes) -> bytes:
        nonce = _os_urandom(12)
        ciphertext = AESGCM(bytes(encryption_key)).encrypt(nonce, plaintext, None)
        return nonce + ciphertext

    def _decrypt(decryption_key: bytes, envelope_bytes: bytes) -> bytes | None:
        nonce, ciphertext = envelope_bytes[:12], envelope_bytes[12:]
        try:
            return AESGCM(bytes(decryption_key)).decrypt(nonce, ciphertext, None)
        except InvalidTag:
            return None

    envelope = _encrypt(bytes(key))

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
    assert key is not None
    recoverable_before_erasure = _decrypt(bytes(key), stored_before) == plaintext

    # -- Crypto-shredding erasure: zero the host's only key material in
    # place, in the same `key` slot the pre-erasure decrypt above just used,
    # rather than merely rebinding `key` to `None` and leaving the real
    # bytes reachable in whatever object previously held them. --
    for i in range(len(key)):
        key[i] = 0

    stored_after = kernel.store.get(envelope_hash)
    assert stored_after is not None
    # The real key material is gone (zeroed in place, not swapped for a
    # never-valid unrelated key), so attempt a *real* decryption through the
    # same `key` slot erasure just wiped: this exercises the actual AEAD
    # authentication check against the actual stored ciphertext and observes
    # its failure, rather than short-circuiting on `key is None` without
    # ever calling the crypto.
    unrecoverable_after_erasure = _decrypt(bytes(key), stored_after) != plaintext

    # No lingering copy of the real key material survives erasure: the only
    # `bytearray` that ever held it has been zeroed above, and the local
    # reference to it is now dropped too.
    del key

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
