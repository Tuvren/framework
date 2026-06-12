# Epic Y Authority Leak Inventory

This inventory opens KRT-Y001 against the live repository state at the start of
Epic Y. It classifies current places where TypeScript, Rust, runner source, or
Markdown can be mistaken for cross-implementation semantic authority.

## Closed by Epic Y

| Entry | Surface | Leak kind | Current evidence | Closure path |
| --- | --- | --- | --- | --- |
| Y-LEAK-001 | `runtime-api` | operation, shape, control, lifecycle, recovery | `constitution/TechSpec.md` names `@tuvren/runtime-api` as a semantic anchor and describes runtime seams with TypeScript binding vocabulary. | KRT-Y005 promotes `tuvren.framework.runtime-api` and rephrases TechSpec language. |
| Y-LEAK-002 | `core-types` | shape, error | `boundaries/shared/contracts/core-types/spec/README.md` says current semantic authority remains `docs/` plus `constitution`; the TypeScript implementation owns the public shape. | KRT-Y003 promotes `tuvren.shared.core-types`. |
| Y-LEAK-003 | `event-stream` | ordered channel, evidence | `boundaries/framework/contracts/event-stream/spec/README.md` says the TypeScript package remains authoritative. | KRT-Y004 promotes `tuvren.framework.event-stream`. |
| Y-LEAK-004 | `driver-api` | operation, lifecycle, control | `boundaries/framework/contracts/driver-api/spec/README.md` says the TypeScript package remains authoritative. | KRT-Y006 promotes `tuvren.framework.driver-api`. |
| Y-LEAK-005 | callable seam | operation, control, error | Framework docs and TypeScript contracts express provider calls, tool execution, approval resolution, cancellation, retry, timeout, and driver hooks as language-shaped callables. | KRT-Y007 resolves each callable to runtime-api or driver-api neutral operations and binding appendices. |
| Y-LEAK-006 | `event-stream` | assertion, ordered channel | `boundaries/framework/implementations/typescript/conformance-runner/src/framework-typescript-conformance.ts` contains expected event sequences, terminal statuses, AG-UI projection sequences, and stable error-code checks in runner source. | KRT-Y004 and KRT-Y011 move these expectations into conformance plans and guard runner literals. |
| Y-LEAK-007 | kernel protocol | assertion, lifecycle, recovery | Rust and TypeScript kernel conformance runners contain expected check IDs, recovery-state expectations, and error-code checks in runner source. | Deferred unless touching kernel protocol packets; KRT-Y011 detects future runner-oracle additions for promoted Epic Y surfaces. |
| Y-LEAK-008 | compatibility | evidence | `reports/compatibility/compatibility-matrix.json` is measured evidence, while prose around compatibility can read like the binding claim. | KRT-Y012 rephrases closure language so per-check evidence paths remain the binding evidence. |

## Deferred With Rationale

| Entry | Surface | Leak kind | Rationale |
| --- | --- | --- | --- |
| Y-DEFER-001 | kernel protocol | transport, shape, assertion | Kernel protocol already owns CDDL/proto/conformance assets from Epics S-T-U. Full authority-packet hardening is outside the five Epic Y promoted framework/shared surfaces. |
| Y-DEFER-002 | providers/provider-api | shape, operation | Provider API was promoted in Epic S and is not one of the five named Epic Y surfaces. Future packet hardening can reuse Epic Y mechanics. |
| Y-DEFER-003 | stream adapters | transport, projection | SSE and AG-UI adapters remain deferred; Epic Y only promotes canonical event-stream semantics, not every host protocol projection as its own packet. |
| Y-DEFER-004 | telemetry | telemetry | Telemetry semconv already has Weaver-backed generated assets; a telemetry authority packet is a future epic candidate. |
| Y-DEFER-005 | compatibility ledger | evidence | Compatibility reporting remains measured evidence; promoting the ledger itself is explicitly out of Epic Y scope. |

## Implementation-Specific, Not Authority Leaks

| Entry | Surface | Reason |
| --- | --- | --- |
| Y-IMPL-001 | TypeScript tests under `implementations/typescript/**/test` | Package-local tests may assert binding behavior so long as they do not claim cross-implementation authority. |
| Y-IMPL-002 | Rust kernel crate internals | Rust kernel source may implement and optimize its local behavior; it is not cited as authority for promoted Epic Y surfaces. |
| Y-IMPL-003 | Generated gRPC TypeScript/Rust helpers | Generated helpers are transport projections governed by their proto/codegen roots, not authored cross-language semantic sources. |
| Y-IMPL-004 | Host playground scenarios | Host harnesses are private validation consumers and are not a promoted authority surface in Epic Y. |

## Inventory Result

All discovered entries are classified. Epic Y closes the four unpromoted
contract roots plus callable seams, installs validator and guardrail mechanics,
and records kernel/provider/telemetry/compatibility packet hardening as future
scope rather than silently broadening this epic.
