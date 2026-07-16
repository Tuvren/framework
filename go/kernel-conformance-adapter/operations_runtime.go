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

// This file wires the M2 runtime-kernel operations (kernel.logical.*,
// kernel.lineage.*, kernel.protocol.edge-validation) into the adapter's
// dispatch table. Every handler here builds its own fresh in-memory Kernel
// (go/kernel's Kernel + InMemoryBackend) per dispatch call — there is no
// state shared across operations or across repeated calls to the same
// operation, matching every other conformance adapter host's per-check
// isolation.
package main

import (
	"encoding/json"
	"fmt"

	kernel "github.com/tuvren/framework/go/kernel"
)

// canonicalTurnTreeSchema is the shared canonical schema
// (spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json)
// several logical/lineage/edge-validation scenarios bootstrap against. It
// is embedded directly rather than read from disk at dispatch time: the
// adapter must not depend on its process working directory to locate
// authority fixtures it can just as well express as a Go value once and
// reuse.
func canonicalTurnTreeSchema() kernel.TurnTreeSchema {
	return kernel.TurnTreeSchema{
		SchemaID: "schema_main",
		Paths: []kernel.PathDefinition{
			{Path: "messages", Collection: kernel.PathCollectionOrdered},
			{Path: "context.manifest", Collection: kernel.PathCollectionSingle},
		},
		IncorporationRules: []kernel.IncorporationRule{
			{ObjectType: "message", TargetPath: "messages"},
			{ObjectType: "context_manifest", TargetPath: "context.manifest"},
		},
	}
}

func newRuntimeKernel() *kernel.Kernel {
	clock := &kernel.IncrementingClock{}
	backend := kernel.NewInMemoryBackend(clock)
	return kernel.NewKernel("kernel-conformance-adapter", clock, backend)
}

func kernelErrorEnvelope(code, message string) *adapterErrorEnvelope {
	return &adapterErrorEnvelope{Code: code, Message: message}
}

// errorOutcomeFor converts a go/kernel error into an adapter error
// envelope, preserving the kernel's own error code when it is a
// *kernel.KernelError so plan assertions that check $.error.code (if any)
// see the real code, not a generic wrapper.
func errorOutcomeFor(err error) operationOutcome {
	if kerr, ok := kernel.AsKernelError(err); ok {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope(kerr.Code, kerr.Message)}
	}
	return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("kernel_runtime_operation_failed", err.Error())}
}

// parsePathValueJSON converts a JSON value (already decoded with
// UseNumber) shaped like the CDDL path-value union (a hash string, an
// array of hash strings, or null) into a kernel.PathValue.
func parsePathValueJSON(value any) (kernel.PathValue, error) {
	switch v := value.(type) {
	case nil:
		return kernel.PathValue{Kind: kernel.PathValueNull}, nil
	case string:
		return kernel.PathValue{Kind: kernel.PathValueSingleKind, Single: v}, nil
	case []any:
		hashes := make([]string, 0, len(v))
		for _, element := range v {
			text, ok := element.(string)
			if !ok {
				return kernel.PathValue{}, fmt.Errorf("ordered path value element must be a string, got %T", element)
			}
			hashes = append(hashes, text)
		}
		return kernel.PathValue{Kind: kernel.PathValueOrderedKind, Ordered: hashes}, nil
	default:
		return kernel.PathValue{}, fmt.Errorf("path value must be a string, an array of strings, or null, got %T", value)
	}
}

func parseChangeSetJSON(raw any) (map[string]kernel.PathValue, error) {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("change set must be a JSON object, got %T", raw)
	}
	out := make(map[string]kernel.PathValue, len(obj))
	for path, value := range obj {
		parsed, err := parsePathValueJSON(value)
		if err != nil {
			return nil, fmt.Errorf("change set path %q: %w", path, err)
		}
		out[path] = parsed
	}
	return out, nil
}

func jsonInt64(value any) (int64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, fmt.Errorf("expected a JSON integer, got %T", value)
	}
	return number.Int64()
}

// parseStepSequenceJSON converts a JSON array of step-declaration-shaped
// objects into []kernel.StepDeclaration.
func parseStepSequenceJSON(raw any) ([]kernel.StepDeclaration, error) {
	array, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("step sequence must be a JSON array, got %T", raw)
	}
	out := make([]kernel.StepDeclaration, 0, len(array))
	for _, element := range array {
		obj, ok := element.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("step declaration must be a JSON object, got %T", element)
		}
		id, _ := obj["id"].(string)
		deterministic, _ := obj["deterministic"].(bool)
		sideEffects, _ := obj["sideEffects"].(bool)
		out = append(out, kernel.StepDeclaration{ID: id, Deterministic: deterministic, SideEffects: sideEffects})
	}
	return out, nil
}

// parseStagedResultJSON converts a JSON object shaped like the CDDL
// staged-result union into a kernel.StagedResult.
func parseStagedResultJSON(raw any) (kernel.StagedResult, error) {
	obj, ok := raw.(map[string]any)
	if !ok {
		return kernel.StagedResult{}, fmt.Errorf("staged result must be a JSON object, got %T", raw)
	}
	taskID, _ := obj["taskId"].(string)
	objectHash, _ := obj["objectHash"].(string)
	objectType, _ := obj["objectType"].(string)
	status, _ := obj["status"].(string)
	timestamp, err := jsonInt64(obj["timestamp"])
	if err != nil {
		return kernel.StagedResult{}, fmt.Errorf("staged result timestamp: %w", err)
	}

	result := kernel.StagedResult{
		TaskID:     taskID,
		ObjectHash: objectHash,
		ObjectType: objectType,
		Timestamp:  timestamp,
		Status:     kernel.StagedResultStatus(status),
	}
	if result.Status == kernel.StagedResultInterrupted {
		payload, err := kernel.RecordFromJSON(obj["interruptPayload"])
		if err != nil {
			return kernel.StagedResult{}, fmt.Errorf("staged result interruptPayload: %w", err)
		}
		result.InterruptPayload = payload
	}
	return result, nil
}

// --- kernel.logical.diff-paths ---

func runLogicalDiffPaths(rawInput json.RawMessage) operationOutcome {
	fixture, rpcErr := readInputFixture(rawInput)
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	changeSet, err := parseChangeSetJSON(fixture["turnTreeChangeSet"])
	if err != nil {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", err.Error())}
	}

	k := newRuntimeKernel()
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}
	created, err := k.CreateThread("thread_conformance", "schema_main", "branch_main")
	if err != nil {
		return errorOutcomeFor(err)
	}

	changedTreeHash, err := k.CreateTurnTree("schema_main", changeSet, &created.RootTurnTreeHash)
	if err != nil {
		return errorOutcomeFor(err)
	}
	diff, err := k.DiffTurnTrees(created.RootTurnTreeHash, changedTreeHash)
	if err != nil {
		return errorOutcomeFor(err)
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{"diffPaths": diff})}
}

// --- kernel.logical.branch-list ---

func runLogicalBranchList(rawInput json.RawMessage) operationOutcome {
	if _, rpcErr := readInputFixture(rawInput); rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	k := newRuntimeKernel()
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}
	if _, err := k.CreateThread("thread_conformance", "schema_main", "branch_main"); err != nil {
		return errorOutcomeFor(err)
	}

	entries, err := k.ListBranchHeads("thread_conformance")
	if err != nil {
		return errorOutcomeFor(err)
	}
	branchEntries := make([][2]string, len(entries))
	copy(branchEntries, entries)

	return operationOutcome{Kind: "result", Value: projection(map[string]any{"branchEntries": branchEntries})}
}

// --- kernel.logical.recovery-state ---

func runLogicalRecoveryState(rawInput json.RawMessage) operationOutcome {
	fixture, rpcErr := readInputFixture(rawInput)
	if rpcErr != nil {
		return operationOutcome{Kind: "error", Error: rpcErr}
	}

	recoveryFixture, ok := fixture["recoveryState"].(map[string]any)
	if !ok {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", "fixture.recoveryState must be a JSON object")}
	}
	stepSequence, err := parseStepSequenceJSON(recoveryFixture["stepSequence"])
	if err != nil {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", err.Error())}
	}
	if len(stepSequence) < 2 {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", "fixture.recoveryState.stepSequence must declare at least 2 steps")}
	}

	consumedArray, ok := recoveryFixture["consumedStagedResults"].([]any)
	if !ok || len(consumedArray) == 0 {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", "fixture.recoveryState.consumedStagedResults must be a non-empty array")}
	}
	consumedFixture, err := parseStagedResultJSON(consumedArray[0])
	if err != nil {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", err.Error())}
	}

	uncommittedArray, ok := recoveryFixture["uncommittedStagedResults"].([]any)
	if !ok || len(uncommittedArray) == 0 {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", "fixture.recoveryState.uncommittedStagedResults must be a non-empty array")}
	}
	uncommittedFixture, err := parseStagedResultJSON(uncommittedArray[0])
	if err != nil {
		return operationOutcome{Kind: "error", Error: kernelErrorEnvelope("invalid_operation_input", err.Error())}
	}

	k := newRuntimeKernel()
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}
	created, err := k.CreateThread("thread_recovery", "schema_main", "branch_recovery")
	if err != nil {
		return errorOutcomeFor(err)
	}
	if err := k.CreateRun("run_recovery", "turn_recovery", "branch_recovery", "schema_main", created.RootTurnNodeHash, stepSequence[:2]); err != nil {
		return errorOutcomeFor(err)
	}

	// A staged result consumed before the run's first step boundary, so
	// the recovery-state scenario demonstrates that consumedStagedResults
	// reflects only the *most recent* checkpoint's consumption, not the
	// run's entire history.
	preFixture := kernel.StagedResult{
		TaskID: "pre_fixture_consumed", ObjectHash: kernel.HashBytesToHex([]byte("pre-fixture-consumed")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 0,
	}
	if err := k.StageResult("run_recovery", preFixture); err != nil {
		return errorOutcomeFor(err)
	}
	if _, err := k.CompleteStep("run_recovery", stepSequence[0].ID, "", ""); err != nil {
		return errorOutcomeFor(err)
	}

	if err := k.StageResult("run_recovery", consumedFixture); err != nil {
		return errorOutcomeFor(err)
	}
	if _, err := k.CompleteStep("run_recovery", stepSequence[1].ID, "", ""); err != nil {
		return errorOutcomeFor(err)
	}

	if err := k.StageResult("run_recovery", uncommittedFixture); err != nil {
		return errorOutcomeFor(err)
	}

	state, err := k.RecoveryState("run_recovery")
	if err != nil {
		return errorOutcomeFor(err)
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"recovery": map[string]any{
			"lastCompletedStepId":      state.LastCompletedStepID,
			"consumedStagedResults":    len(state.ConsumedStagedResults),
			"uncommittedStagedResults": len(state.UncommittedStagedResults),
		},
	})}
}

// --- kernel.lineage.cross-thread-rejection ---

func runLineageCrossThreadRejection(json.RawMessage) operationOutcome {
	k := newRuntimeKernel()
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}

	resultA, err := k.CreateThread("thread_lineage_a", "schema_main", "branch_lineage_a")
	if err != nil {
		return errorOutcomeFor(err)
	}
	eventHash := k.PutObject("application/json", []byte("lineage-cross-thread-event"))
	if err := k.CreateRun("run_lineage_a", "turn_lineage_a", "branch_lineage_a", "schema_main", resultA.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "step_a", Deterministic: true, SideEffects: false},
	}); err != nil {
		return errorOutcomeFor(err)
	}
	nodeA, err := k.CompleteStep("run_lineage_a", "step_a", eventHash, "")
	if err != nil {
		return errorOutcomeFor(err)
	}

	if _, err := k.CreateThread("thread_lineage_b", "schema_main", "branch_lineage_b"); err != nil {
		return errorOutcomeFor(err)
	}

	errorCode := "unexpected_success"
	if err := k.CreateBranch("branch_cross_thread", "thread_lineage_b", nodeA); err != nil {
		if kerr, ok := kernel.AsKernelError(err); ok {
			errorCode = kerr.Code
		} else {
			errorCode = "internal_error"
		}
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{"errorCode": errorCode})}
}

// --- kernel.protocol.edge-validation ---

// captureCode runs probe and returns "unexpected_success" if it succeeds,
// or the kernel error code it produced. This mirrors
// typescript/kernel/conformance-adapter/src/host.ts's
// captureSemanticErrorCode: an edge-validation probe that unexpectedly
// succeeds must report that cleanly (failing exactly the one assertion
// that expected a specific error code) rather than the adapter crashing or
// masking the surprise.
func captureCode(probe func() error) string {
	err := probe()
	if err == nil {
		return "unexpected_success"
	}
	if kerr, ok := kernel.AsKernelError(err); ok {
		return kerr.Code
	}
	return "internal_error"
}

func runProtocolEdgeValidation(json.RawMessage) operationOutcome {
	schema := canonicalTurnTreeSchema()

	duplicatePathCode := captureCode(func() error {
		record, err := recordFromTurnTreeSchema(kernel.TurnTreeSchema{
			SchemaID: "schema_edge_duplicate",
			Paths: []kernel.PathDefinition{
				{Path: "firstPath", Collection: kernel.PathCollectionSingle},
				{Path: "firstPath", Collection: kernel.PathCollectionSingle},
			},
		})
		if err != nil {
			return err
		}
		_, err = kernel.ValidateTurnTreeSchema(record)
		return err
	})

	missingRequiredPathCode := captureCode(func() error {
		k := newRuntimeKernel()
		if err := k.RegisterSchema(schema); err != nil {
			return err
		}
		_, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
			"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		}, nil)
		return err
	})

	schemaMismatchCode := captureCode(func() error {
		k := newRuntimeKernel()
		if err := k.RegisterSchema(schema); err != nil {
			return err
		}
		otherSchema := kernel.TurnTreeSchema{SchemaID: "schema_edge_other", Paths: []kernel.PathDefinition{
			{Path: "solo", Collection: kernel.PathCollectionSingle},
		}}
		if err := k.RegisterSchema(otherSchema); err != nil {
			return err
		}
		treeA, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
			"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
			"context.manifest": {Kind: kernel.PathValueNull},
		}, nil)
		if err != nil {
			return err
		}
		treeB, err := k.CreateTurnTree("schema_edge_other", map[string]kernel.PathValue{"solo": {Kind: kernel.PathValueNull}}, nil)
		if err != nil {
			return err
		}
		_, err = k.DiffTurnTrees(treeA, treeB)
		return err
	})

	busyBranchCode := captureCode(func() error {
		k := newRuntimeKernel()
		if err := k.RegisterSchema(schema); err != nil {
			return err
		}
		created, err := k.CreateThread("thread_edge_busy", "schema_main", "branch_edge_busy")
		if err != nil {
			return err
		}
		steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
		if err := k.CreateRun("run_edge_busy_1", "turn_edge_busy_1", "branch_edge_busy", "schema_main", created.RootTurnNodeHash, steps); err != nil {
			return err
		}
		return k.CreateRun("run_edge_busy_2", "turn_edge_busy_2", "branch_edge_busy", "schema_main", created.RootTurnNodeHash, steps)
	})

	outOfOrderStepCode := captureCode(func() error {
		k := newRuntimeKernel()
		if err := k.RegisterSchema(schema); err != nil {
			return err
		}
		created, err := k.CreateThread("thread_edge_step_order", "schema_main", "branch_edge_step_order")
		if err != nil {
			return err
		}
		steps := []kernel.StepDeclaration{
			{ID: "first", Deterministic: true, SideEffects: false},
			{ID: "second", Deterministic: true, SideEffects: false},
		}
		if err := k.CreateRun("run_edge_step_order", "turn_edge_step_order", "branch_edge_step_order", "schema_main", created.RootTurnNodeHash, steps); err != nil {
			return err
		}
		return k.BeginStep("run_edge_step_order", "second")
	})

	missingEventObjectCode := captureCode(func() error {
		k := newRuntimeKernel()
		if err := k.RegisterSchema(schema); err != nil {
			return err
		}
		created, err := k.CreateThread("thread_edge_event", "schema_main", "branch_edge_event")
		if err != nil {
			return err
		}
		steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
		if err := k.CreateRun("run_edge_event", "turn_edge_event", "branch_edge_event", "schema_main", created.RootTurnNodeHash, steps); err != nil {
			return err
		}
		neverStoredEventHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		_, err = k.CompleteStep("run_edge_event", "only_step", neverStoredEventHash, "")
		return err
	})

	lateralHeadCode := captureCode(func() error {
		k := newRuntimeKernel()
		if err := k.RegisterSchema(schema); err != nil {
			return err
		}
		created, err := k.CreateThread("thread_edge_lateral", "schema_main", "branch_edge_lateral_main")
		if err != nil {
			return err
		}
		mainEventHash := k.PutObject("application/json", []byte("edge-lateral-main-event"))
		steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
		if err := k.CreateRun("run_edge_lateral_main", "turn_edge_lateral_main", "branch_edge_lateral_main", "schema_main", created.RootTurnNodeHash, steps); err != nil {
			return err
		}
		if _, err := k.CompleteStep("run_edge_lateral_main", "only_step", mainEventHash, ""); err != nil {
			return err
		}

		if err := k.CreateBranch("branch_edge_lateral_fork", "thread_edge_lateral", created.RootTurnNodeHash); err != nil {
			return err
		}
		forkEventHash := k.PutObject("application/json", []byte("edge-lateral-fork-event"))
		if err := k.CreateRun("run_edge_lateral_fork", "turn_edge_lateral_fork", "branch_edge_lateral_fork", "schema_main", created.RootTurnNodeHash, steps); err != nil {
			return err
		}
		forkNodeHash, err := k.CompleteStep("run_edge_lateral_fork", "only_step", forkEventHash, "")
		if err != nil {
			return err
		}

		return k.SetBranchHead("branch_edge_lateral_main", forkNodeHash)
	})

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"protocolEdgeValidation": map[string]any{
			"schema": map[string]any{"duplicatePathCode": duplicatePathCode},
			"tree": map[string]any{
				"missingRequiredPathCode": missingRequiredPathCode,
				"schemaMismatchCode":      schemaMismatchCode,
			},
			"run": map[string]any{
				"busyBranchCode":         busyBranchCode,
				"outOfOrderStepCode":     outOfOrderStepCode,
				"missingEventObjectCode": missingEventObjectCode,
			},
			"branch": map[string]any{"lateralHeadCode": lateralHeadCode},
		},
	})}
}

// recordFromTurnTreeSchema builds the kernel.Record shape ValidateTurnTreeSchema
// expects from a kernel.TurnTreeSchema Go value, so probes that need to
// exercise record-level validation (rather than the already-registered
// Kernel.RegisterSchema path) can do so directly.
func recordFromTurnTreeSchema(schema kernel.TurnTreeSchema) (kernel.Record, error) {
	paths := make(kernel.RecordArray, 0, len(schema.Paths))
	for _, p := range schema.Paths {
		paths = append(paths, kernel.RecordMap{
			"path":       kernel.RecordText(p.Path),
			"collection": kernel.RecordText(string(p.Collection)),
		})
	}
	rules := make(kernel.RecordArray, 0, len(schema.IncorporationRules))
	for _, r := range schema.IncorporationRules {
		rules = append(rules, kernel.RecordMap{
			"objectType": kernel.RecordText(r.ObjectType),
			"targetPath": kernel.RecordText(r.TargetPath),
		})
	}
	return kernel.RecordMap{
		"schemaId":           kernel.RecordText(schema.SchemaID),
		"paths":              paths,
		"incorporationRules": rules,
	}, nil
}

// --- kernel.logical.thread-list ---

func runLogicalThreadList(json.RawMessage) operationOutcome {
	k := newRuntimeKernel()
	if err := k.RegisterSchema(canonicalTurnTreeSchema()); err != nil {
		return errorOutcomeFor(err)
	}
	if _, err := k.CreateThread("thread_enum_a", "schema_main", "branch_enum_a"); err != nil {
		return errorOutcomeFor(err)
	}
	if _, err := k.CreateThread("thread_enum_b", "schema_main", "branch_enum_b"); err != nil {
		return errorOutcomeFor(err)
	}

	all, _, err := k.ListThreads(0, "")
	if err != nil {
		return errorOutcomeFor(err)
	}
	paged, nextCursor, err := k.ListThreads(1, "")
	if err != nil {
		return errorOutcomeFor(err)
	}

	firstThreadID := ""
	if len(all) > 0 {
		firstThreadID = all[0].ThreadID
	}

	return operationOutcome{Kind: "result", Value: projection(map[string]any{
		"threadEnumeration": map[string]any{
			"count":         len(all),
			"firstThreadId": firstThreadID,
			"pagedCount":    len(paged),
			"hasCursor":     nextCursor != "",
		},
	})}
}
