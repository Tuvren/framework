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

"""The storage seam `tuvren_kernel.runtime.RuntimeKernel` is built over.

`docs/KrakenKernelSpecification.md` Section 8.1 defines the kernel's
persistence requirements as *observable behavioral guarantees* (atomic
single/multi-entity writes, durable visibility, read-after-write
consistency), not as a dependency on a specific storage product. This module
is the Python port's seam for that: `RuntimeBackend` is the storage protocol
`tuvren_kernel.runtime.RuntimeKernel` is written against (mirroring the
TypeScript `@tuvren/kernel-protocol` `RuntimeBackend` interface's
decomposition into per-entity repositories), and `InMemoryBackend` is the
one implementation this milestone ships -- a plain-dict store that upholds
those guarantees trivially (everything is already atomic and durably
visible within one process) so later milestones can add `backend-sqlite` /
`backend-postgres` equivalents behind the same seam without touching
`runtime.py`.

Two constructor-only parameters this milestone plumbs through but does not
yet exercise, per Section 2.3 ("Scope-resolved identity") and the M2
worker brief: `scope` (a host-bound partition identity -- not a kernel
syscall argument, so it never appears on any `RuntimeKernel` method) and
`now` (an injected clock, used today only to stamp `Thread.createdAtMs` for
`thread.list` ordering, per Section 9.3). Both exist so a later milestone's
cross-Scope isolation and lease-clock-skew conformance checks have a seam to
attach to without a `RuntimeBackend` constructor signature change.
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

DEFAULT_SCOPE = "tuvren.scope.default"


def _default_clock() -> int:
    return 0


class RuntimeBackend(Protocol):
    """Storage protocol `RuntimeKernel` is written against.

    Every method is a direct, unvalidated durable-storage primitive --
    `RuntimeKernel` in `runtime.py` owns all Appendix-B validation and
    Section 5/6 semantics; this protocol only owns durability and lookup.

    Every getter (`get_*`, `list_*`) returns a copy of the stored record(s),
    never a live reference into backend-internal state: a caller (including
    `runtime.py`, which routinely mutates a fetched record in place before
    writing it back through the matching `put_*`) must not be able to
    corrupt durable state just by holding onto and mutating a returned
    value. `InMemoryBackend` upholds this with `copy.deepcopy` on every read
    path; a future `backend-sqlite`/`backend-postgres` port must uphold the
    same guarantee, deserializing a fresh value per call.
    """

    scope: str

    def now(self) -> int: ...

    # --- Objects (Section 2) -------------------------------------------
    def put_object(self, data: bytes) -> str: ...
    def get_object(self, object_hash: str) -> bytes | None: ...
    def has_object(self, object_hash: str) -> bool: ...

    # --- Schemas (Section 3.1) -------------------------------------------
    def put_schema(self, schema_id: str, schema: dict[str, Any]) -> None: ...
    def get_schema(self, schema_id: str) -> dict[str, Any] | None: ...

    # --- TurnTrees (Section 3.2) -----------------------------------------
    def put_tree(self, tree_hash: str, record: dict[str, Any]) -> None: ...
    def get_tree(self, tree_hash: str) -> dict[str, Any] | None: ...

    # --- TurnNodes (Section 3.3) -----------------------------------------
    def put_node(self, node_hash: str, record: dict[str, Any]) -> None: ...
    def get_node(self, node_hash: str) -> dict[str, Any] | None: ...

    # --- Threads (Section 4.1) -------------------------------------------
    def put_thread(self, thread_id: str, record: dict[str, Any]) -> None: ...
    def get_thread(self, thread_id: str) -> dict[str, Any] | None: ...
    def list_threads(self) -> list[dict[str, Any]]: ...

    # --- Branches (Section 4.2) ------------------------------------------
    def put_branch(self, branch_id: str, record: dict[str, Any]) -> None: ...
    def get_branch(self, branch_id: str) -> dict[str, Any] | None: ...
    def list_branches(self, thread_id: str) -> list[dict[str, Any]]: ...

    # --- Turns (Section 5.3) ----------------------------------------------
    def put_turn(self, turn_id: str, record: dict[str, Any]) -> None: ...
    def get_turn(self, turn_id: str) -> dict[str, Any] | None: ...

    # --- Runs (Section 5.2) ------------------------------------------------
    def put_run(self, run_id: str, record: dict[str, Any]) -> None: ...
    def get_run(self, run_id: str) -> dict[str, Any] | None: ...
    def list_runs_for_branch(self, branch_id: str) -> list[dict[str, Any]]: ...
    def list_all_runs(self) -> list[dict[str, Any]]: ...

    # --- Staging (Section 3.4) ---------------------------------------------
    def append_staged(self, run_id: str, staged_result: dict[str, Any]) -> None: ...
    def list_staged(self, run_id: str) -> list[dict[str, Any]]: ...
    def clear_staged(self, run_id: str) -> None: ...


@dataclass
class InMemoryBackend:
    """The one first-party `RuntimeBackend` this milestone ships.

    All first-party backends advertise `thread.enumeration: true`
    (`docs/KrakenKernelSpecification.md` Section 9.2); this in-memory
    backend is no exception, so `RuntimeKernel.thread.list` never rejects
    against it with `kernel_capability_unsupported`.
    """

    scope: str = DEFAULT_SCOPE
    now: Callable[[], int] = field(default=_default_clock)

    _objects: dict[str, bytes] = field(default_factory=dict)
    _schemas: dict[str, dict[str, Any]] = field(default_factory=dict)
    _trees: dict[str, dict[str, Any]] = field(default_factory=dict)
    _nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    _threads: dict[str, dict[str, Any]] = field(default_factory=dict)
    _branches: dict[str, dict[str, Any]] = field(default_factory=dict)
    _turns: dict[str, dict[str, Any]] = field(default_factory=dict)
    _runs: dict[str, dict[str, Any]] = field(default_factory=dict)
    _staged: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def capabilities(self) -> dict[str, bool]:
        return {"thread.enumeration": True}

    # --- Objects -----------------------------------------------------------
    def put_object(self, data: bytes) -> str:
        from tuvren_kernel.identity import hash_raw_bytes

        object_hash = hash_raw_bytes(data)
        # `store.put` is write-once and idempotent (Section 2.4): putting the
        # same content twice must not raise or overwrite.
        self._objects.setdefault(object_hash, bytes(data))
        return object_hash

    def get_object(self, object_hash: str) -> bytes | None:
        return self._objects.get(object_hash)

    def has_object(self, object_hash: str) -> bool:
        return object_hash in self._objects

    # --- Schemas -------------------------------------------------------------
    def put_schema(self, schema_id: str, schema: dict[str, Any]) -> None:
        self._schemas[schema_id] = schema

    def get_schema(self, schema_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._schemas.get(schema_id))

    # --- TurnTrees -----------------------------------------------------------
    def put_tree(self, tree_hash: str, record: dict[str, Any]) -> None:
        self._trees.setdefault(tree_hash, record)

    def get_tree(self, tree_hash: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._trees.get(tree_hash))

    # --- TurnNodes -----------------------------------------------------------
    def put_node(self, node_hash: str, record: dict[str, Any]) -> None:
        self._nodes.setdefault(node_hash, record)

    def get_node(self, node_hash: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._nodes.get(node_hash))

    # --- Threads -------------------------------------------------------------
    def put_thread(self, thread_id: str, record: dict[str, Any]) -> None:
        self._threads[thread_id] = record

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._threads.get(thread_id))

    def list_threads(self) -> list[dict[str, Any]]:
        return copy.deepcopy(list(self._threads.values()))

    # --- Branches ------------------------------------------------------------
    def put_branch(self, branch_id: str, record: dict[str, Any]) -> None:
        self._branches[branch_id] = record

    def get_branch(self, branch_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._branches.get(branch_id))

    def list_branches(self, thread_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy([b for b in self._branches.values() if b["threadId"] == thread_id])

    # --- Turns -----------------------------------------------------------------
    def put_turn(self, turn_id: str, record: dict[str, Any]) -> None:
        self._turns[turn_id] = record

    def get_turn(self, turn_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._turns.get(turn_id))

    # --- Runs --------------------------------------------------------------------
    def put_run(self, run_id: str, record: dict[str, Any]) -> None:
        self._runs[run_id] = record

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._runs.get(run_id))

    def list_runs_for_branch(self, branch_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy([r for r in self._runs.values() if r["branchId"] == branch_id])

    def list_all_runs(self) -> list[dict[str, Any]]:
        # Milestone M3's run-liveness expiry listing (Section 5.2 / ADR-050)
        # scans across every branch a run may live on -- `run.create`
        # already forbids two simultaneously-active runs sharing one branch
        # (Appendix B), so an expired-running run and an excluded paused run
        # can never coexist on the same branch, and this milestone's
        # conformance scenarios deliberately spread them across branches.
        return copy.deepcopy(list(self._runs.values()))

    # --- Staging -------------------------------------------------------------------
    def append_staged(self, run_id: str, staged_result: dict[str, Any]) -> None:
        self._staged.setdefault(run_id, []).append(staged_result)

    def list_staged(self, run_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy(self._staged.get(run_id, []))

    def clear_staged(self, run_id: str) -> None:
        self._staged[run_id] = []
