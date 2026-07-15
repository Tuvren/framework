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

"""Certification wrapper package for the Python kernel port.

This package is a thin wrapper only. It carries no semantic decisions:
conformance is executed by the shared engine at
`tools/conformance/harness/run.ts` against
`python/kernel-conformance-adapter/adapter.json`. Registration of a
`conformance` Nx target lands in a later milestone.
"""
