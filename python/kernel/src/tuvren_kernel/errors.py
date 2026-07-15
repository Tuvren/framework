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

"""The one exception type every `tuvren_kernel.runtime` operation raises.

Every rejection `docs/KrakenKernelSpecification.md` Appendix B describes --
missing entities, illegal state transitions, lineage failures -- surfaces as
a `KernelRuntimeError` carrying a stable `code` string. A handful of those
codes are normative: they come directly from the M2 plan assertions this
milestone's conformance checks read back (`duplicate_schema_path`,
`kernel_runtime_missing_required_tree_path`,
`kernel_runtime_tree_schema_mismatch_diff`,
`kernel_runtime_branch_already_active`, `kernel_runtime_unexpected_step`,
`kernel_runtime_missing_event_object`, `kernel_runtime_lateral_head_movement`,
`turn_node_thread_mismatch`) and this module's callers must raise them
byte-for-byte as written, not through some intermediate "logical" alias --
unlike the TypeScript port, which raises an internal
`kernel_runtime_lineage_mismatch` and only produces the adapter-facing
`turn_node_thread_mismatch` by normalizing it in the conformance adapter's
host support, this Python port raises `turn_node_thread_mismatch` directly
from `tuvren_kernel.runtime`, since the plan only ever asserts the public
name and an extra alias layer would add indirection with no behavioral
payoff. The remaining codes in this module are this port's own invented
names for Appendix B rejections the M2 plan does not directly assert
(`kernel_runtime_unknown_schema`, `kernel_runtime_missing_tree`, ...); they
follow the same `kernel_runtime_<reason>` shape as the TypeScript runtime's
inventory for cross-language readability, without claiming byte-identity
with any single TypeScript literal beyond the eight normative codes above.
"""

from __future__ import annotations

from typing import Any


class KernelRuntimeError(Exception):
    """Raised by `tuvren_kernel.runtime` for any Appendix-B rejection."""

    def __init__(self, code: str, message: str | None = None, details: Any = None) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.details = details
