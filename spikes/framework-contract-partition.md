# Framework Contract Partition Spike

- Date: 2026-04-09
- Semantic anchor posture: `@kraken/framework-runtime-api` owns the shared framework semantic model and the host-facing runtime API so one package remains the authoritative TypeScript source for message, approval, context, event, tool, provider, extension, and host-handle shapes.
- Focused facade posture:
  - `@kraken/framework-event-stream` is the focused public home for the canonical event vocabulary.
  - `@kraken/framework-tool-contracts` is the focused public home for tool, approval, and dispatch contracts.
  - `@kraken/provider-api` is the focused public home for provider-neutral generate/stream contracts.
  - `@kraken/framework-driver-api` is the explicit public seam between shared runtime foundations and concrete drivers.
- Driver boundary posture:
  - shared runtime owns turn orchestration, checkpoint integration, and host controls
  - drivers own concrete execution policy through `execute()` and approval-resume continuation through `resume()`
  - drivers emit canonical runtime events through a runtime-owned port rather than by reaching into host adapters directly
- Dependency posture:
  - `@kraken/framework-runtime-api` depends only on `@kraken/shared-core-types`
  - focused facade packages depend on `@kraken/framework-runtime-api`
  - `@kraken/framework-driver-api` depends on `@kraken/framework-runtime-api`
- Anti-lock-in posture: ReAct remains the first concrete driver, but none of the shared contract packages require ReAct-specific types, loop names, or provider assumptions.
