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
	"encoding/json"
	"fmt"
)

// operationHandler runs one conformance-plan operation against the Go
// kernel and returns its OperationOutcome. Later milestones register real
// handlers here as the Go kernel gains semantics; this milestone (M0) keeps
// the table empty so every operation falls through to
// adapter_operation_not_implemented.
type operationHandler func(input json.RawMessage) operationOutcome

// operationHandlers is the seam later milestones extend with per-operation
// entries (for example "kernel.protocol.deterministic-hashing"), mirroring
// the match arms in rust/kernel-conformance-adapter/src/main.rs's
// dispatch_operation.
var operationHandlers = map[string]operationHandler{}

// capabilities lists the capability tags this adapter reports during
// initialize. It must byte-match adapter.json's "capabilities" array (see
// tools/conformance/harness/run.ts's validateAdapterHandshake). M0 ships no
// kernel semantics, so this is empty until later milestones populate both
// this slice and adapter.json together.
func capabilities() []string {
	return []string{}
}

// dispatchOperation runs the named operation's handler, or reports
// adapter_operation_not_implemented when no handler is registered yet.
func dispatchOperation(operation string, input json.RawMessage) operationOutcome {
	handler, ok := operationHandlers[operation]
	if !ok {
		return operationOutcome{
			Kind: "error",
			Error: &adapterErrorEnvelope{
				Code:    "adapter_operation_not_implemented",
				Message: fmt.Sprintf("operation not implemented: %s", operation),
			},
		}
	}

	return handler(input)
}
