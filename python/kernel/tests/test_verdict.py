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

"""Verdict composition per `docs/KrakenKernelSpecification.md` Section 6."""

from __future__ import annotations

from tuvren_kernel.verdict import compose_verdicts


def test_modify_composition_matches_conformance_scenario() -> None:
    # Mirrors the exact scenario built by
    # `rust/kernel-conformance-adapter/src/main.rs::run_modify_composition`
    # and asserted by the `kernel.protocol.modify_composition` check in both
    # `spec/conformance/kernel/plans/kernel-protocol-core.json` and
    # `kernel-protocol-extended.json`.
    verdicts = [
        {
            "kind": "modify",
            "transform": {"extension": "first", "mutation": "append-prefix"},
        },
        {"kind": "proceed"},
        {
            "kind": "modify",
            "transform": {"extension": "second", "mutation": "append-suffix"},
        },
    ]

    composed = compose_verdicts(verdicts)

    assert composed == {
        "kind": "modify",
        "transform": [
            {"extension": "first", "mutation": "append-prefix"},
            {"extension": "second", "mutation": "append-suffix"},
        ],
    }


def test_single_modify_transform_is_not_wrapped_in_array() -> None:
    verdicts = [
        {"kind": "proceed"},
        {"kind": "modify", "transform": {"only": "one"}},
    ]

    assert compose_verdicts(verdicts) == {"kind": "modify", "transform": {"only": "one"}}


def test_abort_outranks_everything() -> None:
    abort_verdict = {"kind": "abort", "disposition": "HardFail", "reason": "boom"}
    verdicts = [
        {"kind": "modify", "transform": {"x": 1}},
        abort_verdict,
        {"kind": "pause", "reason": "wait", "resumptionSchema": None},
    ]

    assert compose_verdicts(verdicts) == abort_verdict


def test_pause_outranks_modify_and_retry() -> None:
    pause_verdict = {"kind": "pause", "reason": "wait", "resumptionSchema": None}
    verdicts = [
        {"kind": "retry", "adjustment": None},
        {"kind": "modify", "transform": {"x": 1}},
        pause_verdict,
    ]

    assert compose_verdicts(verdicts) == pause_verdict


def test_retry_outranks_proceed() -> None:
    retry_verdict = {"kind": "retry", "adjustment": {"delayMs": 5}}
    verdicts = [{"kind": "proceed"}, retry_verdict]

    assert compose_verdicts(verdicts) == retry_verdict


def test_empty_list_composes_to_proceed() -> None:
    assert compose_verdicts([]) == {"kind": "proceed"}


def test_first_abort_wins_among_multiple_aborts() -> None:
    first_abort = {"kind": "abort", "disposition": "HardFail", "reason": "first"}
    second_abort = {"kind": "abort", "disposition": "SoftFail", "reason": "second"}

    assert compose_verdicts([first_abort, second_abort]) == first_abort
