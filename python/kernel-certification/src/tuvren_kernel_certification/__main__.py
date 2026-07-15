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

"""Entry point for ``python -m tuvren_kernel_certification``.

Mirrors rust/kernel-certification/src/main.rs: this binary is not how
certification runs. Certification runs through the shared conformance
engine driving the adapter process directly.
"""

import sys


def main() -> None:
    print(
        "kernel Python conformance is executed by "
        "tools/conformance/harness/run.ts through "
        "python/kernel-conformance-adapter/adapter.json",
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
