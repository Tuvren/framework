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

import (
	"fmt"
	"os"
)

// stubMessage is the diagnostic printed by this non-functional stub binary.
// It is extracted from main so a trivial smoke test can assert its content
// without invoking os.Exit.
func stubMessage() string {
	return "kernel Go conformance is executed by tools/conformance/harness/run.ts through go/kernel-conformance-adapter/adapter.json"
}

func main() {
	fmt.Fprintln(os.Stderr, stubMessage())
	os.Exit(1)
}
