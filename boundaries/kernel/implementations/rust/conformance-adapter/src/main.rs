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
use std::io::{self, BufRead};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tuvren_kernel_rust::{
    InMemoryKernel, KernelError, KernelRecord, PathCollectionKind, PathDefinition, PathValue,
    RecoveryState, RunCompletionStatus, StagedResult, StagedResultStatus, StepDeclaration,
    TurnNode, TurnTreeSchema, decode_deterministic_kernel_record, hash_bytes_to_hex,
    hash_kernel_record, hash_turn_node_identity, kernel_record_from_json,
};

const CANONICAL_SCHEMA_PATH: &str =
    "boundaries/kernel/conformance/fixtures/canonical-turn-tree-schema.json";

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Value,
    jsonrpc: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterCapabilities {
    adapter_id: &'static str,
    capabilities: Vec<&'static str>,
    packet_id: String,
    plan_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterErrorEnvelope {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Serialize)]
#[serde(tag = "kind")]
enum OperationOutcome {
    #[serde(rename = "result")]
    Result { value: Value },
    #[serde(rename = "error")]
    Error { error: AdapterErrorEnvelope },
}

fn main() {
    for line in io::stdin().lock().lines() {
        let response = match line {
            Ok(text) => handle_line(&text),
            Err(source) => error_response(
                Value::Null,
                "adapter_stdin_failed",
                &format!("failed to read adapter stdin: {source}"),
            ),
        };
        println!("{}", response);
    }
}

fn handle_line(line: &str) -> Value {
    let request = match serde_json::from_str::<JsonRpcRequest>(line) {
        Ok(request) => request,
        Err(source) => {
            return error_response(
                Value::Null,
                "invalid_json_rpc_request",
                &format!("failed to parse JSON-RPC request: {source}"),
            );
        }
    };
    if request.jsonrpc != "2.0" {
        return error_response(
            request.id,
            "invalid_json_rpc_request",
            "request jsonrpc must be 2.0",
        );
    }
    let id = request.id.clone();

    match dispatch_request(request) {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    }
}

fn dispatch_request(request: JsonRpcRequest) -> Result<Value, AdapterErrorEnvelope> {
    match request.method.as_str() {
        "initialize" => Ok(json!(AdapterCapabilities {
            adapter_id: "rust-kernel",
            capabilities: vec![
                "kernel.protocol",
                "kernel.logical",
                "kernel.persistence.process-local",
            ],
            packet_id: read_param_string(&request.params, "packetId")?,
            plan_version: read_param_string(&request.params, "planVersion")?,
        })),
        "dispatch" => {
            let operation = read_param_string(&request.params, "operation")?;
            let input = request.params.get("input").cloned().unwrap_or(Value::Null);
            Ok(json!(dispatch_operation(&operation, &input)))
        }
        "events" => Ok(json!([])),
        "inspectState" | "createInstance" | "destroyInstance" | "shutdown" => Ok(Value::Null),
        method => Err(adapter_error(
            "adapter_method_not_implemented",
            &format!("unsupported adapter method {method}"),
            None,
        )),
    }
}

fn dispatch_operation(operation: &str, input: &Value) -> OperationOutcome {
    let result = match operation {
        "kernel.protocol.deterministic-hashing" => run_deterministic_hashing(input),
        "kernel.protocol.schema-roundtrip" => run_schema_roundtrip(input),
        "kernel.protocol.modify-composition" => run_modify_composition(),
        "kernel.logical.diff-paths" => run_logical_diff(input),
        "kernel.logical.branch-list" => run_branch_list(input),
        "kernel.logical.recovery-state" => run_recovery_state(input),
        "kernel.lineage.cross-thread-rejection" => run_cross_thread_lineage(),
        "kernel.turn.lateral-head-guard" => run_lateral_turn_head_guard(),
        _ => Err(error(
            "adapter_operation_not_implemented",
            &format!("rust kernel adapter does not implement {operation}"),
        )),
    };

    match result {
        Ok(value) => OperationOutcome::Result { value },
        Err(source) => OperationOutcome::Error {
            error: AdapterErrorEnvelope {
                code: source.payload.code,
                message: source.payload.message,
                details: None,
            },
        },
    }
}

fn run_deterministic_hashing(input: &Value) -> Result<Value, KernelError> {
    let fixture = read_input_fixture(input)?;
    let raw_bytes = read_u8_array(fixture.get("rawOpaqueBytes"), "rawOpaqueBytes")?;
    let schema = decode_deterministic_kernel_record(&hex_to_bytes(&read_string(
        fixture.get("turnTreeSchemaRecordCborHex"),
        "turnTreeSchemaRecordCborHex",
    )?)?)?;
    let node = parse_turn_node_identity(read_value(
        fixture.get("turnNodeIdentityRecord"),
        "turnNodeIdentityRecord",
    )?)?;

    Ok(json!({
        "evidence": {
            "hashes": {
                "rawOpaqueBytes": hash_bytes_to_hex(&raw_bytes),
                "turnTreeSchema": hash_kernel_record(&schema)?,
                "turnNodeIdentity": hash_turn_node_identity(&node)?,
            }
        }
    }))
}

fn run_schema_roundtrip(input: &Value) -> Result<Value, KernelError> {
    let fixture = read_input_fixture(input)?;
    let decoded_schema = decode_deterministic_kernel_record(&hex_to_bytes(&read_string(
        fixture.get("turnTreeSchemaRecordCborHex"),
        "turnTreeSchemaRecordCborHex",
    )?)?)?;
    let decoded_node = decode_deterministic_kernel_record(&hex_to_bytes(&read_string(
        fixture.get("turnNodeIdentityRecordCborHex"),
        "turnNodeIdentityRecordCborHex",
    )?)?)?;

    Ok(json!({
        "evidence": {
            "roundtrip": {
                "turnTreeSchemaRecord": kernel_record_to_json(&decoded_schema),
                "turnNodeIdentityRecord": kernel_record_to_json(&decoded_node)
            }
        }
    }))
}

fn run_modify_composition() -> Result<Value, KernelError> {
    let kernel = InMemoryKernel::new();
    let verdict = kernel.verdicts_compose(vec![
        tuvren_kernel_rust::Verdict::Modify {
            transform: KernelRecord::Map(BTreeMap::from([
                (
                    "extension".to_string(),
                    KernelRecord::Text("first".to_string()),
                ),
                (
                    "mutation".to_string(),
                    KernelRecord::Text("append-prefix".to_string()),
                ),
            ])),
        },
        tuvren_kernel_rust::Verdict::Proceed,
        tuvren_kernel_rust::Verdict::Modify {
            transform: KernelRecord::Map(BTreeMap::from([
                (
                    "extension".to_string(),
                    KernelRecord::Text("second".to_string()),
                ),
                (
                    "mutation".to_string(),
                    KernelRecord::Text("append-suffix".to_string()),
                ),
            ])),
        },
    ])?;

    let tuvren_kernel_rust::Verdict::Modify { transform } = verdict else {
        return Err(error(
            "unexpected_verdict_kind",
            "expected modify verdict after composing ordered modify transforms",
        ));
    };

    Ok(json!({
        "evidence": {
            "verdict": {
                "kind": "modify",
                "transform": kernel_record_to_json(&transform),
            }
        }
    }))
}

fn run_logical_diff(input: &Value) -> Result<Value, KernelError> {
    let logical = read_input_fixture(input)?;
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    let created = kernel.thread_create("thread_conformance", "schema_main", "branch_main")?;
    let mut changes = BTreeMap::new();
    let logical_changes = read_object(logical.get("turnTreeChangeSet"), "turnTreeChangeSet")?;

    for (path, value) in logical_changes {
        changes.insert(path.clone(), parse_path_value(value)?);
    }

    let changed_tree =
        kernel.tree_create("schema_main", changes, Some(&created.root_turn_tree_hash))?;
    let diff = kernel.tree_diff(&created.root_turn_tree_hash, &changed_tree)?;

    Ok(json!({ "evidence": { "diffPaths": diff } }))
}

fn run_branch_list(input: &Value) -> Result<Value, KernelError> {
    let _logical = read_input_fixture(input)?;
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    kernel.thread_create("thread_conformance", "schema_main", "branch_main")?;
    let branch_entries = kernel.branch_list("thread_conformance")?;

    Ok(json!({ "evidence": { "branchEntries": branch_entries } }))
}

fn run_recovery_state(input: &Value) -> Result<Value, KernelError> {
    let logical = read_input_fixture(input)?;
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let recovery_state =
        parse_recovery_state(read_value(logical.get("recoveryState"), "recoveryState")?)?;
    run_recovery_fixture_scenario(&canonical_schema, &recovery_state)?;

    Ok(json!({
        "evidence": {
            "recovery": {
                "lastCompletedStepId": recovery_state.last_completed_step_id,
                "consumedStagedResults": recovery_state.consumed_staged_results.len(),
                "uncommittedStagedResults": recovery_state.uncommitted_staged_results.len()
            }
        }
    }))
}

fn run_cross_thread_lineage() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
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
    kernel.thread_create("thread_b", "schema_main", "branch_b")?;
    // Unexpected acceptance is returned as observation evidence so one check
    // fails without turning a kernel regression into an adapter process panic.
    let lineage_error = match kernel.branch_create("branch_cross_thread", "thread_b", &node_a) {
        Ok(_) => {
            return Ok(json!({
                "evidence": {
                    "errorCode": "unexpected_success",
                    "diagnostics": ["thread A node unexpectedly seeded thread B branch"]
                }
            }));
        }
        Err(error) => error,
    };

    Ok(json!({ "evidence": { "errorCode": lineage_error.payload.code } }))
}

fn run_lateral_turn_head_guard() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
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
    kernel.run_complete_step("run_main", "main_step", None, Vec::new(), None)?;
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
    // Unexpected acceptance is returned as observation evidence so one check
    // fails without turning a kernel regression into an adapter process panic.
    let lateral_error = match kernel.turn_update_head("turn_main", &alt_node) {
        Ok(_) => {
            return Ok(json!({
                "evidence": {
                    "errorCode": "unexpected_success",
                    "diagnostics": ["turn head unexpectedly jumped to a lateral descendant"]
                }
            }));
        }
        Err(error) => error,
    };

    Ok(json!({ "evidence": { "errorCode": lateral_error.payload.code } }))
}

fn parse_schema(value: &Value) -> Result<TurnTreeSchema, KernelError> {
    let object = read_object(Some(value), "schema")?;
    let paths = read_array(object.get("paths"), "paths")?
        .iter()
        .map(parse_path_definition)
        .collect::<Result<Vec<_>, _>>()?;
    let incorporation_rules = read_array(object.get("incorporationRules"), "incorporationRules")?
        .iter()
        .map(|value| {
            let object = read_object(Some(value), "incorporation rule")?;
            Ok(tuvren_kernel_rust::IncorporationRule {
                object_type: read_string(object.get("objectType"), "objectType")?,
                target_path: read_string(object.get("targetPath"), "targetPath")?,
            })
        })
        .collect::<Result<Vec<_>, KernelError>>()?;

    Ok(TurnTreeSchema {
        incorporation_rules,
        paths,
        schema_id: read_string(object.get("schemaId"), "schemaId")?,
    })
}

fn kernel_record_to_json(record: &KernelRecord) -> Value {
    match record {
        KernelRecord::Null => Value::Null,
        KernelRecord::Bool(value) => Value::Bool(*value),
        KernelRecord::Integer(value) => json!(value),
        KernelRecord::Text(value) => Value::String(value.clone()),
        KernelRecord::Bytes(value) => json!(value),
        KernelRecord::Array(values) => {
            Value::Array(values.iter().map(kernel_record_to_json).collect())
        }
        KernelRecord::Map(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), kernel_record_to_json(value)))
                .collect(),
        ),
    }
}

fn parse_path_definition(value: &Value) -> Result<PathDefinition, KernelError> {
    let object = read_object(Some(value), "path definition")?;
    let collection = match read_string(object.get("collection"), "collection")?.as_str() {
        "ordered" => PathCollectionKind::Ordered,
        "single" => PathCollectionKind::Single,
        _ => return Err(error("invalid_path_collection", "invalid path collection")),
    };
    Ok(PathDefinition {
        collection,
        metadata: object
            .get("metadata")
            .map(kernel_record_from_json)
            .transpose()?,
        path: read_string(object.get("path"), "path")?,
    })
}

fn parse_turn_node_identity(value: &Value) -> Result<TurnNode, KernelError> {
    let object = read_object(Some(value), "turn node")?;
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
    let object = read_object(Some(value), "staged result")?;
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
    let object = read_object(Some(value), "recovery state")?;
    Ok(RecoveryState {
        consumed_staged_results: read_array(
            object.get("consumedStagedResults"),
            "consumedStagedResults",
        )?
        .iter()
        .map(parse_staged_result)
        .collect::<Result<Vec<_>, _>>()?,
        last_completed_step_id: read_nullable_string(
            object.get("lastCompletedStepId"),
            "lastCompletedStepId",
        )?,
        last_turn_node_hash: read_string(object.get("lastTurnNodeHash"), "lastTurnNodeHash")?,
        step_sequence: read_array(object.get("stepSequence"), "stepSequence")?
            .iter()
            .map(parse_step_declaration)
            .collect::<Result<Vec<_>, _>>()?,
        uncommitted_staged_results: read_array(
            object.get("uncommittedStagedResults"),
            "uncommittedStagedResults",
        )?
        .iter()
        .map(parse_staged_result)
        .collect::<Result<Vec<_>, _>>()?,
    })
}

fn parse_step_declaration(value: &Value) -> Result<StepDeclaration, KernelError> {
    let object = read_object(Some(value), "step declaration")?;
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
    let consumed = expected
        .consumed_staged_results
        .first()
        .ok_or_else(|| error("invalid_recovery_fixture", "missing consumed staged result"))?;
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
            "missing uncommitted staged result",
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
        last_turn_node_hash: last_turn_node_hash
            .ok_or_else(|| error("invalid_recovery_fixture", "missing checkpoint"))?,
        step_sequence: expected.step_sequence.clone(),
        uncommitted_staged_results: vec![uncommitted_staged],
    };

    if actual != expected_actual {
        return Err(error(
            "recovery_state_mismatch",
            "native recovery state did not match fixture",
        ));
    }
    Ok(())
}

fn read_input_fixture(input: &Value) -> Result<&Map<String, Value>, KernelError> {
    read_object(input.get("fixture"), "adapter input fixture")
}

fn read_json(path: &Path) -> Result<Value, KernelError> {
    let text = std::fs::read_to_string(path).map_err(|source| {
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

fn read_value<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a Value, KernelError> {
    value.ok_or_else(|| error("missing_value", &format!("{label} is required")))
}

fn read_object<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> Result<&'a Map<String, Value>, KernelError> {
    value.and_then(Value::as_object).ok_or_else(|| {
        error(
            "invalid_object_fixture",
            &format!("{label} must be an object"),
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

fn read_u8_array(value: Option<&Value>, label: &str) -> Result<Vec<u8>, KernelError> {
    read_array(value, label)?
        .iter()
        .map(|entry| {
            entry
                .as_u64()
                .and_then(|value| u8::try_from(value).ok())
                .ok_or_else(|| {
                    error(
                        "invalid_byte_fixture",
                        &format!("{label} must contain bytes"),
                    )
                })
        })
        .collect()
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

fn read_bool(value: Option<&Value>, label: &str) -> Result<bool, KernelError> {
    value.and_then(Value::as_bool).ok_or_else(|| {
        error(
            "invalid_boolean_fixture",
            &format!("{label} must be a boolean"),
        )
    })
}

fn read_i64(value: Option<&Value>, label: &str) -> Result<i64, KernelError> {
    value.and_then(Value::as_i64).ok_or_else(|| {
        error(
            "invalid_integer_fixture",
            &format!("{label} must be an integer"),
        )
    })
}

fn read_param_string(params: &Value, key: &str) -> Result<String, AdapterErrorEnvelope> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            adapter_error(
                "invalid_adapter_request",
                &format!("{key} must be a string"),
                None,
            )
        })
}

fn adapter_error(code: &str, message: &str, details: Option<Value>) -> AdapterErrorEnvelope {
    AdapterErrorEnvelope {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn error_response(id: Value, code: &str, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": adapter_error(code, message, None)
    })
}

fn error(code: &str, message: &str) -> KernelError {
    KernelError::new(code, message, Option::<KernelRecord>::None)
}
