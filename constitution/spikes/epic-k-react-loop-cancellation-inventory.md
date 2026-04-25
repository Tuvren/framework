# Epic K ReAct Loop and Cancellation Inventory

## Status

This note records the current brownfield state of Epic K after the loop-closure
pass. It is an implementation inventory, not a replacement for the normative
behavior in:

- [docs/KrakenFrameworkSpecification.md](../../docs/KrakenFrameworkSpecification.md)
- [constitution/TechSpec.md](../TechSpec.md)
- [constitution/Tasks.md](../Tasks.md)

Epic K remains scoped to the existing ReAct driver, shared runtime-core loop,
and current handoff contract. It does not widen provider bridges, host stream
adapters, or handoff policy.

## Current Behavior Inventory

### 1. Resolution and loop ownership

- ReAct driver iteration mapping lives in
  [react-driver.ts](../../boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver.ts).
- Shared loop orchestration, checkpointing, and lifecycle publication live in
  [runtime-core.ts](../../boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts).
- Current deterministic mapping:
  - assistant tool calls -> `continue_iteration` plus `toolExecutionMode`
  - terminal assistant content -> `end_turn`
  - handoff intent -> existing `handoff` contract only
  - provider failure or cancellation -> `fail(hard)`
- Shared core still owns the final validity check that rejects illegal mixes
  such as executable tool calls plus terminal resolutions.
- Baseline ReAct now honors `AgentConfig.loopPolicy` for non-tool assistant
  responses and rejects unsupported tool-call policy combinations as
  `invalid_loop_policy`, keeping the current driver/shared-core seam explicit
  instead of silently accepting terminal executable tool-call outcomes.

### 1.1 Ownership map

- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver.ts`
  - provider outcome normalization
  - assistant-message construction
  - ReAct iteration result mapping to `continue_iteration`, `end_turn`, or
    failed partials
- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-stream.ts`
  - stream accumulation
  - partial finalization rules
  - live assistant content event emission for stream mode
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts`
  - iteration loop progression
  - lifecycle event ordering
  - runtime status finalization
  - handoff application
  - cancellation override and durable checkpoint policy
- package tests under
  `boundaries/framework/implementations/typescript/drivers/react/test` and
  `boundaries/framework/implementations/typescript/runtime-core/test`
  - regression closure for loop mapping, lifecycle sequencing, handoff
    preservation, and cancellation boundaries

### 2. Cancellation and partial-output boundary

- Running cancellation is modeled as a hard failure and never as a pause.
- When recoverable assistant output already exists, shared core durably stages
  that assistant content, finalizes `runtime.status` as failed with
  `partial: true`, emits the canonical error, and ends the Turn as failed.
- When cancellation arrives before recoverable assistant content exists, shared
  core fails the Turn without staging assistant history and without setting the
  durable `partial` flag.
- Paused approval cancellation remains the rejection-and-stop path already owned
  by shared core; Epic K does not redefine it.

### 2.1 Patterns considered

- Generated response path: buffer assistant events until the durable response
  passes validation.
- Stream response path: publish live assistant events as chunks arrive, then
  validate the final durable assistant checkpoint after the provider call
  resolves.
- Stream cancellation after recoverable assistant content: stage that content as
  a failed partial assistant message.
- Stream cancellation before recoverable assistant content: fail without staging
  assistant history.
- Paused approval cancellation: keep the existing rejection-and-stop semantics
  rather than converting paused cancellation into a failed Turn.

### 3. Assistant stream publication and validation seam

- Stream assembly and partial finalization live in
  [react-driver-stream.ts](../../boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-stream.ts).
- Generated responses stay buffered until validation succeeds.
- Streamed responses may publish assistant events before final validation; later
  invalid-stream failures do not retract already-forwarded live events.
- Shared core validates emitted assistant sequences against the durable
  assistant message unless the narrow
  `allow_final_sequence_divergence` contract is active.
- Incomplete tool-call fragments may be durably staged only as interrupted
  assistant context; they are never promoted into executable tool work.

### 4. Handoff and active-agent boundary

- Existing driver-owned handoff intent stays in scope.
- Shared core still owns helper-built handoff plans, source-context
  normalization, active-agent swaps, and durable handoff application.
- Epic K does not expand handoff modes or add host-owned handoff behavior.
- The current provider-neutral content model does not define a dedicated
  handoff content part, so Epic K preserves the existing shared handoff contract
  and runtime helper path instead of inventing a new provider response shape.

## Remaining Gap Closed In This Pass

- Host-triggered runtime cancellation now preserves a typed shared-core error
  (`runtime_execution_cancelled`) instead of downgrading to a bare
  `Error("execution cancelled")`.
- Regression coverage now explicitly locks the durable partial/non-partial
  boundary for cancellation:
  - partial assistant content -> failed runtime status with `partial: true`
  - no recoverable assistant content -> failed runtime status without `partial`

## Hidden Choices Frozen For Epic L

- Shared public contracts stay unchanged in Epic K.
- Provider metadata and usage stay opaque and provider-shaped.
- The durable assistant checkpoint remains the source of truth for
  `afterIteration` response synthesis.
- Generated-response validation order remains stricter than streamed live-event
  publication order.
- Cancellation may preserve incomplete assistant content only when it is safe to
  represent as durable model-visible history.

## Explicit Non-Goals

- No AI SDK bridge work.
- No host protocol or playground work.
- No provider metadata normalization.
- No new handoff policy beyond the current contract.
- No tool/approval scope beyond the already-existing shared-core behavior needed
  to keep loop semantics coherent.

## Validation

- `bun run nx run framework-driver-react:test`
- `bun run nx run framework-runtime-core:test`
- `bun run typecheck`
