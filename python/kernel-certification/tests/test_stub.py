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

"""Trivial smoke test scoped to the tuvren_kernel_certification package only.

This intentionally does not re-run python/kernel's pytest suite;
certification conformance runs through the shared conformance engine driving
the adapter process directly, per this package's stub message.
"""

import pytest

from tuvren_kernel_certification.__main__ import STUB_MESSAGE, main


def test_main_prints_stub_message_and_exits_nonzero(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main()

    assert exit_info.value.code == 1
    assert capsys.readouterr().err.strip() == STUB_MESSAGE
