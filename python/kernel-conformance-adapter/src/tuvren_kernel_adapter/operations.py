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

from typing import Any

# Re-exported so `__main__.py`, the adapter tests, and any external caller keep
# their existing `operations.<name>` import surface; the definitions live in
# the `operations_common` leaf module to keep the module graph acyclic.
from tuvren_kernel_adapter.operations_common import (
    OperationInputError as OperationInputError,
)
from tuvren_kernel_adapter.operations_liveness import (
    run_crash_recovery_in_process,
    run_expired_listing,
    run_lease_renewal,
    run_restart_recovery_concurrent_writer,
    run_stale_preemption,
)
from tuvren_kernel_adapter.operations_maintenance import (
    run_cross_scope_probe,
    run_erasure_probe,
    run_reclamation_probe,
)
from tuvren_kernel_adapter.operations_protocol import (
    run_deterministic_hashing,
    run_modify_composition,
    run_schema_roundtrip,
)
from tuvren_kernel_adapter.operations_runtime import (
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
