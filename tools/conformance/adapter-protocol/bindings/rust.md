# Rust Adapter Binding

The Rust binding projects `../protocol.schema.json` into Rust without making
Rust traits or structs the semantic authority.

```rust
trait ImplementationAdapter {
    async fn initialize(&mut self, packet_id: &str, plan_version: &str) -> AdapterCapabilities;
    async fn shutdown(&mut self);
    async fn dispatch(
        &mut self,
        operation: &str,
        input: serde_json::Value,
        controls: AdapterControls,
    ) -> OperationOutcome;
    async fn inspect_state(&self, query: serde_json::Value) -> Option<serde_json::Value>;
    async fn emit_evidence(&mut self, check_id: &str, key: &str, payload: serde_json::Value);
}
```

Stream, cancellation-token, and byte-buffer details are Rust binding concerns.
Neutral controls are still the schema-owned `cancel`, `cancel_after_event`, and
`deadline_ms` fields after Rust naming projection. The conformance plan remains
the source of operation inputs and expectations.

Reference scaffold:
`boundaries/kernel/implementations/rust/conformance-runner/src/adapter_scaffold.rs`.
