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

// This file wires the kernel.protocol.canonical-rejection operation:
// kernel-protocol-extended.json's adversarial-CBOR check
// (spec/conformance/kernel/fixtures/kernel-protocol-adversarial-cbor.json)
// asserts every listed byte sequence is refused by the strict canonical
// KernelRecord decoder (kernel spec §2.3). This handler only reports
// whether each case's bytes were rejected — it never projects an error
// code, matching the adapter guardrail that adapters do not grade or
// classify failures themselves.
package main

import (
	"encoding/json"
	"fmt"

	kernel "github.com/tuvren/framework/go/kernel"
)

// runCanonicalRejection attempts kernel.DecodeCanonical against every case
// in the fixture's "cases" map and projects, for each case name, whether
// decoding it returned an error. A case's cborBytes array is read with the
// same helper (readFixtureByteArray) the deterministic-hashing/schema-
// roundtrip operations already use for byte-array fixture fields.
func runCanonicalRejection(rawInput json.RawMessage) operationOutcome {
	fixture, rpcErr := readInputFixture(rawInput)
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	rawCases, ok := fixture["cases"].(map[string]any)
	if !ok {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "fixture.cases must be a JSON object",
		}}
	}

	rejection := make(map[string]any, len(rawCases))
	for name, rawCase := range rawCases {
		caseObject, ok := rawCase.(map[string]any)
		if !ok {
			return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
				Code:    "invalid_operation_input",
				Message: fmt.Sprintf("fixture.cases.%s must be a JSON object", name),
			}}
		}

		cborBytes, rpcErr := readFixtureByteArray(caseObject, "cborBytes")
		if rpcErr != nil {
			return operationOutcome{Kind: "error", Error: rpcErr}
		}

		_, decodeErr := kernel.DecodeCanonical(cborBytes)
		rejection[name] = map[string]any{
			"rejected": decodeErr != nil,
		}
	}

	return operationOutcome{
		Kind:  "result",
		Value: projection(map[string]any{"rejection": rejection}),
	}
}
