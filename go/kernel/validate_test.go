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
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

func TestValidateTurnTreeSchema_RejectsUnknownField(t *testing.T) {
	record := kernel.RecordMap{
		"schemaId":           kernel.RecordText("schema_main"),
		"paths":              kernel.RecordArray{},
		"incorporationRules": kernel.RecordArray{},
		"unexpectedField":    kernel.RecordText("nope"),
	}
	_, err := kernel.ValidateTurnTreeSchema(record)
	requireErrCode(t, err, kernel.ErrUnknownRecordField)
}

func TestValidateTurnTreeSchema_RejectsDuplicatePath(t *testing.T) {
	record := kernel.RecordMap{
		"schemaId": kernel.RecordText("schema_main"),
		"paths": kernel.RecordArray{
			kernel.RecordMap{"path": kernel.RecordText("messages"), "collection": kernel.RecordText("ordered")},
			kernel.RecordMap{"path": kernel.RecordText("messages"), "collection": kernel.RecordText("ordered")},
		},
		"incorporationRules": kernel.RecordArray{},
	}
	_, err := kernel.ValidateTurnTreeSchema(record)
	requireErrCode(t, err, kernel.ErrDuplicateSchemaPath)
}

func TestValidateTurnTreeSchema_AcceptsWellFormedSchema(t *testing.T) {
	record := kernel.RecordMap{
		"schemaId": kernel.RecordText("schema_main"),
		"paths": kernel.RecordArray{
			kernel.RecordMap{"path": kernel.RecordText("messages"), "collection": kernel.RecordText("ordered")},
			kernel.RecordMap{
				"path":       kernel.RecordText("context.manifest"),
				"collection": kernel.RecordText("single"),
				"metadata":   kernel.RecordNull{},
			},
		},
		"incorporationRules": kernel.RecordArray{
			kernel.RecordMap{"objectType": kernel.RecordText("message"), "targetPath": kernel.RecordText("messages")},
		},
	}
	schema, err := kernel.ValidateTurnTreeSchema(record)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if schema.SchemaID != "schema_main" || len(schema.Paths) != 2 {
		t.Fatalf("unexpected schema: %+v", schema)
	}
}

func TestValidatePathDefinition_RejectsInvalidCollectionKind(t *testing.T) {
	record := kernel.RecordMap{
		"schemaId": kernel.RecordText("schema_main"),
		"paths": kernel.RecordArray{
			kernel.RecordMap{"path": kernel.RecordText("messages"), "collection": kernel.RecordText("not-a-real-kind")},
		},
		"incorporationRules": kernel.RecordArray{},
	}
	_, err := kernel.ValidateTurnTreeSchema(record)
	requireErrCode(t, err, kernel.ErrInvalidRecordField)
}

func TestValidateStepDeclaration_RejectsMissingRequiredField(t *testing.T) {
	record := kernel.RecordMap{
		"id":            kernel.RecordText("step_a"),
		"deterministic": kernel.RecordBool(true),
		// sideEffects intentionally omitted
	}
	_, err := kernel.ValidateStepDeclaration(record)
	requireErrCode(t, err, kernel.ErrMissingRecordField)
}

func TestValidateStepDeclaration_AcceptsAbsentOptionalMetadata(t *testing.T) {
	record := kernel.RecordMap{
		"id":            kernel.RecordText("step_a"),
		"deterministic": kernel.RecordBool(true),
		"sideEffects":   kernel.RecordBool(false),
	}
	decl, err := kernel.ValidateStepDeclaration(record)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if decl.HasMetadata {
		t.Fatal("expected metadata to be absent, not present")
	}
}

func TestValidateStepDeclaration_AcceptsExplicitNullMetadata(t *testing.T) {
	// metadata's CDDL type is kernel-record, whose own union includes null,
	// so an explicit null is a legitimate value here (unlike a field typed
	// without null in its union).
	record := kernel.RecordMap{
		"id":            kernel.RecordText("step_a"),
		"deterministic": kernel.RecordBool(true),
		"sideEffects":   kernel.RecordBool(false),
		"metadata":      kernel.RecordNull{},
	}
	decl, err := kernel.ValidateStepDeclaration(record)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if !decl.HasMetadata {
		t.Fatal("expected metadata to be present (as an explicit null)")
	}
}

func TestValidateStagedResult_InterruptedRequiresPayload(t *testing.T) {
	record := kernel.RecordMap{
		"taskId":     kernel.RecordText("task_1"),
		"objectHash": kernel.RecordText(kernel.HashBytesToHex([]byte("x"))),
		"objectType": kernel.RecordText("tool_result"),
		"timestamp":  kernel.RecordInt(1),
		"status":     kernel.RecordText("interrupted"),
		// interruptPayload intentionally omitted
	}
	_, err := kernel.ValidateStagedResult(record)
	requireErrCode(t, err, kernel.ErrMissingRecordField)
}

func TestValidateStagedResult_SettledRejectsInterruptPayloadField(t *testing.T) {
	// interruptPayload is only in the interrupted-staged-result shape; a
	// settled (completed/failed) record carrying it violates the closed-map
	// rule for that variant.
	record := kernel.RecordMap{
		"taskId":           kernel.RecordText("task_1"),
		"objectHash":       kernel.RecordText(kernel.HashBytesToHex([]byte("x"))),
		"objectType":       kernel.RecordText("tool_result"),
		"timestamp":        kernel.RecordInt(1),
		"status":           kernel.RecordText("completed"),
		"interruptPayload": kernel.RecordText("nope"),
	}
	_, err := kernel.ValidateStagedResult(record)
	requireErrCode(t, err, kernel.ErrUnknownRecordField)
}

func TestValidateStagedResult_RejectsUnknownStatus(t *testing.T) {
	record := kernel.RecordMap{
		"taskId":     kernel.RecordText("task_1"),
		"objectHash": kernel.RecordText(kernel.HashBytesToHex([]byte("x"))),
		"objectType": kernel.RecordText("tool_result"),
		"timestamp":  kernel.RecordInt(1),
		"status":     kernel.RecordText("not-a-real-status"),
	}
	_, err := kernel.ValidateStagedResult(record)
	requireErrCode(t, err, kernel.ErrInvalidRecordField)
}

func TestValidateTurnTreeManifestLike_AcceptsNullSingleAndOrderedValues(t *testing.T) {
	hashA := kernel.HashBytesToHex([]byte("a"))
	hashB := kernel.HashBytesToHex([]byte("b"))
	record := kernel.RecordMap{
		"context.manifest": kernel.RecordNull{},
		"single.path":      kernel.RecordText(hashA),
		"messages":         kernel.RecordArray{kernel.RecordText(hashA), kernel.RecordText(hashB)},
	}
	manifest, err := kernel.ValidateTurnTreeManifestLike(record, "turn-tree-manifest")
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if manifest["context.manifest"].Kind != kernel.PathValueNull {
		t.Fatalf("expected null path value, got %+v", manifest["context.manifest"])
	}
	if manifest["single.path"].Kind != kernel.PathValueSingleKind || manifest["single.path"].Single != hashA {
		t.Fatalf("unexpected single path value: %+v", manifest["single.path"])
	}
	if manifest["messages"].Kind != kernel.PathValueOrderedKind || len(manifest["messages"].Ordered) != 2 {
		t.Fatalf("unexpected ordered path value: %+v", manifest["messages"])
	}
}
