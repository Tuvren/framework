# Framework Contract Partition Spike

- Date: 2026-04-09
- Semantic anchor posture: `@tuvren/runtime-api` owns the shared framework semantic model and the host-facing runtime API so one package remains the authoritative TypeScript source for message, approval, context, event, tool, provider, extension, and host-handle shapes.
- Focused facade posture:
  - `@tuvren/event-stream` is the focused public home for the canonical event vocabulary.
  - `@tuvren/tool-contracts` is the focused public home for tool, approval, and dispatch contracts.
  - `@tuvren/provider-api` is the focused public home for provider-neutral generate/stream contracts.
  - `@tuvren/driver-api` is the explicit public seam between shared runtime foundations and concrete drivers.
- Driver boundary posture:
  - shared runtime owns turn orchestration, checkpoint integration, and host controls
  - drivers own concrete execution policy through `execute()` and approval-resume continuation through `resume()`
  - drivers emit canonical runtime events through a runtime-owned port rather than by reaching into host adapters directly
- Dependency posture:
  - `@tuvren/runtime-api` depends only on `@tuvren/core-types`
  - focused facade packages depend on `@tuvren/runtime-api`
  - `@tuvren/driver-api` depends on `@tuvren/runtime-api`
- Anti-lock-in posture: ReAct remains the first concrete driver, but none of the shared contract packages require ReAct-specific types, loop names, or provider assumptions.
