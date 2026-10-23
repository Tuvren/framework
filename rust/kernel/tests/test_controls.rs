#![cfg(feature = "conformance")]

use tuvren_kernel_rust::testkit::{
    ClockDomain, FaultMode, FaultOperation, FaultPoint, FaultRequest, FaultSelector,
    KernelTestControls,
};
use tuvren_kernel_rust::{
    InMemoryKernel, IncorporationRule, KernelRecord, LeasedRunCreateInput, PathCollectionKind,
    PathDefinition, StagedResultStatus, StepDeclaration, TurnTreeSchema,
};

fn initialized() -> (InMemoryKernel, KernelTestControls) {
    let controls = KernelTestControls::default();
    assert!(InMemoryKernel::with_test_controls(controls.clone()).is_err());
    controls.set_clock(ClockDomain::Backend, 0).unwrap();
    assert!(InMemoryKernel::with_test_controls(controls.clone()).is_err());
    controls.set_clock(ClockDomain::Worker, 0).unwrap();
    let kernel = InMemoryKernel::with_test_controls(controls.clone()).unwrap();
    (kernel, controls)
}

fn seed(kernel: &InMemoryKernel, branch: &str, run: &str, lease: bool) {
    let thread = kernel.thread_create(branch, "s", branch).unwrap();
    kernel
        .turn_create(branch, branch, branch, None, &thread.root_turn_node_hash)
        .unwrap();
    let steps = (0..3)
        .map(|i| StepDeclaration {
            id: format!("step-{i}"),
            deterministic: false,
            side_effects: false,
            metadata: None,
        })
        .collect();
    if lease {
        kernel
            .run_liveness_create_leased_run(LeasedRunCreateInput {
                branch_id: branch.into(),
                execution_owner_id: "owner".into(),
                lease_expires_at_ms: 100,
                run_id: run.into(),
                schema_id: "s".into(),
                start_turn_node_hash: thread.root_turn_node_hash,
                steps,
                turn_id: branch.into(),
            })
            .unwrap();
    } else {
        kernel
            .run_create(run, branch, branch, "s", &thread.root_turn_node_hash, steps)
            .unwrap();
    }
}

fn schema(kernel: &InMemoryKernel) {
    kernel
        .schema_register(TurnTreeSchema {
            schema_id: "s".into(),
            paths: vec![PathDefinition {
                path: "p".into(),
                collection: PathCollectionKind::Ordered,
                metadata: None,
            }],
            incorporation_rules: vec![IncorporationRule {
                object_type: "o".into(),
                target_path: "p".into(),
            }],
        })
        .unwrap();
}

#[test]
fn worker_clock_controls_embedded_lease_expiry_and_record_time() {
    let (kernel, controls) = initialized();
    schema(&kernel);
    controls.set_clock(ClockDomain::Worker, 50).unwrap();
    seed(&kernel, "b", "r", true);
    let (_, staged) = kernel
        .staging_stage(
            "r",
            vec![1],
            "task",
            "o",
            StagedResultStatus::Completed,
            None,
        )
        .unwrap();
    assert_eq!(staged.timestamp_ms, 50);
    let run = kernel.run_get("r").unwrap().unwrap();
    assert_eq!(run.created_at_ms, 50);
    controls.set_clock(ClockDomain::Worker, 99).unwrap();
    controls.set_clock(ClockDomain::Backend, 9000).unwrap();
    let renewed = kernel
        .run_liveness_renew_lease("r", "owner", run.fencing_token.as_deref().unwrap(), 200)
        .unwrap();
    assert_eq!(renewed.updated_at_ms, 99);
    controls.set_clock(ClockDomain::Worker, 200).unwrap();
    controls.set_clock(ClockDomain::Backend, 0).unwrap();
    let error = kernel
        .run_liveness_renew_lease("r", "owner", renewed.fencing_token.as_deref().unwrap(), 300)
        .unwrap_err();
    assert_eq!(error.payload.code, "run_lease_expired");
}

#[test]
fn occurrence_matches_logical_transactions_once_and_respects_both_selectors() {
    for point in [FaultPoint::BeforeCommit, FaultPoint::AfterCommitBeforeAck] {
        let (kernel, controls) = initialized();
        schema(&kernel);
        seed(&kernel, "selected", "r", false);
        seed(&kernel, "other", "other", false);
        let token = controls
            .arm_fault(FaultRequest {
                point,
                selector: FaultSelector {
                    branch_id: Some("selected".into()),
                    operation: Some(FaultOperation::Checkpoint),
                },
                occurrence: 2,
                mode: FaultMode::Throw,
            })
            .unwrap();
        assert_eq!(token, "fault-1");
        kernel
            .run_complete_step("other", "step-0", None, vec![], None)
            .unwrap();
        kernel
            .staging_stage(
                "r",
                vec![1],
                "task",
                "o",
                StagedResultStatus::Completed,
                None,
            )
            .unwrap();
        kernel.run_recover("r").unwrap();
        kernel
            .run_complete_step("r", "step-0", None, vec![], None)
            .unwrap();
        // A failed native action is not a successfully submitted transaction.
        assert!(
            kernel
                .run_complete_step("r", "step-0", None, vec![], None)
                .is_err()
        );
        let error = kernel
            .run_complete_step("r", "step-1", None, vec![], None)
            .unwrap_err();
        assert_eq!(error.payload.code, "kernel_persistence_fault_injected");
        let KernelRecord::Map(details) = error.payload.details.unwrap() else {
            panic!("typed details")
        };
        assert_eq!(details["token"], KernelRecord::Text(token));
        assert_eq!(details["point"], KernelRecord::Text(point.as_str().into()));
        let recovery = kernel.run_recover("r").unwrap();
        let next = if point == FaultPoint::BeforeCommit {
            "step-1"
        } else {
            "step-2"
        };
        assert_eq!(
            recovery.last_completed_step_id.as_deref(),
            Some(if point == FaultPoint::BeforeCommit {
                "step-0"
            } else {
                "step-1"
            })
        );
        kernel
            .run_complete_step("r", next, None, vec![], None)
            .unwrap();
    }
}

#[test]
fn unfiltered_faults_cover_non_checkpoint_transactions_and_leave_production_instances_untouched() {
    for point in [FaultPoint::BeforeCommit, FaultPoint::AfterCommitBeforeAck] {
        let (kernel, controls) = initialized();
        controls
            .arm_fault(FaultRequest {
                point,
                selector: FaultSelector::default(),
                occurrence: 1,
                mode: FaultMode::Throw,
            })
            .unwrap();
        let production = InMemoryKernel::new();
        let hash = production.store_put(vec![1], None).unwrap();
        let error = kernel.store_put(vec![1], None).unwrap_err();
        assert_eq!(error.payload.code, "kernel_persistence_fault_injected");
        assert_eq!(
            kernel.store_has(&hash).unwrap(),
            point == FaultPoint::AfterCommitBeforeAck
        );
        assert_eq!(production.store_get(&hash).unwrap(), Some(vec![1]));
        kernel.store_put(vec![1], None).unwrap();
    }
}

#[test]
fn control_inputs_use_closed_enums_selectors_and_safe_integer_bounds() {
    for request in [
        serde_json::json!({"point":"unknown","mode":"throw","occurrence":1,"selector":{}}),
        serde_json::json!({"point":"before-commit","mode":"unknown","occurrence":1,"selector":{}}),
        serde_json::json!({"point":"before-commit","mode":"throw","occurrence":1,"selector":{"operation":"other"}}),
        serde_json::json!({"point":"before-commit","mode":"throw","occurrence":1,"selector":{"unexpected":true}}),
        serde_json::json!({"point":"before-commit","mode":"throw","occurrence":1,"selector":{"branchId":null}}),
        serde_json::json!({"point":"before-commit","mode":"throw","occurrence":1,"selector":{"operation":null}}),
    ] {
        assert!(serde_json::from_value::<FaultRequest>(request).is_err());
    }
    let controls = KernelTestControls::default();
    for now in [-1, 9_007_199_254_740_992] {
        assert!(controls.set_clock(ClockDomain::Backend, now).is_err());
    }
    for occurrence in [0, 9_007_199_254_740_992] {
        assert!(
            controls
                .arm_fault(FaultRequest {
                    point: FaultPoint::BeforeCommit,
                    selector: FaultSelector::default(),
                    occurrence,
                    mode: FaultMode::Throw
                })
                .is_err()
        );
    }
}

#[test]
fn read_only_syscalls_do_not_clone_state_but_still_select_faults() {
    let (kernel, controls) = initialized();
    schema(&kernel);
    seed(&kernel, "b", "r", false);
    let hash = kernel.store_put(vec![7; 16 * 1024], None).unwrap();
    let thread = kernel.thread_get("b").unwrap().unwrap();
    let root = kernel
        .node_get(&thread.root_turn_node_hash)
        .unwrap()
        .unwrap();
    let clones = kernel.state_clone_count().unwrap();
    kernel.store_has(&hash).unwrap();
    kernel.store_get(&hash).unwrap();
    kernel.schema_get("s").unwrap();
    kernel
        .tree_diff(&root.turn_tree_hash, &root.turn_tree_hash)
        .unwrap();
    kernel.tree_resolve(&root.turn_tree_hash, "p").unwrap();
    kernel.tree_manifest(&root.turn_tree_hash).unwrap();
    kernel.node_get(&root.hash).unwrap();
    kernel.node_walk_back(&root.hash).unwrap();
    kernel.thread_list(Default::default()).unwrap();
    kernel.thread_get("b").unwrap();
    kernel.branch_get("b").unwrap();
    kernel.branch_list("b").unwrap();
    kernel.turn_get("b").unwrap();
    kernel.staging_current("r").unwrap();
    kernel.run_get("r").unwrap();
    kernel.run_recover("r").unwrap();
    kernel.run_liveness_list_expired(0).unwrap();
    assert_eq!(kernel.state_clone_count().unwrap(), clones);
    controls
        .arm_fault(FaultRequest {
            point: FaultPoint::BeforeCommit,
            selector: FaultSelector::default(),
            occurrence: 1,
            mode: FaultMode::Throw,
        })
        .unwrap();
    assert_eq!(
        kernel.store_has(&hash).unwrap_err().payload.code,
        "kernel_persistence_fault_injected"
    );
    assert_eq!(kernel.state_clone_count().unwrap(), clones);
    kernel.store_put(vec![8], None).unwrap();
    assert_eq!(kernel.state_clone_count().unwrap(), clones);
}

#[test]
fn reclamation_defaults_to_worker_clock_with_skewed_backend_clock() {
    for (worker, backend, retained) in [(50, 90_000_000, true), (90_000_000, 50, false)] {
        let (kernel, controls) = initialized();
        schema(&kernel);
        seed(&kernel, "b", "r", false);
        let hash = kernel.store_put(vec![42], None).unwrap();
        controls.set_clock(ClockDomain::Worker, worker).unwrap();
        controls.set_clock(ClockDomain::Backend, backend).unwrap();
        kernel.maintenance_reclaim().unwrap();
        assert_eq!(kernel.store_has(&hash).unwrap(), retained);
    }
}

#[test]
fn branch_only_faults_ignore_run_only_transactions_and_count_branch_reads() {
    for point in [FaultPoint::BeforeCommit, FaultPoint::AfterCommitBeforeAck] {
        let (kernel, controls) = initialized();
        schema(&kernel);
        seed(&kernel, "b", "r", true);
        let run = kernel.run_get("r").unwrap().unwrap();
        controls
            .arm_fault(FaultRequest {
                point,
                selector: FaultSelector {
                    branch_id: Some("b".into()),
                    operation: None,
                },
                occurrence: 2,
                mode: FaultMode::Throw,
            })
            .unwrap();
        kernel.run_get("r").unwrap();
        kernel.run_recover("r").unwrap();
        kernel.staging_current("r").unwrap();
        kernel
            .staging_stage(
                "r",
                vec![1],
                "task",
                "o",
                StagedResultStatus::Completed,
                None,
            )
            .unwrap();
        kernel
            .run_liveness_renew_lease("r", "owner", run.fencing_token.as_deref().unwrap(), 200)
            .unwrap();
        kernel.turn_get("b").unwrap();
        kernel.run_begin_step("r", "step-0").unwrap();
        let error = kernel.branch_get("b").unwrap_err();
        assert_eq!(error.payload.code, "kernel_persistence_fault_injected");
        kernel.branch_get("b").unwrap();
    }
}

#[test]
fn reachable_delete_mutant_targets_only_fork_point_consumed_objects() {
    use tuvren_kernel_rust::testkit::mutants::KernelMutant;

    let mutant = KernelMutant::select("kernel.delete-object-reachable-through-live-root").unwrap();
    let controls = KernelTestControls::with_mutant(Some(mutant.clone()));
    controls.set_clock(ClockDomain::Backend, 0).unwrap();
    controls.set_clock(ClockDomain::Worker, 0).unwrap();
    let kernel = InMemoryKernel::with_test_controls(controls).unwrap();
    schema(&kernel);
    seed(&kernel, "b", "r", false);
    let mut objects = Vec::new();
    let mut nodes = Vec::new();
    for index in 0..3 {
        let (hash, _) = kernel
            .staging_stage(
                "r",
                vec![index],
                &format!("task-{index}"),
                "o",
                StagedResultStatus::Completed,
                None,
            )
            .unwrap();
        kernel
            .run_complete_step("r", &format!("step-{index}"), None, vec![], None)
            .unwrap();
        objects.push(hash);
        nodes.push(kernel.branch_get("b").unwrap().unwrap().head_turn_node_hash);
    }
    kernel.maintenance_reclaim().unwrap();
    assert_eq!(mutant.activation_count(), 0);
    kernel.branch_set_head("b", &nodes[1]).unwrap();
    kernel.maintenance_reclaim().unwrap();
    assert!(kernel.store_has(&objects[0]).unwrap());
    assert!(!kernel.store_has(&objects[1]).unwrap());
    assert_eq!(mutant.activation_count(), 1);
}

#[test]
fn writes_do_not_clone_untouched_objects_manifests_or_nodes() {
    let (kernel, _) = initialized();
    schema(&kernel);
    for index in 0_u64..128 {
        kernel
            .store_put(index.to_le_bytes().to_vec(), None)
            .unwrap();
        kernel
            .thread_create(&format!("t-{index}"), "s", &format!("b-{index}"))
            .unwrap();
    }
    let clones = kernel.state_clone_count().unwrap();
    let entries = kernel.journal_entry_count().unwrap();
    kernel.store_put(vec![255], None).unwrap();
    assert_eq!(kernel.journal_entry_count().unwrap(), entries + 1);
    assert_eq!(kernel.state_clone_count().unwrap(), clones);
}
