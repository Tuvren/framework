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
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"

	kernel "github.com/tuvren/framework/go/kernel"
)

// parseJSONInput decodes an adapter dispatch input payload using UseNumber
// so integers survive as json.Number (never float64), matching how
// go/kernel's JSON conversion expects to see them.
func parseJSONInput(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

// readInputFixture extracts params.input.fixture as a JSON object. Every
// kernel.protocol.* check that carries a fixture wraps it this way (see
// tools/conformance/harness/run.ts's createAdapterInput), mirroring
// rust/kernel-conformance-adapter/src/main.rs's read_input_fixture.
func readInputFixture(rawInput json.RawMessage) (map[string]any, *adapterErrorEnvelope) {
	parsed, err := parseJSONInput(rawInput)
	if err != nil {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: fmt.Sprintf("failed to parse dispatch input: %v", err),
		}
	}

	input, ok := parsed.(map[string]any)
	if !ok {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "dispatch input must be a JSON object",
		}
	}

	fixture, ok := input["fixture"].(map[string]any)
	if !ok {
		return nil, &adapterErrorEnvelope{
			Code:    "missing_operation_fixture",
			Message: "dispatch input.fixture must be a JSON object",
		}
	}

	return fixture, nil
}

func readFixtureString(fixture map[string]any, field string) (string, *adapterErrorEnvelope) {
	value, ok := fixture[field].(string)
	if !ok {
		return "", &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: fmt.Sprintf("fixture.%s must be a string", field),
		}
	}
	return value, nil
}

func readFixtureByteArray(fixture map[string]any, field string) ([]byte, *adapterErrorEnvelope) {
	rawArray, ok := fixture[field].([]any)
	if !ok {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: fmt.Sprintf("fixture.%s must be an array of bytes", field),
		}
	}

	out := make([]byte, len(rawArray))
	for i, element := range rawArray {
		number, ok := element.(json.Number)
		if !ok {
			return nil, &adapterErrorEnvelope{
				Code:    "invalid_operation_input",
				Message: fmt.Sprintf("fixture.%s[%d] must be an integer", field, i),
			}
		}
		value, err := number.Int64()
		if err != nil || value < 0 || value > 255 {
			return nil, &adapterErrorEnvelope{
				Code:    "invalid_operation_input",
				Message: fmt.Sprintf("fixture.%s[%d] must be a byte value (0-255)", field, i),
			}
		}
		out[i] = byte(value)
	}
	return out, nil
}

func decodeCanonicalHexField(fixture map[string]any, field string) (kernel.Record, *adapterErrorEnvelope) {
	hexValue, rpcErr := readFixtureString(fixture, field)
	if rpcErr != nil {
		return nil, rpcErr
	}

	decoded, err := hex.DecodeString(hexValue)
	if err != nil {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: fmt.Sprintf("fixture.%s is not valid hex: %v", field, err),
		}
	}

	record, err := kernel.DecodeCanonical(decoded)
	if err != nil {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_kernel_record_encoding",
			Message: fmt.Sprintf("fixture.%s did not decode as canonical deterministic CBOR: %v", field, err),
		}
	}

	return record, nil
}

// projection mirrors rust/kernel-conformance-adapter/src/main.rs's
// projection(): the same observation object is both the operation result
// ($.result in plan assertions) and the persisted evidence ($.evidence).
func projection(observation map[string]any) map[string]any {
	return map[string]any{
		"evidence": observation,
		"result":   observation,
	}
}

func runDeterministicHashing(rawInput json.RawMessage) operationOutcome {
	fixture, rpcErr := readInputFixture(rawInput)
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	rawOpaqueBytes, rpcErr := readFixtureByteArray(fixture, "rawOpaqueBytes")
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	schemaRecord, rpcErr := decodeCanonicalHexField(fixture, "turnTreeSchemaRecordCborHex")
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}
	schemaHash, err := kernel.HashRecord(schemaRecord)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "kernel_record_hash_failed",
			Message: err.Error(),
		}}
	}

	turnNodeIdentityRecordJSON, ok := fixture["turnNodeIdentityRecord"]
	if !ok {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "fixture.turnNodeIdentityRecord must be present",
		}}
	}
	nodeRecord, err := kernel.RecordFromJSON(turnNodeIdentityRecordJSON)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "invalid_kernel_record",
			Message: err.Error(),
		}}
	}
	nodeHash, err := kernel.HashRecord(nodeRecord)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "kernel_record_hash_failed",
			Message: err.Error(),
		}}
	}

	return operationOutcome{
		Kind: "result",
		Value: projection(map[string]any{
			"hashes": map[string]any{
				"rawOpaqueBytes":   kernel.HashBytesToHex(rawOpaqueBytes),
				"turnTreeSchema":   schemaHash,
				"turnNodeIdentity": nodeHash,
			},
		}),
	}
}

func runSchemaRoundtrip(rawInput json.RawMessage) operationOutcome {
	fixture, rpcErr := readInputFixture(rawInput)
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	schemaRecord, rpcErr := decodeCanonicalHexField(fixture, "turnTreeSchemaRecordCborHex")
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}
	schemaJSON, err := kernel.RecordToJSON(schemaRecord)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "kernel_record_to_json_failed",
			Message: err.Error(),
		}}
	}

	nodeRecord, rpcErr := decodeCanonicalHexField(fixture, "turnNodeIdentityRecordCborHex")
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}
	nodeJSON, err := kernel.RecordToJSON(nodeRecord)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "kernel_record_to_json_failed",
			Message: err.Error(),
		}}
	}

	return operationOutcome{
		Kind: "result",
		Value: projection(map[string]any{
			"roundtrip": map[string]any{
				"turnTreeSchemaRecord":   schemaJSON,
				"turnNodeIdentityRecord": nodeJSON,
			},
		}),
	}
}

// modifyTransformRecord builds one Modify verdict's transform record, e.g.
// {"extension": "first", "mutation": "append-prefix"}.
func modifyTransformRecord(extension, mutation string) kernel.RecordMap {
	return kernel.RecordMap{
		"extension": kernel.RecordText(extension),
		"mutation":  kernel.RecordText(mutation),
	}
}

// runModifyComposition exercises the kernel spec's §6.2 composition rule
// with two Modify verdicts (registered around an intervening Proceed, which
// contributes nothing) and asserts the kernel composes their transforms, in
// registration order, into a single Modify verdict.
func runModifyComposition(json.RawMessage) operationOutcome {
	composed := kernel.ComposeVerdicts([]kernel.Verdict{
		{Kind: kernel.VerdictKindModify, Transform: modifyTransformRecord("first", "append-prefix")},
		{Kind: kernel.VerdictKindProceed},
		{Kind: kernel.VerdictKindModify, Transform: modifyTransformRecord("second", "append-suffix")},
	})

	if composed.Kind != kernel.VerdictKindModify {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "unexpected_verdict_kind",
			Message: "expected modify verdict after composing ordered modify transforms",
		}}
	}

	transformJSON, err := kernel.RecordToJSON(composed.Transform)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "kernel_record_to_json_failed",
			Message: err.Error(),
		}}
	}

	return operationOutcome{
		Kind: "result",
		Value: projection(map[string]any{
			"verdict": map[string]any{
				"kind":      "modify",
				"transform": transformJSON,
			},
		}),
	}
}
