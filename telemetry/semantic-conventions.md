# Tuvren Runtime Semantic Conventions

Generated from `telemetry/semconv/tuvren-runtime.yaml` via `weaver`.

- Schema URL: `https://tuvren.dev/schemas/telemetry/0.1.0`
- Resolved registry: `telemetry/semconv`

| Attribute | Type | Stability | Brief | Examples |
| --- | --- | --- | --- | --- |
| `tuvren.runtime.bound` | `string` | `development` | The hard-stop execution bound that was breached (maxIterations, maxToolCalls, or maxWallClockMs). | `maxIterations`, `maxWallClockMs` |
| `tuvren.runtime.bound.limit` | `string` | `development` | The configured limit for the breached bound, emitted as a decimal string. The authoritative integer value lives on the canonical error-event details and the failed ExecutionResult. | `64`, `256` |
| `tuvren.runtime.bound.observed` | `string` | `development` | The observed value at breach time, emitted as a decimal string. The authoritative integer value lives on the canonical error-event details and the failed ExecutionResult. | `65`, `257` |
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
| `tuvren.runtime.scope.id` | `string` | `development` | The host-bound Scope (tenancy partition identity, ADR-048) the runtime is constructed against. Correlation context only; the kernel syscall surface stays scope-free and the Scope is never a syscall argument. | `tuvren.scope.default`, `tenant-a` |
| `tuvren.runtime.thread.id` | `string` | `development` | The Tuvren runtime thread identifier. | `thread_main` |
| `tuvren.runtime.tool_call.id` | `string` | `development` | The current tool call identifier when the execution is inside tool work. | `tool_call_1` |
| `tuvren.runtime.turn.id` | `string` | `development` | The Tuvren runtime turn identifier. | `turn_main` |
