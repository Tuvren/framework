# Epic AC Framework Orchestration Authority Inventory

## Status

Epic AC inventory is complete.

## Inventory Method

- Authority source for required behavior: `docs/KrakenFrameworkSpecification.md` §10.
- Current machine-owned authority before Epic AC completion: `boundaries/framework/contracts/runtime-api/spec/authority-packet.json` plus the referenced runtime-api conformance plans.
- Current local implementation evidence: TypeScript `runtime-core` orchestration tests and compatibility evidence only as measured implementation evidence, not as cross-implementation semantic authority.

## Classification

| Spec area | Behavior | Classification | Evidence anchor |
| --- | --- | --- | --- |
| §10.1 Agent Configuration | Agent configs are static for orchestration lifetime and handoff swaps the active config on the same branch. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.1; `boundaries/framework/implementations/typescript/runtime-core/test/orchestration-runtime.test.ts` |
| §10.2 Synchronous Workers | Tool-owned synchronous sub-agent execution remains opaque to the parent unless forwarded explicitly. | `intentionally implementation-defined` | `docs/KrakenFrameworkSpecification.md` §10.2 |
| §10.3 Asynchronous Workers | Child execution handles, child/subtree event streams, and child completion access exist as shared-core primitives. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.3; TypeScript runtime-api binding appendix and local orchestration tests |
| §10.3 Asynchronous Workers | The shared core does not define a canonical conversational `worker_result` payload. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.3; local test coverage for parent history without injected `worker_result` |
| §10.3 Asynchronous Workers | Higher-layer projection of child completion into parent context is above shared-core scope. | `intentionally implementation-defined` | `docs/KrakenFrameworkSpecification.md` §10.3 |
| §10.3 Asynchronous Workers | Worker execution is run-local: parent and child pause/resume/cancel behavior remains local to the owning execution handle. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.3; local orchestration tests around pause, approval replacement, and cancellation |
| §10.3 Asynchronous Workers | Parent execution must actually start before `spawn()` is valid. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.3; local launch-precondition tests |
| §10.3 Asynchronous Workers | `awaitResult()` alone does not satisfy the parent launch precondition. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.3; local launch-precondition tests |
| §10.3 Asynchronous Workers | `allEvents()` is a self-plus-descendants subtree stream and does not consume the child host-visible subtree stream. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.3; local subtree-stream tests |
| §10.4 Handoffs | Agent-signaled handoff remains a runtime resolution rather than a canonical history entry and stays on the same branch. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.4; local handed-off child attribution test |
| §10.4 Handoffs | Handoff context-building strategy and wrapper wording are deterministic but partly implementation-defined. | `intentionally implementation-defined` | `docs/KrakenFrameworkSpecification.md` §10.4 |
| §10.5 Ordered Pipelines | Ordered pipelines are outside shared-core semantics. | `intentionally implementation-defined` | `docs/KrakenFrameworkSpecification.md` §10.5 |
| §10.6 OrchestrationRuntime | `OrchestrationRuntime.executeTurn(...)` and `OrchestrationHandle` exist as the minimal handle/tree orchestration primitive. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; `boundaries/framework/contracts/runtime-api/implementations/typescript/src/lib/runtime-contracts.ts` |
| §10.6 OrchestrationRuntime | Orchestration composes existing framework primitives rather than introducing new kernel concepts. | `implemented-without-shared-conformance` | `docs/KrakenFrameworkSpecification.md` §10.6; current runtime-api packet and plans omit orchestration-specific checks |
| §10.6 OrchestrationRuntime | Child handles own their own pause/resume/cancel lifecycle. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; local pause/resume/cancel orchestration tests |
| §10.6 OrchestrationRuntime | Recursive child spawning is supported. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; local recursive spawn tests |
| §10.6 OrchestrationRuntime | `spawn()` is valid only while the current orchestration handle is running. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; local inactive-handle and paused-parent tests |
| §10.6 OrchestrationRuntime | Descendant events in `allEvents()` must carry source attribution sufficient to identify the originating execution node. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; local descendant attribution tests |
| §10.6 OrchestrationRuntime | Child launches inherit the caller's explicit execution surface such as `driverId`, per-request `tools`, and explicit schema. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; local execution-surface inheritance tests |
| §10.6 OrchestrationRuntime | `awaitResult()` resolves with the child execution's final visible result surface on success and rejects on failed completion. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.6; local visible-result and failure tests |
| §10.7 Extension Scoping | Extensions belong to the active agent config; workers run on separate threads with their own extensions. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.7; local mutable extension receiver test and orchestration config snapshotting test |
| §10.8 Streaming Events for Orchestration | `events()` and `allEvents()` are the canonical runtime surfaces; orchestration-specific custom tracing is optional and implementation-defined. | `implemented-and-locally-tested` | `docs/KrakenFrameworkSpecification.md` §10.8; local event-surface and attribution tests |
| §10.9 Boundaries | Worker process management, cross-thread state sharing, agent discovery, A2A integration, delegated construction modes, worker GC, and concurrent handoffs are out of core scope. | `intentionally implementation-defined` | `docs/KrakenFrameworkSpecification.md` §10.9 |

## Inventory Result

- Every behavior in `docs/KrakenFrameworkSpecification.md` §10 is now classified without relying on TypeScript `runtime-core` source as semantic authority.
- The portable shared semantics that must be promoted by Epic AC are the orchestration handle/runtime surface, launch preconditions, run-local lifecycle behavior, subtree event boundaries, descendant source attribution, explicit execution-surface inheritance, nested descendant attribution, and final visible result semantics.
- The promoted shared-runner subset is narrower than the full inventory: static agent-config snapshotting and extension-scoping behavior remain implementation-local evidence until a later epic explicitly promotes them into packet-owned conformance.
- TypeScript local tests remain useful implementation evidence, but future implementation lines should read the runtime-api packet, binding appendix, shared orchestration plans, and compatibility evidence instead of reverse-engineering `runtime-core` source.
