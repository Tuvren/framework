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

"""`kernel.protocol` operation handlers backing the Python conformance adapter.

Each handler receives the JSON-RPC `dispatch` call's `params.input` (the
compiled adapter input, i.e. `{"checkInput": ..., "fixture": <fixture json
or None>}`; see `tools/conformance/harness/run.ts::createAdapterInput`) and
returns the `AdapterObservation` value the harness reads assertions from.

Per the adapter hard rules this module never receives a check identifier,
never grades pass/fail, and never emits evidence itself -- it only *computes* the
`tuvren_kernel` semantics a conformance plan's assertions read back out of
`$.result...` / `$.evidence...`. The `{"result": obs, "evidence": obs}`
envelope shape mirrors `rust/kernel-conformance-adapter/src/main.rs`'s
`projection()` helper, which the harness's `createResultContext` unwraps
(`outcome.value.result` / `outcome.value.evidence`) to build assertion
context -- this is a protocol requirement of the shared harness, not an
adapter-invented shape.

This module itself stays slim: it hosts only the helpers genuinely shared
across every operation family (fixture parsing, the observation envelope,
canonical-schema loading, the deterministic-clock test double, and semantic
error capture) and assembles the single `OPERATIONS` routing table from the
concern-scoped submodules below, mirroring the Go port's split of the same
surface into `operations.go` / `operations_runtime.go` /
`operations_liveness.go` / `operations_maintenance.go`:

- `operations_protocol.py` -- `kernel.protocol.deterministic-hashing`,
  `kernel.protocol.schema-roundtrip`, `kernel.protocol.modify-composition`.
- `operations_runtime.py` -- `kernel.logical.*`, `kernel.lineage.*`, and
  `kernel.protocol.edge-validation` (edge-validation exercises the same
  logical/schema/run runtime surface as the other operations in this file,
  not the wire-level protocol surface `operations_protocol.py` covers).
- `operations_liveness.py` -- `kernel.run-liveness.*` and
  `kernel.restart-recovery.*`.
- `operations_maintenance.py` -- `kernel.scope-isolation.*` and
  `kernel.reclamation.*`.

Per the authority-guardrails constraint, operation-name string literals
(the `OPERATIONS` dict keys) live only in this file's routing table.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tuvren_kernel.backend import InMemoryBackend
from tuvren_kernel.errors import KernelRuntimeError
from tuvren_kernel.records import RecordValidationError, normalize_turn_tree_schema
from tuvren_kernel.runtime import RuntimeKernel

# `python/kernel-conformance-adapter/src/tuvren_kernel_adapter/operations.py`
# -> parents[4] is the repository root, mirroring the fixture-path derivation
# `python/kernel/tests/test_kernel_records.py` already uses for the sibling
# `spec/conformance/kernel/fixtures/` tree.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_CANONICAL_SCHEMA_PATH = (
    _REPO_ROOT / "spec" / "conformance" / "kernel" / "fixtures" / "canonical-turn-tree-schema.json"
)

_canonical_schema_cache: dict[str, Any] | None = None


class OperationInputError(Exception):
    """Raised when adapter input does not match what an operation expects.

    The adapter's dispatch seam (`tuvren_kernel_adapter.__main__.
    handle_dispatch`) catches `AdapterOperationError`, not this type
    directly -- handlers raise `OperationInputError` and the dispatch
    wrapper below translates it, keeping the error *code* naming
    (`missing_value`, `invalid_object_fixture`, ...) aligned with
    `rust/kernel-conformance-adapter/src/main.rs`'s `KernelError` codes for
    cross-language consistency, without importing the Rust adapter's types.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _read_fixture(operation_input: Any) -> dict[str, Any]:
    if not isinstance(operation_input, dict):
        raise OperationInputError("missing_value", "adapter input is required for this operation")
    fixture = operation_input.get("fixture")
    if not isinstance(fixture, dict):
        raise OperationInputError(
            "invalid_object_fixture", "adapter input fixture must be an object"
        )
    return fixture


def _read_u8_array(value: Any, label: str) -> bytes:
    if not isinstance(value, list):
        raise OperationInputError("invalid_array_fixture", f"{label} must be an array")
    out = bytearray()
    for entry in value:
        if isinstance(entry, bool) or not isinstance(entry, int) or not (0 <= entry <= 255):
            raise OperationInputError("invalid_byte_fixture", f"{label} must contain bytes")
        out.append(entry)
    return bytes(out)


def _projection(evidence: dict[str, Any]) -> dict[str, Any]:
    return {"evidence": evidence, "result": evidence}


def _load_canonical_schema() -> dict[str, Any]:
    """Load & cache `spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json`.

    This is the one schema every `kernel.logical.*` / `kernel.lineage.*` /
    `kernel.protocol.edge-validation` scenario registers, matching
    `loadCanonicalSchema` in the TypeScript adapter's `host-support.ts` and
    the Rust adapter's equivalent -- the schema itself is authority (shared
    across every conformance adapter), not an adapter-invented fixture.
    """

    global _canonical_schema_cache
    if _canonical_schema_cache is None:
        raw = json.loads(_CANONICAL_SCHEMA_PATH.read_text())
        try:
            _canonical_schema_cache = normalize_turn_tree_schema(raw)
        except RecordValidationError as validation_error:
            raise OperationInputError(
                "invalid_object_fixture", f"canonical schema is invalid: {validation_error}"
            ) from validation_error
    return _canonical_schema_cache


def _new_conformance_kernel() -> RuntimeKernel:
    """A fresh in-memory kernel with the canonical schema registered.

    Every operation below builds its scenario from a clean kernel, the same
    isolation `withConformanceKernel` gives each TypeScript adapter call --
    one dispatch, one kernel, no state leaking between operations.
    """

    kernel = RuntimeKernel(InMemoryBackend())
    kernel.schema.register(dict(_load_canonical_schema()))
    return kernel


def _capture_semantic_error_code(execute: Any) -> str:
    try:
        execute()
        return "unexpected_success"
    except KernelRuntimeError as runtime_error:
        return runtime_error.code


class _InjectedClock:
    """A mutable, adapter-controlled `RuntimeBackend.now()` clock.

    Every run-liveness/restart-recovery/reclamation scenario needs precise
    control over the backend-authoritative clock (ADR-050: lease math is
    always computed from `RuntimeBackend.now()`, never a caller-supplied
    value) to land on a conformance plan's literal expected numbers -- e.g.
    `renewal.renewedLeaseExpiresAtMs == 40`. This is that seam: a plain
    callable `InMemoryBackend.now` accepts, whose `.value` the scenario
    advances between kernel calls.
    """

    def __init__(self, value: int = 0) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value


def _new_conformance_kernel_with_clock(clock: _InjectedClock) -> RuntimeKernel:
    kernel = RuntimeKernel(InMemoryBackend(now=clock))
    kernel.schema.register(dict(_load_canonical_schema()))
    return kernel


from tuvren_kernel_adapter.operations_liveness import (  # noqa: E402
    run_crash_recovery_in_process,
    run_expired_listing,
    run_lease_renewal,
    run_restart_recovery_concurrent_writer,
    run_stale_preemption,
)
from tuvren_kernel_adapter.operations_maintenance import (  # noqa: E402
    run_cross_scope_probe,
    run_erasure_probe,
    run_reclamation_probe,
)
from tuvren_kernel_adapter.operations_protocol import (  # noqa: E402
    run_deterministic_hashing,
    run_modify_composition,
    run_schema_roundtrip,
)
from tuvren_kernel_adapter.operations_runtime import (  # noqa: E402
    run_branch_list,
    run_cross_thread_lineage,
    run_logical_diff,
    run_protocol_edge_validation,
    run_recovery_state,
    run_thread_list,
)

OPERATIONS: dict[str, Any] = {
    "kernel.protocol.deterministic-hashing": run_deterministic_hashing,
    "kernel.protocol.schema-roundtrip": run_schema_roundtrip,
    "kernel.protocol.modify-composition": run_modify_composition,
    "kernel.protocol.edge-validation": run_protocol_edge_validation,
    "kernel.logical.diff-paths": run_logical_diff,
    "kernel.logical.branch-list": run_branch_list,
    "kernel.logical.recovery-state": run_recovery_state,
    "kernel.logical.thread-list": run_thread_list,
    "kernel.lineage.cross-thread-rejection": run_cross_thread_lineage,
    "kernel.run-liveness.lease-renewal": run_lease_renewal,
    "kernel.run-liveness.expired-listing": run_expired_listing,
    "kernel.run-liveness.stale-preemption": run_stale_preemption,
    "kernel.restart-recovery.crash-recovery-in-process": run_crash_recovery_in_process,
    "kernel.restart-recovery.concurrent-writer": run_restart_recovery_concurrent_writer,
    "kernel.scope-isolation.cross-scope-probe": run_cross_scope_probe,
    "kernel.reclamation.reclaim-probe": run_reclamation_probe,
    "kernel.reclamation.erasure-probe": run_erasure_probe,
}
