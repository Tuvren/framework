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

package main

import "testing"

// TestStubMessage is a trivial smoke test scoped to this certification
// module only. It intentionally does not re-run go/kernel or
// go/kernel-conformance-adapter tests; certification conformance runs
// through the shared conformance engine driving the adapter process
// directly, per this package's stub message.
func TestStubMessage(t *testing.T) {
	want := "kernel Go conformance is executed by tools/conformance/harness/run.ts through go/kernel-conformance-adapter/adapter.json"
	if got := stubMessage(); got != want {
		t.Fatalf("stubMessage() = %q, want %q", got, want)
	}
}
