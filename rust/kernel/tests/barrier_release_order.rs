#![cfg(feature = "conformance")]

use std::time::Duration;

use tuvren_kernel_rust::testkit::{ClockDomain, KernelTestControls, barrier::BarrierControl};
use tuvren_kernel_rust::{
    InMemoryKernel, IncorporationRule, PathCollectionKind, PathDefinition, RunCompletionStatus,
    StagedResultStatus, StepDeclaration, TurnTreeSchema,
};

#[test]
fn released_writer_wins_for_each_ordering() {
    for first in ["a", "b"] {
        let controls = KernelTestControls::default();
        controls.set_clock(ClockDomain::Backend, 0).unwrap();
        controls.set_clock(ClockDomain::Worker, 0).unwrap();
        let kernel = InMemoryKernel::with_test_controls(controls).unwrap();
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
        let thread = kernel.thread_create("t", "s", "common").unwrap();
        let mut nodes = Vec::new();
        for (branch, byte) in [("a", 1), ("b", 2)] {
            kernel
                .branch_create(branch, "t", &thread.root_turn_node_hash)
                .unwrap();
            kernel
                .turn_create(branch, "t", branch, None, &thread.root_turn_node_hash)
                .unwrap();
            kernel
                .run_create(
                    branch,
                    branch,
                    branch,
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
                    branch,
                    vec![byte],
                    "task",
                    "o",
                    StagedResultStatus::Completed,
                    None,
                )
                .unwrap();
            let (_, node) = kernel
                .run_complete_step(branch, "step", None, vec![], None)
                .unwrap();
            kernel
                .run_complete(branch, RunCompletionStatus::Completed, None)
                .unwrap();
            nodes.push(node.unwrap());
        }
        assert_ne!(nodes[0], nodes[1]);
        let barrier = BarrierControl::default();
        barrier
            .arm(
                "writers",
                "kernel.persistence.before-transact",
                &["a".into(), "b".into()],
            )
            .unwrap();
        let mut writers = Vec::new();
        for (handle, node) in [("a", &nodes[0]), ("b", &nodes[1])] {
            let writer = kernel.for_operation(barrier.operation(handle.into()));
            let node = node.clone();
            writers.push(std::thread::spawn(move || {
                writer.branch_set_head("common", &node)
            }));
        }
        for handle in ["a", "b"] {
            barrier
                .wait("writers", handle, Duration::from_secs(1))
                .unwrap();
        }
        let second = if first == "a" { "b" } else { "a" };
        barrier
            .release("writers", &[first.into(), second.into()])
            .unwrap();
        let outcomes: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect();
        let winner = if first == "a" { 0 } else { 1 };
        let loser = 1 - winner;
        assert_eq!(
            outcomes[winner]
                .as_ref()
                .unwrap()
                .branch
                .head_turn_node_hash,
            nodes[winner]
        );
        assert_eq!(
            outcomes[loser].as_ref().unwrap_err().payload.code,
            "kernel_runtime_lateral_head_movement"
        );
        assert_eq!(
            kernel
                .branch_get("common")
                .unwrap()
                .unwrap()
                .head_turn_node_hash,
            nodes[winner]
        );
    }
}
