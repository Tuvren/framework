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
use std::sync::{Arc, Mutex};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, AeadCore, Generate, Key, KeyInit},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tuvren_kernel_rust::{
    HashString, InMemoryKernel, InMemoryKernelOptions, KernelError, KernelRecord,
    LeasedRunCreateInput, PathCollectionKind, PathDefinition, PathValue, RecoveryState,
    RunCompletionStatus, RunStatus, StagedResult, StagedResultStatus, StepDeclaration,
    ThreadListOptions, TurnNode, TurnTreeSchema, Verdict, VerdictDisposition,
    decode_deterministic_kernel_record, hash_bytes_to_hex, hash_kernel_record,
    hash_turn_node_identity, kernel_record_from_json,
};

const CANONICAL_SCHEMA_PATH: &str =
    "spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json";

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
                "kernel-protocol.thread.enumeration",
                "kernel.run-liveness",
                "kernel.reclamation",
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
        "kernel.protocol.modify-composition" => run_modify_composition(input),
        "kernel.protocol.canonical-rejection" => run_canonical_rejection(input),
        "kernel.logical.diff-paths" => run_logical_diff(input),
        "kernel.logical.branch-list" => run_branch_list(input),
        "kernel.logical.thread-list" => run_thread_list(),
        "kernel.logical.recovery-state" => run_recovery_state(input),
        "kernel.lineage.cross-thread-rejection" => run_cross_thread_lineage(),
        "kernel.turn.lateral-head-guard" => run_lateral_turn_head_guard(),
        "kernel.run-liveness.lease-renewal" => run_lease_renewal(),
        "kernel.run-liveness.expired-listing" => run_expired_listing(),
        "kernel.run-liveness.stale-preemption" => run_stale_preemption(),
        "kernel.reclamation.reclaim-probe" => run_reclamation_probe(),
        "kernel.reclamation.erasure-probe" => run_erasure_probe(),
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

    Ok(projection(json!({
        "hashes": {
            "rawOpaqueBytes": hash_bytes_to_hex(&raw_bytes),
            "turnTreeSchema": hash_kernel_record(&schema)?,
            "turnNodeIdentity": hash_turn_node_identity(&node)?,
        }
    })))
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

    Ok(projection(json!({
        "roundtrip": {
            "turnTreeSchemaRecord": kernel_record_to_json(&decoded_schema),
            "turnNodeIdentityRecord": kernel_record_to_json(&decoded_node)
        }
    })))
}

fn run_modify_composition(input: &Value) -> Result<Value, KernelError> {
    if let Some(fixture_value) = input.get("fixture") {
        return run_modify_composition_fixture(read_object(
            Some(fixture_value),
            "adapter input fixture",
        )?);
    }

    let kernel = InMemoryKernel::new();
    let verdict = kernel.verdicts_compose(vec![
        Verdict::Modify {
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
        Verdict::Proceed,
        Verdict::Modify {
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

    let Verdict::Modify { transform } = verdict else {
        return Err(error(
            "unexpected_verdict_kind",
            "expected modify verdict after composing ordered modify transforms",
        ));
    };

    Ok(projection(json!({
        "verdict": {
            "kind": "modify",
            "transform": kernel_record_to_json(&transform),
        }
    })))
}

// KRT-BK010 (`kernel.protocol`): fixture-aware extension of
// `kernel.protocol.modify-composition` that composes each named case's
// verdict list through `InMemoryKernel::verdicts_compose` and projects the
// resulting verdict, mirroring the TypeScript conformance host's handling of
// `f-verdict-composition`. Kernel spec §6.1/§6.2 fix the dominance order
// Abort > Pause > Modify > Retry > Proceed, first-objection-wins, with
// multiple Modify transforms composing into an ordered array.
fn run_modify_composition_fixture(fixture: &Map<String, Value>) -> Result<Value, KernelError> {
    let cases = read_object(fixture.get("cases"), "cases")?;
    let kernel = InMemoryKernel::new();
    let mut composition = Map::new();

    for (name, case) in cases {
        let case_object = read_object(Some(case), "verdict composition case")?;
        let verdicts = read_array(case_object.get("verdicts"), "verdicts")?
            .iter()
            .map(parse_verdict)
            .collect::<Result<Vec<_>, _>>()?;
        let composed = kernel.verdicts_compose(verdicts)?;
        composition.insert(name.clone(), verdict_to_json(&composed));
    }

    Ok(projection(
        json!({ "composition": Value::Object(composition) }),
    ))
}

fn parse_verdict(value: &Value) -> Result<Verdict, KernelError> {
    let object = read_object(Some(value), "verdict")?;
    match read_string(object.get("kind"), "verdict.kind")?.as_str() {
        "proceed" => Ok(Verdict::Proceed),
        "abort" => Ok(Verdict::Abort {
            disposition: parse_verdict_disposition(&read_string(
                object.get("disposition"),
                "verdict.disposition",
            )?)?,
            reason: read_string(object.get("reason"), "verdict.reason")?,
        }),
        "modify" => Ok(Verdict::Modify {
            transform: kernel_record_from_json(read_value(
                object.get("transform"),
                "verdict.transform",
            )?)?,
        }),
        "pause" => Ok(Verdict::Pause {
            reason: read_string(object.get("reason"), "verdict.reason")?,
            resumption_schema: kernel_record_from_json(read_value(
                object.get("resumptionSchema"),
                "verdict.resumptionSchema",
            )?)?,
        }),
        "retry" => Ok(Verdict::Retry {
            adjustment: kernel_record_from_json(read_value(
                object.get("adjustment"),
                "verdict.adjustment",
            )?)?,
        }),
        other => Err(error(
            "invalid_verdict_kind",
            &format!("unsupported verdict kind {other}"),
        )),
    }
}

fn parse_verdict_disposition(value: &str) -> Result<VerdictDisposition, KernelError> {
    match value {
        "HardFail" => Ok(VerdictDisposition::HardFail),
        "SoftFail" => Ok(VerdictDisposition::SoftFail),
        "EndTurn" => Ok(VerdictDisposition::EndTurn),
        other => Err(error(
            "invalid_verdict_disposition",
            &format!("unsupported verdict disposition {other}"),
        )),
    }
}

fn verdict_disposition_to_str(disposition: &VerdictDisposition) -> &'static str {
    match disposition {
        VerdictDisposition::HardFail => "HardFail",
        VerdictDisposition::SoftFail => "SoftFail",
        VerdictDisposition::EndTurn => "EndTurn",
    }
}

fn verdict_to_json(verdict: &Verdict) -> Value {
    match verdict {
        Verdict::Proceed => json!({ "kind": "proceed" }),
        Verdict::Abort {
            disposition,
            reason,
        } => json!({
            "kind": "abort",
            "disposition": verdict_disposition_to_str(disposition),
            "reason": reason,
        }),
        Verdict::Modify { transform } => json!({
            "kind": "modify",
            "transform": kernel_record_to_json(transform),
        }),
        Verdict::Pause {
            reason,
            resumption_schema,
        } => json!({
            "kind": "pause",
            "reason": reason,
            "resumptionSchema": kernel_record_to_json(resumption_schema),
        }),
        Verdict::Retry { adjustment } => json!({
            "kind": "retry",
            "adjustment": kernel_record_to_json(adjustment),
        }),
    }
}

// KRT-BK010 (`kernel.protocol`): mirrors the TypeScript conformance host's
// canonical-rejection check. Each named adversarial byte sequence from
// `f-adversarial-cbor` (docs/KrakenKernelSpecification.md §2.3) must be
// refused identity by the strict deterministic CBOR decoder.
fn run_canonical_rejection(input: &Value) -> Result<Value, KernelError> {
    let fixture = read_input_fixture(input)?;
    let cases = read_object(fixture.get("cases"), "cases")?;
    let mut rejection = Map::new();

    for (name, case) in cases {
        let case_object = read_object(Some(case), "adversarial cbor case")?;
        let bytes = read_u8_array(case_object.get("cborBytes"), "cborBytes")?;
        let rejected = decode_deterministic_kernel_record(&bytes).is_err();
        rejection.insert(name.clone(), json!({ "rejected": rejected }));
    }

    Ok(projection(json!({ "rejection": Value::Object(rejection) })))
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

    Ok(projection(json!({ "diffPaths": diff })))
}

fn run_branch_list(input: &Value) -> Result<Value, KernelError> {
    let _logical = read_input_fixture(input)?;
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    kernel.thread_create("thread_conformance", "schema_main", "branch_main")?;
    let branch_entries = kernel.branch_list("thread_conformance")?;

    Ok(projection(json!({ "branchEntries": branch_entries })))
}

fn run_thread_list() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    kernel.thread_create("thread_enum_a", "schema_main", "branch_enum_a")?;
    kernel.thread_create("thread_enum_b", "schema_main", "branch_enum_b")?;
    let (all_threads, _) = kernel.thread_list(ThreadListOptions::default())?;
    let (paged, next_cursor) = kernel.thread_list(ThreadListOptions {
        limit: Some(1),
        ..Default::default()
    })?;
    Ok(projection(json!({
        "threadEnumeration": {
            "count": all_threads.len(),
            "firstThreadId": all_threads.first().map(|t| t.thread_id.as_str()).unwrap_or(""),
            "pagedCount": paged.len(),
            "hasCursor": next_cursor.is_some()
        }
    })))
}

fn run_recovery_state(input: &Value) -> Result<Value, KernelError> {
    let logical = read_input_fixture(input)?;
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let recovery_state =
        parse_recovery_state(read_value(logical.get("recoveryState"), "recoveryState")?)?;
    run_recovery_fixture_scenario(&canonical_schema, &recovery_state)?;

    Ok(projection(json!({
        "recovery": {
            "lastCompletedStepId": recovery_state.last_completed_step_id,
            "consumedStagedResults": recovery_state.consumed_staged_results.len(),
            "uncommittedStagedResults": recovery_state.uncommitted_staged_results.len()
        }
    })))
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
            return Ok(projection(json!({
                "errorCode": "unexpected_success",
                "diagnostics": ["thread A node unexpectedly seeded thread B branch"]
            })));
        }
        Err(error) => error,
    };

    Ok(projection(
        json!({ "errorCode": lineage_error.payload.code }),
    ))
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
            return Ok(projection(json!({
                "errorCode": "unexpected_success",
                "diagnostics": ["turn head unexpectedly jumped to a lateral descendant"]
            })));
        }
        Err(error) => error,
    };

    Ok(projection(
        json!({ "errorCode": lateral_error.payload.code }),
    ))
}

// KRT-BK010 (`kernel.run-liveness`): mirrors the TypeScript conformance host's
// `runLeaseRenewal` (typescript/kernel/conformance-adapter/src/host.ts,
// runLeaseRenewal). A fixed clock keeps the lease-expiry values deterministic.
fn run_lease_renewal() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(|| 10)),
    });
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    let thread = kernel.thread_create(
        "thread_liveness_renewal",
        "schema_main",
        "branch_liveness_renewal",
    )?;
    let turn = kernel.turn_create(
        "turn_liveness_renewal",
        "thread_liveness_renewal",
        "branch_liveness_renewal",
        None,
        &thread.root_turn_node_hash,
    )?;
    let leased_run = kernel.run_liveness_create_leased_run(LeasedRunCreateInput {
        branch_id: thread.branch_id.clone(),
        execution_owner_id: "owner-primary".to_string(),
        lease_expires_at_ms: 20,
        run_id: "run_liveness_renewal".to_string(),
        schema_id: "schema_main".to_string(),
        start_turn_node_hash: thread.root_turn_node_hash.clone(),
        steps: vec![StepDeclaration {
            deterministic: false,
            id: "iterate".to_string(),
            metadata: None,
            side_effects: true,
        }],
        turn_id: turn.turn_id.clone(),
    })?;
    let stale_token = leased_run
        .fencing_token
        .clone()
        .ok_or_else(|| error("missing_fencing_token", "expected leased run fencing token"))?;
    let renewed =
        kernel.run_liveness_renew_lease(&leased_run.run_id, "owner-primary", &stale_token, 40)?;
    let renewed_fencing_token = renewed
        .fencing_token
        .clone()
        .ok_or_else(|| error("missing_fencing_token", "expected renewed fencing token"))?;

    let owner_mismatch_code = match kernel.run_liveness_renew_lease(
        &leased_run.run_id,
        "owner-secondary",
        &renewed_fencing_token,
        50,
    ) {
        Ok(_) => "unexpected_success".to_string(),
        Err(source) => source.payload.code,
    };

    let stale_token_code = match kernel.run_liveness_renew_lease(
        &leased_run.run_id,
        "owner-primary",
        &stale_token,
        50,
    ) {
        Ok(_) => "unexpected_success".to_string(),
        Err(source) => source.payload.code,
    };

    Ok(projection(json!({
        "renewal": {
            "renewedLeaseExpiresAtMs": renewed.lease_expires_at_ms,
            "ownerMismatchCode": owner_mismatch_code,
            "staleTokenCode": stale_token_code,
        }
    })))
}

// KRT-BK010 (`kernel.run-liveness`): mirrors the TypeScript conformance
// host's `runExpiredListing`. Three leased runs on separate threads/branches:
// one left running with an already-expired lease, one completed as failed,
// and one completed as paused (with a stale lease value that must not make it
// eligible for expired listing, since paused status excludes it outright).
fn run_expired_listing() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(|| 10)),
    });
    kernel.schema_register(parse_schema(&canonical_schema)?)?;

    let expired_thread = kernel.thread_create(
        "thread_liveness_listing_expired",
        "schema_main",
        "branch_liveness_listing_expired",
    )?;
    let fresh_thread = kernel.thread_create(
        "thread_liveness_listing_fresh",
        "schema_main",
        "branch_liveness_listing_fresh",
    )?;
    let paused_thread = kernel.thread_create(
        "thread_liveness_listing_paused",
        "schema_main",
        "branch_liveness_listing_paused",
    )?;
    let expired_turn = kernel.turn_create(
        "turn_liveness_listing_expired",
        "thread_liveness_listing_expired",
        "branch_liveness_listing_expired",
        None,
        &expired_thread.root_turn_node_hash,
    )?;
    let fresh_turn = kernel.turn_create(
        "turn_liveness_listing_fresh",
        "thread_liveness_listing_fresh",
        "branch_liveness_listing_fresh",
        None,
        &fresh_thread.root_turn_node_hash,
    )?;
    let paused_turn = kernel.turn_create(
        "turn_liveness_listing_paused",
        "thread_liveness_listing_paused",
        "branch_liveness_listing_paused",
        None,
        &paused_thread.root_turn_node_hash,
    )?;

    kernel.run_liveness_create_leased_run(LeasedRunCreateInput {
        branch_id: expired_thread.branch_id.clone(),
        execution_owner_id: "owner-primary".to_string(),
        lease_expires_at_ms: 5,
        run_id: "run_expired".to_string(),
        schema_id: "schema_main".to_string(),
        start_turn_node_hash: expired_thread.root_turn_node_hash.clone(),
        steps: vec![StepDeclaration {
            deterministic: false,
            id: "iterate".to_string(),
            metadata: None,
            side_effects: true,
        }],
        turn_id: expired_turn.turn_id.clone(),
    })?;
    let fresh_run = kernel.run_liveness_create_leased_run(LeasedRunCreateInput {
        branch_id: fresh_thread.branch_id.clone(),
        execution_owner_id: "owner-primary".to_string(),
        lease_expires_at_ms: 50,
        run_id: "run_fresh".to_string(),
        schema_id: "schema_main".to_string(),
        start_turn_node_hash: fresh_thread.root_turn_node_hash.clone(),
        steps: vec![StepDeclaration {
            deterministic: false,
            id: "iterate".to_string(),
            metadata: None,
            side_effects: true,
        }],
        turn_id: fresh_turn.turn_id.clone(),
    })?;
    let paused_run = kernel.run_liveness_create_leased_run(LeasedRunCreateInput {
        branch_id: paused_thread.branch_id.clone(),
        execution_owner_id: "owner-primary".to_string(),
        // This lease is already stale before the pause so the evidence proves
        // paused status, not remaining lease time, keeps it out of expired
        // listings.
        lease_expires_at_ms: 5,
        run_id: "run_paused".to_string(),
        schema_id: "schema_main".to_string(),
        start_turn_node_hash: paused_thread.root_turn_node_hash.clone(),
        steps: vec![StepDeclaration {
            deterministic: false,
            id: "iterate".to_string(),
            metadata: None,
            side_effects: true,
        }],
        turn_id: paused_turn.turn_id.clone(),
    })?;

    kernel.run_complete(&fresh_run.run_id, RunCompletionStatus::Failed, None)?;
    kernel.run_complete(&paused_run.run_id, RunCompletionStatus::Paused, None)?;

    let expired_runs = kernel.run_liveness_list_expired(10)?;
    let paused_stored_run = kernel
        .run_get(&paused_run.run_id)?
        .ok_or_else(|| error("missing_run", "expected paused stored run"))?;

    Ok(projection(json!({
        "listing": {
            "expiredRunIds": expired_runs.iter().map(|run| run.run_id.as_str()).collect::<Vec<_>>(),
            "pausedRunListed": expired_runs.iter().any(|run| run.run_id == paused_run.run_id),
            "pausedRunStatus": run_status_to_str(&paused_stored_run.status),
        }
    })))
}

// KRT-BK010 (`kernel.run-liveness`): mirrors the TypeScript conformance
// host's `runStalePreemption`.
fn run_stale_preemption() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(|| 10)),
    });
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    let thread = kernel.thread_create(
        "thread_liveness_preemption",
        "schema_main",
        "branch_liveness_preemption",
    )?;
    let turn = kernel.turn_create(
        "turn_liveness_preemption",
        "thread_liveness_preemption",
        "branch_liveness_preemption",
        None,
        &thread.root_turn_node_hash,
    )?;
    let leased_run = kernel.run_liveness_create_leased_run(LeasedRunCreateInput {
        branch_id: thread.branch_id.clone(),
        execution_owner_id: "owner-primary".to_string(),
        lease_expires_at_ms: 5,
        run_id: "run_liveness_preemption".to_string(),
        schema_id: "schema_main".to_string(),
        start_turn_node_hash: thread.root_turn_node_hash.clone(),
        steps: vec![StepDeclaration {
            deterministic: false,
            id: "iterate".to_string(),
            metadata: None,
            side_effects: true,
        }],
        turn_id: turn.turn_id.clone(),
    })?;
    kernel.run_begin_step(&leased_run.run_id, "iterate")?;
    kernel.staging_stage(
        &leased_run.run_id,
        b"assistant".to_vec(),
        "assistant_message",
        "message",
        StagedResultStatus::Completed,
        None,
    )?;
    let recovery = kernel.run_liveness_preempt_expired(
        &leased_run.run_id,
        "owner-secondary",
        10,
        "stale_running_recovery",
    )?;

    let stored_run = kernel
        .run_get(&leased_run.run_id)?
        .ok_or_else(|| error("missing_run", "expected preempted stored run"))?;
    let updated_branch = kernel
        .branch_get(&thread.branch_id)?
        .ok_or_else(|| error("missing_branch", "expected preempted branch"))?;

    let lease_cleared = stored_run.execution_owner_id.is_none()
        && stored_run.fencing_token.is_none()
        && stored_run.lease_expires_at_ms.is_none();
    let preserved_staged_result_task_ids = recovery
        .consumed_staged_results
        .iter()
        .map(|staged| staged.task_id.as_str())
        .collect::<Vec<_>>();

    Ok(projection(json!({
        "preemption": {
            "branchHeadTurnNodeHash": updated_branch.head_turn_node_hash,
            "leaseCleared": lease_cleared,
            "preemptionReason": stored_run.preemption_reason,
            "preservedStagedResultTaskIds": preserved_staged_result_task_ids,
            "recoveryHeadMatchesBranchHead": recovery.last_turn_node_hash == updated_branch.head_turn_node_hash,
            "recoveryLastTurnNodeHash": recovery.last_turn_node_hash,
            "runStatus": run_status_to_str(&stored_run.status),
            "uncommittedStagedResults": recovery.uncommitted_staged_results.len(),
        }
    })))
}

fn run_status_to_str(status: &RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "running",
        RunStatus::Paused => "paused",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
    }
}

struct CheckpointMessageInput {
    branch_id: String,
    message_bytes: Vec<u8>,
    parent_turn_id: Option<String>,
    run_id: String,
    schema_id: String,
    start_turn_node_hash: String,
    task_id: String,
    thread_id: String,
    turn_id: String,
}

struct CheckpointMessageResult {
    object_hash: HashString,
    turn_id: String,
    turn_node_hash: HashString,
}

/// Mirrors the TypeScript conformance host's `checkpointMessageIntoHead`: runs
/// one non-deterministic checkpoint step that stages `message_bytes` as a
/// `message`, so the canonical schema incorporates it into the branch-head
/// turn tree's `messages` path.
fn checkpoint_message_into_head(
    kernel: &InMemoryKernel,
    input: CheckpointMessageInput,
) -> Result<CheckpointMessageResult, KernelError> {
    let turn = kernel.turn_create(
        &input.turn_id,
        &input.thread_id,
        &input.branch_id,
        input.parent_turn_id,
        &input.start_turn_node_hash,
    )?;
    kernel.run_create(
        &input.run_id,
        &turn.turn_id,
        &input.branch_id,
        &input.schema_id,
        &input.start_turn_node_hash,
        vec![StepDeclaration {
            deterministic: false,
            id: "checkpoint".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;
    kernel.run_begin_step(&input.run_id, "checkpoint")?;
    let (object_hash, _staged) = kernel.staging_stage(
        &input.run_id,
        input.message_bytes,
        &input.task_id,
        "message",
        StagedResultStatus::Completed,
        None,
    )?;
    let (_, turn_node_hash) =
        kernel.run_complete_step(&input.run_id, "checkpoint", None, Vec::new(), None)?;
    let turn_node_hash = turn_node_hash
        .ok_or_else(|| error("missing_checkpoint", "expected checkpoint turn node hash"))?;
    kernel.run_complete(&input.run_id, RunCompletionStatus::Completed, None)?;
    Ok(CheckpointMessageResult {
        object_hash,
        turn_id: turn.turn_id,
        turn_node_hash,
    })
}

// KRT-BK010 (`kernel.reclamation`): mirrors the TypeScript conformance host's
// `runReclamationProbe`. Four independent sub-scenarios, each over its own
// kernel instance: (1) an archive rollback over a shared non-root ancestor
// proves the keep closure is a set-union over live roots; (2) a deterministic
// clock orders writes around an active execution lease to prove the grace
// window is the lease horizon; (3)/(4) a leaseless running run either past or
// within the 24h admin-expiry horizon does/doesn't pin the grace horizon.
fn run_reclamation_probe() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;

    // --- (1) Reachability sub-scenario (archive rollback). ---
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;
    let thread = kernel.thread_create("thread_reclamation", "schema_main", "branch_reclamation")?;

    let shared = checkpoint_message_into_head(
        &kernel,
        CheckpointMessageInput {
            branch_id: thread.branch_id.clone(),
            message_bytes: b"shared-across-live-and-archived".to_vec(),
            parent_turn_id: None,
            run_id: "run_shared".to_string(),
            schema_id: "schema_main".to_string(),
            start_turn_node_hash: thread.root_turn_node_hash.clone(),
            task_id: "msg_shared".to_string(),
            thread_id: thread.thread_id.clone(),
            turn_id: "turn_shared".to_string(),
        },
    )?;
    let shared_object_hash = shared.object_hash.clone();

    let archived = checkpoint_message_into_head(
        &kernel,
        CheckpointMessageInput {
            branch_id: thread.branch_id.clone(),
            message_bytes: b"archived-exclusive-payload".to_vec(),
            parent_turn_id: Some(shared.turn_id.clone()),
            run_id: "run_archived".to_string(),
            schema_id: "schema_main".to_string(),
            start_turn_node_hash: shared.turn_node_hash.clone(),
            task_id: "msg_archived".to_string(),
            thread_id: thread.thread_id.clone(),
            turn_id: "turn_archived".to_string(),
        },
    )?;
    let archived_only_object_hash = archived.object_hash.clone();

    let archived_node = kernel
        .node_get(&archived.turn_node_hash)?
        .ok_or_else(|| error("missing_node", "expected archived node before rollback"))?;
    let archived_manifest = kernel.tree_manifest(&archived_node.turn_tree_hash)?;
    let shared_object_referenced_by_archived_node = matches!(
        archived_manifest.get("messages"),
        Some(PathValue::Ordered(hashes)) if hashes.contains(&shared_object_hash)
    );

    let rollback = kernel.branch_set_head(&thread.branch_id, &shared.turn_node_hash)?;
    let archived_into_branch = rollback
        .archive_branch
        .as_ref()
        .is_some_and(|archive| archive.head_turn_node_hash == archived.turn_node_hash);

    let orphan_object_hash = kernel.store_put(b"unreachable-orphan".to_vec(), None)?;

    let summary = kernel.maintenance_reclaim()?;

    let branches_after = kernel.branch_list(&thread.thread_id)?;
    let thread_after = kernel.thread_get(&thread.thread_id)?;

    let archived_branch_released = archived_into_branch
        && !kernel.store_has(&archived_only_object_hash)?
        && kernel.node_get(&archived.turn_node_hash)?.is_none()
        && !branches_after
            .iter()
            .any(|(branch_id, _)| branch_id.contains("archive"))
        && summary.released_archived_branch_count >= 1;

    let reachable_from_live_root_retained = kernel.store_has(&shared_object_hash)?
        && kernel.node_get(&shared.turn_node_hash)?.is_some()
        && thread_after
            .as_ref()
            .is_some_and(|t| t.root_turn_node_hash == thread.root_turn_node_hash);

    let shared_object_retained_via_live_root = shared_object_referenced_by_archived_node
        && kernel.store_has(&shared_object_hash)?
        && !kernel.store_has(&archived_only_object_hash)?
        && kernel.node_get(&archived.turn_node_hash)?.is_none();

    let unreachable_past_grace_released =
        !kernel.store_has(&orphan_object_hash)? && summary.released_object_count >= 1;

    // --- (2) Grace-window sub-scenario. ---
    let grace_clock = Arc::new(Mutex::new(0i64));
    let grace_clock_for_closure = Arc::clone(&grace_clock);
    let grace_kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(move || *grace_clock_for_closure.lock().unwrap())),
    });
    grace_kernel.schema_register(parse_schema(&canonical_schema)?)?;

    *grace_clock.lock().unwrap() = 10;
    let orphan_before_lease = grace_kernel.store_put(vec![1], None)?;

    *grace_clock.lock().unwrap() = 20;
    let grace_thread = grace_kernel.thread_create("thread_grace", "schema_main", "branch_grace")?;
    let grace_turn = grace_kernel.turn_create(
        "turn_grace",
        "thread_grace",
        "branch_grace",
        None,
        &grace_thread.root_turn_node_hash,
    )?;
    grace_kernel.run_create(
        "run_grace",
        &grace_turn.turn_id,
        "branch_grace",
        "schema_main",
        &grace_thread.root_turn_node_hash,
        vec![StepDeclaration {
            deterministic: true,
            id: "work".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;

    *grace_clock.lock().unwrap() = 30;
    let orphan_after_lease = grace_kernel.store_put(vec![2], None)?;

    *grace_clock.lock().unwrap() = 40;
    grace_kernel.maintenance_reclaim()?;

    let grace_window_held_under_active_lease = !grace_kernel.store_has(&orphan_before_lease)?
        && grace_kernel.store_has(&orphan_after_lease)?;

    // --- (3) Leaseless-expired sub-scenario. ---
    let leaseless_expired_clock = Arc::new(Mutex::new(0i64));
    let leaseless_expired_clock_for_closure = Arc::clone(&leaseless_expired_clock);
    let leaseless_expired_kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(move || {
            *leaseless_expired_clock_for_closure.lock().unwrap()
        })),
    });
    leaseless_expired_kernel.schema_register(parse_schema(&canonical_schema)?)?;
    let leaseless_expired_thread = leaseless_expired_kernel.thread_create(
        "thread_leaseless_expired",
        "schema_main",
        "branch_leaseless_expired",
    )?;
    let leaseless_expired_turn = leaseless_expired_kernel.turn_create(
        "turn_leaseless_expired",
        "thread_leaseless_expired",
        "branch_leaseless_expired",
        None,
        &leaseless_expired_thread.root_turn_node_hash,
    )?;
    leaseless_expired_kernel.run_create(
        "run_leaseless_expired",
        &leaseless_expired_turn.turn_id,
        "branch_leaseless_expired",
        "schema_main",
        &leaseless_expired_thread.root_turn_node_hash,
        vec![StepDeclaration {
            deterministic: true,
            id: "work".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;

    *leaseless_expired_clock.lock().unwrap() = 10;
    let leaseless_expired_orphan =
        leaseless_expired_kernel.store_put(b"leaseless-expiry-orphan".to_vec(), None)?;

    *leaseless_expired_clock.lock().unwrap() = 86_400_000 + 5000;
    leaseless_expired_kernel.maintenance_reclaim()?;

    let leaseless_run_past_admin_expiry_does_not_pin_reclamation =
        !leaseless_expired_kernel.store_has(&leaseless_expired_orphan)?;

    // --- (4) Leaseless-active sub-scenario. ---
    let leaseless_active_clock = Arc::new(Mutex::new(0i64));
    let leaseless_active_clock_for_closure = Arc::clone(&leaseless_active_clock);
    let leaseless_active_kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(move || {
            *leaseless_active_clock_for_closure.lock().unwrap()
        })),
    });
    leaseless_active_kernel.schema_register(parse_schema(&canonical_schema)?)?;
    let leaseless_active_thread = leaseless_active_kernel.thread_create(
        "thread_leaseless_active",
        "schema_main",
        "branch_leaseless_active",
    )?;
    let leaseless_active_turn = leaseless_active_kernel.turn_create(
        "turn_leaseless_active",
        "thread_leaseless_active",
        "branch_leaseless_active",
        None,
        &leaseless_active_thread.root_turn_node_hash,
    )?;
    leaseless_active_kernel.run_create(
        "run_leaseless_active",
        &leaseless_active_turn.turn_id,
        "branch_leaseless_active",
        "schema_main",
        &leaseless_active_thread.root_turn_node_hash,
        vec![StepDeclaration {
            deterministic: true,
            id: "work".to_string(),
            metadata: None,
            side_effects: false,
        }],
    )?;

    *leaseless_active_clock.lock().unwrap() = 10;
    let leaseless_active_orphan =
        leaseless_active_kernel.store_put(b"leaseless-active-orphan".to_vec(), None)?;

    *leaseless_active_clock.lock().unwrap() = 1000;
    leaseless_active_kernel.maintenance_reclaim()?;

    let leaseless_run_within_admin_expiry_still_pins_reclamation =
        leaseless_active_kernel.store_has(&leaseless_active_orphan)?;

    Ok(projection(json!({
        "reclaim": {
            "archivedBranchReleased": archived_branch_released,
            "reachableFromLiveRootRetained": reachable_from_live_root_retained,
            "sharedObjectRetainedViaLiveRoot": shared_object_retained_via_live_root,
            "unreachablePastGraceReleased": unreachable_past_grace_released,
            "graceWindowHeldUnderActiveLease": grace_window_held_under_active_lease,
            "leaselessRunPastAdminExpiryDoesNotPinReclamation": leaseless_run_past_admin_expiry_does_not_pin_reclamation,
            "leaselessRunWithinAdminExpiryStillPinsReclamation": leaseless_run_within_admin_expiry_still_pins_reclamation,
        }
    })))
}

// KRT-BK010 (`kernel.reclamation`): mirrors the TypeScript conformance host's
// `runErasureProbe`. The crypto is entirely adapter-side: the Rust kernel
// itself never sees plaintext or a key, only ever calling `store_put`/
// `store_get` on opaque ciphertext bytes. "Erasure" is the host destroying
// its own in-memory key.
fn run_erasure_probe() -> Result<Value, KernelError> {
    let canonical_schema = read_json(Path::new(CANONICAL_SCHEMA_PATH))?;
    let kernel = InMemoryKernel::new();
    kernel.schema_register(parse_schema(&canonical_schema)?)?;

    let mut key: Option<Key<Aes256Gcm>> = Some(Key::<Aes256Gcm>::generate());
    let plaintext = b"sensitive-untrusted-edge-payload";

    let envelope = {
        let cipher = Aes256Gcm::new(key.as_ref().expect("key present before erasure"));
        let nonce = Nonce::generate();
        let ciphertext = cipher.encrypt(&nonce, plaintext.as_ref()).map_err(|_| {
            error(
                "erasure_encrypt_failed",
                "failed to encrypt erasure probe payload",
            )
        })?;
        let mut envelope = nonce.as_slice().to_vec();
        envelope.extend_from_slice(&ciphertext);
        envelope
    };

    let thread = kernel.thread_create("thread_erasure", "schema_main", "branch_erasure")?;
    let checkpoint = checkpoint_message_into_head(
        &kernel,
        CheckpointMessageInput {
            branch_id: thread.branch_id.clone(),
            message_bytes: envelope.clone(),
            parent_turn_id: None,
            run_id: "run_erasure".to_string(),
            schema_id: "schema_main".to_string(),
            start_turn_node_hash: thread.root_turn_node_hash.clone(),
            task_id: "msg_erasure".to_string(),
            thread_id: thread.thread_id.clone(),
            turn_id: "turn_erasure".to_string(),
        },
    )?;
    let envelope_hash = checkpoint.object_hash.clone();

    let branch_before = kernel
        .branch_get(&thread.branch_id)?
        .ok_or_else(|| error("missing_branch", "expected branch before erasure"))?;
    let node_before = kernel
        .node_get(&checkpoint.turn_node_hash)?
        .ok_or_else(|| error("missing_node", "expected node before erasure"))?;

    let stored_before = kernel
        .store_get(&envelope_hash)?
        .ok_or_else(|| error("missing_object", "expected stored envelope before erasure"))?;
    let recoverable_before_erasure = decrypt_envelope(
        key.as_ref().expect("key present before erasure"),
        &stored_before,
    )
    .is_some_and(|decrypted| decrypted == plaintext);

    // ── Crypto-shredding erasure: the host destroys the key. ──
    let _ = key.take();

    let stored_after = kernel
        .store_get(&envelope_hash)?
        .ok_or_else(|| error("missing_object", "expected stored envelope after erasure"))?;
    // The real key is gone (dropped, not merely marked absent), so it cannot
    // be reconstructed. Mirror the TypeScript reference's keyring-resolution
    // failure: attempt decryption through the same `key` slot erasure just
    // cleared, rather than substituting an unrelated key. An unrelated key
    // would always fail AES-GCM's authentication check regardless of whether
    // `key.take()` above ever ran, making the assertion insensitive to a
    // regression that skips or breaks the erasure step. Routing through
    // `key.as_ref()` keeps the check mutation-sensitive: if erasure is
    // skipped, `key` is still `Some`, decryption still succeeds, and this
    // correctly reports the payload as recoverable.
    let unrecoverable_after_erasure = match key.as_ref() {
        None => true,
        Some(surviving_key) => decrypt_envelope(surviving_key, &stored_after)
            .map(|decrypted| decrypted != plaintext)
            .unwrap_or(true),
    };

    let branch_after = kernel
        .branch_get(&thread.branch_id)?
        .ok_or_else(|| error("missing_branch", "expected branch after erasure"))?;
    let node_after = kernel
        .node_get(&checkpoint.turn_node_hash)?
        .ok_or_else(|| error("missing_node", "expected node after erasure"))?;
    let manifest_after = kernel.tree_manifest(&node_after.turn_tree_hash)?;
    let manifest_references_envelope = matches!(
        manifest_after.get("messages"),
        Some(PathValue::Ordered(hashes)) if hashes.contains(&envelope_hash)
    );

    let lineage_structurally_intact_after_erasure = branch_after.head_turn_node_hash
        == branch_before.head_turn_node_hash
        && node_after.turn_tree_hash == node_before.turn_tree_hash
        && manifest_references_envelope
        && stored_after == stored_before
        && stored_after == envelope;

    Ok(projection(json!({
        "erasure": {
            "recoverableBeforeErasure": recoverable_before_erasure,
            "unrecoverableAfterErasure": unrecoverable_after_erasure,
            "lineageStructurallyIntactAfterErasure": lineage_structurally_intact_after_erasure,
        }
    })))
}

fn decrypt_envelope(key: &Key<Aes256Gcm>, envelope: &[u8]) -> Option<Vec<u8>> {
    const NONCE_LEN: usize = 12;
    if envelope.len() < NONCE_LEN {
        return None;
    }
    let (nonce_bytes, ciphertext) = envelope.split_at(NONCE_LEN);
    let nonce = Nonce::<<Aes256Gcm as AeadCore>::NonceSize>::try_from(nonce_bytes).ok()?;
    let cipher = Aes256Gcm::new(key);
    cipher.decrypt(&nonce, ciphertext).ok()
}

fn projection(evidence: Value) -> Value {
    json!({
        "evidence": evidence.clone(),
        "result": evidence,
    })
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
        // Never fed into hash_turn_node_identity's hand-built hash record, so
        // any placeholder value is fine here.
        created_at_ms: 0,
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
