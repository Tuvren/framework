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

func newTestKernel() *kernel.Kernel {
	clock := &kernel.IncrementingClock{}
	backend := kernel.NewInMemoryBackend(clock)
	return kernel.NewKernel("test-scope", clock, backend)
}

func canonicalSchema() kernel.TurnTreeSchema {
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

func requireErrCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %q, got nil", code)
	}
	kerr, ok := kernel.AsKernelError(err)
	if !ok {
		t.Fatalf("expected a *KernelError, got %T: %v", err, err)
	}
	if kerr.Code != code {
		t.Fatalf("expected error code %q, got %q (%v)", code, kerr.Code, err)
	}
}

// --- schema registry ---

func TestRegisterSchema_DuplicatePathRejected(t *testing.T) {
	schema := kernel.TurnTreeSchema{
		SchemaID: "schema_dup",
		Paths: []kernel.PathDefinition{
			{Path: "messages", Collection: kernel.PathCollectionOrdered},
			{Path: "messages", Collection: kernel.PathCollectionOrdered},
		},
	}
	record, err := recordFromSchema(schema)
	if err != nil {
		t.Fatalf("build record: %v", err)
	}
	_, err = kernel.ValidateTurnTreeSchema(record)
	requireErrCode(t, err, kernel.ErrDuplicateSchemaPath)
}

func TestRegisterSchema_Succeeds(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
}

// --- turn tree create/diff ---

func TestCreateTurnTree_MissingRequiredPath(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	changes := map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		// context.manifest intentionally omitted
	}
	_, err := k.CreateTurnTree("schema_main", changes, nil)
	requireErrCode(t, err, kernel.ErrMissingRequiredTreePath)
}

func TestCreateTurnTree_MissingSingleCollectionPathExplicitCase(t *testing.T) {
	// Adversarial regression: only the ordered path is supplied, exactly
	// like the protocol edge-validation probe.
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	_, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages": {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
	}, nil)
	requireErrCode(t, err, kernel.ErrMissingRequiredTreePath)
}

func TestCreateTurnTree_ModifyProducesNewHashWithStructuralSharing(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	baseHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create base: %v", err)
	}

	manifestHash := kernel.HashBytesToHex([]byte("manifest-object"))
	modifiedHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"context.manifest": {Kind: kernel.PathValueSingleKind, Single: manifestHash},
	}, &baseHash)
	if err != nil {
		t.Fatalf("modify: %v", err)
	}
	if modifiedHash == baseHash {
		t.Fatal("expected modify to produce a new tree hash")
	}

	changed, err := k.DiffTurnTrees(baseHash, modifiedHash)
	if err != nil {
		t.Fatalf("diff: %v", err)
	}
	if !reflect.DeepEqual(changed, []string{"context.manifest"}) {
		t.Fatalf("expected only context.manifest to have changed, got %v", changed)
	}
}

func TestCreateTurnTree_ModifyWrongSchemaMismatch(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	otherSchema := kernel.TurnTreeSchema{SchemaID: "schema_other", Paths: []kernel.PathDefinition{
		{Path: "solo", Collection: kernel.PathCollectionSingle},
	}}
	if err := k.RegisterSchema(otherSchema); err != nil {
		t.Fatalf("register other: %v", err)
	}

	baseHash, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create base: %v", err)
	}

	_, err = k.CreateTurnTree("schema_other", map[string]kernel.PathValue{"solo": {Kind: kernel.PathValueNull}}, &baseHash)
	requireErrCode(t, err, kernel.ErrTreeSchemaMismatch)
}

func TestDiffTurnTrees_SchemaMismatch(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	otherSchema := kernel.TurnTreeSchema{SchemaID: "schema_other", Paths: []kernel.PathDefinition{
		{Path: "solo", Collection: kernel.PathCollectionSingle},
	}}
	if err := k.RegisterSchema(otherSchema); err != nil {
		t.Fatalf("register other: %v", err)
	}

	treeA, err := k.CreateTurnTree("schema_main", map[string]kernel.PathValue{
		"messages":         {Kind: kernel.PathValueOrderedKind, Ordered: []string{}},
		"context.manifest": {Kind: kernel.PathValueNull},
	}, nil)
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	treeB, err := k.CreateTurnTree("schema_other", map[string]kernel.PathValue{"solo": {Kind: kernel.PathValueNull}}, nil)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	_, err = k.DiffTurnTrees(treeA, treeB)
	requireErrCode(t, err, kernel.ErrTreeSchemaMismatchDiff)
}

// --- thread / branch ---

func TestCreateThread_CreatesRootNodeAndMainBranch(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}

	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if result.ThreadID != "thread_a" || result.BranchID != "branch_main" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.RootTurnNodeHash == "" || result.RootTurnTreeHash == "" {
		t.Fatalf("expected non-empty hashes: %+v", result)
	}

	heads, err := k.ListBranchHeads("thread_a")
	if err != nil {
		t.Fatalf("list branch heads: %v", err)
	}
	if len(heads) != 1 || heads[0][0] != "branch_main" || heads[0][1] != result.RootTurnNodeHash {
		t.Fatalf("unexpected branch heads: %v", heads)
	}
}

func TestCreateBranch_CrossThreadRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	resultA, err := k.CreateThread("thread_a", "schema_main", "branch_a_main")
	if err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_b", "schema_main", "branch_b_main"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	// A node minted purely from schema/tree defaults (like a fresh root
	// node) can legitimately collide in hash across two threads that share
	// a schema, so it wouldn't exercise the ownership guard at all.
	// Advancing thread_a's branch with a step tagged to a distinct event
	// object guarantees a node hash no other thread could have minted.
	distinguishingEventHash := k.PutObject("application/json", []byte("thread-a-only-event"))
	if err := k.CreateRun("run_a", "turn_a", "branch_a_main", "schema_main", resultA.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run a: %v", err)
	}
	nodeA, err := k.CompleteStep("run_a", "only_step", distinguishingEventHash)
	if err != nil {
		t.Fatalf("complete step a: %v", err)
	}

	err = k.CreateBranch("branch_cross_thread", "thread_b", nodeA)
	requireErrCode(t, err, kernel.ErrTurnNodeThreadMismatch)
}

func TestSetBranchHead_LateralMovementRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}

	// Advance branch_main itself with its own step first, so its current
	// head is no longer the shared root.
	mainEventHash := k.PutObject("application/json", []byte("main-branch-event"))
	if err := k.CreateRun("run_main", "turn_main", "branch_main", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create main run: %v", err)
	}
	if _, err := k.CompleteStep("run_main", "only_step", mainEventHash); err != nil {
		t.Fatalf("complete main step: %v", err)
	}

	// Fork a sibling branch from the same root, then advance the sibling
	// with its own run (tagged to a distinct event object so its node
	// doesn't collide with branch_main's) so it has a node the main
	// branch's head chain never passes through.
	if err := k.CreateBranch("branch_fork", "thread_a", result.RootTurnNodeHash); err != nil {
		t.Fatalf("fork: %v", err)
	}
	forkEventHash := k.PutObject("application/json", []byte("fork-branch-event"))
	if err := k.CreateRun("run_fork", "turn_fork", "branch_fork", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create fork run: %v", err)
	}
	forkNodeHash, err := k.CompleteStep("run_fork", "only_step", forkEventHash)
	if err != nil {
		t.Fatalf("complete fork step: %v", err)
	}

	err = k.SetBranchHead("branch_main", forkNodeHash)
	requireErrCode(t, err, kernel.ErrLateralHeadMovement)
}

func TestSetBranchHead_ForwardMovementAccepted(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if err := k.CreateRun("run_main", "turn_main", "branch_main", "schema_main", result.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run: %v", err)
	}
	nodeHash, err := k.CompleteStep("run_main", "only_step", "")
	if err != nil {
		t.Fatalf("complete step: %v", err)
	}
	if err := k.SetBranchHead("branch_main", nodeHash); err != nil {
		t.Fatalf("forward move: %v", err)
	}
}

func TestSetBranchHead_CrossThreadNodeRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	resultA, err := k.CreateThread("thread_a", "schema_main", "branch_a_main")
	if err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_b", "schema_main", "branch_b_main"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	distinguishingEventHash := k.PutObject("application/json", []byte("thread-a-only-event-2"))
	if err := k.CreateRun("run_a", "turn_a", "branch_a_main", "schema_main", resultA.RootTurnNodeHash, []kernel.StepDeclaration{
		{ID: "only_step", Deterministic: true, SideEffects: false},
	}); err != nil {
		t.Fatalf("create run a: %v", err)
	}
	nodeA, err := k.CompleteStep("run_a", "only_step", distinguishingEventHash)
	if err != nil {
		t.Fatalf("complete step a: %v", err)
	}

	err = k.SetBranchHead("branch_b_main", nodeA)
	requireErrCode(t, err, kernel.ErrTurnNodeThreadMismatch)
}

// --- run lifecycle ---

func TestCreateRun_SecondActiveRunOnBranchRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run 1: %v", err)
	}
	err = k.CreateRun("run_2", "turn_2", "branch_main", "schema_main", result.RootTurnNodeHash, steps)
	requireErrCode(t, err, kernel.ErrBranchAlreadyActive)
}

func TestBeginStep_OutOfOrderRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "first", Deterministic: true, SideEffects: false},
		{ID: "second", Deterministic: true, SideEffects: false},
	}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	err = k.BeginStep("run_1", "second")
	requireErrCode(t, err, kernel.ErrUnexpectedStep)
}

func TestCompleteStep_MissingEventObjectRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	missingEventHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	_, err = k.CompleteStep("run_1", "only_step", missingEventHash)
	requireErrCode(t, err, kernel.ErrMissingEventObject)
}

func TestCompleteStep_ExistingEventObjectAccepted(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	eventHash := k.PutObject("application/json", []byte("event-payload"))

	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := k.CompleteStep("run_1", "only_step", eventHash); err != nil {
		t.Fatalf("complete step: %v", err)
	}
}

func TestCompleteRun_MissingEventObjectRejected(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_a", "schema_main", "branch_main")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{{ID: "only_step", Deterministic: true, SideEffects: false}}
	if err := k.CreateRun("run_1", "turn_1", "branch_main", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := k.CompleteStep("run_1", "only_step", ""); err != nil {
		t.Fatalf("complete step: %v", err)
	}

	err = k.CompleteRun("run_1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	requireErrCode(t, err, kernel.ErrMissingEventObject)
}

// --- staged results / recovery state ---

func TestRecoveryState_MatchesRustReferenceScenario(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	result, err := k.CreateThread("thread_recovery", "schema_main", "branch_recovery")
	if err != nil {
		t.Fatalf("create thread: %v", err)
	}
	steps := []kernel.StepDeclaration{
		{ID: "model_call", Deterministic: false, SideEffects: false},
		{ID: "tool_execution", Deterministic: false, SideEffects: true},
	}
	if err := k.CreateRun("run_recovery", "turn_recovery", "branch_recovery", "schema_main", result.RootTurnNodeHash, steps); err != nil {
		t.Fatalf("create run: %v", err)
	}

	preFixture := kernel.StagedResult{
		TaskID: "pre_fixture_consumed", ObjectHash: kernel.HashBytesToHex([]byte("pre")),
		ObjectType: "message", Status: kernel.StagedResultCompleted, Timestamp: 1,
	}
	if err := k.StageResult("run_recovery", preFixture); err != nil {
		t.Fatalf("stage pre-fixture: %v", err)
	}
	if _, err := k.CompleteStep("run_recovery", "model_call", ""); err != nil {
		t.Fatalf("complete model_call: %v", err)
	}

	consumed := kernel.StagedResult{
		TaskID: "consumed", ObjectHash: kernel.HashBytesToHex([]byte("consumed")),
		ObjectType: "tool_result", Status: kernel.StagedResultCompleted, Timestamp: 2,
	}
	if err := k.StageResult("run_recovery", consumed); err != nil {
		t.Fatalf("stage consumed: %v", err)
	}
	if _, err := k.CompleteStep("run_recovery", "tool_execution", ""); err != nil {
		t.Fatalf("complete tool_execution: %v", err)
	}

	uncommitted := kernel.StagedResult{
		TaskID: "uncommitted", ObjectHash: kernel.HashBytesToHex([]byte("uncommitted")),
		ObjectType: "tool_result", Status: kernel.StagedResultInterrupted, Timestamp: 3,
		InterruptPayload: kernel.RecordText("paused"),
	}
	if err := k.StageResult("run_recovery", uncommitted); err != nil {
		t.Fatalf("stage uncommitted: %v", err)
	}

	state, err := k.RecoveryState("run_recovery")
	if err != nil {
		t.Fatalf("recovery state: %v", err)
	}
	if !state.HasLastCompletedStepID || state.LastCompletedStepID != "tool_execution" {
		t.Fatalf("expected lastCompletedStepId tool_execution, got %+v", state)
	}
	if len(state.ConsumedStagedResults) != 1 || state.ConsumedStagedResults[0].TaskID != "consumed" {
		t.Fatalf("expected exactly the tool_execution checkpoint's consumed result, got %+v", state.ConsumedStagedResults)
	}
	if len(state.UncommittedStagedResults) != 1 || state.UncommittedStagedResults[0].TaskID != "uncommitted" {
		t.Fatalf("expected exactly one uncommitted staged result, got %+v", state.UncommittedStagedResults)
	}
}

// --- thread enumeration ---

func TestListThreads_DeterministicOrderAndCursorPaging(t *testing.T) {
	k := newTestKernel()
	if err := k.RegisterSchema(canonicalSchema()); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := k.CreateThread("thread_enum_a", "schema_main", "branch_enum_a"); err != nil {
		t.Fatalf("create thread a: %v", err)
	}
	if _, err := k.CreateThread("thread_enum_b", "schema_main", "branch_enum_b"); err != nil {
		t.Fatalf("create thread b: %v", err)
	}

	all, cursor, err := k.ListThreads(0, "")
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 2 || cursor != "" {
		t.Fatalf("expected 2 threads and no cursor, got %d threads, cursor=%q", len(all), cursor)
	}
	if all[0].ThreadID != "thread_enum_a" {
		t.Fatalf("expected thread_enum_a first, got %q", all[0].ThreadID)
	}

	page, nextCursor, err := k.ListThreads(1, "")
	if err != nil {
		t.Fatalf("list page: %v", err)
	}
	if len(page) != 1 || page[0].ThreadID != "thread_enum_a" {
		t.Fatalf("expected a 1-item page starting at thread_enum_a, got %+v", page)
	}
	if nextCursor == "" {
		t.Fatal("expected a non-empty next cursor when the page was truncated")
	}

	rest, restCursor, err := k.ListThreads(10, nextCursor)
	if err != nil {
		t.Fatalf("list rest: %v", err)
	}
	if len(rest) != 1 || rest[0].ThreadID != "thread_enum_b" {
		t.Fatalf("expected thread_enum_b to be the only remaining thread, got %+v", rest)
	}
	if restCursor != "" {
		t.Fatalf("expected no further cursor, got %q", restCursor)
	}
}

// recordFromSchema builds a kernel.Record for a TurnTreeSchema so
// validate_test-style scenarios can exercise ValidateTurnTreeSchema
// directly without going through JSON.
func recordFromSchema(schema kernel.TurnTreeSchema) (kernel.Record, error) {
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
