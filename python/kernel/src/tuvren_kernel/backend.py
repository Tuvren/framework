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
`thread.list` ordering, per Section 9.3).

Milestone M4 exercises both of those seams for real:

- `scope` now drives genuine cross-Scope isolation (Section 2.3 / 9.4):
  `create_scoped_backend_pair` binds two `InMemoryBackend` handles with
  distinct `scope` identities to one shared `_SharedTables` substrate, and
  every read/write path below keys its physical storage by `(scope, id)` --
  never bare `id` -- so a handle constructed with scope B can never observe,
  enumerate, or overwrite scope A's durable state, and vice versa, even
  though both handles share the same underlying dicts.
- Every hash-addressed entity (`Object`, `TurnTree`, `TurnNode`) now also
  records its own creation timestamp (via `now()`), and every entity family
  gained `list_*_hashes` / `get_*_created_at` / `delete_*` primitives so
  `RuntimeKernel`'s Section 9.4 reachability-reclamation sweep (see
  `runtime.py`'s `MaintenanceOps`) can enumerate, timestamp-filter, and
  release durable state through this seam without ever reaching past it
  into backend-internal dict state.
- `compare_and_swap_branch_head` closes the read-compare-write race
  `RuntimeKernel.commit_checkpoint` used to have between reading a Branch's
  current head and writing its advanced head back: the whole
  compare-and-conditionally-write happens as one backend-owned atomic
  primitive instead.
"""

from __future__ import annotations

import copy
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

DEFAULT_SCOPE = "tuvren.scope.default"

_SCOPE_KEY_SEPARATOR = "\x1f"


def _default_clock() -> int:
    return 0


class RuntimeBackend(Protocol):
    """Storage protocol `RuntimeKernel` is written against.

    Every method is a direct, unvalidated durable-storage primitive --
    `RuntimeKernel` in `runtime.py` owns all Appendix-B validation and
    Section 5/6 semantics; this protocol only owns durability, lookup, and
    (Section 9.4) reachability-reclamation's raw enumerate/timestamp/release
    primitives.

    Every getter (`get_*`, `list_*`) returns a copy of the stored record(s),
    never a live reference into backend-internal state: a caller (including
    `runtime.py`, which routinely mutates a fetched record in place before
    writing it back through the matching `put_*`) must not be able to
    corrupt durable state just by holding onto and mutating a returned
    value. `InMemoryBackend` upholds this with `copy.deepcopy` on every read
    path; a future `backend-sqlite`/`backend-postgres` port must uphold the
    same guarantee, deserializing a fresh value per call.

    Every method here is Scope-confined (Section 2.3): a backend handle only
    ever observes, enumerates, or mutates durable state that was written
    through a handle constructed with the same `scope` identity, even when
    two handles share one physical substrate (see `create_scoped_backend_pair`).
    """

    scope: str

    def now(self) -> int: ...

    def capabilities(self) -> dict[str, bool]: ...

    # --- Objects (Section 2) -------------------------------------------
    def put_object(self, data: bytes) -> str: ...
    def get_object(self, object_hash: str) -> bytes | None: ...
    def has_object(self, object_hash: str) -> bool: ...
    def get_object_created_at(self, object_hash: str) -> int | None: ...
    def list_object_hashes(self) -> list[str]: ...
    def delete_object(self, object_hash: str) -> None: ...

    # --- Schemas (Section 3.1) -------------------------------------------
    def put_schema(self, schema_id: str, schema: dict[str, Any]) -> None: ...
    def get_schema(self, schema_id: str) -> dict[str, Any] | None: ...

    # --- TurnTrees (Section 3.2) -----------------------------------------
    def put_tree(self, tree_hash: str, record: dict[str, Any]) -> None: ...
    def get_tree(self, tree_hash: str) -> dict[str, Any] | None: ...
    def get_tree_created_at(self, tree_hash: str) -> int | None: ...
    def list_tree_hashes(self) -> list[str]: ...
    def delete_tree(self, tree_hash: str) -> None: ...

    # --- TurnNodes (Section 3.3) -----------------------------------------
    def put_node(self, node_hash: str, record: dict[str, Any]) -> None: ...
    def get_node(self, node_hash: str) -> dict[str, Any] | None: ...
    def get_node_created_at(self, node_hash: str) -> int | None: ...
    def list_node_hashes(self) -> list[str]: ...
    def delete_node(self, node_hash: str) -> None: ...

    # --- Threads (Section 4.1) -------------------------------------------
    def put_thread(self, thread_id: str, record: dict[str, Any]) -> None: ...
    def get_thread(self, thread_id: str) -> dict[str, Any] | None: ...
    def list_threads(self) -> list[dict[str, Any]]: ...

    # --- Branches (Section 4.2) ------------------------------------------
    def put_branch(self, branch_id: str, record: dict[str, Any]) -> None: ...
    def get_branch(self, branch_id: str) -> dict[str, Any] | None: ...
    def list_branches(self, thread_id: str) -> list[dict[str, Any]]: ...
    def list_all_branches(self) -> list[dict[str, Any]]: ...
    def delete_branch(self, branch_id: str) -> None: ...
    def compare_and_swap_branch_head(
        self, branch_id: str, expected_head: str, new_head: str
    ) -> bool: ...

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
class _SharedTables:
    """The physical substrate one or more `InMemoryBackend` handles bind to.

    A single `InMemoryBackend()` constructs its own private `_SharedTables`
    (the M2/M3 behavior: one backend, one substrate, no sharing). Section
    9.4/2.3 cross-Scope isolation instead constructs one `_SharedTables` and
    hands it to two `InMemoryBackend` handles with distinct `scope` values
    via `create_scoped_backend_pair` -- every key those handles write is
    Scope-prefixed (see `InMemoryBackend._key`), so the sharing is purely
    physical; logically the two handles observe disjoint state.

    `lock` backs `compare_and_swap_branch_head`'s atomicity: one
    `threading.Lock` per substrate, held only for the single
    read-compare-write critical section, so a compare-and-swap on this
    substrate is never interleaved with another compare-and-swap on the same
    substrate even though every conformance scenario today is single
    threaded.
    """

    objects: dict[str, bytes] = field(default_factory=dict)
    objects_created_at: dict[str, int] = field(default_factory=dict)
    schemas: dict[str, dict[str, Any]] = field(default_factory=dict)
    trees: dict[str, dict[str, Any]] = field(default_factory=dict)
    trees_created_at: dict[str, int] = field(default_factory=dict)
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    nodes_created_at: dict[str, int] = field(default_factory=dict)
    threads: dict[str, dict[str, Any]] = field(default_factory=dict)
    branches: dict[str, dict[str, Any]] = field(default_factory=dict)
    turns: dict[str, dict[str, Any]] = field(default_factory=dict)
    runs: dict[str, dict[str, Any]] = field(default_factory=dict)
    staged: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class InMemoryBackend:
    """The one first-party `RuntimeBackend` this milestone ships.

    All first-party backends advertise `thread.enumeration: true`
    (`docs/KrakenKernelSpecification.md` Section 9.2) and
    `maintenance.reclamation: true` (Section 9.4); this in-memory backend is
    no exception, so `RuntimeKernel.thread.list` / `RuntimeKernel.
    maintenance.reclaim` never reject against it with
    `kernel_capability_unsupported`.
    """

    scope: str = DEFAULT_SCOPE
    now: Callable[[], int] = field(default=_default_clock)
    _shared: _SharedTables = field(default_factory=_SharedTables)

    def capabilities(self) -> dict[str, bool]:
        return {"thread.enumeration": True, "maintenance.reclamation": True}

    # --- Scope-keying helpers ------------------------------------------------

    def _key(self, raw_id: str) -> str:
        return f"{self.scope}{_SCOPE_KEY_SEPARATOR}{raw_id}"

    def _scope_prefix(self) -> str:
        return f"{self.scope}{_SCOPE_KEY_SEPARATOR}"

    def _own_scope_items(self, table: dict[str, Any]) -> list[tuple[str, Any]]:
        prefix = self._scope_prefix()
        return [(key, value) for key, value in table.items() if key.startswith(prefix)]

    # --- Objects -----------------------------------------------------------
    def put_object(self, data: bytes) -> str:
        from tuvren_kernel.identity import hash_raw_bytes

        object_hash = hash_raw_bytes(data)
        key = self._key(object_hash)
        # `store.put` is write-once and idempotent (Section 2.4): putting the
        # same content twice must not raise, overwrite, or re-stamp the
        # object's creation timestamp.
        if key not in self._shared.objects:
            self._shared.objects[key] = bytes(data)
            self._shared.objects_created_at[key] = self.now()
        return object_hash

    def get_object(self, object_hash: str) -> bytes | None:
        return self._shared.objects.get(self._key(object_hash))

    def has_object(self, object_hash: str) -> bool:
        return self._key(object_hash) in self._shared.objects

    def get_object_created_at(self, object_hash: str) -> int | None:
        return self._shared.objects_created_at.get(self._key(object_hash))

    def list_object_hashes(self) -> list[str]:
        prefix = self._scope_prefix()
        return [key[len(prefix) :] for key in self._shared.objects if key.startswith(prefix)]

    def delete_object(self, object_hash: str) -> None:
        key = self._key(object_hash)
        self._shared.objects.pop(key, None)
        self._shared.objects_created_at.pop(key, None)

    # --- Schemas -------------------------------------------------------------
    def put_schema(self, schema_id: str, schema: dict[str, Any]) -> None:
        self._shared.schemas[self._key(schema_id)] = schema

    def get_schema(self, schema_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.schemas.get(self._key(schema_id)))

    # --- TurnTrees -----------------------------------------------------------
    def put_tree(self, tree_hash: str, record: dict[str, Any]) -> None:
        key = self._key(tree_hash)
        if key not in self._shared.trees:
            self._shared.trees[key] = record
            self._shared.trees_created_at[key] = self.now()

    def get_tree(self, tree_hash: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.trees.get(self._key(tree_hash)))

    def get_tree_created_at(self, tree_hash: str) -> int | None:
        return self._shared.trees_created_at.get(self._key(tree_hash))

    def list_tree_hashes(self) -> list[str]:
        prefix = self._scope_prefix()
        return [key[len(prefix) :] for key in self._shared.trees if key.startswith(prefix)]

    def delete_tree(self, tree_hash: str) -> None:
        key = self._key(tree_hash)
        self._shared.trees.pop(key, None)
        self._shared.trees_created_at.pop(key, None)

    # --- TurnNodes -----------------------------------------------------------
    def put_node(self, node_hash: str, record: dict[str, Any]) -> None:
        key = self._key(node_hash)
        if key not in self._shared.nodes:
            self._shared.nodes[key] = record
            self._shared.nodes_created_at[key] = self.now()

    def get_node(self, node_hash: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.nodes.get(self._key(node_hash)))

    def get_node_created_at(self, node_hash: str) -> int | None:
        return self._shared.nodes_created_at.get(self._key(node_hash))

    def list_node_hashes(self) -> list[str]:
        prefix = self._scope_prefix()
        return [key[len(prefix) :] for key in self._shared.nodes if key.startswith(prefix)]

    def delete_node(self, node_hash: str) -> None:
        key = self._key(node_hash)
        self._shared.nodes.pop(key, None)
        self._shared.nodes_created_at.pop(key, None)

    # --- Threads -------------------------------------------------------------
    def put_thread(self, thread_id: str, record: dict[str, Any]) -> None:
        self._shared.threads[self._key(thread_id)] = record

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.threads.get(self._key(thread_id)))

    def list_threads(self) -> list[dict[str, Any]]:
        return copy.deepcopy([value for _, value in self._own_scope_items(self._shared.threads)])

    # --- Branches ------------------------------------------------------------
    def put_branch(self, branch_id: str, record: dict[str, Any]) -> None:
        self._shared.branches[self._key(branch_id)] = record

    def get_branch(self, branch_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.branches.get(self._key(branch_id)))

    def list_branches(self, thread_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy(
            [
                value
                for _, value in self._own_scope_items(self._shared.branches)
                if value["threadId"] == thread_id
            ]
        )

    def list_all_branches(self) -> list[dict[str, Any]]:
        return copy.deepcopy([value for _, value in self._own_scope_items(self._shared.branches)])

    def delete_branch(self, branch_id: str) -> None:
        self._shared.branches.pop(self._key(branch_id), None)

    def compare_and_swap_branch_head(
        self, branch_id: str, expected_head: str, new_head: str
    ) -> bool:
        """Atomically move `branch_id`'s head iff it is still `expected_head`.

        The single primitive `RuntimeKernel.commit_checkpoint` uses in place
        of its old read-then-compare-then-`put_branch` sequence: the read,
        the comparison, and the write all happen inside one critical
        section, so no other writer's checkpoint can land between this
        method's read and write.
        """

        key = self._key(branch_id)
        with self._shared.lock:
            current = self._shared.branches.get(key)
            if current is None or current["headTurnNodeHash"] != expected_head:
                return False
            self._shared.branches[key] = {**current, "headTurnNodeHash": new_head}
            return True

    # --- Turns -----------------------------------------------------------------
    def put_turn(self, turn_id: str, record: dict[str, Any]) -> None:
        self._shared.turns[self._key(turn_id)] = record

    def get_turn(self, turn_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.turns.get(self._key(turn_id)))

    # --- Runs --------------------------------------------------------------------
    def put_run(self, run_id: str, record: dict[str, Any]) -> None:
        self._shared.runs[self._key(run_id)] = record

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self._shared.runs.get(self._key(run_id)))

    def list_runs_for_branch(self, branch_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy(
            [
                value
                for _, value in self._own_scope_items(self._shared.runs)
                if value["branchId"] == branch_id
            ]
        )

    def list_all_runs(self) -> list[dict[str, Any]]:
        # Milestone M3's run-liveness expiry listing (Section 5.2 / ADR-050)
        # scans across every branch a run may live on -- `run.create`
        # already forbids two simultaneously-active runs sharing one branch
        # (Appendix B), so an expired-running run and an excluded paused run
        # can never coexist on the same branch, and this milestone's
        # conformance scenarios deliberately spread them across branches.
        return copy.deepcopy([value for _, value in self._own_scope_items(self._shared.runs)])

    # --- Staging -------------------------------------------------------------------
    def append_staged(self, run_id: str, staged_result: dict[str, Any]) -> None:
        self._shared.staged.setdefault(self._key(run_id), []).append(staged_result)

    def list_staged(self, run_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy(self._shared.staged.get(self._key(run_id), []))

    def clear_staged(self, run_id: str) -> None:
        self._shared.staged[self._key(run_id)] = []


def create_scoped_backend_pair(
    scope_a: str, scope_b: str, now: Callable[[], int] = _default_clock
) -> tuple[InMemoryBackend, InMemoryBackend]:
    """Two `InMemoryBackend` handles bound to one shared substrate.

    Section 2.3 / 9.4's cross-Scope isolation seam: `scope_a` and `scope_b`
    must differ (the conformance adapter's cross-scope probe always passes
    two distinct Scope identities), and every entity either handle writes is
    invisible to the other -- `store.has`/`store.get` report false/null,
    `thread.list` never enumerates the other Scope's Threads -- because
    every physical key both handles write through `InMemoryBackend._key` is
    Scope-prefixed against this one shared `_SharedTables`.
    """

    shared = _SharedTables()
    return (
        InMemoryBackend(scope=scope_a, now=now, _shared=shared),
        InMemoryBackend(scope=scope_b, now=now, _shared=shared),
    )
