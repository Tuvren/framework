use std::collections::BTreeMap;
use std::sync::Arc;

use tuvren_kernel_rust::{
    InMemoryKernel, InMemoryKernelOptions, IncorporationRule, KernelRecord, ObserveResult,
    PathCollectionKind, PathDefinition, PathValue, RunCompletionStatus, StagedResult,
    StagedResultStatus, StepDeclaration, TurnNode, TurnTreeSchema, Verdict, VerdictDisposition,
    decode_deterministic_kernel_record, encode_deterministic_kernel_record, hash_bytes_to_hex,
    hash_kernel_record, hash_turn_node_identity, schema_to_record,
};

#[test]
fn deterministic_identity_matches_shared_fixture_vectors() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/kernel-protocol-deterministic.json"
    ))
    .expect("fixture parses");
    let raw_bytes = fixture["rawOpaqueBytes"]
        .as_array()
        .expect("raw bytes")
        .iter()
        .map(|value| value.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>();
    assert_eq!(
        hash_bytes_to_hex(&raw_bytes),
        fixture["rawOpaqueBytesSha256Hex"]
            .as_str()
            .expect("raw hash")
    );

    let schema = canonical_schema_with_metadata();
    assert_eq!(
        hash_kernel_record(&schema_to_record(&schema)).expect("schema hashes"),
        fixture["turnTreeSchemaRecordSha256Hex"]
            .as_str()
            .expect("schema hash")
    );

    let record_hex = fixture["turnTreeSchemaRecordCborHex"]
        .as_str()
        .expect("schema cbor hex");
    let decoded = decode_deterministic_kernel_record(&hex_to_bytes(record_hex))
        .expect("fixture cbor is canonical");
    assert_eq!(
        hash_kernel_record(&decoded).expect("decoded hashes"),
        fixture["turnTreeSchemaRecordSha256Hex"]
            .as_str()
            .expect("schema hash")
    );

    let turn_node_record = fixture["turnNodeIdentityRecord"]
        .as_object()
        .expect("turn node object");
    let staged = turn_node_record["consumedStagedResults"]
        .as_array()
        .expect("staged results")[0]
        .as_object()
        .expect("staged result");
    let node = TurnNode {
        consumed_staged_results: vec![StagedResult {
            interrupt_payload: None,
            object_hash: staged["objectHash"]
                .as_str()
                .expect("objectHash")
                .to_string(),
            object_type: staged["objectType"]
                .as_str()
                .expect("objectType")
                .to_string(),
            status: StagedResultStatus::Completed,
            task_id: staged["taskId"].as_str().expect("taskId").to_string(),
            timestamp_ms: staged["timestamp"].as_i64().expect("timestamp"),
        }],
        event_hash: Some(
            turn_node_record["eventHash"]
                .as_str()
                .expect("eventHash")
                .to_string(),
        ),
        hash: String::new(),
        previous_turn_node_hash: None,
        schema_id: turn_node_record["schemaId"]
            .as_str()
            .expect("schemaId")
            .to_string(),
        turn_tree_hash: turn_node_record["turnTreeHash"]
            .as_str()
            .expect("turnTreeHash")
            .to_string(),
    };
    assert_eq!(
        hash_turn_node_identity(&node).expect("node hashes"),
        fixture["turnNodeIdentityRecordSha256Hex"]
            .as_str()
            .expect("node hash")
    );
}

#[test]
fn in_memory_kernel_runs_checkpoint_and_recovery_flow() {
    let kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(|| 1_717_171_717_171)),
    });
    let schema = canonical_schema();
    kernel
        .schema_register(schema)
        .expect("schema register succeeds");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread create succeeds");
    let turn = kernel
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("turn create succeeds");
    let run = kernel
        .run_create(
            "run_main",
            &turn.turn_id,
            "branch_main",
            "schema_main",
            &thread.root_turn_node_hash,
            vec![StepDeclaration {
                deterministic: false,
                id: "model_call".to_string(),
                metadata: None,
                side_effects: false,
            }],
        )
        .expect("run create succeeds");
    assert_eq!(run.current_step_index, 0);

    let (_, staged) = kernel
        .staging_stage(
            "run_main",
            b"hello".to_vec(),
            "msg_assistant",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect("stage succeeds");
    assert_eq!(staged.timestamp_ms, 1_717_171_717_171);
    let (checkpointed, turn_node_hash) = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step completes");
    assert!(checkpointed);
    let turn_node_hash = turn_node_hash.expect("turn node hash");
    assert_eq!(
        kernel
            .branch_get("branch_main")
            .expect("branch get")
            .expect("branch")
            .head_turn_node_hash,
        turn_node_hash
    );
    kernel
        .run_complete("run_main", RunCompletionStatus::Completed, None)
        .expect("run completes");
    let recovery = kernel.run_recover("run_main").expect("recovery succeeds");
    assert_eq!(
        recovery.last_completed_step_id.as_deref(),
        Some("model_call")
    );
    assert_eq!(recovery.consumed_staged_results.len(), 1);
}

#[test]
fn failed_step_checkpoint_keeps_staged_results_for_retry() {
    let (kernel, thread_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    kernel
        .staging_stage(
            "run_main",
            b"hello".to_vec(),
            "msg_assistant",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect("stage succeeds");
    let error = kernel
        .run_complete_step(
            "run_main",
            "model_call",
            None,
            Vec::new(),
            Some("missing_tree".to_string()),
        )
        .expect_err("missing tree fails checkpoint");

    assert_eq!(error.payload.code, "turn_tree_not_found");
    assert_eq!(
        kernel
            .staging_current("run_main")
            .expect("staging remains readable")
            .len(),
        1
    );
    assert_eq!(
        kernel
            .branch_get("branch_main")
            .expect("branch get")
            .expect("branch")
            .head_turn_node_hash,
        thread_hash
    );
}

#[test]
fn provided_step_tree_must_match_run_schema() {
    let (kernel, thread_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let mut other_schema = canonical_schema();
    other_schema.schema_id = "schema_other".to_string();
    kernel
        .schema_register(other_schema)
        .expect("other schema registers");
    let other_tree = kernel
        .tree_create("schema_other", empty_canonical_manifest(), None)
        .expect("other tree creates");
    let error = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), Some(other_tree))
        .expect_err("schema mismatch fails checkpoint");

    assert_eq!(error.payload.code, "turn_tree_schema_mismatch");
    assert_eq!(
        kernel
            .branch_get("branch_main")
            .expect("branch get")
            .expect("branch")
            .head_turn_node_hash,
        thread_hash
    );
}

#[test]
fn terminal_failure_checkpoints_unanchored_staged_results() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    kernel
        .staging_stage(
            "run_main",
            b"hello".to_vec(),
            "msg_assistant",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect("stage succeeds");
    let terminal_hash = kernel
        .run_complete("run_main", RunCompletionStatus::Failed, None)
        .expect("run fails with a terminal checkpoint")
        .expect("terminal checkpoint hash");
    let recovery = kernel.run_recover("run_main").expect("recovery succeeds");

    assert_eq!(recovery.consumed_staged_results.len(), 1);
    assert!(recovery.uncommitted_staged_results.is_empty());
    assert_eq!(recovery.last_turn_node_hash, terminal_hash);
}

#[test]
fn schema_registration_is_write_once() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let error = kernel
        .schema_register(canonical_schema())
        .expect_err("duplicate schema is rejected");

    assert_eq!(error.payload.code, "schema_already_exists");
}

#[test]
fn deterministic_side_effect_free_step_can_advance_without_checkpoint() {
    let (kernel, root_hash) = kernel_with_run(StepDeclaration {
        deterministic: true,
        id: "pure_step".to_string(),
        metadata: None,
        side_effects: false,
    });
    let (checkpointed, node_hash) = kernel
        .run_complete_step("run_main", "pure_step", None, Vec::new(), None)
        .expect("pure step completes");
    let recovery = kernel.run_recover("run_main").expect("recovery succeeds");

    assert!(!checkpointed);
    assert!(node_hash.is_none());
    assert_eq!(
        recovery.last_completed_step_id.as_deref(),
        Some("pure_step")
    );
    assert_eq!(recovery.last_turn_node_hash, root_hash);
}

#[test]
fn run_completion_rejects_invalid_terminal_transitions() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    kernel
        .run_complete("run_main", RunCompletionStatus::Paused, None)
        .expect("run pauses");
    let error = kernel
        .run_complete("run_main", RunCompletionStatus::Completed, None)
        .expect_err("paused run cannot complete");

    assert_eq!(error.payload.code, "invalid_run_completion_transition");
}

#[test]
fn duplicate_incorporation_object_types_are_rejected() {
    let kernel = InMemoryKernel::new();
    let mut schema = canonical_schema();
    schema.incorporation_rules.push(IncorporationRule {
        object_type: "message".to_string(),
        target_path: "context.manifest".to_string(),
    });
    let error = kernel
        .schema_register(schema)
        .expect_err("duplicate object type is rejected");

    assert_eq!(
        error.payload.code,
        "duplicate_incorporation_rule_object_type"
    );
}

#[test]
fn event_hash_must_reference_stored_object() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let error = kernel
        .run_complete_step(
            "run_main",
            "model_call",
            Some("missing_event".to_string()),
            Vec::new(),
            None,
        )
        .expect_err("missing event object is rejected");

    assert_eq!(error.payload.code, "event_object_not_found");
}

#[test]
fn terminal_event_hash_must_reference_stored_object() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let error = kernel
        .run_complete(
            "run_main",
            RunCompletionStatus::Failed,
            Some("missing_event".to_string()),
        )
        .expect_err("missing terminal event object is rejected");

    assert_eq!(error.payload.code, "event_object_not_found");
}

#[test]
fn branch_rewind_fails_active_runs() {
    let (kernel, root_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let (_, node_hash) = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step checkpoints");
    let node_hash = node_hash.expect("checkpoint hash");
    kernel
        .staging_stage(
            "run_main",
            b"uncommitted".to_vec(),
            "late_task",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect("active run can still have uncommitted staged work");

    let set_head = kernel
        .branch_set_head("branch_main", &root_hash)
        .expect("rewind archives old head");
    assert_eq!(
        set_head
            .archive_branch
            .expect("archive branch")
            .head_turn_node_hash,
        node_hash
    );
    let error = kernel
        .run_begin_step("run_main", "model_call")
        .expect_err("rewound active run is failed");
    assert_eq!(error.payload.code, "run_not_running");
    assert!(
        kernel
            .staging_current("run_main")
            .expect("failed run staging remains readable")
            .is_empty()
    );
}

#[test]
fn branch_rewind_does_not_overwrite_existing_archive_ids() {
    let (kernel, root_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let (_, node_hash) = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step checkpoints");
    let node_hash = node_hash.expect("checkpoint hash");
    kernel
        .branch_create("branch_main_archive_1", "thread_main", &root_hash)
        .expect("host branch using archive-like id creates");

    let set_head = kernel
        .branch_set_head("branch_main", &root_hash)
        .expect("rewind archives old head without collision");

    assert_eq!(
        kernel
            .branch_get("branch_main_archive_1")
            .expect("branch get")
            .expect("pre-existing archive-like branch")
            .head_turn_node_hash,
        root_hash
    );
    assert_eq!(
        set_head
            .archive_branch
            .expect("generated archive branch")
            .head_turn_node_hash,
        node_hash
    );
}

#[test]
fn branch_forward_move_is_rejected_with_active_run() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread creates");
    kernel
        .branch_create("branch_worker", "thread_main", &thread.root_turn_node_hash)
        .expect("worker branch creates");
    kernel
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("main turn creates");
    kernel
        .turn_create(
            "turn_worker",
            "thread_main",
            "branch_worker",
            Some("turn_main".to_string()),
            &thread.root_turn_node_hash,
        )
        .expect("worker turn creates");
    kernel
        .run_create(
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
        )
        .expect("main run creates");
    kernel
        .run_create(
            "run_worker",
            "turn_worker",
            "branch_worker",
            "schema_main",
            &thread.root_turn_node_hash,
            vec![StepDeclaration {
                deterministic: false,
                id: "worker_step".to_string(),
                metadata: None,
                side_effects: false,
            }],
        )
        .expect("worker run creates");
    let (_, worker_node) = kernel
        .run_complete_step("run_worker", "worker_step", None, Vec::new(), None)
        .expect("worker step checkpoints");
    let error = kernel
        .branch_set_head("branch_main", &worker_node.expect("worker node"))
        .expect_err("active run blocks external forward branch move");

    assert_eq!(error.payload.code, "branch_has_active_run");
}

#[test]
fn staging_stage_requires_running_run() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step completes");
    kernel
        .run_complete("run_main", RunCompletionStatus::Completed, None)
        .expect("run completes");
    let error = kernel
        .staging_stage(
            "run_main",
            b"late".to_vec(),
            "msg_late",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect_err("completed run cannot stage");

    assert_eq!(error.payload.code, "run_not_running");
}

#[test]
fn observe_signals_are_available_to_next_step_once() {
    let (kernel, _) = kernel_with_steps(vec![
        StepDeclaration {
            deterministic: false,
            id: "first".to_string(),
            metadata: None,
            side_effects: false,
        },
        StepDeclaration {
            deterministic: true,
            id: "second".to_string(),
            metadata: None,
            side_effects: false,
        },
    ]);
    kernel
        .run_complete_step(
            "run_main",
            "first",
            None,
            vec![ObserveResult {
                annotations: Vec::new(),
                signals: vec![KernelRecord::Text("wake_next_step".to_string())],
            }],
            None,
        )
        .expect("first step completes with observe signal");
    let next_context = kernel
        .run_begin_step("run_main", "second")
        .expect("second step begins");
    let replay_context = kernel
        .run_begin_step("run_main", "second")
        .expect("second step can be observed again without stale signals");

    assert_eq!(
        next_context.signals,
        vec![KernelRecord::Text("wake_next_step".to_string())]
    );
    assert!(replay_context.signals.is_empty());
}

#[test]
fn staging_stage_duplicate_is_atomic() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    kernel
        .staging_stage(
            "run_main",
            b"hello".to_vec(),
            "msg_assistant",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect("first stage succeeds");
    let duplicate_hash = hash_bytes_to_hex(b"bye");
    let error = kernel
        .staging_stage(
            "run_main",
            b"bye".to_vec(),
            "msg_assistant",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect_err("duplicate stage fails");

    assert_eq!(error.payload.code, "staged_result_task_already_exists");
    assert!(
        !kernel
            .store_has(&duplicate_hash)
            .expect("store lookup succeeds")
    );
}

#[test]
fn verdict_composition_uses_fixed_priority_over_input_order() {
    let kernel = InMemoryKernel::new();
    let composed = kernel
        .verdicts_compose(vec![
            Verdict::Retry {
                adjustment: KernelRecord::Text("retry".to_string()),
            },
            Verdict::Pause {
                reason: "pause".to_string(),
                resumption_schema: KernelRecord::Null,
            },
            Verdict::Abort {
                disposition: VerdictDisposition::SoftFail,
                reason: "abort".to_string(),
            },
        ])
        .expect("verdicts compose");

    assert!(matches!(composed, Verdict::Abort { .. }));
}

#[test]
fn verdict_composition_preserves_first_verdict_within_priority() {
    let kernel = InMemoryKernel::new();
    let composed = kernel
        .verdicts_compose(vec![
            Verdict::Pause {
                reason: "first".to_string(),
                resumption_schema: KernelRecord::Null,
            },
            Verdict::Pause {
                reason: "second".to_string(),
                resumption_schema: KernelRecord::Null,
            },
        ])
        .expect("verdicts compose");

    assert!(matches!(composed, Verdict::Pause { reason, .. } if reason == "first"));
}

#[test]
fn turn_update_head_requires_descendant_of_turn_start() {
    let (kernel, root_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let (_, node_hash) = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step checkpoints");
    let node_hash = node_hash.expect("checkpoint hash");
    kernel
        .turn_create(
            "turn_child",
            "thread_main",
            "branch_main",
            Some("turn_main".to_string()),
            &node_hash,
        )
        .expect("child turn starts at parent head");
    let error = kernel
        .turn_update_head("turn_child", &root_hash)
        .expect_err("turn head cannot move before start");

    assert_eq!(error.payload.code, "turn_head_not_descendant");
}

#[test]
fn turn_update_head_rejects_lateral_descendant() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread creates");
    kernel
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("main turn creates");
    kernel
        .run_create(
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
        )
        .expect("main run creates");
    let (_, main_node) = kernel
        .run_complete_step("run_main", "main_step", None, Vec::new(), None)
        .expect("main step checkpoints");
    let main_node = main_node.expect("main node");
    kernel
        .run_complete("run_main", RunCompletionStatus::Completed, None)
        .expect("main run completes");
    kernel
        .branch_create("branch_alt", "thread_main", &thread.root_turn_node_hash)
        .expect("alt branch creates");
    kernel
        .turn_create(
            "turn_alt",
            "thread_main",
            "branch_alt",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("alt turn creates");
    kernel
        .run_create(
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
        )
        .expect("alt run creates");
    kernel
        .staging_stage(
            "run_alt",
            b"alt branch message".to_vec(),
            "alt_message",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect("alt staged result creates a distinct descendant");
    let (_, alt_node) = kernel
        .run_complete_step("run_alt", "alt_step", None, Vec::new(), None)
        .expect("alt step checkpoints");
    assert_ne!(main_node, alt_node.clone().expect("alt node"));
    let error = kernel
        .turn_update_head("turn_main", &alt_node.expect("alt node"))
        .expect_err("turn head cannot jump to a lateral descendant");

    assert_eq!(error.payload.code, "turn_head_lateral_move");
}

#[test]
fn turn_create_parent_must_chain_to_start() {
    let (kernel, root_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step checkpoints");
    let error = kernel
        .turn_create(
            "turn_child",
            "thread_main",
            "branch_main",
            Some("turn_main".to_string()),
            &root_hash,
        )
        .expect_err("child start must match parent head");

    assert_eq!(error.payload.code, "parent_turn_head_mismatch");
}

#[test]
fn turn_create_requires_parent_when_previous_turn_reaches_start() {
    let (kernel, _root_hash) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let (_, node_hash) = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("step checkpoints");
    let error = kernel
        .turn_create(
            "turn_child",
            "thread_main",
            "branch_main",
            None,
            &node_hash.expect("node hash"),
        )
        .expect_err("later turn must name its semantic parent");

    assert_eq!(error.payload.code, "turn_parent_required");
}

#[test]
fn tree_create_without_base_requires_all_paths() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let mut changes = BTreeMap::new();
    changes.insert("messages".to_string(), PathValue::Ordered(Vec::new()));
    let error = kernel
        .tree_create("schema_main", changes, None)
        .expect_err("partial base-less tree create is rejected");

    assert_eq!(error.payload.code, "incomplete_turn_tree_manifest");
}

#[test]
fn kernel_record_integers_are_javascript_safe() {
    let encode_error =
        encode_deterministic_kernel_record(&KernelRecord::Integer(9_007_199_254_740_992))
            .expect_err("out-of-profile integer is rejected on encode");
    let json_error =
        tuvren_kernel_rust::kernel_record_from_json(&serde_json::json!(9_007_199_254_740_992_i64))
            .expect_err("out-of-profile integer is rejected from JSON");

    assert_eq!(encode_error.payload.code, "invalid_kernel_record_integer");
    assert_eq!(json_error.payload.code, "invalid_kernel_record_integer");
}

#[test]
fn thread_roots_are_unique_for_lineage_proofs() {
    let (kernel, root_a) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let (_, node_a) = kernel
        .run_complete_step("run_main", "model_call", None, Vec::new(), None)
        .expect("thread A step checkpoints");
    let node_a = node_a.expect("checkpoint hash");
    let thread_b = kernel
        .thread_create("thread_b", "schema_main", "branch_b")
        .expect("second thread creates with same schema");

    assert_ne!(root_a, thread_b.root_turn_node_hash);
    let error = kernel
        .branch_create("branch_cross_thread", "thread_b", &node_a)
        .expect_err("thread A node cannot seed thread B branch");
    assert_eq!(error.payload.code, "turn_node_thread_mismatch");
}

#[test]
fn run_create_schema_must_match_start_node() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let mut other_schema = canonical_schema();
    other_schema.schema_id = "schema_other".to_string();
    kernel
        .schema_register(other_schema)
        .expect("other schema registers");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread creates");
    let turn = kernel
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("turn creates");
    let error = kernel
        .run_create(
            "run_main",
            &turn.turn_id,
            "branch_main",
            "schema_other",
            &thread.root_turn_node_hash,
            vec![StepDeclaration {
                deterministic: false,
                id: "model_call".to_string(),
                metadata: None,
                side_effects: false,
            }],
        )
        .expect_err("run schema cannot differ from start node schema");

    assert_eq!(error.payload.code, "run_schema_mismatch");
}

#[test]
fn run_create_rejects_empty_step_sequence() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread creates");
    let turn = kernel
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("turn creates");
    let error = kernel
        .run_create(
            "run_main",
            &turn.turn_id,
            "branch_main",
            "schema_main",
            &thread.root_turn_node_hash,
            Vec::new(),
        )
        .expect_err("empty step sequence is rejected");

    assert_eq!(error.payload.code, "invalid_step_sequence");
}

#[test]
fn run_complete_completed_requires_all_steps() {
    let (kernel, _) = kernel_with_steps(vec![
        StepDeclaration {
            deterministic: true,
            id: "first".to_string(),
            metadata: None,
            side_effects: false,
        },
        StepDeclaration {
            deterministic: true,
            id: "second".to_string(),
            metadata: None,
            side_effects: false,
        },
    ]);
    let error = kernel
        .run_complete("run_main", RunCompletionStatus::Completed, None)
        .expect_err("completed run must exhaust steps");

    assert_eq!(error.payload.code, "run_steps_incomplete");
}

#[test]
fn staging_stage_rejects_empty_task_and_object_type() {
    let (kernel, _) = kernel_with_run(StepDeclaration {
        deterministic: false,
        id: "model_call".to_string(),
        metadata: None,
        side_effects: false,
    });
    let task_error = kernel
        .staging_stage(
            "run_main",
            b"hello".to_vec(),
            "",
            "message",
            StagedResultStatus::Completed,
            None,
        )
        .expect_err("empty task id is rejected");
    let object_type_error = kernel
        .staging_stage(
            "run_main",
            b"hello".to_vec(),
            "msg_assistant",
            "",
            StagedResultStatus::Completed,
            None,
        )
        .expect_err("empty object type is rejected");

    assert_eq!(task_error.payload.code, "invalid_task_id");
    assert_eq!(object_type_error.payload.code, "invalid_object_type");
}

#[test]
fn tree_values_must_contain_hash_strings() {
    let kernel = InMemoryKernel::new();
    kernel
        .schema_register(canonical_schema())
        .expect("schema registers");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread creates");
    let mut invalid_manifest = empty_canonical_manifest();
    invalid_manifest.insert(
        "messages".to_string(),
        PathValue::Ordered(vec!["not_a_hash".to_string()]),
    );
    let create_error = kernel
        .tree_create("schema_main", invalid_manifest, None)
        .expect_err("invalid manifest hash is rejected");
    let incorporate_error = kernel
        .tree_incorporate(
            &thread.root_turn_tree_hash,
            &[StagedResult {
                interrupt_payload: None,
                object_hash: "not_a_hash".to_string(),
                object_type: "message".to_string(),
                status: StagedResultStatus::Completed,
                task_id: "msg_assistant".to_string(),
                timestamp_ms: 1_717_171_717_171,
            }],
        )
        .expect_err("invalid staged object hash is rejected");

    assert_eq!(create_error.payload.code, "invalid_hash_string");
    assert_eq!(incorporate_error.payload.code, "invalid_hash_string");
}

fn kernel_with_run(step: StepDeclaration) -> (InMemoryKernel, String) {
    kernel_with_steps(vec![step])
}

fn kernel_with_steps(steps: Vec<StepDeclaration>) -> (InMemoryKernel, String) {
    let kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
        now: Some(Arc::new(|| 1_717_171_717_171)),
    });
    kernel
        .schema_register(canonical_schema())
        .expect("schema register succeeds");
    let thread = kernel
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread create succeeds");
    let turn = kernel
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("turn create succeeds");
    kernel
        .run_create(
            "run_main",
            &turn.turn_id,
            "branch_main",
            "schema_main",
            &thread.root_turn_node_hash,
            steps,
        )
        .expect("run create succeeds");
    (kernel, thread.root_turn_node_hash)
}

fn empty_canonical_manifest() -> BTreeMap<String, PathValue> {
    let mut manifest = BTreeMap::new();
    manifest.insert("messages".to_string(), PathValue::Ordered(Vec::new()));
    manifest.insert("context.manifest".to_string(), PathValue::Null);
    manifest
}

fn canonical_schema() -> TurnTreeSchema {
    TurnTreeSchema {
        incorporation_rules: vec![
            IncorporationRule {
                object_type: "message".to_string(),
                target_path: "messages".to_string(),
            },
            IncorporationRule {
                object_type: "context_manifest".to_string(),
                target_path: "context.manifest".to_string(),
            },
        ],
        paths: vec![
            PathDefinition {
                collection: PathCollectionKind::Ordered,
                metadata: None,
                path: "messages".to_string(),
            },
            PathDefinition {
                collection: PathCollectionKind::Single,
                metadata: None,
                path: "context.manifest".to_string(),
            },
        ],
        schema_id: "schema_main".to_string(),
    }
}

fn canonical_schema_with_metadata() -> TurnTreeSchema {
    let mut chat_metadata = BTreeMap::new();
    chat_metadata.insert("role".to_string(), KernelRecord::Text("chat".to_string()));
    let mut manifest_metadata = BTreeMap::new();
    manifest_metadata.insert("version".to_string(), KernelRecord::Integer(1));
    let mut schema = canonical_schema();
    schema.paths[0].metadata = Some(KernelRecord::Map(chat_metadata));
    schema.paths[1].metadata = Some(KernelRecord::Map(manifest_metadata));
    schema
}

fn hex_to_bytes(value: &str) -> Vec<u8> {
    hex::decode(value).expect("valid hex fixture")
}
