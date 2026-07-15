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

"""Verdict algebra per `docs/KrakenKernelSpecification.md` Section 6.

Verdicts are `{"kind": ..., ...}` records matching the CDDL `verdict`
production (`proceed-verdict` / `abort-verdict` / `modify-verdict` /
`pause-verdict` / `retry-verdict`). Section 6.2's composition rule is a
fixed priority order:

    Abort > Pause > Modify > Retry > Proceed

with "first-objection-wins" for the non-Modify kinds (the first verdict of
the winning kind, in input order, is returned as-is) and, for Modify, "the
kernel composes multiple transforms in registration order" (Section 6.1):
every Modify verdict's `transform` is collected, in input order, into the
composed Modify verdict.

The exact collection shape for >1 transform mirrors
`rust/kernel/src/memory.rs`'s `InMemoryKernel::verdicts_compose` (shape
guidance only, per the worker's authority rules -- the *decision* to wrap
multiple opaque transforms in an array rather than invent transform-specific
merge semantics is licensed directly by Section 6.1's "transform: opaque"
wording, and is exactly what `kernel.protocol.modify_composition`'s expected
`$.verdict.transform` array asserts): a single Modify verdict's `transform`
value is used unmodified, but two or more are wrapped as a `kernel-array` of
the individual transform values, in registration order.
"""

from __future__ import annotations

from typing import Any


def compose_verdicts(verdicts: list[dict[str, Any]]) -> dict[str, Any]:
    """Compose an ordered list of verdicts into a single verdict."""

    abort: dict[str, Any] | None = None
    pause: dict[str, Any] | None = None
    modify_transforms: list[Any] = []
    retry: dict[str, Any] | None = None

    for verdict in verdicts:
        kind = verdict.get("kind")
        if kind == "abort":
            if abort is None:
                abort = verdict
        elif kind == "pause":
            if pause is None:
                pause = verdict
        elif kind == "modify":
            modify_transforms.append(verdict.get("transform"))
        elif kind == "retry":
            if retry is None:
                retry = verdict
        elif kind == "proceed":
            continue
        else:
            raise ValueError(f"unknown verdict kind: {kind!r}")

    if abort is not None:
        return abort
    if pause is not None:
        return pause
    if modify_transforms:
        transform = modify_transforms[0] if len(modify_transforms) == 1 else list(modify_transforms)
        return {"kind": "modify", "transform": transform}
    if retry is not None:
        return retry
    return {"kind": "proceed"}
