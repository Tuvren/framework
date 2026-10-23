use tuvren_kernel_rust::{
    InMemoryKernel, ObserveResult, PathCollectionKind, PathDefinition, StagedResultStatus,
    StepDeclaration, TurnTreeSchema, hash_bytes_to_hex,
};

fn assert_failed_checkpoints_are_atomic(kernel: InMemoryKernel) {
    kernel
        .schema_register(TurnTreeSchema {
            schema_id: "s".into(),
            paths: vec![PathDefinition {
                path: "p".into(),
                collection: PathCollectionKind::Ordered,
                metadata: None,
            }],
            incorporation_rules: vec![],
        })
        .unwrap();
    let thread = kernel.thread_create("t", "s", "b").unwrap();
    kernel
        .turn_create("t", "t", "b", None, &thread.root_turn_node_hash)
        .unwrap();
    kernel
        .run_create(
            "r",
            "t",
            "b",
            "s",
            &thread.root_turn_node_hash,
            vec![StepDeclaration {
                id: "step".into(),
                deterministic: false,
                side_effects: false,
                metadata: None,
            }],
        )
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
    let run = kernel.run_get("r").unwrap();
    let branch = kernel.branch_get("b").unwrap();
    let turn = kernel.turn_get("t").unwrap();
    let staged = kernel.staging_current("r").unwrap();
    let nodes = kernel.node_walk_back(&thread.root_turn_node_hash).unwrap();
    let annotation = vec![2, 3, 4];
    let annotation_hash = hash_bytes_to_hex(&annotation);
    for (event, tree, code) in [
        (
            Some("missing".into()),
            None,
            "kernel_runtime_missing_event_object",
        ),
        (None, Some("missing".into()), "turn_tree_not_found"),
    ] {
        let error = kernel
            .run_complete_step(
                "r",
                "step",
                event,
                vec![ObserveResult {
                    annotations: vec![annotation.clone()],
                    signals: vec![],
                }],
                tree,
            )
            .unwrap_err();
        assert_eq!(error.payload.code, code);
        assert!(!kernel.store_has(&annotation_hash).unwrap());
        assert_eq!(kernel.run_get("r").unwrap(), run);
        assert_eq!(kernel.branch_get("b").unwrap(), branch);
        assert_eq!(kernel.turn_get("t").unwrap(), turn);
        assert_eq!(kernel.staging_current("r").unwrap(), staged);
        assert_eq!(
            kernel.node_walk_back(&thread.root_turn_node_hash).unwrap(),
            nodes
        );
    }
    let error = kernel
        .run_complete(
            "r",
            tuvren_kernel_rust::RunCompletionStatus::Completed,
            Some("missing".into()),
        )
        .unwrap_err();
    assert_eq!(error.payload.code, "kernel_runtime_missing_event_object");
    assert_eq!(kernel.run_get("r").unwrap(), run);
    assert_eq!(kernel.branch_get("b").unwrap(), branch);
    assert_eq!(kernel.turn_get("t").unwrap(), turn);
    assert_eq!(kernel.staging_current("r").unwrap(), staged);
}

#[test]
fn production_failed_checkpoints_leave_state_unchanged() {
    assert_failed_checkpoints_are_atomic(InMemoryKernel::new());
}

#[cfg(feature = "conformance")]
#[test]
fn instrumented_failed_checkpoints_leave_the_same_state_unchanged() {
    use tuvren_kernel_rust::testkit::{ClockDomain, KernelTestControls};
    let controls = KernelTestControls::default();
    controls.set_clock(ClockDomain::Backend, 0).unwrap();
    controls.set_clock(ClockDomain::Worker, 0).unwrap();
    assert_failed_checkpoints_are_atomic(InMemoryKernel::with_test_controls(controls).unwrap());
}
