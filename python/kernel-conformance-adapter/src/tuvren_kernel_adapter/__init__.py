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

"""Python conformance adapter for the Tuvren kernel port.

This package implements the neutral JSON-RPC 2.0 stdio process seam described
in `tools/conformance/adapter-protocol/protocol.md`. It bridges the shared
conformance runner (`tools/conformance/harness/run.ts`) to the
`tuvren_kernel` implementation. It carries no semantic authority of its own:
product semantics, operation inputs, assertions, and pass/fail decisions come
only from authority packets and their conformance plans.
"""
