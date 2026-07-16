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

"""Milestone M4 coverage for `kernel.scope-isolation.cross-scope-probe` and
`kernel.reclamation.reclaim-probe`, plus the M3 review carry-forward that
touches this adapter (`kernel.restart-recovery.crash-recovery-in-process`'s
now-honest `visibleCommittedMessageCount`)."""

from __future__ import annotations

from tuvren_kernel_adapter import __main__ as adapter_main
from tuvren_kernel_adapter import operations


def test_run_cross_scope_probe_reports_all_expected_fields() -> None:
    result = operations.run_cross_scope_probe(None)["result"]

    assert result["storeHas"] == {
        "sameScopeObservesOwnContent": True,
        "crossScopeObservesOtherContent": False,
    }
    assert result["storeGet"] == {
        "sameScopeReturnsObject": True,
        "crossScopeReturnsNull": True,
    }
    assert result["enumeration"] == {
        "sameScopeThreadVisible": True,
        "crossScopeThreadVisible": False,
    }


def test_run_reclamation_probe_reports_all_expected_fields() -> None:
    result = operations.run_reclamation_probe(None)["result"]["reclaim"]

    assert result == {
        "unreachablePastGraceReleased": True,
        "archivedBranchReleased": True,
        "reachableFromLiveRootRetained": True,
        "sharedObjectRetainedViaLiveRoot": True,
        "graceWindowHeldUnderActiveLease": True,
        "leaselessRunPastAdminExpiryDoesNotPinReclamation": True,
        "leaselessRunWithinAdminExpiryStillPinsReclamation": True,
    }


def test_capabilities_include_scope_isolation_and_reclamation() -> None:
    assert "kernel.scope-isolation" in adapter_main.CAPABILITIES
    assert "kernel.reclamation" in adapter_main.CAPABILITIES


def test_operations_registry_includes_the_three_new_operations() -> None:
    for operation_name in (
        "kernel.scope-isolation.cross-scope-probe",
        "kernel.reclamation.reclaim-probe",
        "kernel.reclamation.erasure-probe",
    ):
        assert operation_name in operations.OPERATIONS


def test_crash_recovery_visible_committed_message_count_reads_manifest() -> None:
    """M3 review carry-forward: no longer a `len(createdTurnNodes)` proxy."""

    result = operations.run_crash_recovery_in_process(None)["result"]["crashRecovery"]

    assert result["beforeCommit"]["visibleCommittedMessageCount"] == 1
    assert result["midCommit"]["visibleCommittedMessageCount"] == 2
    assert result["afterCommitBeforeAck"]["visibleCommittedMessageCount"] == 2
