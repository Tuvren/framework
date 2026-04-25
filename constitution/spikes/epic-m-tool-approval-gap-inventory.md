# Epic M Tool and Approval Inventory

This file closes `KRT-M001` against current brownfield reality and records the
shared-core seams that the rest of Epic M depends on.

## Current Repo Reality
- `framework-runtime-core` already contains the shared tool executor, approval
  pause/resume path, resumed-handle lifecycle, staged partial-batch behavior,
  and most of the integration coverage Epic M needs.
- `framework-driver-react` already emits durable assistant `tool_call` parts and
  chooses `toolExecutionMode`, while shared core owns execution, staging,
  approval, and continuation.
- Verification baseline for this inventory:
  - `bun run nx run framework-runtime-core:typecheck`
  - `bun run nx run framework-runtime-core:test`

## Contract Homes
- Shared approval and execution contracts:
  `boundaries/framework/contracts/runtime-api/src/lib/runtime-contracts.ts`
- Shared tool executor and approval helpers:
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/tool-execution.ts`
  and
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/tool-execution-helpers.ts`
- Shared pause/resume lifecycle, checkpointing, and continuation:
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts`
  and
  `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-execution-handle.ts`
- ReAct driver continuation seam:
  `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver.ts`

## Ownership Map
- `framework-driver-react`
  - produces durable assistant `tool_call` parts
  - selects sequential versus parallel `toolExecutionMode`
  - does not own approval resume
- `framework-runtime-core`
  - validates assistant tool-call durability before execution
  - executes auto-approved tools and stages per-call `tool_result` messages
  - pauses on approval, resumes only unfinished calls, and owns handle
    replacement semantics
  - keeps partial-batch staging, status transitions, and branch advancement
    coherent
- host layer
  - chooses whether to call `resolveApproval(...)` or `cancel()`
  - chooses the approval decisions
  - owns any extra context-engineering policy that explains a human edit beyond
    the durable audit trace recorded by shared core
- deferred / out of scope
  - provider-native tool APIs
  - host UI policy
  - approval-expiry products or policy

## Ticket Traceability
### KRT-M002 Tool Result Continuation
- Current behavior:
  - completed tool calls are staged incrementally and incorporated as durable
    `tool` messages before the next model iteration
  - resumed iterations continue from staged tool results instead of re-executing
    completed calls
- Evidence:
  - runtime-core tests covering mixed approval batches, immediate resumed
    decisions, and partial sibling completion

### KRT-M003 Approval Pause and Exact Resume
- Current behavior:
  - `approval.requested` is emitted before paused `turn.end`
  - `resolveApproval(...)` returns a fresh handle
  - resumed streams begin with `turn.start` plus `approval.resolved`
  - runtime status is restaged to `running` before resumed work continues
  - only unfinished approved or edited calls resume through the shared executor
- Evidence:
  - paused snapshot, inert old handle, resumed cancellation, steering carry-over,
    and paused runtime-status tests in `framework-runtime-core`

### KRT-M004 Edit/Reject and Partial Batch Recovery
- Current behavior:
  - reject decisions synthesize durable error `tool_result` messages and may
    continue the same Turn when the host uses `resolveApproval(...)`
  - paused-handle `cancel()` remains the separate rejection-and-stop path
  - completed sibling results survive renewed approval pauses and malformed
    resume failures
- Gap closed in this pass:
  - successful edited approvals now preserve a durable audit trace on the stored
    `tool_result` payload by recording the original requested input and the
    approved edited input alongside the executed result
  - invalid edited approvals preserve the same audit trace on the synthesized
    error `tool_result`
- Evidence:
  - existing rejection, renewed-approval, malformed-approval, and partial-batch
    recovery tests
  - edited-approval audit-trace regression coverage in
    `framework-runtime-core`

### KRT-M005 Tool Governance Integration Closure
- Current behavior:
  - sequential mode stops at the first approval gate
  - parallel mode preserves wave-ordered `tool.start` publication and
    per-completion `tool.result` publication
  - malformed approval requests fail without checkpointing invalid sibling
    progress
  - aroundTool-triggered pauses resume through the same shared executor
- Evidence:
  - ordering, cap, malformed approval, aroundTool pause/resume, and staged
    recovery tests in `framework-runtime-core`

## Durable Invariants Epic M Relies On
- Shared core only executes durable assistant `ToolCallPart` values that already
  passed runtime validation.
- Pending approval state records the original requested tool input.
- Edited approval execution uses the approved edited input for `tool.start`,
  tool execution, and the resulting durable `tool_result`.
- The original request remains visible in the prior assistant `tool_call`
  message, while edited approvals add a separate audit payload on the resulting
  `tool_result`.
- Paused-run closure through the kernel's `paused -> failed` bookkeeping does
  not change the framework meaning of approval resume or paused cancellation.

## Explicit Non-Goals
- No new host-facing approval APIs.
- No new driver-owned approval resume path.
- No provider-native tool support.
- No automatic agent-facing narration of why a human edited a call beyond the
  durable approval audit payload already attached to edited tool results.

## Validation
- `bun run nx run framework-runtime-core:typecheck`
- `bun run nx run framework-runtime-core:test`
