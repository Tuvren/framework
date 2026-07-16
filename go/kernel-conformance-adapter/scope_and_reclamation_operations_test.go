// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Milestone M4 coverage for the cross-scope isolation probe operation
// (runCrossScopeProbe) and the reclamation probe operation
// (runReclaimProbe), both wired in operations_maintenance.go, mirroring the
// coverage intent of
// python/kernel-conformance-adapter/tests/test_scope_and_reclamation_operations.py.
package main

import (
	"reflect"
	"testing"
)

// resultFieldFromOutcome extracts a named nested object under the
// operation's projected "result" observation (for example "storeHas" or
// "reclaim"), failing loudly if the outcome is not a well-formed result
// envelope shaped as expected.
func resultFieldFromOutcome(t *testing.T, outcome operationOutcome, field string) map[string]any {
	t.Helper()
	if outcome.Kind != "result" {
		t.Fatalf("expected a result outcome, got kind %q (error: %+v)", outcome.Kind, outcome.Error)
	}
	value, ok := outcome.Value.(map[string]any)
	if !ok {
		t.Fatalf("expected outcome.Value to be a map[string]any, got %T", outcome.Value)
	}
	result, ok := value["result"].(map[string]any)
	if !ok {
		t.Fatalf("expected value[\"result\"] to be a map[string]any, got %T", value["result"])
	}
	nested, ok := result[field].(map[string]any)
	if !ok {
		t.Fatalf("expected result[%q] to be a map[string]any, got %T", field, result[field])
	}
	return nested
}

// TestRunCrossScopeProbe_ReportsAllExpectedFields proves the cross-scope
// probe operation's three projected observation groups (storeHas,
// storeGet, enumeration) are all derived from a real pair of Kernels bound
// to two distinct Scopes over one shared substrate: the constructing scope
// observes its own content and thread, and the co-tenant scope observes
// none of it.
func TestRunCrossScopeProbe_ReportsAllExpectedFields(t *testing.T) {
	outcome := runCrossScopeProbe(nil)

	storeHas := resultFieldFromOutcome(t, outcome, "storeHas")
	wantStoreHas := map[string]any{
		"sameScopeObservesOwnContent":    true,
		"crossScopeObservesOtherContent": false,
	}
	if !reflect.DeepEqual(storeHas, wantStoreHas) {
		t.Fatalf("expected storeHas %+v, got %+v", wantStoreHas, storeHas)
	}

	storeGet := resultFieldFromOutcome(t, outcome, "storeGet")
	wantStoreGet := map[string]any{
		"sameScopeReturnsObject": true,
		"crossScopeReturnsNull":  true,
	}
	if !reflect.DeepEqual(storeGet, wantStoreGet) {
		t.Fatalf("expected storeGet %+v, got %+v", wantStoreGet, storeGet)
	}

	enumeration := resultFieldFromOutcome(t, outcome, "enumeration")
	wantEnumeration := map[string]any{
		"sameScopeThreadVisible":  true,
		"crossScopeThreadVisible": false,
	}
	if !reflect.DeepEqual(enumeration, wantEnumeration) {
		t.Fatalf("expected enumeration %+v, got %+v", wantEnumeration, enumeration)
	}
}

// TestRunReclaimProbe_ReportsAllExpectedFields proves every decisive
// mark-and-sweep reclamation scenario (kernel spec §9.4) the operation
// exercises — unreachable-past-grace release, archived-lineage release,
// live-root retention, shared-object retention via a live root, the grace
// window pinned to the oldest active lease, and both leaseless-run
// admin-expiry scenarios — comes back true, all derived from real kernel
// state rather than hardcoded projection.
func TestRunReclaimProbe_ReportsAllExpectedFields(t *testing.T) {
	reclaim := resultFieldFromOutcome(t, runReclaimProbe(nil), "reclaim")

	want := map[string]any{
		"unreachablePastGraceReleased":                      true,
		"archivedBranchReleased":                            true,
		"reachableFromLiveRootRetained":                     true,
		"sharedObjectRetainedViaLiveRoot":                   true,
		"graceWindowHeldUnderActiveLease":                   true,
		"leaselessRunPastAdminExpiryDoesNotPinReclamation":  true,
		"leaselessRunWithinAdminExpiryStillPinsReclamation": true,
	}
	if !reflect.DeepEqual(reclaim, want) {
		t.Fatalf("expected reclaim observation %+v, got %+v", want, reclaim)
	}
}
