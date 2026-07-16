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

// Package kernel: this file is a typed CDDL validation layer for the
// record families the M2 runtime kernel ingests (spec/kernel/cddl/kernel-records.cddl:
// turn-tree-schema, path-definition, incorporation-rule, step-declaration,
// staged-result, turn-tree-manifest / turn-tree-change-set). It sits between
// the generic kernel.Record decoding in cbor.go/json.go and the runtime
// kernel logic in kernel_runtime.go: every record the runtime kernel accepts
// from a caller is validated here first.
//
// Two structural rules apply uniformly:
//
//  1. CDDL maps in this record family are closed: a record carrying a field
//     name absent from the map's grammar is a validation error, not
//     silently-ignored extra data.
//  2. Absent vs. null is significant for optional fields whose CDDL type
//     does not itself include null: leaving the field out entirely is
//     valid, but explicitly setting it to null where the field's type
//     doesn't allow null is a validation error. Optional fields typed as
//     kernel-record (which itself includes null in its union) accept an
//     explicit null the same as any other kernel-record value.
package kernel

import (
	"fmt"
	"regexp"
)

const (
	ErrUnknownRecordField  = "kernel_record_unknown_field"
	ErrMissingRecordField  = "kernel_record_missing_field"
	ErrInvalidRecordField  = "kernel_record_invalid_field"
	ErrNullNotAllowedField = "kernel_record_null_not_allowed"
)

var hashStringPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// --- generic record-shape helpers ---

func expectMap(value Record, context string) (RecordMap, error) {
	m, ok := value.(RecordMap)
	if !ok {
		return nil, newKernelError(ErrInvalidRecordField, "%s: expected a map, got %T", context, value)
	}
	return m, nil
}

func expectArray(value Record, context string) (RecordArray, error) {
	a, ok := value.(RecordArray)
	if !ok {
		return nil, newKernelError(ErrInvalidRecordField, "%s: expected an array, got %T", context, value)
	}
	return a, nil
}

// requiredField returns the record at key, erroring if the key is absent.
// An explicit null value is returned as-is (RecordNull{}); callers whose
// field type does not permit null must reject it themselves via
// requireNonNull.
func requiredField(m RecordMap, key, context string) (Record, error) {
	value, ok := m[key]
	if !ok {
		return nil, newKernelError(ErrMissingRecordField, "%s: missing required field %q", context, key)
	}
	return value, nil
}

// optionalField returns the record at key and whether it was present at
// all (present-with-null counts as present).
func optionalField(m RecordMap, key string) (Record, bool) {
	value, ok := m[key]
	return value, ok
}

func requireNonNull(value Record, key, context string) (Record, error) {
	if _, isNull := value.(RecordNull); isNull {
		return nil, newKernelError(ErrNullNotAllowedField, "%s: field %q must not be null", context, key)
	}
	return value, nil
}

func requireText(m RecordMap, key, context string) (string, error) {
	value, err := requiredField(m, key, context)
	if err != nil {
		return "", err
	}
	if _, err := requireNonNull(value, key, context); err != nil {
		return "", err
	}
	text, ok := value.(RecordText)
	if !ok {
		return "", newKernelError(ErrInvalidRecordField, "%s: field %q must be a string, got %T", context, key, value)
	}
	return string(text), nil
}

func requireNonEmptyText(m RecordMap, key, context string) (string, error) {
	text, err := requireText(m, key, context)
	if err != nil {
		return "", err
	}
	if text == "" {
		return "", newKernelError(ErrInvalidRecordField, "%s: field %q must be a non-empty string", context, key)
	}
	return text, nil
}

func requireHashString(m RecordMap, key, context string) (string, error) {
	text, err := requireNonEmptyText(m, key, context)
	if err != nil {
		return "", err
	}
	if !hashStringPattern.MatchString(text) {
		return "", newKernelError(ErrInvalidRecordField, "%s: field %q must be a 64-character lowercase hex hash string, got %q", context, key, text)
	}
	return text, nil
}

// nullableHashString reads a field typed `hash-string / null`.
func nullableHashString(m RecordMap, key, context string) (string, bool, error) {
	value, err := requiredField(m, key, context)
	if err != nil {
		return "", false, err
	}
	if _, isNull := value.(RecordNull); isNull {
		return "", false, nil
	}
	text, ok := value.(RecordText)
	if !ok {
		return "", false, newKernelError(ErrInvalidRecordField, "%s: field %q must be a hash string or null, got %T", context, key, value)
	}
	if !hashStringPattern.MatchString(string(text)) {
		return "", false, newKernelError(ErrInvalidRecordField, "%s: field %q must be a 64-character lowercase hex hash string, got %q", context, key, string(text))
	}
	return string(text), true, nil
}

func requireBool(m RecordMap, key, context string) (bool, error) {
	value, err := requiredField(m, key, context)
	if err != nil {
		return false, err
	}
	if _, err := requireNonNull(value, key, context); err != nil {
		return false, err
	}
	b, ok := value.(RecordBool)
	if !ok {
		return false, newKernelError(ErrInvalidRecordField, "%s: field %q must be a bool, got %T", context, key, value)
	}
	return bool(b), nil
}

func requireInt(m RecordMap, key, context string) (int64, error) {
	value, err := requiredField(m, key, context)
	if err != nil {
		return 0, err
	}
	if _, err := requireNonNull(value, key, context); err != nil {
		return 0, err
	}
	i, ok := value.(RecordInt)
	if !ok {
		return 0, newKernelError(ErrInvalidRecordField, "%s: field %q must be an integer, got %T", context, key, value)
	}
	return int64(i), nil
}

func requireArrayField(m RecordMap, key, context string) (RecordArray, error) {
	value, err := requiredField(m, key, context)
	if err != nil {
		return nil, err
	}
	if _, err := requireNonNull(value, key, context); err != nil {
		return nil, err
	}
	return expectArray(value, fmt.Sprintf("%s.%s", context, key))
}

// checkClosedMap rejects any key in m that is not in allowed, per the CDDL
// closed-map rule this record family uses throughout.
func checkClosedMap(m RecordMap, allowed map[string]bool, context string) error {
	for key := range m {
		if !allowed[key] {
			return newKernelError(ErrUnknownRecordField, "%s: unrecognized field %q", context, key)
		}
	}
	return nil
}

// --- path-definition / incorporation-rule / turn-tree-schema ---

// PathCollectionKind mirrors the CDDL path-collection-kind enum.
type PathCollectionKind string

const (
	PathCollectionOrdered PathCollectionKind = "ordered"
	PathCollectionSingle  PathCollectionKind = "single"
)

// PathDefinition mirrors the CDDL path-definition record.
type PathDefinition struct {
	Path       string
	Collection PathCollectionKind
	Metadata   Record // nil if the optional field was absent
}

var pathDefinitionFields = map[string]bool{"path": true, "collection": true, "metadata": true}

func validatePathDefinition(value Record) (PathDefinition, error) {
	const context = "path-definition"
	m, err := expectMap(value, context)
	if err != nil {
		return PathDefinition{}, err
	}
	if err := checkClosedMap(m, pathDefinitionFields, context); err != nil {
		return PathDefinition{}, err
	}

	path, err := requireNonEmptyText(m, "path", context)
	if err != nil {
		return PathDefinition{}, err
	}
	collectionText, err := requireNonEmptyText(m, "collection", context)
	if err != nil {
		return PathDefinition{}, err
	}
	collection := PathCollectionKind(collectionText)
	if collection != PathCollectionOrdered && collection != PathCollectionSingle {
		return PathDefinition{}, newKernelError(ErrInvalidRecordField, "%s: field %q must be \"ordered\" or \"single\", got %q", context, "collection", collectionText)
	}

	var metadata Record
	if value, ok := optionalField(m, "metadata"); ok {
		// metadata: kernel-record, whose own union includes null, so an
		// explicit null here is a legitimate kernel-record value, not a
		// violation of the absent-vs-null rule.
		metadata = value
	}

	return PathDefinition{Path: path, Collection: collection, Metadata: metadata}, nil
}

// IncorporationRule mirrors the CDDL incorporation-rule record.
type IncorporationRule struct {
	ObjectType string
	TargetPath string
}

var incorporationRuleFields = map[string]bool{"objectType": true, "targetPath": true}

func validateIncorporationRule(value Record) (IncorporationRule, error) {
	const context = "incorporation-rule"
	m, err := expectMap(value, context)
	if err != nil {
		return IncorporationRule{}, err
	}
	if err := checkClosedMap(m, incorporationRuleFields, context); err != nil {
		return IncorporationRule{}, err
	}
	objectType, err := requireNonEmptyText(m, "objectType", context)
	if err != nil {
		return IncorporationRule{}, err
	}
	targetPath, err := requireNonEmptyText(m, "targetPath", context)
	if err != nil {
		return IncorporationRule{}, err
	}
	return IncorporationRule{ObjectType: objectType, TargetPath: targetPath}, nil
}

// TurnTreeSchema mirrors the CDDL turn-tree-schema record.
type TurnTreeSchema struct {
	SchemaID           string
	Paths              []PathDefinition
	IncorporationRules []IncorporationRule
}

var turnTreeSchemaFields = map[string]bool{"schemaId": true, "paths": true, "incorporationRules": true}

// ValidateTurnTreeSchema decodes and validates a turn-tree-schema record.
// Duplicate path definitions across Paths are rejected with
// ErrDuplicateSchemaPath (checked here rather than left to the runtime
// kernel, since a schema with duplicate paths is malformed at the record
// level, independent of any tree operation).
func ValidateTurnTreeSchema(value Record) (TurnTreeSchema, error) {
	const context = "turn-tree-schema"
	m, err := expectMap(value, context)
	if err != nil {
		return TurnTreeSchema{}, err
	}
	if err := checkClosedMap(m, turnTreeSchemaFields, context); err != nil {
		return TurnTreeSchema{}, err
	}

	schemaID, err := requireNonEmptyText(m, "schemaId", context)
	if err != nil {
		return TurnTreeSchema{}, err
	}

	pathsArray, err := requireArrayField(m, "paths", context)
	if err != nil {
		return TurnTreeSchema{}, err
	}
	seenPaths := make(map[string]bool, len(pathsArray))
	paths := make([]PathDefinition, 0, len(pathsArray))
	for _, element := range pathsArray {
		definition, err := validatePathDefinition(element)
		if err != nil {
			return TurnTreeSchema{}, err
		}
		if seenPaths[definition.Path] {
			return TurnTreeSchema{}, newKernelError(ErrDuplicateSchemaPath, "turn-tree-schema %q declares path %q more than once", schemaID, definition.Path)
		}
		seenPaths[definition.Path] = true
		paths = append(paths, definition)
	}

	rulesArray, err := requireArrayField(m, "incorporationRules", context)
	if err != nil {
		return TurnTreeSchema{}, err
	}
	rules := make([]IncorporationRule, 0, len(rulesArray))
	for _, element := range rulesArray {
		rule, err := validateIncorporationRule(element)
		if err != nil {
			return TurnTreeSchema{}, err
		}
		rules = append(rules, rule)
	}

	return TurnTreeSchema{SchemaID: schemaID, Paths: paths, IncorporationRules: rules}, nil
}

// --- step-declaration ---

// StepDeclaration mirrors the CDDL step-declaration record.
type StepDeclaration struct {
	ID            string
	Deterministic bool
	SideEffects   bool
	Metadata      Record
	HasMetadata   bool
}

var stepDeclarationFields = map[string]bool{"id": true, "deterministic": true, "sideEffects": true, "metadata": true}

func ValidateStepDeclaration(value Record) (StepDeclaration, error) {
	const context = "step-declaration"
	m, err := expectMap(value, context)
	if err != nil {
		return StepDeclaration{}, err
	}
	if err := checkClosedMap(m, stepDeclarationFields, context); err != nil {
		return StepDeclaration{}, err
	}

	id, err := requireNonEmptyText(m, "id", context)
	if err != nil {
		return StepDeclaration{}, err
	}
	deterministic, err := requireBool(m, "deterministic", context)
	if err != nil {
		return StepDeclaration{}, err
	}
	sideEffects, err := requireBool(m, "sideEffects", context)
	if err != nil {
		return StepDeclaration{}, err
	}

	decl := StepDeclaration{ID: id, Deterministic: deterministic, SideEffects: sideEffects}
	if value, ok := optionalField(m, "metadata"); ok {
		decl.Metadata = value
		decl.HasMetadata = true
	}
	return decl, nil
}

// --- staged-result ---

// StagedResultStatus mirrors the CDDL staged-result-status enum.
type StagedResultStatus string

const (
	StagedResultCompleted   StagedResultStatus = "completed"
	StagedResultFailed      StagedResultStatus = "failed"
	StagedResultInterrupted StagedResultStatus = "interrupted"
)

// StagedResult mirrors the CDDL staged-result union (base-staged-result plus
// either interrupted-staged-result's interruptPayload or a settled status).
type StagedResult struct {
	TaskID           string
	ObjectHash       string
	ObjectType       string
	Timestamp        int64
	Status           StagedResultStatus
	InterruptPayload Record // set iff Status == StagedResultInterrupted
}

var settledStagedResultFields = map[string]bool{"taskId": true, "objectHash": true, "objectType": true, "timestamp": true, "status": true}
var interruptedStagedResultFields = map[string]bool{"taskId": true, "objectHash": true, "objectType": true, "timestamp": true, "status": true, "interruptPayload": true}

func ValidateStagedResult(value Record) (StagedResult, error) {
	const context = "staged-result"
	m, err := expectMap(value, context)
	if err != nil {
		return StagedResult{}, err
	}

	statusText, err := requireNonEmptyText(m, "status", context)
	if err != nil {
		return StagedResult{}, err
	}
	status := StagedResultStatus(statusText)

	var allowed map[string]bool
	switch status {
	case StagedResultCompleted, StagedResultFailed:
		allowed = settledStagedResultFields
	case StagedResultInterrupted:
		allowed = interruptedStagedResultFields
	default:
		return StagedResult{}, newKernelError(ErrInvalidRecordField, "%s: field %q must be \"completed\", \"failed\", or \"interrupted\", got %q", context, "status", statusText)
	}
	if err := checkClosedMap(m, allowed, context); err != nil {
		return StagedResult{}, err
	}

	taskID, err := requireNonEmptyText(m, "taskId", context)
	if err != nil {
		return StagedResult{}, err
	}
	objectHash, err := requireHashString(m, "objectHash", context)
	if err != nil {
		return StagedResult{}, err
	}
	objectType, err := requireNonEmptyText(m, "objectType", context)
	if err != nil {
		return StagedResult{}, err
	}
	timestamp, err := requireInt(m, "timestamp", context)
	if err != nil {
		return StagedResult{}, err
	}

	result := StagedResult{
		TaskID:     taskID,
		ObjectHash: objectHash,
		ObjectType: objectType,
		Timestamp:  timestamp,
		Status:     status,
	}

	if status == StagedResultInterrupted {
		payload, err := requiredField(m, "interruptPayload", context)
		if err != nil {
			return StagedResult{}, err
		}
		result.InterruptPayload = payload
	}

	return result, nil
}

// --- turn-tree-manifest / turn-tree-change-set (path-value maps) ---

// PathValue mirrors the CDDL path-value union: a single hash string, an
// ordered array of hash strings, or null (path not populated).
type PathValue struct {
	Single  string   // set when Kind == PathValueSingle
	Ordered []string // set when Kind == PathValueOrdered
	Kind    PathValueKind
}

type PathValueKind int

const (
	PathValueNull PathValueKind = iota
	PathValueSingleKind
	PathValueOrderedKind
)

func validatePathValue(value Record, context string) (PathValue, error) {
	switch v := value.(type) {
	case RecordNull:
		return PathValue{Kind: PathValueNull}, nil
	case RecordText:
		if !hashStringPattern.MatchString(string(v)) {
			return PathValue{}, newKernelError(ErrInvalidRecordField, "%s: expected a hash string, got %q", context, string(v))
		}
		return PathValue{Kind: PathValueSingleKind, Single: string(v)}, nil
	case RecordArray:
		hashes := make([]string, 0, len(v))
		for _, element := range v {
			text, ok := element.(RecordText)
			if !ok || !hashStringPattern.MatchString(string(text)) {
				return PathValue{}, newKernelError(ErrInvalidRecordField, "%s: expected an array of hash strings", context)
			}
			hashes = append(hashes, string(text))
		}
		return PathValue{Kind: PathValueOrderedKind, Ordered: hashes}, nil
	default:
		return PathValue{}, newKernelError(ErrInvalidRecordField, "%s: expected a hash string, an array of hash strings, or null, got %T", context, value)
	}
}

// ValidateTurnTreeManifestLike decodes a turn-tree-manifest or
// turn-tree-change-set record: `{ * non-empty-tstr => path-value }`. Both
// CDDL shapes are structurally identical open string-keyed maps (unlike the
// closed record shapes above), so one validator serves both.
func ValidateTurnTreeManifestLike(value Record, context string) (map[string]PathValue, error) {
	m, err := expectMap(value, context)
	if err != nil {
		return nil, err
	}
	result := make(map[string]PathValue, len(m))
	for key, element := range m {
		if key == "" {
			return nil, newKernelError(ErrInvalidRecordField, "%s: keys must be non-empty strings", context)
		}
		pathValue, err := validatePathValue(element, fmt.Sprintf("%s[%q]", context, key))
		if err != nil {
			return nil, err
		}
		result[key] = pathValue
	}
	return result, nil
}
