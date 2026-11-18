use std::path::Path;

use serde_json::{Value, json};
use tuvren_kernel_rust::memory::SharedSubstrate;
use tuvren_kernel_rust::testkit::{ClockDomain, KernelTestControls};
use tuvren_kernel_rust::{InMemoryKernel, KernelError, ThreadListOptions};

pub(crate) fn run_cross_scope_probe() -> Result<Value, KernelError> {
    let schema = super::parse_schema(&super::read_json(Path::new(super::CANONICAL_SCHEMA_PATH))?)?;
    let schema_id = schema.schema_id.clone();
    let substrate = SharedSubstrate::default();
    let controls = KernelTestControls::default();
    controls.set_clock(ClockDomain::Backend, 0)?;
    controls.set_clock(ClockDomain::Worker, 0)?;
    let kernel_a = InMemoryKernel::with_scoped_test_controls(
        controls.clone(),
        &substrate,
        "tuvren.scope.conformance-a",
    )?;
    let kernel_b = InMemoryKernel::with_scoped_test_controls(
        controls,
        &substrate,
        "tuvren.scope.conformance-b",
    )?;
    kernel_a.schema_register(schema)?;
    let hash = kernel_a.store_put(b"scope-a cross-scope probe content".to_vec(), None)?;
    let thread_id = "scope_probe_thread";
    kernel_a.thread_create(thread_id, &schema_id, "scope_probe_branch")?;
    let same_scope_get = kernel_a.store_get(&hash)?;
    let cross_scope_get = kernel_b.store_get(&hash)?;
    let (same_scope_threads, _) = kernel_a.thread_list(ThreadListOptions::default())?;
    let (cross_scope_threads, _) = kernel_b.thread_list(ThreadListOptions::default())?;
    Ok(super::projection(json!({
        "enumeration": {
            "crossScopeThreadVisible": cross_scope_threads.iter().any(|thread| thread.thread_id == thread_id),
            "sameScopeThreadVisible": same_scope_threads.iter().any(|thread| thread.thread_id == thread_id),
        },
        "storeGet": {
            "crossScopeReturnsNull": cross_scope_get.is_none(),
            "sameScopeReturnsObject": same_scope_get.is_some(),
        },
        "storeHas": {
            "crossScopeObservesOtherContent": kernel_b.store_has(&hash)?,
            "sameScopeObservesOwnContent": kernel_a.store_has(&hash)?,
        },
    })))
}
