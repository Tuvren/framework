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

"""Tuvren kernel runtime authority, Python port.

Milestone M1 landed the canonical-record core described in
`docs/KrakenKernelSpecification.md` Section 2.3 (record identity hashing)
and Section 6 (verdict algebra): canonical CBOR encode/decode
(`tuvren_kernel.cbor`), SHA-256 record identity (`tuvren_kernel.identity`),
turn-tree-schema / turn-node-identity record validation
(`tuvren_kernel.records`), and verdict composition (`tuvren_kernel.verdict`).

Milestone M2 adds the runtime kernel itself: a storage seam
(`tuvren_kernel.backend`, `RuntimeBackend` protocol + `InMemoryBackend`), the
`KernelRuntimeError` every rejection raises (`tuvren_kernel.errors`), and
`tuvren_kernel.runtime.RuntimeKernel`, implementing the object store, schema
registry, TurnTree, Thread/Branch containment, and a minimal Run lifecycle
slice of `docs/KrakenKernelSpecification.md` Section 7's syscall surface. The
rest of that syscall surface (full Run liveness/leases, restart recovery,
Scope isolation, reclamation) lands in later milestones and must stay
aligned with that specification and the authority packet at
`spec/kernel/authority-packet.json`.
"""

from tuvren_kernel import backend, cbor, errors, identity, records, runtime, verdict

__all__ = ["backend", "cbor", "errors", "identity", "records", "runtime", "verdict"]
