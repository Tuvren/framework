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

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tuvren_kernel_rust::{
    InMemoryKernel, KernelError, KernelRecord, PathCollectionKind, PathDefinition, PathValue,
    RecoveryState, RunCompletionStatus, StagedResult, StagedResultStatus, StepDeclaration,
    TurnNode, TurnTreeSchema, decode_deterministic_kernel_record, hash_bytes_to_hex,
    hash_kernel_record, hash_turn_node_identity, kernel_record_from_json, schema_to_record,
};

const MANIFEST_PATH: &str = "boundaries/kernel/conformance/scenarios/suite-manifest.json";
const RUST_IMPLEMENTATION_ID: &str = "rust-kernel";
const EXPECTED_RUST_CHECK_IDS: &[&str] = &[
    "kernel.protocol.deterministic_hashing",
    "kernel.protocol.schema_roundtrip",
    "kernel.logical.diff_paths",
    "kernel.logical.branch_list",
    "kernel.logical.recovery_state",
    "kernel.lineage.cross_thread_rejection",
    "kernel.turn.lateral_head_guard",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssertionResult {
    assertion_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    assertion_results: Vec<AssertionResult>,
    check_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceSummary {
    failed_checks: usize,
    passed_checks: usize,
    total_checks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    boundary: String,
    check_results: Vec<CheckResult>,
    implementation_id: &'static str,
    language: &'static str,
    status: &'static str,
    suite_id: String,
    suite_version: String,
    summary: EvidenceSummary,
}

fn main() -> Result<(), KernelError> {
    let suite = read_suite()?;
    assert_eq!(suite.manifest.boundary, "kernel");
    assert_eq!(suite.manifest.suite_id, "tuvren.kernel.protocol-seed");
    assert_eq!(suite.manifest.suite_version, "0.2.0");
    assert_expected_rust_checks(&suite.manifest)?;

    // The Rust runner still dispatches checks explicitly so each scenario can
    // stay idiomatic to the local kernel API, but the manifest assertion above
    // prevents that hand-written list from drifting away from the
    // boundary-owned suite contract.
    let check_results = vec![
        run_deterministic_hashing_check(&suite)?,
        run_schema_roundtrip_check(&suite)?,
        run_logical_diff_check(&suite)?,
        run_branch_list_check(&suite)?,
        run_recovery_state_check(&suite)?,
        run_cross_thread_lineage_check(&suite)?,
        run_lateral_turn_head_guard_check(&suite)?,
    ];

    let failed_checks = check_results
        .iter()
        .filter(|check_result| check_result.status == "fail")
        .count();
    let summary = EvidenceSummary {
        failed_checks,
        passed_checks: check_results.len() - failed_checks,
        total_checks: check_results.len(),
    };
    let evidence = Evidence {
        boundary: suite.manifest.boundary.clone(),
        check_results,
        implementation_id: RUST_IMPLEMENTATION_ID,
        language: "rust",
        status: if failed_checks == 0 { "pass" } else { "fail" },
        suite_id: suite.manifest.suite_id.clone(),
        suite_version: suite.manifest.suite_version.clone(),
        summary,
    };

    println!(
        "{}",
        serde_json::to_string_pretty(&evidence)
            .map_err(|_| error("invalid_evidence", "failed to serialize evidence"))?
    );
    Ok(())
}

#[derive(Deserialize)]
struct SuiteManifest {
    boundary: String,
    checks: Vec<SuiteCheck>,
    #[serde(rename = "fixtureSchemaPath")]
    fixture_schema_path: String,
    fixtures: Vec<SuiteFixture>,
    #[serde(rename = "suiteId")]
    suite_id: String,
    #[serde(rename = "suiteVersion")]
    suite_version: String,
}

#[derive(Deserialize)]
struct SuiteFixture {
    id: String,
    path: String,
}

#[derive(Deserialize)]
struct SuiteCheck {
    #[serde(rename = "checkId")]
    check_id: String,
    implementations: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct DeterministicFixture {
    #[serde(rename = "rawOpaqueBytes")]
    raw_opaque_bytes: Vec<u8>,
    #[serde(rename = "rawOpaqueBytesSha256Hex")]
    raw_opaque_bytes_sha256_hex: String,
    #[serde(rename = "turnNodeIdentityRecord")]
    turn_node_identity_record: Value,
    #[serde(rename = "turnNodeIdentityRecordCborHex")]
    turn_node_identity_record_cbor_hex: String,
    #[serde(rename = "turnNodeIdentityRecordSha256Hex")]
    turn_node_identity_record_sha256_hex: String,
    #[serde(rename = "turnTreeSchemaRecord")]
    turn_tree_schema_record: Value,
    #[serde(rename = "turnTreeSchemaRecordCborHex")]
    turn_tree_schema_record_cbor_hex: String,
    #[serde(rename = "turnTreeSchemaRecordSha256Hex")]
    turn_tree_schema_record_sha256_hex: String,
}

#[derive(Deserialize)]
struct LogicalFixture {
    #[serde(rename = "branchHeadListEntry")]
    branch_head_list_entry: Value,
    #[serde(rename = "recoveryState")]
    recovery_state: Value,
    #[serde(rename = "turnTreeChangeSet")]
    turn_tree_change_set: Value,
}

struct FixtureSuite {
    canonical_schema: Value,
    deterministic: DeterministicFixture,
    logical: LogicalFixture,
    manifest: SuiteManifest,
}

fn read_suite() -> Result<FixtureSuite, KernelError> {
    let manifest_path = Path::new(MANIFEST_PATH);
    let manifest: SuiteManifest = read_json(manifest_path)?;
    let manifest_dir = manifest_path
        .parent()
        .ok_or_else(|| error("invalid_manifest_path", "manifest path must have a parent"))?;
    validate_fixture_schema_path(manifest_dir, &manifest.fixture_schema_path)?;
    let canonical_schema: Value = read_json(&fixture_path(
        manifest_dir,
        &manifest.fixtures,
        "canonical-turn-tree-schema",
    )?)?;
    let deterministic: DeterministicFixture = read_json(&fixture_path(
        manifest_dir,
        &manifest.fixtures,
        "kernel-protocol-deterministic",
    )?)?;
    let logical: LogicalFixture = read_json(&fixture_path(
        manifest_dir,
        &manifest.fixtures,
        "kernel-protocol-logical",
    )?)?;

    Ok(FixtureSuite {
        canonical_schema,
        deterministic,
        logical,
        manifest,
    })
}

fn validate_fixture_schema_path(
    manifest_dir: &Path,
    fixture_schema_path: &str,
) -> Result<(), KernelError> {
    let schema_path = manifest_dir.join(fixture_schema_path);
    let schema: Value = read_json(&schema_path)?;
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "invalid_fixture_schema",
                "fixture schema must list required keys",
            )
        })?;
    for expected_key in [
        "canonicalSchemaPath",
        "deterministicFixturePath",
        "logicalFixturePath",
    ] {
        if !required
            .iter()
            .any(|value| value.as_str() == Some(expected_key))
        {
            return Err(error(
                "invalid_fixture_schema",
                "fixture schema required keys drifted from the conformance contract",
            ));
        }
    }
    Ok(())
}

fn assert_expected_rust_checks(manifest: &SuiteManifest) -> Result<(), KernelError> {
    let rust_check_ids: Vec<&str> = manifest
        .checks
        .iter()
        .filter(|check| {
            check
                .implementations
                .as_ref()
                .is_some_and(|implementations| {
                    implementations
                        .iter()
                        .any(|id| id == RUST_IMPLEMENTATION_ID)
                })
        })
        .map(|check| check.check_id.as_str())
        .collect();

    if rust_check_ids == EXPECTED_RUST_CHECK_IDS {
        return Ok(());
    }

    Err(error(
        "manifest_check_drift",
        "kernel conformance manifest check order drifted from the Rust runner dispatch list",
    ))
}

fn run_deterministic_hashing_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let deterministic = &suite.deterministic;
    let raw_bytes = deterministic.raw_opaque_bytes.clone();
    let schema = parse_schema(&deterministic.turn_tree_schema_record)?;
    let node = parse_turn_node_identity(&deterministic.turn_node_identity_record)?;

    Ok(create_check_result(
        "kernel.protocol.deterministic_hashing",
        vec![
            create_assertion_result(
                "raw_opaque_bytes_hash",
                hash_bytes_to_hex(&raw_bytes) == deterministic.raw_opaque_bytes_sha256_hex,
                None,
            ),
            create_assertion_result(
                "turn_tree_schema_hash",
                hash_kernel_record(&schema_to_record(&schema))?
                    == deterministic.turn_tree_schema_record_sha256_hex,
                None,
            ),
            create_assertion_result(
                "turn_node_identity_hash",
                hash_turn_node_identity(&node)?
                    == deterministic.turn_node_identity_record_sha256_hex,
                None,
            ),
        ],
        Some(json!({
            "hashKinds": ["rawOpaqueBytes", "turnTreeSchema", "turnNodeIdentity"]
        })),
    ))
}

fn run_schema_roundtrip_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let deterministic = &suite.deterministic;
    let schema = parse_schema(&deterministic.turn_tree_schema_record)?;
    let decoded_schema = decode_deterministic_kernel_record(&hex_to_bytes(
        &deterministic.turn_tree_schema_record_cbor_hex,
    )?)?;
    let decoded_node = decode_deterministic_kernel_record(&hex_to_bytes(
        &deterministic.turn_node_identity_record_cbor_hex,
    )?)?;

    Ok(create_check_result(
        "kernel.protocol.schema_roundtrip",
        vec![
            create_assertion_result(
                "turn_tree_schema_cbor_roundtrip",
                decoded_schema == schema_to_record(&schema),
                None,
            ),
            create_assertion_result(
                "turn_node_identity_cbor_roundtrip",
                decoded_node == kernel_record_from_json(&deterministic.turn_node_identity_record)?,
                None,
            ),
        ],
        None,
    ))
}

fn run_logical_diff_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&suite.canonical_schema)?)?;
    let created = kernel.thread_create("thread_conformance", "schema_main", "branch_main")?;
    let mut changes = BTreeMap::new();
    let logical_changes = suite
        .logical
        .turn_tree_change_set
        .as_object()
        .ok_or_else(|| error("invalid_fixture", "turnTreeChangeSet must be an object"))?;

    for (path, value) in logical_changes {
        changes.insert(path.clone(), parse_path_value(value)?);
    }

    let changed_tree =
        kernel.tree_create("schema_main", changes, Some(&created.root_turn_tree_hash))?;
    let diff = kernel.tree_diff(&created.root_turn_tree_hash, &changed_tree)?;

    Ok(create_check_result(
        "kernel.logical.diff_paths",
        vec![create_assertion_result(
            "logical_diff_matches_fixture_paths",
            diff == vec!["context.manifest".to_string(), "messages".to_string()],
            None,
        )],
        Some(json!({ "diffPaths": diff })),
    ))
}

fn run_branch_list_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&suite.canonical_schema)?)?;
    kernel.thread_create("thread_conformance", "schema_main", "branch_main")?;
    let branch_entries = kernel.branch_list("thread_conformance")?;
    let branch_head = parse_branch_head_list_entry(&suite.logical.branch_head_list_entry)?;

    Ok(create_check_result(
        "kernel.logical.branch_list",
        vec![create_assertion_result(
            "branch_list_matches_fixture_entry",
            branch_entries.len() == 1 && branch_entries[0] == branch_head,
            None,
        )],
        Some(json!({ "branchEntries": branch_entries })),
    ))
}

fn run_recovery_state_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let recovery_state = parse_recovery_state(&suite.logical.recovery_state)?;
    run_recovery_fixture_scenario(&suite.canonical_schema, &recovery_state)?;

    Ok(create_check_result(
        "kernel.logical.recovery_state",
        vec![
            create_assertion_result(
                "recovery_state_last_completed_step",
                recovery_state.last_completed_step_id.as_deref() == Some("tool_execution"),
                None,
            ),
            create_assertion_result(
                "recovery_state_consumed_results",
                recovery_state.consumed_staged_results.len() == 1,
                None,
            ),
            create_assertion_result(
                "recovery_state_uncommitted_results",
                recovery_state.uncommitted_staged_results.len() == 1,
                None,
            ),
        ],
        Some(json!({
            "recoveryStepIds": recovery_state
                .step_sequence
                .iter()
                .map(|step| step.id.clone())
                .collect::<Vec<_>>()
        })),
    ))
}

fn run_cross_thread_lineage_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&suite.canonical_schema)?)?;
    let thread_a = kernel.thread_create("thread_a", "schema_main", "branch_a")?;
    kernel.turn_create(
        "turn_a",
        "thread_a",
        "branch_a",
        None,
        &thread_a.root_turn_node_hash,
    )?;
    kernel.run_create(
        "run_a",
        "turn_a",
        "branch_a",
        "schema_main",
        &thread_a.root_turn_node_hash,
        vec![StepDeclaration {
            deterministic: false,
            id: "step_a".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;
    let (_, node_a) = kernel.run_complete_step("run_a", "step_a", None, Vec::new(), None)?;
    let node_a = node_a.ok_or_else(|| error("missing_checkpoint", "expected checkpoint hash"))?;
    let _thread_b = kernel.thread_create("thread_b", "schema_main", "branch_b")?;
    let error = kernel
        .branch_create("branch_cross_thread", "thread_b", &node_a)
        .expect_err("thread A node cannot seed thread B branch");

    Ok(create_check_result(
        "kernel.lineage.cross_thread_rejection",
        vec![create_assertion_result(
            "cross_thread_branch_create_rejected",
            error.payload.code == "turn_node_thread_mismatch",
            Some(error.payload.code.clone()),
        )],
        Some(json!({ "errorCode": error.payload.code })),
    ))
}

fn run_lateral_turn_head_guard_check(suite: &FixtureSuite) -> Result<CheckResult, KernelError> {
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&suite.canonical_schema)?)?;
    let thread = kernel.thread_create("thread_main", "schema_main", "branch_main")?;
    kernel.turn_create(
        "turn_main",
        "thread_main",
        "branch_main",
        None,
        &thread.root_turn_node_hash,
    )?;
    kernel.run_create(
        "run_main",
        "turn_main",
        "branch_main",
        "schema_main",
        &thread.root_turn_node_hash,
        vec![StepDeclaration {
            deterministic: false,
            id: "main_step".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;
    let (_, main_node) =
        kernel.run_complete_step("run_main", "main_step", None, Vec::new(), None)?;
    let main_node =
        main_node.ok_or_else(|| error("missing_checkpoint", "expected main checkpoint"))?;
    kernel.run_complete("run_main", RunCompletionStatus::Completed, None)?;
    kernel.branch_create("branch_alt", "thread_main", &thread.root_turn_node_hash)?;
    kernel.turn_create(
        "turn_alt",
        "thread_main",
        "branch_alt",
        None,
        &thread.root_turn_node_hash,
    )?;
    kernel.run_create(
        "run_alt",
        "turn_alt",
        "branch_alt",
        "schema_main",
        &thread.root_turn_node_hash,
        vec![StepDeclaration {
            deterministic: false,
            id: "alt_step".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;
    kernel.staging_stage(
        "run_alt",
        b"alt branch message".to_vec(),
        "alt_message",
        "message",
        StagedResultStatus::Completed,
        None,
    )?;
    let (_, alt_node) = kernel.run_complete_step("run_alt", "alt_step", None, Vec::new(), None)?;
    let alt_node =
        alt_node.ok_or_else(|| error("missing_checkpoint", "expected alt checkpoint"))?;
    let error = kernel
        .turn_update_head("turn_main", &alt_node)
        .expect_err("turn head cannot jump to a lateral descendant");

    Ok(create_check_result(
        "kernel.turn.lateral_head_guard",
        vec![create_assertion_result(
            "lateral_turn_head_move_rejected",
            main_node != alt_node && error.payload.code == "turn_head_lateral_move",
            Some(error.payload.code.clone()),
        )],
        Some(json!({ "errorCode": error.payload.code })),
    ))
}

fn create_check_result(
    check_id: &str,
    assertion_results: Vec<AssertionResult>,
    details: Option<Value>,
) -> CheckResult {
    let status = if assertion_results
        .iter()
        .all(|assertion| assertion.status == "pass")
    {
        "pass"
    } else {
        "fail"
    };

    CheckResult {
        assertion_results,
        check_id: check_id.to_string(),
        details,
        status,
    }
}

fn create_assertion_result(
    assertion_id: &str,
    passed: bool,
    message: Option<String>,
) -> AssertionResult {
    AssertionResult {
        assertion_id: assertion_id.to_string(),
        message,
        status: if passed { "pass" } else { "fail" },
    }
}

fn fixture_path(
    manifest_dir: &Path,
    fixtures: &[SuiteFixture],
    expected_id: &str,
) -> Result<PathBuf, KernelError> {
    let fixture = fixtures
        .iter()
        .find(|fixture| fixture.id == expected_id)
        .ok_or_else(|| error("fixture_not_found", "suite fixture is missing"))?;
    Ok(manifest_dir.join(&fixture.path))
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>, KernelError> {
    if !value.len().is_multiple_of(2) {
        return Err(error(
            "invalid_hex_fixture",
            "fixture hex must have even length",
        ));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| error("invalid_hex_fixture", "fixture hex must decode"))
        })
        .collect()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, KernelError> {
    let text = fs::read_to_string(path).map_err(|source| {
        error(
            "fixture_read_failed",
            &format!("failed to read {}: {source}", path.display()),
        )
    })?;
    serde_json::from_str(&text).map_err(|source| {
        error(
            "fixture_parse_failed",
            &format!("failed to parse {}: {source}", path.display()),
        )
    })
}

fn parse_schema(value: &Value) -> Result<TurnTreeSchema, KernelError> {
    let object = value
        .as_object()
        .ok_or_else(|| error("invalid_schema_fixture", "schema fixture must be an object"))?;
    let schema_id = read_string(object.get("schemaId"), "schemaId")?;
    let paths = read_array(object.get("paths"), "paths")?
        .iter()
        .map(parse_path_definition)
        .collect::<Result<Vec<_>, _>>()?;
    let incorporation_rules = read_array(object.get("incorporationRules"), "incorporationRules")?
        .iter()
        .map(|value| {
            let object = value.as_object().ok_or_else(|| {
                error(
                    "invalid_incorporation_rule",
                    "incorporation rule must be an object",
                )
            })?;
            Ok(tuvren_kernel_rust::IncorporationRule {
                object_type: read_string(object.get("objectType"), "objectType")?,
                target_path: read_string(object.get("targetPath"), "targetPath")?,
            })
        })
        .collect::<Result<Vec<_>, KernelError>>()?;

    Ok(TurnTreeSchema {
        incorporation_rules,
        paths,
        schema_id,
    })
}

fn parse_path_definition(value: &Value) -> Result<PathDefinition, KernelError> {
    let object = value.as_object().ok_or_else(|| {
        error(
            "invalid_path_definition",
            "path definition must be an object",
        )
    })?;
    let collection = match read_string(object.get("collection"), "collection")?.as_str() {
        "ordered" => PathCollectionKind::Ordered,
        "single" => PathCollectionKind::Single,
        _ => return Err(error("invalid_path_collection", "invalid path collection")),
    };
    let metadata = object
        .get("metadata")
        .map(kernel_record_from_json)
        .transpose()?;
    Ok(PathDefinition {
        collection,
        metadata,
        path: read_string(object.get("path"), "path")?,
    })
}

fn parse_turn_node_identity(value: &Value) -> Result<TurnNode, KernelError> {
    let object = value.as_object().ok_or_else(|| {
        error(
            "invalid_turn_node_fixture",
            "turn node fixture must be an object",
        )
    })?;
    let staged_results = read_array(object.get("consumedStagedResults"), "consumedStagedResults")?
        .iter()
        .map(parse_staged_result)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TurnNode {
        consumed_staged_results: staged_results,
        event_hash: read_nullable_string(object.get("eventHash"), "eventHash")?,
        hash: String::new(),
        previous_turn_node_hash: read_nullable_string(
            object.get("previousTurnNodeHash"),
            "previousTurnNodeHash",
        )?,
        schema_id: read_string(object.get("schemaId"), "schemaId")?,
        turn_tree_hash: read_string(object.get("turnTreeHash"), "turnTreeHash")?,
    })
}

fn parse_staged_result(value: &Value) -> Result<StagedResult, KernelError> {
    let object = value
        .as_object()
        .ok_or_else(|| error("invalid_staged_result", "staged result must be an object"))?;
    let status = match read_string(object.get("status"), "status")?.as_str() {
        "completed" => StagedResultStatus::Completed,
        "failed" => StagedResultStatus::Failed,
        "interrupted" => StagedResultStatus::Interrupted,
        _ => {
            return Err(error(
                "invalid_staged_result_status",
                "invalid staged result status",
            ));
        }
    };
    Ok(StagedResult {
        interrupt_payload: object
            .get("interruptPayload")
            .map(kernel_record_from_json)
            .transpose()?,
        object_hash: read_string(object.get("objectHash"), "objectHash")?,
        object_type: read_string(object.get("objectType"), "objectType")?,
        status,
        task_id: read_string(object.get("taskId"), "taskId")?,
        timestamp_ms: read_i64(object.get("timestamp"), "timestamp")?,
    })
}

fn parse_recovery_state(value: &Value) -> Result<RecoveryState, KernelError> {
    let object = value
        .as_object()
        .ok_or_else(|| error("invalid_recovery_state", "recovery state must be an object"))?;
    let consumed_staged_results =
        read_array(object.get("consumedStagedResults"), "consumedStagedResults")?
            .iter()
            .map(parse_staged_result)
            .collect::<Result<Vec<_>, _>>()?;
    let step_sequence = read_array(object.get("stepSequence"), "stepSequence")?
        .iter()
        .map(parse_step_declaration)
        .collect::<Result<Vec<_>, _>>()?;
    let uncommitted_staged_results = read_array(
        object.get("uncommittedStagedResults"),
        "uncommittedStagedResults",
    )?
    .iter()
    .map(parse_staged_result)
    .collect::<Result<Vec<_>, _>>()?;

    Ok(RecoveryState {
        consumed_staged_results,
        last_completed_step_id: read_nullable_string(
            object.get("lastCompletedStepId"),
            "lastCompletedStepId",
        )?,
        last_turn_node_hash: read_string(object.get("lastTurnNodeHash"), "lastTurnNodeHash")?,
        step_sequence,
        uncommitted_staged_results,
    })
}

fn parse_step_declaration(value: &Value) -> Result<StepDeclaration, KernelError> {
    let object = value.as_object().ok_or_else(|| {
        error(
            "invalid_step_declaration",
            "step declaration must be an object",
        )
    })?;
    Ok(StepDeclaration {
        deterministic: read_bool(object.get("deterministic"), "deterministic")?,
        id: read_string(object.get("id"), "id")?,
        metadata: object
            .get("metadata")
            .map(kernel_record_from_json)
            .transpose()?,
        side_effects: read_bool(object.get("sideEffects"), "sideEffects")?,
    })
}

fn parse_branch_head_list_entry(value: &Value) -> Result<(String, String), KernelError> {
    let values = read_array(Some(value), "branchHeadListEntry")?;
    if values.len() != 2 {
        return Err(error(
            "invalid_branch_head_list_entry",
            "branchHeadListEntry must contain branch id and head hash",
        ));
    }
    Ok((
        read_string(values.first(), "branchHeadListEntry[0]")?,
        read_string(values.get(1), "branchHeadListEntry[1]")?,
    ))
}

fn parse_path_value(value: &Value) -> Result<PathValue, KernelError> {
    if value.is_null() {
        return Ok(PathValue::Null);
    }
    if let Some(text) = value.as_str() {
        return Ok(PathValue::Single(text.to_string()));
    }
    read_array(Some(value), "path value").and_then(|values| {
        values
            .iter()
            .map(|value| {
                value.as_str().map(ToString::to_string).ok_or_else(|| {
                    error("invalid_path_value", "ordered path values must be strings")
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(PathValue::Ordered)
    })
}

fn run_recovery_fixture_scenario(
    canonical_schema: &Value,
    expected: &RecoveryState,
) -> Result<(), KernelError> {
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(canonical_schema)?)?;
    let created = kernel.thread_create("thread_recovery", "schema_main", "branch_recovery")?;
    let turn = kernel.turn_create(
        "turn_recovery",
        "thread_recovery",
        "branch_recovery",
        None,
        &created.root_turn_node_hash,
    )?;
    kernel.run_create(
        "run_recovery",
        &turn.turn_id,
        "branch_recovery",
        "schema_main",
        &created.root_turn_node_hash,
        expected.step_sequence.clone(),
    )?;
    kernel.staging_stage(
        "run_recovery",
        b"earlier consumed fixture object".to_vec(),
        "pre_fixture_consumed",
        "message",
        StagedResultStatus::Completed,
        None,
    )?;
    kernel.run_complete_step("run_recovery", "model_call", None, Vec::new(), None)?;
    let consumed = expected.consumed_staged_results.first().ok_or_else(|| {
        error(
            "invalid_recovery_fixture",
            "fixture must include consumed staged result",
        )
    })?;
    let (_, consumed_staged) = kernel.staging_stage(
        "run_recovery",
        b"consumed fixture object".to_vec(),
        &consumed.task_id,
        &consumed.object_type,
        consumed.status.clone(),
        consumed.interrupt_payload.clone(),
    )?;
    let (_, last_turn_node_hash) =
        kernel.run_complete_step("run_recovery", "tool_execution", None, Vec::new(), None)?;
    let uncommitted = expected.uncommitted_staged_results.first().ok_or_else(|| {
        error(
            "invalid_recovery_fixture",
            "fixture must include uncommitted staged result",
        )
    })?;
    let (_, uncommitted_staged) = kernel.staging_stage(
        "run_recovery",
        b"uncommitted fixture object".to_vec(),
        &uncommitted.task_id,
        &uncommitted.object_type,
        uncommitted.status.clone(),
        uncommitted.interrupt_payload.clone(),
    )?;
    let actual = kernel.run_recover("run_recovery")?;
    let expected_actual = RecoveryState {
        consumed_staged_results: vec![consumed_staged],
        last_completed_step_id: expected.last_completed_step_id.clone(),
        last_turn_node_hash: last_turn_node_hash.ok_or_else(|| {
            error(
                "invalid_recovery_fixture",
                "tool_execution must create a checkpoint",
            )
        })?,
        step_sequence: expected.step_sequence.clone(),
        uncommitted_staged_results: vec![uncommitted_staged],
    };

    // The scenario intentionally creates an earlier consumed result; recovery
    // must report the latest TurnNode only, with full staged-result equality.
    assert_eq!(actual, expected_actual);
    Ok(())
}

fn read_bool(value: Option<&Value>, label: &str) -> Result<bool, KernelError> {
    value
        .as_ref()
        .and_then(|value| value.as_bool())
        .ok_or_else(|| {
            error(
                "invalid_boolean_fixture",
                &format!("{label} must be a boolean"),
            )
        })
}

fn read_string(value: Option<&Value>, label: &str) -> Result<String, KernelError> {
    value
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            error(
                "invalid_string_fixture",
                &format!("{label} must be a string"),
            )
        })
}

fn read_nullable_string(value: Option<&Value>, label: &str) -> Result<Option<String>, KernelError> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(error(
            "invalid_nullable_string_fixture",
            &format!("{label} must be a string or null"),
        )),
    }
}

fn read_i64(value: Option<&Value>, label: &str) -> Result<i64, KernelError> {
    value.and_then(Value::as_i64).ok_or_else(|| {
        error(
            "invalid_integer_fixture",
            &format!("{label} must be an integer"),
        )
    })
}

fn read_array<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a Vec<Value>, KernelError> {
    value.and_then(Value::as_array).ok_or_else(|| {
        error(
            "invalid_array_fixture",
            &format!("{label} must be an array"),
        )
    })
}

fn error(code: &str, message: &str) -> KernelError {
    KernelError::new(code, message, Option::<KernelRecord>::None)
}
