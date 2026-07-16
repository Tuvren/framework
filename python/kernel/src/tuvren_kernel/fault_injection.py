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

"""A fault-injecting `RuntimeBackend` decorator for milestone M3's restart-
recovery conformance surface.

Mirrors the shape of `typescript/kernel/testkit/src/lib/fault-injecting-
backend.ts`, adapted to this port's simpler (non-transactional)
`RuntimeBackend` seam: the TypeScript backend wraps one `transact` call and
injects a fault via commit-sequence hooks the wrapped backend exposes;
`tuvren_kernel.backend.RuntimeBackend` has no `transact` concept -- Section
5.5's checkpoint transaction (`docs/KrakenKernelSpecification.md`) is instead
three sequential backend calls `RuntimeKernel.commit_checkpoint` makes
directly (`put_node`, then `put_branch`, then `clear_staged` -- see
`runtime.py`), so this decorator hooks those three calls in place of a
transaction boundary:

- `beforeCommit` fires before `put_node` is even attempted: the checkpoint's
  TurnNode is never written, so recovery afterward sees the checkpoint as
  entirely absent.
- `midCommit` fires immediately after `put_node` durably commits, before
  `put_branch`/`clear_staged` run. This leaves genuinely partial backend
  state -- the TurnNode object exists, but the branch head has not advanced
  and staging has not cleared -- for `RunOps.reconcile` to roll forward.
- `afterCommitBeforeAck` fires after `clear_staged` completes, i.e. after all
  three checkpoint writes are durable: backend state is already fully
  committed: only the caller's acknowledgment (returning from
  `RunOps.complete_step`, and `RunOps` finishing its own run-record
  bookkeeping) never happens.

Every other `RuntimeBackend` method passes straight through to `inner`
unmodified.
"""

from __future__ import annotations

from typing import Any, Literal

from tuvren_kernel.backend import RuntimeBackend
from tuvren_kernel.errors import KernelRuntimeError

FaultPoint = Literal["beforeCommit", "midCommit", "afterCommitBeforeAck"]
FaultPolicy = Literal["once", "always"]

# Normative per the M3 worker brief and both restart-recovery conformance
# plans' `injectedErrorCode` assertions.
INJECTED_FAULT_CODE = "kernel_persistence_fault_injected"


class FaultInjectingBackend:
    """Wraps a `RuntimeBackend`, injecting `kernel_persistence_fault_injected`
    at a chosen point in the Section 5.5 checkpoint write sequence.

    `policy="once"` (the default every conformance operation in this port
    uses) injects the fault on the first matching write and lets every
    later write through unmodified; `policy="always"` keeps injecting on
    every matching write.
    """

    def __init__(
        self,
        inner: RuntimeBackend,
        fault_point: FaultPoint,
        policy: FaultPolicy = "once",
    ) -> None:
        self._inner = inner
        self._fault_point = fault_point
        self._policy = policy
        self._fired = False

    @property
    def scope(self) -> str:
        return self._inner.scope

    def now(self) -> int:
        return self._inner.now()

    def _maybe_fire(self, point: FaultPoint) -> None:
        if point != self._fault_point:
            return
        if self._fired and self._policy == "once":
            return
        self._fired = True
        raise KernelRuntimeError(
            INJECTED_FAULT_CODE, f"fault injected at checkpoint write point: {point}"
        )

    # --- Objects -------------------------------------------------------------
    def put_object(self, data: bytes) -> str:
        return self._inner.put_object(data)

    def get_object(self, object_hash: str) -> bytes | None:
        return self._inner.get_object(object_hash)

    def has_object(self, object_hash: str) -> bool:
        return self._inner.has_object(object_hash)

    # --- Schemas ---------------------------------------------------------------
    def put_schema(self, schema_id: str, schema: dict[str, Any]) -> None:
        self._inner.put_schema(schema_id, schema)

    def get_schema(self, schema_id: str) -> dict[str, Any] | None:
        return self._inner.get_schema(schema_id)

    # --- TurnTrees -----------------------------------------------------------
    def put_tree(self, tree_hash: str, record: dict[str, Any]) -> None:
        self._inner.put_tree(tree_hash, record)

    def get_tree(self, tree_hash: str) -> dict[str, Any] | None:
        return self._inner.get_tree(tree_hash)

    # --- TurnNodes: the beforeCommit / midCommit fault points -------------------
    def put_node(self, node_hash: str, record: dict[str, Any]) -> None:
        self._maybe_fire("beforeCommit")
        self._inner.put_node(node_hash, record)
        self._maybe_fire("midCommit")

    def get_node(self, node_hash: str) -> dict[str, Any] | None:
        return self._inner.get_node(node_hash)

    # --- Threads ---------------------------------------------------------------
    def put_thread(self, thread_id: str, record: dict[str, Any]) -> None:
        self._inner.put_thread(thread_id, record)

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        return self._inner.get_thread(thread_id)

    def list_threads(self) -> list[dict[str, Any]]:
        return self._inner.list_threads()

    # --- Branches ---------------------------------------------------------------
    def put_branch(self, branch_id: str, record: dict[str, Any]) -> None:
        self._inner.put_branch(branch_id, record)

    def get_branch(self, branch_id: str) -> dict[str, Any] | None:
        return self._inner.get_branch(branch_id)

    def list_branches(self, thread_id: str) -> list[dict[str, Any]]:
        return self._inner.list_branches(thread_id)

    # --- Turns -----------------------------------------------------------------
    def put_turn(self, turn_id: str, record: dict[str, Any]) -> None:
        self._inner.put_turn(turn_id, record)

    def get_turn(self, turn_id: str) -> dict[str, Any] | None:
        return self._inner.get_turn(turn_id)

    # --- Runs --------------------------------------------------------------------
    def put_run(self, run_id: str, record: dict[str, Any]) -> None:
        self._inner.put_run(run_id, record)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        return self._inner.get_run(run_id)

    def list_runs_for_branch(self, branch_id: str) -> list[dict[str, Any]]:
        return self._inner.list_runs_for_branch(branch_id)

    def list_all_runs(self) -> list[dict[str, Any]]:
        return self._inner.list_all_runs()

    # --- Staging: the afterCommitBeforeAck fault point ---------------------------
    def append_staged(self, run_id: str, staged_result: dict[str, Any]) -> None:
        self._inner.append_staged(run_id, staged_result)

    def list_staged(self, run_id: str) -> list[dict[str, Any]]:
        return self._inner.list_staged(run_id)

    def clear_staged(self, run_id: str) -> None:
        self._inner.clear_staged(run_id)
        self._maybe_fire("afterCommitBeforeAck")

    def capabilities(self) -> dict[str, bool]:
        return self._inner.capabilities()  # type: ignore[attr-defined]
