# Rust Adapter Binding

The Rust binding projects `../protocol.schema.json` into Rust without making
Rust traits or structs the semantic authority.

```rust
trait ImplementationAdapter {
    async fn initialize(&mut self, packet_id: &str, plan_version: &str) -> AdapterCapabilities;
    async fn shutdown(&mut self);
    async fn create_instance(&mut self, input: serde_json::Value) -> Option<serde_json::Value>;
    async fn destroy_instance(&mut self, instance: serde_json::Value);
    async fn dispatch(
        &mut self,
        operation: &str,
        input: serde_json::Value,
        controls: AdapterControls,
        instance: Option<serde_json::Value>,
    ) -> OperationOutcome;
    async fn events(
        &mut self,
        operation: &str,
        input: serde_json::Value,
        controls: AdapterControls,
        instance: Option<serde_json::Value>,
    ) -> Vec<serde_json::Value>;
    async fn inspect_state(
        &self,
        query: serde_json::Value,
        instance: Option<serde_json::Value>,
    ) -> Option<serde_json::Value>;
}
```

Stream, cancellation-token, and byte-buffer details are Rust binding concerns.
Neutral controls are still the schema-owned `cancel`, `cancel_after_event`, and
`deadline_ms` fields after Rust naming projection. The conformance plan remains
the source of operation inputs and expectations.

Reference scaffold:
`boundaries/kernel/implementations/rust/conformance-adapter/src/main.rs`.
