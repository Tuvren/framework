# Tuvren Runtime Semantic Conventions

Generated from `telemetry/semconv/tuvren-runtime.yaml` via `weaver`.

- Schema URL: `https://tuvren.dev/schemas/telemetry/0.1.0`
- Resolved registry: `telemetry/semconv`

| Attribute | Type | Stability | Brief | Examples |
| --- | --- | --- | --- | --- |
| `tuvren.runtime.backend.id` | `string` | `development` | The backend implementation identifier selected by the runtime. | `sqlite` |
| `tuvren.runtime.branch.id` | `string` | `development` | The Tuvren runtime branch identifier. | `branch_main` |
| `tuvren.runtime.capability.execution_class` | `string` | `development` | The execution class of the capability invocation per ADR-046 (tuvren-server, provider-native, provider-mediated, tuvren-client). | `tuvren-server`, `provider-native` |
| `tuvren.runtime.capability.owner` | `string` | `development` | The owner dimension of the capability invocation (tuvren or provider). Added additively per ADR-046 AW006. | `tuvren`, `provider` |
| `tuvren.runtime.checkpoint.hash` | `string` | `development` | The current checkpoint hash observed during runtime progression. | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| `tuvren.runtime.driver.id` | `string` | `development` | The active driver identifier for the runtime execution. | `react` |
| `tuvren.runtime.error.code` | `string` | `development` | The stable Tuvren runtime error code associated with a failed telemetry span. | `runtime_error` |
| `tuvren.runtime.parent_checkpoint.hash` | `string` | `development` | The parent checkpoint hash that the current checkpoint extends from. | `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` |
| `tuvren.runtime.provider.id` | `string` | `development` | The provider bridge or provider identifier used for model work. | `ai-sdk-openai` |
| `tuvren.runtime.resumed_from.hash` | `string` | `development` | The checkpoint hash that a resumed execution continued from. | `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc` |
| `tuvren.runtime.run.id` | `string` | `development` | The Tuvren runtime run identifier. | `run_main` |
| `tuvren.runtime.thread.id` | `string` | `development` | The Tuvren runtime thread identifier. | `thread_main` |
| `tuvren.runtime.tool_call.id` | `string` | `development` | The current tool call identifier when the execution is inside tool work. | `tool_call_1` |
| `tuvren.runtime.turn.id` | `string` | `development` | The Tuvren runtime turn identifier. | `turn_main` |
