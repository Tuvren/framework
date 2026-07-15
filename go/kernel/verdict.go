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

package kernel

// Verdict kinds, per docs/KrakenKernelSpecification.md §6.1 and the CDDL
// verdict union in spec/kernel/cddl/kernel-records.cddl.
const (
	VerdictKindProceed = "proceed"
	VerdictKindAbort   = "abort"
	VerdictKindModify  = "modify"
	VerdictKindPause   = "pause"
	VerdictKindRetry   = "retry"
)

// Verdict is a flat union over the five kernel verdict variants. Only the
// fields relevant to Kind are meaningful; this mirrors the CDDL's five
// disjoint object shapes without needing a Go-level sum type for a surface
// this small.
type Verdict struct {
	Kind string

	// Abort
	Disposition string
	Reason      string

	// Modify
	Transform Record

	// Pause
	ResumptionSchema Record

	// Retry
	Adjustment Record
}

// ComposeVerdicts implements the kernel spec's §6.2 composition rule:
//
//	Abort > Pause > Modify > Retry > Proceed
//
// First-objection-wins: the highest-priority verdict kind present in the
// input wins, and the first verdict of that kind (in input order) is
// returned — except Modify, where §6.1 states "the kernel composes
// multiple transforms in registration order": when more than one Modify
// verdict is present (and no Abort or Pause outranks it), every Modify
// transform is collected in input order into a single composed Modify
// verdict whose transform is that ordered array.
func ComposeVerdicts(verdicts []Verdict) Verdict {
	var abort, pause, retry *Verdict
	var modifyTransforms []Record

	for _, verdict := range verdicts {
		switch verdict.Kind {
		case VerdictKindAbort:
			if abort == nil {
				captured := verdict
				abort = &captured
			}
		case VerdictKindPause:
			if pause == nil {
				captured := verdict
				pause = &captured
			}
		case VerdictKindModify:
			modifyTransforms = append(modifyTransforms, verdict.Transform)
		case VerdictKindRetry:
			if retry == nil {
				captured := verdict
				retry = &captured
			}
		}
	}

	var modify *Verdict
	switch len(modifyTransforms) {
	case 0:
		// No Modify verdict to compose.
	case 1:
		modify = &Verdict{Kind: VerdictKindModify, Transform: modifyTransforms[0]}
	default:
		modify = &Verdict{Kind: VerdictKindModify, Transform: RecordArray(modifyTransforms)}
	}

	for _, candidate := range []*Verdict{abort, pause, modify, retry} {
		if candidate != nil {
			return *candidate
		}
	}

	return Verdict{Kind: VerdictKindProceed}
}
