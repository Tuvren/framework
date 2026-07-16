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

"""Milestone M2: the runtime kernel over the `tuvren_kernel.backend` seam.

`RuntimeKernel` implements the M2 slice of `docs/KrakenKernelSpecification.md`
Section 7's syscall surface -- the object store (Section 2), schema registry
(Section 3.1), TurnTree operations (Section 3.2), Thread/Branch containment
(Section 4), a minimal Run lifecycle (Section 5.2/5.5/5.7), and the
`thread.enumeration` capability (Section 9.2) -- decomposed into one
namespace object per entity family (`store`, `schema`, `tree`, `node`,
`thread`, `branch`, `turn`, `staging`, `run`, `verdicts`), mirroring how the
TypeScript port splits `@tuvren/kernel-runtime` into per-entity operation
groups instead of one flat method bag. Every namespace is written purely
against the `RuntimeBackend` protocol in `backend.py`; no namespace reaches
past that seam, so a future `backend-sqlite`/`backend-postgres` port only
has to satisfy `backend.py`, never touch this module.

All Appendix-B validation and rejection lives here, not in `backend.py`
(which is a dumb, unvalidated durable-storage primitive) and not in the
conformance adapter (which only orchestrates scenarios over this API and
projects results -- see `tuvren_kernel_adapter.operations`).

**Deliberate M2 scope cuts** (documented so a later milestone does not
mistake these for bugs):

- `run.completeStep` always performs a checkpoint transaction (Section 5.5)
  regardless of `StepDeclaration.deterministic` / `sideEffects`. Section
  5.6's "planned checkpoints only after `!deterministic || sideEffects`"
  refinement is a later-milestone concern -- every M2 conformance scenario
  (mirroring the TypeScript host's) declares its steps `deterministic:
  false`, so unconditional checkpointing is observationally identical for
  every check this milestone promotes.
- `tree.resolve` and `tree.manifest` (Section 3.2) are not implemented:
  no M2 check reads them, and adding them speculatively would grow the
  surface past what this milestone's conformance plan exercises.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from tuvren_kernel import identity, records
from tuvren_kernel.backend import RuntimeBackend
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.verdict import compose_verdicts

_ACTIVE_RUN_STATUSES = {"running", "paused"}

# A caller-tunable default (every M3 lease scenario overrides this
# explicitly via `run.create(..., lease_duration_ms=...)` to land on a
# specific expiry value); this default only matters for M2-era callers that
# never mention leases at all.
_DEFAULT_LEASE_DURATION_MS = 60_000

# Bounds `verify_thread_membership`/`reaches`'s `previousTurnNodeHash` walk
# (Section 4.3), matching the Go port's `maxLineageWalkDepth`: adversarial or
# accidentally cyclic lineage chains must degrade into a normal kernel error
# instead of an unbounded loop.
_MAX_LINEAGE_WALK_DEPTH = 100_000


def _tree_identity_hash(schema_id: str, manifest: dict[str, Any]) -> str:
    """Hash a TurnTree's identity tuple `{schemaId, manifest}` (Section 3.2)."""

    return identity.hash_kernel_record({"schemaId": schema_id, "manifest": manifest})


def _empty_value(collection: str) -> Any:
    return [] if collection == "ordered" else None


def _validate_path_value(paths_by_name: dict[str, dict[str, Any]], path: str, value: Any) -> None:
    definition = paths_by_name.get(path)
    if definition is None:
        raise KernelRuntimeError("kernel_runtime_unknown_tree_path", f"unknown schema path: {path}")
    if definition["collection"] == "ordered":
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise KernelRuntimeError(
                "kernel_runtime_invalid_tree_path_value",
                f"path {path!r} is 'ordered' and requires a Hash[] value",
            )
    else:
        if value is not None and not isinstance(value, str):
            raise KernelRuntimeError(
                "kernel_runtime_invalid_tree_path_value",
                f"path {path!r} is 'single' and requires a Hash or null value",
            )


def _encode_cursor(created_at_ms: int, thread_id: str) -> str:
    payload = json.dumps([created_at_ms, thread_id]).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[int, str]:
    try:
        payload = base64.urlsafe_b64decode(cursor.encode("ascii"))
        created_at_ms, thread_id = json.loads(payload)
        return int(created_at_ms), str(thread_id)
    except Exception as decode_error:  # noqa: BLE001 - normalized into one error code below
        raise KernelRuntimeError(
            "invalid_durable_read_cursor", f"malformed thread.list cursor: {decode_error}"
        ) from decode_error


class StoreOps:
    """Section 2.4 object store operations."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def put(self, blob: bytes) -> str:
        return self._kernel.backend.put_object(bytes(blob))

    def get(self, object_hash: str) -> bytes | None:
        return self._kernel.backend.get_object(object_hash)

    def has(self, object_hash: str) -> bool:
        return self._kernel.backend.has_object(object_hash)


class SchemaOps:
    """Section 3.1 schema registry operations."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def register(self, schema: dict[str, Any]) -> str:
        try:
            normalized = records.normalize_turn_tree_schema(schema)
        except records.RecordValidationError as validation_error:
            raise KernelRuntimeError("kernel_runtime_invalid_record", str(validation_error)) from (
                validation_error
            )

        schema_id = normalized["schemaId"]
        if self._kernel.backend.get_schema(schema_id) is not None:
            raise KernelRuntimeError(
                "kernel_runtime_duplicate_schema", f"schemaId already registered: {schema_id}"
            )

        path_names = [path["path"] for path in normalized["paths"]]
        if len(path_names) != len(set(path_names)):
            raise KernelRuntimeError(
                "duplicate_schema_path", "turn-tree-schema.paths has a duplicate path"
            )

        object_types = [rule["objectType"] for rule in normalized["incorporationRules"]]
        if len(object_types) != len(set(object_types)):
            raise KernelRuntimeError(
                "kernel_runtime_duplicate_incorporation_rule",
                "turn-tree-schema.incorporationRules has a duplicate objectType",
            )

        known_paths = set(path_names)
        for rule in normalized["incorporationRules"]:
            if rule["targetPath"] not in known_paths:
                raise KernelRuntimeError(
                    "kernel_runtime_unknown_tree_path",
                    f"incorporation rule targetPath not in schema paths: {rule['targetPath']}",
                )

        self._kernel.backend.put_schema(schema_id, normalized)
        return schema_id

    def get(self, schema_id: str) -> dict[str, Any] | None:
        return self._kernel.backend.get_schema(schema_id)


class TreeOps:
    """Section 3.2 TurnTree operations."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def create(
        self,
        schema_id: str,
        changes: dict[str, Any],
        base_turn_tree_hash: str | None = None,
    ) -> str:
        schema = self._kernel.require_schema(schema_id)
        paths_by_name = {path["path"]: path for path in schema["paths"]}

        if base_turn_tree_hash is None:
            missing = sorted(set(paths_by_name) - set(changes))
            if missing:
                raise KernelRuntimeError(
                    "kernel_runtime_missing_required_tree_path",
                    f"tree.create without a base requires every schema path; missing {missing}",
                )
            manifest: dict[str, Any] = {}
        else:
            base = self._kernel.backend.get_tree(base_turn_tree_hash)
            if base is None:
                raise KernelRuntimeError(
                    "kernel_runtime_missing_turn_tree", f"unknown turn tree: {base_turn_tree_hash}"
                )
            if base["schemaId"] != schema_id:
                raise KernelRuntimeError(
                    "kernel_runtime_tree_schema_mismatch",
                    "tree.create base tree schemaId does not match the requested schemaId",
                )
            manifest = dict(base["manifest"])

        for path, value in changes.items():
            _validate_path_value(paths_by_name, path, value)
            manifest[path] = value

        tree_hash = _tree_identity_hash(schema_id, manifest)
        self._kernel.backend.put_tree(tree_hash, {"schemaId": schema_id, "manifest": manifest})
        return tree_hash

    def incorporate(self, base_turn_tree_hash: str, staged_results: list[dict[str, Any]]) -> str:
        base = self._kernel.backend.get_tree(base_turn_tree_hash)
        if base is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_turn_tree", f"unknown turn tree: {base_turn_tree_hash}"
            )

        schema = self._kernel.require_schema(base["schemaId"])
        rules = {rule["objectType"]: rule["targetPath"] for rule in schema["incorporationRules"]}
        paths_by_name = {path["path"]: path for path in schema["paths"]}
        manifest = dict(base["manifest"])

        for staged in staged_results:
            target_path = rules.get(staged["objectType"])
            if target_path is None:
                raise KernelRuntimeError(
                    "kernel_runtime_unmatched_incorporation_rule",
                    f"no incorporation rule for objectType: {staged['objectType']}",
                )
            definition = paths_by_name[target_path]
            if definition["collection"] == "ordered":
                manifest[target_path] = [*manifest.get(target_path, []), staged["objectHash"]]
            else:
                manifest[target_path] = staged["objectHash"]

        tree_hash = _tree_identity_hash(base["schemaId"], manifest)
        self._kernel.backend.put_tree(
            tree_hash, {"schemaId": base["schemaId"], "manifest": manifest}
        )
        return tree_hash

    def diff(self, tree_hash_a: str, tree_hash_b: str) -> list[str]:
        tree_a = self._kernel.backend.get_tree(tree_hash_a)
        tree_b = self._kernel.backend.get_tree(tree_hash_b)
        if tree_a is None or tree_b is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_turn_tree",
                f"unknown turn tree: {tree_hash_a if tree_a is None else tree_hash_b}",
            )
        if tree_a["schemaId"] != tree_b["schemaId"]:
            raise KernelRuntimeError(
                "kernel_runtime_tree_schema_mismatch_diff",
                "tree.diff requires both trees to share the same schemaId",
            )

        schema = self._kernel.require_schema(tree_a["schemaId"])
        changed: list[str] = []
        for path_def in schema["paths"]:
            path = path_def["path"]
            default = _empty_value(path_def["collection"])
            value_a = tree_a["manifest"].get(path, default)
            value_b = tree_b["manifest"].get(path, default)
            if value_a != value_b:
                changed.append(path)
        return sorted(changed)


class NodeOps:
    """Section 3.3 TurnNode read operations."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def get(self, node_hash: str) -> dict[str, Any] | None:
        return self._kernel.backend.get_node(node_hash)


class ThreadOps:
    """Section 4.1 Thread operations plus Section 9's `thread.list`."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def create(self, thread_id: str, schema_id: str, initial_branch_id: str) -> dict[str, Any]:
        if self._kernel.backend.get_thread(thread_id) is not None:
            raise KernelRuntimeError(
                "kernel_runtime_thread_exists", f"threadId exists: {thread_id}"
            )
        if self._kernel.backend.get_branch(initial_branch_id) is not None:
            raise KernelRuntimeError(
                "kernel_runtime_branch_exists", f"branchId exists: {initial_branch_id}"
            )

        schema = self._kernel.require_schema(schema_id)
        manifest = {path["path"]: _empty_value(path["collection"]) for path in schema["paths"]}
        tree_hash = _tree_identity_hash(schema_id, manifest)
        self._kernel.backend.put_tree(tree_hash, {"schemaId": schema_id, "manifest": manifest})

        # Backend-owned bootstrap event (Section 3.3): without a
        # thread-unique eventHash, two threads registered against the same
        # schema would both compute an empty root tree and would therefore
        # share one indistinguishable genesis TurnNode identity, collapsing
        # their lineage roots into the same hash and silently defeating
        # cross-thread membership proofs (Section 4.3). This bootstrap
        # object is opaque to the framework and exists solely to keep each
        # thread's root TurnNode identity unique.
        bootstrap_event_hash = self._kernel.backend.put_object(
            f"tuvren.kernel.bootstrap:{thread_id}".encode("utf-8")
        )
        node_identity = {
            "schemaId": schema_id,
            "turnTreeHash": tree_hash,
            "previousTurnNodeHash": None,
            "eventHash": bootstrap_event_hash,
            "consumedStagedResults": [],
        }
        node_hash = identity.hash_kernel_record(node_identity)
        self._kernel.backend.put_node(node_hash, {**node_identity, "hash": node_hash})

        self._kernel.backend.put_thread(
            thread_id,
            {
                "threadId": thread_id,
                "schemaId": schema_id,
                "rootTurnNodeHash": node_hash,
                "createdAtMs": self._kernel.backend.now(),
            },
        )
        self._kernel.backend.put_branch(
            initial_branch_id,
            {"branchId": initial_branch_id, "threadId": thread_id, "headTurnNodeHash": node_hash},
        )

        return {
            "threadId": thread_id,
            "branchId": initial_branch_id,
            "rootTurnNodeHash": node_hash,
            "rootTurnTreeHash": tree_hash,
        }

    def get(self, thread_id: str) -> dict[str, Any] | None:
        return self._kernel.backend.get_thread(thread_id)

    def list(
        self,
        limit: int | None = None,
        cursor: str | None = None,
        schema_id: str | None = None,
    ) -> dict[str, Any]:
        capabilities = self._kernel.backend.capabilities()  # type: ignore[attr-defined]
        if not capabilities.get("thread.enumeration", False):
            raise KernelRuntimeError(
                "kernel_capability_unsupported",
                "backend does not advertise the thread.enumeration capability",
            )

        threads = self._kernel.backend.list_threads()
        if schema_id is not None:
            threads = [thread for thread in threads if thread["schemaId"] == schema_id]
        threads.sort(key=lambda thread: (thread["createdAtMs"], thread["threadId"]))

        if cursor is not None:
            last_created_at_ms, last_thread_id = _decode_cursor(cursor)
            threads = [
                thread
                for thread in threads
                if (thread["createdAtMs"], thread["threadId"])
                > (last_created_at_ms, last_thread_id)
            ]

        if limit is not None and len(threads) > limit:
            page = threads[:limit]
            last = page[-1]
            next_cursor: str | None = _encode_cursor(last["createdAtMs"], last["threadId"])
        else:
            page = threads
            next_cursor = None

        result: dict[str, Any] = {"threads": page}
        if next_cursor is not None:
            result["nextCursor"] = next_cursor
        return result


class BranchOps:
    """Section 4.2 Branch operations."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def create(self, branch_id: str, thread_id: str, from_turn_node_hash: str) -> dict[str, Any]:
        thread = self._kernel.require_thread(thread_id)
        if self._kernel.backend.get_branch(branch_id) is not None:
            raise KernelRuntimeError(
                "kernel_runtime_branch_exists", f"branchId exists: {branch_id}"
            )
        self._kernel.verify_thread_membership(thread, from_turn_node_hash)

        record = {
            "branchId": branch_id,
            "threadId": thread_id,
            "headTurnNodeHash": from_turn_node_hash,
        }
        self._kernel.backend.put_branch(branch_id, record)
        return record

    def get(self, branch_id: str) -> dict[str, Any] | None:
        return self._kernel.backend.get_branch(branch_id)

    def list(self, thread_id: str) -> list[list[str]]:
        self._kernel.require_thread(thread_id)
        return [
            [branch["branchId"], branch["headTurnNodeHash"]]
            for branch in self._kernel.backend.list_branches(thread_id)
        ]

    def set_head(self, branch_id: str, turn_node_hash: str) -> dict[str, Any]:
        branch = self._kernel.require_branch(branch_id)
        thread = self._kernel.require_thread(branch["threadId"])
        self._kernel.verify_thread_membership(thread, turn_node_hash)

        current_head = branch["headTurnNodeHash"]
        direction = self._kernel.classify_head_movement(current_head, turn_node_hash)

        if direction == "lateral":
            raise KernelRuntimeError(
                "kernel_runtime_lateral_head_movement",
                "branch.setHead target is neither an ancestor nor a descendant of the current head",
            )

        if direction == "forward":
            active_run = next(
                (
                    run
                    for run in self._kernel.backend.list_runs_for_branch(branch_id)
                    if run["status"] in _ACTIVE_RUN_STATUSES
                ),
                None,
            )
            if active_run is not None:
                raise KernelRuntimeError(
                    "kernel_runtime_branch_has_active_run",
                    f"branch {branch_id} cannot move head forward while run "
                    f"{active_run['runId']} is active",
                )
            branch = {**branch, "headTurnNodeHash": turn_node_hash}
            self._kernel.backend.put_branch(branch_id, branch)
            return {"branch": branch, "archiveBranch": None}

        # Backward: atomic archival rollback (Section 4.2).
        archive_branch_id = self._kernel.next_archive_branch_id(branch_id)
        archive_branch = {
            "branchId": archive_branch_id,
            "threadId": branch["threadId"],
            "headTurnNodeHash": current_head,
        }
        self._kernel.backend.put_branch(archive_branch_id, archive_branch)

        for run in self._kernel.backend.list_runs_for_branch(branch_id):
            if run["status"] in _ACTIVE_RUN_STATUSES:
                self._kernel.backend.put_run(run["runId"], {**run, "status": "failed"})

        branch = {**branch, "headTurnNodeHash": turn_node_hash}
        self._kernel.backend.put_branch(branch_id, branch)
        return {"branch": branch, "archiveBranch": archive_branch}


class TurnOps:
    """Minimal Section 5.3 Turn operations needed to build M2 Run scenarios."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def create(
        self,
        turn_id: str,
        thread_id: str,
        branch_id: str,
        parent_turn_id: str | None,
        start_turn_node_hash: str,
    ) -> dict[str, Any]:
        if self._kernel.backend.get_turn(turn_id) is not None:
            raise KernelRuntimeError("kernel_runtime_turn_exists", f"turnId exists: {turn_id}")

        thread = self._kernel.require_thread(thread_id)
        branch = self._kernel.require_branch(branch_id)
        if branch["threadId"] != thread_id:
            raise KernelRuntimeError(
                "kernel_runtime_branch_thread_mismatch",
                f"branch {branch_id} does not belong to thread {thread_id}",
            )
        if parent_turn_id is not None and self._kernel.backend.get_turn(parent_turn_id) is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_turn", f"unknown parent turn: {parent_turn_id}"
            )

        self._kernel.verify_thread_membership(thread, start_turn_node_hash)

        record = {
            "turnId": turn_id,
            "threadId": thread_id,
            "branchId": branch_id,
            "parentTurnId": parent_turn_id,
            "startTurnNodeHash": start_turn_node_hash,
            "headTurnNodeHash": start_turn_node_hash,
        }
        self._kernel.backend.put_turn(turn_id, record)
        return record

    def get(self, turn_id: str) -> dict[str, Any] | None:
        return self._kernel.backend.get_turn(turn_id)


class StagingOps:
    """Section 3.4 staging operations."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def stage(
        self,
        run_id: str,
        blob: bytes,
        task_id: str,
        object_type: str,
        status: str,
        interrupt_payload: Any = None,
    ) -> dict[str, Any]:
        run = self._kernel.require_run(run_id)
        if run["status"] != "running":
            raise KernelRuntimeError(
                "kernel_runtime_run_not_running", f"run {run_id} is not running"
            )

        object_hash = self._kernel.store.put(blob)
        raw: dict[str, Any] = {
            "taskId": task_id,
            "objectHash": object_hash,
            "objectType": object_type,
            "status": status,
            "timestamp": self._kernel.backend.now(),
        }
        if status == "interrupted" or interrupt_payload is not None:
            raw["interruptPayload"] = interrupt_payload

        try:
            staged_result = records.normalize_staged_result(raw)
        except records.RecordValidationError as validation_error:
            raise KernelRuntimeError("kernel_runtime_invalid_record", str(validation_error)) from (
                validation_error
            )

        self._kernel.backend.append_staged(run_id, staged_result)
        return {"objectHash": object_hash, "stagedResult": staged_result}

    def current(self, run_id: str) -> list[dict[str, Any]]:
        self._kernel.require_run(run_id)
        return self._kernel.backend.list_staged(run_id)


class RunOps:
    """Minimal Section 5.2/5.5/5.7 Run lifecycle slice."""

    def __init__(self, kernel: RuntimeKernel) -> None:
        self._kernel = kernel

    def create(
        self,
        run_id: str,
        turn_id: str,
        branch_id: str,
        schema_id: str,
        start_turn_node_hash: str,
        steps: list[dict[str, Any]],
        *,
        owner_id: str | None = None,
        lease_duration_ms: int = _DEFAULT_LEASE_DURATION_MS,
    ) -> dict[str, Any]:
        if self._kernel.backend.get_run(run_id) is not None:
            raise KernelRuntimeError("kernel_runtime_run_exists", f"runId exists: {run_id}")
        if self._kernel.backend.get_turn(turn_id) is None:
            raise KernelRuntimeError("kernel_runtime_missing_turn", f"unknown turn: {turn_id}")

        branch = self._kernel.require_branch(branch_id)
        self._kernel.require_schema(schema_id)

        if branch["headTurnNodeHash"] != start_turn_node_hash:
            raise KernelRuntimeError(
                "kernel_runtime_run_branch_head_mismatch",
                "run.create startTurnNodeHash does not match the branch's current head",
            )

        for existing in self._kernel.backend.list_runs_for_branch(branch_id):
            if existing["status"] in _ACTIVE_RUN_STATUSES:
                raise KernelRuntimeError(
                    "kernel_runtime_branch_already_active",
                    f"branch {branch_id} already has an active run: {existing['runId']}",
                )

        step_ids = [step["id"] for step in steps]
        if len(step_ids) != len(set(step_ids)):
            raise KernelRuntimeError(
                "kernel_runtime_duplicate_step_id", "run.create steps has a duplicate step id"
            )

        now = self._kernel.backend.now()
        lease = {
            "ownerId": owner_id if owner_id is not None else f"owner:{run_id}",
            "token": self._kernel.next_lease_token(run_id),
            "expiresAtMs": now + lease_duration_ms,
        }
        record = {
            "runId": run_id,
            "turnId": turn_id,
            "branchId": branch_id,
            "schemaId": schema_id,
            "startTurnNodeHash": start_turn_node_hash,
            "status": "running",
            "stepSequence": [dict(step) for step in steps],
            "currentStepIndex": 0,
            "createdTurnNodes": [],
            "lastCompletedStepId": None,
            "lease": lease,
            "pendingCheckpoint": None,
            "preemptionReason": None,
        }
        self._kernel.backend.put_run(run_id, record)
        return dict(record)

    def renew_lease(
        self, run_id: str, owner_id: str, token: str, lease_duration_ms: int
    ) -> dict[str, Any]:
        """Section 5.2 / ADR-050 lease renewal.

        Backend-authoritative: the new `expiresAtMs` is always computed from
        `RuntimeBackend.now()`, never from a caller-supplied clock. Rejects a
        non-owner caller with `run_lease_owner_mismatch` before ever
        inspecting the token (an impostor should not learn whether *any*
        token would have worked), then rejects a correct-owner but
        wrong/stale token with `run_lease_token_mismatch`.
        """

        run = self._kernel.require_run(run_id)
        lease = run.get("lease")
        if lease is None:
            raise KernelRuntimeError(
                "kernel_runtime_run_no_active_lease", f"run {run_id} has no active lease"
            )
        if lease["ownerId"] != owner_id:
            raise KernelRuntimeError(
                "run_lease_owner_mismatch",
                f"run {run_id} lease is owned by a different owner",
            )
        if lease["token"] != token:
            raise KernelRuntimeError(
                "run_lease_token_mismatch", f"run {run_id} lease renewal token is stale"
            )

        new_expires_at_ms = self._kernel.backend.now() + lease_duration_ms
        run["lease"] = {**lease, "expiresAtMs": new_expires_at_ms}
        self._kernel.backend.put_run(run_id, run)
        return dict(run["lease"])

    def list_expired_running(self, now: int | None = None) -> list[dict[str, Any]]:
        """Section 5.2 lease-expiry listing.

        Scans every run this backend knows about (across every branch: two
        simultaneously-active runs can never share one branch per Appendix
        B, so a run-liveness scenario that needs both an expired-running run
        and an excluded paused run necessarily spreads them across
        branches), keeping only `status == "running"` runs whose lease has
        expired. `"paused"` runs are *never* lease-expired-listed, even if
        their stored `expiresAtMs` looks stale -- a paused run has
        deliberately yielded its lease-liveness obligation, not lost it.
        """

        as_of = self._kernel.backend.now() if now is None else now
        expired = []
        for run in self._kernel.backend.list_all_runs():
            if run["status"] != "running":
                continue
            lease = run.get("lease")
            if lease is None:
                continue
            if lease["expiresAtMs"] <= as_of:
                expired.append(run)
        return expired

    def preempt_stale(self, run_id: str) -> dict[str, Any]:
        """Section 5.2 stale-run preemption/recovery.

        Transitions an expired `"running"` run to `"failed"` with
        `preemptionReason: "stale_running_recovery"`, discards its
        uncommitted staged results (Section 3.4 -- nothing consumed them
        into a checkpoint), and clears its lease. This run never advanced
        the branch head past its own `startTurnNodeHash` (a stale-running
        run by definition made no further checkpoint after the crash that
        stranded it), so the branch head is untouched here -- it is already
        the "recovery head" a caller compares against.
        """

        run = self._kernel.require_run(run_id)
        if run["status"] != "running":
            raise KernelRuntimeError(
                "kernel_runtime_run_not_running",
                f"run {run_id} is not running (status={run['status']!r})",
            )

        self._kernel.backend.clear_staged(run_id)
        run["status"] = "failed"
        run["preemptionReason"] = "stale_running_recovery"
        run["lease"] = None
        self._kernel.backend.put_run(run_id, run)
        return dict(run)

    def begin_step(self, run_id: str, step_id: str) -> dict[str, Any]:
        run = self._kernel.require_run(run_id)
        if run["status"] != "running":
            raise KernelRuntimeError(
                "kernel_runtime_run_not_running", f"run {run_id} is not running"
            )

        steps = run["stepSequence"]
        index = run["currentStepIndex"]
        if index >= len(steps) or steps[index]["id"] != step_id:
            raise KernelRuntimeError(
                "kernel_runtime_unexpected_step",
                f"expected step {steps[index]['id'] if index < len(steps) else '<none>'!r}, got {step_id!r}",
            )

        schema = self._kernel.require_schema(run["schemaId"])
        branch = self._kernel.require_branch(run["branchId"])
        return {
            "step": steps[index],
            "schema": schema,
            "signals": [],
            "currentTurnNodeHash": branch["headTurnNodeHash"],
        }

    def complete_step(
        self,
        run_id: str,
        step_id: str,
        event_hash: str | None = None,
        tree_hash: str | None = None,
    ) -> dict[str, Any]:
        run = self._kernel.require_run(run_id)
        if run["status"] != "running":
            raise KernelRuntimeError(
                "kernel_runtime_run_not_running", f"run {run_id} is not running"
            )

        steps = run["stepSequence"]
        index = run["currentStepIndex"]
        if index >= len(steps) or steps[index]["id"] != step_id:
            raise KernelRuntimeError(
                "kernel_runtime_unexpected_step",
                f"expected step {steps[index]['id'] if index < len(steps) else '<none>'!r}, got {step_id!r}",
            )

        if event_hash is not None and not self._kernel.backend.has_object(event_hash):
            raise KernelRuntimeError(
                "kernel_runtime_missing_event_object", f"unknown event object: {event_hash}"
            )

        branch = self._kernel.require_branch(run["branchId"])
        staged = self._kernel.backend.list_staged(run_id)

        if tree_hash is not None:
            tree = self._kernel.backend.get_tree(tree_hash)
            if tree is None:
                raise KernelRuntimeError(
                    "kernel_runtime_missing_turn_tree", f"unknown turn tree: {tree_hash}"
                )
            if tree["schemaId"] != run["schemaId"]:
                raise KernelRuntimeError(
                    "kernel_runtime_tree_schema_mismatch",
                    "run.completeStep treeHash schemaId does not match the run's schemaId",
                )
            new_tree_hash = tree_hash
        else:
            head_node = self._kernel.backend.get_node(branch["headTurnNodeHash"])
            assert head_node is not None  # every stored branch head references a stored node
            new_tree_hash = self._kernel.tree.incorporate(head_node["turnTreeHash"], staged)

        # Section 5.5's checkpoint transaction is three sequential backend
        # writes (`put_node`, `put_branch`, `clear_staged` -- see
        # `RuntimeKernel.commit_checkpoint` below), not one backend-owned
        # atomic transaction: a crash between any two of those writes is
        # observable. So the checkpoint's *identity* is computed and
        # durably recorded on the run record as `pendingCheckpoint`
        # *before* attempting any of those writes, and only cleared once
        # every write plus this method's own run-record bookkeeping has
        # completed. If the process is interrupted anywhere in between
        # (including by an injected fault -- see `tuvren_kernel.
        # fault_injection`), `RunOps.reconcile` can inspect exactly how far
        # the interrupted attempt got and finish it deterministically,
        # rather than replaying `complete_step` from scratch (which would
        # try to consume the same staged results twice).
        node_identity, node_hash = self._kernel.begin_checkpoint(
            run, branch, new_tree_hash, event_hash, staged
        )
        run["pendingCheckpoint"] = {
            "stepId": step_id,
            "nodeHash": node_hash,
            "nodeIdentity": node_identity,
        }
        self._kernel.backend.put_run(run_id, run)

        self._kernel.commit_checkpoint(run, branch, node_hash, node_identity)

        run["createdTurnNodes"].append(node_hash)
        run["lastCompletedStepId"] = step_id
        run["currentStepIndex"] = index + 1
        run["pendingCheckpoint"] = None
        self._kernel.backend.put_run(run_id, run)

        return {"checkpointed": True, "turnNodeHash": node_hash}

    def reconcile(self, run_id: str) -> dict[str, Any]:
        """Section 5.7-style recovery reconciliation for `complete_step`'s
        pending checkpoint.

        Inspects backend state directly to determine exactly how far an
        interrupted `complete_step` attempt got, and finishes it
        deterministically:

        - The checkpoint's TurnNode was never written (`beforeCommit`): the
          attempt is discarded outright, nothing to roll forward.
        - The TurnNode was written but the branch head has not advanced yet
          (`midCommit`): rolls the write forward by advancing the head and
          clearing staging, then finishes the run-record bookkeeping.
        - The TurnNode was written *and* the branch head already advanced to
          it (`afterCommitBeforeAck`, or a `midCommit` this method has
          already rolled forward once): only the run-record bookkeeping is
          missing, so this method finishes just that.

        A no-op (`reconciled: False`) when the run has no pending
        checkpoint to reconcile.
        """

        run = self._kernel.require_run(run_id)
        branch = self._kernel.require_branch(run["branchId"])
        pending = run.get("pendingCheckpoint")
        if pending is None:
            return {
                "reconciled": False,
                "pendingMessageCommitted": None,
                "headTurnNodeHash": branch["headTurnNodeHash"],
            }

        node_hash = pending["nodeHash"]
        node = self._kernel.backend.get_node(node_hash)
        if node is None:
            # beforeCommit: the checkpoint never durably existed.
            run["pendingCheckpoint"] = None
            self._kernel.backend.put_run(run_id, run)
            return {
                "reconciled": True,
                "pendingMessageCommitted": False,
                "headTurnNodeHash": branch["headTurnNodeHash"],
            }

        if branch["headTurnNodeHash"] != node_hash:
            # midCommit: the TurnNode is durable but the head/staging half
            # of the write never ran. Roll it forward.
            self._kernel.backend.put_branch(
                run["branchId"], {**branch, "headTurnNodeHash": node_hash}
            )
            self._kernel.backend.clear_staged(run_id)
            branch = self._kernel.require_branch(run["branchId"])

        # afterCommitBeforeAck lands here directly (the backend write was
        # already fully durable); the midCommit branch above also falls
        # through here once it has finished rolling forward.
        if node_hash not in run["createdTurnNodes"]:
            run["createdTurnNodes"].append(node_hash)
        run["lastCompletedStepId"] = pending["stepId"]
        steps = run["stepSequence"]
        pending_index = next(
            (index for index, step in enumerate(steps) if step["id"] == pending["stepId"]), None
        )
        if pending_index is not None and run["currentStepIndex"] <= pending_index:
            run["currentStepIndex"] = pending_index + 1
        run["pendingCheckpoint"] = None
        self._kernel.backend.put_run(run_id, run)
        return {
            "reconciled": True,
            "pendingMessageCommitted": True,
            "headTurnNodeHash": branch["headTurnNodeHash"],
        }

    def complete(self, run_id: str, status: str, event_hash: str | None = None) -> dict[str, Any]:
        run = self._kernel.require_run(run_id)

        if run["status"] == "running":
            if status not in ("completed", "failed", "paused"):
                raise KernelRuntimeError(
                    "kernel_runtime_illegal_run_status_transition",
                    f"a running run cannot complete to status {status!r}",
                )
        elif run["status"] == "paused":
            if status != "failed":
                raise KernelRuntimeError(
                    "kernel_runtime_invalid_paused_run_completion",
                    "a paused run may only be explicitly resolved to 'failed'",
                )
        else:
            raise KernelRuntimeError(
                "kernel_runtime_illegal_run_status_transition",
                f"run {run_id} is already terminal ({run['status']})",
            )

        if event_hash is not None and not self._kernel.backend.has_object(event_hash):
            raise KernelRuntimeError(
                "kernel_runtime_missing_event_object", f"unknown event object: {event_hash}"
            )

        result: dict[str, Any] = {}
        staged = self._kernel.backend.list_staged(run_id)
        if staged and status != "paused":
            # Reactive checkpoint (Section 5.6): un-anchored staged work is
            # committed before the Run halts.
            branch = self._kernel.require_branch(run["branchId"])
            head_node = self._kernel.backend.get_node(branch["headTurnNodeHash"])
            assert head_node is not None
            new_tree_hash = self._kernel.tree.incorporate(head_node["turnTreeHash"], staged)
            node_hash = self._kernel.checkpoint(run, branch, new_tree_hash, event_hash, staged)
            run["createdTurnNodes"].append(node_hash)
            result["turnNodeHash"] = node_hash

        run["status"] = status
        self._kernel.backend.put_run(run_id, run)
        return result

    def recover(self, run_id: str) -> dict[str, Any]:
        # Section 5.7 / recovery-state CDDL: `consumedStagedResults` comes
        # from the run's own *last* TurnNode -- its most recent
        # `createdTurnNodes` entry, or its `startTurnNodeHash` when it has
        # not checkpointed yet -- never from the run's full checkpoint
        # history and never from the branch head (which can diverge from
        # this run's own last checkpoint once a later run moves on).
        run = self._kernel.require_run(run_id)
        created_nodes = run["createdTurnNodes"]
        last_turn_node_hash = created_nodes[-1] if created_nodes else run["startTurnNodeHash"]
        last_turn_node = self._kernel.backend.get_node(last_turn_node_hash)
        assert last_turn_node is not None  # every run-produced hash references a stored node
        return {
            "lastTurnNodeHash": last_turn_node_hash,
            "lastCompletedStepId": run["lastCompletedStepId"],
            "stepSequence": run["stepSequence"],
            "consumedStagedResults": list(last_turn_node["consumedStagedResults"]),
            "uncommittedStagedResults": self._kernel.backend.list_staged(run_id),
        }


class VerdictOps:
    """Section 6.5 verdict composition."""

    def compose(self, verdicts: list[dict[str, Any]]) -> dict[str, Any]:
        return compose_verdicts(verdicts)


class RuntimeKernel:
    """The M2 runtime kernel, decomposed into per-entity namespaces."""

    def __init__(self, backend: RuntimeBackend) -> None:
        self.backend = backend
        self._lease_token_ordinal = 0
        self.store = StoreOps(self)
        self.schema = SchemaOps(self)
        self.tree = TreeOps(self)
        self.node = NodeOps(self)
        self.thread = ThreadOps(self)
        self.branch = BranchOps(self)
        self.turn = TurnOps(self)
        self.staging = StagingOps(self)
        self.run = RunOps(self)
        self.verdicts = VerdictOps()

    # --- Shared lookups (raise, never return None to a namespace) ----------

    def require_schema(self, schema_id: str) -> dict[str, Any]:
        schema = self.backend.get_schema(schema_id)
        if schema is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_schema", f"unknown schema: {schema_id}"
            )
        return schema

    def require_thread(self, thread_id: str) -> dict[str, Any]:
        thread = self.backend.get_thread(thread_id)
        if thread is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_thread", f"unknown thread: {thread_id}"
            )
        return thread

    def require_branch(self, branch_id: str) -> dict[str, Any]:
        branch = self.backend.get_branch(branch_id)
        if branch is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_branch", f"unknown branch: {branch_id}"
            )
        return branch

    def require_run(self, run_id: str) -> dict[str, Any]:
        run = self.backend.get_run(run_id)
        if run is None:
            raise KernelRuntimeError("kernel_runtime_missing_run", f"unknown run: {run_id}")
        return run

    # --- Lineage (Section 4.3) ------------------------------------------------

    def verify_thread_membership(self, thread: dict[str, Any], node_hash: str) -> None:
        """Walk `previousTurnNodeHash` back from `node_hash` to a root.

        Raises `kernel_runtime_missing_turn_node` if the chain is broken,
        `turn_node_thread_mismatch` if it reaches a root other than
        `thread`'s own `rootTurnNodeHash` (Section 4.3's cross-thread
        rejection), or `kernel_runtime_lineage_walk_depth_exceeded` if the
        walk exceeds `_MAX_LINEAGE_WALK_DEPTH` hops without reaching a root
        (an adversarial or accidentally cyclic chain).
        """

        current = node_hash
        node = self.backend.get_node(current)
        if node is None:
            raise KernelRuntimeError(
                "kernel_runtime_missing_turn_node", f"unknown turn node: {current}"
            )

        depth = 0
        while node["previousTurnNodeHash"] is not None:
            depth += 1
            if depth > _MAX_LINEAGE_WALK_DEPTH:
                raise KernelRuntimeError(
                    "kernel_runtime_lineage_walk_depth_exceeded",
                    f"turn node lineage walk from {node_hash} exceeded "
                    f"{_MAX_LINEAGE_WALK_DEPTH} hops without reaching a root",
                )
            current = node["previousTurnNodeHash"]
            node = self.backend.get_node(current)
            if node is None:
                raise KernelRuntimeError(
                    "kernel_runtime_missing_turn_node", f"unknown turn node: {current}"
                )

        if current != thread["rootTurnNodeHash"]:
            raise KernelRuntimeError(
                "turn_node_thread_mismatch",
                f"turn node {node_hash} does not belong to thread {thread['threadId']}",
            )

    def reaches(self, from_hash: str, to_hash: str) -> bool:
        """Whether walking `previousTurnNodeHash` back from `from_hash` reaches `to_hash`.

        Raises `kernel_runtime_lineage_walk_depth_exceeded` if the walk
        exceeds `_MAX_LINEAGE_WALK_DEPTH` hops without resolving (Section
        4.2's head-movement classification must not loop unboundedly over
        an adversarial or accidentally cyclic chain).
        """

        current: str | None = from_hash
        depth = 0
        while current is not None:
            if current == to_hash:
                return True
            depth += 1
            if depth > _MAX_LINEAGE_WALK_DEPTH:
                raise KernelRuntimeError(
                    "kernel_runtime_lineage_walk_depth_exceeded",
                    f"turn node lineage walk from {from_hash} exceeded "
                    f"{_MAX_LINEAGE_WALK_DEPTH} hops without resolving",
                )
            node = self.backend.get_node(current)
            if node is None:
                return False
            current = node["previousTurnNodeHash"]
        return False

    def classify_head_movement(self, current_head: str, target: str) -> str:
        """Classify a `branch.setHead` move per Section 4.2 / Appendix A."""

        if self.reaches(target, current_head):
            return "forward"
        if self.reaches(current_head, target):
            return "backward"
        return "lateral"

    def next_archive_branch_id(self, branch_id: str) -> str:
        ordinal = 1
        while self.backend.get_branch(f"{branch_id}__archive_{ordinal}") is not None:
            ordinal += 1
        return f"{branch_id}__archive_{ordinal}"

    def next_lease_token(self, run_id: str) -> str:
        """A fresh, run-scoped Section 5.2 lease token.

        Ordinal-based rather than random, so the same backend/clock
        deterministically reproduces the same token sequence across runs --
        useful for conformance scenarios that need to construct a
        deliberately *stale* token to exercise `run_lease_token_mismatch`.
        """

        self._lease_token_ordinal += 1
        return f"lease:{run_id}:{self._lease_token_ordinal}"

    def begin_checkpoint(
        self,
        run: dict[str, Any],
        branch: dict[str, Any],
        tree_hash: str,
        event_hash: str | None,
        staged: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], str]:
        """Compute a Section 5.5 checkpoint's TurnNode identity and hash.

        Pure: performs no backend writes. Split out from `commit_checkpoint`
        so a caller (`RunOps.complete_step`) can durably record the
        checkpoint's identity as a `pendingCheckpoint` *before* attempting
        any of the writes `commit_checkpoint` performs -- see that method's
        docstring for why.
        """

        node_identity = {
            "schemaId": run["schemaId"],
            "turnTreeHash": tree_hash,
            "previousTurnNodeHash": branch["headTurnNodeHash"],
            "eventHash": event_hash,
            "consumedStagedResults": staged,
        }
        node_hash = identity.hash_kernel_record(node_identity)
        return node_identity, node_hash

    def commit_checkpoint(
        self,
        run: dict[str, Any],
        branch: dict[str, Any],
        node_hash: str,
        node_identity: dict[str, Any],
    ) -> None:
        """Section 5.5 checkpoint transaction: write TurnNode, advance Head, clear staging.

        Guards against a concurrent writer that already moved `branch`'s
        head since this checkpoint's base was read: re-reads the branch
        from the backend and rejects with a typed
        `kernel_runtime_checkpoint_lateral_conflict` (distinct from a
        generic exception, so a caller can positively identify "someone
        else committed first" rather than a storage failure) instead of
        silently overwriting a sibling checkpoint the losing writer never
        saw.
        """

        current_branch = self.backend.get_branch(branch["branchId"])
        if (
            current_branch is None
            or current_branch["headTurnNodeHash"] != branch["headTurnNodeHash"]
        ):
            raise KernelRuntimeError(
                "kernel_runtime_checkpoint_lateral_conflict",
                f"branch {branch['branchId']} head moved before this checkpoint committed",
            )

        self.backend.put_node(node_hash, {**node_identity, "hash": node_hash})
        self.backend.put_branch(branch["branchId"], {**branch, "headTurnNodeHash": node_hash})
        self.backend.clear_staged(run["runId"])

    def checkpoint(
        self,
        run: dict[str, Any],
        branch: dict[str, Any],
        tree_hash: str,
        event_hash: str | None,
        staged: list[dict[str, Any]],
    ) -> str:
        """Section 5.5 checkpoint transaction: write TurnNode, advance Head, clear staging."""

        node_identity, node_hash = self.begin_checkpoint(run, branch, tree_hash, event_hash, staged)
        self.commit_checkpoint(run, branch, node_hash, node_identity)
        return node_hash
