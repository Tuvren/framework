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
	fixture, present, rpcErr := tryReadInputFixture(rawInput)
	if rpcErr != nil {
		return nil, rpcErr
	}
	if !present {
		return nil, &adapterErrorEnvelope{
			Code:    "missing_operation_fixture",
			Message: "dispatch input.fixture must be a JSON object",
		}
	}
	return fixture, nil
}

// tryReadInputFixture is readInputFixture's non-required counterpart: it
// reports (fixture, true, nil) when params.input.fixture is present and is
// a JSON object, (nil, false, nil) when input has no "fixture" key at all
// (or no input object was given), and (nil, false, err) only for a genuine
// parse failure or a present-but-malformed "fixture" value. This is what
// lets an operation like kernel.protocol.modify-composition stay
// fixture-optional: a plan invoking it without a fixture (the original
// core-plan check) gets its unchanged fixture-less behavior, while a plan
// that does supply one (the extended-plan verdict-composition check) gets
// fixture-driven behavior, without either plan having to agree in advance
// on which shape this operation is.
func tryReadInputFixture(rawInput json.RawMessage) (map[string]any, bool, *adapterErrorEnvelope) {
	parsed, err := parseJSONInput(rawInput)
	if err != nil {
		return nil, false, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: fmt.Sprintf("failed to parse dispatch input: %v", err),
		}
	}

	input, ok := parsed.(map[string]any)
	if !ok {
		return nil, false, nil
	}

	rawFixture, present := input["fixture"]
	if !present {
		return nil, false, nil
	}

	fixture, ok := rawFixture.(map[string]any)
	if !ok {
		return nil, false, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "dispatch input.fixture must be a JSON object",
		}
	}

	return fixture, true, nil
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

	// The schema hash must be derived by walking the JSON→Record path
	// (RecordFromJSON), matching how the node/TypeScript reference computes
	// it. Decoding turnTreeSchemaRecordCborHex and re-hashing that would be
	// circular — it never exercises JSON ingestion for the schema at all,
	// so it can't catch a JSON→Record bug even though the hash happens to
	// come out identical when both paths are correct.
	turnTreeSchemaRecordJSON, ok := fixture["turnTreeSchemaRecord"]
	if !ok {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "fixture.turnTreeSchemaRecord must be present",
		}}
	}
	schemaRecord, err := kernel.RecordFromJSON(turnTreeSchemaRecordJSON)
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "invalid_kernel_record",
			Message: err.Error(),
		}}
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

// runModifyComposition exercises the kernel spec's §6.2 composition rule.
//
// Without a fixture (params.input carries no "fixture" key at all — the
// original kernel-protocol-core.json check), it runs its original
// fixture-less scenario: two Modify verdicts registered around an
// intervening Proceed (which contributes nothing), asserting the kernel
// composes their transforms, in registration order, into a single Modify
// verdict.
//
// With a fixture present (kernel-protocol-extended.json's
// f-verdict-composition, spec/conformance/kernel/fixtures/
// kernel-protocol-verdict-composition.json), it instead composes every
// fixture case's own verdicts through kernel.ComposeVerdicts and projects
// each case's composed result under $.composition.<name>, so the plan can
// deep-equal it against that same case's committed $.fixture.cases.<name>.
// expected value.
func runModifyComposition(rawInput json.RawMessage) operationOutcome {
	fixture, hasFixture, rpcErr := tryReadInputFixture(rawInput)
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}
	if hasFixture {
		return runModifyCompositionFromFixture(fixture)
	}

	composed, err := kernel.ComposeVerdicts([]kernel.Verdict{
		{Kind: kernel.VerdictKindModify, Transform: modifyTransformRecord("first", "append-prefix")},
		{Kind: kernel.VerdictKindProceed},
		{Kind: kernel.VerdictKindModify, Transform: modifyTransformRecord("second", "append-suffix")},
	})
	if err != nil {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "verdict_compose_failed",
			Message: err.Error(),
		}}
	}

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

// verdictFromJSON converts one fixture verdict object (as decoded by
// parseJSONInput, so numbers arrive as json.Number) into a kernel.Verdict.
// Only the fields kernel.ComposeVerdicts actually reads for that verdict's
// Kind are populated; an unrecognized "kind" is rejected up front rather
// than silently composing as Proceed.
func verdictFromJSON(raw any) (kernel.Verdict, *adapterErrorEnvelope) {
	object, ok := raw.(map[string]any)
	if !ok {
		return kernel.Verdict{}, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "fixture verdict must be a JSON object",
		}
	}
	kind, ok := object["kind"].(string)
	if !ok {
		return kernel.Verdict{}, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "fixture verdict.kind must be a string",
		}
	}

	verdict := kernel.Verdict{Kind: kind}
	switch kind {
	case kernel.VerdictKindProceed:
		// No further fields.
	case kernel.VerdictKindAbort:
		verdict.Disposition, _ = object["disposition"].(string)
		verdict.Reason, _ = object["reason"].(string)
	case kernel.VerdictKindModify:
		transform, err := kernel.RecordFromJSON(object["transform"])
		if err != nil {
			return kernel.Verdict{}, &adapterErrorEnvelope{Code: "invalid_kernel_record", Message: err.Error()}
		}
		verdict.Transform = transform
	case kernel.VerdictKindPause:
		verdict.Reason, _ = object["reason"].(string)
		resumptionSchema, err := kernel.RecordFromJSON(object["resumptionSchema"])
		if err != nil {
			return kernel.Verdict{}, &adapterErrorEnvelope{Code: "invalid_kernel_record", Message: err.Error()}
		}
		verdict.ResumptionSchema = resumptionSchema
	case kernel.VerdictKindRetry:
		adjustment, err := kernel.RecordFromJSON(object["adjustment"])
		if err != nil {
			return kernel.Verdict{}, &adapterErrorEnvelope{Code: "invalid_kernel_record", Message: err.Error()}
		}
		verdict.Adjustment = adjustment
	default:
		return kernel.Verdict{}, &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: fmt.Sprintf("fixture verdict has unknown kind %q", kind),
		}
	}
	return verdict, nil
}

// composedVerdictJSON converts a composed kernel.Verdict back into the same
// bare-field JSON object shape the verdict-composition fixture's own
// "expected" values use: only the fields meaningful to Kind are present, so
// a deep-equal comparison against the fixture's committed expectation
// (rather than a superset with extra null fields) succeeds.
func composedVerdictJSON(verdict kernel.Verdict) (map[string]any, error) {
	out := map[string]any{"kind": verdict.Kind}
	switch verdict.Kind {
	case kernel.VerdictKindProceed:
		// No further fields.
	case kernel.VerdictKindAbort:
		out["disposition"] = verdict.Disposition
		out["reason"] = verdict.Reason
	case kernel.VerdictKindModify:
		transformJSON, err := kernel.RecordToJSON(verdict.Transform)
		if err != nil {
			return nil, err
		}
		out["transform"] = transformJSON
	case kernel.VerdictKindPause:
		out["reason"] = verdict.Reason
		resumptionSchemaJSON, err := kernel.RecordToJSON(verdict.ResumptionSchema)
		if err != nil {
			return nil, err
		}
		out["resumptionSchema"] = resumptionSchemaJSON
	case kernel.VerdictKindRetry:
		adjustmentJSON, err := kernel.RecordToJSON(verdict.Adjustment)
		if err != nil {
			return nil, err
		}
		out["adjustment"] = adjustmentJSON
	}
	return out, nil
}

// runModifyCompositionFromFixture composes every case in a
// kernel-protocol-verdict-composition.json-shaped fixture's "cases" map
// through kernel.ComposeVerdicts and projects each case's composed verdict
// under $.composition.<name>, keyed by the same case name the fixture (and
// the plan's $.fixture.cases.<name>.expected assertions) use.
func runModifyCompositionFromFixture(fixture map[string]any) operationOutcome {
	rawCases, ok := fixture["cases"].(map[string]any)
	if !ok {
		return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
			Code:    "invalid_operation_input",
			Message: "fixture.cases must be a JSON object",
		}}
	}

	composition := make(map[string]any, len(rawCases))
	for name, rawCase := range rawCases {
		caseObject, ok := rawCase.(map[string]any)
		if !ok {
			return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
				Code:    "invalid_operation_input",
				Message: fmt.Sprintf("fixture.cases.%s must be a JSON object", name),
			}}
		}
		rawVerdicts, ok := caseObject["verdicts"].([]any)
		if !ok {
			return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
				Code:    "invalid_operation_input",
				Message: fmt.Sprintf("fixture.cases.%s.verdicts must be a JSON array", name),
			}}
		}

		verdicts := make([]kernel.Verdict, 0, len(rawVerdicts))
		for _, rawVerdict := range rawVerdicts {
			verdict, rpcErr := verdictFromJSON(rawVerdict)
			if rpcErr != nil {
				return operationOutcome{Kind: "error", Error: rpcErr}
			}
			verdicts = append(verdicts, verdict)
		}

		composed, err := kernel.ComposeVerdicts(verdicts)
		if err != nil {
			return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
				Code:    "verdict_compose_failed",
				Message: fmt.Sprintf("fixture.cases.%s: %v", name, err),
			}}
		}

		composedJSON, err := composedVerdictJSON(composed)
		if err != nil {
			return operationOutcome{Kind: "error", Error: &adapterErrorEnvelope{
				Code:    "kernel_record_to_json_failed",
				Message: fmt.Sprintf("fixture.cases.%s: %v", name, err),
			}}
		}
		composition[name] = composedJSON
	}

	return operationOutcome{
		Kind:  "result",
		Value: projection(map[string]any{"composition": composition}),
	}
}
