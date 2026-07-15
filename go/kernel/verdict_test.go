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

package kernel_test

import (
	"reflect"
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

func TestComposeVerdicts_MultipleModifiesComposeInOrder(t *testing.T) {
	first := kernel.RecordMap{
		"extension": kernel.RecordText("first"),
		"mutation":  kernel.RecordText("append-prefix"),
	}
	second := kernel.RecordMap{
		"extension": kernel.RecordText("second"),
		"mutation":  kernel.RecordText("append-suffix"),
	}

	composed := kernel.ComposeVerdicts([]kernel.Verdict{
		{Kind: kernel.VerdictKindModify, Transform: first},
		{Kind: kernel.VerdictKindProceed},
		{Kind: kernel.VerdictKindModify, Transform: second},
	})

	if composed.Kind != kernel.VerdictKindModify {
		t.Fatalf("expected modify verdict, got %s", composed.Kind)
	}

	transform, ok := composed.Transform.(kernel.RecordArray)
	if !ok {
		t.Fatalf("expected transform to be a RecordArray, got %T", composed.Transform)
	}
	if len(transform) != 2 {
		t.Fatalf("expected 2 composed transforms, got %d", len(transform))
	}
	if !reflect.DeepEqual(transform[0], kernel.Record(first)) {
		t.Errorf("first transform mismatch: %#v", transform[0])
	}
	if !reflect.DeepEqual(transform[1], kernel.Record(second)) {
		t.Errorf("second transform mismatch: %#v", transform[1])
	}
}

func TestComposeVerdicts_AbortOutranksEverything(t *testing.T) {
	abort := kernel.Verdict{Kind: kernel.VerdictKindAbort, Disposition: "HardFail", Reason: "boom"}
	composed := kernel.ComposeVerdicts([]kernel.Verdict{
		{Kind: kernel.VerdictKindModify, Transform: kernel.RecordText("ignored")},
		abort,
		{Kind: kernel.VerdictKindPause, Reason: "also ignored", ResumptionSchema: kernel.RecordNull{}},
	})

	if composed.Kind != kernel.VerdictKindAbort || composed.Reason != "boom" {
		t.Fatalf("expected the abort verdict to win, got %+v", composed)
	}
}

func TestComposeVerdicts_SingleModifyStaysUnwrapped(t *testing.T) {
	only := kernel.RecordText("solo")
	composed := kernel.ComposeVerdicts([]kernel.Verdict{
		{Kind: kernel.VerdictKindProceed},
		{Kind: kernel.VerdictKindModify, Transform: only},
	})

	if composed.Kind != kernel.VerdictKindModify {
		t.Fatalf("expected modify verdict, got %s", composed.Kind)
	}
	if !reflect.DeepEqual(composed.Transform, kernel.Record(only)) {
		t.Errorf("expected single modify transform to stay unwrapped, got %#v", composed.Transform)
	}
}

func TestComposeVerdicts_EmptyOrAllProceedYieldsProceed(t *testing.T) {
	if composed := kernel.ComposeVerdicts(nil); composed.Kind != kernel.VerdictKindProceed {
		t.Fatalf("expected proceed for empty input, got %s", composed.Kind)
	}
	composed := kernel.ComposeVerdicts([]kernel.Verdict{
		{Kind: kernel.VerdictKindProceed},
		{Kind: kernel.VerdictKindProceed},
	})
	if composed.Kind != kernel.VerdictKindProceed {
		t.Fatalf("expected proceed, got %s", composed.Kind)
	}
}
